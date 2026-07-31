/**
 * Anthropic 风格 cache_control 的适用性判定
 *
 * 这个判定是为了修一个把命中率越"优化"越低的问题：`applyCacheBreakpoints`
 * 原本无条件把消息 `content` 从字符串改写成带 `cache_control` 的 blocks 数组。
 * 但只有 Anthropic 系认这套协议；DeepSeek / OpenAI 等用的是**自动前缀缓存**，
 * 要求前缀逐字节稳定，改写序列化形态反而把本来能命中的缓存打掉。
 *
 * 口径必须与 pi-ai 的 `detectCompat` 一致（它只在 openrouter + anthropic/* 时
 * 置 cacheControlFormat='anthropic'），否则两处判断分叉会更难排查。
 */
import { describe, it, expect } from 'vitest'
import {
  supportsAnthropicCacheControl,
  usesOpenAiPromptCacheKey,
  buildPromptCacheKey,
} from '../core/plugin/cache-control-support.js'

describe('supportsAnthropicCacheControl：支持的目标', () => {
  it('Anthropic 原生 provider', () => {
    expect(supportsAnthropicCacheControl({ provider: 'anthropic' })).toBe(true)
  })

  it('Vertex / Bedrock 变体', () => {
    expect(supportsAnthropicCacheControl({ provider: 'anthropic-vertex' })).toBe(true)
    expect(supportsAnthropicCacheControl({ provider: 'anthropic-bedrock' })).toBe(true)
  })

  it('provider 名自定义但 baseUrl 指向 Anthropic 官方端点', () => {
    // 用户可以给 provider 起任意名字，不能只看名字
    expect(supportsAnthropicCacheControl({
      provider: 'my-claude',
      baseUrl: 'https://api.anthropic.com/v1',
    })).toBe(true)
  })

  it('OpenRouter 转发 anthropic/* 模型', () => {
    expect(supportsAnthropicCacheControl({
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    })).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(supportsAnthropicCacheControl({ provider: 'Anthropic' })).toBe(true)
    expect(supportsAnthropicCacheControl({
      provider: 'OpenRouter',
      modelId: 'Anthropic/Claude-Sonnet-4',
    })).toBe(true)
  })
})

describe('supportsAnthropicCacheControl：不支持的目标（用自动前缀缓存）', () => {
  it('DeepSeek —— 实测项目用的 provider，此前被错误地打了断点', () => {
    expect(supportsAnthropicCacheControl({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-chat',
    })).toBe(false)
  })

  it('OpenAI 官方', () => {
    expect(supportsAnthropicCacheControl({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4.1',
    })).toBe(false)
  })

  it('OpenRouter 转发非 Anthropic 模型', () => {
    // 同一个 provider 下按模型区分，不能一概而论
    expect(supportsAnthropicCacheControl({
      provider: 'openrouter',
      modelId: 'openai/gpt-4.1',
    })).toBe(false)
  })

  it('第三方中转网关', () => {
    expect(supportsAnthropicCacheControl({
      provider: 'custom',
      baseUrl: 'https://fastaitoken.com/v1',
      modelId: 'claude-sonnet-4',
    })).toBe(false)
  })

  it('模型名里带 claude 但端点不是 Anthropic —— 不能靠模型名猜协议', () => {
    expect(supportsAnthropicCacheControl({
      provider: 'some-relay',
      baseUrl: 'https://relay.example.com/v1',
      modelId: 'claude-3-5-sonnet',
    })).toBe(false)
  })
})

describe('supportsAnthropicCacheControl：信息缺失时保守处理', () => {
  it('完全没有标识时返回 false —— 宁可不打断点，也不要破坏自动前缀缓存', () => {
    expect(supportsAnthropicCacheControl({})).toBe(false)
  })

  it('只有 modelId 也不足以判定', () => {
    expect(supportsAnthropicCacheControl({ modelId: 'anthropic/claude-sonnet-4' })).toBe(false)
  })

  it('undefined 字段不抛错', () => {
    expect(() => supportsAnthropicCacheControl({
      provider: undefined,
      modelId: undefined,
      baseUrl: undefined,
    })).not.toThrow()
  })
})

describe('usesOpenAiPromptCacheKey', () => {
  it('OpenAI 官方端点使用 prompt_cache_key 路由', () => {
    expect(usesOpenAiPromptCacheKey({ baseUrl: 'https://api.openai.com/v1' })).toBe(true)
  })

  it('其他端点不发这个字段 —— 网关可能不认识，发了是多余参数', () => {
    expect(usesOpenAiPromptCacheKey({ baseUrl: 'https://api.deepseek.com/v1' })).toBe(false)
    expect(usesOpenAiPromptCacheKey({ baseUrl: 'https://api.anthropic.com' })).toBe(false)
    expect(usesOpenAiPromptCacheKey({})).toBe(false)
  })
})

describe('buildPromptCacheKey：让共享前缀的调用命中同一台机器', () => {
  it('同一章的多次调用得到同一个键', () => {
    // 这是修复的核心：此前每次 runAgent 新建 session → 随机 sessionId 作为
    // prompt_cache_key，同一章的 Director/Writer/Reviewer 各被导到不同机器，
    // 明明共享 system + shared 前缀却完全命中不了。
    const a = buildPromptCacheKey('novel:proj-1:10')
    const b = buildPromptCacheKey('novel:proj-1:10')
    expect(a).toBe(b)
  })

  it('不同章得到不同键 —— shared 段按章构建，跨章前缀本就不同', () => {
    expect(buildPromptCacheKey('novel:proj-1:10')).not.toBe(buildPromptCacheKey('novel:proj-1:11'))
  })

  it('不同项目互不干扰', () => {
    expect(buildPromptCacheKey('novel:proj-1:10')).not.toBe(buildPromptCacheKey('novel:proj-2:10'))
  })

  it('非法字符被规范化', () => {
    expect(buildPromptCacheKey('novel:项目 A/第 10 章')).toMatch(/^[a-zA-Z0-9_:-]+$/)
  })

  it('超长 scope 截断到 64 字符（OpenAI 上限）', () => {
    const key = buildPromptCacheKey('novel:' + 'x'.repeat(200))
    expect(key.length).toBe(64)
  })

  it('截断后仍保持确定性', () => {
    const scope = 'novel:' + 'x'.repeat(200)
    expect(buildPromptCacheKey(scope)).toBe(buildPromptCacheKey(scope))
  })
})
