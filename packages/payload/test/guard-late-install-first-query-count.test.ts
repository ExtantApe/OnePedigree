import { describe, it } from 'vitest'

import { firstQueryOnLateCollection } from './guard-late-install-first-query.shared'

describe('late install (first query on a late collection: count)', () => {
  it('refuses a count through a hidden parent before any guarded operation has run', async () => {
    await firstQueryOnLateCollection((c, v) => c.lc('notes', { 'animal.dam': { equals: v } }))
  })
})
