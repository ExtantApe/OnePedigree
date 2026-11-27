import type { Payload } from 'payload'

import { assertResolverGuards } from './parentPaths.js'
import { globalVersionsGuarded, guardGlobalVersions } from './globalGuard.js'
import { refused } from './privacy.js'
import type { ResolvedOptions } from './types.js'

/**
 * Whether the config Payload is running carries the guard is recorded against that config object, in one registry
 * shared by every build of the plugin and every copy of this module. A dev reload swaps in a new config built by a new
 * run of the plugin, so nothing here may depend on one plugin closure: the parts are recognized by a mark, not by
 * identity, and the record is keyed by the config, not held in a closure.
 */
const MARK = Symbol.for('onepedigree.part')
const REGISTRY = Symbol.for('onepedigree.guardedConfigs')
const ANCHORED = Symbol.for('onepedigree.anchoredAdapters')
type Registry = WeakMap<object, Set<string>>
const store = globalThis as { [REGISTRY]?: Registry; [ANCHORED]?: WeakSet<object> }
const guarded: Registry = (store[REGISTRY] ??= new WeakMap())
const anchored: WeakSet<object> = (store[ANCHORED] ??= new WeakSet())

export type Part = 'guard' | 'redact'
/** Marks one of the plugin's functions as `part` for the individuals collection `opts.collection`. */
export const mark = <T extends object>(fn: T, part: Part, opts: ResolvedOptions, slug = opts.collection): T => {
  Object.defineProperty(fn, MARK, { value: `${part}:${opts.collection}:${slug}` })
  return fn
}
const isPart = (fn: unknown, part: Part, opts: ResolvedOptions, slug: string) => typeof fn === 'function' && (fn as { [MARK]?: string })[MARK] === `${part}:${opts.collection}:${slug}`

/** True when the config object Payload runs now has been checked to carry every part of the guard. */
export const isGuarded = (config: object | undefined, opts: ResolvedOptions): boolean => Boolean(config && guarded.get(config)?.has(opts.collection))

/** The options of the plugin build that made the running config, when it is the same install; else the caller's. */
const liveOptions = (payload: Payload, own: ResolvedOptions): ResolvedOptions => {
  const live = (payload.config?.custom as { onepedigree?: ResolvedOptions } | undefined)?.onepedigree
  return live && live.collection === own.collection ? live : own
}

/**
 * Puts the guard on every collection and global of the running config that lacks it (ones a later plugin added),
 * checks that the individuals and cohorts collections still carry the redaction, checks Payload's resolver, and only
 * then records the config as guarded. Throws, and records nothing, when any of that fails. Safe to call again.
 */
