/**
 * ObservabilityService：观测聚合服务（缓存与监控一体化，任务 4）。
 *
 * 只读聚合 `novel_agent_logs`，对外提供四个视图：
 *   - overview：项目总览（调用量/成功率/token 汇总/命中率/数据质量四桶）
 *   - cache：缓存分层报告（JS 侧复用 cache-layer-diagnostics 的纯函数诊断）
 *   - agents：按 Agent 分组统计（含量近一条失败原因）
 *   - timeline：调用时间线（倒序、limit、每行命中率）
 *
 * ## 口径
 *
 * - created_at 为 unixepoch 秒，from/to 过滤均为含端点。
 * - cacheHitRate 复用 `model-call-telemetry` 的口径：cacheRead / (cacheRead + input)，
 *   分母为 0 时返回 null（区分"未命中"与"没数据"）。
 * - 大文本（system_prompt/chapter_context/user_message）087a 后外置到 payload 表，
 *   主表列可能为空串或仍留有旧值。诊断只读主表列、不回读 payload（性能），
 *   取不到内容时该章诊断自然降级为 no_data。
 */
import type Database from 'better-sqlite3'
import { cacheHitRate } from '../../../../core/observability/model-call-telemetry.js'
import {
  buildCacheLayerReport,
  diagnoseChapterCache,
  type CacheDiagnosticLog,
  type CacheVerdict,
} from './cache-layer-diagnostics.js'

export interface ObservabilityFilter {
  /** unixepoch 秒（含） */
  from?: number
  /** unixepoch 秒（含） */
  to?: number
  chapterNumber?: number
  agentType?: string
  /** 默认 100，最大 500 */
  limit?: number
}

export interface ObservabilityOverview {
  totalCalls: number
  /** success/total，无调用时 null */
  successRate: number | null
  errorRate: number
  /** 本项目状态只有 success/error/cancelled，恒 0 */
  timeoutRate: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 总 cacheRead / (总 cacheRead + 总 input)；总 input+cacheRead=0 时 null */
  cacheHitRate: number | null
  /** AVG(duration_ms)，仅成功样本；无成功样本时 null */
  avgDurationMs: number | null
  // TODO: 接入 cost-rates 单价后由 cost-report 口径补齐真实成本
  totalCostUsd: number
  /** data_quality 列为 NULL（迁移前旧行）计入 unknown */
  dataQuality: { completeCalls: number; partialCalls: number; noDataCalls: number; unknownCalls: number }
  timestamp: number
}

export interface ObservabilityCacheReport {
  /** 所有章节 followUpCoverage 的平均值（复用 buildCacheLayerReport 口径） */
  overallCoverage: number | null
  verdict: CacheVerdict
  /** 若分层完全命中，本次统计范围内可省下的 input token 上界估算 */
  potentialSavedTokens: number
  notes: string[]
  chapters: Array<{ chapterNumber: number; verdict: CacheVerdict; followUpCoverage: number | null }>
  byAgent: Array<{ agentType: string; hitRate: number | null; calls: number }>
  /** cache_protocol 分组计数，NULL 计入 'unknown' */
  protocolDistribution: Record<string, number>
  /** 仅统计 fingerprint 非空的行 */
  fingerprintStability: { totalCalls: number; distinctFingerprints: number }
  /** 参与分层诊断采样的日志条数（上限 500） */
  sampledLogs: number
  timestamp: number
}

export interface ObservabilityAgentRow {
  agentType: string
  calls: number
  successRate: number
  inputTokens: number
  outputTokens: number
  cacheHitRate: number | null
  /** AVG(duration_ms)，仅成功样本；无成功样本时 null */
  avgDurationMs: number | null
  // TODO: 接入 cost-rates 单价后由 cost-report 口径补齐真实成本
  costUsd: number
  /** 该 agent 最近一条 status!='success' 的 error 前 200 字符，无则 null */
  lastError: string | null
}

