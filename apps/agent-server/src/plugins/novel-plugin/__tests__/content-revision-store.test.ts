import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
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

    // 旧表兼容：rollback_pre / rollback_applied 快照都留存
    const legacyVersions = store.listChapterVersions(chapter.id)
    const phases = legacyVersions.map((v) => v.phase)
    expect(phases).toContain('rollback_pre')
    expect(phases).toContain('rollback_applied')
  })

  it('listChapterVersions isCurrent 修复：覆盖前快照不再误标为当前，content 相等才为 true', () => {
    const store = new NovelStore(createDb())
    const { chapter } = setupChapter(store, '旧内容')

    // 覆盖：旧表存"覆盖前快照"（旧内容），当前正文变为新内容
    store.updateChapterContent(chapter.id, '新内容', 3, {
      phase: 'writer_initial', agentType: 'writer', trigger: '落库',
    })

    const versions = store.listChapterVersions(chapter.id)
    // 版本表里只有一条"覆盖前快照"，内容是旧内容 ≠ 当前正文 → 不应标 current
    expect(versions.some((v) => v.isCurrent)).toBe(false)

    // 手动创建与当前正文一致的快照 → 该快照才标 current
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
  it('Flag 关闭：listChapterVersions/getLatestVersion 走旧表（行为与现状一致）', () => {
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

    // 旧表读到覆盖前快照 + 手动快照等
    const versions = store.listChapterVersions(chapter.id)
    expect(versions.length).toBeGreaterThan(0)
    expect(store.getLatestVersion(chapter.id)?.content).toBe('v1') // 旧表最后一条是覆盖前快照
    // V2 链独立
    expect(store.getCurrentContentRevision(chapter.id)?.content).toBe('v2')
  })

  it('versionChainV2Read 开启：listChapterVersions/getLatestVersion 委托 V2 链', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
      flags: { versionChainV2Read: true },
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

  it('versionChainV2Read 开启：rollbackToVersion 委托不可变链（rollback_applied 新版本）', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
      flags: { versionChainV2Read: true },
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
  })

  it('versionChainV2Write 开启：旧表不再 INSERT（P1-1-1），手工快照改走 V2 链', () => {
    const db = createDb()
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active',
      flags: { versionChainV2Write: true },
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

    // 旧表新增行 = 0（仅 createChapter 时无旧表写入；旧表为空）
    const dbRaw = (store as unknown as { db: Database.Database }).db
    const legacyCount = (dbRaw.prepare(
      'SELECT COUNT(*) AS n FROM novel_chapter_versions WHERE chapter_id = ?',
    ).get(chapter.id) as { n: number }).n
    expect(legacyCount).toBe(0)

    // V2 链包含手工快照 revision（phase=manual_snapshot）
    const all = store.listContentRevisions(chapter.id)
    expect(all.some((r) => r.phase === 'manual_snapshot')).toBe(true)
  })

  it('reconcileVersionChains：双写数据一致 → mismatch/orphan/duplicate 全 0', () => {
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
    expect(report.mismatchRows).toBe(0)
    expect(report.orphanRows).toBe(0)
    expect(report.duplicateRows).toBe(0)
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
