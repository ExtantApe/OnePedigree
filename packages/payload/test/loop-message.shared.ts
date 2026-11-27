import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LOOP_MESSAGE } from '../src/integrity'
import { startFixture, type Ctx, type Mode } from './differential.fixture'

/** A loop is refused with one message, whether or not the family line runs through a record the editor can't read. */
export function loopMessageTests(mode: Mode) {
  describe(`loop message (${mode})`, () => {
    let c: Ctx
    const mk = async (name: string, data: object) => String((await c.payload.create({ collection: 'animals', data: { name, ...data } as never })).id)
    let x = '', cc = '', cc2 = '', x2 = ''
    beforeAll(async () => {
      c = await startFixture(mode)
      x = await mk('LX', {})
      const hidden = await mk('LH', { visibility: 'private', dam: x })
      cc = await mk('LC', { dam: hidden })
      x2 = await mk('LX2', {})
      cc2 = await mk('LC2', { dam: x2 })
    })
    afterAll(async () => {
      await c?.stop()
    })

    const validate = async (id: string, parent: string) => {
      const r = await c.call(`/animals/${id}/pedigree/validate`, { method: 'POST', body: JSON.stringify({ parents: [{ individual: parent, role: 'mother' }] }) })
      return (r.body as { issues?: { code: string; message: string; relatedIds?: string[] }[] }).issues ?? []
    }
    const local = async (id: string, parent: string) => {
      const e = (await c.payload.update({ collection: 'animals', id, data: { dam: parent } as never, ...c.as(), depth: 0 }).catch((x) => x)) as { data?: { errors?: { message: string }[] } }
      return JSON.stringify(e.data?.errors ?? e)
    }

    it('REST: same code and words through a hidden record and through a visible one, and no hidden id', async () => {
      const hiddenLine = await validate(x, cc)
      const visibleLine = await validate(x2, cc2)
      for (const issues of [hiddenLine, visibleLine]) {
        expect(issues.map((i) => i.code)).toEqual(['PARENT_IS_DESCENDANT'])
        expect(issues[0]!.message).toBe(LOOP_MESSAGE)
      }
      expect(JSON.stringify(hiddenLine)).not.toContain(c.id.H!)
      expect(hiddenLine[0]!.relatedIds).toEqual([cc])
    })

    it('Local: the refusal carries the same words either way', async () => {
      const a = await local(x, cc)
      const b = await local(x2, cc2)
      expect(a).toContain(LOOP_MESSAGE)
      expect(b).toContain(LOOP_MESSAGE)
    })

    it('says exactly what the owner approved', () => {
      expect(LOOP_MESSAGE).toBe('This animal can’t be a parent here, because it already descends from this animal in the family line. Some of that line may belong to records you can’t see.')
    })
  })
}