export interface ObservabilityTimelineRow {
  id: string
  chapterNumber: number
  agentType: string
  phase: string
  status: string
  durationMs: number
  inputTokens: number
  cacheReadTokens: number
  cacheProtocol: string | null
  cacheHitRate: number | null
  createdAt: number
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export class ObservabilityService {
  constructor(private readonly db: Database.Database) {}

  /** 项目总览：一次 SQL 聚合 + 数据质量分桶 */
  overview(projectId: string, f: ObservabilityFilter = {}): ObservabilityOverview {
    const { clause, params } = this.where(projectId, f)
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
             AVG(CASE WHEN status = 'success' THEN duration_ms END) AS avg_duration
      FROM novel_agent_logs
      WHERE ${clause}
    `).get(...params) as {
      total: number
      success: number
      errors: number
      input_tokens: number
      output_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
      avg_duration: number | null
    }

    const dqRows = this.db.prepare(`
      SELECT CASE WHEN data_quality IN ('complete', 'partial', 'no_data') THEN data_quality ELSE 'unknown' END AS q,
             COUNT(*) AS n
      FROM novel_agent_logs
      WHERE ${clause}
      GROUP BY q
    `).all(...params) as Array<{ q: string; n: number }>
    const dq = { completeCalls: 0, partialCalls: 0, noDataCalls: 0, unknownCalls: 0 }
    for (const r of dqRows) {
      if (r.q === 'complete') dq.completeCalls = r.n
      else if (r.q === 'partial') dq.partialCalls = r.n
      else if (r.q === 'no_data') dq.noDataCalls = r.n
      else dq.unknownCalls = r.n
    }

    const total = row.total
    return {
      totalCalls: total,
      successRate: total > 0 ? row.success / total : null,
      errorRate: total > 0 ? row.errors / total : 0,
      timeoutRate: 0,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      cacheHitRate: cacheHitRate(row.cache_read_tokens, row.input_tokens),
      avgDurationMs: row.avg_duration,
      totalCostUsd: 0,
      dataQuality: dq,
      timestamp: Date.now(),
    }
  }

  /** 缓存分层报告：SQL 分组（协议/指纹/Agent）+ JS 侧复用纯函数诊断（每章） */
  cache(projectId: string, f: ObservabilityFilter = {}): ObservabilityCacheReport {
    const { clause, params } = this.where(projectId, f)

    // 拉取过滤后日志（上限 500）做分层诊断；大文本只读主表列，为空时该章降级 no_data
    const rows = this.db.prepare(`
      SELECT chapter_number, agent_type, system_prompt, chapter_context, user_message,
             input_tokens, cache_read_tokens, cache_write_tokens, created_at, status
      FROM novel_agent_logs
      WHERE ${clause}
      ORDER BY created_at ASC
      LIMIT ${MAX_LIMIT}
    `).all(...params) as Array<{
      chapter_number: number
      agent_type: string
      system_prompt: string | null
      chapter_context: string | null
      user_message: string | null
      input_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
      created_at: number
      status: string
    }>

    const byChapter = new Map<number, CacheDiagnosticLog[]>()
    for (const r of rows) {
      const log: CacheDiagnosticLog = {
        agentType: r.agent_type,
        chapterNumber: r.chapter_number,
        systemPrompt: r.system_prompt ?? '',
        chapterContext: r.chapter_context ?? '',
        userMessage: r.user_message ?? '',
        inputTokens: r.input_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        createdAt: r.created_at,
        status: r.status,
      }
      const logs = byChapter.get(r.chapter_number)
      if (logs) logs.push(log)
      else byChapter.set(r.chapter_number, [log])
    }

    const diagnoses = [...byChapter.entries()]
      .map(([chapterNumber, logs]) => diagnoseChapterCache(chapterNumber, logs))
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
    const report = buildCacheLayerReport(diagnoses)

    // byAgent 命中率：cacheHitRate(总 cacheRead, 总 input)
    const agentRows = this.db.prepare(`
      SELECT agent_type,
             COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
      FROM novel_agent_logs
      WHERE ${clause}
      GROUP BY agent_type
      ORDER BY agent_type ASC
    `).all(...params) as Array<{
      agent_type: string
      calls: number
      input_tokens: number
      cache_read_tokens: number
    }>

    const protocolRows = this.db.prepare(`
      SELECT COALESCE(NULLIF(cache_protocol, ''), 'unknown') AS p, COUNT(*) AS n
      FROM novel_agent_logs
      WHERE ${clause}
      GROUP BY p
      ORDER BY p ASC
    `).all(...params) as Array<{ p: string; n: number }>
    const protocolDistribution: Record<string, number> = {}
    for (const r of protocolRows) protocolDistribution[r.p] = r.n

    const fpRow = this.db.prepare(`
      SELECT COUNT(*) AS total_calls, COUNT(DISTINCT request_fingerprint) AS distinct_fingerprints
      FROM novel_agent_logs
      WHERE ${clause} AND request_fingerprint IS NOT NULL AND request_fingerprint != ''
    `).get(...params) as { total_calls: number; distinct_fingerprints: number }

    return {
      overallCoverage: report.overallCoverage,
      verdict: report.verdict,
      potentialSavedTokens: report.potentialSavedTokens,
      notes: report.notes,
      chapters: diagnoses.map((d) => ({
        chapterNumber: d.chapterNumber,
        verdict: d.verdict,
        followUpCoverage: d.followUpCoverage,
      })),
      byAgent: agentRows.map((r) => ({
        agentType: r.agent_type,
        hitRate: cacheHitRate(r.cache_read_tokens, r.input_tokens),
        calls: r.calls,
      })),
      protocolDistribution,
      fingerprintStability: {
        totalCalls: fpRow.total_calls,
        distinctFingerprints: fpRow.distinct_fingerprints,
      },
      sampledLogs: rows.length,
      timestamp: Date.now(),
    }
  }

  /**
   * 按 Agent 分组统计 + 最近一条失败原因（截断 200 字符）。
   * lastError 兜底顺序：主表 error 文本 → 归一化 error_code（087a 后新行 error
   * 外置 payload、主表写空串，此时至少给出错误码）→ 两者皆空为 null。
   */
  agents(projectId: string, f: ObservabilityFilter = {}): ObservabilityAgentRow[] {
    const { clause, params } = this.where(projectId, f)
    const rows = this.db.prepare(`
      SELECT agent_type,
             COUNT(*) AS calls,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             AVG(CASE WHEN status = 'success' THEN duration_ms END) AS avg_duration
      FROM novel_agent_logs
      WHERE ${clause}
      GROUP BY agent_type
      ORDER BY agent_type ASC
    `).all(...params) as Array<{
      agent_type: string
      calls: number
      success: number
      input_tokens: number
      output_tokens: number
      cache_read_tokens: number
      avg_duration: number | null
    }>

    // 每个 agent 最近一条非成功调用：error 为空串时兜底取 error_code（见方法头注释）
    const lastErrorRows = this.db.prepare(`
      SELECT agent_type, error FROM (
        SELECT agent_type, COALESCE(NULLIF(error, ''), error_code) AS error,
               ROW_NUMBER() OVER (PARTITION BY agent_type ORDER BY created_at DESC, id DESC) AS rn
        FROM novel_agent_logs
        WHERE ${clause} AND status != 'success'
      ) WHERE rn = 1
    `).all(...params) as Array<{ agent_type: string; error: string | null }>
    const lastErrorByAgent = new Map<string, string | null>()
    for (const r of lastErrorRows) {
      lastErrorByAgent.set(r.agent_type, r.error ? r.error.slice(0, 200) : null)
    }

    return rows.map((r) => ({
      agentType: r.agent_type,
      calls: r.calls,
      successRate: r.calls > 0 ? r.success / r.calls : 0,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheHitRate: cacheHitRate(r.cache_read_tokens, r.input_tokens),
      avgDurationMs: r.avg_duration,
      costUsd: 0,
      lastError: lastErrorByAgent.get(r.agent_type) ?? null,
    }))
  }

  /** 调用时间线：created_at 倒序 + limit（默认 100，最大 500）+ 每行命中率 */
  timeline(projectId: string, f: ObservabilityFilter = {}): ObservabilityTimelineRow[] {
    const { clause, params } = this.where(projectId, f)
    const limit = Math.min(Math.max(f.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const rows = this.db.prepare(`
      SELECT id, chapter_number, agent_type, phase, status, duration_ms,
             input_tokens, cache_read_tokens, cache_protocol, created_at
      FROM novel_agent_logs
      WHERE ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: string
      chapter_number: number
      agent_type: string
      phase: string
      status: string
      duration_ms: number
      input_tokens: number
      cache_read_tokens: number
      cache_protocol: string | null
      created_at: number
    }>

    return rows.map((r) => ({
      id: r.id,
      chapterNumber: r.chapter_number,
      agentType: r.agent_type,
      phase: r.phase,
      status: r.status,
      durationMs: r.duration_ms,
      inputTokens: r.input_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheProtocol: r.cache_protocol,
      cacheHitRate: cacheHitRate(r.cache_read_tokens, r.input_tokens),
      createdAt: r.created_at,
    }))
  }

  /** 拼接公共 WHERE（project_id + 可选时间/章节/Agent 过滤），全部参数绑定 */
  private where(projectId: string, f: ObservabilityFilter): { clause: string; params: unknown[] } {
    const conditions = ['project_id = ?']
    const params: unknown[] = [projectId]
    if (f.from != null) {
      conditions.push('created_at >= ?')
      params.push(f.from)
    }
    if (f.to != null) {
      conditions.push('created_at <= ?')
      params.push(f.to)
    }
    if (f.chapterNumber != null) {
      conditions.push('chapter_number = ?')
      params.push(f.chapterNumber)
    }
    if (f.agentType != null && f.agentType !== '') {
      conditions.push('agent_type = ?')
      params.push(f.agentType)
    }
    return { clause: conditions.join(' AND '), params }
  }
}
