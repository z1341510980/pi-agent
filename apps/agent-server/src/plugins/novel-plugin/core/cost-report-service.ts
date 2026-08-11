/**
 * CostReportService：Agent / 章节成本报表（PRD §4.1 P0-2，统一方案 §5.1）。
 *
 * 只读聚合 novel_agent_logs（token/round-trip 真实值）+ novel_context_section_metrics
 * （section 级字符占比），回答"token 花在哪"。
 *
 * 必答六项指标：
 *   1. 每章首次调用 full-price input（第一条第 1 次 LLM 往返的 input，cache miss 口径）
 *   2. 每个 Agent 成本占比（input + cache-read 口径）
 *   3. formatArrangedEntities（实体档案）占 shared 比例
 *   4. tool schema 占输入比例
 *   5. 工具调用 round-trip 次数
 *   6. cache-read / input 比例
 *
 * 每条报表行可下钻到 novel_agent_logs 原始记录（agentLogId）。
 */
import type Database from 'better-sqlite3'

export interface CostReportRow {
  projectId: string
  chapterNumber: number
  agentType: string
  agentLogId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmRoundTrips: number
  durationMs: number
  status: string
  createdAt: number
  /** section 级字符数（来自度量表，缺省 0） */
  systemChars: number
  sharedChars: number
  identityChars: number
  suffixChars: number
  dynamicChars: number
  toolSchemaChars: number
  arrangedEntitiesChars: number
}

export interface AgentCostShare {
  agentType: string
  calls: number
  inputTokens: number
  cacheReadTokens: number
  /** input + cache-read 口径成本单位 */
  costUnits: number
  sharePct: number
}

export interface ChapterCostReport {
  projectId: string
  chapterNumber: number
  rows: CostReportRow[]
  /** 每章首次调用 full-price input（该章最早日志的 inputTokens） */
  firstCallInputTokens: number
  /** 每章首次调用是否为 cache miss（inputTokens > 0 且 cacheReadTokens 未覆盖） */
  firstCallCacheReadTokens: number
  agentShares: AgentCostShare[]
  /** formatArrangedEntities 字符数占 shared 字符数比例（0~1，缺 shared 数据为 null） */
  arrangedEntitiesShareOfSharedPct: number | null
  /** tool schema 字符数占（system+shared+identity+suffix+dynamic+tool_schema）比例 */
  toolSchemaShareOfInputPct: number
  roundTripTotal: number
  /** cache-read / input 比例（input=0 时为 0） */
  cacheReadRatio: number
}

export class CostReportService {
  constructor(private db: Database.Database) {}

  /**
   * 按项目 + 章节生成成本报表（不传 chapterNumber 则返回全部章节逐章聚合）。
   */
  chapterReport(projectId: string, chapterNumber?: number): ChapterCostReport[] {
    const chapterNumbers = this.listChapterNumbers(projectId, chapterNumber)
    return chapterNumbers.map((num) => this.buildChapterReport(projectId, num))
  }

  /**
   * 按项目聚合每个 Agent 的成本占比（input + cache-read 口径）。
   */
  agentCostShare(projectId: string): AgentCostShare[] {
    const rows = this.db.prepare(
      `SELECT agent_type,
              COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens
       FROM novel_agent_logs
       WHERE project_id = ?
       GROUP BY agent_type
       ORDER BY (SUM(input_tokens) + SUM(cache_read_tokens)) DESC`,
    ).all(projectId) as Array<{
      agent_type: string
      calls: number
      input_tokens: number
      cache_read_tokens: number
    }>

    const totalCost = rows.reduce((sum, r) => sum + r.input_tokens + r.cache_read_tokens, 0)
    return rows.map((r) => {
      const costUnits = r.input_tokens + r.cache_read_tokens
      return {
        agentType: r.agent_type,
        calls: r.calls,
        inputTokens: r.input_tokens,
        cacheReadTokens: r.cache_read_tokens,
        costUnits,
        sharePct: totalCost > 0 ? costUnits / totalCost : 0,
      }
    })
  }

  /** 列出项目的章节号（升序） */
  private listChapterNumbers(projectId: string, chapterNumber?: number): number[] {
    if (chapterNumber != null) return [chapterNumber]
    const rows = this.db.prepare(
      'SELECT DISTINCT chapter_number AS n FROM novel_agent_logs WHERE project_id = ? ORDER BY n ASC',
    ).all(projectId) as Array<{ n: number }>
    return rows.map((r) => r.n)
  }

