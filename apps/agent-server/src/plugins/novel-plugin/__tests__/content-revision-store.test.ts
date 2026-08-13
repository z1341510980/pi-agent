import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { hashChapterContent } from '../core/stores/chapter-store.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelChapter } from '../core/types.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setupChapter(store: NovelStore, initialContent = '第一版正文'): { projectId: string; chapter: NovelChapter } {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active',
  })
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
    title: '第一章', content: initialContent, wordCount: initialContent.length,
    status: 'planned', narrativeTask: '', outline: '', volumeId: null,
    acceptanceResult: null, tension: null, positioning: null,
    timeOffset: null, chapterEndingHook: null, recap: null,
  })
  return { projectId, chapter }
}

describe('不可变正文版本链（content revision）', () => {
  it('revision 追加失败时正文、旧 revision 状态和 current 指针整体回滚', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const { chapter } = setupChapter(store, 'v1')
    const original = store.getCurrentContentRevision(chapter.id)!
    db.exec(`
      CREATE TRIGGER reject_content_revision_insert
      BEFORE INSERT ON novel_chapter_content_revisions
      BEGIN
        SELECT RAISE(ABORT, 'forced revision failure');
      END;
    `)

    expect(() => store.updateChapterContent(chapter.id, 'v2', 2, {
      phase: 'writer_initial', agentType: 'writer', trigger: '测试事务',
    })).toThrow(/forced revision failure/)

    expect(store.getChapterById(chapter.id)!.content).toBe('v1')
    expect(store.listContentRevisions(chapter.id)).toHaveLength(1)
    expect(store.getCurrentContentRevision(chapter.id)).toMatchObject({
      id: original.id,
      content: 'v1',
      status: 'committed',
    })
  })

  it('正文落库追加 committed revision，current 指针指向它', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')

    const updated = store.updateChapterContent(chapter.id, 'v2', 2, {
      phase: 'writer_initial', agentType: 'writer', trigger: '测试落库',
    })!

    const current = store.getCurrentContentRevision(chapter.id)!
    expect(current.content).toBe('v2')
    expect(current.status).toBe('committed')
    expect(current.revision).toBe(2)
    expect(current.parentRevisionId).not.toBeNull()

    const all = store.listContentRevisions(chapter.id)
    expect(all).toHaveLength(2)
    // summary 不含 content 全文（类型契约）
    expect('content' in all[0] ? all[0].content : undefined).toBeUndefined()
    expect(all[0].status).toBe('committed')
    expect(all[1].status).toBe('superseded')
    expect(all[0].isCurrent).toBe(true)
    expect(all[1].isCurrent).toBe(false)
    expect(updated.content).toBe('v2')
  })

  it('正文落库后把同哈希的待绑定 Review 绑定到 current revision', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapter } = setupChapter(store, 'v1')
    const reviewedContent = 'v2'
    store.createChapterReview({
      id: randomUUID(), projectId, chapterId: chapter.id,
      contentRevisionId: null, contentHash: hashChapterContent(reviewedContent),
      consistencyScore: 10, characterScore: 10, taskCompletionScore: 10,
      clueProgressScore: 10, foreshadowStatusScore: 10, conflictChangeScore: 10,
      pacingScore: 10, infoControlScore: 10, readerHookScore: 10, styleScore: 10,
      overallScore: 10, verdict: 'accept', issues: '[]', suggestions: '[]',
      reviewedBy: 'reviewer',
    })

    store.updateChapterContent(chapter.id, reviewedContent, 2, {
      phase: 'writer_initial', agentType: 'writer', trigger: '审稿后落库',
    })

    const current = store.getCurrentContentRevision(chapter.id)!
    expect(store.getChapterReview(chapter.id)).toMatchObject({
      contentHash: hashChapterContent(reviewedContent),
      contentRevisionId: current.id,
    })
  })

  it('多次更新：旧 committed → superseded，revision 递增，parent 链完整', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')

    store.updateChapterContent(chapter.id, 'v2', 2, undefined)
    store.updateChapterContent(chapter.id, 'v3', 2, undefined)
    store.updateChapterContent(chapter.id, 'v4', 2, undefined)

    const all = store.listContentRevisions(chapter.id)
    expect(all).toHaveLength(4)
    expect('content' in all[0] ? all[0].content : undefined).toBeUndefined()
    expect(all[0].revision).toBe(4)
    expect(all[0].status).toBe('committed')
    expect(all[0].isCurrent).toBe(true)
    expect(all[1].status).toBe('superseded')
    expect(all[1].revision).toBe(3)
    expect(all[2].status).toBe('superseded')
    expect(all[2].revision).toBe(2)

    // parent 链：rev4 → rev3 → rev2 → rev1
    const r4 = store.getContentRevision(all[0].id)!
    const r3 = store.getContentRevision(all[1].id)!
    const r2 = store.getContentRevision(all[2].id)!
    expect(r4.parentRevisionId).toBe(r3.id)
    expect(r3.parentRevisionId).toBe(r2.id)
  })

  it('updateChapter（带 content patch）同样追加 revision', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')

    store.updateChapter(chapter.id, { content: 'patch 版', wordCount: 7 }, {
      phase: 'manual_patch', trigger: '用户手改',
    })

    const current = store.getCurrentContentRevision(chapter.id)!
    expect(current.content).toBe('patch 版')
    expect(current.trigger).toBe('用户手改')
    expect(current.phase).toBe('manual_patch')
  })

  it("versionSource='skip' 不追加 revision", () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')

    store.updateChapterContent(chapter.id, 'v2', 2, 'skip')

    expect(store.listContentRevisions(chapter.id)).toHaveLength(1)
  })

  it('相同内容不追加 revision', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')

    store.updateChapterContent(chapter.id, 'v1', 2, undefined)

    expect(store.listContentRevisions(chapter.id)).toHaveLength(1)
  })

  it('rollbackToContentRevision：以目标为 parent 创建 rollback_applied，不把旧行设为 current', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')

    store.updateChapterContent(chapter.id, 'v2', 2, undefined)
    store.updateChapterContent(chapter.id, 'v3', 2, undefined)

    const target = store.listContentRevisions(chapter.id).find((r) => r.revision === 2)!

    const result = store.rollbackToContentRevision(chapter.id, target.id)

    expect(result.content).toBe('v2')
    const current = store.getCurrentContentRevision(chapter.id)!
    expect(current.content).toBe('v2')
    expect(current.status).toBe('rollback_applied')
    expect(current.parentRevisionId).toBe(target.id) // 以目标为 parent，而非直接复用
    expect(current.revision).toBe(4) // 新 revision，不覆盖历史

    const all = store.listContentRevisions(chapter.id)
    expect(all).toHaveLength(4)
    expect(all[0].status).toBe('rollback_applied')
    expect(all[0].isCurrent).toBe(true)
    expect(all[1].status).toBe('superseded') // 原 v3
    expect(all[2].status).toBe('superseded') // 原 v2

    // 单链：V2 版本列表含 rollback_applied 行，不再有旧表 rollback_pre 快照
    const versions = store.listChapterVersions(chapter.id)
    const phases = versions.map((v) => v.phase)
    expect(phases).toContain('rollback_applied')
    expect(phases).not.toContain('rollback_pre')
  })

  it('回滚后再落库：parent 链接在 rollback_applied 行上，不断链（回归）', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')

    store.updateChapterContent(chapter.id, 'v2', 2, undefined)
    store.updateChapterContent(chapter.id, 'v3', 2, undefined)
    const target = store.listContentRevisions(chapter.id).find((r) => r.revision === 2)!
    const { appliedRevisionId } = store.rollbackToContentRevision(chapter.id, target.id)

    // 回滚后继续落库新正文
    store.updateChapterContent(chapter.id, 'v4-new', 6, {
      phase: 'writer_initial', agentType: 'writer', trigger: '回滚后继续创作',
    })

    const current = store.getCurrentContentRevision(chapter.id)!
    expect(current.content).toBe('v4-new')
    expect(current.status).toBe('committed')
    expect(current.revision).toBe(5)
    // 关键断言：parent 是回滚行，而不是 NULL（断链修复）
    expect(current.parentRevisionId).toBe(appliedRevisionId)

    const all = store.listContentRevisions(chapter.id)
    expect(all).toHaveLength(5)
    const rollbackRow = all.find((r) => r.id === appliedRevisionId)!
    expect(rollbackRow.status).toBe('superseded') // 回滚行被新提交收编
    // 链上只允许一条生效版本
    const active = all.filter((r) => r.status === 'committed' || r.status === 'rollback_applied')
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(current.id)
  })

  it('二次回滚：上一条 rollback_applied 行被置为 superseded', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')

    store.updateChapterContent(chapter.id, 'v2', 2, undefined)
    store.updateChapterContent(chapter.id, 'v3', 2, undefined)
    store.updateChapterContent(chapter.id, 'v4', 2, undefined)

    const rev2 = store.listContentRevisions(chapter.id).find((r) => r.revision === 2)!
    const rev3 = store.listContentRevisions(chapter.id).find((r) => r.revision === 3)!
    const first = store.rollbackToContentRevision(chapter.id, rev2.id)
    const second = store.rollbackToContentRevision(chapter.id, rev3.id)

    const all = store.listContentRevisions(chapter.id)
    const firstRow = all.find((r) => r.id === first.appliedRevisionId)!
    const secondRow = all.find((r) => r.id === second.appliedRevisionId)!
    expect(firstRow.status).toBe('superseded')
    expect(secondRow.status).toBe('rollback_applied')
    expect(secondRow.isCurrent).toBe(true)
    expect(store.getCurrentContentRevision(chapter.id)!.content).toBe('v3')
  })

  it('listChapterVersions isCurrent 由 current 指针决定（V2 单链）', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, '旧内容')

    // 覆盖：V2 链追加新 committed，current 指针指向新正文
    store.updateChapterContent(chapter.id, '新内容', 3, {
      phase: 'writer_initial', agentType: 'writer', trigger: '落库',
    })

    const versions = store.listChapterVersions(chapter.id)
    // 恰好一条 current（最新 committed），且内容为新正文
    const currentVersions = versions.filter((v) => v.isCurrent)
    expect(currentVersions).toHaveLength(1)
    expect(currentVersions[0].trigger).toBe('落库')

    // 手动快照：追加新 revision 并成为 current
    store.createVersionSnapshot(chapter.id, {
      phase: 'manual_snapshot', trigger: '手动快照',
    })
    const versions2 = store.listChapterVersions(chapter.id)
    expect(versions2.filter((v) => v.isCurrent)).toHaveLength(1)
    expect(versions2.find((v) => v.isCurrent)!.trigger).toBe('手动快照')
  })

  it('章节删除级联清理 content revisions', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, 'v1')
    store.updateChapterContent(chapter.id, 'v2', 2, undefined)

    expect(store.deleteChapter(chapter.id)).toBe(true)
    // 表已删章节，查询返回空（不抛错）
    expect(store.listContentRevisions(chapter.id)).toEqual([])
  })
})

