/**
 * ChapterChatStore：章节聊天消息存储
 *
 * 按章节持久化所有用户输入与 Agent 回复，包括：
 * - pre_creation：创作启动前用户输入的指令
 * - checkpoint：检查点反馈意见
 * - discussion：群聊过程中用户的发言
 * - free_chat：章节级自由聊天（非结构化对话）
 * - review：章节完成后回看聊天
 *
 * 工作流和群聊两种创作模式共用此存储，前端切换章节时加载历史消息。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

/** 聊天消息角色 */
export type ChapterChatRole = 'user' | 'agent' | 'system'

/** 聊天消息阶段（标识消息产生于哪种场景） */
export type ChapterChatPhase =
  | 'pre_creation'
  | 'checkpoint'
  | 'discussion'
  | 'free_chat'
  | 'review'

/** 章节聊天消息 */
export interface ChapterChatMessage {
  id: string
  projectId: string
  chapterNumber: number
  role: ChapterChatRole
  fromId: string
  fromName: string
  content: string
  phase: ChapterChatPhase
  metadata?: {
    /** 检查点 ID（phase=checkpoint 时） */
    checkpointId?: string
    /** 检查点决策（phase=checkpoint 时） */
    decision?: string
    /** Agent 类型（role=agent 时，如 'director'/'writer'/'character'） */
    agentType?: string
    /** 用户 @ 指定的 Agent ID 列表（phase=free_chat 时） */
    mentionedAgents?: string[]
    /** 创作模式（'workflow' | 'discussion'） */
    flowMode?: 'workflow' | 'discussion'
    /** 群聊运行 ID，用于区分同一章节的多次创作尝试 */
    discussionRunId?: string
    /** 群聊消息类型（member/moderator/system/run_start/run_end） */
    discussionMessageType?: string
    /** 群聊运行终态 */
    discussionRunStatus?: 'completed' | 'cancelled' | 'error'
    /** 该终态是否可从持久化快照恢复 */
    discussionCanResume?: boolean
    /** 群聊场景 ID */
    sceneId?: number
  }
  createdAt: number
}

interface ChatRow {
  id: string
  project_id: string
  chapter_number: number
  role: string
  from_id: string
  from_name: string
  content: string
  phase: string
  metadata: string | null
  created_at: number
}

export class ChapterChatStore {
  private stmtList: Database.Statement
  private stmtListByPhase: Database.Statement
  private stmtInsert: Database.Statement
  private stmtClear: Database.Statement
  private stmtClearPhase: Database.Statement

  constructor(private db: Database.Database) {
    this.stmtList = db.prepare(`
      SELECT id, project_id, chapter_number, role, from_id, from_name,
             content, phase, metadata, created_at
      FROM novel_chapter_chat_messages
      WHERE project_id = ? AND chapter_number = ?
      ORDER BY created_at ASC, rowid ASC
    `)
    this.stmtListByPhase = db.prepare(`
      SELECT id, project_id, chapter_number, role, from_id, from_name,
             content, phase, metadata, created_at
      FROM novel_chapter_chat_messages
      WHERE project_id = ? AND chapter_number = ? AND phase = ?
      ORDER BY created_at ASC, rowid ASC
    `)
    this.stmtInsert = db.prepare(`
      INSERT INTO novel_chapter_chat_messages
        (id, project_id, chapter_number, role, from_id, from_name, content, phase, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtClear = db.prepare(`
      DELETE FROM novel_chapter_chat_messages WHERE project_id = ? AND chapter_number = ?
    `)
    this.stmtClearPhase = db.prepare(`
      DELETE FROM novel_chapter_chat_messages
      WHERE project_id = ? AND chapter_number = ? AND phase = ?
    `)
  }

  /** 列出章节所有聊天消息（按时间升序） */
  list(projectId: string, chapterNumber: number): ChapterChatMessage[] {
    const rows = this.stmtList.all(projectId, chapterNumber) as ChatRow[]
    return rows.map(this.rowToMessage)
  }

  /** 列出指定阶段的消息 */
  listByPhase(projectId: string, chapterNumber: number, phase: ChapterChatPhase): ChapterChatMessage[] {
    const rows = this.stmtListByPhase.all(projectId, chapterNumber, phase) as ChatRow[]
    return rows.map(this.rowToMessage)
  }

  /** 新增单条消息 */
  add(input: Omit<ChapterChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): ChapterChatMessage {
    const id = input.id ?? randomUUID()
    const createdAt = input.createdAt ?? Date.now()
    this.stmtInsert.run(
      id,
      input.projectId,
      input.chapterNumber,
      input.role,
      input.fromId,
      input.fromName,
      input.content,
      input.phase,
      input.metadata ? JSON.stringify(input.metadata) : null,
      Math.floor(createdAt / 1000),
    )
    return { ...input, id, createdAt }
  }

  /** 批量新增（事务） */
  addMany(messages: Array<Omit<ChapterChatMessage, 'id'> & { createdAt?: number }>): void {
    const tx = this.db.transaction((msgs: typeof messages) => {
      for (const msg of msgs) this.add(msg)
    })
    tx(messages)
  }

  /** 清空章节所有聊天历史 */
  clear(projectId: string, chapterNumber: number): void {
    this.stmtClear.run(projectId, chapterNumber)
  }

  /** 清空指定阶段的消息 */
  clearPhase(projectId: string, chapterNumber: number, phase: ChapterChatPhase): void {
    this.stmtClearPhase.run(projectId, chapterNumber, phase)
  }

  private rowToMessage = (row: ChatRow): ChapterChatMessage => {
    let metadata: ChapterChatMessage['metadata']
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata)
      } catch {
        metadata = undefined
      }
    }
    return {
      id: row.id,
      projectId: row.project_id,
      chapterNumber: row.chapter_number,
      role: row.role as ChapterChatRole,
      fromId: row.from_id,
      fromName: row.from_name,
      content: row.content,
      phase: row.phase as ChapterChatPhase,
      metadata,
      createdAt: row.created_at * 1000,
    }
  }
}
