import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { novelMigrations } from '../novel-migrations.js'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { TimelineRebuildRunner } from '../core/analysis/timeline-rebuild-runner.js'
import type { TimelineRebuildJob } from '../core/analysis/timeline-consistency-store.js'
import type { NovelChapter } from '../core/types.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function createProject(store: NovelStore): string {
  return store.createProject({
    id: randomUUID(), title: '重放执行器测试', genre: 'test', synopsis: '', targetWords: 3000,
    currentVolume: 1, currentChapter: 3, currentStage: 'setup', status: 'active',
  }).id
}

function createChapter(store: NovelStore, projectId: string, chapterNumber: number): NovelChapter {
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber, title: `第${chapterNumber}章`,
    content: '', wordCount: 0, status: 'planned', narrativeTask: '', acceptanceResult: null,
  })
  store.updateChapterContent(chapter.id, `正文 ${chapterNumber}`, 4)
  return store.getChapterById(chapter.id)!
}

function recordCommittedRun(db: Database.Database, projectId: string, chapterId: string): void {
  db.prepare(`
    INSERT INTO novel_memory_operation_runs
      (id, project_id, chapter_id, source, payload_hash, status, created_at, committed_at)
    VALUES (?, ?, ?, 'test', 'hash', 'committed', 1, 1)
  `).run(randomUUID(), projectId, chapterId)
}

interface FakeSessionOptions {
  replies: Array<string | Error>
  onPrompt?: () => void
  onCreateSession?: (options: Parameters<PluginContext['createSession']>[0]) => void
}

function createFakeContext(options: FakeSessionOptions): PluginContext {
  let call = 0
  return {
    createSession: async (sessionOptions: Parameters<PluginContext['createSession']>[0]) => {
      options.onCreateSession?.(sessionOptions)
      return {
        promptStream: async () => {
          const reply = options.replies[Math.min(call, options.replies.length - 1)]
          call += 1
          options.onPrompt?.()
          if (reply instanceof Error) throw reply
          return reply
        },
        dispose: () => {},
      }
    },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  } as unknown as PluginContext
}

function setupRebuildableProject(db: Database.Database): {
  store: NovelStore
  memory: NovelMemoryStore
  projectId: string
  job: TimelineRebuildJob
  second: NovelChapter
  third: NovelChapter
} {
  const store = new NovelStore(db)
  const memory = new NovelMemoryStore(db)
  const projectId = createProject(store)
  createChapter(store, projectId, 1)
  const second = createChapter(store, projectId, 2)
  const third = createChapter(store, projectId, 3)
  recordCommittedRun(db, projectId, second.id)
  recordCommittedRun(db, projectId, third.id)
  // 起始章（第 2 章）前的全量状态快照，作为隔离重放的基线
  memory.saveSnapshot({ projectId, chapterNumber: 1, snapshotType: 'full', entityId: null, snapshotData: '{"第1章末":"基线"}' })
  store.updateChapterContent(second.id, '改写后的第 2 章正文', 8)
  const job = store.createTimelineRebuildJob(projectId, store.getTimelineRebuildPreview(projectId)!.confirmationToken)
  return { store, memory, projectId, job, second, third }
}

