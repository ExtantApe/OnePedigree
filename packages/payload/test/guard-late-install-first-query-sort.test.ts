import { describe, it } from 'vitest'

import { firstQueryOnLateCollection } from './guard-late-install-first-query.shared'

describe('late install (first query on a late collection: sort)', () => {
  it('refuses a sort through a hidden parent before any guarded operation has run', async () => {
    await firstQueryOnLateCollection((c, v) => c.lf('notes', {}, { sort: 'animal.dam' }))
  })
})
