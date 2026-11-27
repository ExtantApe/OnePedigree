import { describe, expect, it } from 'vitest'

import { startFixture } from './differential.fixture'
import { guarded, probe } from './guard-late-install.shared'

/** The guard goes on collections and globals that a plugin added after OnePedigree, whichever way Payload starts. */
describe('late install (reload)', () => {
  it('after a dev reload, a collection that a later plugin added is guarded again', async () => {
    const c = await startFixture('omit')
    try {
      // What Payload's reload() does to the running instance: a new config object (so no hook from before), then the adapter's init.
      const fresh = c.payload.config.collections.map((x) => (x.slug === 'notes' ? { ...x, hooks: {} as never } : x))
      c.payload.config = { ...c.payload.config, collections: fresh } as never
      ;(c.payload.collections as never as Record<string, { config: unknown }>).notes!.config = fresh.find((x) => x.slug === 'notes')
      expect(guarded(c, 'notes')).toBe(false)
      await c.payload.db.destroy?.()
      await c.payload.db.init?.()
      await c.payload.db.connect?.({ hotReload: true })
      expect(guarded(c, 'notes')).toBe(true)
      await probe(c)
    } finally {
      await c.stop()
    }
  })
})
