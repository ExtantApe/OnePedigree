import { createLocalReq, type Access, type CollectionConfig, type Payload, type PayloadRequest, type TypedUser, type Where } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { onePedigree, withStoredParents } from '../src'
import { startPayload, usersCollection } from './helpers'

/**
 * The plugin's own flags never stay on the caller's request (2026-11-25). Payload merges a
 * nested call's `context` into the req it is given and leaves it there, and runs a bulk update's docs in parallel
 * on one req. A skip flag, the trusted flag or the raw-parents counter left on that req made sibling writes skip
 * the parentage checks and sibling reads skip redaction. Each test below failed before nested calls got a child req.
 */
const role = (u: unknown) => (u as { role?: string } | null)?.role
const uid = (u: unknown) => (u as { id?: string } | null)?.id
const read: Access = ({ req }) =>
  role(req.user) === 'admin' ? true : ({ or: [{ visibility: { equals: 'public' } }, ...(req.user ? [{ owner: { equals: uid(req.user) } }] : [])] } as Where)
const write: Access = ({ req }) => (role(req.user) === 'admin' ? true : req.user ? ({ owner: { equals: uid(req.user) } } as Where) : false)

const animals: CollectionConfig = {
  slug: 'animals',
  access: { read, create: write, update: write, delete: write },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' },
    { name: 'owner', type: 'relationship', relationTo: 'users' },
  ],
}

const SKIP = 'onepedigreeInternal'
const TRUSTED = 'onepedigreeOverrideAccess'
const RAW = 'onepedigreeRawParents'

let payload: Payload
let stop: () => Promise<void>
const users: Record<string, TypedUser> = {}
const a: Record<string, string> = {}

const create = async (key: string, data: Record<string, unknown> = {}) => {
  a[key] = String((await payload.create({ collection: 'animals' as never, data: { name: key, ...data } as never })).id)
}
const parents = (...list: [string, 'mother' | 'father'][]) => ({ parentage: { parents: list.map(([k, r]) => ({ individual: a[k], role: r })) } })
const reqFor = (who: string) => createLocalReq({ user: users[who] }, payload)
const update = (req: PayloadRequest, key: string, data: Record<string, unknown>, overrideAccess = true) =>
  payload.update({ collection: 'animals' as never, id: a[key]!, data: data as never, req, overrideAccess, user: req.user } as never)

beforeAll(async () => {
  ;({ payload, stop } = await startPayload({
    collections: [usersCollection, animals],
    plugins: [onePedigree({ collection: 'animals', mode: 'standard-fields', hiddenRecords: 'placeholder', onReferencedIndividualDelete: 'detach' })],
  }))
  for (const [name, r] of [['admin', 'admin'], ['owner', 'viewer'], ['member', 'viewer']] as const)
    users[name] = (await payload.create({ collection: 'users', data: { email: `${name}@example.com`, password: 'a-long-test-password', role: r } as never })) as TypedUser
  // P is private to its owner and is Q's mother.
  await create('P', { visibility: 'private', owner: users.owner!.id })
  await create('Q', { owner: users.owner!.id, ...parents(['P', 'mother']) })
  for (const k of ['A', 'B', 'X', 'Y', 'Z']) await create(k, { owner: users.owner!.id })
}, 120_000)

afterAll(async () => {
  await stop?.()
})

describe('nested writes run on a child request', () => {
  it('a later write on the same request is still checked after a parentage change', async () => {
    const req = await reqFor('admin')
    await update(req, 'X', parents(['B', 'mother']))
    expect(req.context[SKIP]).toBeUndefined()
    await expect(update(req, 'A', parents(['A', 'mother']))).rejects.toMatchObject({ data: { errors: [{ message: expect.stringMatching(/own parent/) }] } })
  })

  it('a detach on delete leaves the caller trusted only as it asked', async () => {
    await create('D', { owner: users.owner!.id })
    await create('DChild', { owner: users.owner!.id, ...parents(['D', 'father']) })
    const req = await reqFor('owner')
    await payload.delete({ collection: 'animals' as never, id: a.D!, req, overrideAccess: false, user: req.user } as never)
    expect(req.context[TRUSTED]).not.toBe(true)
    expect(req.context[SKIP]).toBeUndefined()
    const child = (await payload.findByID({ collection: 'animals' as never, id: a.DChild!, depth: 0 })) as { parentage?: { parents?: unknown[] } }
    expect(child.parentage?.parents ?? []).toHaveLength(0)
  })
})

describe('withStoredParents', () => {
  const asMember = (req: PayloadRequest) =>
    payload.findByID({ collection: 'animals' as never, id: a.Q!, depth: 0, req, overrideAccess: false, user: req.user } as never)

  it('reads stored parents only through the child request it hands over', async () => {
    const req = await reqFor('member')
    const result = await withStoredParents(req, async (rawReq) => ({ raw: await asMember(rawReq), outer: await asMember(req) }))
    expect(JSON.stringify(result.raw)).toContain(a.P)
    expect(JSON.stringify(result.outer)).not.toContain(a.P)
    expect(req.context[RAW]).toBeUndefined()
  })

  it('a sibling read that runs alongside it is still redacted', async () => {
    const req = await reqFor('member')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const inside = withStoredParents(req, async () => {
      await held
    })
    const sibling = await asMember(req)
    release()
    await inside
    expect(JSON.stringify(sibling)).not.toContain(a.P)
  })
})

describe('bulk updates', () => {
  it('check every doc and redact every result when docs run in parallel on one request', async () => {
    const req = await reqFor('admin')
    const res = (await payload.update({
      collection: 'animals' as never,
      where: { id: { in: [a.Y, a.Z] } },
      data: parents(['Y', 'mother']) as never,
      req,
    } as never)) as { docs: { id: string }[]; errors: { id: string; message: string }[] }
    expect(res.errors.map((e) => String(e.id))).toContain(a.Y)
    expect(res.docs.map((d) => String(d.id))).toContain(a.Z)
    expect(req.context[SKIP]).toBeUndefined()
  })
})