describe('版本链收敛（P1-1，Flag 控制）', () => {
  it('默认 V2 单链：listChapterVersions/getLatestVersion 直接读 V2 链（旧表停写）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })

    store.updateChapterContent(chapter.id, 'v2', 2, { phase: 'writer_initial', agentType: 'writer', trigger: 't' })

    // 版本列表来自 V2 链（rev1 锚点 + rev2 committed）
    const versions = store.listChapterVersions(chapter.id)
    expect(versions).toHaveLength(2)
    expect(versions[0].isCurrent).toBe(true)
    // getLatestVersion 返回当前正文（V2 current 指针）
    expect(store.getLatestVersion(chapter.id)?.content).toBe('v2')
    // 旧表已停写（无行）
    const dbRaw = (store as unknown as { db: Database.Database }).db
    const legacyCount = (dbRaw.prepare(
      'SELECT COUNT(*) AS n FROM novel_chapter_versions WHERE chapter_id = ?',
    ).get(chapter.id) as { n: number }).n
    expect(legacyCount).toBe(0)
  })

  it('listChapterVersions/getLatestVersion 默认走 V2 链（单链）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    store.updateChapterContent(chapter.id, 'v2', 2, { phase: 'writer_initial', agentType: 'writer', trigger: '落库' })

    const versions = store.listChapterVersions(chapter.id)
    // V2 链两条（v1 锚点 + v2 committed），sequence = revision
    expect(versions).toHaveLength(2)
    expect(versions[0].id).toBe(store.getCurrentContentRevision(chapter.id)!.id)
    expect(versions[0].sequence).toBe(2)
    expect(versions[0].isCurrent).toBe(true)

    const latest = store.getLatestVersion(chapter.id)!
    expect(latest.content).toBe('v2')
    expect(latest.sequence).toBe(2)

    // 详情读取也走 V2
    const detail = store.getChapterVersion(versions[0].id)!
    expect(detail.content).toBe('v2')
    expect(detail.sequence).toBe(2)
  })

  it('rollbackToVersion 默认委托不可变链（rollback_applied 新版本）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    store.updateChapterContent(chapter.id, 'v2', 2, undefined)
    const target = store.listContentRevisions(chapter.id).find((r) => r.revision === 1)!

    const result = store.rollbackToVersion(chapter.id, target.id)
    expect(result.currentContent).toBe('v1')
    expect(store.getCurrentContentRevision(chapter.id)!.content).toBe('v1')
    expect(store.getChapterById(chapter.id)!.status).toBe('drafting')
  })

  it('已发布章节不能通过任一版本链回滚正文', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'review', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    store.updateChapterContent(chapter.id, 'v2', 2)
    const target = store.listContentRevisions(chapter.id).find((r) => r.revision === 1)!
    store.publishReviewedChapter(chapter.id)

    expect(() => store.rollbackToContentRevision(chapter.id, target.id)).toThrow(/已发布章节/)
    expect(() => store.rollbackToVersion(chapter.id, target.id)).toThrow(/已发布章节/)
    expect(store.getChapterById(chapter.id)).toMatchObject({ content: 'v2', status: 'published' })
  })

  it('Store 发布命令自身拒绝非 review 状态，避免绕过 Engine 校验', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'draft', wordCount: 5,
      status: 'drafting', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })

    expect(() => store.publishReviewedChapter(chapter.id)).toThrow(/只有待审章节可以发布/)
    expect(store.getChapterById(chapter.id)?.status).toBe('drafting')
  })

  it('旧表不再 INSERT（P1-1-1），手工快照改走 V2 链', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    store.updateChapterContent(chapter.id, 'v2', 2, { phase: 'writer_initial', agentType: 'writer', trigger: 't' })
    store.createVersionSnapshot(chapter.id, { phase: 'manual_snapshot', trigger: '手工快照' })

    // 旧表新增行 = 0（旧表停写）
    const dbRaw = (store as unknown as { db: Database.Database }).db
    const legacyCount = (dbRaw.prepare(
      'SELECT COUNT(*) AS n FROM novel_chapter_versions WHERE chapter_id = ?',
    ).get(chapter.id) as { n: number }).n
    expect(legacyCount).toBe(0)

    // V2 链包含手工快照 revision（phase=manual_snapshot）
    const all = store.listContentRevisions(chapter.id)
    expect(all.some((r) => r.phase === 'manual_snapshot')).toBe(true)
  })

  it('reconcileVersionChains：单链下旧表停写 → mismatch/duplicate 全 0、orphan 反映 V2 独占历史', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    store.updateChapterContent(chapter.id, 'v2', 2, { phase: 'writer_initial', agentType: 'writer', trigger: 't' })
    store.updateChapterContent(chapter.id, 'v3', 2, { phase: 'writer_initial', agentType: 'writer', trigger: 't' })

    const report = store.reconcileVersionChains(projectId)
    expect(report.mismatchRows).toBe(0) // 旧表无 V2 缺失行（旧表空）
    expect(report.duplicateRows).toBe(0)
    // orphan：V2 链中非 current 的历史版本无旧表对应行 → 预期（停旧写后旧表冻结）
    expect(report.orphanRows).toBeGreaterThan(0)
    expect(report.sourceRows).toBe(0) // 旧表已停写
    expect(report.targetRows).toBe(3) // V2 链 3 行（v1 锚点 + v2 + v3）
    expect(report.rollbackVerified).toBe(false)
    expect(report.checkedChapters).toBeGreaterThanOrEqual(1)
    expect(report.mismatchedChapters).toEqual([])
  })

  it('reconcileVersionChains：旧表多一条不一致行 → mismatch > 0（供对账发现）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: 'v1', wordCount: 2,
      status: 'planned', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    store.updateChapterContent(chapter.id, 'v2', 2, { phase: 'writer_initial', agentType: 'writer', trigger: 't' })

    // 手工向旧表插入一条 V2 链没有的脏行
    const dbRaw = (store as unknown as { db: Database.Database }).db
    dbRaw.prepare(`
      INSERT INTO novel_chapter_versions (id, chapter_id, project_id, content, word_count, phase, agent_type, trigger, sequence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), chapter.id, projectId, '脏数据', 3, 'writer_initial', 'writer', 't', 99, Math.floor(Date.now() / 1000))

    const report = store.reconcileVersionChains(projectId)
    expect(report.mismatchRows).toBeGreaterThan(0)
  })
})
