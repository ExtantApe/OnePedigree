import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { expect } from 'vitest'
import { buildConfig, reload, type Access, type CollectionConfig, type Config, type Payload, type Where } from 'payload'

import { onePedigree } from '../src'
import { startPayload, usersCollection } from './helpers'

/**
 * A small made-up install for the tests that check the guard against the config Payload is running: individuals
 * (`animals`) with a hidden one `H`, cohorts (`clutches`), and `weighings`, which only a later plugin adds.
 */
export const NOBODY = '64b0000000000000000000aa'
const role = (u: unknown) => (u as { role?: string } | null)?.role
export const read: Access = ({ req }) => (role(req.user) === 'admin' ? true : ({ visibility: { equals: 'public' } } as Where))
const write: Access = ({ req }) => Boolean(req.user)
const rel = (name: string, relationTo: string) => ({ name, type: 'relationship', relationTo })
export const animals = (): CollectionConfig => ({
  slug: 'animals',
  access: { read, create: write, update: write },
  fields: [{ name: 'name', type: 'text' }, { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' }, rel('dam', 'animals'), rel('sire', 'animals'), rel('clutch', 'clutches')] as never,
})
export const clutches = (): CollectionConfig => ({ slug: 'clutches', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, rel('mother', 'animals')] as never })
const weighings = (): CollectionConfig => ({ slug: 'weighings', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, rel('animal', 'animals')] as never })
export const plugin = () => onePedigree({ collection: 'animals', mode: 'mapped', fields: { label: 'name', parentage: { kind: 'role-fields', roles: { mother: 'dam', father: 'sire' }, cohort: 'clutch' } }, cohorts: { collection: 'clutches', birthParentField: 'mother' }, hiddenRecords: 'omit' } as never)

type Later = (c: Config) => Config
/** A later plugin that adds `weighings`. */
export const addsWeighings: Later = (c) => ({ ...c, collections: [...(c.collections ?? []), weighings()] })
/** A later plugin that puts its own read access on the individuals collection and adds `weighings`. */
export const overwritesRead: Later = (c) => ({ ...c, collections: [...(c.collections ?? []).map((x) => (x.slug === 'animals' ? { ...x, access: { ...x.access, read } } : x)), weighings()] })
/** A later plugin that sets its own onInit without calling the one before it. */
export const unchainedInit: Later = (c) => ({ ...c, onInit: async () => {} })
export const replaces = (slug: string, make: () => CollectionConfig): Later => (c) => ({ ...c, collections: (c.collections ?? []).map((x) => (x.slug === slug ? make() : x)) })

export type Mode = { disableOnInit?: boolean; replaceDb?: boolean; replaceKv?: boolean }

/** Starts with `later` after the plugin, seeds through the adapter (so no operation runs first), and gives a probe. */
export async function start(later: Later[], mode: Mode = {}) {
  const { payload, stop } = await startPayload({ collections: [usersCollection, animals(), clutches()], plugins: [plugin(), ...later] }, mode)
  const id: Record<string, string> = {}
  let viewer: Record<string, unknown>
  try {
    const mk = async (c: string, k: string, d: object = {}) => (id[k] = String((await payload.db.create({ collection: c as never, data: { name: k, ...d } as never })).id))
    viewer = await payload.db.create({ collection: 'users', data: { email: 'viewer@example.com', role: 'viewer' } as never })
    await mk('animals', 'H', { visibility: 'private' })
    await mk('animals', 'A')
    await mk('animals', 'kid', { dam: id.H })
    await mk('animals', 'kid2', { dam: id.A })
    if (payload.collections['weighings' as never]) {
      await mk('weighings', 'w1', { animal: id.kid })
      await mk('weighings', 'w2', { animal: id.kid2 })
    }
  } catch (error) {
    await stop()
    throw error
  }
  const user = { ...viewer, collection: 'users' } as never
  const answer = async (f: () => Promise<unknown>) => {
    try {
      return JSON.stringify(await f())
    } catch (e) {
      return `refused: ${(e as Error).message}`
    }
  }
  /** The late collection filtered through a parent field, for the hidden id and then a made-up one. */
  const filter = async (on: Payload = payload) => {
    const q = (v: string) => answer(() => on.find({ collection: 'weighings' as never, where: { 'animal.dam': { equals: v } } as never, depth: 0, overrideAccess: false, user }))
    return { hidden: await q(id.H!), made: await q(NOBODY) }
  }
  const kidDam = async () => answer(async () => ((await payload.findByID({ collection: 'animals' as never, id: id.kid!, depth: 0, overrideAccess: false, user })) as { dam?: unknown }).dam ?? null)
  return { payload, stop, id, user, filter, kidDam, answer }
}

/** A hidden id and a made-up one get the same answer, and that answer is a refusal. */
export const closed = (r: { hidden: string; made: string }) => {
  expect(r.hidden).toBe(r.made)
  expect(r.hidden).toMatch(/^refused: /)
}

/**
 * What Payload's dev reload does: a fresh config, built by running every plugin again (so a new build of OnePedigree
 * with nothing shared with the one that started), handed to `reload()`. Its adapter is never started; Payload keeps
 * the running one. `replaceDb` adds the same adapter-replacing plugin the start had.
 */
export async function rebuildAndReload(payload: Payload, later: Later[], mode: Mode = {}) {
  const unused = () => mongooseAdapter({ url: 'mongodb://127.0.0.1:9/unused' })
  const fresh = await buildConfig({
    collections: [usersCollection, animals(), clutches()],
    plugins: [plugin(), ...later, ...(mode.replaceDb ? [(c: Config): Config => ({ ...c, db: unused() })] : [])],
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: unused(),
  })
  let error: string | null = null
  try {
    await reload(fresh, payload, true)
  } catch (e) {
    error = (e as Error).message
  }
  expect(payload.config).toBe(fresh)
  return { fresh, error }
}

export const hasGuard = (payload: Payload, slug: string) => ((payload.config.collections.find((c) => c.slug === slug)?.hooks?.beforeOperation ?? []) as unknown[]).length > 0
