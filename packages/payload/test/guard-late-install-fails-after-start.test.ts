import { describe, expect, it } from 'vitest'

import { startFixture } from './differential.fixture'

/** The guard goes on collections and globals that a plugin added after OnePedigree, whichever way Payload starts. */
describe('late install (fails-after-start)', () => {
  it('refuses to answer when the install fails after start', async () => {
    const c = await startFixture('omit')
    try {
      const notes = c.payload.config.collections.find((x) => x.slug === 'notes')!
      notes.hooks = { beforeOperation: Object.freeze([]) as never } as never
      c.payload.config = { ...c.payload.config } as never
      // The next operation on any guarded collection notices that the running config isn't installed, and refuses.
      await expect(c.lf('animals', { name: { equals: 'x' } })).rejects.toThrow(/could not guard collection "notes"/)
    } finally {
      await c.stop()
    }
  })
})
