/**
 * LLM 调用失败的分类与重试策略。
 *
 * ## 为什么需要
 *
 * 实测数据（真实项目 11 章、272 条 `novel_agent_logs`）：Director 共 102 次调用，
 * **29 次失败（28%）**，而 `runAgent` 外层**没有任何重试** —— 一次 502 就要用户
 * 重新触发整个 create-flow，前面几十次成功调用的 token 全部作废。
 *
 * 29 次失败的原因分布：
 *
 * | 次数 | 原因 | 性质 |
 * | --- | --- | --- |
 * | 4 | `402 Insufficient Balance` | 账户：重试无用 |
 * | 1 | `401 Invalid API key` | 账户：重试无用 |
 * | 4 | `Request timed out` | 瞬时 |
 * | 4 | `Request was aborted` | 瞬时（但需与用户主动取消区分） |
 * | 4 | `Stream ended without finish_reason` | 瞬时 |
 * | 3 | `502 status code (no body)` | 瞬时 |
 * | 2 | `503 Service temporarily unavailable` | 瞬时 |
 * | 2 | `LLM 调用超时（120s）` | 瞬时 |
 * | 1 | `400 ... 'tool_calls' must be followed by tool messages` | 会话消息不成对 |
 * | 1 | `400 Failed to deserialize ... missing field 'messages'` | 会话消息不成对 |
 *
 * Writer 另有 3 次 `LLM 调用超时（300s）` + 2 次 503。
 *
 * ## 三类处理
 *
 * - `transient`：指数退避重试。**不占 `MAX_GUARD_REWRITE` 配额** ——
 *   那个配额限制的是"正文质量不合格所以重写"，与"网关 502"是两件事，
 *   混用会让几次网络抖动吃掉本该留给质量问题的重写次数。
 * - `account`：立即失败，并推明确的账户错误文案。此前一律显示"LLM 调用失败"，
 *   用户看不出是自己欠费还是服务挂了，只会反复重试烧掉更多时间。
 * - `malformed_session`：会话消息不成对，重试同一份消息必然再失败。
 *   这是 `pi-session` 侧的真实缺陷（详见下方注释），此处只做识别与快速失败，
 *   不做静默重试，避免把 bug 掩盖成"偶发抖动"。
 *
 * ## 本模块的边界
 *
 * 纯函数，不含计时器与 IO：分类与退避时长可被单测钉住，调用方负责实际等待。
 */

/** 失败分类 */
export type LlmFailureKind =
  /** 瞬时故障，值得重试 */
  | 'transient'
  /** 账户/凭据问题，重试无用 */
  | 'account'
  /** 会话消息结构不合法，重试同一份消息必然再失败 */
  | 'malformed_session'
  /** 用户主动取消，不是失败 */
  | 'aborted_by_user'
  /** 未识别，保守处理为不重试 */
  | 'unknown'

export interface LlmFailureClassification {
  kind: LlmFailureKind
  /** 是否应当重试 */
  retryable: boolean
  /** 面向用户的说明；unknown 时为 null，由调用方回退到原始 message */
  userMessage: string | null
}

/** 重试上限。3 次重试 = 最多 4 次调用。 */
export const LLM_MAX_RETRIES = 3

/**
 * 指数退避间隔（毫秒）：1s / 4s / 12s。
 *
 * 不用纯 2^n：Director 单次调用平均 53s，退避到 12s 相对调用本身仍然便宜，
 * 而 502/503 这类网关抖动通常几秒内恢复；再长只是让用户干等。
 */
export const LLM_RETRY_DELAYS_MS = [1_000, 4_000, 12_000] as const

/**
 * 瞬时故障特征。
 *
 * 按 message 子串匹配而非状态码：错误来自 Provider SDK / fetch / 自研超时包装
 * 三个不同层，没有统一的结构化字段，能稳定拿到的只有 message。
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  // 网关与上游不可用
  /\b50[234]\b/,
  /service temporarily unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /\b429\b/,
  /rate limit/i,
  // 超时：SDK 的 "Request timed out" 与自研的 "LLM 调用超时（120s）"
  /timed?\s*out/i,
  /timeout/i,
  /调用超时/,
  // 流被掐断：拿到了部分内容但没有终止原因
  /stream ended without finish_reason/i,
  /premature close/i,
  // undici 在响应体被上游/代理中途销毁时抛 `TypeError: terminated`（实测 Writer 111s 后失败整章作废）
  /\bterminated\b/i,
  // 连接层
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE/,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
]

/** 账户/凭据问题 */
const ACCOUNT_PATTERNS: ReadonlyArray<{ pattern: RegExp; userMessage: string }> = [
  {
    pattern: /insufficient\s*balance|\b402\b|quota exceeded|billing/i,
    userMessage: 'Provider 账户余额不足，请充值后重新开始创作。已完成的内容不受影响。',
  },
  {
    pattern: /\b401\b|invalid api key|incorrect api key|unauthorized|authentication/i,
    userMessage: 'Provider API Key 无效或已过期，请在「设置 → 模型与 Provider」中更新后重试。',
  },
  {
    pattern: /\b403\b|permission denied|forbidden/i,
    userMessage: 'Provider 拒绝了本次请求（无权限或模型未开通），请检查账户的模型访问权限。',
  },
]

