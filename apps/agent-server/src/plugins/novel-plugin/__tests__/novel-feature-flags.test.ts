import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isNovelFeatureEnabled, NOVEL_FEATURE_FLAGS } from '../core/novel-feature-flags.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function setupProject(store: NovelStore, flags?: Record<string, boolean>): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords: 3000, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active', flags,
  })
  return projectId
}

describe('NOVEL_FEATURE_FLAGS 清单', () => {
  it('包含方案 §10 五个 + P0/P1 五个 + P2 三个 + P3 一个（共 14 个，全部默认关）', () => {
    expect(NOVEL_FEATURE_FLAGS).toEqual([
      'scenePlanV2Write',
      'scenePlanV2DualWrite',
      'memoryProposalV2',
      'matrixProjectionV2Read',
      'legacyNarrativeWriteDisabled',
      'versionChainV2Read',
      'versionChainV2Write',
      'logPayloadExternalized',
      'sceneCastV2Write',
      'sceneCastV2Read',
      'appearanceV2Write',
      'appearanceV2Read',
      'chapterSpansFrozen',
      'contextChunksEnabled',
    ])
    expect(NOVEL_FEATURE_FLAGS).toHaveLength(14)
  })
})

describe('isNovelFeatureEnabled 项目灰度读取', () => {
  it('未配置 → false', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    expect(isNovelFeatureEnabled(store, projectId, 'scenePlanV2Write')).toBe(false)
  })

  it('配置 {scenePlanV2Write:true} → 该项目 true、其他项目 false、其他 flag false', () => {
    const store = new NovelStore(createDb())
    const enabledProject = setupProject(store, { scenePlanV2Write: true })
    const otherProject = setupProject(store)
    expect(isNovelFeatureEnabled(store, enabledProject, 'scenePlanV2Write')).toBe(true)
    expect(isNovelFeatureEnabled(store, enabledProject, 'memoryProposalV2')).toBe(false)
    expect(isNovelFeatureEnabled(store, otherProject, 'scenePlanV2Write')).toBe(false)
  })

  it('新增 flag 默认关闭：未配置 → false', () => {
    const store = new NovelStore(createDb())
    const projectId = setupProject(store)
    for (const flag of NOVEL_FEATURE_FLAGS) {
      expect(isNovelFeatureEnabled(store, projectId, flag)).toBe(false)
    }
  })

  it('配置新增 flag true → 该项目 true、其他项目 false', () => {
    const store = new NovelStore(createDb())
    const enabledProject = setupProject(store, {
      versionChainV2Read: true,
      versionChainV2Write: true,
      logPayloadExternalized: true,
      sceneCastV2Write: true,
      sceneCastV2Read: true,
    })
    const otherProject = setupProject(store)
    expect(isNovelFeatureEnabled(store, enabledProject, 'versionChainV2Read')).toBe(true)
    expect(isNovelFeatureEnabled(store, enabledProject, 'versionChainV2Write')).toBe(true)
    expect(isNovelFeatureEnabled(store, enabledProject, 'logPayloadExternalized')).toBe(true)
    expect(isNovelFeatureEnabled(store, enabledProject, 'sceneCastV2Write')).toBe(true)
    expect(isNovelFeatureEnabled(store, enabledProject, 'sceneCastV2Read')).toBe(true)
    expect(isNovelFeatureEnabled(store, otherProject, 'versionChainV2Read')).toBe(false)
  })

  it('项目不存在 → false 不抛错', () => {
    const store = new NovelStore(createDb())
    expect(isNovelFeatureEnabled(store, 'not-exist', 'scenePlanV2Write')).toBe(false)
    expect(isNovelFeatureEnabled(store, 'not-exist', 'versionChainV2Read')).toBe(false)
  })

  it('flags 为非法 JSON 的旧数据 → false 不抛错（rowToProject 安全解析）', () => {
    const store = new NovelStore(createDb())
    const projectId = randomUUID()
    store.createProject({
      id: projectId, title: 't', genre: 'g', synopsis: '', outline: '',
      targetWords: 3000, currentVolume: 1, currentChapter: 1,
      currentStage: 'rising', status: 'active', flags: undefined,
    })
    // 模拟库里已存在损坏 JSON：直接改写行
    const db = (store as unknown as { db: Database.Database }).db
    db.prepare('UPDATE novel_projects SET feature_flags = ? WHERE id = ?').run('{bad json', projectId)
    expect(isNovelFeatureEnabled(store, projectId, 'scenePlanV2Write')).toBe(false)
  })
})
