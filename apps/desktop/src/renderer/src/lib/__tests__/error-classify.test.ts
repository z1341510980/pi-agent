import { describe, expect, it } from 'vitest'
import { classifyStreamError } from '../error-classify'

/**
 * 分类只能靠消息文本做模式匹配（后端没给结构化错误码），所以这些用例同时
 * 承担两个职责：钉住分类结果，以及记录真实见过的错误文本长什么样。
 */

describe('classifyStreamError', () => {
  it('空消息走兜底且可重试', () => {
    const result = classifyStreamError('')
    expect(result.ownership).toBe('unknown')
    expect(result.retryable).toBe(true)
  })

  describe('鉴权', () => {
    it.each([
      'Request failed with status code 401',
      'Incorrect API key provided: sk-***',
      'invalid_api_key',
      'Authentication failed',
      'API key is missing',
    ])('%s → 模型服务 / 不可重试 / 去设置', (raw) => {
      const result = classifyStreamError(raw)
      expect(result.ownership).toBe('provider')
      expect(result.retryable).toBe(false)
      expect(result.action).toBe('open-settings')
    })

    it('鉴权判定优先于网络：消息里同时带 fetch failed 时也算鉴权', () => {
      const result = classifyStreamError('fetch failed: 401 Unauthorized')
      expect(result.ownership).toBe('provider')
      expect(result.retryable).toBe(false)
    })
  })

  describe('额度与限流', () => {
    it('余额不足 → 不可重试', () => {
      const result = classifyStreamError('You exceeded your current quota, insufficient_quota')
      expect(result.retryable).toBe(false)
      expect(result.action).toBe('open-settings')
    })

    it('429 限流 → 可重试', () => {
      const result = classifyStreamError('Error 429: Rate limit reached')
      expect(result.ownership).toBe('provider')
      expect(result.retryable).toBe(true)
      expect(result.action).toBe('retry')
    })
  })

  describe('上下文超限', () => {
    it.each([
      "This model's maximum context length is 8192 tokens",
      'context_length_exceeded',
      '上下文长度超出限制',
    ])('%s → 应用归属 / 引导去压缩', (raw) => {
      const result = classifyStreamError(raw)
      expect(result.ownership).toBe('app')
      expect(result.retryable).toBe(false)
      expect(result.action).toBe('compact')
    })
  })

  describe('模型不可用', () => {
    it('model not found → 去设置换模型', () => {
      const result = classifyStreamError('The model `gpt-9` does not exist')
      expect(result.ownership).toBe('provider')
      expect(result.action).toBe('open-settings')
    })
  })

  describe('网络', () => {
    it.each(['connect ECONNREFUSED 127.0.0.1:1080', 'fetch failed', 'socket hang up', '网络错误'])(
      '%s → 网络归属 / 可重试',
      (raw) => {
        const result = classifyStreamError(raw)
        expect(result.ownership).toBe('network')
        expect(result.retryable).toBe(true)
      },
    )

    it('超时单独成类但同样归网络', () => {
      const result = classifyStreamError('Request timed out after 60000ms')
      expect(result.ownership).toBe('network')
      expect(result.retryable).toBe(true)
    })
  })

  describe('服务端故障', () => {
    it.each(['502 Bad Gateway', 'Internal Server Error', 'Overloaded'])(
      '%s → 模型服务 / 可重试',
      (raw) => {
        const result = classifyStreamError(raw)
        expect(result.ownership).toBe('provider')
        expect(result.retryable).toBe(true)
      },
    )
  })

  describe('工具与权限', () => {
    it('工具执行失败归 Agent', () => {
      const result = classifyStreamError('Tool execution failed: read_file')
      expect(result.ownership).toBe('agent')
    })

    it('权限被拒归 Agent', () => {
      const result = classifyStreamError('permission denied')
      expect(result.ownership).toBe('agent')
    })
  })

  describe('正文质量门', () => {
    // 质量门未通过不是基础设施故障：重新生成不会让确定性检测消失，
    // 因此必须判为不可重试，避免用户点「重试」整条重跑白烧 token。
    it.each([
      '正文表达质量门修订后仍未通过，已阻止落库',
      '自动修订 2 轮后仍有 1 项表达问题未通过，已阻止落库',
      '修订未成功应用任何修改，已阻止原正文落库',
    ])('%s 判为不可重试，且不给重试入口', (raw) => {
      const result = classifyStreamError(raw)
      expect(result.retryable).toBe(false)
      expect(result.action).toBe('none')
      expect(result.title).toBe('正文质量门未通过')
      expect(result.aborted).toBe(false)
    })

    it('质量门规则优先于服务端 5xx（消息里带数字不应误判为服务故障）', () => {
      const result = classifyStreamError('自动修订 2 轮后仍有 500 字未通过，已阻止落库')
      expect(result.title).toBe('正文质量门未通过')
      expect(result.retryable).toBe(false)
    })
  })

  describe('用户中断', () => {
    it.each(['AbortError: The operation was aborted', 'request cancelled', '用户取消'])(
      '%s 标记为 aborted，不当作错误',
      (raw) => {
        const result = classifyStreamError(raw)
        expect(result.aborted).toBe(true)
        expect(result.retryable).toBe(true)
      },
    )
  })

  it('原始消息始终保留，供技术细节展示', () => {
    const raw = '  Error 429: Rate limit reached  '
    expect(classifyStreamError(raw).raw).toBe('Error 429: Rate limit reached')
  })

  it('认不出来的错误走兜底但仍给重试机会', () => {
    const result = classifyStreamError('something weird happened in the pipeline')
    expect(result.ownership).toBe('unknown')
    expect(result.retryable).toBe(true)
    expect(result.aborted).toBe(false)
  })
})
