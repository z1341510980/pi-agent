import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { WorkflowRunStore } from '../core/workflow-run-store.js'

function createStore(): WorkflowRunStore {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  // novel_workflow_runs.project_id 外键引用 novel_projects，先建项目行
  db.prepare(`INSERT INTO novel_projects (id, title, genre) VALUES ('p-1', '测试', 'fantasy')`).run()
  return new WorkflowRunStore(db)
}

describe('WorkflowRunStore', () => {
  it('persists and reloads a full resumable snapshot round-trip', () => {
    const store = createStore()
    store.save({
      id: 'run-1',
      projectId: 'p-1',
      chapterNumber: 3,
      status: 'error',
      phase: 'reviewing',
      failedPhase: 'reviewing',
      directorTask: {
        type: 'advance_mainline',
        description: '推进主线',
        targetEntity: null,
        priority: 'high',
      },
      directorOutput: 'director raw',
      rhythmSuggestion: {
        rhythm: 'rising',
        arcPosition: 0.4,
        reason: '主线进入加速阶段',
        description: '逐步提高压力并推进核心目标',
      },
      arrangedEntities: { characterIds: ['c-1'], conflictIds: [], foreshadowIds: [], clueIds: [], factionIds: [], locationIds: [] },
      writerDraft: '草稿正文',
      finalContent: undefined,
      modelId: { provider: 'p', modelId: 'm' },
      error: '审校失败',
    })

    const loaded = store.get('run-1')!
    expect(loaded).toMatchObject({
      id: 'run-1',
      phase: 'reviewing',
      failedPhase: 'reviewing',
      writerDraft: '草稿正文',
      modelId: { provider: 'p', modelId: 'm' },
    })
    expect(loaded.directorTask).toMatchObject({ type: 'advance_mainline' })
    expect(loaded.arrangedEntities?.characterIds).toEqual(['c-1'])
  })

  it('getLatestResumable returns the newest error/running snapshot with a phase', () => {
    const store = createStore()
    store.save({
      id: 'old', projectId: 'p-1', chapterNumber: 3, status: 'error',
      phase: 'writing', writerDraft: undefined,
    })
    store.save({
      id: 'completed', projectId: 'p-1', chapterNumber: 3, status: 'completed',
      phase: 'memory', finalContent: '正文',
    })
    store.save({
      id: 'newest', projectId: 'p-1', chapterNumber: 3, status: 'error',
      phase: 'reviewing', writerDraft: '草稿',
    })
    // 无 phase 产物（Director 即失败）不应被当作可续跑
    store.save({
      id: 'no-boundary', projectId: 'p-1', chapterNumber: 3, status: 'error',
    })

    expect(store.getLatestResumable('p-1', 3)?.id).toBe('newest')
    expect(store.getLatestResumable('p-1', 99)).toBeUndefined()
  })
})
