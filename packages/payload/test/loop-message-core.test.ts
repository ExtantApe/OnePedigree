import { validateParentageChange, indexPedigree } from '@extantape/onepedigree-core'
import { describe, expect, it } from 'vitest'

import { LOOP_MESSAGE } from '../src/integrity'

describe('loop message wording', () => {
  it('core says the same words as the Payload package', () => {
    const index = indexPedigree({ individuals: [{ id: 'a', parentage: { parents: [] } }, { id: 'b', parentage: { parents: [{ individual: 'a', role: 'mother' }] } }] } as never)
    const r = validateParentageChange(index, 'a', [{ individual: 'b', role: 'mother' }])
    const loop = r.issues.filter((i) => i.code === 'PARENT_IS_DESCENDANT')
    expect(loop).toHaveLength(1)
    expect(loop[0]!.message).toBe(LOOP_MESSAGE)
  })
})
