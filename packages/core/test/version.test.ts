import { describe, expect, it } from 'vitest'

import * as entry from '../src/index'
import { CORE_VERSION } from '../src/index'
import pkg from '../package.json'

describe('CORE_VERSION', () => {
  it('equals the version in package.json', () => {
    expect(CORE_VERSION).toBe(pkg.version)
  })

  it('is exported from the package entry as a plain string', () => {
    expect(typeof entry.CORE_VERSION).toBe('string')
    expect(entry.CORE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })

  it('matches the other workspace packages, which release in lockstep', async () => {
    for (const name of ['react', 'payload', 'studbook']) {
      const other = (await import(`../../${name}/package.json`)).default as { version: string }
      expect(other.version, name).toBe(CORE_VERSION)
    }
  })
})
