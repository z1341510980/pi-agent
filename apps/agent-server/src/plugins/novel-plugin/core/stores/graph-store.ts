/**
 * GraphStore - PR-5b 重构（PR-4 合并 ReviewStore）
 *
 * 从原 novel-store.ts 抽取 Marker + AgentLog + NodePosition + Edge + AuthorIntent + ChapterReview 相关的 CRUD。
 * 严格保持与原 novel-store.ts 行为一致。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  NovelMarker, NovelAgentLog, NovelAgentLogSummary, NovelAgentLogStatus,
  NovelNodePosition, NovelNodeType, NovelEdge,
  NovelAuthorIntent, NovelChapterReview,
} from '../types.js'
import type {
  MarkerRow, AgentLogRow, NodePositionRow, EdgeRow,
  AuthorIntentRow, ChapterReviewRow,
} from './row-types.js'
import { now, bindString, parseJSON } from './store-utils.js'
import {
  isNovelFeatureEnabled,
  type FeatureFlagProjectSource,
} from '../novel-feature-flags.js'
import {
  gzipText,
  gunzipBlob,
  hashPayloadFields,
  computeExpiresAt,
  PAYLOAD_BLOB_COLUMNS,
  type PayloadFields,
} from '../log-payload-service.js'
import type {
  ContextSectionMetric,
  ContextSectionMetricInput,
} from '../context-section-metrics.js'

/** insertAgentLog 选项：externalizePayload 未指定时由 flag logPayloadExternalized 驱动 */
export interface InsertAgentLogOptions {
  externalizePayload?: boolean
}

export class GraphStore {
  private readonly stmtListNodePositions: Database.Statement
  private readonly stmtUpsertNodePosition: Database.Statement
  private readonly stmtDeleteNodePosition: Database.Statement
  private readonly stmtListMarkers: Database.Statement
  private readonly stmtListEdges: Database.Statement
  private readonly stmtDeleteEdge: Database.Statement
  private readonly stmtDeleteEdgesByEntity: Database.Statement
  private readonly stmtInsertAgentLog: Database.Statement
  private readonly stmtGetAgentLog: Database.Statement
  private readonly stmtListAgentLogsByProject: Database.Statement
  private readonly stmtListAgentLogsByChapter: Database.Statement
  private readonly stmtListAgentLogsByAgent: Database.Statement
  private readonly stmtDeleteAgentLogsByProject: Database.Statement
  private readonly stmtGetAgentLogPayload: Database.Statement
  private readonly stmtInsertAgentLogPayload: Database.Statement
  private readonly stmtDeleteExpiredPayloads: Database.Statement
  private readonly stmtCountPayloads: Database.Statement
  private readonly stmtCountExpiredPayloads: Database.Statement
  private readonly stmtInsertContextSectionMetric: Database.Statement

