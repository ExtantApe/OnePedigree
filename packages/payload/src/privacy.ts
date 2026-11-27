import { APIError, validations, ValidationError, type CollectionAfterReadHook, type CollectionBeforeOperationHook, type CollectionBeforeValidateHook, type CollectionSlug, type PayloadRequest, type Where } from 'payload'

import { isBiologicalKind } from '@extantape/onepedigree-core'

import { getAt, idOf } from './mapping.js'
import { childReq } from './request.js'
import type { ResolvedOptions } from './types.js'

/**
 * What a reader gets in place of a parent they may not read, on plain collection reads (REST, GraphQL, Admin, Local
 * API with access control): no ID, name or link. With `hiddenRecords: 'omit'` the parent is left out instead.
 */
export type PrivateParent = { private: true }
export const isPrivateParent = (v: unknown): v is PrivateParent =>
  Boolean(v) && typeof v === 'object' && !('id' in (v as object)) && (v as { private?: unknown }).private === true

/** Per request: which individuals its user may read. */
const READABLE = 'onepedigreeReadable'
const SELECTOR_ROLES = { mother: 'mother', father: 'father' } as const
/** Per request and record: stored parents the editor can't read, kept by `keepHiddenParents`. */
const KEPT = 'onepedigreeKeptParents'

/**
 * Wraps a parent field's validation. A stored parent that `keepHiddenParents` kept on this record is valid as it is:
 * Payload's own check would look it up with the editor's access whenever the field has `filterOptions` (multi-tenant
 * adds them), and refuse it, so the editor couldn't save the record at all. Every other value goes through the
 * field's own validation, or Payload's relationship validation.
 */
export const keptParentValidate =
  (original: ((value: unknown, options: unknown) => unknown) | undefined) =>
  (value: unknown, options: { id?: string | number; req?: PayloadRequest; [k: string]: unknown }) => {
    const kept = options?.id != null ? (options.req?.context[KEPT] as Map<string, Set<string>> | undefined)?.get(String(options.id)) : undefined
    const id = idOf(value)
    if (kept && id && kept.has(id)) return true
    return (original ?? (validations.relationship as (value: unknown, options: unknown) => unknown))(value, options)
  }

/** Per request: how many of the plugin's own reads are running that need stored IDs (they redact for themselves). */
const RAW = 'onepedigreeRawParents'

/**
 * Runs `read` with stored parent IDs left in place, for the plugin's own reads through access control: the pedigree
 * and relatives endpoints, which replace hidden parents with their own placeholders, and the parentage check. `read`
 * gets a child request carrying the marker and must pass it to Payload; the caller's request is left as it was, so
 * sibling documents in a bulk update and later reads on the same request are still redacted. A counter, not a flag,
 * so nested reads keep it. Never return these documents to a reader as they are.
 */
export async function withStoredParents<T>(req: PayloadRequest, read: (req: PayloadRequest) => Promise<T>): Promise<T> {
  return read(childReq(req, { [RAW]: ((req.context[RAW] as number | undefined) ?? 0) + 1 }))
}

/** The IDs among `ids` that the request's user may read. Cached on the request. */
export async function readableIds(req: PayloadRequest, opts: ResolvedOptions, ids: readonly string[]): Promise<Set<string>> {
  const cache = ((req.context[READABLE] as Map<string, boolean> | undefined) ??= new Map<string, boolean>())
  const unknown = [...new Set(ids)].filter((id) => !cache.has(id))
  if (unknown.length) {
    const read = req.payload.collections[opts.collection as CollectionSlug]?.config.access.read
    const all = read ? (await read({ req } as never)) === true : Boolean(req.user)
    let found = new Set(unknown)
    if (!all) {
      const { docs } = await req.payload.find({
        collection: opts.collection as CollectionSlug,
        where: { id: { in: unknown } } as Where,
        depth: 0,
        pagination: false,
        select: {} as never,
        overrideAccess: false,
        // No context flag here: Payload would copy it onto this request. These docs carry IDs only, so this hook
        // finds no parents in them and returns at once.
        req,
      })
      found = new Set((docs as unknown as { id: unknown }[]).map((d) => String(d.id)))
    }
    for (const id of unknown) cache.set(id, found.has(id))
  }
  return new Set(ids.filter((id) => cache.get(id)))
}

