import type { Access, CollectionConfig, Payload, TypedUser, Where } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { onePedigree } from '../src'
import { callEndpoint, startPayload, usersCollection } from './helpers'

/**
 * Each operation carries its own access mode, and a cohort's hidden birthing parent stays hidden. A host hook that
 * writes with access overridden, on the same request, must not switch the checks off for the write it sits inside.
 * Made-up data only.
 */
const role = (u: unknown) => (u as { role?: string } | null)?.role
const read: Access = ({ req }) => (role(req.user) === 'admin' ? true : ({ visibility: { equals: 'public' } } as Where))
const write: Access = ({ req }) => Boolean(req.user)

const ids: Record<string, string> = {}
let nested = 0
const NOBODY = '64b0000000000000000000aa'

const animals: CollectionConfig = {
  slug: 'animals',
  access: { read, create: write, update: write, delete: write },
  hooks: {
    // A host hook: touches a cohort on the same request, with access overridden (the Local API default).
    beforeChange: [
      async ({ req, data, operation }) => {
        if (operation === 'update' && ids.touchClutch) await req.payload.update({ collection: 'clutches' as never, id: ids.touchClutch, data: { name: 'touched' } as never, req })
        if (operation === 'update' && ids.touchClutch) nested++
        return data
      },
    ],
  },
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
  access: { read, create: write, update: write },
  hooks: {
    beforeChange: [
      async ({ req, data, operation }) => {
        if (operation === 'update' && ids.touchAnimal) await req.payload.update({ collection: 'animals' as never, id: ids.touchAnimal, data: { name: 'touched' } as never, req })
        return data
      },
    ],
  },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' },
    { name: 'mother', type: 'relationship', relationTo: 'animals' },
  ],
}

let payload: Payload
let stop: () => Promise<void>
const users: Record<string, TypedUser> = {}

const animal = async (key: string, data: Record<string, unknown> = {}) => {
  ids[key] = String((await payload.create({ collection: 'animals' as never, data: { name: key, ...data } as never })).id)
}
const clutch = async (key: string, data: Record<string, unknown> = {}) => {
  ids[key] = String((await payload.create({ collection: 'clutches' as never, data: { name: key, ...data } as never })).id)
}
const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (e) {
    const x = e as { data?: { errors?: { path: string; message: string }[] }; message?: string; status?: number }
    return x.data?.errors?.map((m) => `${m.path}: ${m.message}`) ?? [`${x.status}: ${x.message}`]
  }
  return null
}
const asViewer = (collection: string, id: string, data: Record<string, unknown>) => () =>
  payload.update({ collection: collection as never, id, data: data as never, overrideAccess: false, user: users.viewer })
const stored = (collection: string, id: string) => payload.findByID({ collection: collection as never, id, depth: 0 }) as unknown as Promise<Record<string, unknown>>

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
  await animal('Lone')
  await animal('Touch')
  await clutch('Touch clutch')
  await clutch('Has hidden member')
  await clutch('Has no members')
  await animal('Hidden member', { visibility: 'private', clutch: ids['Has hidden member'], dam: ids['Other Dam'] })
  await clutch('Private clutch', { visibility: 'private', mother: ids['Other Dam'] })
  await clutch('Secret mother', { mother: ids['Secret Dam'] })
})
afterAll(async () => stop?.())

describe('a nested trusted write does not switch the checks off for the write around it', () => {
  it('individuals: a viewer still cannot store a hidden parent', async () => {
    ids.touchClutch = ids['Touch clutch']!
    try {
      const said = await refusal(asViewer('animals', ids.Lone!, { dam: ids['Secret Dam'] }))
      expect(said).toEqual([expect.stringMatching(/does not exist or you cannot access/)])
      expect((await stored('animals', ids.Lone!)).dam ?? null).toBeNull()
      // The host hook's nested trusted write did run, inside the refused write.
      expect(nested).toBeGreaterThan(0)
    } finally {
      delete ids.touchClutch
    }
  })

  it('cohorts: hidden members still do not change the answer', async () => {
    ids.touchAnimal = ids.Touch!
    try {
      const withHidden = await refusal(asViewer('clutches', ids['Has hidden member']!, { mother: ids['Public Dam'] }))
      const without = await refusal(asViewer('clutches', ids['Has no members']!, { mother: ids['Public Dam'] }))
      expect(withHidden).toBeNull()
      expect(without).toBeNull()
      expect((await stored('animals', ids.Touch!)).name).toBe('touched')
    } finally {
      delete ids.touchAnimal
    }
  })

  it('trusted writes are still trusted', async () => {
    ids.touchClutch = ids['Touch clutch']!
    try {
      // Server code with access overridden may set a hidden parent.
      await payload.update({ collection: 'animals' as never, id: ids.Lone!, data: { dam: ids['Secret Dam'] } as never })
      expect(String((await stored('animals', ids.Lone!)).dam)).toBe(ids['Secret Dam'])
    } finally {
      delete ids.touchClutch
    }
  })
})

