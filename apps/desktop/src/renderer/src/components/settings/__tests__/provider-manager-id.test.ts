/**
 * provider-manager Provider ID 与旧缓存迁移逻辑测试
 *
 * 核心回归场景：新增 Provider 必须分配与名称无关的唯一 ID；
 * 旧版缓存中的名称派生 ID 需要和后端记录合并，否则会渲染成两条且无法正确删除。
 */
import { describe, expect, it } from 'vitest'
import {
  deriveProviderId,
  ensureUniqueProviderId,
  generateProviderId,
  reconcileLocalProviders,
} from '../provider-manager'

describe('generateProviderId', () => {
  it('生成与 Provider 名称无关的唯一 ID', () => {
    const id = generateProviderId(new Set(['provider-existing']))
    expect(id).toMatch(/^provider-/)
    expect(id).not.toBe('OpenAI')
    expect(id).not.toBe('openai')
    expect(id).not.toBe('deepseek')
  })
})

describe('reconcileLocalProviders', () => {
  it('将旧版名称派生 ID 的本地缓存合并到后端 Provider', () => {
    const local = {
      id: 'openai',
      name: 'OpenAI',
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-local-key',
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    }
    const backend = {
      id: 'provider-550e8400-e29b-41d4-a716-446655440000',
      name: 'OpenAI',
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    }

    const result = reconcileLocalProviders([local], [backend])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(backend.id)
    expect(result[0].apiKey).toBe(local.apiKey)
  })
})

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
