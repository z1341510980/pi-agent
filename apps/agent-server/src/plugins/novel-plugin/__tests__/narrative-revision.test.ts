import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { novelMigrations } from '../novel-migrations.js'
import { NovelStore } from '../core/novel-store.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function createProject(store: NovelStore): string {
  return store.createProject({
    id: randomUUID(), title: '修订测试', genre: 'test', synopsis: '', targetWords: 3000,
    currentVolume: 1, currentChapter: 1, currentStage: 'setup', status: 'active',
  }).id
}

function createChapter(store: NovelStore, projectId: string, chapterNumber: number): NonNullable<ReturnType<NovelStore['getChapterById']>> {
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber, title: `第${chapterNumber}章`,
    content: '', wordCount: 0, status: 'planned', narrativeTask: '', acceptanceResult: null,
  })
  store.updateChapterContent(chapter.id, `正文 ${chapterNumber}`, 4)
  return store.getChapterById(chapter.id)!
}

/** 直接落库准备可被人工编辑的场景基线（含 plan + scene + scene revision）。 */
function createSceneFixture(db: Database.Database, store: NovelStore, projectId: string): { chapter: NonNullable<ReturnType<NovelStore['getChapterById']>>; sceneId: string; revisionId: string } {
  const chapter = createChapter(store, projectId, 1)
  const now = Date.now()
  const planId = randomUUID()
  const sceneId = randomUUID()
  const revisionId = randomUUID()
  db.prepare(`
    INSERT INTO novel_chapter_plan_revisions (id, chapter_id, project_id, budget, status, revision, created_at)
    VALUES (?, ?, ?, '{}', 'approved', 1, ?)
  `).run(planId, chapter.id, projectId, now)
  db.prepare(`
    INSERT INTO novel_scenes (id, chapter_id, project_id, stable_key, created_at)
    VALUES (?, ?, ?, 'scene-1', ?)
  `).run(sceneId, chapter.id, projectId, now)
  db.prepare(`
    INSERT INTO novel_scene_revisions
      (id, scene_id, chapter_id, project_id, plan_revision_id, order_no, title, goal, summary,
       location_text, time_text, pov_mode, status, created_at)
    VALUES (?, ?, ?, ?, ?, 1, '开场', '铺垫', '旧摘要', '', '', 'single', 'planned', ?)
  `).run(revisionId, sceneId, chapter.id, projectId, planId, now)
  db.prepare(`
    INSERT INTO novel_scene_cast (scene_revision_id, character_id, role, function, prominence, note)
    VALUES (?, 'c1', 'focus', NULL, NULL, '')
  `).run(revisionId)
  return { chapter, sceneId, revisionId }
}

describe('StorylineRevision', () => {
  it('草稿→提交→批准成为当前规范事实，旧 approved 被 supersede', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = createProject(store)
    const storyline = store.ensureStoryline(projectId, '复仇主线')

    const draft = store.createStorylineRevisionDraft(storyline.id, projectId, {
      expectedRevision: 0, summary: '主角踏上复仇之路', goal: '揭露真相', stakes: '身败名裂', actor: '主角',
    })
    expect(draft.status).toBe('draft')
    expect(draft.revision).toBe(1)

    const submitted = store.submitStorylineRevision(draft.id)
    expect(submitted.status).toBe('submitted')

    const approved = store.approveStorylineRevision(draft.id, { decision: 'approve', reviewer: 'user' })
    expect(approved.status).toBe('approved')
    expect(store.getStorylineCurrentRevision(storyline.id)?.id).toBe(draft.id)

    // 第二个草稿基于 revision=1
    const draft2 = store.createStorylineRevisionDraft(storyline.id, projectId, {
      expectedRevision: 1, summary: '修订后的复仇主线', goal: 'g', stakes: 's', actor: 'a',
    })
    expect(draft2.revision).toBe(2)
    store.approveStorylineRevision(store.submitStorylineRevision(draft2.id).id, { decision: 'approve' })
    // 旧 approved 被 supersede，新的成为当前
    expect(store.getStorylineRevision(draft.id)?.status).toBe('superseded')
    expect(store.getStorylineCurrentRevision(storyline.id)?.id).toBe(draft2.id)
    db.close()
  })

  it('乐观锁冲突：expectedRevision 过期时创建草稿抛错', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = createProject(store)
    const storyline = store.ensureStoryline(projectId, '主线')
    store.createStorylineRevisionDraft(storyline.id, projectId, {
      expectedRevision: 0, summary: 'a', goal: '', stakes: '', actor: '',
    })
    expect(() => store.createStorylineRevisionDraft(storyline.id, projectId, {
      expectedRevision: 0, summary: 'b', goal: '', stakes: '', actor: '',
    })).toThrow('版本已变化')
    db.close()
  })

  it('比较与回滚：回滚创建新 draft 并携带目标版本内容', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = createProject(store)
    const storyline = store.ensureStoryline(projectId, '主线')
    const v1 = store.createStorylineRevisionDraft(storyline.id, projectId, {
      expectedRevision: 0, summary: '版本一', goal: '', stakes: '', actor: '',
    })
    store.createStorylineRevisionDraft(storyline.id, projectId, {
      expectedRevision: 1, summary: '版本二', goal: '', stakes: '', actor: '',
    })

    const compare = store.compareStorylineRevisions(storyline.id, 1, 2)
    expect(compare.fields).toContainEqual({ field: 'summary', before: '版本一', after: '版本二' })

    const rollback = store.rollbackStorylineRevision(storyline.id, projectId, v1.id, '回到版本一')
    expect(rollback.status).toBe('draft')
    expect(rollback.summary).toBe('版本一')
    expect(rollback.supersedesId).toBe(v1.id)
    expect(rollback.revision).toBe(3)
    db.close()
  })
})

