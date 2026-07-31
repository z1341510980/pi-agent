/**
 * 缓存分层命中诊断。
 *
 * ## 要回答的问题
 *
 * 提示词按 `system → shared → identity → suffix` 分层，并在 system 末尾与每条
 * prefix user message 末尾打 `cache_control: ephemeral` 断点
 * （`plugin-manager.ts` / `novel-orchestrator.ts` 的 `prefixUserMessage` 顺序）。
 * 设计意图是：Director 先写入缓存，Writer / Reviewer 读同一段 shared 时直接命中。
 *
 * 但这套分层**从未验证过是否真的生效**。实测数据给出两个可疑信号：
 *
 * 1. Writer 平均 `cache_read` 只有 6.1k，而 shared 段本身就有 14.2k 字符 ——
 *    如果分层命中正常，Writer 的 cache_read 至少应覆盖 system + shared + identity。
 * 2. 155 条有 token 记录的日志里，`cache_write_tokens` **全部为 0**。
 *    要么 Provider 不上报写入量，要么 `cache_control` 根本没生效。
 *
 * 这是全链路最大的一笔潜在节省（累计 372 万 input token），所以先量出来再谈优化。
 *
 * ## 怎么量：用数据自己校准，不用魔法常数
 *
 * 难点在于日志里存的是**字符数**（`chapter_context` / `system_prompt` 的长度），
 * 而 cache_read 是**token 数**，两者之间的比值取决于模型的分词器。
 * 硬编码一个「中文 1.5 字/token」的常数会让结论完全依赖这个猜测。
 *
 * 这里改为**从同一条日志里反解**：`inputTokens / 总提示词字符数` 就是该模型在
 * 该段文本上的实际字符/token 比。用它换算可缓存前缀的期望 token 数，
 * 再与实测 cache_read 比较。这样结论只依赖"同一条记录内部自洽"，
 * 不依赖任何外部假设。
 *
 * ## 边界
 *
 * 纯函数，不碰数据库。调用方负责取日志。
 */

/** 诊断所需的单条 Agent 调用记录（`novel_agent_logs` 的子集） */
export interface CacheDiagnosticLog {
  agentType: string
  chapterNumber: number
  /** STATIC 层。identity_only 模式（盲审）下为空 */
  systemPrompt: string
  /** `[shared, identity, suffix].filter(Boolean).join('\n\n---\n\n')` */
  chapterContext: string
  userMessage: string
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  createdAt: number
  status: string
}

/** chapterContext 的拼接分隔符，与 novel-orchestrator 写入时一致 */
const CONTEXT_SEPARATOR = '\n\n---\n\n'

/**
 * 单条调用的分层度量。
 */
export interface CallCacheMetrics {
  agentType: string
  /** 调用在本章内的序号（1-based，按 createdAt 升序） */
  order: number
  /** 可缓存前缀字符数 = system + shared + identity（suffix 之后无断点，不计） */
  cacheablePrefixChars: number
  /** 总提示词字符数 */
  totalPromptChars: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * 由本条记录自身反解的字符/token 比。
   * inputTokens 为 0（Provider 未上报）时为 null，此时无法换算。
   */
  charsPerToken: number | null
  /** 可缓存前缀折算成 token 的期望值；charsPerToken 为 null 时为 null */
  expectedCacheReadTokens: number | null
  /**
   * 命中覆盖率 = cacheRead / expectedCacheRead。
   * 1.0 表示可缓存前缀被完整命中；0 表示完全 miss。
   */
  coverage: number | null
}

/** 分层是否按设计工作 */
export type CacheVerdict =
  /** 后续调用完整命中前缀 */
  | 'healthy'
  /** 命中了但只覆盖了一部分前缀（典型症状：只命中 system，shared 没跨 Agent 复用） */
  | 'partial'
  /** 后续调用完全没有 cache_read */
  | 'miss'
  /** Provider 没上报 token，无法判断 */
  | 'no_data'

