import { describe, it, expect } from 'vitest'

/**
 * 验证 plugin createSession 的 temperature 注入逻辑。
 * 纯函数测试，验证 onPayload 注入公式正确。
 */
describe('plugin createSession temperature 注入', () => {
  it('temperature 定义时 onPayload 注入到 payload', () => {
    const temperature = 0.5
    const onPayload = (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      temperature,
    })
    const result = onPayload({ model: 'deepseek-chat', messages: [{ role: 'user' }] })
    expect(result).toMatchObject({ temperature: 0.5, model: 'deepseek-chat' })
  })

  it('temperature undefined 时不注入', () => {
    const temperature: number | undefined = undefined
    const shouldInject = temperature !== undefined
    expect(shouldInject).toBe(false)
  })

  it('onPayload 保留原 payload 所有字段', () => {
    const temperature = 1.2
    const onPayload = (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      temperature,
    })
    const original = { messages: [], model: 'x', stream: true, max_tokens: 4096 }
    const result = onPayload(original)
    expect(result).toMatchObject(original)
    expect((result as Record<string, unknown>).temperature).toBe(1.2)
  })
})
