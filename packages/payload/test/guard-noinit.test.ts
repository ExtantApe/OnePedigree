import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startFixture, type Ctx } from './differential.fixture'

/**
 * Payload can be started with `disableOnInit` (build steps and some serverless setups). OnePedigree's onInit pass,
 * which guards collections and globals added by plugins that run after it, is skipped there. The collection the later
 * plugin adds is the case that matters, so it is checked on its own.
 */
describe('guard without onInit', () => {
  let c: Ctx
  beforeAll(async () => {
    c = await startFixture('omit', { disableOnInit: true })
  })
  afterAll(async () => {
    await c?.stop()
  })

  it('answers a hidden id like a made-up id on a collection a later plugin added', async () => {
    for (const q of ['animal.dam', 'animal__dam', 'animal.clutch.mother']) {
      const p = await c.pair((v) => c.call(`/notes?depth=0&where[${q}][equals]=${v}`))
      expect(p.equal, `${q}: ${JSON.stringify(p)}`).toBe(true)
    }
  })

  it('answers a hidden id like a made-up id on a global version read', async () => {
    const p = await c.pair((v) => c.call(`/globals/featured/versions?depth=0&where[version.herd][contains][dam][equals]=${v}`))
    expect(p.equal, JSON.stringify(p)).toBe(true)
  })
})
