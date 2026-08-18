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
import type {
  ChapterChatMessage,
  ChapterChatRole,
  ChapterChatPhase,
  ChapterChatMetadata,
} from '@repo/shared/novel'

// 章节聊天相关类型（ChapterChatMessage/ChapterChatRole/ChapterChatPhase/ChapterChatMetadata）
// 已迁入 @repo/shared/novel 共享包，此处 re-export 供本插件内部模块沿用相对路径引入。
export type {
  ChapterChatMessage,
  ChapterChatRole,
  ChapterChatPhase,
  ChapterChatMetadata,
} from '@repo/shared/novel'

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
  private stmtFindInterject: Database.Statement
  private stmtUpdateMetadata: Database.Statement

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
    this.stmtFindInterject = db.prepare(`
      SELECT id, metadata
      FROM novel_chapter_chat_messages
      WHERE json_extract(metadata, '$.messageId') = ?
      ORDER BY rowid DESC
      LIMIT 1
    `)
    this.stmtUpdateMetadata = db.prepare(`
      UPDATE novel_chapter_chat_messages SET metadata = ? WHERE id = ?
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

  /** 按插话 messageId 持久化 queued/injected/dropped 状态。 */
  updateInterjectStatus(
    messageId: string,
    status: 'queued' | 'injected' | 'dropped',
    agentType?: string,
  ): boolean {
    const row = this.stmtFindInterject.get(messageId) as Pick<ChatRow, 'id' | 'metadata'> | undefined
    if (!row?.metadata) return false
    let metadata: ChapterChatMetadata
    try {
      metadata = JSON.parse(row.metadata) as ChapterChatMetadata
    } catch {
      return false
    }
    metadata.interjectStatus = status
    if (agentType) metadata.agentType = agentType
    return this.stmtUpdateMetadata.run(JSON.stringify(metadata), row.id).changes > 0
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