export interface ChapterCacheDiagnosis {
  chapterNumber: number
  calls: CallCacheMetrics[]
  verdict: CacheVerdict
  /** 一句话结论 */
  summary: string
  /**
   * 首次调用之后的平均命中覆盖率。
   *
   * 排除首次调用：本章第一次调用（通常是 Director）负责**写入**缓存，
   * 它本身的 cache_read 天然低（只能命中跨章节稳定的 system 段），
   * 把它算进平均值会掩盖真正要看的"后续调用有没有复用上"。
   */
  followUpCoverage: number | null
  /**
   * `cache_write_tokens` 是否全为 0。
   *
   * 单独拎出来是因为它有两种完全不同的解释，且都需要人来判断：
   * Provider 不上报写入量（无害），或 `cache_control` 根本没生效（严重）。
   * 诊断不猜，只如实报告。
   */
  allCacheWriteZero: boolean
}

/** 覆盖率判定阈值 */
export const CACHE_COVERAGE_THRESHOLDS = {
  /** ≥ 此值视为完整命中。留 15% 余量：分词边界与 identity 段的微小变动都会造成偏差 */
  healthy: 0.85,
  /** ≥ 此值视为部分命中；低于则视为 miss */
  partial: 0.1,
} as const

/**
 * 拆出可缓存前缀的字符数。
 *
 * `chapterContext` 是 `[shared, identity, suffix].filter(Boolean).join(sep)`，
 * 空段被过滤掉，所以分段数不固定。靠 systemPrompt 是否为空来区分两种模式：
 *   - 非空 → full 模式，分段为 shared / identity /（可选）suffix
 *   - 空   → identity_only 模式（盲审），只有 identity 一段
 *
 * suffix 位于最后一个缓存断点之后、且每次实时构建，不计入可缓存前缀。
 */
export function computeCacheablePrefixChars(log: CacheDiagnosticLog): number {
  const parts = log.chapterContext ? log.chapterContext.split(CONTEXT_SEPARATOR) : []
  if (!log.systemPrompt) {
    // identity_only：整段都是 identity
    return parts.reduce((sum, p) => sum + p.length, 0)
  }
  // full 模式：shared + identity 可缓存，suffix 不计
  const shared = parts[0]?.length ?? 0
  const identity = parts[1]?.length ?? 0
  return log.systemPrompt.length + shared + identity
}

function totalPromptChars(log: CacheDiagnosticLog): number {
  return log.systemPrompt.length + log.chapterContext.length + log.userMessage.length
}

/** 计算单条调用的分层度量 */
export function measureCall(log: CacheDiagnosticLog, order: number): CallCacheMetrics {
  const cacheablePrefixChars = computeCacheablePrefixChars(log)
  const total = totalPromptChars(log)

  // inputTokens 已含 cache_read 部分（见 NovelAgentLog 字段注释），
  // 因此它对应的就是完整提示词，可直接用于反解比值。
  const charsPerToken = log.inputTokens > 0 && total > 0 ? total / log.inputTokens : null
  const expectedCacheReadTokens = charsPerToken != null
    ? Math.round(cacheablePrefixChars / charsPerToken)
    : null
  const coverage = expectedCacheReadTokens != null && expectedCacheReadTokens > 0
    ? log.cacheReadTokens / expectedCacheReadTokens
    : null

  return {
    agentType: log.agentType,
    order,
    cacheablePrefixChars,
    totalPromptChars: total,
    inputTokens: log.inputTokens,
    cacheReadTokens: log.cacheReadTokens,
    cacheWriteTokens: log.cacheWriteTokens,
    charsPerToken,
    expectedCacheReadTokens,
    coverage,
  }
}

/**
 * 诊断单章的缓存分层命中情况。
 *
 * @param logs 该章的 Agent 调用记录，顺序无所谓（内部按 createdAt 排序）
 */