describe('a cohort the requester cannot read', () => {
  it('answers the same as a cohort that does not exist', async () => {
    const call = (cohort: string) =>
      callEndpoint(payload, 'animals', '/:id/pedigree/validate', { id: ids.Lone! }, { user: users.viewer!, body: { id: ids.Lone, parents: [{ individual: ids['Public Dam'], role: 'mother' }], cohort } })
    const hidden = await call(ids['Private clutch']!)
    const made = await call(NOBODY)
    expect(hidden.body.valid).toBe(true)
    expect(hidden.body).toEqual(made.body)
  })

  it('is still checked for trusted server code', async () => {
    await animal('Kid', { clutch: ids['Private clutch'] })
    const said = await refusal(() => payload.update({ collection: 'animals' as never, id: ids.Kid!, data: { dam: ids['Public Dam'] } as never }))
    expect(said).toEqual([expect.stringMatching(/birthing event/)])
  })
})

describe('a cohort does not reveal a hidden birthing parent', () => {
  const asReader = (id: string) => payload.findByID({ collection: 'clutches' as never, id, depth: 0, overrideAccess: false, user: users.viewer }) as unknown as Promise<{ mother?: unknown }>

  it('shows a placeholder on single and list reads, with no ID anywhere', async () => {
    const one = await asReader(ids['Secret mother']!)
    expect(one.mother).toEqual({ private: true })
    const list = await payload.find({ collection: 'clutches' as never, depth: 0, overrideAccess: false, user: users.viewer })
    expect(JSON.stringify([one, list])).not.toContain(ids['Secret Dam']!)
  })

  it('shows a readable birthing parent as before, and trusted reads are unchanged', async () => {
    await clutch('Open mother', { mother: ids['Public Dam'] })
    expect(String((await asReader(ids['Open mother']!)).mother)).toBe(ids['Public Dam'])
    expect(String((await stored('clutches', ids['Secret mother']!)).mother)).toBe(ids['Secret Dam'])
  })

  it('refuses to filter by the birthing parent, so a hidden ID cannot be probed', async () => {
    for (const where of [{ mother: { equals: ids['Secret Dam'] } }, { and: [{ name: { exists: true } }, { mother: { equals: NOBODY } }] }]) {
      const said = await refusal(() => payload.find({ collection: 'clutches' as never, where: where as never, overrideAccess: false, user: users.viewer }))
      expect(said).toEqual([expect.stringMatching(/^400: .*filtered/)])
    }
    const trusted = await payload.find({ collection: 'clutches' as never, where: { mother: { equals: ids['Secret Dam'] } } as never })
    expect(trusted.docs.map((d) => d.name)).toEqual(['Secret mother'])
  })

  it('keeps a hidden birthing parent when an editor saves the cohort, and refuses a replacement', async () => {
    await payload.update({ collection: 'clutches' as never, id: ids['Secret mother']!, data: { name: 'renamed', mother: { private: true } } as never, overrideAccess: false, user: users.viewer })
    const after = await stored('clutches', ids['Secret mother']!)
    expect(after.name).toBe('renamed')
    expect(String(after.mother)).toBe(ids['Secret Dam'])
    const said = await refusal(asViewer('clutches', ids['Secret mother']!, { mother: ids['Public Dam'] }))
    expect(said).toEqual([expect.stringMatching(/^mother: This parent is private/)])
    expect(String((await stored('clutches', ids['Secret mother']!)).mother)).toBe(ids['Secret Dam'])
  })
})
