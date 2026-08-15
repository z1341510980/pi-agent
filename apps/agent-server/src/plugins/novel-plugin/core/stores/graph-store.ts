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
  gzipText,
  gunzipBlob,
  hashPayloadFields,
  computeExpiresAt,
  PAYLOAD_BLOB_COLUMNS,
  type PayloadFields,
} from '../analysis/log-payload-service.js'
import type {
  ContextSectionMetric,
  ContextSectionMetricInput,
} from '../prompting/context-section-metrics.js'
import { createNovelDrizzleDb, GraphRepository } from '../../infrastructure/sqlite/index.js'


export class GraphStore {
  private readonly repository: GraphRepository
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

  constructor(
    private db: Database.Database,
  ) {
    this.repository = new GraphRepository(createNovelDrizzleDb(db))

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
        ask_story_policy, ask_story_enabled, payload_id,
        cache_key, cache_protocol, request_fingerprint,
        cacheable_prefix_chars, data_quality, error_code
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
        @ask_story_policy, @ask_story_enabled, @payload_id,
        @cache_key, @cache_protocol, @request_fingerprint,
        @cacheable_prefix_chars, @data_quality, @error_code
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
    return this.repository.listMarkers(projectId).map((r) => this.rowToMarker(r))
  }

  getMarker(markerId: string): NovelMarker | undefined {
    const row = this.repository.getMarker(markerId)
    return row ? this.rowToMarker(row) : undefined
  }