  constructor(
    private db: Database.Database,
    private flags?: FeatureFlagProjectSource,
  ) {
    this.stmtListNodePositions = db.prepare('SELECT * FROM novel_node_positions WHERE project_id = ? ORDER BY updated_at ASC')
    this.stmtUpsertNodePosition = db.prepare(`
      INSERT INTO novel_node_positions (id, project_id, node_type, entity_id, pos_x, pos_y, updated_at)
      VALUES (@id, @project_id, @node_type, @entity_id, @pos_x, @pos_y, @updated_at)
      ON CONFLICT(project_id, node_type, entity_id) DO UPDATE SET
        id = @id,
        pos_x = @pos_x,
        pos_y = @pos_y,
        updated_at = @updated_at
    `)
    this.stmtDeleteNodePosition = db.prepare('DELETE FROM novel_node_positions WHERE project_id = ? AND node_type = ? AND entity_id = ?')
    this.stmtListMarkers = db.prepare('SELECT * FROM novel_markers WHERE project_id = ? ORDER BY chapter ASC, created_at ASC')
    this.stmtListEdges = db.prepare('SELECT * FROM novel_edges WHERE project_id = ? ORDER BY created_at ASC')
    this.stmtDeleteEdge = db.prepare('DELETE FROM novel_edges WHERE id = ?')
    this.stmtDeleteEdgesByEntity = db.prepare(
      'DELETE FROM novel_edges WHERE source_id = ? OR target_id = ?',
    )

    this.stmtInsertAgentLog = db.prepare(`
      INSERT INTO novel_agent_logs (
        id, project_id, chapter_number, agent_type, agent_name,
        display_agent_type, display_agent_name, phase,
        system_prompt, chapter_context, user_message,
        task_input, user_instructions, tools, tool_names,
        result, result_length, duration_ms, status, error,
        session_id, parent_log_id, operation, created_at,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        llm_provider, llm_model,
        payload_messages_chars, payload_tools_chars, payload_tool_count,
        payload_total_chars, llm_round_trips,
        ask_story_policy, ask_story_enabled, payload_id
      ) VALUES (
        @id, @project_id, @chapter_number, @agent_type, @agent_name,
        @display_agent_type, @display_agent_name, @phase,
        @system_prompt, @chapter_context, @user_message,
        @task_input, @user_instructions, @tools, @tool_names,
        @result, @result_length, @duration_ms, @status, @error,
        @session_id, @parent_log_id, @operation, @created_at,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
        @llm_provider, @llm_model,
        @payload_messages_chars, @payload_tools_chars, @payload_tool_count,
        @payload_total_chars, @llm_round_trips,
        @ask_story_policy, @ask_story_enabled, @payload_id
      )
    `)
    this.stmtGetAgentLog = db.prepare('SELECT * FROM novel_agent_logs WHERE id = ?')
    this.stmtGetAgentLogPayload = db.prepare(
      'SELECT * FROM novel_agent_log_payloads WHERE agent_log_id = ?',
    )
    this.stmtInsertAgentLogPayload = db.prepare(`
      INSERT INTO novel_agent_log_payloads (
        id, agent_log_id, compression, system_prompt_blob, chapter_context_blob,
        user_message_blob, task_input_blob, user_instructions_blob, tools_blob,
        result_blob, error_blob, content_hash, expires_at, created_at
      ) VALUES (
        @id, @agent_log_id, @compression, @system_prompt_blob, @chapter_context_blob,
        @user_message_blob, @task_input_blob, @user_instructions_blob, @tools_blob,
        @result_blob, @error_blob, @content_hash, @expires_at, @created_at
      )
    `)
    this.stmtDeleteExpiredPayloads = db.prepare(
      'DELETE FROM novel_agent_log_payloads WHERE expires_at IS NOT NULL AND expires_at <= ?',
    )
    this.stmtCountPayloads = db.prepare('SELECT COUNT(*) AS n FROM novel_agent_log_payloads')
    this.stmtCountExpiredPayloads = db.prepare(
      'SELECT COUNT(*) AS n FROM novel_agent_log_payloads WHERE expires_at IS NOT NULL AND expires_at <= ?',
    )
    this.stmtInsertContextSectionMetric = db.prepare(`
      INSERT INTO novel_context_section_metrics (
        id, agent_log_id, project_id, chapter_number, agent_type,
        section_type, section_id, chars, estimated_tokens, source_hash, mode, created_at
      ) VALUES (
        @id, @agent_log_id, @project_id, @chapter_number, @agent_type,
        @section_type, @section_id, @chars, @estimated_tokens, @source_hash, @mode, @created_at
      )
    `)
    this.stmtListAgentLogsByProject = db.prepare(
      'SELECT * FROM novel_agent_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    this.stmtListAgentLogsByChapter = db.prepare(
      'SELECT * FROM novel_agent_logs WHERE project_id = ? AND chapter_number = ? ORDER BY created_at DESC LIMIT ?',
    )
    this.stmtListAgentLogsByAgent = db.prepare(
      'SELECT * FROM novel_agent_logs WHERE project_id = ? AND agent_type = ? ORDER BY created_at DESC LIMIT ?',
    )
    this.stmtDeleteAgentLogsByProject = db.prepare(
      'DELETE FROM novel_agent_logs WHERE project_id = ?',
    )
  }

