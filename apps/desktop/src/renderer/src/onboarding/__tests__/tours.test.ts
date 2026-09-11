import { describe, it, expect } from 'vitest'
import { tours } from '../tours'

describe('tours 配置完整性', () => {
  const tourIds = [
    'home-tour',
    'novel-tour',
    'chat-tour',
    'settings-tour',
    'shortcuts-tour',
    'canvas-tour'
  ] as const

  for (const id of tourIds) {
    describe(`${id}`, () => {
      it('存在于 tours registry', () => {
        expect(tours[id]).toBeDefined()
      })

      it('id 与 key 匹配', () => {
        expect(tours[id].id).toBe(id)
      })

      it('每个步骤必须有 description', () => {
        for (const step of tours[id].steps) {
          expect(step.description, `步骤 description 不能为空`).toBeTruthy()
          expect(typeof step.description).toBe('string')
        }
      })

      it('若步骤有 element，必须是合法 selector 字符串', () => {
        for (const step of tours[id].steps) {
          if (step.element !== undefined) {
            expect(step.element.length).toBeGreaterThan(0)
            expect(step.element).toMatch(/^\[|^#|^\./)
          }
        }
      })
    })
  }
})
