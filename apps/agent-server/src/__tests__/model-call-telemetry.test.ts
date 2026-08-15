/**
 * 模型调用遥测纯函数
 *
 * 这些口径是「缓存与监控一体化」的判定基础：
 * - 协议判定必须复用 cache-control-support，不能另起一套；
 * - 命中率 / 覆盖率在数据缺失时返回 null，不把"没上报"算成"命中 0"；
 * - 请求指纹只存摘要，且分层带长度前缀，避免拼接歧义。
 */
import { describe, it, expect } from 'vitest'
import {
  resolveCacheProtocol,
  buildRequestFingerprint,
  cacheHitRate,
  prefixCoverage,
  classifyDataQuality,
} from '../core/observability/model-call-telemetry.js'

describe('resolveCacheProtocol：四类协议分支', () => {
  it('没有任何标识信息时 unknown —— 宁可不判，不要猜错协议', () => {
    expect(resolveCacheProtocol({})).toBe('unknown')
  })

  it('Anthropic 原生 → anthropic-cache-control', () => {
    expect(resolveCacheProtocol({ provider: 'anthropic' })).toBe('anthropic-cache-control')
  })

  it('OpenRouter 转发 anthropic/* 模型 → anthropic-cache-control（口径同 detectCompat）', () => {
    expect(resolveCacheProtocol({
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    })).toBe('anthropic-cache-control')
  })

  it('OpenAI 官方端点 → openai-prompt-cache-key', () => {
    expect(resolveCacheProtocol({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    })).toBe('openai-prompt-cache-key')
  })

  it('DeepSeek 等其余目标 → automatic-prefix', () => {
    expect(resolveCacheProtocol({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-chat',
    })).toBe('automatic-prefix')
  })
})

describe('buildRequestFingerprint：稳定性与区分度', () => {
  const layers = {
    system: '你是一名小说写作总监',
    shared: '世界观设定与人物档案……',
    identity: 'Agent=Director Project=p1 Chapter=10',
    dynamic: '本次任务指令与草稿……',
  }

  it('相同分层得到相同指纹（确定性）', () => {
    expect(buildRequestFingerprint(layers)).toBe(buildRequestFingerprint(layers))
  })

  it('格式为 16 位 hex（sha256 摘要前缀）', () => {
    expect(buildRequestFingerprint(layers)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('dynamic 段变化 → 指纹变化', () => {
    expect(buildRequestFingerprint({ ...layers, dynamic: '改写后的任务指令……' }))
      .not.toBe(buildRequestFingerprint(layers))
  })

  it('shared 段变化 → 指纹变化（前缀不稳定要在指纹上可见）', () => {
    expect(buildRequestFingerprint({ ...layers, shared: '更新后的世界观设定……' }))
      .not.toBe(buildRequestFingerprint(layers))
  })

  it('拼接结果相同但分层切分不同 → 指纹不同（长度前缀消除边界歧义）', () => {
    const a = { system: 'ab', shared: '', identity: '', dynamic: '' }
    const b = { system: 'a', shared: 'b', identity: '', dynamic: '' }
    expect(buildRequestFingerprint(a)).not.toBe(buildRequestFingerprint(b))
  })

  it('全空分层也能产出稳定指纹', () => {
    const empty = { system: '', shared: '', identity: '', dynamic: '' }
    expect(buildRequestFingerprint(empty)).toBe(buildRequestFingerprint(empty))
  })
})

describe('cacheHitRate：实际缓存读取率', () => {
  it('常规计算：cacheRead / (cacheRead + input)', () => {
    // 80 命中 + 20 未命中输入 → 读取率 0.8
    expect(cacheHitRate(80, 20)).toBe(0.8)
  })

  it('没命中但数据齐全 → 0，是真实未命中而不是 null', () => {
    expect(cacheHitRate(0, 100)).toBe(0)
  })

  it('任一数据缺失 → null（不把"没上报"算成"命中 0"）', () => {
    expect(cacheHitRate(null, 100)).toBeNull()
    expect(cacheHitRate(80, null)).toBeNull()
    expect(cacheHitRate(null, null)).toBeNull()
  })

  it('总输入非正 → null（无法定义分母）', () => {
    expect(cacheHitRate(0, 0)).toBeNull()
    expect(cacheHitRate(0, -10)).toBeNull()
  })
})

describe('prefixCoverage：缓存前缀覆盖率', () => {
  it('常规计算：实测 cacheRead / 期望前缀 token', () => {
    expect(prefixCoverage(80, 100)).toBe(0.8)
  })

  it('允许超过 1 —— 期望值是估算，Provider 计数可以更高', () => {
    expect(prefixCoverage(120, 100)).toBe(1.2)
  })

  it('cacheRead 缺失 → null', () => {
    expect(prefixCoverage(null, 100)).toBeNull()
  })

  it('期望值缺失或非正 → null', () => {
    expect(prefixCoverage(80, null)).toBeNull()
    expect(prefixCoverage(80, 0)).toBeNull()
    expect(prefixCoverage(80, -5)).toBeNull()
  })
})

describe('classifyDataQuality：数据质量分级', () => {
  it('四项齐备 → complete', () => {
    expect(classifyDataQuality({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheWriteTokens: 120,
    })).toBe('complete')
  })

  it('有 input 且 cacheRead 在场，output / cacheWrite 缺 → complete（缓存口径已可判）', () => {
    // cacheRead 在场即可判定缓存命中情况，无需 output
    expect(classifyDataQuality({
      inputTokens: 100,
      outputTokens: null,
      cacheReadTokens: 80,
      cacheWriteTokens: null,
    })).toBe('complete')
  })

  it('只有 input，output / cacheRead / cacheWrite 全缺 → partial', () => {
    expect(classifyDataQuality({
      inputTokens: 100,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    })).toBe('partial')
  })

  it('inputTokens 为 null → no_data', () => {
    expect(classifyDataQuality({
      inputTokens: null,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    })).toBe('no_data')
  })

  it('inputTokens 为 0 且 cacheRead 为 null → no_data（输入侧什么都没上报）', () => {
    // 输入侧既无 input 也无 cacheRead，说明 Provider 没上报任何输入 token 证据，
    // 即使 output 有值也无法评估缓存命中情况 → no_data
    expect(classifyDataQuality({
      inputTokens: 0,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    })).toBe('no_data')
  })

  it('input=0 但 cacheRead 在场（Provider 把全部输入计入缓存读）→ complete', () => {
    expect(classifyDataQuality({ inputTokens: 0, outputTokens: null, cacheReadTokens: 80, cacheWriteTokens: null })).toBe('complete')
  })

  it('四项全 0（Provider 无 usage 的失败调用）→ no_data', () => {
    // 失败调用拿不到 usage，落库 ?? 0 后四项全 0 —— 是"没上报"不是"真实为 0"
    expect(classifyDataQuality({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe('no_data')
  })

  it('input=0 且 cacheRead=0 但 output>0 → no_data（输入侧无证据即 no_data）', () => {
    // 推导：noInputEvidence 为真（input=0 且 cacheRead=0）→ no_data。
    // dataQuality 评估的是缓存监控的数据完备性，仅输出侧有 token 无法评估缓存命中
    expect(classifyDataQuality({ inputTokens: 0, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe('no_data')
  })
})