describe('SceneRevisionReview', () => {
  it('人工编辑创建草稿→提交→批准，旧版本被 supersede', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = createProject(store)
    const { sceneId, revisionId } = createSceneFixture(db, store, projectId)

    const draft = store.createSceneReviewDraft(sceneId, {
      expectedRevision: revisionId, summary: '新摘要', pov: 'omniscient',
      positioning: '高潮', narrativeTaskTypes: ['推进', '揭示'],
    })
    expect(draft.reviewStatus).toBe('draft')
    expect(draft.summary).toBe('新摘要')
    expect(draft.positioning).toBe('高潮')

    // 旧版本被 supersede 且 order_no 翻转为负
    const old = store.getSceneReviewRevision(revisionId)!
    expect(old.status).toBe('superseded')
    expect(old.order).toBeLessThan(0)

    const submitted = store.submitSceneReviewRevision(draft.id)
    expect(submitted.reviewStatus).toBe('submitted')
    const approved = store.decideSceneReviewRevision(draft.id, 'approve', '通过')
    expect(approved.reviewStatus).toBe('approved')
    expect(approved.reviewNote).toBe('通过')

    // 详情返回当前版本 + 历史版本链
    const detail = store.getSceneReviewDetail(sceneId)!
    expect(detail.revision?.id).toBe(draft.id)
    expect(detail.revisions).toHaveLength(2)
    db.close()
  })

  it('场景比较与回滚', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = createProject(store)
    const { sceneId, revisionId } = createSceneFixture(db, store, projectId)
    const draft = store.createSceneReviewDraft(sceneId, {
      expectedRevision: revisionId, summary: '新摘要', pov: 'single',
    })

    const compare = store.compareSceneReviewRevisions(sceneId, revisionId, draft.id)
    expect(compare.fields).toContainEqual({ field: 'summary', before: '旧摘要', after: '新摘要' })

    const rollback = store.rollbackSceneReviewRevision(sceneId, draft.id, '回到旧摘要')
    expect(rollback.reviewStatus).toBe('draft')
    expect(rollback.summary).toBe('新摘要') // 回滚目标内容 = draft 的摘要
    db.close()
  })
})

describe('NarrativeMatrixRebuild', () => {
  it('同步重投影落 job + 完成事件，幂等去重', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = createProject(store)
    store.ensureStoryline(projectId, '主线')

    const rebuild = store.createMatrixRebuild(projectId, [], 'key-1')
    expect(rebuild.status).toBe('queued')
    const report = store.narrativeMatrix(projectId)
    const completed = store.markMatrixRebuildCompleted(projectId, rebuild.id, {
      sourceRevision: report.sourceRevision, stale: report.stale, failedNodes: [],
    })
    expect(completed.status).toBe('completed')
    expect(completed.sourceRevision).toBe(report.sourceRevision)

    const events = store.listMatrixRebuildEvents(projectId, rebuild.id)
    expect(events.map((event) => event.type)).toEqual(['rebuild_queued', 'rebuild_completed'])

    // 幂等：同 idempotencyKey 返回同一 job
    const again = store.createMatrixRebuild(projectId, [], 'key-1')
    expect(again.id).toBe(rebuild.id)
    db.close()
  })
})