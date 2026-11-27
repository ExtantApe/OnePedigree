import { json, w, type Ctx } from './differential.fixture'

/**
 * The review probes of rounds 3 to 7, one row each (ids keep the probe's own names, prefixed by the round). A row runs
 * with the hidden id or the made-up id as `v`; the two answers must match. Made-up data only.
 */
export type Row = { id: string; run: (v: string) => Promise<unknown> }
/** A row whose answer is a refusal in `omit` mode and a normal answer with placeholders (the `exists` family). */
export type ExistsRow = { id: string; run: () => Promise<{ status: number }> }

const M = (n: number) => Array(n).fill('mate').join('.')

export function seedRows(c: Ctx): { pairs: Row[]; exists: ExistsRow[] } {
  const { id, gql, lf, lc, call } = c
  const get = (p: string) => call(p)
  const r = (round: string, rows: [string, (v: string) => Promise<unknown>][]): Row[] => rows.map(([k, run]) => ({ id: `${round}.${k}`, run }))
  const wc = (p: string) => (v: string) => get(p.replace('{V}', v))

  const r3 = r('r3', [
    ['X1 weighings where animal.dam', (v) => get(`/weighings?depth=0&${w('animal.dam', v)}`)],
    ['X1c weighings where animal.clutch.mother', (v) => get(`/weighings?depth=0&${w('animal.clutch.mother', v)}`)],
    ['X1g GraphQL animal__dam', (v) => gql(`{ Weighings(where: { animal__dam: { equals: "${v}" } }) { totalDocs } }`)],
    ['X2 animals where mate.dam', (v) => get(`/animals?depth=0&${w('mate.dam', v)}`)],
    ['X3 REST joins where on clutches.members', (v) => get(`/clutches?depth=1&where[name][equals]=C1&joins[members][where][dam][equals]=${v}`)],
    ['X3g GraphQL join where on clutches.members', (v) => gql(`{ Clutches(where: { name: { equals: "C1" } }) { docs { members(where: { dam: { equals: "${v}" } }) { docs { name } } } } }`)],
    ['X5 animals join kids where sire', (v) => get(`/animals?depth=1&where[name][equals]=A&joins[kids][where][sire][equals]=${v}`)],
    ['X7 uppercase AND', (v) => get(`/animals?depth=0&where[AND][0][dam][equals]=${v}`)],
    ['X8 object operand {id}', (v) => get(`/animals?depth=0&where[dam][equals][id]=${v}`)],
    ['X13 weighings count where animal.dam', (v) => get(`/weighings/count?${w('animal.dam', v)}`)],
  ])

  const r4 = r('r4', [
    ['D8 eight mate hops then dam', (v) => get(`/animals?depth=0&${w(`${M(8)}.dam`, v)}`)],
    ['D9 nine mate hops then dam', (v) => get(`/animals?depth=0&${w(`${M(9)}.dam`, v)}`)],
    ['D9c nine hops, count', (v) => get(`/animals/count?${w(`${M(9)}.dam`, v)}`)],
    ['D9j nine hops, JSON where', (v) => get(`/animals?depth=0&${json({ [`${M(9)}.dam`]: { equals: v } })}`)],
    ['D9w nine hops from weighings', (v) => get(`/weighings?depth=0&${w(`animal.${M(8)}.dam`, v)}`)],
    ['D9g nine hops, Local', (v) => lf('animals', { [`${M(9)}.dam`]: { equals: v } })],
    ['O1 in as object (qs arrayLimit)', (v) => get(`/animals?depth=0&where[dam][in][1001]=${v}`)],
    ['O1j in as object (JSON)', (v) => get(`/animals?depth=0&${json({ dam: { in: { a: v } } })}`)],
    ['O2 equals {value}', (v) => get(`/animals?depth=0&where[dam][equals][value]=${v}`)],
    ['O3 exists with not_equals', (v) => get(`/animals?depth=0&where[dam][exists]=true&where[name][not_equals]=${v}`)],
    ['L1 collection added by a later plugin', (v) => get(`/notes?depth=0&${w('animal.dam', v)}`)],
    ['L2 payload-locked-documents document.value.dam', (v) => get(`/payload-locked-documents?depth=0&${w('document.value.dam', v)}`)],
    ['L2b payload-locked-documents document.dam', (v) => get(`/payload-locked-documents?depth=0&${w('document.dam', v)}`)],
    ['G1 global versions version.animal.dam', (v) => get(`/globals/featured/versions?depth=0&${w('version.animal.dam', v)}`)],
    ['G1l global versions, Local', (v) => c.payload.findGlobalVersions({ slug: 'featured' as never, depth: 0, where: { 'version.animal.dam': { equals: v } } as never, ...c.as() })],
    ['V1 host versions version.animal.dam', (v) => get(`/weighings/versions?depth=0&${w('version.animal.dam', v)}`)],
    ['V2 draft find', (v) => get(`/weighings?depth=0&draft=true&${w('animal.dam', v)}`)],
    ...['items.animal.dam', 'layout.animal.dam', 'layout.pick.animal.dam', 'subject.value.dam', 'subject.dam', 'herd.dam', 'meta.animal.dam'].map((p): [string, (v: string) => Promise<unknown>] => [`F ${p}`, (v) => get(`/weighings?depth=0&${w(p, v)}`)]),
    ['C1 case variant Animal.dam / animal.Dam', async (v) => [await get(`/weighings?depth=0&${w('animal.Dam', v)}`), await get(`/weighings?depth=0&${w('Animal.dam', v)}`)]],
    ['J1 findByID with joins where', (v) => get(`/clutches/${id.C1}?depth=1&joins[members][where][dam][equals]=${v}`)],
    ['D1 findDistinct weighings animal.dam', (v) => (c.payload as never as { findDistinct: (o: object) => Promise<unknown> }).findDistinct({ collection: 'weighings', field: 'animal.dam', where: { name: { not_equals: v } }, ...c.as() })],
    ['B1 bulk PATCH where mate.dam', (v) => call(`/animals?depth=0&${w('mate.dam', v)}`, { method: 'PATCH', body: JSON.stringify({}) })],
    ['N1 or/and nesting', (v) => get(`/animals?depth=0&${json({ or: [{ and: [{ name: { exists: true } }, { or: [{ 'mate.dam': { equals: v } }] }] }] })}`)],
    ['N2 mixed readable and hidden in', (v) => get(`/animals?depth=0&where[clutch.mother][in]=${v},${id.A}`)],
  ])

  const r5 = r('r5', [
    ['U1 weighings animal__dam', (v) => get(`/weighings?depth=0&${w('animal__dam', v)}`)],
    ['U2 animals clutch__mother', (v) => get(`/animals?depth=0&${w('clutch__mother', v)}`)],
    ['U3 animals mate__dam', (v) => get(`/animals?depth=0&${w('mate__dam', v)}`)],
    ['U4 count mate__dam', (v) => get(`/animals/count?${w('mate__dam', v)}`)],
    ['U5 Local find mate__dam', (v) => lf('animals', { mate__dam: { equals: v } })],
    ['U6 mixed animal.clutch__mother', (v) => get(`/weighings?depth=0&${w('animal.clutch__mother', v)}`)],
    ['U7 later-plugin notes animal__dam', (v) => get(`/notes?depth=0&${w('animal__dam', v)}`)],
    ['U8 clutch versions version__mother', (v) => get(`/clutches/versions?depth=0&${w('version__mother', v)}`)],
    ['U9 weighings versions version__animal__dam', (v) => get(`/weighings/versions?depth=0&${w('version__animal__dam', v)}`)],
    ['U10 join where clutch__mother inside clutches members', (v) => get(`/clutches?depth=1&where[name][equals]=C1&joins[members][where][clutch__mother][equals]=${v}`)],
    ['U11 bulk PATCH mate__dam', (v) => call(`/animals?depth=0&${w('mate__dam', v)}`, { method: 'PATCH', body: JSON.stringify({}) })],
    ['U15 global versions version__animal__dam', (v) => get(`/globals/featured/versions?depth=0&${w('version__animal__dam', v)}`)],
    ['P1 array index items.0.animal.dam', (v) => get(`/weighings?depth=0&${w('items.0.animal.dam', v)}`)],
    ['P2 empty segment animal..dam', (v) => get(`/weighings?depth=0&${w('animal..dam', v)}`)],
    ['P3 _id spelling', async (v) => [await get(`/weighings?depth=0&${w('animal.dam._id', v)}`), await get(`/animals?depth=0&${w('dam._id', v)}`)]],
    ['P4 trailing dot', (v) => get(`/animals?depth=0&${w('mate.dam.', v)}`)],
    ['B9w weighings animal + 8 mates dam', (v) => get(`/weighings?depth=0&${w(`animal.${M(8)}.dam`, v)}`)],
    ['B9p polymorphic subject.value + 8 mates dam', (v) => get(`/weighings?depth=0&${w(`subject.value.${M(8)}.dam`, v)}`)],
    ['O5 equals true / number', async (v) => [await get(`/animals?depth=0&where[dam][equals]=true&where[name][not_equals]=${v}`), await lf('animals', { dam: { equals: 0 }, name: { not_equals: v } }).catch((e) => String(e))]],
    ['O6 placeholder object operand in a list', (v) => lf('animals', { dam: { in: [{ private: true, value: v }] } }).catch((e) => String((e as Error).message))],
    ['O6e placeholder equals', async (v) => [
      await lf('animals', { dam: { equals: { private: true, relationTo: 'animals', value: v } } }).catch((e) => String((e as Error).message)),
      await get(`/animals?depth=0&where[dam][equals][private]=true&where[dam][equals][value]=${v}`),
      await get(`/weighings?depth=0&where[animal.dam][in][0][private]=true&where[animal.dam][in][0][value]=${v}`),
    ]],
  ])

  const spell = ['__dam', 'dam__', 'mate___dam', 'mate____dam', 'mate.__dam', 'mate__.dam', 'Mate__dam', 'mate__Dam', 'mate__dam__', '__mate__dam', 'mate_._dam', 'mate__dam.id', 'mate__dam__id', 'version__dam', 'mate__mate__mate__dam']
  const r6 = r('r6', [
    ['N1 weighings herd contains {dam}', (v) => get(`/weighings?depth=0&where[herd][contains][dam][equals]=${v}`)],
    ['N2 count weighings herd contains {dam}', (v) => get(`/weighings/count?where[herd][contains][dam][equals]=${v}`)],
    ['N3 clutches members(join) contains {dam}', (v) => get(`/clutches?depth=0&where[members][contains][dam][equals]=${v}`)],
    ['N4 Local weighings herd contains {dam}', (v) => lf('weighings', { herd: { contains: { dam: { equals: v } } } })],
    ['N5 Local clutches members contains {clutch__mother}', (v) => lf('clutches', { members: { contains: { clutch__mother: { equals: v } } } })],
    ['N7 bulk PATCH weighings herd contains {dam}', (v) => call(`/weighings?depth=0&where[herd][contains][dam][equals]=${v}`, { method: 'PATCH', body: JSON.stringify({}) })],
    ['N8 weighings versions version.herd contains {dam}', (v) => get(`/weighings/versions?depth=0&where[version.herd][contains][dam][equals]=${v}`)],
    ['N9 animals kids(join) contains {mate__dam}', (v) => get(`/animals?depth=0&where[kids][contains][mate__dam][equals]=${v}`)],
    ['N10 GraphQL weighings herd contains nested', (v) => gql(`{ Weighings(where: { herd: { contains: { dam: { equals: "${v}" } } } }) { totalDocs } }`)],
    ['N11 herd contains {not_equals dam}', (v) => get(`/weighings/count?where[herd][contains][dam][not_equals]=${v}`)],
    ...spell.map((p, i): [string, (v: string) => Promise<unknown>] => [`X${i}:${p}`, (v) => get(`/animals/count?${w(p, v)}`)]),
    ...spell.map((p, i): [string, (v: string) => Promise<unknown>] => [`XL${i}:${p}`, (v) => lf('animals', { [p]: { equals: v } })]),
    ['A1 and/or nesting with __', (v) => lf('animals', { or: [{ and: [{ name: { exists: true } }, { or: [{ mate__dam: { in: [v] } }] }] }] })],
    ['A2 REST and/or nesting with __', (v) => get(`/animals/count?where[or][0][and][0][or][0][mate__dam][equals]=${v}`)],
    ['A3 nested object path where[mate][dam]', (v) => get(`/animals/count?where[mate][dam][equals]=${v}`)],
    ['A4 nested object path weighings where[animal][dam]', (v) => get(`/weighings/count?where[animal][dam][equals]=${v}`)],
    ['A5 GraphQL OR with __', (v) => gql(`{ Weighings(where: { OR: [{ animal__dam: { equals: "${v}" } }] }) { totalDocs } }`)],
    ['A6 GraphQL AND/OR', (v) => gql(`{ Weighings(where: { AND: [{ OR: [{ meta__animal__dam: { equals: "${v}" } }] }] }) { totalDocs } }`)],
    ['J2 join where with __', (v) => get(`/clutches?depth=1&joins[members][where][or][0][mate__dam][equals]=${v}`)],
    ['J3 Local join where mate__clutch__mother', (v) => lf('clutches', {}, { joins: { members: { where: { mate__clutch__mother: { equals: v } } } } })],
  ])

  const r7 = r('r7', [
    ['L1 count lherd.en contains {dam}', wc('/weighings/count?where[lherd.en][contains][dam][equals]={V}')],
    ['L2 count lherd__en contains {dam}', wc('/weighings/count?where[lherd__en][contains][dam][equals]={V}')],
    ['L3 count lherd contains {dam}', wc('/weighings/count?where[lherd][contains][dam][equals]={V}')],
    ['L4 Local find lherd.en contains {dam}', (v) => lf('weighings', { 'lherd.en': { contains: { dam: { equals: v } } } })],
    ['L5 versions version.lherd.en contains {dam}', wc('/weighings/versions?depth=0&where[version.lherd.en][contains][dam][equals]={V}')],
    ['L6 bulk PATCH lherd.en contains {dam}', (v) => call(`/weighings?depth=0&where[lherd.en][contains][dam][equals]=${v}`, { method: 'PATCH', body: '{}' })],
    ['L7 lgrp.en.herd contains {dam}', wc('/weighings/count?where[lgrp.en.herd][contains][dam][equals]={V}')],
    ['L8 lgrp.herd contains {dam}', wc('/weighings/count?where[lgrp.herd][contains][dam][equals]={V}')],
    ['L10 Local count lherd.fr contains {dam}', (v) => lc('weighings', { 'lherd.fr': { contains: { dam: { equals: v } } } })],
    ['G1 global versions version.herd contains {dam}', wc('/globals/featured/versions?depth=0&where[version.herd][contains][dam][equals]={V}')],
    ['G2 global versions version.animal.dam', wc('/globals/featured/versions?depth=0&where[version.animal.dam][equals]={V}')],
    ['G3 Local findGlobalVersions version.herd contains {dam}', (v) => c.payload.findGlobalVersions({ slug: 'featured' as never, where: { 'version.herd': { contains: { dam: { equals: v } } } } as never, depth: 0, ...c.as() })],
    ['G4 global versions version.herd.dam / version__animal__dam / in', async (v) =>
      Promise.all([`where[version.herd.dam][equals]=${v}`, `where[version__animal__dam][equals]=${v}`, `where[version.herd][contains][dam][in]=${v}`].map((q) => get(`/globals/featured/versions?depth=0&${q}`)))],
    ['U1 upload pics contains {subject.dam}', wc('/weighings/count?where[pics][contains][subject.dam][equals]={V}')],
    ['U2 upload pics contains {subject__dam}', wc('/weighings/count?where[pics][contains][subject__dam][equals]={V}')],
    ['P1 poly contains {dam}', wc('/weighings/count?where[poly][contains][dam][equals]={V}')],
    ['P2 poly contains {relationTo,value:{dam}}', (v) => lc('weighings', { poly: { contains: { relationTo: 'animals', value: { dam: { equals: v } } } } })],
    ['P3 poly.value contains {dam}', wc('/weighings/count?where[poly.value][contains][dam][equals]={V}')],
    ['A1 items.herd contains {dam}', wc('/weighings/count?where[items.herd][contains][dam][equals]={V}')],
    ['A2 layout.herd contains {dam}', wc('/weighings/count?where[layout.herd][contains][dam][equals]={V}')],
    ['A3 layout.pick.herd contains {dam}', wc('/weighings/count?where[layout.pick.herd][contains][dam][equals]={V}')],
    ['M1 pens weighing.herd contains {dam}', wc('/pens/count?where[weighing.herd][contains][dam][equals]={V}')],
    ['M2 herd contains {friends contains {dam}}', wc('/weighings/count?where[herd][contains][friends][contains][dam][equals]={V}')],
    ['M3 herd contains {mate, friends contains {dam}}', (v) => lc('weighings', { herd: { contains: { mate: { equals: id.kid }, friends: { contains: { dam: { equals: v } } } } } })],
    ['M4 herd contains {OR:[{dam}]}', (v) => lc('weighings', { herd: { contains: { OR: [{ dam: { equals: v } }] } } })],
    ['M5 top-level Or', (v) => lc('animals', { Or: [{ dam: { equals: v } }] })],
    ['M6 herd contains [{dam}] array operand', (v) => lc('weighings', { herd: { contains: [{ dam: { equals: v } }] } })],
    ['M7 herd in/all/equals/not_in/not_equals object operands', (v) => Promise.all(['in', 'all', 'equals', 'not_in', 'not_equals'].map((op) => c.safe(() => lc('weighings', { herd: { [op]: { dam: { equals: v } } } }))))],
    ['M8 herd exists plus contains {dam}', (v) => lc('weighings', { herd: { exists: true, contains: { dam: { equals: v } } } })],
    ['M9 herd contains {id equals}', wc('/weighings/count?where[herd][contains][id][equals]={V}')],
    ['M10 herd contains {kids contains, dam}', wc('/weighings/count?where[herd][contains][kids][contains][name][equals]=kid&where[herd][contains][dam][equals]={V}')],
    ['J1 animals kids contains {clutch.mother}', wc('/animals/count?where[kids][contains][clutch.mother][equals]={V}')],
    ['J2 animals my__kids join where {dam}', wc('/animals?depth=1&where[name][equals]=H&joins[my__kids][where][mate][equals]=x&joins[my__kids][where][dam][equals]={V}')],
    ['J3 animals my__kids join where {clutch.mother}', wc('/animals?depth=1&limit=50&joins[my__kids][where][clutch.mother][equals]={V}')],
    ['J5 Local my__kids join where', (v) => lf('animals', {}, { depth: 1, limit: 50, joins: { my__kids: { where: { clutch__mother: { equals: v } } } } })],
    ['J6 grp.sibs join where clutch.mother', wc('/animals?depth=1&limit=50&joins[grp.sibs][where][clutch.mother][equals]={V}')],
    ['J7 my__kids contains {clutch.mother} in where', wc('/animals/count?where[my__kids][contains][clutch.mother][equals]={V}')],
    ['J8 GraphQL my__kids join where', (v) => gql(`{ Animals(limit: 50) { docs { name my__kids(where: { clutch__mother: { equals: "${v}" } }) { docs { name } } } } }`)],
    ['J9 my__mates join where clutch.mother', wc('/animals?depth=0&limit=50&joins[my__mates][where][clutch.mother][equals]={V}')],
    ['J11 Local my__mates join where clutch.mother', (v) => lf('animals', { name: { equals: 'kid' } }, { joins: { my__mates: { where: { 'clutch.mother': { equals: v } } } } })],
    ['K1 lherd.en.dam equals', wc('/weighings/count?where[lherd.en.dam][equals]={V}')],
    ['K2 lherd__en__dam equals', wc('/weighings/count?where[lherd__en__dam][equals]={V}')],
    ['K3 lgrp.en.herd.dam equals', wc('/weighings/count?where[lgrp.en.herd.dam][equals]={V}')],
    ['K4 animals lmate.en.dam equals', wc('/animals/count?where[lmate.en.dam][equals]={V}')],
    ['K5 Local lherd.en.dam in', (v) => lc('weighings', { 'lherd.en.dam': { in: [v] } })],
    ['K6 versions version.lherd.en.dam', wc('/weighings/versions?depth=0&where[version.lherd.en.dam][equals]={V}')],
    ['K7 GraphQL lherd__en__dam', (v) => gql(`{ Weighings(where: { lherd__en__dam: { equals: "${v}" } }) { totalDocs } }`)],
    // Global versions, every operation that reads them.
    ['G5 Local countGlobalVersions version.animal.dam', (v) => c.payload.countGlobalVersions({ slug: 'featured', where: { 'version.animal.dam': { equals: v } }, ...c.as() } as never)],
    ['G6 REST global versions lherd.en.dam', wc('/globals/featured/versions?depth=0&where[version.lherd.en.dam][equals]={V}')],
    ['G7 GraphQL global versions', (v) => gql(`{ versionsFeatured(where: { version__animal__dam: { equals: "${v}" } }) { totalDocs } }`)],
    ['G8 GraphQL global versions herd contains', (v) => gql(`{ versionsFeatured(where: { version__herd: { contains: { dam: { equals: "${v}" } } } }) { totalDocs } }`)],
    ['G9 Local findGlobalVersions sort and where', (v) => c.payload.findGlobalVersions({ slug: 'featured' as never, where: { 'version.animal.dam': { in: [v] } } as never, sort: '-createdAt', depth: 0, ...c.as() })],
  ])

  // A filter on the hidden parent's own fields (its name, visibility): the value is the hidden record's real name for H.
  const nm = (v: string) => (v === id.H ? 'H' : 'Nobody')
  const below = r('below', [
    ['B1 weighings animal.dam.name', (v) => get(`/weighings?depth=0&${w('animal.dam.name', nm(v))}`)],
    ['B2 animals dam.name', (v) => get(`/animals?depth=0&${w('dam.name', nm(v))}`)],
    ['B3 animals dam__visibility', (v) => get(`/animals?depth=0&${w('dam__visibility', v === id.H ? 'private' : 'nothing')}`)],
    ['B4 count dam.name exists-free like', (v) => get(`/animals/count?${w('dam.name', nm(v), 'like')}`)],
    ['B5 Local clutch.mother.name', (v) => lf('animals', { 'clutch.mother.name': { equals: nm(v) } })],
    ['B6 nested contains {dam.name}', (v) => get(`/weighings/count?where[herd][contains][dam.name][equals]=${nm(v)}`)],
    ['B7 version.animal.dam.name', (v) => get(`/weighings/versions?depth=0&${w('version.animal.dam.name', nm(v))}`)],
    ['B8 dam.id', (v) => get(`/animals?depth=0&${w('dam.id', v)}`)],
  ])

  const exists: ExistsRow[] = [
    ['r6.N6 herd contains {dam exists}', '/weighings/count?where[herd][contains][dam][exists]=true'],
    ['r5.U12 exists mate__dam', '/animals/count?where[mate__dam][exists]=true'],
    ['r7.L9 exists under lherd.en contains', '/weighings/count?where[lherd.en][contains][dam][exists]=true'],
    ['r7.K8b exists on lgrp.en.herd.dam', '/weighings/count?where[lgrp.en.herd.dam][exists]=true'],
  ].map(([k, p]) => ({ id: k!, run: () => call(p!) }))

  return { pairs: [...r3, ...r4, ...r5, ...r6, ...r7, ...below], exists }
}
