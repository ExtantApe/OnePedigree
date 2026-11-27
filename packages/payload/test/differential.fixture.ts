import { configToSchema } from '@payloadcms/graphql'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createLocalReq, handleEndpoints, type Access, type CollectionConfig, type Config, type GlobalConfig, type Payload, type TypedUser, type Where } from 'payload'

import { onePedigree } from '../src'
import { startPayload, usersCollection } from './helpers'

/**
 * One fixture for the differential tests: a hidden individual `H` and a made-up id answer alike for a caller who can't
 * read `H`. Collections, globals and localization cover every spelling the review rounds found. Made-up data only.
 */
// The same CommonJS copy of graphql that Payload's schema builder loads; a second copy refuses its schema.
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')
export const NOBODY = '64b0000000000000000000aa'
const role = (u: unknown) => (u as { role?: string } | null)?.role
const read: Access = ({ req }) => (role(req.user) === 'admin' ? true : ({ visibility: { equals: 'public' } } as Where))
const write: Access = ({ req }) => Boolean(req.user)
const base = [
  { name: 'name', type: 'text' },
  { name: 'visibility', type: 'select', options: ['public', 'private'], defaultValue: 'public' },
] as CollectionConfig['fields']
const rel = (name: string, relationTo: string | string[], extra: object = {}) => ({ name, type: 'relationship', relationTo, ...extra })

const animals: CollectionConfig = {
  slug: 'animals',
  access: { read, create: write, update: write, delete: write },
  fields: [
    ...base,
    rel('dam', 'animals'),
    rel('sire', 'animals'),
    rel('clutch', 'clutches'),
    rel('mate', 'animals'),
    rel('friends', 'animals', { hasMany: true }),
    { name: 'kids', type: 'join', collection: 'animals', on: 'dam' },
    { name: 'my__kids', type: 'join', collection: 'animals', on: 'dam' },
    { name: 'my__mates', type: 'join', collection: 'animals', on: 'mate' },
    rel('lmate', 'animals', { localized: true }),
    { name: 'internalNote', type: 'text', hidden: true },
    { name: 'grp', type: 'group', fields: [{ name: 'sibs', type: 'join', collection: 'animals', on: 'dam' }] },
  ] as never,
}
const clutches: CollectionConfig = {
  slug: 'clutches',
  access: { read, create: write, update: write, readVersions: write },
  versions: { maxPerDoc: 5 },
  fields: [...base, rel('mother', 'animals'), { name: 'members', type: 'join', collection: 'animals', on: 'clutch' }] as never,
}
const photos: CollectionConfig = {
  slug: 'photos',
  access: { read: () => true, create: write },
  upload: { staticDir: '' },
  fields: [rel('subject', 'animals')] as never,
}
const weighings: CollectionConfig = {
  slug: 'weighings',
  access: { read: () => true, readVersions: () => true, create: write, update: write },
  versions: { drafts: true },
  fields: [
    { name: 'name', type: 'text' },
    rel('animal', 'animals'),
    rel('herd', 'animals', { hasMany: true }),
    rel('lherd', 'animals', { hasMany: true, localized: true }),
    { name: 'lgrp', type: 'group', localized: true, fields: [rel('herd', 'animals', { hasMany: true })] },
    { name: 'pics', type: 'upload', relationTo: 'photos', hasMany: true },
    rel('poly', ['animals', 'clutches'], { hasMany: true }),
    rel('subject', ['animals', 'clutches']),
    { name: 'items', type: 'array', fields: [rel('animal', 'animals'), rel('herd', 'animals', { hasMany: true })] },
    { name: 'layout', type: 'blocks', blocks: [{ slug: 'pick', fields: [rel('animal', 'animals'), rel('herd', 'animals', { hasMany: true })] }] },
    { type: 'tabs', tabs: [{ name: 'meta', fields: [rel('animal', 'animals')] }] },
  ] as never,
}
const pens: CollectionConfig = { slug: 'pens', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, rel('weighing', 'weighings')] as never }
const notes: CollectionConfig = { slug: 'notes', access: { read: () => true, create: write }, fields: [{ name: 'name', type: 'text' }, rel('animal', 'animals')] as never }
/** Unrelated to individuals: its versions and its fields must be served as the host wrote them. */
const footer: GlobalConfig = { slug: 'footer', access: { read: () => true, readVersions: () => true, update: write }, versions: { max: 5 }, fields: [{ name: 'text', type: 'text' }, rel('owner', 'users')] as never }
const featured: GlobalConfig = {
  slug: 'featured',
  access: { read: () => true, readVersions: () => true, update: write },
  versions: { max: 5 },
  fields: [rel('animal', 'animals'), rel('herd', 'animals', { hasMany: true }), rel('lherd', 'animals', { hasMany: true, localized: true })] as never,
}
/** Reaches individuals only through another collection (pens, then weighings, then animals). */
const chain: GlobalConfig = { slug: 'chain', access: { read: () => true, readVersions: () => true, update: write }, versions: { max: 5 }, fields: [rel('pen', 'pens')] as never }
/** A global added by a plugin that runs after OnePedigree. */
const lateGlobal: GlobalConfig = { slug: 'lateGlobal', access: { read: () => true, readVersions: () => true, update: write }, versions: { max: 5 }, fields: [rel('animal', 'animals')] as never }
/** A collection added by a plugin that runs after OnePedigree, so OnePedigree's config pass never sees it. */
const laterPlugin = (config: Config): Config => ({ ...config, collections: [...(config.collections ?? []), notes], globals: [...(config.globals ?? []), lateGlobal] })
/** A later plugin that sets its own onInit without calling the one before it. */
const unchainedInit = (config: Config): Config => ({ ...config, onInit: async () => {} })
/** A late collection whose hook list can't be changed, so the guard can't be put on it. */
const lockedLate = (config: Config): Config => ({ ...config, collections: [...(config.collections ?? []), { slug: 'locked', access: { read: () => true }, hooks: { beforeOperation: Object.freeze([]) as never }, fields: [{ name: 'name', type: 'text' }] }] })

