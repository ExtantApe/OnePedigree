import { PEDIGREE_VIEWS } from '@extantape/onepedigree-core'
import { databaseKVAdapter, type Access, type CollectionBeforeOperationHook, type CollectionConfig, type Config, type EmailAdapter, type Field, type FieldAccess, type GlobalConfig, type KVAdapterResult, type Payload, type Plugin } from 'payload'

import { createCohortsCollection, createIndividualsCollection } from './collections.js'
import { cohortMembersEndpoint, pedigreeEndpoint, relativesEndpoint, validateEndpoint } from './endpoints.js'
import { anchorAdapter, checkpoint, ensureGuarded, isGuarded, mark } from './install.js'
import { guardedPaths } from './parentPaths.js'
import { createParentageField } from './fields.js'
import { guardGlobalVersions } from './globalGuard.js'
import { cohortBirthParentBeforeChange, parentageBeforeChange, parentBeforeDelete, rememberAccessMode, SKIP, TRUSTED } from './integrity.js'
import { resolveOptions } from './mapping.js'
import { birthParentAfterRead, keepHiddenBirthParent, keepHiddenParents, keptParentValidate, parentageAfterRead, guardParentQueries, refused } from './privacy.js'
import type { OnePedigreePluginOptions, ResolvedOptions } from './types.js'

const CLIENT = '@extantape/payload-plugin-onepedigree/client'

const panelField = (opts: ResolvedOptions): Field => ({
  name: 'pedigreePanel',
  type: 'ui',
  admin: {
    components: {
      Field: {
        path: `${CLIENT}#PedigreePanel`,
        clientProps: {
          views: opts.views?.enabled ?? PEDIGREE_VIEWS,
          defaultView: opts.views?.default ?? 'pedigree',
          settingsGlobal: opts.admin?.settings === false ? null : opts.settingsGlobal,
          terminology: opts.terminology ?? {},
        },
      },
    },
  },
})

const graphGlobal = (opts: ResolvedOptions): GlobalConfig => ({
  slug: opts.graphGlobal,
  admin: { hidden: true },
  // Internal: written in the same transaction as each parentage change (serialization and cache revision).
  access: { read: () => false, update: () => false },
  fields: [{ name: 'revision', type: 'number', defaultValue: 0 }],
})

const settingsGlobal = (opts: ResolvedOptions): GlobalConfig => ({
  slug: opts.settingsGlobal,
  label: 'Pedigree settings',
  access: { read: () => true, update: opts.admin?.settingsAccess ?? (({ req }) => Boolean(req.user)) },
  fields: [
    {
      name: 'theme',
      type: 'json',
      admin: {
        description: 'Colors of pedigree views: choose a preset and adjust any color with a hex code.',
        components: { Field: `${CLIENT}#ThemeField` },
      },
    },
    {
      name: 'defaultView',
      type: 'select',
      defaultValue: opts.views?.default ?? 'pedigree',
      options: (opts.views?.enabled ?? PEDIGREE_VIEWS).map((v) => ({ label: v[0]!.toUpperCase() + v.slice(1), value: v })),
    },
  ],
})

/** Paths of the relationship fields that hold parents: role fields, or the rows' individual and the pickers. */
const parentFieldPaths = (opts: ResolvedOptions): string[] => {
  const m = opts.fields.parentage
  return m.kind === 'role-fields' ? Object.values(m.roles) : [`${m.path}.parents.${m.individualField}`, `${m.path}.mother`, `${m.path}.father`]
}

/** Applies `change` to the named field at `path`, through groups, arrays, rows, collapsibles and tabs. */
function mapFieldAt(fields: Field[], path: string[], change: (f: Field) => Field): Field[] {
  return fields.map((f): Field => {
    const named = 'name' in f && f.name
    if (!named) {
      if (f.type === 'tabs') return { ...f, tabs: f.tabs.map((t) => ('name' in t && t.name ? (t.name === path[0] ? { ...t, fields: mapFieldAt(t.fields, path.slice(1), change) } : t) : { ...t, fields: mapFieldAt(t.fields, path, change) })) }
      return 'fields' in f ? ({ ...f, fields: mapFieldAt(f.fields, path, change) } as Field) : f
    }
    if (f.name !== path[0]) return f
    if (path.length === 1) return change(f)
    return 'fields' in f ? ({ ...f, fields: mapFieldAt(f.fields, path.slice(1), change) } as Field) : f
  })
}

