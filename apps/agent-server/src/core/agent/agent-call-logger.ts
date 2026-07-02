/**
 * AgentCallLogger：通用 Agent 调用日志记录器
 *
 * 与 EvidenceLedger（工具调用维度）互补，本类记录"Agent 调用维度"的完整上下文：
 * - 系统提示词 / 用户消息 / 任务输入 / 工具列表 / 执行结果 / 耗时 / 状态
 * - 领域扩展字段（如 projectId / chapterNumber / agentType / phase）通过 metadata JSON 列存储
 *
 * 作为 chat 底座能力，所有 Agent 调用（含 subagent / team_execute / 插件 createSession）
 * 均可通过此类统一记录。novel 等领域插件在 metadata 中携带自身扩展字段。
 *
 * 参考 ARCHITECTURE.md §9 多 Agent 协作、§22.8 EvidenceLedger。
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

/** Agent 调用日志状态 */
export type AgentCallLogStatus = 'success' | 'error' | 'timeout'

/** Agent 调用日志条目 */
export interface AgentCallLogEntry {
  /** 记录 ID */
  id: string
  /** Agent ID */
  agentId: string
  /** Agent 名称 */
  agentName: string
  /** 线程 ID（subagent session 的 threadId，可为空） */
  threadId: string
  /** 系统提示词 */
  systemPrompt: string
  /** 用户消息（任务描述） */
  userMessage: string
  /** 任务输入（原始任务输入，可能为 JSON） */
  taskInput: string
  /** 工具列表（JSON 字符串，含 name/description） */
  tools: string
  /** 工具名列表（JSON 字符串） */
  toolNames: string
  /** 执行结果文本 */
  result: string
  /** 结果长度 */
  resultLength: number
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 状态 */
  status: AgentCallLogStatus
  /** 错误信息（status != success 时） */
  error: string
  /** 领域扩展字段（JSON 字符串，如 projectId/chapterNumber/agentType/phase） */
  metadata: string
  /** 创建时间戳（unixepoch 秒） */
  createdAt: number
}

/** agent_call_logs 表行结构 */
interface AgentCallLogRow {
  id: string
  agent_id: string
  agent_name: string
  thread_id: string
  system_prompt: string
  user_message: string
  task_input: string
  tools: string
  tool_names: string
  result: string
  result_length: number
  duration_ms: number
  status: string
  error: string
  metadata: string
  created_at: number
}

/**
 * 通用 Agent 调用日志记录器
 *
 * 用法：
 * - 在 subagent-plugin 中创建实例，注入 AgentManager 与 PluginContext
 * - AgentManager.dispatchToAgent 自动调用 record 记录 subagent/team_execute 调用
 * - 领域插件（如 novel）可在自身编排流程中显式调用 record，并在 metadata 携带领域字段
 */
export class AgentCallLogger {
  private readonly db: Database.Database
  // 预编译 SQL，提升反复执行性能
  private readonly stmtInsert: Database.Statement
  private readonly stmtSelectByAgent: Database.Statement
  private readonly stmtSelectByThread: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    this.stmtInsert = this.db.prepare(`
      INSERT INTO agent_call_logs (
        id, agent_id, agent_name, thread_id,
        system_prompt, user_message, task_input,
        tools, tool_names,
        result, result_length, duration_ms, status, error,
        metadata, created_at
      ) VALUES (
        @id, @agent_id, @agent_name, @thread_id,
        @system_prompt, @user_message, @task_input,
        @tools, @tool_names,
        @result, @result_length, @duration_ms, @status, @error,
        @metadata, @created_at
      )
    `)
    this.stmtSelectByAgent = this.db.prepare(
      'SELECT * FROM agent_call_logs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    this.stmtSelectByThread = this.db.prepare(
      'SELECT * FROM agent_call_logs WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?',
    )
  }

  /**
   * 记录一次 Agent 调用
   *
   * 在 dispatchToAgent / 编排流程的 finally 块中调用，采集完整上下文。
   * 写入失败不影响主流程（调用方应 try/catch 包裹）。
   */
  record(entry: Omit<AgentCallLogEntry, 'id' | 'createdAt'>): AgentCallLogEntry {
    const id = randomUUID()
    const createdAt = Math.floor(Date.now() / 1000)
    const full: AgentCallLogEntry = { ...entry, id, createdAt }

    this.stmtInsert.run({
      id: full.id,
      agent_id: full.agentId,
      agent_name: full.agentName,
      thread_id: full.threadId,
      system_prompt: full.systemPrompt,
      user_message: full.userMessage,
      task_input: full.taskInput,
      tools: full.tools,
      tool_names: full.toolNames,
      result: full.result,
      result_length: full.resultLength,
      duration_ms: full.durationMs,
      status: full.status,
      error: full.error,
      metadata: full.metadata,
      created_at: full.createdAt,
    })

    return full
  }

  /** 按 Agent ID 查询日志 */
  listByAgent(agentId: string, limit = 100): AgentCallLogEntry[] {
    const rows = this.stmtSelectByAgent.all(agentId, limit) as AgentCallLogRow[]
    return rows.map((row) => this.rowToEntry(row))
  }

  /** 按线程 ID 查询日志 */
  listByThread(threadId: string, limit = 100): AgentCallLogEntry[] {
    const rows = this.stmtSelectByThread.all(threadId, limit) as AgentCallLogRow[]
    return rows.map((row) => this.rowToEntry(row))
  }

  /** 将数据库行转换为 AgentCallLogEntry */
  private rowToEntry(row: AgentCallLogRow): AgentCallLogEntry {
    return {
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      threadId: row.thread_id,
      systemPrompt: row.system_prompt,
      userMessage: row.user_message,
      taskInput: row.task_input,
      tools: row.tools,
      toolNames: row.tool_names,
      result: row.result,
      resultLength: row.result_length,
      durationMs: row.duration_ms,
      status: row.status as AgentCallLogStatus,
      error: row.error,
      metadata: row.metadata,
      createdAt: row.created_at,
    }
  }
}