const setAt = (doc: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split('.')
  let o: Record<string, unknown> = doc
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') return
    o = o[k] as Record<string, unknown>
  }
  if (value === undefined) delete o[keys.at(-1)!]
  else o[keys.at(-1)!] = value
}

/** Every stored parent ID of a document, wherever the mapping keeps it (role fields, rows, pickers). */
function storedIds(doc: unknown, opts: ResolvedOptions): string[] {
  const m = opts.fields.parentage
  if (m.kind === 'role-fields') return Object.values(m.roles).flatMap((p) => idOf(getAt(doc, p)) ?? [])
  const rows = getAt(doc, `${m.path}.parents`)
  const fromRows = Array.isArray(rows) ? rows.flatMap((r) => idOf((r as Record<string, unknown>)?.[m.individualField]) ?? []) : []
  const fromPickers = Object.keys(SELECTOR_ROLES).flatMap((k) => idOf(getAt(doc, `${m.path}.${k}`)) ?? [])
  return [...fromRows, ...fromPickers]
}

/**
 * Plain reads (spec §42.4): a parent the reader may not read comes back as `{ private: true }`, or is left out with
 * `hiddenRecords: 'omit'`, at every depth. Trusted Local API reads (access control overridden) are unchanged.
 */
export const parentageAfterRead =
  (opts: ResolvedOptions): CollectionAfterReadHook =>
  async ({ doc, req, overrideAccess }) => {
    if (overrideAccess === true || ((req.context[RAW] as number | undefined) ?? 0) > 0 || !doc || typeof doc !== 'object') return doc
    const ids = storedIds(doc, opts)
    if (!ids.length) return doc
    const ok = await readableIds(req, opts, ids)
    const hidden = new Set(ids.filter((id) => !ok.has(id)))
    if (!hidden.size) return doc
    const isHidden = (v: unknown) => {
      const id = idOf(v)
      return id !== null && hidden.has(id)
    }
    // GraphQL resolves relationship values itself and needs an ID or nothing; there, a hidden parent is null.
    const placeholder = opts.hiddenRecords === 'placeholder' && req.payloadAPI !== 'GraphQL'
    const m = opts.fields.parentage
    if (m.kind === 'role-fields') {
      for (const path of Object.values(m.roles)) if (isHidden(getAt(doc, path))) setAt(doc, path, placeholder ? { private: true } : null)
      return doc
    }
    const rows = getAt(doc, `${m.path}.parents`)
    if (Array.isArray(rows))
      setAt(
        doc,
        `${m.path}.parents`,
        rows.flatMap((r: Record<string, unknown>) => {
          if (!isHidden(r?.[m.individualField])) return [r]
          return placeholder ? [{ ...r, [m.individualField]: { private: true } }] : req.payloadAPI === 'GraphQL' ? [{ ...r, [m.individualField]: null }] : []
        }),
      )
    for (const k of Object.keys(SELECTOR_ROLES))
      if (isHidden(getAt(doc, `${m.path}.${k}`))) setAt(doc, `${m.path}.${k}`, placeholder ? { private: true } : null)
    return doc
  }

const refuse = (opts: ResolvedOptions, path: string): never => {
  throw new ValidationError({
    collection: opts.collection,
    errors: [{ path, message: 'This parent is private to you, so you can’t change or remove it. Ask someone who can see it.' }],
  })
}

/**
 * The write side of the redaction: on an update with access control, parents the editor may not read are kept as
 * stored. A placeholder, an empty value or a missing row means "unchanged", so saving a form that showed a private
 * parent never erases it; replacing one with another parent is refused. Runs before field validation.
 */
