import { describe, expect, it } from 'vitest'
import { DatabaseKVAdapter, InMemoryKVAdapter, inMemoryKVAdapter, type Access, type CollectionConfig, type Config, type EmailAdapter, type Where } from 'payload'

import { onePedigree } from '../src'
import { startFixture } from './differential.fixture'
import { guarded } from './guard-late-install.shared'
import { startPayload, usersCollection } from './helpers'

/**
 * Payload calls the key-value store's `init` on every start, right after the database adapter's, even when a later
 * plugin replaced the adapter and `onInit` is off. The guard and the collection checks install there, so nothing of
 * the process is answered before they have run, and a start they refuse doesn't happen.
 */
const NOBODY = '64b0000000000000000000aa'
const role = (u: unknown) => (u as { role?: string } | null)?.role
const read: Access = ({ req }) => (role(req.user) === 'admin' ? true : ({ visibility: { equals: 'public' } } as Where))
const write: Access = ({ req }) => Boolean(req.user)
const rel = (name: string, relationTo: string) => ({ name, type: 'relationship', relationTo })
const animals = (): CollectionConfig => ({
  slug: 'animals',
  access: { read, create: write },
  fields: [{ name: 'name', type: 'text' }, { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' }, rel('dam', 'animals'), rel('sire', 'animals'), rel('clutch', 'clutches')] as never,
})
const clutches = (): CollectionConfig => ({ slug: 'clutches', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, rel('mother', 'animals')] as never })
const weighings = (): CollectionConfig => ({ slug: 'weighings', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, rel('animal', 'animals')] as never })
const plugin = () => onePedigree({ collection: 'animals', mode: 'mapped', fields: { label: 'name', parentage: { kind: 'role-fields', roles: { mother: 'dam', father: 'sire' }, cohort: 'clutch' } }, cohorts: { collection: 'clutches', birthParentField: 'mother' }, hiddenRecords: 'omit' } as never)

/** The start mode with nothing of the plugin left at start except what Payload calls on its own. */
const LATE = { disableOnInit: true, replaceDb: true }
const later = (change: (c: Config) => Config) => change
const start = (plugins: Config['plugins'], extra: Partial<Config> = {}, o: { disableOnInit?: boolean; replaceDb?: boolean } = LATE) =>
  startPayload({ collections: [usersCollection, animals(), clutches()], plugins: [plugin(), ...(plugins ?? [])], ...extra }, o)

/** Starts, runs `f`, and always stops; a start that was meant to be refused but wasn't fails the test after stopping. */
async function refused(plugins: Config['plugins'], pattern: RegExp, extra: Partial<Config> = {}) {
  let started: Awaited<ReturnType<typeof start>> | undefined
  try {
    started = await start(plugins, extra)
  } catch (error) {
    expect((error as Error).message).toMatch(pattern)
    return
  }
  await started.stop()
  throw new Error('the start was not refused')
}

const hookless = (slug: string, make: () => CollectionConfig) => later((c) => ({ ...c, collections: (c.collections ?? []).map((x) => (x.slug === slug ? make() : x)) }))
const fakeEmail: EmailAdapter = () => ({ name: 'test-email', defaultFromAddress: 'noreply@example.com', defaultFromName: 'Test', sendEmail: async () => undefined })

describe('late install through the key-value store', () => {
  it('a later plugin that overwrites the individuals read access and adds a collection leaks nothing on the first filter', async () => {
    const overwrite = later((c) => ({ ...c, collections: [...(c.collections ?? []).map((x) => (x.slug === 'animals' ? { ...x, access: { ...x.access, read } } : x)), weighings()] }))
    const { payload, stop } = await start([overwrite])
    try {
      const id = async (c: string, d: object) => String((await payload.db.create({ collection: c as never, data: d as never })).id)
      const viewer = await payload.db.create({ collection: 'users', data: { email: 'viewer@example.com', role: 'viewer' } as never })
      const hidden = await id('animals', { name: 'H', visibility: 'private' })
      const kid = await id('animals', { name: 'kid', dam: hidden })
      await id('weighings', { name: 'w1', animal: kid })
      const answer = async (v: string) => {
        try {
          return JSON.stringify(await payload.find({ collection: 'weighings' as never, where: { 'animal.dam': { equals: v } } as never, depth: 0, overrideAccess: false, user: { ...viewer, collection: 'users' } as never }))
        } catch (e) {
          return `refused: ${(e as Error).message}`
        }
      }
      for (let i = 0; i < 2; i++) {
        const [h, n] = [await answer(hidden), await answer(NOBODY)]
        expect(h).toBe(n)
        expect(h).toMatch(/^refused: /)
      }
    } finally {
      await stop()
    }
  })

  it('refuses the start when a later plugin replaced the cohorts or the individuals collection', async () => {
    await refused([hookless('clutches', clutches)], /"clutches" is missing or was replaced/)
    await refused([hookless('animals', animals)], /"animals" is missing or was replaced/)
  })

  it('refuses the start when the guard cannot be put on a late collection', async () => {
    const locked = later((c) => ({ ...c, collections: [...(c.collections ?? []), { slug: 'locked', access: { read: () => true }, hooks: { beforeOperation: Object.freeze([]) as never }, fields: [{ name: 'name', type: 'text' }] }] }))
    await refused([locked], /could not guard collection "locked"/)
  })

  it('has the guard on a late collection before the first operation, so that query is answered as for a made-up id', async () => {
    const c = await startFixture('omit', { disableOnInit: true, replaceDb: true, rawSeed: true })
    try {
      expect(guarded(c, 'notes')).toBe(true)
      const first = await c.safe(() => c.lf('notes', { 'animal.dam': { equals: c.id.H! } }))
      const second = await c.safe(() => c.lf('notes', { 'animal.dam': { equals: NOBODY } }))
      expect(JSON.stringify(c.norm(first))).toBe(JSON.stringify(c.norm(second)))
    } finally {
      await c.stop()
    }
  })

  it("keeps Payload's default store, its collection and the guard on it, when the host sets none", async () => {
    const { payload, stop } = await start([])
    try {
      expect(payload.kv).toBeInstanceOf(DatabaseKVAdapter)
      const kvCollection = payload.collections['payload-kv' as never]!
      expect(kvCollection).toBeDefined()
      expect(kvCollection.config.admin?.hidden).toBe(true)
      expect(((kvCollection.config.hooks?.beforeOperation ?? []) as unknown[]).length).toBeGreaterThan(0)
      await payload.kv.set('k', { v: 1 })
      expect(await payload.kv.get('k')).toEqual({ v: 1 })
      await payload.kv.delete('k')
    } finally {
      await stop()
    }
  })

  it("keeps a host's own store working", async () => {
    const { payload, stop } = await start([], { kv: inMemoryKVAdapter() })
    try {
      expect(payload.kv).toBeInstanceOf(InMemoryKVAdapter)
      expect(payload.collections['payload-kv' as never]).toBeUndefined()
      await payload.kv.set('k', 'v')
      expect(await payload.kv.get('k')).toBe('v')
    } finally {
      await stop()
    }
    await refused([hookless('clutches', clutches)], /"clutches" is missing or was replaced/, { kv: inMemoryKVAdapter() })
  })

  it("falls back to the host's email adapter when a later plugin replaced the store too", async () => {
    const replaceKv = later((c) => ({ ...c, kv: inMemoryKVAdapter() }))
    await refused([hookless('clutches', clutches), replaceKv], /"clutches" is missing or was replaced/, { email: fakeEmail })
  })
})
