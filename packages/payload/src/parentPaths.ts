import { buildVersionCollectionFields, getLocalizedPaths, type FlattenedField, type Payload } from 'payload'

import type { ResolvedOptions } from './types.js'

/**
 * Which field a query key lands on, asked of Payload's own resolver (`getLocalizedPaths`, the function the query
 * validation and the database adapter use) instead of parsed from the key text. Locale codes, `__`, groups, tabs,
 * arrays and blocks are consumed by the resolver, so the answer is the field object itself, and a parent field is
 * recognised by identity.
 */

/** A key Payload can't resolve, or one too long or too deep to resolve safely. Callers refuse it. */
export class Unresolved extends Error {}

export const MAX_SEGMENTS = 100
/** One entry per collection a key passes through: the host, then one per relationship hop. */
export const MAX_ENTRIES = 9

type Entry = { collectionSlug?: string; complete: boolean; field?: FlattenedField; fields?: FlattenedField[]; invalid?: boolean }
export type Hit = 'exact' | 'below' | null

const child = (f: FlattenedField): FlattenedField[] =>
  ((f as { flattenedFields?: FlattenedField[] }).flattenedFields as FlattenedField[] | undefined) ?? []
const blockFields = (f: FlattenedField, payload: Payload): FlattenedField[][] => {
  const b = f as { type: string; blocks?: unknown[]; blockReferences?: unknown[] }
  if (b.type !== 'blocks') return []
  return (b.blockReferences ?? b.blocks ?? []).map((x) => ((typeof x === 'string' ? (payload.blocks as Record<string, { flattenedFields: FlattenedField[] }>)[x] : (x as { flattenedFields: FlattenedField[] }))?.flattenedFields ?? []))
}

/** Every field object reached by `path` (dot separated field names) through `fields`. Blocks can yield several. */
export function fieldsAt(payload: Payload, fields: FlattenedField[], path: string[]): FlattenedField[] {
  if (!path.length) return []
  const [head, ...rest] = path
  const out: FlattenedField[] = []
  for (const f of fields) {
    if ((f as { name?: string }).name !== head) continue
    if (!rest.length) out.push(f)
    else {
      out.push(...fieldsAt(payload, child(f), rest))
      for (const set of blockFields(f, payload)) out.push(...fieldsAt(payload, set, rest))
    }
  }
  return out
}

/** The parent paths on a collection: the individuals' parent fields, or the cohorts' birthing parent. Empty elsewhere. */
export const guardedPaths = (opts: ResolvedOptions, slug: string): string[] => {
  const m = opts.fields.parentage
  const birth = opts.cohorts?.birthParentField
  if (opts.cohorts && slug === opts.cohorts.collection) return birth ? [birth] : []
  if (slug !== opts.collection) return []
  return m.kind === 'role-fields' ? Object.values(m.roles) : [`${m.path}.parents.${m.individualField}`, `${m.path}.mother`, `${m.path}.father`]
}

/** In a standard-fields install the parents are array rows. Everything in a row that can hold a hidden parent says that it exists. */
export const guardedRowRoots = (opts: ResolvedOptions, slug: string): string[] => {
  const m = opts.fields.parentage
  return slug === opts.collection && m.kind !== 'role-fields' ? [`${m.path}.parents`] : []
}

/** The field itself and every field inside it, blocks included. */
function withinField(payload: Payload, f: FlattenedField, out: Set<FlattenedField>): void {
  if (out.has(f)) return
  out.add(f)
  for (const c of child(f)) withinField(payload, c, out)
  for (const set of blockFields(f, payload)) for (const c of set) withinField(payload, c, out)
}

const guardedCache = new WeakMap<object, Map<string, Set<FlattenedField>>>()
/** The parent field objects inside one field set (a collection's plain fields, or its version fields). */
function guardedIn(payload: Payload, opts: ResolvedOptions, slug: string, set: FlattenedField[], prefix: string[]): Set<FlattenedField> {
  let byKey = guardedCache.get(set)
  if (!byKey) guardedCache.set(set, (byKey = new Map()))
  const key = `${slug}|${prefix.join('.')}`
  let found = byKey.get(key)
  if (!found) {
    found = new Set()
    for (const p of guardedPaths(opts, slug)) for (const f of fieldsAt(payload, set, [...prefix, ...p.split('.')])) found.add(f)
    for (const p of guardedRowRoots(opts, slug)) for (const f of fieldsAt(payload, set, [...prefix, ...p.split('.')])) withinField(payload, f, found)
    byKey.set(key, found)
  }
  return found
}

