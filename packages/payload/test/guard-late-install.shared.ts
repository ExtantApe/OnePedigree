import { expect } from 'vitest'

import type { Ctx } from './differential.fixture'

export const guarded = (c: Ctx, slug: string) => {
  const list = (c.payload.config.collections.find((x) => x.slug === slug)?.hooks?.beforeOperation ?? []) as unknown[]
  return list.length > 0
}
export const probe = async (c: Ctx) => {
  for (const q of ['animal.dam', 'animal__dam', 'animal.clutch.mother']) {
    const p = await c.pair((v) => c.call(`/notes?depth=0&where[${q}][equals]=${v}`))
    expect(p.equal, `${q}: ${JSON.stringify(p)}`).toBe(true)
  }
}
