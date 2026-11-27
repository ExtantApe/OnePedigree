import type { Access, GlobalConfig, Payload } from 'payload'

import { readsEveryIndividual } from './privacy.js'
import type { ResolvedOptions } from './types.js'

/**
 * Global version reads (`findGlobalVersions`, `findGlobalVersionByID`, REST `/globals/<slug>/versions`, GraphQL
 * `versions<Slug>`) never run `beforeOperation`, so the query guard can't see their `where`. Every one of them does run
 * `access.readVersions` for a caller that isn't trusted. A global that holds a reference to individuals (directly, or
 * through any chain of relationship, upload and join fields) therefore answers `false` there for a caller who can't
 * read every individual: with nothing to read, a hidden ID and a made-up one get the same answer. Globals with no such
 * reference keep the host's own rule.
 */
const MARK = Symbol.for('onepedigree.readVersionsGuard')
type Targets = { relationTo?: string | string[]; collection?: string | string[]; type?: string; flattenedFields?: unknown[]; blocks?: unknown[]; blockReferences?: unknown[] }

const targetsOf = (fields: unknown[], payload: Payload, out = new Set<string>(), seen = new Set<unknown>()): Set<string> => {
  for (const f of fields as Targets[]) {
    if (!f || seen.has(f)) continue
    seen.add(f)
    if (f.type === 'relationship' || f.type === 'upload') for (const t of ([] as string[]).concat(f.relationTo ?? [])) out.add(t)
    if (f.type === 'join') for (const t of ([] as string[]).concat(f.collection ?? [])) out.add(t)
    if (f.flattenedFields) targetsOf(f.flattenedFields, payload, out, seen)
    for (const b of f.blockReferences ?? f.blocks ?? []) {
      const block = typeof b === 'string' ? (payload.blocks as Record<string, { flattenedFields?: unknown[] }>)[b] : (b as { flattenedFields?: unknown[] })
      if (block?.flattenedFields) targetsOf(block.flattenedFields, payload, out, seen)
    }
  }
  return out
}

const cache = new WeakMap<object, Map<string, boolean>>()
/** True when the global's fields can reach the individuals or cohorts collection. */
function exposed(payload: Payload, opts: ResolvedOptions, global: { slug: string; flattenedFields?: unknown[]; fields: unknown[] }): boolean {
  let byGlobal = cache.get(payload.config)
  if (!byGlobal) cache.set(payload.config, (byGlobal = new Map()))
  const cached = byGlobal.get(global.slug)
  if (cached !== undefined) return cached
  const goal = new Set([opts.collection, ...(opts.cohorts ? [opts.cohorts.collection] : [])])
  const reaches = new Map<string, boolean>()
  const collectionReaches = (slug: string, path: Set<string>): boolean => {
    if (goal.has(slug)) return true
    if (reaches.has(slug)) return reaches.get(slug)!
    if (path.has(slug)) return false
    const config = payload.collections[slug as never]?.config
    if (!config) return false
    const next = new Set(path).add(slug)
    const r = [...targetsOf(config.flattenedFields, payload)].some((t) => collectionReaches(t, next))
    // A negative answer found inside a cycle can be wrong for another entry point, so only a positive one is kept.
    if (r) reaches.set(slug, true)
    return r
  }
  const result = [...targetsOf(global.flattenedFields ?? global.fields, payload)].some((t) => collectionReaches(t, new Set()))
  byGlobal.set(global.slug, result)
  return result
}

/** Wraps `access.readVersions` of a global with versions, once. Safe to call again on the same global. */
export function guardGlobalVersions<T extends GlobalConfig>(global: T, opts: ResolvedOptions, inPlace = false): T {
  if (!global.versions) return global
  const host = global.access?.readVersions as (Access & { [MARK]?: boolean }) | undefined
  if (host?.[MARK]) return global
  const guarded: Access & { [MARK]?: boolean } = async (args) => {
    const req = args.req
    if (!req?.payload) return false
    const config = (req.payload.config.globals ?? []).find((g) => g.slug === global.slug) ?? global
    if (exposed(req.payload, opts, config as never) && !(await readsEveryIndividual(req, opts))) return false
    return host ? host(args) : Boolean(req.user)
  }
  guarded[MARK] = true
  const access = { ...global.access, readVersions: guarded }
  if (!inPlace) return { ...global, access }
  global.access = access
  return global
}
