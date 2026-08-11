/**
 * P2 实体出场关系统一（novel_entity_appearances）测试。
 *
 * 守护：
 * 1. appearance 表的基础读写与幂等；
 * 2. recordAppearancesIfEnabled：appearanceV2Write 关闭时零副作用（默认行为不变）、
 *    开启时按章写入（resolve chapterId）；
 * 3. 对账口径可跑（CLI 由人工在真实库执行，这里只测 store 层）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

describe('P2 实体出场关系统一', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string
  let chapterId: string

  beforeAll(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    const project = store.createProject({
      id: 'p2-appearance-project',
      title: 'P2 出场关系测试',
      genre: '科幻',
      synopsis: '',
      targetWords: 3000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    projectId = project.id
    // 直接 INSERT 章节行（createChapter 字段要求多，测试最小化）
    db.prepare(`
      INSERT INTO novel_chapters (id, project_id, chapter_number, volume, title, narrative_task, status)
      VALUES (?, ?, 1, 1, '测试章', '{"description":"测试","type":"advance_mainline","priority":"medium"}', 'draft')
    `).run('p2-chapter-1', projectId)
    chapterId = 'p2-chapter-1'
  })

  afterAll(() => {
    db.close()
  })

  it('appearanceV2Write 默认关闭：recordAppearancesIfEnabled 零副作用', () => {
    store.recordAppearancesIfEnabled({
      projectId,
      chapterNumber: 1,
      entityType: 'conflict',
      entityIds: ['c1', 'c2'],
      source: 'sync',
    })
    expect(store.listAppearancesByChapter(projectId, chapterId)).toHaveLength(0)
    expect(store.listAppearancesByEntity(projectId, 'conflict', 'c1')).toHaveLength(0)
  })

  it('开启 appearanceV2Write 后按章写入（resolve chapterId），且幂等', () => {
    store.updateProject(projectId, { flags: { appearanceV2Write: true } })

    store.recordAppearancesIfEnabled({
      projectId,
      chapterNumber: 1,
      entityType: 'conflict',
      entityIds: ['c1', 'c2'],
      source: 'sync',
    })
    const first = store.listAppearancesByChapter(projectId, chapterId)
    expect(first).toHaveLength(2)
    expect(first.map((r) => r.entityId).sort()).toEqual(['c1', 'c2'])
    expect(first.every((r) => r.role === 'present')).toBe(true)

    // 幂等：重复写不重复
    store.recordAppearancesIfEnabled({
      projectId,
      chapterNumber: 1,
      entityType: 'conflict',
      entityIds: ['c1'],
      source: 'sync',
    })
    expect(store.listAppearancesByChapter(projectId, chapterId)).toHaveLength(2)

    // 按实体反查
    expect(store.listAppearancesByEntity(projectId, 'conflict', 'c1')).toEqual([chapterId])
  })

  it('chapterId 无法解析时不写入（数据完整性优先）', () => {
    store.recordAppearancesIfEnabled({
      projectId,
      chapterNumber: 999,
      entityType: 'conflict',
      entityIds: ['c9'],
      source: 'sync',
    })
    expect(store.listAppearancesByEntity(projectId, 'conflict', 'c9')).toHaveLength(0)
  })

  it('实体/章节出场删除接口可用', () => {
    store.recordAppearancesIfEnabled({
      projectId,
      chapterNumber: 1,
      entityType: 'foreshadow',
      entityIds: ['f1'],
      source: 'ai-arrange',
    })
    expect(store.listAppearancesByEntity(projectId, 'foreshadow', 'f1')).toHaveLength(1)
    store.removeEntityAppearances(projectId, 'foreshadow', 'f1')
    expect(store.listAppearancesByEntity(projectId, 'foreshadow', 'f1')).toHaveLength(0)
    store.removeChapterAppearances(projectId, chapterId)
    expect(store.listAppearancesByChapter(projectId, chapterId)).toHaveLength(0)
  })

  describe('appearanceV2Read 读切', () => {
    it('读切关闭时返回 null（调用方回退原 chapterSpans 逻辑，零行为变化）', () => {
      store.updateProject(projectId, { flags: { appearanceV2Write: false, appearanceV2Read: false } })
      expect(store.listChapterAppearanceIds({ projectId, chapterNumber: 1, entityType: 'conflict' }))
        .toBeNull()
    })

    it('读切开启时返回 appearance 中的本章实体（替换 union 多表）', () => {
      store.updateProject(projectId, { flags: { appearanceV2Write: true, appearanceV2Read: true } })
      store.recordAppearancesIfEnabled({
        projectId,
        chapterNumber: 1,
        entityType: 'conflict',
        entityIds: ['c-read-1', 'c-read-2'],
        source: 'sync',
      })
      const ids = store.listChapterAppearanceIds({ projectId, chapterNumber: 1, entityType: 'conflict' })
      expect(ids).not.toBeNull()
      expect(ids?.sort()).toEqual(['c-read-1', 'c-read-2'])
    })

    it('读切按 entityType 过滤，且未记录的章节返回空数组', () => {
      const foreshadowIds = store.listChapterAppearanceIds({ projectId, chapterNumber: 1, entityType: 'foreshadow' })
      expect(foreshadowIds).toEqual([])
    })
  })

  describe('chapterSpansFrozen 旧列冻结（P2 收官）', () => {
    it('flag 默认关闭：chapterSpans 正常写入旧列，appearance 不新增（现状不变）', () => {
      store.updateProject(projectId, { flags: { chapterSpansFrozen: false } })
      store.createConflict({
        id: 'fz-c-1',
        projectId,
        description: '冻结测试冲突',
        type: 'interest',
        intensity: 5,
        stage: 'escalating',
        participants: '[]',
        chapterSpans: [],
        tier: 'main',
      })
      store.updateConflict('fz-c-1', { chapterSpans: [[1, 1]] })
      const after = store.getConflict('fz-c-1')
      expect(after?.chapterSpans).toEqual([[1, 1]])
      expect(store.listAppearancesByEntity(projectId, 'conflict', 'fz-c-1')).toHaveLength(0)
    })

    it('flag 开启：chapterSpans 剥离不落库，转写 appearance（source=frozen-redirect）', () => {
      store.updateProject(projectId, { flags: { chapterSpansFrozen: true } })
      // 清掉上一个 case 的出场记录，聚焦本 case
      store.removeEntityAppearances(projectId, 'conflict', 'fz-c-1')
      store.updateConflict('fz-c-1', { chapterSpans: [[1, 1], [2, 2]] })
      const after = store.getConflict('fz-c-1')
      // 旧列保持原值（未被更新）
      expect(after?.chapterSpans).toEqual([[1, 1]])
      // appearance 写入：第 1 章可解析 chapterId；第 2 章未落库则跳过
      const rows = store.listAppearancesByEntity(projectId, 'conflict', 'fz-c-1')
      expect(rows).toEqual([chapterId])
    })

    it('location 的 appearChapters 同样冻结转写', () => {
      store.createLocation({
        id: 'fz-loc-1',
        projectId,
        name: '冻结测试地点',
        description: '',
        type: 'city',
        parentId: null,
        factionId: null,
        significance: 'minor',
        firstChapter: null,
        status: 'normal',
        appearChapters: [],
      })
      store.updateLocation('fz-loc-1', { appearChapters: [1, 3] })
      const after = store.getLocation('fz-loc-1')
      expect(after?.appearChapters).toEqual([])
      expect(store.listAppearancesByEntity(projectId, 'location', 'fz-loc-1')).toEqual([chapterId])
    })

    it('patch 不含出场字段时不受影响（其他字段正常更新）', () => {
      store.updateProject(projectId, { flags: { chapterSpansFrozen: true } })
      store.updateConflict('fz-c-1', { description: '改名后的描述' })
      const after = store.getConflict('fz-c-1')
      expect(after?.description).toBe('改名后的描述')
      expect(after?.chapterSpans).toEqual([[1, 1]])
    })
  })
})