  private buildChapterReport(projectId: string, chapterNumber: number): ChapterCostReport {
    const logs = this.db.prepare(
      `SELECT id, project_id, chapter_number, agent_type, status, duration_ms,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              llm_round_trips, created_at
       FROM novel_agent_logs
       WHERE project_id = ? AND chapter_number = ?
       ORDER BY created_at ASC`,
    ).all(projectId, chapterNumber) as Array<{
      id: string
      project_id: string
      chapter_number: number
      agent_type: string
      status: string
      duration_ms: number
      input_tokens: number
      output_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
      llm_round_trips: number | null
      created_at: number
    }>

    const sectionRows = this.db.prepare(
      `SELECT agent_log_id, section_type, section_id, chars
       FROM novel_context_section_metrics
       WHERE project_id = ? AND chapter_number = ?`,
    ).all(projectId, chapterNumber) as Array<{
      agent_log_id: string
      section_type: string
      section_id: string
      chars: number
    }>

    const sectionByLog = new Map<string, Map<string, number>>()
    const sharedByLog = new Map<string, number>()
    const arrangedByLog = new Map<string, number>()
    const dynamicByLog = new Map<string, { userMessage: number; taskInput: number; other: number }>()
    for (const row of sectionRows) {
      // shared 整段以 section_id='shared' 计量（含实体档案子 section）；
      // arranged-entities 单独计量，用于"实体档案占 shared 比例"（子集 / 全集）。
      if (row.section_id === 'shared') {
        sharedByLog.set(row.agent_log_id, (sharedByLog.get(row.agent_log_id) ?? 0) + row.chars)
      }
      if (row.section_id === 'arranged-entities') {
        arrangedByLog.set(row.agent_log_id, (arrangedByLog.get(row.agent_log_id) ?? 0) + row.chars)
        continue // arranged 已单独计量，不再计入 section_type=shared 汇总
      }
      if (row.section_type === 'dynamic') {
        const dynamic = dynamicByLog.get(row.agent_log_id) ?? { userMessage: 0, taskInput: 0, other: 0 }
        if (row.section_id === 'user-message') dynamic.userMessage += row.chars
        else if (row.section_id === 'task-input') dynamic.taskInput += row.chars
        else dynamic.other += row.chars
        dynamicByLog.set(row.agent_log_id, dynamic)
        continue
      }
      let map = sectionByLog.get(row.agent_log_id)
      if (!map) {
        map = new Map<string, number>()
        sectionByLog.set(row.agent_log_id, map)
      }
      map.set(row.section_type, (map.get(row.section_type) ?? 0) + row.chars)
    }
    for (const [logId, dynamic] of dynamicByLog) {
      let map = sectionByLog.get(logId)
      if (!map) {
        map = new Map<string, number>()
        sectionByLog.set(logId, map)
      }
      // task-input 是 user-message 的原始子集，只在旧日志缺 user-message 时回退。
      map.set('dynamic', dynamic.other + (dynamic.userMessage || dynamic.taskInput))
    }

    const rows: CostReportRow[] = logs.map((log) => {
      const sections = sectionByLog.get(log.id) ?? new Map<string, number>()
      return {
        projectId: log.project_id,
        chapterNumber: log.chapter_number,
        agentType: log.agent_type,
        agentLogId: log.id,
        inputTokens: log.input_tokens,
        outputTokens: log.output_tokens,
        cacheReadTokens: log.cache_read_tokens,
        cacheWriteTokens: log.cache_write_tokens,
        llmRoundTrips: log.llm_round_trips ?? 0,
        durationMs: log.duration_ms,
        status: log.status,
        createdAt: log.created_at,
        systemChars: sections.get('system') ?? 0,
        sharedChars: sharedByLog.get(log.id) ?? 0,
        identityChars: sections.get('identity') ?? 0,
        suffixChars: sections.get('suffix') ?? 0,
        dynamicChars: sections.get('dynamic') ?? 0,
        toolSchemaChars: sections.get('tool_schema') ?? 0,
        arrangedEntitiesChars: arrangedByLog.get(log.id) ?? 0,
      }
    })

    const first = rows[0]
    const totalSharedChars = rows.reduce((sum, r) => sum + r.sharedChars, 0)
    const totalArrangedChars = rows.reduce((sum, r) => sum + r.arrangedEntitiesChars, 0)
    const totalInputChars = rows.reduce((sum, r) => sum + (
      r.systemChars + r.sharedChars + r.identityChars + r.suffixChars + r.dynamicChars + r.toolSchemaChars
    ), 0)
    const totalToolSchemaChars = rows.reduce((sum, r) => sum + r.toolSchemaChars, 0)
    const roundTripTotal = rows.reduce((sum, r) => sum + r.llmRoundTrips, 0)
    const totalInputTokens = rows.reduce((sum, r) => sum + r.inputTokens, 0)
    const totalCacheReadTokens = rows.reduce((sum, r) => sum + r.cacheReadTokens, 0)

    const costByAgent = new Map<string, { calls: number; input: number; cacheRead: number }>()
    for (const r of rows) {
      let entry = costByAgent.get(r.agentType)
      if (!entry) {
        entry = { calls: 0, input: 0, cacheRead: 0 }
        costByAgent.set(r.agentType, entry)
      }
      entry.calls += 1
      entry.input += r.inputTokens
      entry.cacheRead += r.cacheReadTokens
    }
    const totalCost = [...costByAgent.values()].reduce((sum, e) => sum + e.input + e.cacheRead, 0)
    const agentShares: AgentCostShare[] = [...costByAgent.entries()]
      .map(([agentType, e]) => ({
        agentType,
        calls: e.calls,
        inputTokens: e.input,
        cacheReadTokens: e.cacheRead,
        costUnits: e.input + e.cacheRead,
        sharePct: totalCost > 0 ? (e.input + e.cacheRead) / totalCost : 0,
      }))
      .sort((a, b) => b.costUnits - a.costUnits)

    return {
      projectId,
      chapterNumber,
      rows,
      firstCallInputTokens: first?.inputTokens ?? 0,
      firstCallCacheReadTokens: first?.cacheReadTokens ?? 0,
      agentShares,
      arrangedEntitiesShareOfSharedPct: totalSharedChars > 0
        ? totalArrangedChars / totalSharedChars
        : null,
      toolSchemaShareOfInputPct: totalInputChars > 0 ? totalToolSchemaChars / totalInputChars : 0,
      roundTripTotal,
      cacheReadRatio: totalInputTokens > 0 ? totalCacheReadTokens / totalInputTokens : 0,
    }
  }
}
