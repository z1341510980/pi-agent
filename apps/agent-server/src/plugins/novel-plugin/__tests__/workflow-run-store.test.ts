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

  it('reconcileOrphanRunning marks crash-orphaned running rows as error and keeps them resumable', () => {
    const store = createStore()
    // 孤儿：running + 有阶段产物（进程重启残留）
    store.save({ id: 'orphan', projectId: 'p-1', chapterNumber: 3, status: 'running', phase: 'reviewing', writerDraft: '草稿' })
    // 孤儿：running 但无 phase（Director 即死，不可续跑）
    store.save({ id: 'orphan-no-boundary', projectId: 'p-1', chapterNumber: 3, status: 'running' })
    // 终态行不应被触碰
    store.save({ id: 'done', projectId: 'p-1', chapterNumber: 3, status: 'completed', phase: 'memory' })

    const changed = store.reconcileOrphanRunning('服务重启导致创作流程中断；可从断点继续')
    expect(changed).toBe(2)

    const orphan = store.get('orphan')!
    expect(orphan.status).toBe('error')
    expect(orphan.error).toBe('服务重启导致创作流程中断；可从断点继续')
    // phase 保留为续跑入口，failedPhase 回填为同一阶段
    expect(orphan.phase).toBe('reviewing')
    expect(orphan.failedPhase).toBe('reviewing')

    expect(store.get('orphan-no-boundary')!.status).toBe('error')
    expect(store.get('done')!.status).toBe('completed')

    // 回收后仍可被定位为可续跑快照
    expect(store.getLatestResumable('p-1', 3)?.id).toBe('orphan')
  })

  it('reconcileOrphanRunning does not overwrite an existing failedPhase', () => {
    const store = createStore()
    store.save({
      id: 'r', projectId: 'p-1', chapterNumber: 3, status: 'running',
      phase: 'reviewing', failedPhase: 'revising',
    })
    store.reconcileOrphanRunning('中断')
    expect(store.get('r')!.failedPhase).toBe('revising')
  })

  describe('listResumableByProject（章节视图"未完成创作"提示条）', () => {
    it('每章取最近一条可续跑快照，排除无阶段产物与已终结的行', () => {
      const store = createStore()
      store.save({ id: 'ch3-old', projectId: 'p-1', chapterNumber: 3, status: 'error', phase: 'writing' })
      store.save({ id: 'ch3-new', projectId: 'p-1', chapterNumber: 3, status: 'error', phase: 'reviewing', writerDraft: '草稿' })
      // 无阶段产物：不可续跑，不出现
      store.save({ id: 'ch5-no-boundary', projectId: 'p-1', chapterNumber: 5, status: 'error' })
      // 已完成/取消：不出现
      store.save({ id: 'ch7-done', projectId: 'p-1', chapterNumber: 7, status: 'completed', phase: 'memory' })
      store.save({ id: 'ch8-cancelled', projectId: 'p-1', chapterNumber: 8, status: 'cancelled', phase: 'reviewing' })
      // 孤儿 running（进程崩溃残留）：可续跑，出现
      store.save({ id: 'ch9-orphan', projectId: 'p-1', chapterNumber: 9, status: 'running', phase: 'writing' })

      const runs = store.listResumableByProject('p-1')
      expect(runs.map((r) => r.id)).toEqual(['ch9-orphan', 'ch3-new'])
      expect(runs.find((r) => r.id === 'ch3-new')?.writerDraft).toBe('草稿')
    })

    it('弃用（status 改为 cancelled）后退出列表', () => {
      const store = createStore()
      store.save({ id: 'stalled', projectId: 'p-1', chapterNumber: 4, status: 'error', phase: 'reviewing', writerDraft: '半成品' })
      expect(store.listResumableByProject('p-1')).toHaveLength(1)

      const snapshot = store.get('stalled')!
      store.save({ ...snapshot, status: 'cancelled' })
      expect(store.listResumableByProject('p-1')).toHaveLength(0)
    })

    it('只返回本项目的中断 run', () => {
      const db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      for (const migration of novelMigrations) db.exec(migration.sql)
      db.prepare(`INSERT INTO novel_projects (id, title, genre) VALUES ('p-1', '甲', 'fantasy')`).run()
      db.prepare(`INSERT INTO novel_projects (id, title, genre) VALUES ('p-2', '乙', 'fantasy')`).run()
      const store = new WorkflowRunStore(db)
      store.save({ id: 'mine', projectId: 'p-1', chapterNumber: 1, status: 'error', phase: 'writing' })
      store.save({ id: 'theirs', projectId: 'p-2', chapterNumber: 1, status: 'error', phase: 'writing' })

      expect(store.listResumableByProject('p-1').map((r) => r.id)).toEqual(['mine'])
    })
  })
})
