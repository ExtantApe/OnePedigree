import { describe, expect, it } from 'vitest'

import { startFixture } from './differential.fixture'
import { guarded, probe } from './guard-late-install.shared'

/** The guard goes on collections and globals that a plugin added after OnePedigree, whichever way Payload starts. */
describe('late install (replaced-db)', () => {
  it('a later plugin that replaces the database adapter, with onInit off, is guarded from the first operation', async () => {
    const c = await startFixture('omit', { disableOnInit: true, replaceDb: true })
    try {
      await probe(c)
      expect(guarded(c, 'notes')).toBe(true)
    } finally {
      await c.stop()
    }
  })
})
