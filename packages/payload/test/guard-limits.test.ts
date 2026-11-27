import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startFixture, type Ctx } from './differential.fixture'

describe('guard limits fail closed', () => {
  let c: Ctx
  beforeAll(async () => {
    c = await startFixture('omit')
  })
  afterAll(async () => {
    await c?.stop()
  })

  const refusal = (e: unknown) => /can’t be filtered or sorted/.test((e as Error).message)
  const nest = (depth: number): object => {
    let w: object = { name: { equals: 'kid' } }
    for (let i = 0; i < depth; i++) w = { and: [w] }
    return w
  }

  it('refuses a key of more than 100 segments, and one of more than 8 hops', async () => {
    await expect(c.lf('animals', { [Array(101).fill('a').join('.')]: { equals: 'x' } })).rejects.toSatisfy(refusal)
    await expect(c.lf('animals', { [`${Array(9).fill('mate').join('.')}.name`]: { equals: 'x' } })).rejects.toSatisfy(refusal)
  })

  it('accepts ordinary nesting and refuses nesting deeper than 32', async () => {
    expect((await c.lf('animals', nest(10))).totalDocs).toBe(1)
    await expect(c.lf('animals', nest(40))).rejects.toSatisfy(refusal)
  })

  it('refuses a where that contains itself instead of overflowing the stack', async () => {
    const loop: Record<string, unknown> = {}
    loop.and = [loop]
    await expect(c.lf('animals', loop)).rejects.toSatisfy(refusal)
  })

  it('resolves a where of about 10,000 characters quickly', async () => {
    const where = { or: Array.from({ length: 250 }, (_, i) => ({ 'clutch.name': { equals: `clutch-number-${i}-padding-padding` } })) }
    expect(JSON.stringify(where).length).toBeGreaterThan(10_000)
    const t = performance.now()
    await c.lf('animals', where)
    expect(performance.now() - t).toBeLessThan(2000)
  })

  it('refuses a hidden field by the guard, not only by Payload', async () => {
    await expect(c.lf('animals', { internalNote: { equals: 'x' } })).rejects.toSatisfy(refusal)
  })

  it('refuses a key that resolves nowhere, so a future Payload that stops rejecting it stays closed', async () => {
    await expect(c.lf('animals', { 'no.such.field': { equals: 'x' } })).rejects.toSatisfy(refusal)
  })
})
