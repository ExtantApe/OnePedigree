import { configToSchema } from '@payloadcms/graphql'
import { createRequire } from 'node:module'
import { createLocalReq, handleEndpoints, type Access, type CollectionConfig, type Config, type Payload, type TypedUser, type Where } from 'payload'
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
  access: { read: () => true, create: write, update: write, readVersions: () => true },
  versions: { maxPerDoc: 5 },
  fields: [{ name: 'name', type: 'text' }, { name: 'animal', type: 'relationship', relationTo: 'animals' }, { name: 'herd', type: 'relationship', relationTo: 'animals', hasMany: true }],
}

/** A collection added by a plugin that runs after OnePedigree, so it is not in the config OnePedigree sees. */
const notes: CollectionConfig = { slug: 'notes', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, { name: 'animal', type: 'relationship', relationTo: 'animals' }] }
const laterPlugin = (config: Config): Config => ({ ...config, collections: [...(config.collections ?? []), notes] })

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
      plugins: [onePedigree({ collection: 'animals', mode: 'mapped', fields: { label: 'name', parentage: { kind: 'role-fields', roles: { mother: 'dam', father: 'sire' }, cohort: 'clutch' } }, cohorts: { collection: 'clutches', birthParentField: 'mother' }, hiddenRecords }), laterPlugin],
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
    await mk('weighings', 'w1', { animal: id.kid, herd: [id.kid] })
    await mk('weighings', 'w2', { animal: id.kid3, herd: [id.kid3] })
    await mk('notes', 'n1', { animal: id.kid })
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

  it('refuses a path of nine or more relationship hops instead of letting it through', async () => {
    const chain = (n: number) => Array(n).fill('mate').join('.')
    for (const hops of [8, 9, 12]) {
      const q = (v: string) => `/animals?depth=0&where[${chain(hops)}.dam][equals]=${v}`
      expect((await get(q(id.Mhidden!))).status, `${hops} hops`).toBe(400)
      expect(await get(q(id.Mhidden!))).toEqual(await get(q(NOBODY)))
    }
    expect((await get(`/animals/count?where[${chain(9)}.dam][equals]=${id.Mhidden}`)).status).toBe(400)
    expect((await get(`/animals?depth=0&sort=${chain(9)}.dam`)).status).toBe(400)
    await expect(payload.find({ collection: 'animals' as never, where: { [`${chain(9)}.dam`]: { equals: id.Mhidden } } as never, overrideAccess: false, user: viewer })).rejects.toThrow()
  })
  it('guards a collection that a later plugin adds, on filter, count and sort', async () => {
    const q = (v: string) => `/notes?depth=0&where[animal.dam][equals]=${v}`
    expect((await get(q(id.Mhidden!))).status).toBe(400)
    expect(await get(q(id.Mhidden!))).toEqual(await get(q(NOBODY)))
    expect((await get(`/notes/count?where[animal.dam][equals]=${id.Mhidden}`)).status).toBe(400)
    expect((await get('/notes?depth=0&sort=animal.dam')).status).toBe(400)
    expect(await names(`/notes?depth=0&where[animal.dam][equals]=${id.Aaa}`)).toEqual([])
    expect((await get('/notes?depth=0&where[animal.name][equals]=kid')).status).toBe(200)
  })
  it('refuses an operand that is an object without an ID or a list of them, in every mode', async () => {
    for (const w of ['where[dam][in][a]=x', 'where[dam][in][0][a]=x', 'where[dam][equals][a]=x', 'where[dam][not_in][0][b][c]=x', `where[dam][in][0]=${id.Aaa}&where[dam][in][1][a]=x`])
      expect((await get(`/animals?depth=0&${w}`)).status, w).toBe(400)
    // Payload's query parser drops entries past index 1000 over REST, so a long list is tested through the Local API.
    const long = [...Array(1000).fill(id.Aaa), { a: 1 }]
    await expect(payload.find({ collection: 'animals' as never, where: { dam: { in: long } } as never, overrideAccess: false, user: viewer })).rejects.toThrow()
    await expect(payload.find({ collection: 'animals' as never, where: { dam: { in: { a: 1 } } } as never, overrideAccess: false, user: viewer })).rejects.toThrow()
    await expect(payload.find({ collection: 'animals' as never, where: { dam: { in: [{ a: 1 }] } } as never, overrideAccess: false, user: viewer })).rejects.toThrow()
  })
  it('allows exists on a parent field only with placeholders, from the individuals, the cohorts and another collection', async () => {
    const want = hiddenRecords === 'placeholder' ? 200 : 400
    for (const p of ['/animals?depth=0&where[dam][exists]=true', '/animals?depth=0&where[dam][exists]=false', '/animals/count?where[dam][exists]=true', '/clutches?depth=0&where[mother][exists]=false', '/weighings?depth=0&where[animal.dam][exists]=true', '/notes?depth=0&where[animal.dam][exists]=true'])
      expect((await get(p)).status, p).toBe(want)
    const local = payload.find({ collection: 'animals' as never, where: { dam: { exists: true } } as never, overrideAccess: false, user: viewer })
    if (hiddenRecords === 'placeholder') await expect(local).resolves.toBeTruthy()
    else await expect(local).rejects.toThrow()
  })

  // Payload and the database adapter turn `__` into `.` (GraphQL's group separator), so these spellings reach the same fields.
  const same = async (path: (v: string) => string, init?: RequestInit) => {
    const [h, n] = [await call(path(id.Mhidden!), init), await call(path(NOBODY), init)]
    expect(h.status, path(id.Mhidden!)).toBe(400)
    expect(h).toEqual(n)
  }
  it('treats a double underscore as a dot in REST filters, counts and sorts, for role fields and other collections', async () => {
    for (const f of ['dam', 'sire']) await same((v) => `/animals?depth=0&where[${f}][equals]=${v}`)
    for (const f of ['animal__dam', 'animal__sire', 'animal__clutch__mother', 'animal.clutch__mother', 'animal__clutch.mother']) {
      await same((v) => `/weighings?depth=0&where[${f}][equals]=${v}`)
      await same((v) => `/weighings/count?where[${f}][equals]=${v}`)
      expect((await get(`/weighings?depth=0&sort=${f}`)).status, f).toBe(400)
    }
    await same((v) => `/animals?depth=0&where[mate__dam][equals]=${v}`)
    await same((v) => `/animals/count?where[mate__dam][equals]=${v}`)
    await same((v) => `/notes?depth=0&where[animal__dam][equals]=${v}`)
    await same((v) => `/animals?depth=0&where[clutch__mother][equals]=${v}`)
    await same((v) => `/animals?depth=0&where[or][0][mate__dam][equals]=${v}`)
    expect((await get('/animals?depth=0&sort=-mate__dam')).status).toBe(400)
    expect((await get(`/weighings?depth=0&where[animal__dam__name][equals]=${id.Aaa}`)).status).toBe(400)
    expect((await get(`/animals?depth=0&where[mate__dam][like]=${id.Aaa}`)).status).toBe(400)
    // Readable IDs and ordinary fields still work.
    expect(await names(`/animals?depth=0&where[mate__dam][equals]=${id.Aaa}`)).toEqual(['pal2'])
    expect(await names(`/weighings?depth=0&where[animal__dam][equals]=${id.Aaa}`)).toEqual(['w2'])
    expect((await get('/animals?depth=0&where[mate__name][equals]=kid&sort=mate__name')).status).toBe(200)
  })
  it('treats a double underscore as a dot in versions, joins and bulk changes', async () => {
    await same((v) => `/clutches/versions?depth=0&where[version__mother][equals]=${v}`)
    expect((await get('/clutches/versions?depth=0&sort=version__mother')).status).toBe(400)
    expect((await get(`/clutches/versions?depth=0&where[version__mother][equals]=${id.Aaa}`)).status).toBe(200)
    await same((v) => `/clutches?depth=1&where[name][equals]=C_hidden&joins[members][where][clutch__mother][equals]=${v}`)
    await same((v) => `/clutches?depth=1&where[name][equals]=C_hidden&joins[members][where][mate__dam][equals]=${v}`)
    expect((await get('/clutches?depth=1&joins[members][sort]=mate__dam')).status).toBe(400)
    await same((v) => `/animals?depth=0&where[mate__dam][equals]=${v}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    await same((v) => `/animals?depth=0&where[mate__dam][equals]=${v}`, { method: 'DELETE' })
    expect((await get(`/clutches?depth=1&joins[members][where][mate__dam][equals]=${id.Aaa}`)).status).toBe(200)
  })
  it('treats a double underscore as a dot in Local API reads, bulk changes and distinct lists', async () => {
    const as = { overrideAccess: false, user: viewer }
    for (const v of [id.Mhidden!, NOBODY]) {
      await expect(payload.find({ collection: 'animals' as never, where: { mate__dam: { equals: v } } as never, ...as })).rejects.toThrow()
      await expect(payload.count({ collection: 'animals' as never, where: { mate__dam: { equals: v } } as never, ...as })).rejects.toThrow()
      await expect(payload.find({ collection: 'weighings' as never, where: { animal__clutch__mother: { equals: v } } as never, ...as })).rejects.toThrow()
      await expect(payload.countVersions({ collection: 'clutches' as never, where: { version__mother: { equals: v } } as never, ...as })).rejects.toThrow()
      await expect(payload.update({ collection: 'animals' as never, data: { name: 'x' } as never, where: { mate__dam: { equals: v } } as never, ...as })).rejects.toThrow()
      await expect(payload.delete({ collection: 'animals' as never, where: { mate__dam: { equals: v } } as never, ...as })).rejects.toThrow()
      await expect(payload.find({ collection: 'clutches' as never, joins: { members: { where: { mate__dam: { equals: v } } } } as never, ...as })).rejects.toThrow()
    }
    for (const [collection, field] of [['animals', 'mate__dam'], ['animals', 'clutch__mother'], ['weighings', 'animal__dam']] as const)
      await expect(local({ collection, field, overrideAccess: false, user: viewer })).rejects.toThrow()
    await expect(payload.find({ collection: 'animals' as never, where: { mate__dam: { equals: id.Aaa } } as never, ...as })).resolves.toBeTruthy()
    expect((await payload.findByID({ collection: 'animals' as never, id: id.kid2!, overrideAccess: true })).name).toBe('kid2')
  })
  it('allows exists through a double underscore only with placeholders, like the dotted path', async () => {
    const want = hiddenRecords === 'placeholder' ? 200 : 400
    for (const p of ['/animals?depth=0&where[mate__dam][exists]=true', '/animals/count?where[mate__dam][exists]=false', '/weighings?depth=0&where[animal__dam][exists]=true', '/notes?depth=0&where[animal__dam][exists]=true'])
      expect((await get(p)).status, p).toBe(want)
  })
  it('treats a double underscore as a dot in GraphQL filters, sorts and joins', async () => {
    const eq = async (q: (v: string) => string) => {
      const [h, n] = [await gql(q(id.Mhidden!)), await gql(q(NOBODY))]
      expect(h.body.errors?.length, q('x')).toBeGreaterThan(0)
      expect(h).toEqual(n)
    }
    await eq((v) => `{ Animals(where: { mate__dam: { equals: "${v}" } }) { totalDocs } }`)
    await eq((v) => `{ Animals(where: { clutch__mother: { equals: "${v}" } }) { docs { name } } }`)
    await eq((v) => `{ countAnimals(where: { mate__dam: { equals: "${v}" } }) { totalDocs } }`)
    await eq((v) => `{ Weighings(where: { animal__clutch__mother: { equals: "${v}" } }) { totalDocs } }`)
    expect((await gql('{ Animals(sort: "mate__dam") { docs { name } } }')).body.errors?.length).toBeGreaterThan(0)
  })
  it('refuses a placeholder-shaped operand that carries more than the placeholder, in every mode', async () => {
    const as = { overrideAccess: false, user: viewer }
    const extra = { private: true, relationTo: 'animals', value: id.Mhidden }
    await expect(payload.find({ collection: 'animals' as never, where: { dam: { equals: extra } } as never, ...as })).rejects.toThrow()
    await expect(payload.find({ collection: 'animals' as never, where: { dam: { in: [extra] } } as never, ...as })).rejects.toThrow()
    expect((await get(`/animals?depth=0&where[dam][equals][private]=true&where[dam][equals][value]=${id.Mhidden}`)).status).toBe(400)
  })

  it('checks a nested filter on a relationship against the related collection (contains, not_equals, exists)', async () => {
    for (const f of ['herd', 'animal', 'version.herd']) {
      const base = f.startsWith('version') ? '/weighings/versions?depth=0' : '/weighings?depth=0'
      for (const [op, inner] of [['contains', 'dam'], ['contains', 'sire'], ['contains', 'clutch][mother'], ['not_equals', 'dam'], ['contains', 'mate__dam']]) {
        if (f === 'animal' && op === 'contains') continue
        await same((v) => `${base}&where[${f}][${op}][${inner}][equals]=${v}`)
      }
    }
    await same((v) => `/weighings/count?where[herd][contains][dam][equals]=${v}`)
    await same((v) => `/weighings/count?where[herd][contains][dam][in]=${v}`)
    await same((v) => `/weighings/count?where[or][0][herd][contains][dam][equals]=${v}`)
    await same((v) => `/weighings?depth=0&where[herd][contains][and][0][dam][equals]=${v}`)
    await same((v) => `/weighings?depth=0&where[herd][contains][dam][equals]=${v}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    // Readable IDs and ordinary inner fields still work.
    expect((await get(`/weighings/count?where[herd][contains][dam][equals]=${id.Aaa}`)).status).toBe(200)
    expect((await get('/weighings/count?where[herd][contains][name][equals]=kid')).status).toBe(200)
    expect((await get(`/weighings?depth=0&where[herd][contains][dam][like]=${id.Aaa}`)).status).toBe(400)
    const want = hiddenRecords === 'placeholder' ? 200 : 400
    for (const p of ['/weighings/count?where[herd][contains][dam][exists]=true', '/weighings?depth=0&where[herd][contains][mate.dam][exists]=true'])
      expect((await get(p)).status, p).toBe(want)
  })
  it('checks a nested filter on a relationship in Local reads, counts, versions and bulk changes', async () => {
    const as = { overrideAccess: false, user: viewer }
    for (const v of [id.Mhidden!, NOBODY]) {
      const where = { herd: { contains: { dam: { equals: v } } } } as never
      await expect(payload.find({ collection: 'weighings' as never, where, ...as })).rejects.toThrow()
      await expect(payload.count({ collection: 'weighings' as never, where, ...as })).rejects.toThrow()
      await expect(payload.find({ collection: 'weighings' as never, where: { herd: { not_equals: { dam: { equals: v } } } } as never, ...as })).rejects.toThrow()
      await expect(payload.countVersions({ collection: 'weighings' as never, where: { 'version.herd': { contains: { dam: { equals: v } } } } as never, ...as })).rejects.toThrow()
      await expect(payload.update({ collection: 'weighings' as never, data: { name: 'x' } as never, where, ...as })).rejects.toThrow()
    }
    await expect(payload.count({ collection: 'weighings' as never, where: { herd: { contains: { dam: { equals: id.Aaa } } } } as never, ...as })).resolves.toBeTruthy()
  })
  it('joins are looked up by the name as given, so a join filter on a parent field is still refused', async () => {
    await same((v) => `/clutches?depth=1&where[name][equals]=C_hidden&joins[members][where][dam][equals]=${v}`)
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
