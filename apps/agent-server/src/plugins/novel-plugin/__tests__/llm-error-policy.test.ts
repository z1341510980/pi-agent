/**
 * LLM 失败分类与重试策略
 *
 * 分类表直接对应真实项目 272 条 `novel_agent_logs` 里统计出的 Director 29 次失败，
 * 用例按那份分布逐条钉住 —— 分错一类的代价不对称：
 *   - 把账户类误判为可重试 → 余额不足时空转 4 次调用，用户等 17 秒才看到错误
 *   - 把瞬时误判为不可重试 → 一次 502 废掉整个 create-flow（这正是修复前的行为）
 *   - 把用户取消误判为可重试 → 用户按了「停止」，系统还要再打 3 次 LLM
 */
import { describe, it, expect } from 'vitest'
import {
  classifyLlmFailure,
  retryDelayMs,
  LLM_MAX_RETRIES,
  LLM_RETRY_DELAYS_MS,
} from '../core/quality/llm-error-policy.js'

describe('classifyLlmFailure：瞬时故障（实测占 Director 失败的 23/29）', () => {
  const transientMessages = [
    '502 status code (no body)',
    '503 Service temporarily unavailable',
    'Request timed out',
    'LLM 调用超时（120s）',
    'LLM 调用超时（300s）',
    'Stream ended without finish_reason',
    'terminated',
    'TypeError: terminated',
    'LLM 调用失败: terminated，provider: terminated',
    'premature close',
    'fetch failed',
    'socket hang up',
    'read ECONNRESET',
    '429 Too Many Requests',
  ]

  for (const message of transientMessages) {
    it(`可重试：${message}`, () => {
      const result = classifyLlmFailure(new Error(message))
      expect(result.kind).toBe('transient')
      expect(result.retryable).toBe(true)
      // 瞬时错误不需要打扰用户，重试成功就当没发生过
      expect(result.userMessage).toBeNull()
    })
  }

  it('状态码挂在 error.status 而非 message 上也能识别', () => {
    const err = Object.assign(new Error('upstream failure'), { status: 503 })
    expect(classifyLlmFailure(err).retryable).toBe(true)
  })
})

/**
 * 2026-09-30 回归：第 6 章 create-flow 在 Director 阶段被
 * `LLM 调用失败: Connection error.` 整章作废。
 *
 * Pi SDK 自己的 `utils/retry.js` 把 `connection error` 视为可重试并试了 3 次，
 * 但我们的分类器不认识这个词形 → `unknown` → 应用层一次都不补，
 * 于是「SDK 重试耗尽」直接等于「整章失败」。这一组用例把 SDK 白名单里
 * 我们曾经漏掉的词形钉住，防止再次断档。
 */
describe('classifyLlmFailure：连接层与网关词形（与 pi-ai retry.js 同口径）', () => {
  const connectionMessages = [
    'LLM 调用失败: Connection error.',
    'Connection error.',
    'connect ECONNREFUSED 127.0.0.1:443',
    'connection lost before response',
    'other side closed',
    'socket connection was closed unexpectedly',
    'upstream connect error or disconnect/reset before headers',
    'HTTP/2 request did not get a response',
    'Provider returned error',
    'Anthropic stream ended before message_stop',
    'The server is overloaded, please try again',
    'Internal server error',
    'getaddrinfo ENOTFOUND api.example.com',
    'You can retry your request later',
  ]

  for (const message of connectionMessages) {
    it(`可重试：${message}`, () => {
      const result = classifyLlmFailure(new Error(message))
      expect(result.kind).toBe('transient')
      expect(result.retryable).toBe(true)
    })
  }

  it('连接层词形不会抢走账户类判定', () => {
    const result = classifyLlmFailure(new Error('402 Insufficient Balance: connection error'))
    expect(result.kind).toBe('account')
    expect(result.retryable).toBe(false)
  })
})

