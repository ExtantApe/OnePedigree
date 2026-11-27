import { describe, it } from 'vitest'

import { firstQueryOnLateCollection } from './guard-late-install-first-query.shared'

describe('late install (first query on a late collection: find)', () => {
  it('refuses a find through a hidden parent before any guarded operation has run', async () => {
    await firstQueryOnLateCollection((c, v) => c.lf('notes', { 'animal.dam': { equals: v } }))
  })
})
