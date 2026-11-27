import { configToSchema } from '@payloadcms/graphql'
import { createRequire } from 'node:module'
import { createLocalReq, handleEndpoints, type Access, type CollectionConfig, type Payload, type TypedUser, type Where } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { onePedigree } from '../src'
import { startPayload, usersCollection } from './helpers'
import type { Mode } from './differential.fixture'

// The same graphql copy that Payload's schema builder loads; a second copy refuses its schema.
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')
const NOBODY = '64b0000000000000000000aa'
const read: Access = ({ req }) => ((req.user as { role?: string } | null)?.role === 'admin' ? true : ({ visibility: { equals: 'public' } } as Where))
const write: Access = ({ req }) => Boolean(req.user)
const animals: CollectionConfig = {
  slug: 'animals',
  access: { read, create: write, update: write, delete: write },
  fields: [{ name: 'name', type: 'text' }, { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' }],
}

/** Standard-fields install: the parent fields live in the `parentage` group, so GraphQL spells them with `__`. */
export function standardFieldsTests(mode: Mode) {
  describe(`standard-fields differential (${mode})`, () => {
    let payload: Payload
    let stop: () => Promise<void>
    let viewer: TypedUser
    let jwt: string
    const id: Record<string, string> = {}
    const norm = (x: unknown) => {
      let s = JSON.stringify(x)
      for (const [k, v] of Object.entries(id)) s = s.split(v).join(`<${k}>`)
      return JSON.parse(s.replace(/"\d{4}-\d\d-\d\dT[^"]+"/g, '"<ts>"').replace(/"[0-9a-f]{24}"/g, '"<oid>"')) as unknown
    }
    const get = async (p: string) => {
      const r = await handleEndpoints({ config: payload.config, request: new Request(`http://localhost/api${p}`, { headers: { Authorization: `JWT ${jwt}` } }) })
      return { status: r.status, body: await r.json() }
    }
    const gql = async (q: string) => {
      const req = await createLocalReq({ user: viewer as never }, payload)
      ;(req as { payloadAPI: string }).payloadAPI = 'GraphQL'
      const { schema } = configToSchema(payload.config)
      return JSON.parse(JSON.stringify(await graphql({ schema, source: q, contextValue: { req, headers: new Headers() } }))) as unknown
    }
    const alike = async (f: (v: string) => Promise<unknown>) => {
      const run = async (v: string) => norm(await f(v).catch((e) => ({ error: String((e as Error).message) })))
      expect(await run(id.H!)).toEqual(await run(NOBODY))
    }
    beforeAll(async () => {
      ;({ payload, stop } = await startPayload({ collections: [usersCollection, animals], plugins: [onePedigree({ collection: 'animals', mode: 'standard-fields', hiddenRecords: mode })] }))
      viewer = (await payload.create({ collection: 'users', data: { email: 'v@example.com', password: 'a-long-test-password', role: 'viewer' } as never })) as TypedUser
      const r = await handleEndpoints({ config: payload.config, request: new Request('http://localhost/api/users/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'v@example.com', password: 'a-long-test-password' }) }) })
      jwt = ((await r.json()) as { token: string }).token
      id.H = String((await payload.create({ collection: 'animals' as never, data: { name: 'H', visibility: 'private' } as never })).id)
      id.kid = String((await payload.create({ collection: 'animals' as never, data: { name: 'kid', parentage: { parents: [{ individual: id.H, role: 'mother' }] } } as never })).id)
    })
    afterAll(async () => {
      await stop?.()
    })

    it('S0 dotted parents path', () => alike((v) => get(`/animals?depth=0&where[parentage.parents.individual][equals]=${v}`)))
    it('S1 REST __ parents path', () => alike((v) => get(`/animals?depth=0&where[parentage__parents__individual][equals]=${v}`)))
    it('S2 REST __ mother', () => alike((v) => get(`/animals?depth=0&where[parentage__mother][equals]=${v}`)))
    it('S3 REST count __ parents path', () => alike((v) => get(`/animals/count?where[parentage__parents__individual][equals]=${v}`)))
    it('S4 GraphQL __ parents path', () => alike((v) => gql(`{ Animals(where: { parentage__parents__individual: { equals: "${v}" } }) { totalDocs docs { name } } }`)))
    it('S5 GraphQL __ mother', () => alike((v) => gql(`{ Animals(where: { parentage__mother: { equals: "${v}" } }) { totalDocs docs { name } } }`)))
    // A sibling field in the same row says that a hidden parent exists just as the relationship does.
    for (const f of ['role', 'id'])
      it(`S7 sibling ${f} in the row: filter, count and sort are refused, or answer the same`, async () => {
        const refused = /can’t be filtered or sorted/
        for (const op of ['exists', 'equals', 'not_equals', 'like'])
          for (const key of [`parentage.parents.${f}`, `parentage__parents__${f}`]) {
            const value = op === 'exists' ? 'true' : 'mother'
            const r = await get(`/animals?depth=0&where[${key}][${op}]=${value}`)
            // With placeholders the stored rows and the shown rows match, so `exists` is the one answer that is allowed.
            if (op === 'exists' && mode === 'placeholder') expect(JSON.stringify(r.body), `${key} ${op}`).not.toMatch(refused)
            else expect(JSON.stringify(r.body), `${key} ${op}`).toMatch(refused)
          }
        expect(JSON.stringify((await get(`/animals?depth=0&sort=parentage.parents.${f}`)).body)).toMatch(refused)
        expect(JSON.stringify((await get(`/animals/count?where[parentage.parents.${f}][equals]=mother`)).body)).toMatch(refused)
        expect(JSON.stringify((await get(`/animals?depth=0&sort=-parentage__parents__${f}`)).body)).toMatch(refused)
      })
    it('S8 the rows array itself, and GraphQL spellings of a sibling field', async () => {
      const refused = /can’t be filtered or sorted/
      expect(JSON.stringify((await get(`/animals?depth=0&where[parentage.parents][equals]=x`)).body)).toMatch(refused)
      expect(JSON.stringify(await gql('{ Animals(where: { parentage__parents__role: { equals: mother } }) { totalDocs } }'))).toMatch(refused)
      expect(JSON.stringify(await gql('{ Animals(where: { parentage__parents__id: { like: "x" } }) { totalDocs } }'))).toMatch(refused)
    })
    it('S9 fields that hold no parent are still filterable', async () => {
      expect((await get(`/animals?depth=0&where[name][equals]=kid`)).status).toBe(200)
      expect((await get(`/animals?depth=0&where[parentage.reproductiveMode][exists]=true`)).status).not.toBe(500)
    })
    it('S6 sort by a parent field is refused', async () => {
      const r = await gql('{ Animals(sort: "parentage__mother") { docs { name } } }')
      expect(JSON.stringify(r)).toContain('can’t be filtered or sorted')
    })
    it('a readable id still answers from the data', async () => {
      const r = await get(`/animals?depth=0&where[name][equals]=kid`)
      expect(r.status).toBe(200)
    })
  })
}
