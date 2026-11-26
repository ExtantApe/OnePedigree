import type { Access, CollectionConfig, Payload, TypedUser, Where } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { onePedigree } from '../src'
import { callEndpoint, startPayload, usersCollection } from './helpers'

/**
 * Hidden parents must not show through which answer comes back. The parentage check and the birthing-event (cohort)
 * check read with full access for integrity; what they say back must be the same whether or not a record the
 * requester cannot read exists, is the birthing parent, or has members. Made-up data only.
 */
const role = (u: unknown) => (u as { role?: string } | null)?.role
const read: Access = ({ req }) => (role(req.user) === 'admin' ? true : ({ visibility: { equals: 'public' } } as Where))
const write: Access = ({ req }) => Boolean(req.user)

const animals: CollectionConfig = {
  slug: 'animals',
  access: { read, create: write, update: write, delete: write },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' },
    { name: 'dam', type: 'relationship', relationTo: 'animals' },
    { name: 'sire', type: 'relationship', relationTo: 'animals' },
    { name: 'clutch', type: 'relationship', relationTo: 'clutches' },
  ],
}
const clutches: CollectionConfig = {
  slug: 'clutches',
  access: { read: () => true, create: write, update: write },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'mother', type: 'relationship', relationTo: 'animals' },
  ],
}

let payload: Payload
let stop: () => Promise<void>
const users: Record<string, TypedUser> = {}
const a: Record<string, string> = {}
const c: Record<string, string> = {}
const NOBODY = '64b0000000000000000000aa'

const animal = async (key: string, data: Record<string, unknown> = {}) => {
  a[key] = String((await payload.create({ collection: 'animals' as never, data: { name: key, ...data } as never })).id)
}
const clutch = async (key: string, data: Record<string, unknown> = {}) => {
  c[key] = String((await payload.create({ collection: 'clutches' as never, data: { name: key, ...data } as never })).id)
}

/** What a failed write says back: each message with its path, nothing else. */
const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (e) {
    return ((e as { data?: { errors?: { path: string; message: string }[] } }).data?.errors ?? []).map((x) => `${x.path}: ${x.message}`)
  }
  return null
}
const asViewer = (collection: string, id: string, data: Record<string, unknown>) => () =>
  payload.update({ collection: collection as never, id, data: data as never, overrideAccess: false, user: users.viewer })

beforeAll(async () => {
  ;({ payload, stop } = await startPayload({
    collections: [usersCollection, animals, clutches],
    plugins: [
      onePedigree({
        collection: 'animals',
        mode: 'mapped',
        fields: { label: 'name', parentage: { kind: 'role-fields', roles: { mother: 'dam', father: 'sire' }, cohort: 'clutch' } },
        cohorts: { collection: 'clutches', birthParentField: 'mother' },
        hiddenRecords: 'placeholder',
      }),
    ],
  }))
  for (const r of ['admin', 'viewer'])
    users[r] = (await payload.create({ collection: 'users', data: { email: `${r}@example.com`, password: 'a-long-test-password', role: r } as never })) as TypedUser
  await animal('Secret Dam', { visibility: 'private' })
  await animal('Public Dam')
  await animal('Other Dam')
  await clutch('With hidden mother', { mother: a['Secret Dam'] })
  await clutch('Without mother')
  await animal('Kid One', { clutch: c['With hidden mother'] })
  await animal('Kid Two', { clutch: c['Without mother'] })
  await animal('Kid Three', { clutch: c['With hidden mother'] })
})
afterAll(async () => stop?.())

describe('parentage check does not reveal the birthing parent', () => {
  it('answers the same for a hidden birthing parent as for an ID that does not exist', async () => {
    // The cohort's mother is a private animal. Guessing it, or guessing a made-up ID, gives the same reply.
    const guessRight = await refusal(asViewer('animals', a['Kid One']!, { dam: a['Secret Dam'] }))
    const guessNothing = await refusal(asViewer('animals', a['Kid One']!, { dam: NOBODY }))
    expect(guessRight).not.toBeNull()
    expect(guessRight).toEqual(guessNothing)
    expect(guessRight!.every((m) => !/birthing event/.test(m))).toBe(true)
  })

  it('answers the same whether the cohort has a hidden mother or none', async () => {
    const body = (id: string, cohort: string) => ({ id, parents: [{ individual: a['Public Dam'], role: 'mother' }], cohort })
    const call = (id: string, cohort: string) => callEndpoint(payload, 'animals', '/:id/pedigree/validate', { id }, { user: users.viewer!, body: body(id, cohort) })
    const hidden = await call(a['Kid One']!, c['With hidden mother']!)
    const none = await call(a['Kid Two']!, c['Without mother']!)
    expect(hidden.body.valid).toBe(true)
    expect(hidden.body).toEqual(none.body)
  })

  it('still refuses a visible mother that differs from a visible birthing parent', async () => {
    await clutch('Visible mother', { mother: a['Public Dam'] })
    await animal('Kid Four', { clutch: c['Visible mother'] })
    const said = await refusal(asViewer('animals', a['Kid Four']!, { dam: a['Other Dam'] }))
    expect(said).toEqual([expect.stringMatching(/^clutch: .*birthing event/)])
  })

  it('still refuses a different mother for trusted server code', async () => {
    const said = await refusal(() => payload.update({ collection: 'animals' as never, id: a['Kid One']!, data: { dam: a['Public Dam'] } as never }))
    expect(said).toEqual([expect.stringMatching(/^clutch: .*birthing event/)])
  })
})

describe('setting a birthing parent does not reveal hidden members', () => {
  it('answers the same whether or not a hidden member records a different mother', async () => {
    await clutch('Has hidden member')
    await clutch('Has no members')
    await animal('Hidden member', { visibility: 'private', clutch: c['Has hidden member'], dam: a['Other Dam'] })
    const withHidden = await refusal(asViewer('clutches', c['Has hidden member']!, { mother: a['Public Dam'] }))
    const without = await refusal(asViewer('clutches', c['Has no members']!, { mother: a['Public Dam'] }))
    expect(withHidden).toEqual(without)
    expect(without).toBeNull()
  })

  it('still refuses when a member the requester can read records a different mother', async () => {
    await clutch('Has visible member')
    await animal('Visible member', { clutch: c['Has visible member'], dam: a['Other Dam'] })
    const said = await refusal(asViewer('clutches', c['Has visible member']!, { mother: a['Public Dam'] }))
    expect(said).toEqual([expect.stringMatching(/^mother: 1 member\(s\).*different mother/)])
  })

  it('counts hidden members for trusted server code', async () => {
    await clutch('Has hidden member too')
    await animal('Hidden member too', { visibility: 'private', clutch: c['Has hidden member too'], dam: a['Other Dam'] })
    const said = await refusal(() => payload.update({ collection: 'clutches' as never, id: c['Has hidden member too']!, data: { mother: a['Public Dam'] } as never }))
    expect(said).toEqual([expect.stringMatching(/^mother: 1 member\(s\)/)])
  })
})