  listMarkers(projectId: string): NovelMarker[] {
    return (this.stmtListMarkers.all(projectId) as MarkerRow[]).map((r) => this.rowToMarker(r))
  }

  getMarker(markerId: string): NovelMarker | undefined {
    const row = this.db.prepare('SELECT * FROM novel_markers WHERE id = ?').get(markerId) as MarkerRow | undefined
    return row ? this.rowToMarker(row) : undefined
  }

  createMarker(marker: Omit<NovelMarker, 'createdAt' | 'updatedAt'>): NovelMarker {
    const ts = now()
    const full: NovelMarker = { ...marker, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_markers (id, project_id, chapter, title, note, type, color, entity_type, entity_id, created_at, updated_at)
      VALUES (@id, @project_id, @chapter, @title, @note, @type, @color, @entity_type, @entity_id, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter: full.chapter,
      title: bindString(full.title), note: bindString(full.note),
      type: full.type, color: full.color,
      entity_type: full.entityType ?? null, entity_id: full.entityId ?? null,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateMarker(id: string, patch: Partial<NovelMarker>): NovelMarker | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_markers WHERE id = ?').get(id) as MarkerRow | undefined
    if (!existing) return undefined
    const current = this.rowToMarker(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_markers SET chapter=@chapter, title=@title, note=@note,
      type=@type, color=@color, entity_type=@entity_type, entity_id=@entity_id, updated_at=@updated_at WHERE id=@id
    `).run({
      id, chapter: updated.chapter, title: bindString(updated.title), note: bindString(updated.note),
      type: updated.type, color: updated.color,
      entity_type: updated.entityType ?? null, entity_id: updated.entityId ?? null,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteMarker(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_markers WHERE id = ?').run(id)
    return result.changes > 0
  }

  listEdges(projectId: string): NovelEdge[] {
    return (this.stmtListEdges.all(projectId) as EdgeRow[]).map((r) => this.rowToEdge(r))
  }

  createEdge(
    projectId: string,
    data: Omit<NovelEdge, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'auto'> & { auto?: boolean },
  ): NovelEdge {
    const id = randomUUID()
    const ts = now()
    const auto = data.auto ? 1 : 0
    const full: NovelEdge = {
      id,
      projectId,
      sourceId: data.sourceId,
      sourceType: data.sourceType,
      targetId: data.targetId,
      targetType: data.targetType,
      edgeType: data.edgeType,
      label: data.label ?? '',
      auto: auto === 1,
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.prepare(`
      INSERT INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type,
      edge_type, label, auto, created_at, updated_at)
      VALUES (@id, @project_id, @source_id, @source_type, @target_id, @target_type,
      @edge_type, @label, @auto, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId,
      source_id: full.sourceId, source_type: full.sourceType,
      target_id: full.targetId, target_type: full.targetType,
      edge_type: full.edgeType, label: full.label, auto,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  deleteEdge(id: string): boolean {
    const result = this.stmtDeleteEdge.run(id)
    return result.changes > 0
  }

  deleteEdgesByEntity(entityId: string): number {
    const result = this.stmtDeleteEdgesByEntity.run(entityId, entityId)
    return result.changes
  }

  listEdgesByEntity(entityId: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }): NovelEdge[] {
    const direction = opts?.direction ?? 'both'
    const edgeType = opts?.edgeType
    const rows: EdgeRow[] = []

    if (direction === 'source' || direction === 'both') {
      let sql = 'SELECT * FROM novel_edges WHERE source_id = ?'
      const params: (string)[] = [entityId]
      if (edgeType) { sql += ' AND edge_type = ?'; params.push(edgeType) }
      sql += ' ORDER BY created_at ASC'
      rows.push(...(this.db.prepare(sql).all(...params) as EdgeRow[]))
    }
    if (direction === 'target' || direction === 'both') {
      let sql = 'SELECT * FROM novel_edges WHERE target_id = ?'
      const params: (string)[] = [entityId]
      if (edgeType) { sql += ' AND edge_type = ?'; params.push(edgeType) }
      sql += ' ORDER BY created_at ASC'
      rows.push(...(this.db.prepare(sql).all(...params) as EdgeRow[]))
    }

    // 去重（both 模式下同一边可能被 source 和 target 各查一次）
    const seen = new Set<string>()
    const deduped: EdgeRow[] = []
    for (const r of rows) {
      if (!seen.has(r.id)) { seen.add(r.id); deduped.push(r) }
    }
    return deduped.map((r) => this.rowToEdge(r))
  }

  updateEdgeLabel(edgeId: string, label: string): NovelEdge | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_edges WHERE id = ?').get(edgeId) as EdgeRow | undefined
    if (!existing) return undefined
    const ts = now()
    this.db.prepare('UPDATE novel_edges SET label = ?, updated_at = ? WHERE id = ?').run(label, ts, edgeId)
    return { ...this.rowToEdge(existing), label, updatedAt: ts }
  }

  listNodePositions(projectId: string): NovelNodePosition[] {
    return (this.stmtListNodePositions.all(projectId) as NodePositionRow[]).map((r) => this.rowToNodePosition(r))
  }

  upsertNodePosition(
    projectId: string,
    nodeType: NovelNodeType,
    entityId: string,
    posX: number,
    posY: number,
  ): NovelNodePosition {
    const id = `${nodeType}:${entityId}`
    const updatedAt = now()
    this.stmtUpsertNodePosition.run({
      id, project_id: projectId, node_type: nodeType, entity_id: entityId,
      pos_x: posX, pos_y: posY, updated_at: updatedAt,
    })
    return { id, projectId, nodeType, entityId, posX, posY, updatedAt }
  }

  deleteNodePosition(projectId: string, nodeType: NovelNodeType, entityId: string): boolean {
    const result = this.stmtDeleteNodePosition.run(projectId, nodeType, entityId)
    return result.changes > 0
  }

  /**
   * 写入 Agent 调用日志。
   *
   * `opts.externalizePayload` 未显式指定时，由项目级 flag `logPayloadExternalized`
   * 驱动（默认关）：开启后主表只写元数据 + payload_id，大文本 gzip 写 payload 表；
   * 关闭时保持现状（全量写主表）。
   */
  insertAgentLog(
    input: Omit<NovelAgentLog, 'id' | 'createdAt'>,
    opts?: InsertAgentLogOptions,
  ): NovelAgentLog {
    const externalize = opts?.externalizePayload
      ?? (this.flags
        ? isNovelFeatureEnabled(this.flags, input.projectId, 'logPayloadExternalized')
        : false)
    const id = randomUUID()
    const createdAt = now()
    const full: NovelAgentLog = { ...input, id, createdAt }

    const payloadId = externalize ? id : null
    const base = {
      id: full.id,
      project_id: full.projectId,
      chapter_number: full.chapterNumber,
      agent_type: full.agentType,
      agent_name: full.agentName,
      display_agent_type: full.displayAgentType,
      display_agent_name: full.displayAgentName,
      phase: full.phase,
      // 外置时大文本列写空串，体积由 payload 表承担（主表行体积下降 ≥ 80% 指标）
      system_prompt: externalize ? '' : full.systemPrompt,
      chapter_context: externalize ? '' : full.chapterContext,
      user_message: externalize ? '' : full.userMessage,
      task_input: externalize ? '' : full.taskInput,
      user_instructions: externalize ? '[]' : JSON.stringify(full.userInstructions ?? []),
      tools: externalize ? '[]' : JSON.stringify(full.tools ?? []),
      tool_names: JSON.stringify(full.toolNames ?? []),
      result: externalize ? '' : full.result,
      result_length: full.resultLength,
      duration_ms: full.durationMs,
      status: full.status,
      error: externalize ? '' : full.error,
      session_id: full.sessionId,
      parent_log_id: full.parentLogId ?? null,
      operation: full.operation ?? '',
      created_at: full.createdAt,
      input_tokens: full.inputTokens ?? 0,
      output_tokens: full.outputTokens ?? 0,
      cache_read_tokens: full.cacheReadTokens ?? 0,
      cache_write_tokens: full.cacheWriteTokens ?? 0,
      llm_provider: full.llmProvider ?? '',
      llm_model: full.llmModel ?? '',
      payload_messages_chars: full.payloadMessagesChars ?? 0,
      payload_tools_chars: full.payloadToolsChars ?? 0,
      payload_tool_count: full.payloadToolCount ?? 0,
      payload_total_chars: full.payloadTotalChars ?? 0,
      llm_round_trips: full.llmRoundTrips ?? 0,
      ask_story_policy: full.askStoryPolicy ?? 'legacy',
      ask_story_enabled: (full.askStoryEnabled ?? true) ? 1 : 0,
      payload_id: payloadId,
    }

    this.db.transaction(() => {
      this.stmtInsertAgentLog.run(base)
      if (externalize && payloadId) {
        const payloadFields: PayloadFields = {
          systemPrompt: full.systemPrompt,
          chapterContext: full.chapterContext,
          userMessage: full.userMessage,
          taskInput: full.taskInput,
          userInstructions: full.userInstructions ?? [],
          tools: full.tools ?? [],
          result: full.result,
          error: full.error,
        }
        const expiresAt = computeExpiresAt(createdAt, full.status)
        this.stmtInsertAgentLogPayload.run({
          id: payloadId,
          agent_log_id: id,
          compression: 'gzip',
          system_prompt_blob: payloadFields.systemPrompt ? gzipText(payloadFields.systemPrompt) : null,
          chapter_context_blob: payloadFields.chapterContext ? gzipText(payloadFields.chapterContext) : null,
          user_message_blob: payloadFields.userMessage ? gzipText(payloadFields.userMessage) : null,
          task_input_blob: payloadFields.taskInput ? gzipText(payloadFields.taskInput) : null,
          user_instructions_blob: Array.isArray(payloadFields.userInstructions) && payloadFields.userInstructions.length > 0
            ? gzipText(JSON.stringify(payloadFields.userInstructions))
            : null,
          tools_blob: Array.isArray(payloadFields.tools) && payloadFields.tools.length > 0
            ? gzipText(JSON.stringify(payloadFields.tools))
            : null,
          result_blob: payloadFields.result ? gzipText(payloadFields.result) : null,
          error_blob: payloadFields.error ? gzipText(payloadFields.error) : null,
          content_hash: hashPayloadFields(payloadFields),
          expires_at: expiresAt,
          created_at: createdAt,
        })
      }
    })()
    return full
  }

  /**
   * 读取单条日志详情。
   *
   * `opts.loadPayload`（默认 true）：当主行存在 payload_id 时，解压 payload 表
   * 补全大文本字段；`loadPayload=false` 时大文本字段以主表旧列兜底（外置行得到空串）。
   * 旧行（无 payload_id）直接读主表，行为与迁移前一致。
   */
  getAgentLog(id: string, opts?: { loadPayload?: boolean }): NovelAgentLog | undefined {
    const row = this.stmtGetAgentLog.get(id) as AgentLogRow | undefined
    if (!row) return undefined
    const log = this.rowToAgentLog(row)
    if (row.payload_id && opts?.loadPayload !== false) {
      const payloadRow = this.stmtGetAgentLogPayload.get(id) as
        | {
            compression: string
            system_prompt_blob: Buffer | null
            chapter_context_blob: Buffer | null
            user_message_blob: Buffer | null
            task_input_blob: Buffer | null
            user_instructions_blob: Buffer | null
            tools_blob: Buffer | null
            result_blob: Buffer | null
            error_blob: Buffer | null
            content_hash: string
          }
        | undefined
      if (payloadRow) {
        const decompress = (blob: Buffer | null): string => (blob ? gunzipBlob(blob) : '')
        log.systemPrompt = decompress(payloadRow.system_prompt_blob) || log.systemPrompt
        log.chapterContext = decompress(payloadRow.chapter_context_blob) || log.chapterContext
        log.userMessage = decompress(payloadRow.user_message_blob) || log.userMessage
        log.taskInput = decompress(payloadRow.task_input_blob) || log.taskInput
        log.result = decompress(payloadRow.result_blob) || log.result
        log.error = decompress(payloadRow.error_blob) || log.error
        const instructions = decompress(payloadRow.user_instructions_blob)
        if (instructions) log.userInstructions = parseJSON<string[]>(instructions, [])
        const tools = decompress(payloadRow.tools_blob)
        if (tools) log.tools = parseJSON<unknown[]>(tools, [])
      }
    }
    return log
  }

  listAgentLogs(
    projectId: string,
    filter?: { chapterNumber?: number; agentType?: string },
    limit = 100,
  ): NovelAgentLogSummary[] {
    const effectiveLimit = Math.min(Math.max(limit, 1), 500)
    let rows: AgentLogRow[]
    if (filter?.chapterNumber != null) {
      rows = this.stmtListAgentLogsByChapter.all(projectId, filter.chapterNumber, effectiveLimit) as AgentLogRow[]
    } else if (filter?.agentType) {
      rows = this.stmtListAgentLogsByAgent.all(projectId, filter.agentType, effectiveLimit) as AgentLogRow[]
    } else {
      rows = this.stmtListAgentLogsByProject.all(projectId, effectiveLimit) as AgentLogRow[]
    }
    return rows.map((r) => this.rowToAgentLogSummary(r))
  }

  listAgentLogsByProject(projectId: string, limit: number): NovelAgentLog[] {
    const effectiveLimit = Math.min(Math.max(limit, 1), 500)
    const rows = this.stmtListAgentLogsByProject.all(projectId, effectiveLimit) as AgentLogRow[]
    return rows.map((r) => this.rowToAgentLog(r))
  }

  deleteAgentLogsByProject(projectId: string): number {
    const result = this.stmtDeleteAgentLogsByProject.run(projectId)
    return result.changes
  }

  // ── Agent 日志 payload 清理（P1-2 保留策略）──

  /**
   * 按保留策略清理过期 payload（元数据不删）。
   * @param nowMs 当前时间（毫秒），缺省取系统时间；测试可注入
   * @returns deleted=删除行数，scanned=已到期候选行数
   */
  cleanupExpiredPayloads(nowMs?: number): { deleted: number; scanned: number } {
    const ts = nowMs != null ? Math.floor(nowMs / 1000) : now()
    const scanned = (this.stmtCountExpiredPayloads.get(ts) as { n: number }).n
    const result = this.stmtDeleteExpiredPayloads.run(ts)
    return { deleted: result.changes, scanned }
  }

  // ── Context section 度量（P0-1，独立表 087b）──

  insertContextSectionMetrics(rows: ContextSectionMetricInput[]): void {
    if (rows.length === 0) return
    this.db.transaction(() => {
      for (const row of rows) {
        this.stmtInsertContextSectionMetric.run({
          id: randomUUID(),
          agent_log_id: row.agentLogId,
          project_id: row.projectId,
          chapter_number: row.chapterNumber,
          agent_type: row.agentType,
          section_type: row.sectionType,
          section_id: row.sectionId,
          chars: row.chars,
          estimated_tokens: row.estimatedTokens,
          source_hash: row.sourceHash,
          mode: row.mode,
          created_at: now(),
        })
      }
    })()
  }

  listContextSectionMetrics(projectId: string, chapterNumber?: number): ContextSectionMetric[] {
    const rows = (chapterNumber != null
      ? this.db.prepare(
        `SELECT * FROM novel_context_section_metrics WHERE project_id = ? AND chapter_number = ? ORDER BY created_at ASC`,
      ).all(projectId, chapterNumber)
      : this.db.prepare(
        `SELECT * FROM novel_context_section_metrics WHERE project_id = ? ORDER BY created_at ASC`,
      ).all(projectId)) as Array<{
        id: string
        agent_log_id: string
        project_id: string
        chapter_number: number
        agent_type: string
        section_type: string
        section_id: string
        chars: number
        estimated_tokens: number
        source_hash: string
        mode: string
        created_at: number
      }>
    return rows.map((r) => ({
      id: r.id,
      agentLogId: r.agent_log_id,
      projectId: r.project_id,
      chapterNumber: r.chapter_number,
      agentType: r.agent_type,
      sectionType: r.section_type as ContextSectionMetric['sectionType'],
      sectionId: r.section_id,
      chars: r.chars,
      estimatedTokens: r.estimated_tokens,
      sourceHash: r.source_hash,
      mode: r.mode as ContextSectionMetric['mode'],
      createdAt: r.created_at,
    }))
  }

  // ── Review（AuthorIntent / ChapterReview）── 由 ReviewStore 合并而来

  createAuthorIntent(intent: Omit<NovelAuthorIntent, 'createdAt'>): NovelAuthorIntent {
    const ts = now()
    const full: NovelAuthorIntent = { ...intent, createdAt: ts }
    this.db.prepare(`
      INSERT INTO novel_author_intents (id, project_id, chapter_id, intent_type, description, target_entity_id, created_at)
      VALUES (@id, @project_id, @chapter_id, @intent_type, @description, @target_entity_id, @created_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter_id: full.chapterId,
      intent_type: full.intentType, description: full.description,
      target_entity_id: full.targetEntityId, created_at: full.createdAt,
    })
    return full
  }

  createChapterReview(review: Omit<NovelChapterReview, 'createdAt'>): NovelChapterReview {
    const ts = now()
    const full: NovelChapterReview = { ...review, createdAt: ts }
    this.db.prepare(`
      INSERT INTO novel_chapter_reviews (id, project_id, chapter_id, consistency_score, character_score,
      task_completion_score, clue_progress_score, foreshadow_status_score, conflict_change_score,
      pacing_score, info_control_score, reader_hook_score, style_score, overall_score, verdict,
      issues, suggestions, reviewed_by, created_at)
      VALUES (@id, @project_id, @chapter_id, @consistency_score, @character_score,
      @task_completion_score, @clue_progress_score, @foreshadow_status_score, @conflict_change_score,
      @pacing_score, @info_control_score, @reader_hook_score, @style_score, @overall_score, @verdict,
      @issues, @suggestions, @reviewed_by, @created_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter_id: full.chapterId,
      consistency_score: full.consistencyScore, character_score: full.characterScore,
      task_completion_score: full.taskCompletionScore, clue_progress_score: full.clueProgressScore,
      foreshadow_status_score: full.foreshadowStatusScore, conflict_change_score: full.conflictChangeScore,
      pacing_score: full.pacingScore, info_control_score: full.infoControlScore,
      reader_hook_score: full.readerHookScore, style_score: full.styleScore,
      overall_score: full.overallScore, verdict: full.verdict,
      issues: full.issues, suggestions: full.suggestions, reviewed_by: full.reviewedBy,
      created_at: full.createdAt,
    })
    return full
  }

  getChapterReview(chapterId: string): NovelChapterReview | undefined {
    const row = this.db.prepare('SELECT * FROM novel_chapter_reviews WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1').get(chapterId) as ChapterReviewRow | undefined
    return row ? this.rowToChapterReview(row) : undefined
  }

  private rowToChapterReview(row: ChapterReviewRow): NovelChapterReview {
    return {
      id: row.id, projectId: row.project_id, chapterId: row.chapter_id,
      consistencyScore: row.consistency_score, characterScore: row.character_score,
      taskCompletionScore: row.task_completion_score, clueProgressScore: row.clue_progress_score,
      foreshadowStatusScore: row.foreshadow_status_score, conflictChangeScore: row.conflict_change_score,
      pacingScore: row.pacing_score, infoControlScore: row.info_control_score,
      readerHookScore: row.reader_hook_score, styleScore: row.style_score,
      overallScore: row.overall_score, verdict: row.verdict as NovelChapterReview['verdict'],
      issues: row.issues, suggestions: row.suggestions, reviewedBy: row.reviewed_by,
      createdAt: row.created_at,
    }
  }

  private rowToMarker(row: MarkerRow): NovelMarker {
    return {
      id: row.id, projectId: row.project_id, chapter: row.chapter,
      title: row.title, note: row.note,
      type: row.type as NovelMarker['type'],
      color: row.color as NovelMarker['color'],
      entityType: row.entity_type ?? null,
      entityId: row.entity_id ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToEdge(row: EdgeRow): NovelEdge {
    return {
      id: row.id, projectId: row.project_id,
      sourceId: row.source_id, sourceType: row.source_type as NovelEdge['sourceType'],
      targetId: row.target_id, targetType: row.target_type as NovelEdge['targetType'],
      edgeType: row.edge_type as NovelEdge['edgeType'],
      label: row.label, auto: row.auto === 1,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToNodePosition(row: NodePositionRow): NovelNodePosition {
    return {
      id: row.id, projectId: row.project_id,
      nodeType: row.node_type as NovelNodePosition['nodeType'],
      entityId: row.entity_id, posX: row.pos_x, posY: row.pos_y,
      updatedAt: row.updated_at,
    }
  }

  private rowToAgentLog(row: AgentLogRow): NovelAgentLog {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      agentType: row.agent_type,
      agentName: row.agent_name,
      displayAgentType: row.display_agent_type,
      displayAgentName: row.display_agent_name,
      phase: row.phase,
      systemPrompt: row.system_prompt,
      chapterContext: row.chapter_context,
      userMessage: row.user_message,
      taskInput: row.task_input,
      userInstructions: parseJSON<string[]>(row.user_instructions, []),
      tools: parseJSON<unknown[]>(row.tools, []),
      toolNames: parseJSON<string[]>(row.tool_names, []),
      result: row.result,
      resultLength: row.result_length,
      durationMs: row.duration_ms,
      status: row.status as NovelAgentLogStatus,
      error: row.error,
      sessionId: row.session_id,
      parentLogId: row.parent_log_id ?? null,
      operation: row.operation ?? '',
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
      llmProvider: row.llm_provider ?? '',
      llmModel: row.llm_model ?? '',
      payloadMessagesChars: row.payload_messages_chars ?? 0,
      payloadToolsChars: row.payload_tools_chars ?? 0,
      payloadToolCount: row.payload_tool_count ?? 0,
      payloadTotalChars: row.payload_total_chars ?? 0,
      llmRoundTrips: row.llm_round_trips ?? 0,
      askStoryPolicy: (row.ask_story_policy ?? 'legacy') as NovelAgentLog['askStoryPolicy'],
      askStoryEnabled: row.ask_story_enabled == null ? true : row.ask_story_enabled === 1,
      createdAt: row.created_at,
    }
  }

  private rowToAgentLogSummary(row: AgentLogRow): NovelAgentLogSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      agentType: row.agent_type,
      agentName: row.agent_name,
      displayAgentType: row.display_agent_type,
      displayAgentName: row.display_agent_name,
      phase: row.phase,
      systemPromptLength: row.system_prompt.length,
      chapterContextLength: row.chapter_context?.length ?? 0,
      userMessageLength: row.user_message.length,
      toolNames: parseJSON<string[]>(row.tool_names, []),
      resultLength: row.result_length,
      durationMs: row.duration_ms,
      status: row.status as NovelAgentLogStatus,
      error: row.error,
      parentLogId: row.parent_log_id ?? null,
      operation: row.operation ?? '',
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
      llmProvider: row.llm_provider ?? '',
      llmModel: row.llm_model ?? '',
      payloadMessagesChars: row.payload_messages_chars ?? 0,
      payloadToolsChars: row.payload_tools_chars ?? 0,
      payloadToolCount: row.payload_tool_count ?? 0,
      payloadTotalChars: row.payload_total_chars ?? 0,
      llmRoundTrips: row.llm_round_trips ?? 0,
      askStoryPolicy: (row.ask_story_policy ?? 'legacy') as NovelAgentLogSummary['askStoryPolicy'],
      askStoryEnabled: row.ask_story_enabled == null ? true : row.ask_story_enabled === 1,
      createdAt: row.created_at,
    }
  }
}