export const keepHiddenParents =
  (opts: ResolvedOptions, trustedKey: string, skipKey: string): CollectionBeforeValidateHook =>
  async ({ data, originalDoc, req, operation, context }) => {
    if (operation !== 'update' || !data || !originalDoc || context[skipKey] || context[trustedKey] === true) return data
    const stored = storedIds(originalDoc, opts)
    if (!stored.length) return data
    const ok = await readableIds(req, opts, stored)
    const hidden = new Set(stored.filter((id) => !ok.has(id)))
    if (!hidden.size) return data
    // For `keptParentValidate`: these stored parents stay on this record, so field validation lets them through.
    const kept = ((req.context[KEPT] as Map<string, Set<string>> | undefined) ??= new Map<string, Set<string>>())
    kept.set(String(originalDoc.id), hidden)
    const d = data as Record<string, unknown>
    const m = opts.fields.parentage

    if (m.kind === 'role-fields') {
      for (const path of Object.values(m.roles)) {
        const before = idOf(getAt(originalDoc, path))
        const next = getAt(d, path)
        if (!before || !hidden.has(before) || next === undefined) continue
        if (next === null || isPrivateParent(next) || idOf(next) === before) setAt(d, path, before)
        else refuse(opts, path)
      }
      return d
    }

    for (const k of Object.keys(SELECTOR_ROLES) as (keyof typeof SELECTOR_ROLES)[]) {
      const path = `${m.path}.${k}`
      const next = getAt(d, path)
      if (next === undefined) continue
      const rows = (getAt(originalDoc, `${m.path}.parents`) ?? []) as Record<string, unknown>[]
      // The picker shows the biological row with its role (see `createRoleSelectorField`).
      const before = idOf(rows.find((r) => r?.[m.roleField] === SELECTOR_ROLES[k] && isBiologicalKind(r?.[m.kindField] as string | null | undefined))?.[m.individualField])
      if (!before || !hidden.has(before)) continue
      // Leave the picker out of the write: the rows below keep the private parent.
      if (next === null || isPrivateParent(next) || idOf(next) === before) setAt(d, path, undefined)
      else refuse(opts, path)
    }

    const incoming = getAt(d, `${m.path}.parents`)
    if (!Array.isArray(incoming)) return d
    const originals = ((getAt(originalDoc, `${m.path}.parents`) ?? []) as Record<string, unknown>[]).filter((r) => hidden.has(idOf(r?.[m.individualField]) ?? ''))
    const used = new Set<Record<string, unknown>>()
    const restore = (row: Record<string, unknown>) => {
      const match = originals.find((o) => !used.has(o) && row?.id != null && o.id === row.id) ?? originals.find((o) => !used.has(o))
      if (!match) return null
      used.add(match)
      return { ...match, [m.individualField]: idOf(match[m.individualField]) }
    }
    const rows: Record<string, unknown>[] = []
    for (const row of incoming as Record<string, unknown>[]) {
      const v = row?.[m.individualField]
      if (isPrivateParent(v)) {
        const r = restore(row)
        if (r) rows.push(r)
        continue
      }
      const id = idOf(v)
      if (id && hidden.has(id)) {
        const o = originals.find((x) => !used.has(x) && idOf(x[m.individualField]) === id)
        if (o) used.add(o)
      }
      rows.push(row)
    }
    // Private rows the editor didn't send (left out, or omitted from what they read) stay.
    for (const o of originals) if (!used.has(o)) rows.push({ ...o, [m.individualField]: idOf(o[m.individualField]) })
    setAt(d, `${m.path}.parents`, rows)
    return d
  }

/**
 * A cohort's birthing parent the reader may not read comes back as `{ private: true }` (or null with
 * `hiddenRecords: 'omit'` and in GraphQL), like a hidden parent on an individual. Trusted reads are unchanged.
 */
export const birthParentAfterRead =
  (opts: ResolvedOptions): CollectionAfterReadHook =>
  async ({ doc, req, overrideAccess }) => {
    const field = opts.cohorts?.birthParentField
    if (!field || overrideAccess === true || ((req.context[RAW] as number | undefined) ?? 0) > 0 || !doc || typeof doc !== 'object') return doc
    const id = idOf(getAt(doc, field))
    if (!id || (await readableIds(req, opts, [id])).has(id)) return doc
    setAt(doc, field, opts.hiddenRecords === 'placeholder' && req.payloadAPI !== 'GraphQL' ? { private: true } : null)
    return doc
  }

