import { configToSchema } from '@payloadcms/graphql'
import { createRequire } from 'node:module'
import { createLocalReq, handleEndpoints, type Access, type CollectionConfig, type Payload, type TypedUser, type Where } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { onePedigree } from '../src'
import { startPayload, usersCollection } from './helpers'

/**
 * On a standard-fields install the parent fields sit in a group, and GraphQL writes group paths with a double
 * underscore (`parentage__parents__individual`). Payload and the database turn that into a dot, so it must be guarded
 * exactly like the dotted path. Made-up data only.
 */
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')
const role = (u: unknown) => (u as { role?: string } | null)?.role
const read: Access = ({ req }) => (role(req.user) === 'admin' ? true : ({ visibility: { equals: 'public' } } as Where))
const write: Access = ({ req }) => Boolean(req.user)
const animals: CollectionConfig = {
  slug: 'animals',
  access: { read, create: write, update: write, delete: write },
  versions: { maxPerDoc: 5 },
  fields: [{ name: 'name', type: 'text' }, { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' }],
}
const NOBODY = '64b0000000000000000000aa'

export const underscoreStandardTests = (hiddenRecords: 'omit' | 'placeholder') => describe(`double underscore, standard fields (${hiddenRecords})`, () => {
  let payload: Payload
  let stop: () => Promise<void>
  let viewer: TypedUser
  let jwt: string
  const id: Record<string, string> = {}
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await handleEndpoints({ config: payload.config, request: new Request(`http://localhost/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `JWT ${jwt}` } : {}) } }) })
    return { status: res.status, body: (await res.json()) as unknown }
  }
  const gql = async (query: string) => {
    const req = await createLocalReq({ user: viewer as never }, payload)
    ;(req as { payloadAPI: string }).payloadAPI = 'GraphQL'
    const { schema } = configToSchema(payload.config)
    return JSON.parse(JSON.stringify(await graphql({ schema, source: query, contextValue: { req, headers: new Headers() } }))) as { errors?: unknown[] }
  }
  const same = async (path: (v: string) => string, init?: RequestInit) => {
    const [h, n] = [await call(path(id.H!), init), await call(path(NOBODY), init)]
    expect(h.status, path(id.H!)).toBe(400)
    expect(h).toEqual(n)
  }
  beforeAll(async () => {
    ;({ payload, stop } = await startPayload({ collections: [usersCollection, animals], plugins: [onePedigree({ collection: 'animals', mode: 'standard-fields', hiddenRecords })] }))
    viewer = (await payload.create({ collection: 'users', data: { email: 'v@example.com', password: 'a-long-test-password', role: 'viewer' } as never })) as TypedUser
    const login = await call('/users/login', { method: 'POST', body: JSON.stringify({ email: 'v@example.com', password: 'a-long-test-password' }) })
    jwt = (login.body as { token: string }).token
    id.H = String((await payload.create({ collection: 'animals' as never, data: { name: 'H', visibility: 'private' } as never })).id)
    id.A = String((await payload.create({ collection: 'animals' as never, data: { name: 'A' } as never })).id)
    await payload.create({ collection: 'animals' as never, data: { name: 'kid', parentage: { parents: [{ individual: id.H, role: 'mother' }] } } as never })
  })
  afterAll(async () => stop?.())

  it('guards the dotted and double underscore paths alike, over REST, count and sort', async () => {
    for (const f of ['parentage.parents.individual', 'parentage__parents__individual', 'parentage.parents__individual', 'parentage__mother', 'parentage.father']) {
      await same((v) => `/animals?depth=0&where[${f}][equals]=${v}`)
      await same((v) => `/animals/count?where[${f}][equals]=${v}`)
      expect((await call(`/animals?depth=0&sort=${f}`)).status, f).toBe(400)
    }
    await same((v) => `/animals/versions?depth=0&where[version__parentage__parents__individual][equals]=${v}`)
    await same((v) => `/animals?depth=0&where[parentage__parents__individual][equals]=${v}`, { method: 'PATCH', body: '{}' })
    expect((await call(`/animals?depth=0&where[parentage__parents__individual][equals]=${id.A}`)).status).toBe(200)
    expect((await call(`/animals?depth=0&where[parentage__parents__individual][exists]=true`)).status).toBe(hiddenRecords === 'placeholder' ? 200 : 400)
  })
  it('guards the double underscore path in Local reads and GraphQL', async () => {
    const as = { overrideAccess: false, user: viewer }
    for (const v of [id.H!, NOBODY]) {
      await expect(payload.find({ collection: 'animals' as never, where: { parentage__parents__individual: { equals: v } } as never, ...as })).rejects.toThrow()
      await expect(payload.update({ collection: 'animals' as never, data: {} as never, where: { parentage__mother: { equals: v } } as never, ...as })).rejects.toThrow()
    }
    const g = async (v: string) => gql(`{ Animals(where: { parentage__parents__individual: { equals: "${v}" } }) { totalDocs docs { name } } }`)
    const [h, n] = [await g(id.H!), await g(NOBODY)]
    expect(h.errors?.length).toBeGreaterThan(0)
    expect(h).toEqual(n)
    const m = async (v: string) => gql(`{ Animals(where: { parentage__mother: { equals: "${v}" } }) { totalDocs } }`)
    expect(await m(id.H!)).toEqual(await m(NOBODY))
    expect((await gql('{ Animals(sort: "parentage__mother") { docs { name } } }')).errors?.length).toBeGreaterThan(0)
  })
})