describe('classifyLlmFailure：账户类（重试无用，必须立刻告诉用户）', () => {
  it('402 余额不足 → 明确提示充值', () => {
    const result = classifyLlmFailure(new Error('402 Insufficient Balance'))
    expect(result.kind).toBe('account')
    expect(result.retryable).toBe(false)
    expect(result.userMessage).toContain('余额不足')
  })

  it('401 无效 key → 指向设置页', () => {
    const result = classifyLlmFailure(new Error('401 Invalid API key provided'))
    expect(result.kind).toBe('account')
    expect(result.retryable).toBe(false)
    expect(result.userMessage).toContain('API Key')
  })

  it('403 无权限 → 提示检查模型访问权限', () => {
    const result = classifyLlmFailure(new Error('403 Forbidden'))
    expect(result.kind).toBe('account')
    expect(result.userMessage).toContain('权限')
  })

  it('账户类优先于瞬时匹配：402 响应体里带 service 也不会被判成可重试', () => {
    const result = classifyLlmFailure(
      new Error('402 Insufficient Balance - service will resume after top-up'),
    )
    expect(result.kind).toBe('account')
    expect(result.retryable).toBe(false)
  })
})

describe('classifyLlmFailure：会话消息不成对（pi-session 侧缺陷）', () => {
  it('tool_calls 未配对 → 快速失败而非静默重试', () => {
    const result = classifyLlmFailure(
      new Error("400 An assistant message with 'tool_calls' must be followed by tool messages"),
    )
    expect(result.kind).toBe('malformed_session')
    expect(result.retryable).toBe(false)
    // 重试同一份不合法消息必然再失败；伪装成瞬时错误会把缺陷掩盖成"偶发抖动"
    expect(result.userMessage).toContain('工具调用')
  })

  it('messages 字段缺失同样归此类', () => {
    const result = classifyLlmFailure(
      new Error('400 Failed to deserialize the JSON body: missing field `messages`'),
    )
    expect(result.kind).toBe('malformed_session')
    expect(result.retryable).toBe(false)
  })
})

describe('classifyLlmFailure：aborted 的双重含义', () => {
  it('用户主动取消 → 不重试（否则按了停止还会再打 3 次 LLM）', () => {
    const result = classifyLlmFailure(new Error('Request was aborted'), true)
    expect(result.kind).toBe('aborted_by_user')
    expect(result.retryable).toBe(false)
  })

  it('非用户取消的 abort → 视作上游连接中断，可重试', () => {
    const result = classifyLlmFailure(new Error('Request was aborted'), false)
    expect(result.kind).toBe('transient')
    expect(result.retryable).toBe(true)
  })

  it('userAborted 优先于一切 message 匹配（含账户类）', () => {
    const result = classifyLlmFailure(new Error('402 Insufficient Balance'), true)
    expect(result.kind).toBe('aborted_by_user')
    expect(result.userMessage).toBeNull()
  })
})

describe('classifyLlmFailure：未识别错误保守处理', () => {
  it('陌生错误不重试，由调用方回退到原始 message', () => {
    const result = classifyLlmFailure(new Error('某个前所未见的错误'))
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
    expect(result.userMessage).toBeNull()
  })

  it('非 Error 抛出物也能分类', () => {
    expect(classifyLlmFailure('503 Service Unavailable').retryable).toBe(true)
    expect(classifyLlmFailure(null).kind).toBe('unknown')
  })
})

describe('retryDelayMs：指数退避', () => {
  it('1s / 4s / 12s', () => {
    expect(retryDelayMs(1)).toBe(1_000)
    expect(retryDelayMs(2)).toBe(4_000)
    expect(retryDelayMs(3)).toBe(12_000)
  })

  it('超出上限返回 null，表示不再重试', () => {
    expect(retryDelayMs(LLM_MAX_RETRIES + 1)).toBeNull()
  })

  it('非法 attempt 返回 null 而非抛错', () => {
    expect(retryDelayMs(0)).toBeNull()
    expect(retryDelayMs(-1)).toBeNull()
  })

  it('重试上限与退避表长度一致 —— 改一处忘改另一处会静默丢失最后一次重试', () => {
    expect(LLM_RETRY_DELAYS_MS.length).toBe(LLM_MAX_RETRIES)
  })

  it('退避严格递增：等长间隔在网关抖动下容易同时打满上游', () => {
    for (let i = 1; i < LLM_RETRY_DELAYS_MS.length; i += 1) {
      expect(LLM_RETRY_DELAYS_MS[i]).toBeGreaterThan(LLM_RETRY_DELAYS_MS[i - 1])
    }
  })

  it('总退避时长远小于单次 Director 调用（平均 53s），重试才划算', () => {
    const total = LLM_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeLessThan(53_000)
  })
})