/** The write side for a cohort: a hidden birthing parent stays as stored; a placeholder or empty value means unchanged. */
export const keepHiddenBirthParent =
  (opts: ResolvedOptions, trustedKey: string, skipKey: string): CollectionBeforeValidateHook =>
  async ({ data, originalDoc, req, operation, context }) => {
    const field = opts.cohorts?.birthParentField
    if (!field || (operation !== 'update' && operation !== 'create') || !data || context[skipKey] || context[trustedKey] === true) return data
    // A new or changed birthing parent must be one the editor can read; a hidden ID and a made-up one get the same refusal.
    const incoming = idOf(getAt(data, field))
    const was = originalDoc ? idOf(getAt(originalDoc, field)) : null
    if (incoming && incoming !== was && !isPrivateParent(getAt(data, field)) && !(await readableIds(req, opts, [incoming])).has(incoming))
      throw new ValidationError({ collection: opts.cohorts!.collection, errors: [{ path: field, message: 'A parent does not exist or you cannot access it.' }] })
    if (!originalDoc) return data
    const before = idOf(getAt(originalDoc, field))
    if (!before || (await readableIds(req, opts, [before])).has(before)) return data
    const d = data as Record<string, unknown>
    const next = getAt(d, field)
    if (next === undefined) return d
    if (next === null || isPrivateParent(next) || idOf(next) === before) setAt(d, field, before)
    else
      throw new ValidationError({
        collection: opts.cohorts!.collection,
        errors: [{ path: field, message: 'This parent is private to you, so you can’t change or remove it. Ask someone who can see it.' }],
      })
    return d
  }

const REFUSED = 'Parent fields can’t be filtered or sorted.'
const refused = () => new APIError(REFUSED, 400)

/** The parent paths on a collection: the individuals' parent fields and cohort birthing parent, or the cohorts' birthing parent. Empty elsewhere. */
const guardedPaths = (opts: ResolvedOptions, slug: string): string[] => {
  const m = opts.fields.parentage
  const birth = opts.cohorts?.birthParentField
  if (opts.cohorts && slug === opts.cohorts.collection) return birth ? [birth] : []
  if (slug !== opts.collection) return []
  const own = m.kind === 'role-fields' ? Object.values(m.roles) : [`${m.path}.parents.${m.individualField}`, `${m.path}.mother`, `${m.path}.father`]
  return birth && m.cohort ? [...own, `${m.cohort}.${birth}`] : own
}

type FieldLike = { type?: string; name?: string; relationTo?: string | string[]; collection?: string | string[]; fields?: FieldLike[]; tabs?: { name?: string; fields: FieldLike[] }[]; blocks?: { fields: FieldLike[] }[] }
const asList = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : [])

/** Every relationship and join field of a collection by dotted path, with the collections it points to. */
const relationMap = (() => {
  const cache = new WeakMap<object, Map<string, string[]>>()
  const walk = (fields: FieldLike[], prefix: string, out: Map<string, string[]>): void => {
    for (const f of fields) {
      const path = f.name ? `${prefix}${f.name}` : null
      if (path && (f.type === 'relationship' || f.type === 'upload') && f.relationTo) out.set(path, asList(f.relationTo))
      if (path && f.type === 'join' && f.collection) out.set(path, asList(f.collection))
      if (f.fields) walk(f.fields, path ? `${path}.` : prefix, out)
      if (f.tabs) for (const t of f.tabs) walk(t.fields, t.name ? `${prefix}${t.name}.` : prefix, out)
      if (f.blocks) for (const b of f.blocks) walk(b.fields, path ? `${path}.` : prefix, out)
    }
  }
  return (fields: unknown): Map<string, string[]> => {
    const key = fields as object
    let m = cache.get(key)
    if (!m) cache.set(key, (m = new Map())), walk(fields as FieldLike[], '', m)
    return m
  }
})()

const COMPARE = new Set(['equals', 'in', 'not_equals', 'not_in'])

/**
 * Filtering or sorting by a parent field answers "is this hidden record the parent?" for any ID, or orders a hidden
 * parent among known ones. This runs on every collection, because a path can reach a parent field through any
 * relationship (`animal.dam`, `mate.dam`, `animal.clutch.mother`), and on joins, which skip the target's own hooks.
 * With access control on, on every read path (find, count, distinct, versions, joins, GraphQL): sorting and paths
 * below a parent field are refused; `equals`, `in`, `not_equals` and `not_in` are allowed only when every ID is one
 * the requester can read, so a hidden ID and a made-up one get the same answer; `exists` and an empty value only with
 * `hiddenRecords: 'placeholder'`, where a hidden parent shows as a placeholder and counts as set.
 */
