import { describe, expect, it } from 'vitest'
import { inMemoryKVAdapter, type CollectionConfig, type Payload } from 'payload'

import { startPayload, usersCollection } from './helpers'
import { addsWeighings, animals, clutches, closed, hasGuard, overwritesRead, plugin, read, rebuildAndReload, replaces, start, unchainedInit, type Mode } from './guard-live-config.shared'

/**
 * The guard is checked against the config Payload is running, at query time. A dev reload hands Payload a config built
 * by a new run of every plugin, OnePedigree included, so these tests rebuild the plugin before `reload()` instead of
 * reusing the closure that started.
 */
const STRIPPED: Mode = { replaceDb: true, replaceKv: true, disableOnInit: true }

async function reloadCase(mode: Mode, later = [addsWeighings]) {
  const s = await start(later, mode)
  try {
    closed(await s.filter())
    expect(await s.kidDam()).toBe('null')
    const { error } = await rebuildAndReload(s.payload, later, mode)
    expect(error).toBeNull()
    expect(hasGuard(s.payload, 'weighings')).toBe(true)
    closed(await s.filter())
    expect(await s.kidDam()).toBe('null')
  } finally {
    await s.stop()
  }
}

describe('guard checked against the running config', () => {
  it('a normal start survives a reload with a rebuilt plugin, and the late collection is guarded again', () => reloadCase({}))

  it('a replaced adapter with onInit on stays closed after a reload with a rebuilt plugin', () => reloadCase({ replaceDb: true }))

  it('a replaced adapter with an unchained onInit stays closed after a reload with a rebuilt plugin', () => reloadCase({ replaceDb: true }, [addsWeighings, unchainedInit]))

  it('with the adapter and store replaced, onInit off and the read access overwritten, the field trip point closes the first filter, before and after a reload', async () => {
    const s = await start([overwritesRead], STRIPPED)
    try {
      // The later plugin's own read access is in place, so the collection-level trip point is gone; the field one remains.
      expect(s.payload.config.collections.find((c) => c.slug === 'animals')?.access?.read).toBe(read)
      closed(await s.filter())
      const { error } = await rebuildAndReload(s.payload, [overwritesRead], STRIPPED)
      expect(error).toBeNull()
      closed(await s.filter())
      expect(await s.kidDam()).toBe('null')
    } finally {
      await s.stop()
    }
  })

  it('a reload whose new config lost the redaction refuses every query until restart', async () => {
    const s = await start([addsWeighings])
    try {
      const { error } = await rebuildAndReload(s.payload, [addsWeighings, replaces('animals', animals)])
      expect(error).toMatch(/"animals" is missing or was replaced/)
      const answers = [
        ...Object.values(await s.filter()),
        await s.kidDam(),
        await s.answer(() => s.payload.find({ collection: 'animals' as never, depth: 0, overrideAccess: true })),
        await s.answer(() => s.payload.count({ collection: 'weighings' as never, overrideAccess: true })),
      ]
      for (const a of answers) expect(a).toMatch(/^refused: /)
      for (const a of answers) expect(a).not.toContain(s.id.kid!)
    } finally {
      await s.stop()
    }
  })

  it('a config swapped in without init is refused at the adapter until it has been guarded', async () => {
    const s = await start([addsWeighings])
    try {
      // A new config object whose late collection has no hooks, put in place without any start hook running.
      const bare = s.payload.config.collections.map((c) => (c.slug === 'weighings' ? { ...c, hooks: {} as never } : c))
      s.payload.config = { ...s.payload.config, collections: bare } as never
      ;(s.payload.collections as never as Record<string, { config: unknown }>).weighings!.config = bare.find((c) => c.slug === 'weighings')
      expect(hasGuard(s.payload, 'weighings')).toBe(false)
      const first = await s.answer(() => s.payload.db.find({ collection: 'weighings', where: { 'animal.dam': { equals: s.id.H } } as never }))
      expect(first).toMatch(/^refused: /)
      // That refusal guarded the new config; the usual guard now answers the filter.
      expect(hasGuard(s.payload, 'weighings')).toBe(true)
      closed(await s.filter())
    } finally {
      await s.stop()
    }
  })

  it('a key-value store given as a class instance keeps its prototype members and private state', async () => {
    class HostKv {
      #inits = 0
      get kvCollection(): CollectionConfig {
        return { slug: 'kv-store', fields: [{ name: 'key', type: 'text' }] }
      }
      get inits() {
        return this.#inits
      }
      init({ payload }: { payload: Payload }) {
        this.#inits += 1
        return inMemoryKVAdapter().init({ payload })
      }
    }
    const kv = new HostKv()
    const { payload, stop } = await startPayload({ collections: [usersCollection, animals(), clutches()], plugins: [plugin()], kv: kv as never })
    try {
      expect(kv.inits).toBe(1)
      expect(payload.collections['kv-store' as never]).toBeDefined()
      expect(hasGuard(payload, 'kv-store')).toBe(true)
      await payload.kv.set('k', { v: 1 })
      expect(await payload.kv.get('k')).toEqual({ v: 1 })
    } finally {
      await stop()
    }
  })

  it('limit: with every start point replaced and the individuals collection replaced wholesale, a late filter runs no plugin code', async () => {
    // Stated in the README. Nothing of the plugin is left in the running process here, so there is nothing to refuse with.
    const s = await start([addsWeighings, replaces('animals', animals)], STRIPPED)
    try {
      const r = await s.filter()
      expect(r.hidden).not.toBe(r.made)
    } finally {
      await s.stop()
    }
  })
})
