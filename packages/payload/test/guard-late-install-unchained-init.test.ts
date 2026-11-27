import { describe, expect, it } from 'vitest'

import { startFixture } from './differential.fixture'
import { probe } from './guard-late-install.shared'

/** The guard goes on collections and globals that a plugin added after OnePedigree, whichever way Payload starts. */
describe('late install (unchained-init)', () => {
  it('a later plugin that replaces the database adapter and drops onInit is guarded too', async () => {
    const c = await startFixture('omit', { replaceDb: true, unchainedInit: true })
    try {
      await probe(c)
    } finally {
      await c.stop()
    }
  })
})