export function ensureGuarded(payload: Payload, own: ResolvedOptions, ownGuard: unknown): void {
  const config = payload?.config
  if (!config) throw refused()
  if (isGuarded(config, own)) return
  const opts = liveOptions(payload, own)
  if (opts.disabled) return
  const all = [...(config.collections ?? []), ...Object.values(payload.collections ?? {}).map((c) => c?.config)].filter(Boolean)
  const hasGuard = (c: (typeof all)[number]) => ((c.hooks?.beforeOperation ?? []) as unknown[]).some((h) => isPart(h, 'guard', opts, opts.collection))
  // The running config's own guard where there is one, so a late collection gets the same guard as the rest.
  const guard = all.flatMap((c) => (c.hooks?.beforeOperation ?? []) as unknown[]).find((h) => isPart(h, 'guard', opts, opts.collection)) ?? ownGuard
  for (const c of new Set(all)) {
    if (!hasGuard(c))
      try {
        const hooks = (c.hooks ??= {} as never) as { beforeOperation?: unknown[] }
        ;(hooks.beforeOperation ??= []).push(guard)
      } catch {
        // Not changeable: checked below.
      }
    if (!hasGuard(c)) throw new Error(`OnePedigree: could not guard collection "${c.slug}", so Payload won't start or answer queries without the guard. Add the collection before this plugin, or make its hooks changeable.`)
  }
  for (const g of new Set([...(config.globals ?? []), ...(payload.globals?.config ?? [])])) {
    try {
      guardGlobalVersions(g, opts, true)
    } catch {
      // Checked below.
    }
    if (!globalVersionsGuarded(g)) throw new Error(`OnePedigree: could not guard the versions of global "${g.slug}", so Payload won't start or answer queries without the guard.`)
  }
  // A later plugin can drop or replace the individuals or cohorts collection, taking the redaction with it.
  for (const slug of [opts.collection, ...(opts.cohorts ? [opts.cohorts.collection] : [])]) {
    const found = all.filter((c) => c.slug === slug)
    if (!found.length || found.some((c) => !((c.hooks?.afterRead ?? []) as unknown[]).some((h) => isPart(h, 'redact', opts, slug))))
      throw new Error(`OnePedigree: collection "${slug}" is missing or was replaced by a later plugin, so its parents can't be kept private. Payload won't start or answer queries until it carries this plugin's hooks.`)
  }
  assertResolverGuards(payload, opts)
  let set = guarded.get(config)
  if (!set) guarded.set(config, (set = new Set()))
  set.add(opts.collection)
}

/** Adapter methods that read or that take a where. Lifecycle methods (connect, destroy, migrations, transactions) are left alone. */
const QUERIES = ['count', 'countGlobalVersions', 'countVersions', 'deleteMany', 'deleteOne', 'deleteVersions', 'find', 'findDistinct', 'findGlobal', 'findGlobalVersions', 'findOne', 'findVersions', 'queryDrafts', 'updateGlobalVersion', 'updateMany', 'updateOne', 'updateVersion', 'upsert'] as const

/**
 * The database adapter object outlives a dev reload: Payload swaps the config and calls this same object's `init`.
 * So the first time any part of the plugin sees the running instance, it wraps that object once. Its `init` checks
 * the config that is running then, and each query method refuses while the running config isn't recorded as guarded
 * (after trying to guard it), because a query that got this far without the guard may already be unguarded.
 */
export function anchorAdapter(payload: Payload, adapter: unknown, own: ResolvedOptions, ownGuard: unknown): void {
  if (!adapter || typeof adapter !== 'object' || anchored.has(adapter)) return
  const db = adapter as Record<string, unknown>
  const running = () => (db.payload as Payload | undefined) ?? payload
  const replace = (name: string, wrap: (orig: (...a: unknown[]) => unknown) => (this: unknown, ...a: unknown[]) => unknown) => {
    const orig = db[name]
    if (typeof orig !== 'function') return
    try {
      db[name] = wrap(orig as (...a: unknown[]) => unknown)
    } catch {
      // A method that can't be wrapped is caught below.
    }
    if (db[name] === orig) throw new Error(`OnePedigree: could not wrap the database adapter's "${name}", so Payload won't start or answer queries without the guard.`)
  }
  replace('init', (orig) =>
    function (this: unknown, ...a: unknown[]) {
      ensureGuarded(running(), own, ownGuard)
      return orig.apply(this, a)
    },
  )
  for (const name of QUERIES)
    replace(name, (orig) =>
      function (this: unknown, ...a: unknown[]) {
        const p = running()
        if (!own.disabled && !isGuarded(p?.config, own) && !liveOptions(p, own).disabled) {
          ensureGuarded(p, own, ownGuard)
          throw refused()
        }
        return orig.apply(this, a)
      },
    )
  anchored.add(adapter)
}

/** Every place the plugin sees the running instance: wrap its adapter once, then make sure the running config is guarded. */
export function checkpoint(payload: Payload, own: ResolvedOptions, ownGuard: unknown): void {
  if (payload?.db) anchorAdapter(payload, payload.db, own, ownGuard)
  ensureGuarded(payload, own, ownGuard)
}
