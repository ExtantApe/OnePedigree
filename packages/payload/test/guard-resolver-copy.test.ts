import { describe, expect, it, vi } from 'vitest'

// A Payload whose path resolver returns copies of the field objects instead of the objects themselves.
vi.mock('payload', async (original) => {
  const real = await original<typeof import('payload')>()
  return { ...real, getLocalizedPaths: (a: never) => (real.getLocalizedPaths(a) as { field?: object }[]).map((e) => (e.field ? { ...e, field: { ...e.field } } : e)) }
})

describe('resolver self-check', () => {
  it('refuses to start when the resolver returns copies, which would let every filter through', async () => {
    const { startFixture } = await import('./differential.fixture')
    await expect(startFixture('omit')).rejects.toThrow(/path resolver didn't return the guarded field/)
  })
})
