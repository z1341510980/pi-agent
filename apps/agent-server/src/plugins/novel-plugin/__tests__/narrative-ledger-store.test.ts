import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setupSceneRevision(store: NovelStore): {
  projectId: string
  chapterId: string
  sceneRevisionIds: string[]
} {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active',
  })
  const chapter = store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber: 1,
    title: '第一章', content: '正文', wordCount: 2,
    status: 'planned', narrativeTask: '', outline: '', volumeId: null,
    acceptanceResult: null, tension: null, positioning: null,
    timeOffset: null, chapterEndingHook: null, recap: null,
  })
  const budget = { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 }
  const { scenes } = store.submitPlanWithScenes({
    chapterId: chapter.id, projectId, budget,
    scenes: [
      { sceneKey: 's1', order: 1, title: '一', goal: 'g', locationText: 'l', timeText: 't', povMode: 'single', povCharacterId: 'c1', focusCharacterIds: ['c1'], presentCharacterIds: ['c1'], functionalCast: [], targetWords: 3000, progresses: [] },
      { sceneKey: 's2', order: 2, title: '二', goal: 'g', locationText: 'l', timeText: 't', povMode: 'single', povCharacterId: 'c1', focusCharacterIds: ['c1'], presentCharacterIds: ['c1'], functionalCast: [], targetWords: 0, progresses: [] },
    ],
  })
  return { projectId, chapterId: chapter.id, sceneRevisionIds: scenes.map((s) => s.id) }
}

describe('叙事账本（NarrativeLedgerStore）', () => {
  it('ensureStoryline 幂等创建', () => {
    const store = new NovelStore(createDb())
    const { projectId } = setupSceneRevision(store)
    const a = store.ensureStoryline(projectId, '主线对抗', 'main')
    const b = store.ensureStoryline(projectId, '主线对抗', 'main')
    expect(a.id).toBe(b.id)
    expect(a.lifecycle).toBe('active')
    expect(a.maturity).toBe('candidate')
  })

  it('recordProgressForScene：写入 planned，同场景同线幂等，primary 唯一', () => {
    const store = new NovelStore(createDb())
    const { projectId, sceneRevisionIds } = setupSceneRevision(store)

    const recorded = store.recordProgressForScene(projectId, sceneRevisionIds[0], [
      { storylineName: '主线对抗', primary: true, type: 'advance', summary: '首次推进' },
      { storylineName: '感情线', primary: false, type: 'setup', summary: '铺垫' },
    ])
    expect(recorded).toHaveLength(2)
    expect(recorded[0].status).toBe('planned')
    expect(recorded[0].primary).toBe(true)

    // 同 (scene, storyline) 幂等
    const again = store.recordProgressForScene(projectId, sceneRevisionIds[0], [
      { storylineName: '主线对抗', primary: true, type: 'advance' },
    ])
    expect(again).toHaveLength(1)
    expect(again[0].id).toBe(recorded[0].id)
    expect(store.listProgressByScene(sceneRevisionIds[0])).toHaveLength(2)
  })

  it('confirmProgress：planned → confirmed；两个不同场景后故事线 established', () => {
    const store = new NovelStore(createDb())
    const { projectId, sceneRevisionIds } = setupSceneRevision(store)

    const s1 = store.recordProgressForScene(projectId, sceneRevisionIds[0], [
      { storylineName: '主线对抗', primary: true, type: 'advance' },
    ])[0]
    const s2 = store.recordProgressForScene(projectId, sceneRevisionIds[1], [
      { storylineName: '主线对抗', primary: true, type: 'advance' },
    ])[0]

    store.confirmProgress(s1.id)
    const storyline = store.getProgress(s1.id)!.storylineId
    // 只有一个不同场景 confirmed → 仍 candidate
    expect(store.getStoryline(storyline)!.maturity).toBe('candidate')

    store.confirmProgress(s2.id)
    // 两个不同场景 confirmed → established
    expect(store.getStoryline(storyline)!.maturity).toBe('established')
    expect(store.getProgress(s2.id)!.status).toBe('confirmed')
  })

  it('markStaleFromChapter：重写章节所在场景的 confirmed 推进 → stale', () => {
    const store = new NovelStore(createDb())
    const { projectId, chapterId, sceneRevisionIds } = setupSceneRevision(store)

    const p = store.recordProgressForScene(projectId, sceneRevisionIds[0], [
      { storylineName: '主线对抗', primary: true, type: 'advance' },
    ])[0]
    store.confirmProgress(p.id)

    const changed = store.markStaleFromChapter(projectId, chapterId)
    expect(changed).toBeGreaterThan(0)
    expect(store.getProgress(p.id)!.status).toBe('stale')
  })

  it('listProgressByStoryline 按状态过滤', () => {
    const store = new NovelStore(createDb())
    const { projectId, sceneRevisionIds } = setupSceneRevision(store)
    const p = store.recordProgressForScene(projectId, sceneRevisionIds[0], [
      { storylineName: '主线对抗', primary: true, type: 'advance' },
    ])[0]
    const storylineId = p.storylineId

    expect(store.listProgressByStoryline(storylineId, ['confirmed'])).toHaveLength(0)
    store.confirmProgress(p.id)
    expect(store.listProgressByStoryline(storylineId, ['confirmed'])).toHaveLength(1)
    expect(store.listProgressByStoryline(storylineId)).toHaveLength(1)
  })
})