export type Mode = 'omit' | 'placeholder'
export type Body = Record<string, unknown> & { docs?: { name: string }[]; totalDocs?: number; errors?: unknown[]; token?: string }

export type Ctx = Awaited<ReturnType<typeof startFixture>>

export async function startFixture(hiddenRecords: Mode, options: { disableOnInit?: boolean; replaceDb?: boolean; unchainedInit?: boolean; lockedLate?: boolean } = {}) {
  const uploads = mkdtempSync(join(tmpdir(), 'onepedigree-uploads-'))
  const photosWithDir = { ...photos, upload: { staticDir: uploads } } as CollectionConfig
  const { payload, stop: stopPayload } = await startPayload({
    localization: { locales: ['en', 'fr'], defaultLocale: 'en' },
    collections: [usersCollection, animals, clutches, photosWithDir, weighings, pens],
    globals: [featured, footer, chain],
    plugins: [
      onePedigree({ collection: 'animals', mode: 'mapped', fields: { label: 'name', parentage: { kind: 'role-fields', roles: { mother: 'dam', father: 'sire' }, cohort: 'clutch' } }, cohorts: { collection: 'clutches', birthParentField: 'mother' }, hiddenRecords }),
      laterPlugin,
      ...(options.unchainedInit ? [unchainedInit] : []),
      ...(options.lockedLate ? [lockedLate] : []),
    ],
  }, options)
  const id: Record<string, string> = {}
  const mk = async (c: string, k: string, d: object = {}) => {
    id[k] = String((await payload.create({ collection: c as never, data: { name: k, ...d } as never })).id)
  }
  const users: Record<string, TypedUser> = {}
  const jwts: Record<string, string> = {}
  for (const r of ['viewer', 'admin']) {
    users[r] = (await payload.create({ collection: 'users', data: { email: `${r}@example.com`, password: 'a-long-test-password', role: r } as never })) as TypedUser
    const res = await handleEndpoints({ config: payload.config, request: new Request('http://localhost/api/users/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${r}@example.com`, password: 'a-long-test-password' }) }) })
    jwts[r] = ((await res.json()) as { token: string }).token
  }
  const viewer = users.viewer!
  await mk('animals', 'H', { visibility: 'private' })
  await mk('animals', 'A')
  await mk('clutches', 'C1', { mother: id.H })
  await mk('clutches', 'C2', { mother: id.A })
  await mk('animals', 'kid', { dam: id.H, clutch: id.C1 })
  await mk('animals', 'kid2', { dam: id.A, clutch: id.C2 })
  await mk('animals', 'pal', { friends: [id.kid], mate: id.kid, clutch: id.C1, lmate: id.kid })
  await mk('animals', 'pal2', { friends: [id.kid2], mate: id.kid2, clutch: id.C2, lmate: id.kid2 })
  let prev = id.kid!
  for (let i = 1; i <= 9; i++) {
    await mk('animals', `m${i}`, { mate: prev })
    prev = id[`m${i}`]!
  }
  for (const k of ['kid', 'kid2'] as const) {
    const ph = await payload.db.create({ collection: 'photos', data: { filename: `${k}.png`, mimeType: 'image/png', subject: id[k] } as never })
    id[`ph_${k}`] = String((ph as { id: string }).id)
  }
  const wData = (k: 'kid' | 'kid2') => ({
    animal: id[k], herd: [id[k]], lherd: [id[k]], lgrp: { herd: [id[k]] }, pics: [id[`ph_${k}`]],
    poly: [{ relationTo: 'animals', value: id[k] }], subject: { relationTo: 'animals', value: id[k] },
    items: [{ animal: id[k], herd: [id[k]] }], layout: [{ blockType: 'pick', animal: id[k], herd: [id[k]] }], meta: { animal: id[k] },
    _status: 'published',
  })
  await mk('weighings', 'w1', wData('kid'))
  await mk('weighings', 'w4', wData('kid2'))
  await mk('pens', 'p1', { weighing: id.w1 })
  await mk('pens', 'p2', { weighing: id.w4 })
  await mk('notes', 'n1', { animal: id.kid })
  await mk('notes', 'n2', { animal: id.kid2 })
  for (let i = 0; i < 2; i++) await payload.updateGlobal({ slug: 'featured' as never, data: { animal: id.kid, herd: [id.kid], lherd: [id.kid] } as never })
  for (let i = 0; i < 2; i++) await payload.updateGlobal({ slug: 'footer' as never, data: { text: `t${i}` } as never })
  for (const g of ['chain', 'lateGlobal'])
    for (let i = 0; i < 2; i++) await payload.updateGlobal({ slug: g as never, data: (g === 'chain' ? { pen: id.p1 } : { animal: id.kid }) as never })
  await payload.create({ collection: 'payload-locked-documents' as never, data: { document: { relationTo: 'animals', value: id.kid }, user: { relationTo: 'users', value: viewer.id } } as never })

  const call = async (path: string, init: RequestInit = {}, as: 'viewer' | 'admin' | null = 'viewer') => {
    const r = await handleEndpoints({
      config: payload.config,
      request: new Request(`http://localhost/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `JWT ${jwts[as]}` } : {}) } }),
    })
    return { status: r.status, body: (await r.json()) as Body }
  }
  const gql = async (q: string, as: 'viewer' | 'admin' = 'viewer') => {
    const req = await createLocalReq({ user: users[as] as never }, payload)
    ;(req as { payloadAPI: string }).payloadAPI = 'GraphQL'
    const { schema } = configToSchema(payload.config)
    return JSON.parse(JSON.stringify(await graphql({ schema, source: q, contextValue: { req, headers: new Headers() } }))) as Body
  }
  /** Replaces ids with their keys, timestamps and unknown ids with fixed tokens, so two runs compare by shape. */
  const norm = (x: unknown) => {
    let s = JSON.stringify(x) ?? 'undefined'
    for (const [k, v] of Object.entries(id)) s = s.split(v).join(`<${k}>`)
    s = s.split(NOBODY).join('<V>').replace(/"\d{4}-\d\d-\d\dT[^"]+"/g, '"<ts>"').replace(/"[0-9a-f]{24}"/g, '"<oid>"')
    return JSON.parse(s) as unknown
  }
  const safe = async (f: () => Promise<unknown>) => {
    try {
      return { ok: await f() }
    } catch (e) {
      return { error: (e as Error).message, status: (e as { status?: number }).status }
    }
  }
  const as = (who: 'viewer' | 'admin' = 'viewer') => ({ overrideAccess: false, user: users[who] })
  const lf = (c: string, where: object, extra: object = {}) => payload.find({ collection: c as never, where: where as never, depth: 0, ...as(), ...extra } as never)
  const lc = (c: string, where: object, extra: object = {}) => payload.count({ collection: c as never, where: where as never, ...as(), ...extra } as never)
  /** The answer for the hidden id and for a made-up one, as shapes, and whether they match. */
  const pair = async (f: (v: string) => Promise<unknown>) => {
    const h = norm(await safe(() => f(id.H!)))
    const n = norm(await safe(() => f(NOBODY)))
    return { equal: JSON.stringify(h) === JSON.stringify(n), h, n }
  }
  const stop = async () => {
    await stopPayload()
    rmSync(uploads, { recursive: true, force: true })
  }
  return { payload: payload as Payload, stop, id, users, call, gql, norm, safe, as, lf, lc, pair, hiddenRecords }
}

export const w = (p: string, v: string, op = 'equals') => `where[${p}][${op}]=${v}`
export const json = (where: object) => `where=${encodeURIComponent(JSON.stringify(where))}`
