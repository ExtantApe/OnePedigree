import { describe, expect, it } from 'vitest'

import { startFixture } from './differential.fixture'

/** The guard goes on collections and globals that a plugin added after OnePedigree, whichever way Payload starts. */
describe('late install (locked)', () => {
  it('refuses to start when the guard can not be put on a collection', async () => {
    await expect(startFixture('omit', { lockedLate: true })).rejects.toThrow(/OnePedigree: could not guard collection "locked"/)
  })
})
