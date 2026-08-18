import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { novelMigrations } from '../novel-migrations.js'
import { NovelStore } from '../core/novel-store.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function createProject(store: NovelStore): string {
  return store.createProject({
    id: randomUUID(), title: '时间线测试', genre: 'test', synopsis: '', targetWords: 3000,
    currentVolume: 1, currentChapter: 3, currentStage: 'setup', status: 'active',
  }).id
}

function createChapter(store: NovelStore, projectId: string, chapterNumber: number) {
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber, title: `第${chapterNumber}章`,
    content: '', wordCount: 0, status: 'planned', narrativeTask: '', acceptanceResult: null,
  })
  store.updateChapterContent(chapter.id, `正文 ${chapterNumber}`, 4)
  return store.getChapterById(chapter.id)!
}

describe('TimelineConsistencyStore', () => {
  it('正文改写在同一事务内使所有派生投影 stale，并创建可审计预览', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    const first = createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    createChapter(store, projectId, 3)

    const character = store.createCharacter({
      id: randomUUID(), projectId, name: '角色', description: '', identity: '', personality: '',
      appearance: '', currentState: '', currentGoal: '', currentPressure: '', secret: '',
      arcStage: 'introduction', arcHistory: '[]', speechStyle: '', isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting', removalImpact: '',
    })
    store.createCharacterHistory({
      projectId, characterId: character.id, chapterId: second.id, chapterNumber: 2,
      fieldName: 'currentState', oldValue: '旧', newValue: '新', reason: '正文',
    })
    memory.saveSnapshot({
      projectId, chapterNumber: 2, snapshotType: 'full', entityId: null, snapshotData: '{}',
    })
    memory.recordEvent({
      projectId, chapterId: second.id, chapterNumber: 2, eventType: 'character_change',
      entityId: character.id, entityType: 'character', description: '状态变化',
      significance: 8, source: 'manual', cause: null, effectIds: [], oldValue: '旧', newValue: '新',
    })
    memory.createStoryEvent({
      projectId, chapterNumber: 2, sceneId: null, sceneOrder: 0, type: 'custom',
      title: '事件', summary: '摘要', outcome: '', status: 'confirmed',
      parentEventId: null, source: 'manual',
    })
    store.createEntityCandidate({ projectId, chapterNumber: 2, entityType: 'clue', payload: { description: '候选' } })
    store.addChapterAppearances({ projectId, chapterId: second.id, entityType: 'character', entityIds: [character.id] })

    store.updateChapterContent(second.id, '改写后的正文', 6)

    const invalidation = store.getActiveTimelineInvalidation(projectId)
    expect(invalidation).toMatchObject({ startChapterNumber: 2, status: 'pending', affectedChapters: [2, 3] })
    expect(invalidation!.staleCounts.memoryEvents).toBeGreaterThanOrEqual(1)
    expect(invalidation!.staleCounts.memorySnapshots).toBe(1)
    expect(invalidation!.staleCounts.characterHistory).toBe(1)
    expect(invalidation!.staleCounts.entityCandidates).toBe(1)
    expect(invalidation!.staleCounts.entityAppearances).toBe(1)
    expect(memory.listEvents(projectId)).toHaveLength(0)
    expect(memory.listEvents(projectId, { includeStale: true })).toHaveLength(1)
    expect(memory.listSnapshots(projectId)).toHaveLength(0)
    expect(store.listCharacterHistory(projectId)).toHaveLength(0)
    expect(store.listEntityCandidates(projectId)).toHaveLength(0)
    expect(store.listAppearancesByChapter(projectId, second.id)).toHaveLength(0)

    const preview = store.getTimelineRebuildPreview(projectId)!
    expect(preview.automaticRebuildAvailable).toBe(false)
    expect(preview.confirmationToken).toHaveLength(64)
    expect(preview.blockedReasons.length).toBeGreaterThan(0)
    expect(() => store.assertTimelineAllowsGeneration(projectId, 2)).toThrow('时间线尚未重建')
    expect(() => store.assertTimelineAllowsGeneration(projectId, 3)).toThrow('时间线尚未重建')
    expect(() => store.assertTimelineAllowsGeneration(projectId, 1)).not.toThrow()
    expect(first.content).toContain('正文 1')
    db.close()
  })

  it('重建确认 token 在影响范围变化后失效，启动不会伪造 job', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    createChapter(store, projectId, 3)
    store.updateChapterContent(second.id, '改写', 2)
    const preview = store.getTimelineRebuildPreview(projectId)!
    expect(store.verifyTimelineRebuildConfirmation(projectId, preview.confirmationToken)).not.toBeNull()
    store.updateChapterContent(second.id, '再次改写', 4)
    expect(store.verifyTimelineRebuildConfirmation(projectId, preview.confirmationToken)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM novel_timeline_rebuild_jobs').get()).toEqual({ count: 0 })
    db.close()
  })

  it('在具备不可变正文和 Memory 基线时，持久 job 强制按章节准备、应用并完成', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    const third = createChapter(store, projectId, 3)
    memory.createStoryEvent({
      projectId, chapterNumber: 2, sceneId: null, sceneOrder: 0, type: 'custom',
      title: '待重放事件', summary: '', outcome: '', status: 'confirmed', parentEventId: null, source: 'manual',
    })
    const recordCommittedRun = (chapterId: string) => db.prepare(`
      INSERT INTO novel_memory_operation_runs
        (id, project_id, chapter_id, source, payload_hash, status, created_at, committed_at)
      VALUES (?, ?, ?, 'test', 'hash', 'committed', 1, 1)
    `).run(randomUUID(), projectId, chapterId)
    recordCommittedRun(second.id)
    recordCommittedRun(third.id)
    memory.saveSnapshot({ projectId, chapterNumber: 1, snapshotType: 'full', entityId: null, snapshotData: '{}' })

    store.updateChapterContent(second.id, '改写正文', 4)
    const preview = store.getTimelineRebuildPreview(projectId)!
    expect(preview.automaticRebuildAvailable).toBe(true)
    const job = store.createTimelineRebuildJob(projectId, preview.confirmationToken)
    expect(job.status).toBe('running')
    expect(job.steps.map(step => step.status)).toEqual(['pending', 'pending'])

    const secondRevision = store.getCurrentContentRevision(second.id)!.id
    const thirdRevision = store.getCurrentContentRevision(third.id)!.id
    expect(() => store.markTimelineRebuildStepReady(projectId, job.id, third.id, thirdRevision))
      .toThrow('必须按章节顺序应用重建结果')
    store.markTimelineRebuildStepReady(projectId, job.id, second.id, secondRevision)
    store.applyTimelineRebuildStep(projectId, job.id, second.id, secondRevision)
    store.markTimelineRebuildStepReady(projectId, job.id, third.id, thirdRevision)
    store.applyTimelineRebuildStep(projectId, job.id, third.id, thirdRevision)
    db.prepare(`UPDATE novel_story_events SET status = 'stale' WHERE project_id = ? AND chapter_number >= 2`).run(projectId)
    expect(() => store.completeTimelineRebuildJob(projectId, job.id)).toThrow('派生状态仍处于 stale')
    db.prepare(`UPDATE novel_story_events SET status = 'confirmed' WHERE project_id = ? AND chapter_number >= 2`).run(projectId)
    const completed = store.completeTimelineRebuildJob(projectId, job.id)
    expect(completed.status).toBe('completed')
    expect(completed.completed).toBe(2)
    expect(store.getActiveTimelineInvalidation(projectId)).toBeUndefined()
    expect(store.listTimelineRebuildEvents(projectId, job.id).map(event => event.type)).toEqual([
      'job_queued', 'chapter_ready_to_apply', 'chapter_applied', 'chapter_ready_to_apply', 'chapter_applied', 'job_completed',
    ])
    db.close()
  })

  it('取消后可从已应用 checkpoint 恢复，并且不会改写已应用步骤', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    const third = createChapter(store, projectId, 3)
    for (const chapterId of [second.id, third.id]) {
      db.prepare(`
        INSERT INTO novel_memory_operation_runs
          (id, project_id, chapter_id, source, payload_hash, status, created_at, committed_at)
        VALUES (?, ?, ?, 'test', 'hash', 'committed', 1, 1)
      `).run(randomUUID(), projectId, chapterId)
    }
    memory.saveSnapshot({ projectId, chapterNumber: 1, snapshotType: 'full', entityId: null, snapshotData: '{}' })
    store.updateChapterContent(second.id, '改写正文', 4)
    const job = store.createTimelineRebuildJob(projectId, store.getTimelineRebuildPreview(projectId)!.confirmationToken)
    const revision = store.getCurrentContentRevision(second.id)!.id
    store.markTimelineRebuildStepReady(projectId, job.id, second.id, revision)
    store.applyTimelineRebuildStep(projectId, job.id, second.id, revision)
    const cancelled = store.cancelTimelineRebuildJob(projectId, job.id)
    expect(cancelled.status).toBe('cancelled')
    const resumed = store.resumeTimelineRebuildJob(projectId, job.id)
    expect(resumed.status).toBe('running')
    expect(resumed.steps.find(step => step.chapterId === second.id)?.status).toBe('applied')
    expect(resumed.checkpoint).toBe(2)
    db.close()
  })

  it('状态机真实落库：begin 写入 replaying，recordAnalysis 写入 ready_to_apply', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    const third = createChapter(store, projectId, 3)
    for (const chapter of [second, third]) {
      db.prepare(`
        INSERT INTO novel_memory_operation_runs
          (id, project_id, chapter_id, source, payload_hash, status, created_at, committed_at)
        VALUES (?, ?, ?, 'test', 'hash', 'committed', 1, 1)
      `).run(randomUUID(), projectId, chapter.id)
    }
    memory.saveSnapshot({ projectId, chapterNumber: 1, snapshotType: 'full', entityId: null, snapshotData: '{}' })
    store.updateChapterContent(second.id, '改写正文', 4)
    const job = store.createTimelineRebuildJob(projectId, store.getTimelineRebuildPreview(projectId)!.confirmationToken)
    const revision = store.getCurrentContentRevision(second.id)!.id
    const rawStatus = (): string => (db.prepare(
      'SELECT status FROM novel_timeline_rebuild_steps WHERE job_id = ? AND chapter_id = ?',
    ).get(job.id, second.id) as { status: string }).status

    store.beginTimelineRebuildStep(projectId, job.id, second.id, revision)
    expect(rawStatus()).toBe('replaying')
    store.recordTimelineRebuildStepAnalysis(projectId, job.id, second.id, revision, {
      summary: '重放完成', proposedChanges: {}, inputHash: 'h', baseSnapshotHash: 'b',
    })
    expect(rawStatus()).toBe('ready_to_apply')
    db.close()
  })

  it('应用章节时按 stale_from 恢复派生状态、写入重放快照并持久化 checkpoint', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    const third = createChapter(store, projectId, 3)
    for (const chapter of [second, third]) {
      db.prepare(`
        INSERT INTO novel_memory_operation_runs
          (id, project_id, chapter_id, source, payload_hash, status, created_at, committed_at)
        VALUES (?, ?, ?, 'test', 'hash', 'committed', 1, 1)
      `).run(randomUUID(), projectId, chapter.id)
    }

    const character = store.createCharacter({
      id: randomUUID(), projectId, name: '角色', description: '', identity: '', personality: '',
      appearance: '', currentState: '', currentGoal: '', currentPressure: '', secret: '',
      arcStage: 'introduction', arcHistory: '[]', speechStyle: '', isProtagonist: false,
      longTermDesire: '', plotRole: 'supporting', removalImpact: '',
    })
    store.createCharacterHistory({
      projectId, characterId: character.id, chapterId: second.id, chapterNumber: 2,
      fieldName: 'currentState', oldValue: '旧', newValue: '新', reason: '正文',
    })
    memory.saveSnapshot({ projectId, chapterNumber: 2, snapshotType: 'full', entityId: null, snapshotData: '{"old":true}' })
    memory.createStoryEvent({
      projectId, chapterNumber: 2, sceneId: null, sceneOrder: 0, type: 'custom',
      title: '旧事件', summary: '旧正文推导', outcome: '', status: 'confirmed', parentEventId: null, source: 'manual',
    })
    store.createEntityCandidate({ projectId, chapterNumber: 2, entityType: 'clue', payload: { description: '候选' } })
    memory.saveSnapshot({ projectId, chapterNumber: 1, snapshotType: 'full', entityId: null, snapshotData: '{}' })

    store.updateChapterContent(second.id, '改写正文', 4)
    const job = store.createTimelineRebuildJob(projectId, store.getTimelineRebuildPreview(projectId)!.confirmationToken)
    const revision = store.getCurrentContentRevision(second.id)!.id
    // 执行器记录带 proposedChanges.storyEvents 的分析产物
    store.beginTimelineRebuildStep(projectId, job.id, second.id, revision)
    store.recordTimelineRebuildStepAnalysis(projectId, job.id, second.id, revision, {
      summary: '主角立场转变',
      proposedChanges: { storyEvents: [{ type: 'custom', title: '新事件', summary: '新正文推导' }] },
      inputHash: 'h', baseSnapshotHash: 'b',
    })
    store.applyTimelineRebuildStep(projectId, job.id, second.id, revision)

    // 旧事件保留 stale 作为被取代历史，新事件以 timeline_rebuild 来源落库
    const events = db.prepare(
      'SELECT title, status, source FROM novel_story_events WHERE project_id = ? ORDER BY created_at',
    ).all(projectId) as Array<{ title: string; status: string; source: string }>
    expect(events).toContainEqual({ title: '旧事件', status: 'stale', source: 'manual' })
    expect(events).toContainEqual({ title: '新事件', status: 'confirmed', source: 'timeline_rebuild' })
    // 角色历史按 stale_from 恢复 active；候选恢复 needs_review 等待用户审核
    expect(store.listCharacterHistory(projectId).length).toBe(1)
    expect(store.listEntityCandidates(projectId)).toHaveLength(1)
    expect(store.listEntityCandidates(projectId)[0].status).toBe('needs_review')
    // 重放摘要替换 full 快照成为当前态
    const snapshot = memory.getSnapshot(projectId, 2, { snapshotType: 'full' })!
    expect(snapshot.snapshotData).toContain('timeline_rebuild')
    expect(snapshot.snapshotData).toContain('主角立场转变')
    // checkpoint 持久化分析产物与恢复摘要
    const checkpoint = store.getTimelineRebuildCheckpoint(projectId, job.id)
    expect(checkpoint).toMatchObject({ chapterNumber: 2, contentRevisionId: revision })
    expect(checkpoint!.analysis).toMatchObject({ summary: '主角立场转变' })
    expect(checkpoint!.artifacts).toHaveProperty('restored')

    // 起始章应用后残留 stale 旧事件不阻塞：第三步应用后可完成
    const thirdRevision = store.getCurrentContentRevision(third.id)!.id
    store.markTimelineRebuildStepReady(projectId, job.id, third.id, thirdRevision)
    store.applyTimelineRebuildStep(projectId, job.id, third.id, thirdRevision)
    const completed = store.completeTimelineRebuildJob(projectId, job.id)
    expect(completed.status).toBe('completed')
    db.close()
  })

  it('任务失败后正文被回滚/改写时拒绝 resume，要求重新创建任务', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const memory = new NovelMemoryStore(db)
    const projectId = createProject(store)
    createChapter(store, projectId, 1)
    const second = createChapter(store, projectId, 2)
    const third = createChapter(store, projectId, 3)
    for (const chapter of [second, third]) {
      db.prepare(`
        INSERT INTO novel_memory_operation_runs
          (id, project_id, chapter_id, source, payload_hash, status, created_at, committed_at)
        VALUES (?, ?, ?, 'test', 'hash', 'committed', 1, 1)
      `).run(randomUUID(), projectId, chapter.id)
    }
    memory.saveSnapshot({ projectId, chapterNumber: 1, snapshotType: 'full', entityId: null, snapshotData: '{}' })
    store.updateChapterContent(second.id, '改写正文', 4)
    const job = store.createTimelineRebuildJob(projectId, store.getTimelineRebuildPreview(projectId)!.confirmationToken)
    db.prepare(`UPDATE novel_timeline_rebuild_jobs SET status = 'failed' WHERE id = ?`).run(job.id)

    // 失败后用户又回滚了起始章 → 步骤锁定版本漂移
    const firstRevision = db.prepare(
      'SELECT id FROM novel_chapter_content_revisions WHERE chapter_id = ? ORDER BY revision ASC LIMIT 1',
    ).get(second.id) as { id: string }
    store.rollbackToContentRevision(second.id, firstRevision.id)

    expect(() => store.resumeTimelineRebuildJob(projectId, job.id))
      .toThrow('正文版本已变化')
    // 预览仍可用（invalidation 仍 active），允许用户确认后创建范围匹配的新任务
    const preview = store.getTimelineRebuildPreview(projectId)!
    expect(preview.automaticRebuildAvailable).toBe(true)
    db.close()
  })
})