describe('TimelineRebuildRunner', () => {
  it('顺序隔离分析全部章节并落 analysis_phase_completed 事件', async () => {
    const db = createDb()
    const { store, memory, projectId, job } = setupRebuildableProject(db)
    const context = createFakeContext({
      replies: [
        JSON.stringify({ summary: '第 2 章重放摘要', proposedChanges: { storyEvents: [] } }),
        JSON.stringify({ summary: '第 3 章重放摘要', proposedChanges: {} }),
      ],
    })
    const runner = new TimelineRebuildRunner(context, store, memory)
    await runner.run(projectId, job.id)

    const after = store.getTimelineRebuildJob(projectId, job.id)!
    expect(after.status).toBe('running')
    expect(after.steps.map(step => step.status)).toEqual(['ready_to_apply', 'ready_to_apply'])
    expect(after.steps[0].analysis).toMatchObject({ summary: '第 2 章重放摘要' })
    expect(after.steps[1].analysis).toMatchObject({ summary: '第 3 章重放摘要' })
    // 隔离分析不写主库派生事实：invalidation 仍处于 rebuilding
    expect(store.getActiveTimelineInvalidation(projectId)!.status).toBe('rebuilding')
    expect(store.listTimelineRebuildEvents(projectId, job.id).map(event => event.type)).toEqual([
      'job_queued',
      'chapter_replay_started', 'chapter_analysis_ready',
      'chapter_replay_started', 'chapter_analysis_ready',
      'analysis_phase_completed',
    ])
    expect(runner.isRunning(job.id)).toBe(false)
    db.close()
  })

  it('使用创建重建任务时冻结的模型，而不是回退到默认模型', async () => {
    const db = createDb()
    const { store, memory, projectId, job } = setupRebuildableProject(db)
    store.cancelTimelineRebuildJob(projectId, job.id)
    store.resumeTimelineRebuildJob(projectId, job.id)
    const model = { provider: 'test-provider', modelId: 'test-model', thinkingLevel: 'high' as const }
    // 同一 invalidation 不能创建第二个 active job；将现有 job 的模型写入后验证 runner 透传。
    db.prepare('UPDATE novel_timeline_rebuild_jobs SET model_id = ? WHERE id = ?')
      .run(JSON.stringify(model), job.id)
    const selected: Array<{ provider: string; modelId: string } | undefined> = []
    const context = createFakeContext({
      replies: [
        JSON.stringify({ summary: '第 2 章', proposedChanges: {} }),
        JSON.stringify({ summary: '第 3 章', proposedChanges: {} }),
      ],
      onCreateSession: (options) => selected.push(options.modelId),
    })
    const runner = new TimelineRebuildRunner(context, store, memory)
    await runner.run(projectId, job.id)
    expect(selected).toEqual([model, model])
    db.close()
  })

  it('分析失败标记章节与 job failed，不产生后续章节分析', async () => {
    const db = createDb()
    const { store, memory, projectId, job, second } = setupRebuildableProject(db)
    const context = createFakeContext({ replies: [new Error('LLM 超时')] })
    const runner = new TimelineRebuildRunner(context, store, memory)
    await runner.run(projectId, job.id)

    const after = store.getTimelineRebuildJob(projectId, job.id)!
    expect(after.status).toBe('failed')
    expect(after.steps.find(step => step.chapterId === second.id)?.status).toBe('failed')
    expect(after.steps.find(step => step.chapterId === second.id)?.error).toContain('LLM 超时')
    expect(after.steps[1].status).toBe('pending')
    // LLM 失败只结束本次 job，不解除项目级 invalidation；前端仍可读取预览并重试。
    expect(store.getActiveTimelineInvalidation(projectId)).toMatchObject({ status: 'rebuilding' })
    expect(store.getTimelineRebuildPreview(projectId)).not.toBeNull()
    db.close()
  })

  it('resume 复位失败步骤后重新分析，已 ready 步骤不重复计费', async () => {
    const db = createDb()
    const { store, memory, projectId, job } = setupRebuildableProject(db)
    let prompts = 0
    const context = createFakeContext({
      replies: [
        new Error('LLM 超时'),
        JSON.stringify({ summary: '第 2 章重放摘要', proposedChanges: {} }),
        JSON.stringify({ summary: '第 3 章重放摘要', proposedChanges: {} }),
      ],
      onPrompt: () => { prompts += 1 },
    })
    const runner = new TimelineRebuildRunner(context, store, memory)
    await runner.run(projectId, job.id)
    expect(store.getTimelineRebuildJob(projectId, job.id)!.status).toBe('failed')

    store.resumeTimelineRebuildJob(projectId, job.id)
    await runner.run(projectId, job.id)

    const after = store.getTimelineRebuildJob(projectId, job.id)!
    expect(after.status).toBe('running')
    expect(after.steps.map(step => step.status)).toEqual(['ready_to_apply', 'ready_to_apply'])
    // 3 次 LLM 调用：失败 1 次 + 恢复后 2 章；ready 步骤在重跑时被跳过，不重复分析
    expect(prompts).toBe(3)
    db.close()
  })

  it('回滚历史版本后：有基线快照时 preview 可用且 runner 跑通（复现用户链路）', async () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    const third = createChapter(store, projectId, 3)
    recordCommittedRun(db, projectId, second.id)
    recordCommittedRun(db, projectId, third.id)
    memory.saveSnapshot({ projectId, chapterNumber: 1, snapshotType: 'full', entityId: null, snapshotData: '{"第1章末":"基线"}' })

    const v1 = store.getCurrentContentRevision(second.id)!
    store.updateChapterContent(second.id, '第二版正文', 6)
    store.rollbackToContentRevision(second.id, v1.id)

    const preview = store.getTimelineRebuildPreview(projectId)!
    expect(preview.automaticRebuildAvailable).toBe(true)
    const job = store.createTimelineRebuildJob(projectId, preview.confirmationToken)

    const context = createFakeContext({
      replies: [
        JSON.stringify({ summary: '第 2 章重放', proposedChanges: {} }),
        JSON.stringify({ summary: '第 3 章重放', proposedChanges: {} }),
      ],
    })
    const runner = new TimelineRebuildRunner(context, store, memory)
    await runner.run(projectId, job.id)
    const after = store.getTimelineRebuildJob(projectId, job.id)!
    expect(after.status).toBe('running')
    expect(after.steps.map(step => step.status)).toEqual(['ready_to_apply', 'ready_to_apply'])
    db.close()
  })

  it('缺章前快照时预览直接阻塞，不会在确认启动后秒败', async () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    const third = createChapter(store, projectId, 3)
    recordCommittedRun(db, projectId, second.id)
    recordCommittedRun(db, projectId, third.id)
    store.updateChapterContent(second.id, '改写正文', 4)
    // 不保存第 1 章快照 → 起始章 = 2 且无基线
    const preview = store.getTimelineRebuildPreview(projectId)!
    expect(preview.automaticRebuildAvailable).toBe(false)
    expect(preview.blockedReasons.join('；')).toContain('全量状态快照')
    expect(() => store.createTimelineRebuildJob(projectId, preview.confirmationToken))
      .toThrow('全量状态快照')
    expect(db.prepare('SELECT COUNT(*) AS count FROM novel_timeline_rebuild_jobs').get())
      .toEqual({ count: 0 })
    db.close()
  })
})
