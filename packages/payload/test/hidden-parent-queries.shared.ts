import { configToSchema } from '@payloadcms/graphql'
import { createRequire } from 'node:module'
import { createLocalReq, handleEndpoints, type Access, type CollectionConfig, type Payload, type TypedUser, type Where } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { onePedigree } from '../src'
import { startPayload, usersCollection } from './helpers'

/**
 * A parent the reader may not read must not show through a query either: sorting by it, filtering by it (from the
 * collection itself, from the individuals through the cohort, on versions), listing its distinct values, or saving a
 * cohort with an unreadable mother. A hidden ID and a made-up one get the same answer. Made-up data only.
 */
// The same CommonJS copy of graphql that Payload's schema builder loads; a second copy refuses its schema.
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')
const role = (u: unknown) => (u as { role?: string } | null)?.role
const read: Access = ({ req }) => (role(req.user) === 'admin' ? true : ({ visibility: { equals: 'public' } } as Where))
const write: Access = ({ req }) => Boolean(req.user)
const fields = [
  { name: 'name', type: 'text' },
  { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' },
] as CollectionConfig['fields']
const animals: CollectionConfig = {
  slug: 'animals',
  access: { read, create: write, update: write, delete: write },
  fields: [...fields, { name: 'dam', type: 'relationship', relationTo: 'animals' }, { name: 'sire', type: 'relationship', relationTo: 'animals' }, { name: 'clutch', type: 'relationship', relationTo: 'clutches' }, { name: 'mate', type: 'relationship', relationTo: 'animals' }, { name: 'kids', type: 'join', collection: 'animals', on: 'dam' } as never],
}
const clutches: CollectionConfig = {
  slug: 'clutches',
  access: { read, create: write, update: write, readVersions: write },
  versions: { maxPerDoc: 5 },
  fields: [...fields, { name: 'mother', type: 'relationship', relationTo: 'animals' }, { name: 'members', type: 'join', collection: 'animals', on: 'clutch' } as never],
}
/** A host collection that isn't the individuals or cohorts, but relates to them. */
const weighings: CollectionConfig = {
  slug: 'weighings',
  access: { read: () => true, create: write },
  fields: [{ name: 'name', type: 'text' }, { name: 'animal', type: 'relationship', relationTo: 'animals' }],
}

const NOBODY = '64b0000000000000000000aa'
type Body = { docs?: { name: string }[]; totalDocs?: number; errors?: unknown[]; data?: Record<string, { docs?: { name: string }[]; totalDocs?: number }> }

/** One run per `hiddenRecords` mode, each in its own test file (Payload keeps one instance per process). */
export const hiddenParentQueryTests = (hiddenRecords: 'omit' | 'placeholder') => describe(`hidden parents in queries (${hiddenRecords})`, () => {
  let payload: Payload
  let stop: () => Promise<void>
  let viewer: TypedUser
  let jwt: string
  const id: Record<string, string> = {}
  const mk = async (coll: string, key: string, data: object = {}) => {
    id[key] = String((await payload.create({ collection: coll as never, data: { name: key, ...data } as never })).id)
  }
  const call = async (path: string, init: RequestInit = {}, auth = true) => {
    const res = await handleEndpoints({
      config: payload.config,
      request: new Request(`http://localhost/api${path}`, { ...init, headers: { ...(init.headers as object), ...(auth ? { Authorization: `JWT ${jwt}` } : {}) } }),
    })
    return { status: res.status, body: (await res.json()) as Body }
  }
  const get = (path: string) => call(path)
  const names = async (path: string) => (await get(path)).body.docs?.map((d) => d.name)
  /** Runs a GraphQL query as the viewer, on a request marked as GraphQL the way Payload's own handler does. */
  const gql = async (query: string) => {
    const req = await createLocalReq({ user: viewer as never }, payload)
    ;(req as { payloadAPI: string }).payloadAPI = 'GraphQL'
    const { schema } = configToSchema(payload.config)
    const r = await graphql({ schema, source: query, contextValue: { req, headers: new Headers() } })
    return { status: 200, body: JSON.parse(JSON.stringify(r)) as Body }
  }
  const local = (o: object) => (payload as unknown as { findDistinct: (o: object) => Promise<unknown> }).findDistinct(o)

  beforeAll(async () => {
    ;({ payload, stop } = await startPayload({
      collections: [usersCollection, animals, clutches, weighings],
      plugins: [onePedigree({ collection: 'animals', mode: 'mapped', fields: { label: 'name', parentage: { kind: 'role-fields', roles: { mother: 'dam', father: 'sire' }, cohort: 'clutch' } }, cohorts: { collection: 'clutches', birthParentField: 'mother' }, hiddenRecords })],
    }))
    viewer = (await payload.create({ collection: 'users', data: { email: 'v@example.com', password: 'a-long-test-password', role: 'viewer' } as never })) as TypedUser
    const login = await call('/users/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'v@example.com', password: 'a-long-test-password' }) }, false)
    jwt = (login.body as unknown as { token: string }).token
    await mk('animals', 'Mhidden', { visibility: 'private' })
    await mk('animals', 'Aaa')
    await mk('animals', 'Zzz')
    await mk('clutches', 'C_hidden', { mother: id.Mhidden })
    await mk('clutches', 'C_Aaa', { mother: id.Aaa })
    await mk('clutches', 'C_Zzz', { mother: id.Zzz })
    await mk('animals', 'kid', { clutch: id.C_hidden })
    await mk('animals', 'kid2', { dam: id.Mhidden })
    await mk('animals', 'kid3', { dam: id.Aaa })
    await mk('animals', 'pal', { mate: id.kid })
    await mk('animals', 'pal2', { mate: id.kid3 })
    await mk('weighings', 'w1', { animal: id.kid })
    await mk('weighings', 'w2', { animal: id.kid3 })
    await payload.update({ collection: 'clutches' as never, id: id.C_hidden!, data: { name: 'C_hidden' } as never })
  })
  afterAll(async () => stop?.())

  it('refuses sorting by the birthing parent, by name or ID, over REST', async () => {
    expect((await get('/clutches?depth=0&sort=mother.name')).status).toBe(400)
    expect((await get('/clutches?depth=0&sort=-mother')).status).toBe(400)
    expect((await get('/clutches?depth=0&sort=name,mother')).status).toBe(400)
  })
  it('refuses sorting by the birthing parent over GraphQL', async () => {
    const r = await gql('{ Clutches(sort: "mother") { docs { name } } }')
    expect(r.body.errors?.length).toBeGreaterThan(0)
    expect(JSON.stringify(r.body)).not.toContain('C_hidden')
  })
  it('refuses sorting individuals by dam, sire or the cohort birthing parent', async () => {
    for (const s of ['dam', '-sire', 'dam.name', 'clutch.mother']) expect((await get(`/animals?depth=0&sort=${s}`)).status).toBe(400)
  })
  it('still sorts by an ordinary field', async () => {
    expect((await get('/clutches?depth=0&sort=name')).status).toBe(200)
  })

  it('answers a hidden and a made-up birthing parent filter the same way (REST and GraphQL)', async () => {
    const q = (v: string) => `/clutches?depth=0&where[mother][equals]=${v}`
    const [h, n] = [await get(q(id.Mhidden!)), await get(q(NOBODY))]
    expect(h.status).toBe(400)
    expect(h).toEqual(n)
    const g = (v: string) => gql(`{ Clutches(where: { mother: { equals: "${v}" } }) { totalDocs } }`)
    expect(await g(id.Mhidden!)).toEqual(await g(NOBODY))
    expect((await g(id.Mhidden!)).body.errors?.length).toBeGreaterThan(0)
  })
  it('allows a filter by a readable birthing parent, with equals, in and not_equals', async () => {
    expect(await names(`/clutches?depth=0&where[mother][equals]=${id.Aaa}`)).toEqual(['C_Aaa'])
    expect((await get(`/clutches?depth=0&where[mother][in]=${id.Aaa},${id.Zzz}`)).body.totalDocs).toBe(2)
    expect((await get(`/clutches?depth=0&where[mother][not_equals]=${id.Aaa}`)).status).toBe(200)
  })
  it('refuses in and not_in when one ID is hidden, and any filter below the parent field', async () => {
    expect((await get(`/clutches?depth=0&where[mother][in]=${id.Aaa},${id.Mhidden}`)).status).toBe(400)
    expect((await get(`/clutches?depth=0&where[mother][not_in]=${id.Mhidden}`)).status).toBe(400)
    expect((await get(`/clutches?depth=0&where[or][0][mother][equals]=${id.Mhidden}`)).status).toBe(400)
    expect((await get('/clutches?depth=0&where[mother.name][equals]=Mhidden')).status).toBe(400)
    expect((await get('/clutches?depth=0&where[mother][like]=a')).status).toBe(400)
  })
  it('allows exists only with placeholders', async () => {
    expect((await get('/clutches?depth=0&where[mother][exists]=true')).status).toBe(hiddenRecords === 'placeholder' ? 200 : 400)
  })

  it('answers animals filtered through the cohort birthing parent the same for hidden and made-up IDs', async () => {
    const q = (v: string) => `/animals?depth=0&where[clutch.mother][equals]=${v}`
    expect(await get(q(id.Mhidden!))).toEqual(await get(q(NOBODY)))
    expect((await get(q(id.Mhidden!))).status).toBe(400)
  })
  it('answers animals filtered by dam or sire the same for hidden and made-up IDs, and allows a readable one', async () => {
    for (const f of ['dam', 'sire']) {
      const q = (v: string) => `/animals?depth=0&where[${f}][equals]=${v}`
      expect(await get(q(id.Mhidden!))).toEqual(await get(q(NOBODY)))
      expect((await get(q(id.Mhidden!))).status).toBe(400)
    }
    expect(await names(`/animals?depth=0&where[dam][equals]=${id.Aaa}`)).toEqual(['kid3'])
  })
  it('refuses counting by a hidden parent', async () => {
    expect((await get(`/animals/count?where[dam][equals]=${id.Mhidden}`)).status).toBe(400)
    expect((await get(`/animals/count?where[dam][equals]=${id.Aaa}`)).status).toBe(200)
  })

  it('answers version filters the same for hidden and made-up IDs', async () => {
    const [h, n] = [await get(`/clutches/versions?depth=0&where[version.mother][equals]=${id.Mhidden}`), await get(`/clutches/versions?depth=0&where[version.mother][equals]=${NOBODY}`)]
    expect(h.status).toBe(400)
    expect(h).toEqual(n)
    const count = (v: string) => payload.countVersions({ collection: 'clutches' as never, where: { 'version.mother': { equals: v } } as never, overrideAccess: false, user: viewer })
    await expect(count(id.Mhidden!)).rejects.toThrow()
    await expect(count(NOBODY)).rejects.toThrow()
    expect((await get('/clutches/versions?depth=0&sort=version.mother')).status).toBe(400)
    expect((await get(`/clutches/versions?depth=0&where[version.mother][equals]=${id.Aaa}`)).status).toBe(200)
  })

  it('refuses listing the distinct values of a parent field with access on, and still allows it for trusted code', async () => {
    for (const [collection, field] of [['clutches', 'mother'], ['animals', 'dam'], ['animals', 'clutch.mother']] as const)
      await expect(local({ collection, field, overrideAccess: false, user: viewer })).rejects.toThrow()
    const r = await local({ collection: 'clutches', field: 'mother', overrideAccess: true })
    expect(JSON.stringify(r)).toContain(id.Mhidden)
    await expect(local({ collection: 'clutches', field: 'name', overrideAccess: false, user: viewer })).resolves.toBeTruthy()
  })

  it('applies to bulk updates and deletes with a filter on a hidden parent', async () => {
    const run = (o: object) => payload.update({ collection: 'clutches' as never, data: { name: 'x' } as never, overrideAccess: false, user: viewer, ...o } as never)
    await expect(run({ where: { mother: { equals: id.Mhidden } } })).rejects.toThrow()
    await expect(payload.delete({ collection: 'animals' as never, where: { dam: { equals: id.Mhidden } } as never, overrideAccess: false, user: viewer })).rejects.toThrow()
    expect((await payload.findByID({ collection: 'clutches' as never, id: id.C_hidden!, overrideAccess: true })).name).toBe('C_hidden')
  })

  it('refuses a parent path reached from another collection, the same for hidden and made-up IDs (REST, count, sort)', async () => {
    for (const path of ['animal.dam', 'animal.sire', 'animal.clutch.mother']) {
      const q = (v: string) => `/weighings?depth=0&where[${path}][equals]=${v}`
      expect((await get(q(id.Mhidden!))).status).toBe(400)
      expect(await get(q(id.Mhidden!))).toEqual(await get(q(NOBODY)))
      const c = (v: string) => `/weighings/count?where[${path}][equals]=${v}`
      expect((await get(c(id.Mhidden!))).status).toBe(400)
      expect(await get(c(id.Mhidden!))).toEqual(await get(c(NOBODY)))
      expect((await get(`/weighings?depth=0&sort=${path}`)).status).toBe(400)
      expect((await get(`/weighings?depth=0&sort=-${path}`)).status).toBe(400)
    }
    expect((await get('/weighings?depth=0&where[animal.dam.name][equals]=x')).status).toBe(400)
    // Below a parent field is refused even with an ID the viewer can read.
    expect((await get(`/weighings?depth=0&where[animal.dam.name][equals]=${id.Aaa}`)).status).toBe(400)
    expect((await get(`/clutches?depth=0&where[mother.name][equals]=${id.Aaa}`)).status).toBe(400)
  })
  it('still lets another collection filter through a readable parent or an ordinary field', async () => {
    expect(await names(`/weighings?depth=0&where[animal.dam][equals]=${id.Aaa}`)).toEqual(['w2'])
    expect((await get('/weighings?depth=0&where[animal.name][equals]=kid&sort=animal.name')).status).toBe(200)
  })
  it('refuses a parent path through a relationship that is not a parent field (mate.dam)', async () => {
    const q = (v: string) => `/animals?depth=0&where[mate.dam][equals]=${v}`
    expect((await get(q(id.Mhidden!))).status).toBe(400)
    expect(await get(q(id.Mhidden!))).toEqual(await get(q(NOBODY)))
    expect((await get('/animals?depth=0&sort=mate.dam')).status).toBe(400)
    expect(await names(`/animals?depth=0&where[mate.dam][equals]=${id.Aaa}`)).toEqual(['pal2'])
    expect((await get('/animals?depth=0&where[mate.name][equals]=kid')).status).toBe(200)
  })
  it('refuses a hidden parent in the where or sort of a REST join, and allows a readable one', async () => {
    const j = (v: string) => `/clutches?depth=1&where[name][equals]=C_hidden&joins[members][where][dam][equals]=${v}`
    expect((await get(j(id.Mhidden!))).status).toBe(400)
    expect(await get(j(id.Mhidden!))).toEqual(await get(j(NOBODY)))
    expect((await get('/clutches?depth=1&joins[members][sort]=dam')).status).toBe(400)
    expect((await get('/clutches?depth=1&joins[members][sort]=-dam')).status).toBe(400)
    expect((await get(`/animals?depth=1&where[name][equals]=Aaa&joins[kids][where][sire][equals]=${id.Mhidden}`)).status).toBe(400)
    expect((await get(`/clutches?depth=1&joins[members][where][dam][equals]=${id.Aaa}`)).status).toBe(200)
    expect((await get('/clutches?depth=1&joins[members][sort]=name')).status).toBe(200)
    await expect(payload.find({ collection: 'clutches' as never, joins: { members: { where: { dam: { equals: id.Mhidden } } } } as never, overrideAccess: false, user: viewer })).rejects.toThrow()
  })
  it('refuses a hidden parent in a GraphQL filter reached through another collection, as it does a join', async () => {
    const g = (v: string) => gql(`{ Weighings(where: { animal__dam: { equals: "${v}" } }) { totalDocs } }`)
    expect(await g(id.Mhidden!)).toEqual(await g(NOBODY))
    expect(JSON.stringify((await g(id.Mhidden!)).body)).not.toContain('"totalDocs":1')
    const j = (v: string) => gql(`{ Clutches(where: { name: { equals: "C_hidden" } }) { docs { members(where: { dam: { equals: "${v}" } }) { docs { name } } } } }`)
    expect(await j(id.Mhidden!)).toEqual(await j(NOBODY))
    expect(JSON.stringify((await j(id.Mhidden!)).body)).not.toContain('"kid"')
  })
  it('allows only equals, in, not_equals and not_in on a parent field, even with a readable ID', async () => {
    for (const op of ['greater_than', 'greater_than_equal', 'less_than', 'less_than_equal', 'like', 'contains', 'all'])
      for (const [coll, f] of [['clutches', 'mother'], ['animals', 'dam'], ['weighings', 'animal.dam']] as const)
        expect((await get(`/${coll}?depth=0&where[${f}][${op}]=${id.Aaa}`)).status, `${coll} ${f} ${op}`).toBe(400)
  })

  it('refuses a cohort saved with a birthing parent the editor cannot read, the same for hidden and made-up IDs', async () => {
    const msg = async (mother: string, id2?: string) => {
      try {
        if (id2) await payload.update({ collection: 'clutches' as never, id: id2, data: { mother } as never, overrideAccess: false, user: viewer })
        else await payload.create({ collection: 'clutches' as never, data: { name: 'new', mother } as never, overrideAccess: false, user: viewer })
      } catch (e) {
        return JSON.stringify((e as { data?: unknown }).data)
      }
      return 'saved'
    }
    const hiddenCreate = await msg(id.Mhidden!)
    expect(hiddenCreate).not.toBe('saved')
    expect(hiddenCreate).toBe(await msg(NOBODY))
    const hiddenUpdate = await msg(id.Mhidden!, id.C_Aaa)
    expect(hiddenUpdate).not.toBe('saved')
    expect(hiddenUpdate).toBe(await msg(NOBODY, id.C_Aaa))
    expect(await msg(id.Zzz!, id.C_Aaa)).toBe('saved')
    expect(await msg(id.Aaa!, id.C_Aaa)).toBe('saved')
  })
})
