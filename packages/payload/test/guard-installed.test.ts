import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startFixture, type Ctx } from './differential.fixture'

/**
 * Checks by behavior that the guard sits on every entity that can read versions or filter, not that a hook is in a
 * list. Every probe asks about the hidden individual and a made-up one and needs the same answer over REST, Local
 * (with access control on) and GraphQL.
 */
describe('guard is installed everywhere', () => {
  let c: Ctx
  beforeAll(async () => {
    c = await startFixture('omit')
  })
  afterAll(async () => {
    await c?.stop()
  })

  const same = async (label: string, f: (v: string) => Promise<unknown>) => {
    const p = await c.pair(f)
    expect(p.equal, `${label}: ${JSON.stringify(p).slice(0, 300)}`).toBe(true)
  }

  it('config holds entities only under collections and globals', () => {
    const kinds = Object.entries(c.payload.config as unknown as Record<string, unknown>)
      .filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && 'slug' in x && 'fields' in x))
      .map(([k]) => k)
      .sort()
    expect(kinds).toEqual(['collections', 'globals'])
  })

  it('collections: a plugin-added one, an internal one and a versioned one', async () => {
    await same('notes REST', (v) => c.call(`/notes?depth=0&where[animal.dam][equals]=${v}`))
    await same('notes Local', (v) => c.lf('notes', { 'animal.dam': { equals: v } }))
    await same('notes GraphQL', (v) => c.gql(`{ Notes(where: { animal__dam: { equals: "${v}" } }) { totalDocs } }`))
    await same('locked documents', (v) => c.call(`/payload-locked-documents?depth=0&where[document.value.dam][equals]=${v}`))
    await same('versions REST', (v) => c.call(`/weighings/versions?depth=0&where[version.animal.dam][equals]=${v}`))
    await same('versions Local', (v) => c.payload.findVersions({ collection: 'weighings', where: { 'version.animal.dam': { equals: v } } as never, ...c.as() }))
    await same('countVersions Local', (v) => c.payload.countVersions({ collection: 'weighings', where: { 'version__animal__dam': { equals: v } } as never, ...c.as() }))
    await same('bulk update', (v) => c.call(`/weighings?where[lherd.en][contains][dam][equals]=${v}`, { method: 'PATCH', body: '{}' }))
  })

  it('globals: every way to read versions answers alike, and refuses a caller who cannot read every individual', async () => {
    const q = (v: string) => `where[version.herd][contains][dam][equals]=${v}`
    await same('REST list', (v) => c.call(`/globals/featured/versions?depth=0&${q(v)}`))
    await same('REST dotted', (v) => c.call(`/globals/featured/versions?depth=0&where[version.herd.dam][equals]=${v}`))
    await same('REST __', (v) => c.call(`/globals/featured/versions?depth=0&where[version__animal__dam][equals]=${v}`))
    await same('REST in', (v) => c.call(`/globals/featured/versions?depth=0&where[version.animal.dam][in]=${v}`))
    await same('Local list', (v) => c.payload.findGlobalVersions({ slug: 'featured', where: { 'version.herd': { contains: { dam: { equals: v } } } } as never, ...c.as() } as never))
    await same('Local count', (v) => c.payload.countGlobalVersions({ slug: 'featured', where: { 'version.animal.dam': { equals: v } }, ...c.as() } as never))
    await same('GraphQL', (v) => c.gql(`{ versionsFeatured(where: { version__animal__dam: { equals: "${v}" } }) { totalDocs } }`))
    const refused = await c.call('/globals/featured/versions?depth=0')
    expect(refused.status).toBe(403)
    const byId = await c.safe(() => c.payload.findGlobalVersionByID({ slug: 'featured', id: '64b0000000000000000000aa', ...c.as() } as never))
    expect(byId).toHaveProperty('error')
  })

  it('globals that reach individuals through other collections, or that a later plugin added, are refused too', async () => {
    for (const g of ['chain', 'lateGlobal']) {
      expect((await c.call(`/globals/${g}/versions?depth=0`)).status, g).toBe(403)
      expect((await c.call(`/globals/${g}/versions?depth=0`, {}, 'admin')).status, g).toBe(200)
    }
  })

  it('a caller who can read every individual gets the real answer', async () => {
    const r = await c.call('/globals/featured/versions?depth=0', {}, 'admin')
    expect(r.status).toBe(200)
    expect(r.body.totalDocs).toBeGreaterThan(0)
    const hit = await c.call(`/globals/featured/versions?depth=0&where[version.animal][equals]=${c.id.kid}`, {}, 'admin')
    expect(hit.body.totalDocs).toBeGreaterThan(0)
    const miss = await c.call(`/globals/featured/versions?depth=0&where[version.animal][equals]=${c.id.kid2}`, {}, 'admin')
    expect(miss.body.totalDocs).toBe(0)
  })

  it('a global with no reference to individuals is served as the host wrote it', async () => {
    const r = await c.call('/globals/footer/versions?depth=0')
    expect(r.status).toBe(200)
    expect(r.body.totalDocs).toBeGreaterThan(0)
    const local = await c.payload.findGlobalVersions({ slug: 'footer', ...c.as() } as never)
    expect(local.totalDocs).toBeGreaterThan(0)
  })

  it('trusted Local calls are untouched', async () => {
    const r = await c.payload.findGlobalVersions({ slug: 'featured', where: { 'version.animal.dam': { equals: c.id.H } } as never } as never)
    expect(r.totalDocs).toBeGreaterThan(0)
    const found = await c.payload.find({ collection: 'animals', where: { dam: { equals: c.id.H } }, depth: 0 })
    expect(found.docs.map((d) => d.name)).toContain('kid')
  })
})
