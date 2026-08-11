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

function setup(store: NovelStore): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active',
  })
  return projectId
}

describe('剧情（narrative）实体轨道', () => {
  it('createNarrative 落库，chapterSpans 参与矩阵投影', () => {
    const store = new NovelStore(createDb())
    const projectId = setup(store)

    const n = store.createNarrative({
      projectId, description: '矿区势力开始试探主角底线', type: 'turn',
      chapterSpans: [[3, 5]], status: 'active',
    })
    expect(n.type).toBe('turn')
    expect(n.chapterSpans).toEqual([[3, 5]])

    // 矩阵投影包含 narrative 类型
    const report = store.reconcileV2(projectId)
    void report
    const arranged = store.listNarratives(projectId)
    expect(arranged).toHaveLength(1)
    expect(arranged[0].description).toBe('矿区势力开始试探主角底线')
  })

  it('updateNarrative 更新 type/status，deleteNarrative 删除', () => {
    const store = new NovelStore(createDb())
    const projectId = setup(store)
    const n = store.createNarrative({ projectId, description: '铺垫', type: 'setup', chapterSpans: [[1, 1]], status: 'active' })

    const updated = store.updateNarrative(n.id, { type: 'reveal', status: 'resolved' })
    expect(updated?.type).toBe('reveal')
    expect(updated?.status).toBe('resolved')

    expect(store.deleteNarrative(n.id)).toBe(true)
    expect(store.listNarratives(projectId)).toHaveLength(0)
  })
})
