import { expect } from 'vitest'

import { startFixture, type Ctx } from './differential.fixture'
import { guarded } from './guard-late-install.shared'

/**
 * The last gap of the late install: later plugins replace the database adapter and the key-value store, no email
 * adapter is set, Payload starts with `disableOnInit`, and the first operation of the process is on a collection a
 * later plugin added. No OnePedigree code has run yet, so only the first query itself can notice. The data is written through the adapter, so no collection operation (and no
 * guard hook) runs before the query under test. One start per test file: the adapter is replaced in this process.
 */
export async function firstQueryOnLateCollection(run: (c: Ctx, v: string) => Promise<unknown>) {
  const c = await startFixture('omit', { disableOnInit: true, replaceDb: true, replaceKv: true, rawSeed: true })
  try {
    expect(guarded(c, 'notes')).toBe(false) // nothing has installed the guard yet
    const first = await c.safe(() => run(c, c.id.H!)) // the hidden parent, as the first operation of the process
    const second = await c.safe(() => run(c, '64b0000000000000000000aa')) // a made-up id
    expect(JSON.stringify(c.norm(first))).toBe(JSON.stringify(c.norm(second)))
    expect('error' in first, JSON.stringify(first)).toBe(true) // refused, never answered from the data
    expect(guarded(c, 'notes')).toBe(true)
  } finally {
    await c.stop()
  }
}