/** Gives the relationship field at `path` the kept-parent validation. */
const wrapParentValidate = (fields: Field[], path: string[]): Field[] =>
  mapFieldAt(fields, path, (f) => (f.type === 'relationship' ? ({ ...f, validate: keptParentValidate(f.validate as never) } as Field) : f))

/**
 * OnePedigree for Payload. Maps (or creates) an individuals collection,
 * validates parentage on every write, serializes parentage changes, applies
 * the deletion policy, and adds permission-aware pedigree endpoints and Admin
 * components. Never creates collections for parents, roles, modes, edges or
 * occurrences.
 */
export const onePedigree =
  (options: OnePedigreePluginOptions): Plugin =>
  (config: Config): Config => {
    const opts = resolveOptions(options)
    let collections = [...(config.collections ?? [])]

    if (opts.mode === 'managed') {
      if (opts.cohorts?.managed && !collections.some((c) => c.slug === opts.cohorts!.collection))
        collections.push((options.overrides?.cohorts ?? ((c) => c))(createCohortsCollection({ slug: opts.cohorts.collection })))
      if (!collections.some((c) => c.slug === opts.collection))
        collections.push(
          (options.overrides?.individuals ?? ((c) => c))(
            createIndividualsCollection({ slug: opts.collection, cohorts: opts.cohorts?.collection ?? null, roles: opts.roles, kinds: opts.kinds, selectors: opts.selectors, terms: opts.terminology?.parents, userPreference: opts.terminology?.userPreference }),
          ),
        )
    }
    if (!collections.some((c) => c.slug === opts.collection)) throw new Error(`OnePedigree: collection "${opts.collection}" not found`)
    // A cohorts collection that only a later plugin adds would never get the birth parent hooks below, so a hidden
    // birth parent would be read out of it unredacted. It has to exist by the time this plugin runs.
    if (opts.cohorts && !collections.some((c) => c.slug === opts.cohorts!.collection))
      throw new Error(`OnePedigree: cohorts collection "${opts.cohorts.collection}" not found. Add it before this plugin (or set cohorts.managed in managed mode), so its birth parent can be kept private.`)
    // The redaction hooks this plugin puts on those two collections, checked again at start in case a later plugin replaced them.
    const individualsAfterRead = mark(parentageAfterRead(opts), 'redact', opts)
    const cohortsAfterRead = opts.cohorts ? mark(birthParentAfterRead(opts), 'redact', opts, opts.cohorts.collection) : birthParentAfterRead(opts)

    collections = collections.map((c): CollectionConfig => {
      if (c.slug === opts.collection) {
        const inject =
          opts.mode === 'standard-fields' && !c.fields.some((f) => 'name' in f && f.name === 'parentage')
            ? [(options.overrides?.parentageField ?? ((f) => f))(createParentageField({
                individuals: opts.collection,
                cohorts: opts.cohorts?.collection,
                roles: opts.roles,
                kinds: opts.kinds,
                defaultMode: opts.reproductiveModes?.default,
                selectors: opts.selectors,
                terms: opts.terminology?.parents,
                userPreference: opts.terminology?.userPreference,
              }))]
            : []
        if (opts.disabled) return { ...c, fields: [...c.fields, ...inject] }
        const fields = parentFieldPaths(opts).reduce((fs, p) => wrapParentValidate(fs, p.split('.')), [...c.fields, ...inject])
        return {
          ...c,
          fields: [...fields, ...(opts.admin?.panel === false ? [] : [panelField(opts)])],
          hooks: {
            ...c.hooks,
            beforeOperation: [...(c.hooks?.beforeOperation ?? []), rememberAccessMode],
            beforeValidate: [...(c.hooks?.beforeValidate ?? []), keepHiddenParents(opts, TRUSTED, SKIP)],
            beforeChange: [...(c.hooks?.beforeChange ?? []), parentageBeforeChange(opts)],
            beforeDelete: [...(c.hooks?.beforeDelete ?? []), parentBeforeDelete(opts)],
            // Last, so host hooks never see a redacted value and nothing after it restores an ID.
            afterRead: [...(c.hooks?.afterRead ?? []), individualsAfterRead],
          },
          endpoints: [...(Array.isArray(c.endpoints) ? c.endpoints : []), pedigreeEndpoint(opts), relativesEndpoint(opts), validateEndpoint(opts)],
        }
      }
      if (opts.cohorts && c.slug === opts.cohorts.collection && !opts.disabled)
        return {
          ...c,
          endpoints: [...(Array.isArray(c.endpoints) ? c.endpoints : []), cohortMembersEndpoint(opts)],
          hooks: {
            ...c.hooks,
            beforeOperation: [...(c.hooks?.beforeOperation ?? []), rememberAccessMode],
            beforeValidate: [...(c.hooks?.beforeValidate ?? []), keepHiddenBirthParent(opts, TRUSTED, SKIP)],
            beforeChange: [...(c.hooks?.beforeChange ?? []), cohortBirthParentBeforeChange(opts)],
            afterRead: [...(c.hooks?.afterRead ?? []), cohortsAfterRead],
          },
        }
      return c
    })
    // Every collection, not only the individuals and cohorts: a query can reach a parent field through any relationship.
    // The guard first makes sure the config that is running now carries the guard everywhere (see install.ts): a dev
    // reload swaps the config, and a later plugin can add collections or replace the hooks that would have done it.
    const queryGuard = guardParentQueries(opts)
    const guard: CollectionBeforeOperationHook = mark((async (a: Parameters<CollectionBeforeOperationHook>[0]) => {
      const payload = ((a.args as { req?: { payload?: Payload } } | undefined)?.req ?? a.req)?.payload
      if (payload) checkpoint(payload, opts, guard)
      return queryGuard(a)
    }) as CollectionBeforeOperationHook, 'guard', opts)
    // A collection that no hook of this plugin reaches (one a later plugin added, before anything installed the guard)
    // can still reach a parent field by filtering through a relationship. Payload then asks the collection that holds
    // the parent field, and each field on the way, whether the requester may read it. Those answers are trip points:
    // while the running config isn't recorded as guarded they guard it now and refuse this one operation, with the
    // guard's own message, so that query can't be answered unguarded. Once guarded they pass the host's answer on.
    // The field ones stay when a later plugin replaces the collection's read access.
    const trip = async (req: { payload?: Payload } | undefined): Promise<void> => {
      const payload = req?.payload
      if (!payload) throw refused()
      if (isGuarded(payload.config, opts)) return
      checkpoint(payload, opts, guard)
      throw refused()
    }
    const tripCollection = (c: CollectionConfig): CollectionConfig => {
      const read = c.access?.read
      const wrapped = async (a: Parameters<Access>[0]) => {
        await trip(a.req)
        return typeof read === 'function' ? read(a) : read ?? Boolean(a.req.user)
      }
      return { ...c, access: { ...c.access, read: wrapped as Access } }
    }
    const tripField = (f: Field): Field => {
      const read = (f as { access?: { read?: FieldAccess } }).access?.read
      const wrapped: FieldAccess = async (a) => {
        await trip(a.req)
        return read ? read(a) : true
      }
      return { ...f, access: { ...(f as { access?: object }).access, read: wrapped } } as Field
    }
    const tripFields = (slug: string, fields: Field[]): Field[] => guardedPaths(opts, slug).reduce((fs, p) => mapFieldAt(fs, p.split('.'), tripField), fields)
    if (!opts.disabled) {
      collections = collections.map((c): CollectionConfig => {
        const withGuard = { ...c, hooks: { ...c.hooks, beforeOperation: [...(c.hooks?.beforeOperation ?? []), guard] } }
        if (c.slug !== opts.collection && c.slug !== opts.cohorts?.collection) return withGuard
        return tripCollection({ ...withGuard, fields: tripFields(c.slug, withGuard.fields) })
      })
    }

    const globals = (config.globals ?? []).map((g) => (opts.disabled ? g : guardGlobalVersions(g, opts)))
    if (!opts.disabled) {
      globals.push(graphGlobal(opts))
      if (opts.admin?.settings !== false && !globals.some((g) => g.slug === opts.settingsGlobal)) globals.push(settingsGlobal(opts))
    }
    // A collection or global added by a plugin that runs after this one isn't in the lists above; `checkpoint` puts the
    // guard on it in the running config. The start points below run it before Payload answers anything in every start
    // mode a later plugin leaves them in, and the first one wraps the database adapter object, which Payload keeps
    // across a dev reload, so a reload is checked too. A throw refuses the start.
    const host = config.db as { init?: (args: { payload: Payload }) => unknown } | undefined
    const db =
      !opts.disabled && host && typeof host.init === 'function'
        ? {
            ...host,
            init: (args: { payload: Payload }) => {
              ensureGuarded(args.payload, opts, guard)
              const adapter = host.init!(args)
              anchorAdapter(args.payload, adapter, opts, guard)
              return adapter
            },
          }
        : host
    // Payload calls the key-value store's `init` on every start, right after the adapter's, also when a later plugin
    // replaced the adapter and `onInit` is off. With no store set by the host this is the one Payload would add itself,
    // with its collection. A proxy, so a store that keeps members on its prototype or in private fields keeps them.
    const hostKv: KVAdapterResult = config.kv ?? databaseKVAdapter()
    const kvInit: KVAdapterResult['init'] = (args) => {
      checkpoint(args.payload, opts, guard)
      return hostKv.init(args)
    }
    const kv: KVAdapterResult | undefined = opts.disabled ? config.kv : new Proxy(hostKv, { get: (t, k) => (k === 'init' ? kvInit : Reflect.get(t, k, t)) })
    // Payload loads the email adapter on every start after connecting, so a host's adapter is another start point.
    // With none set, Payload's own console adapter stays.
    const hostEmail = config.email
    const withInstall = (adapter: EmailAdapter): EmailAdapter => (args) => {
      checkpoint(args.payload, opts, guard)
      return adapter(args)
    }
    const email: Config['email'] =
      opts.disabled || !hostEmail ? hostEmail : hostEmail instanceof Promise ? hostEmail.then(withInstall) : withInstall(hostEmail)
    // The graph revision document must exist before the first parentage write: two transactions
    // that each create it would not conflict, so concurrent writes could both commit.
    const onInit: Config['onInit'] = async (payload) => {
      await config.onInit?.(payload)
      if (opts.disabled) return
      checkpoint(payload, opts, guard)
      // Retried: on a fresh database this can race other startup writes creating the same
      // MongoDB collection (a transient transaction error). Startup is never blocked by it.
      for (let attempt = 1; attempt <= 5; attempt++)
        try {
          const current = (await payload.findGlobal({ slug: opts.graphGlobal as never, depth: 0, overrideAccess: true })) as { revision?: number; createdAt?: string }
          if (!current?.createdAt)
            await payload.updateGlobal({ slug: opts.graphGlobal as never, data: { revision: current?.revision ?? 0 } as never, overrideAccess: true, context: { onepedigreeInternal: true } })
          return
        } catch (error) {
          if (attempt === 5) payload.logger.error({ err: error }, 'OnePedigree: could not create the pedigree graph revision document; it is created on the next start')
          else await new Promise((r) => setTimeout(r, 200 * attempt))
        }
    }
    return { ...config, ...(db ? { db: db as never } : {}), ...(kv ? { kv } : {}), ...(email ? { email } : {}), collections, globals, onInit, custom: { ...config.custom, onepedigree: opts } }
  }
