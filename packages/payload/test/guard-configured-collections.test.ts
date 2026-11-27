import { describe, expect, it } from 'vitest'
import type { CollectionConfig, Config } from 'payload'

import { onePedigree, resolveOptions } from '../src'
import { assertResolverGuards } from '../src/parentPaths'
import { startPayload, usersCollection } from './helpers'

/**
 * The individuals and cohorts collections carry the plugin's redaction. If either is missing when the plugin runs, or
 * a later plugin adds, drops or replaces one, a hidden parent could be read out unredacted, so nothing starts.
 */
const write = ({ req }: { req: { user?: unknown } }) => Boolean(req.user)
const rel = (name: string, relationTo: string) => ({ name, type: 'relationship', relationTo })
const animals: CollectionConfig = { slug: 'animals', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, rel('dam', 'animals'), rel('sire', 'animals'), rel('clutch', 'clutches')] as never }
const clutches: CollectionConfig = { slug: 'clutches', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, rel('mother', 'animals')] as never }
const options = { collection: 'animals', mode: 'mapped', fields: { label: 'name', parentage: { kind: 'role-fields', roles: { mother: 'dam', father: 'sire' }, cohort: 'clutch' } }, cohorts: { collection: 'clutches', birthParentField: 'mother' }, hiddenRecords: 'omit' } as const
const plugin = () => onePedigree(options as never)

/** A plugin that runs after OnePedigree and changes the collection list. */
const later = (change: (cs: CollectionConfig[]) => CollectionConfig[]) => (c: Config): Config => ({ ...c, collections: change([...(c.collections ?? [])]) })
const start = (collections: CollectionConfig[], plugins: Config['plugins'], o: { disableOnInit?: boolean; replaceDb?: boolean; replaceKv?: boolean } = {}) =>
  startPayload({ collections: [usersCollection, ...collections], plugins }, o)

describe('configured collections must carry the guard', () => {
  it('refuses a cohorts collection that is not there when the plugin runs', () => {
    expect(() => plugin()({ collections: [usersCollection, animals] } as Config)).toThrow(/cohorts collection "clutches" not found/)
  })

  it('refuses to start when a later plugin adds the cohorts collection, in each start mode', async () => {
    for (const o of [{}, { disableOnInit: true, replaceDb: true }]) {
      await expect(start([animals], [plugin(), later((cs) => [...cs, clutches])], o)).rejects.toThrow(/cohorts collection "clutches" not found/)
    }
  })

  it('refuses to start when a later plugin drops or replaces the cohorts or individuals collection', async () => {
    // Dropping one breaks the other's relationship field, which Payload refuses on its own; either refusal is fine.
    await expect(start([animals, clutches], [plugin(), later((cs) => cs.filter((c) => c.slug !== 'clutches'))])).rejects.toThrow(/"clutches" is missing or was replaced|invalid relationship 'clutches'/)
    for (const slug of ['clutches', 'animals']) {
      const original = slug === 'animals' ? animals : clutches
      await expect(start([animals, clutches], [plugin(), later((cs) => cs.map((c) => (c.slug === slug ? original : c)))])).rejects.toThrow(new RegExp(`"${slug}" is missing or was replaced`))
    }
  })

  it('with the adapter and the store replaced and onInit off, refuses the first operation on any guarded collection once a configured one was replaced', async () => {
    // Nothing of this plugin runs at start in that mode, so the check runs on the first operation that reaches its hooks.
    // With the store kept, the start itself is refused (guard-late-install-kv.test.ts).
    const { payload, stop } = await start([animals, clutches], [plugin(), later((cs) => cs.map((c) => (c.slug === 'clutches' ? clutches : c)))], { disableOnInit: true, replaceDb: true, replaceKv: true })
    try {
      for (let i = 0; i < 2; i++) await expect(payload.find({ collection: 'users', depth: 0 })).rejects.toThrow(/"clutches" is missing or was replaced/)
    } finally {
      await stop()
    }
  })

  it('the resolver self-check refuses a configured collection that is not running, for individuals and cohorts', async () => {
    const opts = resolveOptions(options as never)
    const { payload, stop } = await start([animals, clutches], [plugin()])
    try {
      expect(() => assertResolverGuards(payload, opts)).not.toThrow()
      const running = payload.collections as Record<string, unknown>
      for (const slug of ['animals', 'clutches']) {
        const kept = running[slug]
        delete running[slug]
        try {
          expect(() => assertResolverGuards(payload, opts)).toThrow(new RegExp(`"${slug}" isn't in the running config`))
        } finally {
          running[slug] = kept
        }
      }
    } finally {
      await stop()
    }
  })
})