export function diagnoseChapterCache(
  chapterNumber: number,
  logs: CacheDiagnosticLog[],
): ChapterCacheDiagnosis {
  // 失败的调用往往没走完请求，token 数不可信，排除
  const usable = logs
    .filter((l) => l.status === 'success')
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)

  const calls = usable.map((log, index) => measureCall(log, index + 1))
  const allCacheWriteZero = calls.length > 0 && calls.every((c) => c.cacheWriteTokens === 0)

  if (calls.length === 0) {
    return {
      chapterNumber,
      calls,
      verdict: 'no_data',
      summary: '本章没有成功的 Agent 调用记录',
      followUpCoverage: null,
      allCacheWriteZero: false,
    }
  }

  // 首次调用负责写入缓存，其 cache_read 天然低，不参与平均
  const followUps = calls.slice(1).filter((c) => c.coverage != null)
  const followUpCoverage = followUps.length > 0
    ? followUps.reduce((sum, c) => sum + (c.coverage ?? 0), 0) / followUps.length
    : null

  if (followUpCoverage == null) {
    return {
      chapterNumber,
      calls,
      verdict: 'no_data',
      summary: calls.length === 1
        ? '本章只有一次调用，无法判断跨 Agent 复用'
        : 'Provider 未上报 token 用量，无法换算期望命中量',
      followUpCoverage: null,
      allCacheWriteZero,
    }
  }

  const pct = Math.round(followUpCoverage * 100)
  if (followUpCoverage >= CACHE_COVERAGE_THRESHOLDS.healthy) {
    return {
      chapterNumber,
      calls,
      verdict: 'healthy',
      summary: `后续 Agent 平均命中可缓存前缀的 ${pct}%，分层复用正常`,
      followUpCoverage,
      allCacheWriteZero,
    }
  }
  if (followUpCoverage >= CACHE_COVERAGE_THRESHOLDS.partial) {
    return {
      chapterNumber,
      calls,
      verdict: 'partial',
      summary: `后续 Agent 只命中可缓存前缀的 ${pct}%，shared 段很可能没有跨 Agent 复用`,
      followUpCoverage,
      allCacheWriteZero,
    }
  }
  return {
    chapterNumber,
    calls,
    verdict: 'miss',
    summary: `后续 Agent 几乎没有命中缓存（${pct}%），分层断点可能未生效`,
    followUpCoverage,
    allCacheWriteZero,
  }
}

/** 跨章节汇总 */
export interface CacheLayerReport {
  chapters: ChapterCacheDiagnosis[]
  /** 所有章节 followUpCoverage 的平均值 */
  overallCoverage: number | null
  verdict: CacheVerdict
  /** 若分层完全命中，本次统计范围内可省下的 input token 估算 */
  potentialSavedTokens: number
  /** 需要人工判断的提示 */
  notes: string[]
}

/**
 * 汇总多章诊断。
 *
 * `potentialSavedTokens` 是**上界估算**：假设可缓存前缀被 100% 命中，
 * 相比当前实测 cache_read 多出来的那部分。它不代表实际能省下的钱
 * （命中的 token 通常仍按折扣价计费），只用于判断这件事值不值得投入。
 */
export function buildCacheLayerReport(diagnoses: ChapterCacheDiagnosis[]): CacheLayerReport {
  const withCoverage = diagnoses.filter((d) => d.followUpCoverage != null)
  const overallCoverage = withCoverage.length > 0
    ? withCoverage.reduce((sum, d) => sum + (d.followUpCoverage ?? 0), 0) / withCoverage.length
    : null

  let potentialSavedTokens = 0
  for (const chapter of diagnoses) {
    // 同样跳过首次调用：它必须真实写入，没有可省的部分
    for (const call of chapter.calls.slice(1)) {
      if (call.expectedCacheReadTokens == null) continue
      potentialSavedTokens += Math.max(0, call.expectedCacheReadTokens - call.cacheReadTokens)
    }
  }

  const notes: string[] = []
  if (diagnoses.some((d) => d.allCacheWriteZero)) {
    notes.push(
      'cache_write_tokens 全为 0：可能是 Provider 不上报写入量（无害），也可能是 cache_control 未生效（严重）。需要对照 Provider 文档确认。',
    )
  }
  if (overallCoverage != null && overallCoverage < CACHE_COVERAGE_THRESHOLDS.healthy) {
    notes.push(
      '命中率偏低时优先检查 shared 段是否逐字稳定：narrativeTask / constraints 里任何一处随调用变化的内容都会让整个前缀失效。',
    )
  }

  const verdict: CacheVerdict = overallCoverage == null
    ? 'no_data'
    : overallCoverage >= CACHE_COVERAGE_THRESHOLDS.healthy
      ? 'healthy'
      : overallCoverage >= CACHE_COVERAGE_THRESHOLDS.partial
        ? 'partial'
        : 'miss'

  return { chapters: diagnoses, overallCoverage, verdict, potentialSavedTokens, notes }
}