const versionCache = new WeakMap<object, FlattenedField[] | null>()
/** The version fields as Payload's version queries build them, or null if the collection has no versions or the builder fails. */
export function versionFields(payload: Payload, slug: string): FlattenedField[] | null {
  const config = payload.collections[slug as never]?.config
  if (!config?.versions) return null
  if (versionCache.has(config)) return versionCache.get(config)!
  let built: FlattenedField[] | null
  try {
    built = buildVersionCollectionFields(payload.config, config, true)
  } catch {
    built = null
  }
  versionCache.set(config, built)
  return built
}

export type FieldSet = { fields: FlattenedField[]; version: boolean }

/** The field sets a collection's hook `operation` can see: version fields for `countVersions`, plain and version fields for `read`. */
export function fieldSetsFor(payload: Payload, slug: string, operation: string): FieldSet[] {
  const config = payload.collections[slug as never]?.config
  if (!config) throw new Unresolved(`unknown collection ${slug}`)
  const sets: FieldSet[] = []
  const v = config.versions ? versionFields(payload, slug) : null
  if (config.versions && !v) throw new Unresolved('version fields could not be built')
  if (operation !== 'countVersions') sets.push({ fields: config.flattenedFields, version: false })
  if (v && (operation === 'read' || operation === 'countVersions')) sets.push({ fields: v, version: true })
  return sets
}

/** Payload's own key normalizing (`validateSearchParam`): `_id` is `id`, and a double underscore is a dot. */
const normalize = (raw: string): string => (raw === '_id' ? 'id' : raw.replace(/__/g, '.'))

const strongest = (a: Hit, b: Hit): Hit => (a === 'below' || b === 'below' ? 'below' : a === 'exact' || b === 'exact' ? 'exact' : null)

export type Resolved = { hit: Hit; entries: Entry[]; set: FieldSet }

/**
 * Resolves `raw` in every field set and classifies it. Returns what was found in each set where the key resolved;
 * throws `Unresolved` when it resolved in none, was too long, or Payload threw.
 */
export function resolveKey(payload: Payload, opts: ResolvedOptions, slug: string, sets: FieldSet[], raw: string, locale: string | undefined): Resolved[] {
  if (typeof raw !== 'string' || raw.length === 0) throw new Unresolved('empty key')
  const incomingPath = normalize(raw)
  if (incomingPath.split('.').length > MAX_SEGMENTS) throw new Unresolved('key too long')
  const out: Resolved[] = []
  for (const set of sets) {
    let entries: Entry[]
    try {
      entries = getLocalizedPaths({ collectionSlug: slug, fields: set.fields, incomingPath, locale, overrideAccess: false, payload, showHiddenFields: false }) as Entry[]
    } catch {
      continue
    }
    if (!entries.length || entries.length > MAX_ENTRIES) throw new Unresolved('too many hops')
    if (entries.some((e) => e.invalid || !e.field)) continue
    let hit: Hit = null
    entries.forEach((e, i) => {
      const first = i === 0
      // After the first entry, Payload searched the related collection's plain fields.
      const guarded = first ? guardedIn(payload, opts, e.collectionSlug ?? slug, e.fields ?? set.fields, set.version ? ['version'] : []) : guardedIn(payload, opts, e.collectionSlug!, e.fields ?? payload.collections[e.collectionSlug as never]?.config.flattenedFields ?? [], [])
      if (e.field && guarded.has(e.field)) hit = strongest(hit, i === entries.length - 1 ? 'exact' : 'below')
    })
    out.push({ hit, entries, set })
  }
  if (!out.length) throw new Unresolved(`unresolved key`)
  return out
}

export const strongestHit = (rs: Resolved[]): Hit => rs.reduce<Hit>((h, r) => strongest(h, r.hit), null)
