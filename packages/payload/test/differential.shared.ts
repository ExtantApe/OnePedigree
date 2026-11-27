import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { seedRows } from './differential.rows'
import { startFixture, w, type Ctx, type Mode } from './differential.fixture'

/**
 * Differential corpus: for a caller who can't read the hidden individual, asking about it must answer exactly what
 * asking about a made-up id answers (H equals N), over REST, Local and GraphQL.
 */
export function differentialTests(mode: Mode) {
  describe(`differential corpus (${mode})`, () => {
    let c: Ctx
    let rows: ReturnType<typeof seedRows>
    beforeAll(async () => {
      c = await startFixture(mode)
      rows = seedRows(c)
    })
    afterAll(async () => {
      await c?.stop()
    })

    it('has the whole corpus', () => {
      expect(rows.pairs.length).toBeGreaterThan(150)
    })

    it('answers the hidden id exactly like a made-up id, for every row', async () => {
      const bad: string[] = []
      for (const row of rows.pairs) {
        const p = await c.pair(row.run)
        if (!p.equal) bad.push(`${row.id}\n  H=${JSON.stringify(p.h).slice(0, 160)}\n  N=${JSON.stringify(p.n).slice(0, 160)}`)
      }
      expect(bad).toEqual([])
    })

    it('exists on a parent: refused without placeholders, allowed with them', async () => {
      const bad: string[] = []
      for (const row of rows.exists) {
        const { status } = await row.run()
        const refused = status === 400
        if (mode === 'omit' ? !refused : status !== 200) bad.push(`${row.id}: ${status}`)
      }
      expect(bad).toEqual([])
    })

    it('K8: exists on lherd.en.dam is a filter on lherd itself, because Payload drops the segment after a locale', async () => {
      // getLocalizedPaths skips one segment too many after a locale code, so the key resolves to the (non-parent) herd
      // field. It names no parent, so both modes answer it, and it answers exactly like where[lherd.en][exists].
      const a = await c.call('/weighings/count?where[lherd.en.dam][exists]=true')
      const b = await c.call('/weighings/count?where[lherd.en][exists]=true')
      expect(a.status).toBe(200)
      expect(a.body).toEqual(b.body)
    })

    it('refuses to sort or take distinct values by a parent field, on every transport', async () => {
      const keys = ['dam', '-dam', '+dam', 'name,dam', 'clutch.mother', 'clutch__mother', '-animal.dam', 'animal__dam', 'version.animal.dam', 'lherd.en.dam']
      const bad: string[] = []
      for (const k of keys) {
        const slug = k.includes('animal') || k.startsWith('lherd') ? 'weighings' : 'animals'
        const rest = await c.call(`/${slug}?depth=0&sort=${encodeURIComponent(k)}`)
        const vers = await c.call(`/${slug}/versions?depth=0&sort=${encodeURIComponent(k)}`)
        const local = await c.safe(() => c.lf(slug, {}, { sort: k }))
        // lherd.en.dam is the locale-dropped key: it resolves to the herd field, which names no parent.
        const expectRefused = k !== 'lherd.en.dam'
        if (expectRefused && rest.status !== 400) bad.push(`REST ${k}: ${rest.status}`)
        if (expectRefused && 'ok' in local) bad.push(`Local ${k}`)
        if (expectRefused && slug === 'weighings' && vers.status !== 400) bad.push(`versions ${k}: ${vers.status}`)
      }
      const arr = await c.safe(() => c.lf('animals', {}, { sort: ['name', '-dam'] }))
      if ('ok' in arr) bad.push('Local array sort')
      const gq = await c.gql('{ Animals(sort: "dam") { totalDocs } }')
      if (!gq.errors) bad.push('GraphQL sort')
      for (const f of ['dam', 'clutch.mother', 'sire']) {
        const d = await c.safe(() => (c.payload as never as { findDistinct: (o: object) => Promise<unknown> }).findDistinct({ collection: 'animals', field: f, ...c.as() }))
        if ('ok' in d) bad.push(`distinct ${f}`)
      }
      expect(bad).toEqual([])
    })

    it('refuses a filter below a parent field, whatever the value or operator', async () => {
      const bad: string[] = []
      for (const k of ['dam.name', 'dam__visibility', 'dam.id', 'clutch.mother.name']) {
        for (const q of [w(k, c.id.A!), w(k, 'true', 'exists'), w(k, 'x', 'like')]) {
          const r = await c.call(`/animals/count?${q}`)
          if (r.status !== 400) bad.push(`${q}: ${r.status}`)
        }
      }
      const r2 = await c.call(`/weighings/count?${w('animal.dam.name', 'true', 'exists')}`)
      if (r2.status !== 400) bad.push(`weighings: ${r2.status}`)
      expect(bad).toEqual([])
    })

    it('sorts by ordinary fields, including a reversed one', async () => {
      for (const k of ['name', '-name', '+name', '-createdAt', 'name,-id']) {
        const r = await c.call(`/animals?depth=0&sort=${encodeURIComponent(k)}`)
        expect(r.status, k).toBe(200)
      }
      expect((await c.lf('animals', {}, { sort: ['-name', 'createdAt'] })).totalDocs).toBeGreaterThan(0)
    })

    it('refuses a join name the collection does not have', async () => {
      const r = await c.call(`/animals?depth=1&joins[nope][where][name][equals]=x`)
      expect(r.status).toBe(400)
    })

    it('still answers a caller who can read the parent from the real data', async () => {
      const nested = await c.call(`/weighings/count?where[herd][contains][dam][equals]=${c.id.A}`)
      expect(nested.body.totalDocs).toBe(1)
      const up = await c.call(`/animals?depth=0&where[AND][0][dam][equals]=${c.id.A}`)
      expect(up.status).toBe(200)
      expect(up.body.docs?.map((d) => d.name)).toEqual(['kid2'])
      for (const j of [`joins[my__kids][where][name][equals]=kid2`, `joins[my__mates][where][clutch.mother][equals]=${c.id.A}`, `joins[grp.sibs][where][dam][equals]=${c.id.A}`, `joins[kids][where][dam][equals]=${c.id.A}`]) {
        const r = await c.call(`/animals?depth=1&limit=50&${j}`)
        expect(r.status, j).toBe(200)
      }
      const clutchJoin = await c.call(`/clutches/${c.id.C2}?depth=1&joins[members][where][dam][equals]=${c.id.A}`)
      expect(clutchJoin.status).toBe(200)
      const own = await c.call(`/animals/count?where[clutch.mother][equals]=${c.id.A}`)
      expect(own.body.totalDocs).toBe(2)
      const lh = await c.call(`/weighings/count?where[lgrp.en.herd.dam][equals]=${c.id.A}`)
      expect(lh.status).toBe(200)
      const vs = await c.call(`/weighings/versions?depth=0&where[version.animal.dam][equals]=${c.id.A}`)
      expect(vs.status).toBe(200)
      expect(vs.body.totalDocs).toBeGreaterThan(0)
      const cv = await c.safe(() => c.payload.countVersions({ collection: 'weighings', where: { 'version.animal.dam': { equals: c.id.A } } as never, ...c.as() }))
      expect(cv).toHaveProperty('ok')
      const a = await c.call(`/animals?depth=0&where[dam][equals]=${c.id.A}`)
      expect(a.status).toBe(200)
      expect(a.body.docs?.map((d) => d.name)).toContain('kid2')
      const w2 = await c.call(`/weighings/count?where[animal.dam][equals]=${c.id.A}`)
      expect(w2.status).toBe(200)
      expect(w2.body.totalDocs).toBe(1)
      const g = await c.call(`/globals/featured/versions?depth=0&where[version.animal][equals]=${c.id.kid}`, {}, 'admin')
      expect(g.status).toBe(200)
    })
  })
}
