/**
 * ProjectStore：项目 CRUD + 软删除/回收站/purge
 *
 * 从原 novel-store.ts 抽取。管理 novel_projects 表的所有操作。
 */
import type Database from 'better-sqlite3'
import type { NovelProject } from '../types.js'
import type { ProjectRow } from './row-types.js'
import { now } from './store-utils.js'

export class ProjectStore {
  private readonly stmtGetProject: Database.Statement

  constructor(private db: Database.Database) {
    this.stmtGetProject = db.prepare('SELECT * FROM novel_projects WHERE id = ? AND deleted_at IS NULL')
  }

  getProject(projectId: string): NovelProject | undefined {
    const row = this.stmtGetProject.get(projectId) as ProjectRow | undefined
    return row ? this.rowToProject(row) : undefined
  }

  createProject(project: Omit<NovelProject, 'createdAt' | 'updatedAt'>): NovelProject {
    const ts = now()
    const full: NovelProject = { outline: '', ...project, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_projects (id, title, genre, synopsis, outline, target_words, current_volume, current_chapter, current_stage, status, created_at, updated_at, target_platform, novel_ask_story_policy, feature_flags, novel_model_id)
      VALUES (@id, @title, @genre, @synopsis, @outline, @target_words, @current_volume, @current_chapter, @current_stage, @status, @created_at, @updated_at, @target_platform, @novel_ask_story_policy, @feature_flags, @novel_model_id)
    `).run({
      id: full.id, title: full.title, genre: full.genre, synopsis: full.synopsis,
      outline: full.outline ?? '',
      target_words: full.targetWords, current_volume: full.currentVolume,
      current_chapter: full.currentChapter, current_stage: full.currentStage,
      status: full.status, created_at: full.createdAt, updated_at: full.updatedAt,
      target_platform: full.targetPlatform ?? null,
      novel_ask_story_policy: full.novelAskStoryPolicy ?? null,
      feature_flags: full.flags ? JSON.stringify(full.flags) : '{}',
      novel_model_id: full.novelModelId ?? null,
    })
    return full
  }

  updateProject(id: string, patch: Partial<NovelProject>): NovelProject | undefined {
    const existing = this.getProject(id)
    if (!existing) return undefined
    const updated = { ...existing, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_projects SET title=@title, genre=@genre, synopsis=@synopsis, outline=@outline,
      target_words=@target_words, current_volume=@current_volume, current_chapter=@current_chapter,
      current_stage=@current_stage, status=@status, updated_at=@updated_at,
       target_platform=@target_platform, novel_ask_story_policy=@novel_ask_story_policy,
       feature_flags=@feature_flags, novel_model_id=@novel_model_id WHERE id=@id
    `).run({
      id, title: updated.title, genre: updated.genre, synopsis: updated.synopsis, outline: updated.outline ?? '',
      target_words: updated.targetWords, current_volume: updated.currentVolume,
      current_chapter: updated.currentChapter, current_stage: updated.currentStage,
      status: updated.status, updated_at: updated.updatedAt,
      target_platform: updated.targetPlatform ?? null,
      novel_ask_story_policy: updated.novelAskStoryPolicy ?? null,
      feature_flags: updated.flags ? JSON.stringify(updated.flags) : '{}',
      novel_model_id: updated.novelModelId ?? null,
    })
    return updated
  }

  /** 软删除：将项目移入回收站（设置 deleted_at 时间戳） */
  deleteProject(id: string): boolean {
    const result = this.db.prepare(
      'UPDATE novel_projects SET deleted_at = @ts, updated_at = @ts WHERE id = @id AND deleted_at IS NULL',
    ).run({ id, ts: now() })
    return result.changes > 0
  }

  /** 列出回收站中的项目（deleted_at 非 NULL），按移入时间倒序 */
  listTrashedProjects(): NovelProject[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    ).all() as ProjectRow[]
    return rows.map((r) => this.rowToProject(r))
  }

  /** 恢复项目：清除 deleted_at */
  restoreProject(id: string): boolean {
    const result = this.db.prepare(
      'UPDATE novel_projects SET deleted_at = NULL, updated_at = @ts WHERE id = @id AND deleted_at IS NOT NULL',
    ).run({ id, ts: now() })
    return result.changes > 0
  }

  /**
   * 永久删除：硬删除项目 + 清理无级联的关联表数据。
   * 18 张有 ON DELETE CASCADE 的表会自动清理；
   * 这里手动清理剩余 6 张无级联的表，避免孤儿数据。
   */
  purgeProject(id: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM novel_projects WHERE id = ? AND deleted_at IS NOT NULL',
    ).run(id)
    if (result.changes === 0) return false
    // 清理无 ON DELETE CASCADE 的关联表
    this.db.prepare('DELETE FROM novel_node_positions WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_character_history WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_memory_events WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_memory_snapshots WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_agent_logs WHERE project_id = ?').run(id)
    this.db.prepare('DELETE FROM novel_prompt_templates WHERE project_id = ?').run(id)
    return true
  }

  /** 清空回收站：永久删除所有 deleted_at 非 NULL 的项目 */
  emptyTrash(): number {
    const trashed = this.listTrashedProjects()
    let count = 0
    for (const p of trashed) {
      if (this.purgeProject(p.id)) count++
    }
    return count
  }

  listProjects(): NovelProject[] {
    const rows = this.db.prepare(
      'SELECT * FROM novel_projects WHERE deleted_at IS NULL ORDER BY updated_at DESC',
    ).all() as ProjectRow[]
    return rows.map((r) => this.rowToProject(r))
  }

  private rowToProject(row: ProjectRow): NovelProject {
    return {
      id: row.id, title: row.title, genre: row.genre, synopsis: row.synopsis,
      outline: row.outline,
      targetWords: row.target_words, currentVolume: row.current_volume,
      currentChapter: row.current_chapter, currentStage: row.current_stage as NovelProject['currentStage'],
      status: row.status as NovelProject['status'],
      deletedAt: row.deleted_at,
      targetPlatform: row.target_platform as NovelProject['targetPlatform'],
      novelAskStoryPolicy: row.novel_ask_story_policy as NovelProject['novelAskStoryPolicy'],
      novelModelId: row.novel_model_id ?? null,
      flags: parseFeatureFlags(row.feature_flags),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  /**
   * 项目级「创作主模型」modelId（NULL/undefined = 未设置，各 Agent 用各自配置）。
   * 设置后创作流程统一使用该模型，见 NovelProject.novelModelId 注释。
   */
  getNovelModelId(projectId: string): string | undefined {
    const row = this.stmtGetProject.get(projectId) as ProjectRow | undefined
    return row?.novel_model_id ?? undefined
  }

  updateNovelModelId(projectId: string, modelId: string | null): boolean {
    const result = this.db.prepare(
      'UPDATE novel_projects SET novel_model_id = @model_id, updated_at = @ts WHERE id = @id AND deleted_at IS NULL',
    ).run({ id: projectId, model_id: modelId, ts: now() })
    return result.changes > 0
  }
}

/** 解析 feature_flags JSON 列；缺省/空/非法 JSON 一律返回 undefined（视为全部关闭） */
function parseFeatureFlags(raw: string | undefined | null): Record<string, boolean> | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, boolean>
  } catch {
    return undefined
  }
}
