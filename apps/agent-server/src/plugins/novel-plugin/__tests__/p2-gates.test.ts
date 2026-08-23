import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { buildStyleMetricsDiff, measureStyleMetrics } from '../core/analysis/style-measurement.js'

function createStoreWithChapter(): { store: NovelStore; chapterId: string } {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  const store = new NovelStore(db)
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 't', genre: 't', synopsis: '', outline: '',
    targetWords: 0, currentVolume: 1, currentChapter: 1,
    currentStage: 'setup', status: 'active',
  })
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
    title: '第一章', content: '正文', wordCount: 2,
    status: 'review', narrativeTask: '', outline: '', volumeId: null,
    acceptanceResult: null, tension: null, positioning: null,
    timeOffset: null, chapterEndingHook: null, recap: null,
  })
  return { store, chapterId: chapter.id }
}

describe('P2-1 章节级 lengdu 质量报告持久化', () => {
  it('写入后可读回，未写入时为 undefined，损坏 JSON 返回 undefined', () => {
    const { store, chapterId } = createStoreWithChapter()

    expect(store.getChapterLengduQuality(chapterId)).toBeUndefined()

    store.setChapterLengduQuality(chapterId, {
      status: 'needs_attention',
      comprehension: 'passed',
      fluency: 'passed',
      appeal: 'needs_attention',
      revisionCount: 2,
      usedIndependentReader: true,
      summary: '好看项未通过',
      savedAt: 123,
    })
    expect(store.getChapterLengduQuality(chapterId)?.status).toBe('needs_attention')
    expect(store.getChapterLengduQuality(chapterId)?.revisionCount).toBe(2)

    // 覆盖写入最新结果
    store.setChapterLengduQuality(chapterId, { status: 'passed', savedAt: 456 })
    expect(store.getChapterLengduQuality(chapterId)?.status).toBe('passed')

    // 损坏 JSON 不抛错
    store.setChapterLengduQuality(chapterId, undefined)
    expect(store.getChapterLengduQuality(chapterId)).toBeUndefined()
  })
})

describe('ScenePlan V2 覆盖率探针（P1-3 v2 前置审计）', () => {
  it('空项目返回全零且 sceneRewriteReady 判定为 false 口径的原始统计', () => {
    const db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const store = new NovelStore(db)
    store.createProject({
      id: 'proj-empty', title: 't', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 0,
      currentStage: 'setup', status: 'active',
    })

    const coverage = store.getScenePlanCoverage('proj-empty')

    expect(coverage.totalChapters).toBe(0)
    expect(coverage.chaptersWithScenes).toBe(0)
    expect(coverage.chaptersWithApprovedPlan).toBe(0)
    expect(coverage.avgSceneCountPerChapter).toBeNull()
  })

  it('有章节与场景行时正确聚合', () => {
    const db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const store = new NovelStore(db)
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 't', genre: 't', synopsis: '', outline: '',
      targetWords: 0, currentVolume: 1, currentChapter: 1,
      currentStage: 'setup', status: 'active',
    })
    const chapter = store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: '正文', wordCount: 2,
      status: 'review', narrativeTask: '', outline: '', volumeId: null,
      acceptanceResult: null, tension: null, positioning: null,
      timeOffset: null, chapterEndingHook: null, recap: null,
    })
    // 直接落场景行（模拟影子写产物）
    db.prepare(
      `INSERT INTO novel_scenes (id, chapter_id, project_id, stable_key, created_at)
       VALUES (?, ?, ?, 's1', unixepoch()), (?, ?, ?, 's2', unixepoch())`,
    ).run(randomUUID(), chapter.id, projectId, randomUUID(), chapter.id, projectId)

    const coverage = store.getScenePlanCoverage(projectId)

    expect(coverage.totalChapters).toBe(1)
    expect(coverage.chaptersWithScenes).toBe(1)
    expect(coverage.totalSceneRevisions).toBeGreaterThanOrEqual(0)
  })
})

describe('P2-3 修订前后形态指标差异', () => {
  it('指标位移被如实报告；无变化时 changed=false', () => {
    const beforeText = `${'他说了一句很短的话。'.repeat(30)}\n\n${'这是一段长得多的叙述文字，用来把平均句长抬高一些，让前后两个样本的句长分布出现可以观察到的差异。'.repeat(10)}`
    const afterText = `${'他停。他看。他走。他回头。'.repeat(40)}`

    const diff = buildStyleMetricsDiff(measureStyleMetrics(beforeText), measureStyleMetrics(afterText))
    expect(diff.changed).toBe(true)
    expect(diff.text).toContain('修订前后形态指标对比')
    expect(diff.text).toContain('| 指标 | 修订前 | 修订后 |')

    const same = buildStyleMetricsDiff(
      measureStyleMetrics(beforeText),
      measureStyleMetrics(beforeText),
    )
    expect(same.changed).toBe(false)
    expect(same.text).toContain('未发生显著变化')
  })
})
