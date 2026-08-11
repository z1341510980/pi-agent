/**
 * mapToSdkModel 映射逻辑单元测试
 *
 * 验证 ProviderModelConfig → pi-ai SDK Model 的字段映射规则：
 * - vision → input 数组追加 'image'
 * - supportedReasoningEfforts → thinkingLevelMap（键值都设为档位名）
 * - allowDisableThinking → thinkingLevelMap 追加 'off' 键
 * - thinkingFormat → compat.thinkingFormat
 * - 缺省值兜底（cost/cacheRead/cacheWrite/contextWindow/maxTokens）
 */
import { describe, expect, it } from 'vitest'
import { mapToSdkModel } from '../routes/provider.route.js'

describe('mapToSdkModel：基础映射', () => {
  it('最小必填字段映射正确', () => {
    const sdk = mapToSdkModel({ id: 'm1', name: 'M1' })
    expect(sdk.id).toBe('m1')
    expect(sdk.name).toBe('M1')
    expect(sdk.reasoning).toBe(false)
    expect(sdk.input).toEqual(['text'])
    expect(sdk.contextWindow).toBe(32768)
    expect(sdk.maxTokens).toBe(8192)
    expect(sdk.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(sdk.thinkingLevelMap).toBeUndefined()
    expect(sdk.compat).toBeUndefined()
  })

  it('reasoning 显式为 true 时透传', () => {
    expect(mapToSdkModel({ id: 'm', name: 'M', reasoning: true }).reasoning).toBe(true)
  })
})

describe('mapToSdkModel：vision → input 数组', () => {
  it('vision 为 false 时 input 只有 text', () => {
    expect(mapToSdkModel({ id: 'm', name: 'M', vision: false }).input).toEqual(['text'])
  })

  it('vision 为 true 时 input 包含 image', () => {
    expect(mapToSdkModel({ id: 'm', name: 'M', vision: true }).input).toEqual(['text', 'image'])
  })
})

describe('mapToSdkModel：thinkingLevelMap 构建', () => {
  it('supportedReasoningEfforts 转换为 thinkingLevelMap（键值同名）', () => {
    const sdk = mapToSdkModel({
      id: 'm',
      name: 'M',
      reasoning: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    })
    expect(sdk.thinkingLevelMap).toEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
    })
  })

  it('空数组不生成 thinkingLevelMap', () => {
    const sdk = mapToSdkModel({
      id: 'm',
      name: 'M',
      supportedReasoningEfforts: [],
    })
    expect(sdk.thinkingLevelMap).toBeUndefined()
  })

  it('allowDisableThinking 单独存在时也生成带 off 的 thinkingLevelMap', () => {
    const sdk = mapToSdkModel({
      id: 'm',
      name: 'M',
      allowDisableThinking: true,
    })
    expect(sdk.thinkingLevelMap).toEqual({ off: 'off' })
  })

  it('allowDisableThinking 合并到已有的 thinkingLevelMap', () => {
    const sdk = mapToSdkModel({
      id: 'm',
      name: 'M',
      supportedReasoningEfforts: ['medium', 'high'],
      allowDisableThinking: true,
    })
    expect(sdk.thinkingLevelMap).toEqual({
      medium: 'medium',
      high: 'high',
      off: 'off',
    })
  })
})

describe('mapToSdkModel：compat.thinkingFormat 透传', () => {
  it('thinkingFormat 设置时透传到 compat', () => {
    const sdk = mapToSdkModel({
      id: 'm',
      name: 'M',
      thinkingFormat: 'deepseek',
    })
    expect(sdk.compat).toEqual({ thinkingFormat: 'deepseek' })
  })

  it('未设置时 compat 不存在', () => {
    const sdk = mapToSdkModel({ id: 'm', name: 'M' })
    expect(sdk.compat).toBeUndefined()
  })
})

describe('mapToSdkModel：cost 字段兼容', () => {
  it('cost 缺省时默认为 0/0/0/0', () => {
    expect(mapToSdkModel({ id: 'm', name: 'M' }).cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('cost.cacheRead/cacheWrite 缺省补 0', () => {
    const sdk = mapToSdkModel({
      id: 'm',
      name: 'M',
      cost: { input: 1, output: 2 },
    })
    expect(sdk.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
  })

  it('cost 完整字段原样透传', () => {
    const sdk = mapToSdkModel({
      id: 'm',
      name: 'M',
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    })
    expect(sdk.cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  })
})

describe('mapToSdkModel：业务字段不传给 SDK', () => {
  it('toolCalling / onlyThinking / customProtocol / defaultReasoningEffort 不出现在 SDK 输出', () => {
    const sdk = mapToSdkModel({
      id: 'm',
      name: 'M',
      toolCalling: true,
      onlyThinking: true,
      customProtocol: true,
      defaultReasoningEffort: 'high',
    } as never)
    expect(sdk).not.toHaveProperty('toolCalling')
    expect(sdk).not.toHaveProperty('onlyThinking')
    expect(sdk).not.toHaveProperty('customProtocol')
    expect(sdk).not.toHaveProperty('defaultReasoningEffort')
  })
})