/**
 * 会话消息结构不合法。
 *
 * ⚠️ 这两条不是 LLM 的问题，而是我们发出去的消息数组本身就不合法：
 *   - `assistant` 带 `tool_calls` 却没有配对的 `tool` 结果消息
 *   - 整个 `messages` 字段缺失
 * 两者都指向 `pi-session` 在工具调用中断（超时/取消）后没有清理半截的
 * tool_calls，下一轮请求就带着不成对的消息发出去。重试同一份消息必然再失败。
 *
 * 正确修法是在 session 侧丢弃未配对的 tool_calls 后重建请求，属于独立议题；
 * 此处先让它快速失败并给出可定位的文案，而不是伪装成瞬时错误反复重试。
 */
const MALFORMED_SESSION_PATTERNS: readonly RegExp[] = [
  /tool_calls.*must be followed by tool messages/i,
  /missing field ['"`]?messages/i,
  /failed to deserialize the json body/i,
]

/** 用户主动取消的特征 */
const ABORT_PATTERNS: readonly RegExp[] = [
  /\baborted\b/i,
  /\bcancell?ed\b/i,
  /AbortError/,
]

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // 有些 SDK 把状态码放在挂载属性上而不是 message 里，一并纳入匹配面
    const extra = error as { status?: unknown; code?: unknown }
    const status = scalarOrEmpty(extra.status)
    const code = scalarOrEmpty(extra.code)
    return `${error.name} ${error.message} ${status} ${code}`.trim()
  }
  return String(error)
}

function scalarOrEmpty(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/**
 * 分类一次 LLM 调用失败。
 *
 * @param error 捕获到的异常
 * @param userAborted 用户是否已主动取消（`options.signal?.aborted`）。
 *   这个参数不能省：`Request was aborted` 在实测里既来自 Provider 侧的连接中断
 *   （瞬时，应重试），也来自用户点「停止创作」（不能重试，否则用户按了停止
 *   还会再打三次 LLM）。仅凭 message 无法区分，必须由调用方提供意图。
 */
export function classifyLlmFailure(error: unknown, userAborted = false): LlmFailureClassification {
  const message = messageOf(error)

  // 用户意图优先于一切 message 匹配
  if (userAborted) {
    return { kind: 'aborted_by_user', retryable: false, userMessage: null }
  }

  // 账户类先判：402 响应体里也可能带 "service" 之类的词，先匹配瞬时会误判成可重试
  for (const { pattern, userMessage } of ACCOUNT_PATTERNS) {
    if (pattern.test(message)) {
      return { kind: 'account', retryable: false, userMessage }
    }
  }

  // 消息不成对同样先于瞬时判定：它带 400，且文案里可能出现 "messages" 等中性词
  if (MALFORMED_SESSION_PATTERNS.some((p) => p.test(message))) {
    return {
      kind: 'malformed_session',
      retryable: false,
      userMessage: '请求消息结构异常（工具调用未正确配对），这是一个需要修复的内部缺陷。请重新开始本章创作。',
    }
  }

  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) {
    return { kind: 'transient', retryable: true, userMessage: null }
  }

  // 非用户取消的 abort：视作上游连接中断，值得重试
  if (ABORT_PATTERNS.some((p) => p.test(message))) {
    return { kind: 'transient', retryable: true, userMessage: null }
  }

  return { kind: 'unknown', retryable: false, userMessage: null }
}

/**
 * 第 attempt 次重试前应等待的毫秒数。
 *
 * @param attempt 1-based（第 1 次重试 → 1000ms）
 * @returns 超出重试上限时返回 null，表示不应再试
 */
export function retryDelayMs(attempt: number): number | null {
  if (attempt < 1 || attempt > LLM_RETRY_DELAYS_MS.length) return null
  return LLM_RETRY_DELAYS_MS[attempt - 1]
}