export const guardParentQueries =
  (opts: ResolvedOptions): CollectionBeforeOperationHook =>
  async ({ args, operation, collection, req }) => {
    const a = args as { overrideAccess?: boolean; where?: unknown; sort?: unknown; field?: unknown; joins?: unknown; req?: PayloadRequest }
    const ops = ['read', 'count', 'readDistinct', 'update', 'delete', 'countVersions']
    if (a.overrideAccess === true || !ops.includes(operation)) return args
    const request = a.req ?? req
    const collections = request?.payload?.collections as Record<string, { config: { fields: unknown } }> | undefined
    const relations = (slug: string) => {
      const c = collections?.[slug]
      return c ? relationMap(c.config.fields) : new Map<string, string[]>()
    }
    // 'exact' is the parent field itself; 'below' is a path through it (a join to the parent's own fields).
    const walkPath = (slug: string, segs: string[], depth: number): 'exact' | 'below' | null => {
      if (depth > 8) return null
      for (const p of guardedPaths(opts, slug)) {
        const ps = p.split('.')
        if (ps.every((x, n) => segs[n] === x)) return segs.length === ps.length ? 'exact' : 'below'
      }
      const rel = relations(slug)
      for (let j = 1; j < segs.length; j++) {
        const targets = rel.get(segs.slice(0, j).join('.'))
        if (!targets) continue
        // Polymorphic paths read `field.value.<path>`.
        const rest = segs.slice(j)
        for (const t of targets)
          for (const r of [rest, rest[0] === 'value' ? rest.slice(1) : null]) {
            const k = r && r.length ? walkPath(t, r, depth + 1) : null
            if (k) return k
          }
      }
      return null
    }
    // Payload reports findVersions as a plain read, so a version's fields (`version.<field>`) are treated like the document's.
    const classify = (slug: string, raw: string): 'exact' | 'below' | null => {
      const segs = raw.split('.')
      return walkPath(slug, segs, 0) ?? (segs[0] === 'version' ? walkPath(slug, segs.slice(1), 0) : null)
    }
    const ids: string[] = []
    const check = (slug: string, where: unknown, sort: unknown): void => {
      const sorts = (Array.isArray(sort) ? sort : typeof sort === 'string' ? sort.split(',') : []).map((x) => String(x).trim().replace(/^-/, ''))
      if (sorts.some((k) => classify(slug, k))) throw refused()
      const walk = (w: unknown): void => {
        if (Array.isArray(w)) return w.forEach(walk)
        if (!w || typeof w !== 'object') return
        for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
          if (k === 'and' || k === 'or') {
            walk(v)
            continue
          }
          const kind = classify(slug, k)
          if (!kind) {
            walk(v)
            continue
          }
          if (kind === 'below' || !v || typeof v !== 'object' || Array.isArray(v)) throw refused()
          for (const [op, operand] of Object.entries(v as Record<string, unknown>)) {
            if (op === 'exists') {
              if (opts.hiddenRecords !== 'placeholder') throw refused()
              continue
            }
            if (!COMPARE.has(op)) throw refused()
            for (const o of Array.isArray(operand) ? operand : typeof operand === 'string' && (op === 'in' || op === 'not_in') ? operand.split(',') : [operand]) {
              const id = idOf(o)
              if (id === null) {
                if (opts.hiddenRecords !== 'placeholder') throw refused()
                continue
              }
              ids.push(id)
            }
          }
        }
      }
      walk(where)
    }
    const slug = collection.slug
    if (typeof a.field === 'string' && classify(slug, a.field)) throw refused()
    check(slug, a.where, a.sort)
    // Joins: the REST and Local API run them without the target collection's own hooks, so their filter and sort are checked here.
    if (a.joins && typeof a.joins === 'object')
      for (const [name, j] of Object.entries(a.joins as Record<string, unknown>)) {
        if (!j || typeof j !== 'object') continue
        for (const target of relations(slug).get(name) ?? []) check(target, (j as { where?: unknown }).where, (j as { sort?: unknown }).sort)
      }
    if (!ids.length) return args
    if (!request) throw refused()
    // An ID the database can't parse is as unreadable as a made-up one.
    const ok = await readableIds(request, opts, ids).catch(() => new Set<string>())
    if (ids.some((id) => !ok.has(id))) throw refused()
    return args
  }
