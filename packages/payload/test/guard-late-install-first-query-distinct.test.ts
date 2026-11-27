import { describe, it } from 'vitest'

import { firstQueryOnLateCollection } from './guard-late-install-first-query.shared'

describe('late install (first query on a late collection: distinct)', () => {
  it('refuses a distinct through a hidden parent before any guarded operation has run', async () => {
    await firstQueryOnLateCollection((c, v) => c.payload.findDistinct({ collection: 'notes', field: 'animal', where: { 'animal.dam': { equals: v } }, ...c.as() } as never))
  })
})
