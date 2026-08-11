/**
 * provider-manager ID 派生与去重逻辑测试
 *
 * 核心回归场景：新增 Provider 时 id 从名称派生（如 openai/deepseek），
 * 若与已有 Provider（尤其默认 Provider）id 冲突，必须去重为 -2/-3 后缀，
 * 否则会触发后端 upsert 语义，意外覆盖已有 Provider 数据。
 */
import { describe, expect, it } from 'vitest'
import { deriveProviderId, ensureUniqueProviderId } from '../provider-manager'

describe('deriveProviderId', () => {
  it('小写化并替换非字母数字为连字符', () => {
    expect(deriveProviderId('OpenAI Custom')).toBe('openai-custom')
    expect(deriveProviderId('DeepSeek')).toBe('deepseek')
    expect(deriveProviderId('  Silicon Flow  ')).toBe('silicon-flow')
  })

  it('去掉首尾连字符', () => {
    expect(deriveProviderId('-My Provider-')).toBe('my-provider')
  })

  it('纯中文等无法派生的名称返回空串', () => {
    expect(deriveProviderId('硅基流动')).toBe('')
  })
})

describe('ensureUniqueProviderId', () => {
  it('无冲突时原样返回', () => {
    expect(ensureUniqueProviderId('openai', new Set(['deepseek']))).toBe('openai')
  })

  it('冲突时追加 -2 后缀', () => {
    expect(ensureUniqueProviderId('openai', new Set(['openai']))).toBe('openai-2')
  })

  it('连续冲突时递增后缀', () => {
    const existing = new Set(['openai', 'openai-2', 'openai-3'])
    expect(ensureUniqueProviderId('openai', existing)).toBe('openai-4')
  })

  it('excludeId 等于 baseId 时视为无冲突（编辑自身场景）', () => {
    const existing = new Set(['openai'])
    expect(ensureUniqueProviderId('openai', existing, 'openai')).toBe('openai')
  })

  it('空串原样返回（由调用方回退随机 id）', () => {
    expect(ensureUniqueProviderId('', new Set(['']))).toBe('')
  })
})