  createMarker(marker: Omit<NovelMarker, 'createdAt' | 'updatedAt'>): NovelMarker {
    const ts = now()
    const full: NovelMarker = { ...marker, createdAt: ts, updatedAt: ts }
    this.repository.insertMarker({
      id: full.id, project_id: full.projectId, chapter: full.chapter,
      title: bindString(full.title), note: bindString(full.note), type: full.type, color: full.color,
      entity_type: full.entityType ?? null, entity_id: full.entityId ?? null,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateMarker(id: string, patch: Partial<NovelMarker>): NovelMarker | undefined {
    const existing = this.repository.getMarker(id)
    if (!existing) return undefined
    const current = this.rowToMarker(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.repository.updateMarker(id, {
      id, project_id: updated.projectId, chapter: updated.chapter,
      title: bindString(updated.title), note: bindString(updated.note), type: updated.type, color: updated.color,
      entity_type: updated.entityType ?? null, entity_id: updated.entityId ?? null,
      created_at: updated.createdAt, updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteMarker(id: string): boolean {
    return this.repository.deleteMarker(id)
  }

  listEdges(projectId: string): NovelEdge[] {
    return this.repository.listEdges(projectId).map((r) => this.rowToEdge(r))
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
    this.repository.insertEdge({
      id: full.id, project_id: full.projectId,
      source_id: full.sourceId, source_type: full.sourceType,
      target_id: full.targetId, target_type: full.targetType,
      edge_type: full.edgeType, label: full.label, auto,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  deleteEdge(id: string): boolean {
    return this.repository.deleteEdge(id)
  }

  deleteEdgesByEntity(entityId: string): number {
    return this.repository.deleteEdgesByEntity(entityId)
  }

  listEdgesByEntity(entityId: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }): NovelEdge[] {
    return this.repository.listEdgesByEntity(entityId, opts).map((r) => this.rowToEdge(r))
  }

  updateEdgeLabel(edgeId: string, label: string): NovelEdge | undefined {
    const ts = now()
    const updated = this.repository.updateEdgeLabel(edgeId, label, ts)
    return updated ? this.rowToEdge(updated) : undefined
  }

  listNodePositions(projectId: string): NovelNodePosition[] {
    return this.repository.listNodePositions(projectId).map((r) => this.rowToNodePosition(r))
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
    this.repository.upsertNodePosition({
      id, project_id: projectId, node_type: nodeType, entity_id: entityId,
      pos_x: posX, pos_y: posY, updated_at: updatedAt,
    })
    return { id, projectId, nodeType, entityId, posX, posY, updatedAt }
  }

  deleteNodePosition(projectId: string, nodeType: NovelNodeType, entityId: string): boolean {
    return this.repository.deleteNodePosition(projectId, nodeType, entityId)
  }

  /**
   * 写入 Agent 调用日志。
   *
   * 日志大文本一律 gzip 外置到 payload 表（冷热分离）：主表只存元数据 + payload_id，
   * 读取时按 payload_id 合并回读；旧行（无 payload_id）直接读主表，行为与迁移前一致。
   */
  insertAgentLog(
    input: Omit<NovelAgentLog, 'id' | 'createdAt'>,
  ): NovelAgentLog {
    const id = randomUUID()
    const createdAt = now()
    const full: NovelAgentLog = { ...input, id, createdAt }

    const payloadId = id
    const base = {
      id: full.id,
      project_id: full.projectId,
      chapter_number: full.chapterNumber,
      agent_type: full.agentType,
      agent_name: full.agentName,
      display_agent_type: full.displayAgentType,
      display_agent_name: full.displayAgentName,
      phase: full.phase,
      // 外置：大文本列写空串，体积由 payload 表承担（主表行体积下降 ≥ 80% 指标）
      system_prompt: '',
      chapter_context: '',
      user_message: '',
      task_input: '',
      user_instructions: '[]',
      tools: '[]',
      tool_names: JSON.stringify(full.toolNames ?? []),
      result: '',
      result_length: full.resultLength,
      duration_ms: full.durationMs,
      status: full.status,
      error: '',
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
      cache_key: full.cacheKey ?? null,
      cache_protocol: full.cacheProtocol ?? null,
      request_fingerprint: full.requestFingerprint ?? null,
      cacheable_prefix_chars: full.cacheablePrefixChars ?? null,
      data_quality: full.dataQuality ?? null,
      error_code: full.errorCode ?? null,
    }

    this.db.transaction(() => {
      this.stmtInsertAgentLog.run(base)
      {
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
    this.repository.insertContextMetrics(rows.map((row) => ({ id: randomUUID(), agentLogId: row.agentLogId, projectId: row.projectId, chapterNumber: row.chapterNumber, agentType: row.agentType, sectionType: row.sectionType, sectionId: row.sectionId, chars: row.chars, estimatedTokens: row.estimatedTokens, sourceHash: row.sourceHash, mode: row.mode, createdAt: now() })))
  }

  listContextSectionMetrics(projectId: string, chapterNumber?: number): ContextSectionMetric[] {
    const rows = this.repository.listContextMetrics(projectId, chapterNumber)
    return rows.map((r) => ({
      id: r.id,
      agentLogId: r.agentLogId,
      projectId: r.projectId,
      chapterNumber: r.chapterNumber,
      agentType: r.agentType,
      sectionType: r.sectionType as ContextSectionMetric['sectionType'],
      sectionId: r.sectionId,
      chars: r.chars,
      estimatedTokens: r.estimatedTokens,
      sourceHash: r.sourceHash,
      mode: r.mode as ContextSectionMetric['mode'],
      createdAt: r.createdAt,
    }))
  }

  // ── Review（AuthorIntent / ChapterReview）── 由 ReviewStore 合并而来

  createAuthorIntent(intent: Omit<NovelAuthorIntent, 'createdAt'>): NovelAuthorIntent {
    const ts = now()
    const full: NovelAuthorIntent = { ...intent, createdAt: ts }
    this.repository.insertAuthorIntent({ id: full.id, project_id: full.projectId, chapter_id: full.chapterId, intent_type: full.intentType, description: full.description, target_entity_id: full.targetEntityId, created_at: full.createdAt })
    return full
  }

  createChapterReview(review: Omit<NovelChapterReview, 'createdAt'>): NovelChapterReview {
    const ts = now()
    const full: NovelChapterReview = { ...review, createdAt: ts }
    this.repository.insertChapterReview({ id: full.id, project_id: full.projectId, chapter_id: full.chapterId, consistency_score: full.consistencyScore, character_score: full.characterScore, task_completion_score: full.taskCompletionScore, clue_progress_score: full.clueProgressScore, foreshadow_status_score: full.foreshadowStatusScore, conflict_change_score: full.conflictChangeScore, pacing_score: full.pacingScore, info_control_score: full.infoControlScore, reader_hook_score: full.readerHookScore, style_score: full.styleScore, overall_score: full.overallScore, verdict: full.verdict, issues: full.issues, suggestions: full.suggestions, reviewed_by: full.reviewedBy, content_revision_id: full.contentRevisionId, content_hash: full.contentHash, created_at: full.createdAt })
    return full
  }

  getChapterReview(chapterId: string): NovelChapterReview | undefined {
    const row = this.repository.getLatestChapterReview(chapterId)
    return row ? this.rowToChapterReview(row) : undefined
  }

  getAcceptedChapterReviewForContent(chapterId: string, contentHash: string): NovelChapterReview | undefined {
    const row = this.repository.getAcceptedChapterReview(chapterId, contentHash)
    return row ? this.rowToChapterReview(row) : undefined
  }

  bindChapterReviewsToRevision(chapterId: string, contentHash: string, revisionId: string): number {
    return this.repository.bindChapterReviews(chapterId, contentHash, revisionId)
  }

  private rowToChapterReview(row: ChapterReviewRow): NovelChapterReview {
    return {
      id: row.id, projectId: row.project_id, chapterId: row.chapter_id,
      contentRevisionId: row.content_revision_id, contentHash: row.content_hash,
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
      cacheKey: row.cache_key ?? null,
      cacheProtocol: row.cache_protocol ?? null,
      requestFingerprint: row.request_fingerprint ?? null,
      cacheablePrefixChars: row.cacheable_prefix_chars ?? null,
      dataQuality: row.data_quality ?? null,
      errorCode: row.error_code ?? null,
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
      cacheKey: row.cache_key ?? null,
      cacheProtocol: row.cache_protocol ?? null,
      requestFingerprint: row.request_fingerprint ?? null,
      cacheablePrefixChars: row.cacheable_prefix_chars ?? null,
      dataQuality: row.data_quality ?? null,
      errorCode: row.error_code ?? null,
      createdAt: row.created_at,
    }
  }
}
