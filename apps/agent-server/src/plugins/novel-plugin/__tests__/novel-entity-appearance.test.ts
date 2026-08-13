/**
 * P2 实体出场关系统一（novel_entity_appearances）测试。
 *
 * 2026-08-12 逻辑统一：appearance 表为唯一出场写面/读面（appearanceV2Write /
 * appearanceV2Read / chapterSpansFrozen 已转正移除，旧列冻结）。
 *
 * 守护：
 * 1. appearance 表的基础读写与幂等；
 * 2. recordAppearancesIfEnabled：恒写（resolve chapterId）、幂等、无法解析时不写；
 * 3. 出场字段 patch 恒剥离旧列并转写 appearance（frozen-redirect）；
 * 4. 手工编辑增删 spans 恒同步 appearance（manual 来源）；
 * 5. 对账口径可跑（CLI 由人工在真实库执行，这里只测 store 层）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

describe('P2 实体出场关系统一（appearance 单链）', () => {
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

  it('recordAppearancesIfEnabled 恒写（默认即写，无 flag 门控）', () => {
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

  describe('appearance 读切（恒走 appearance 表）', () => {
    it('恒返回 appearance 中的本章实体（不再返回 null）', () => {
      store.recordAppearancesIfEnabled({
        projectId,
        chapterNumber: 1,
        entityType: 'conflict',
        entityIds: ['c-read-1', 'c-read-2'],
        source: 'sync',
      })
      const ids = store.listChapterAppearanceIds({ projectId, chapterNumber: 1, entityType: 'conflict' })
      expect(Array.isArray(ids)).toBe(true)
      expect(ids?.sort()).toEqual(['c-read-1', 'c-read-2'])
    })

    it('按 entityType 过滤，未记录的章节返回空数组', () => {
      const foreshadowIds = store.listChapterAppearanceIds({ projectId, chapterNumber: 1, entityType: 'foreshadow' })
      expect(foreshadowIds).toEqual([])
    })
  })

  describe('旧列冻结（chapterSpansFrozen 转正：恒剥离转写）', () => {
    it('chapterSpans patch 恒剥离不落旧列，转写 appearance（source=frozen-redirect）', () => {
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
      store.updateConflict('fz-c-1', { chapterSpans: [[1, 1], [2, 2]] })
      const after = store.getConflict('fz-c-1')
      // 旧列保持原值（未被更新，冻结）
      expect(after?.chapterSpans).toEqual([])
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
      store.updateConflict('fz-c-1', { description: '改名后的描述' })
      const after = store.getConflict('fz-c-1')
      expect(after?.description).toBe('改名后的描述')
      expect(after?.chapterSpans).toEqual([])
    })
  })

  describe('手工编辑 spans 恒同步 appearance（syncManualSpanAppearances）', () => {
    beforeAll(() => {
      // 补第 2 章（增删需要两个已落库章节）
      db.prepare(`
        INSERT INTO novel_chapters (id, project_id, chapter_number, volume, title, narrative_task, status)
        VALUES (?, ?, 2, 1, '测试章2', '{"description":"测试","type":"advance_mainline","priority":"medium"}', 'draft')
      `).run('p2-chapter-2', projectId)
    })

    it('手工增章写入 appearance（source=manual），旧列冻结不更新', () => {
      store.createConflict({
        id: 'manual-c-1',
        projectId,
        description: '手工编辑测试冲突',
        type: 'interest',
        intensity: 5,
        stage: 'escalating',
        participants: '[]',
        chapterSpans: [],
        tier: 'main',
      })
      store.updateConflict('manual-c-1', { chapterSpans: [[1, 2]] })
      // 旧列冻结（不落库）
      expect(store.getConflict('manual-c-1')?.chapterSpans).toEqual([])
      expect(store.listAppearancesByEntity(projectId, 'conflict', 'manual-c-1').sort())
        .toEqual(['p2-chapter-1', 'p2-chapter-2'])
      const sources = db.prepare(
        "SELECT DISTINCT source FROM novel_entity_appearances WHERE project_id = ? AND entity_id = 'manual-c-1'",
      ).all(projectId) as Array<{ source: string }>
      // 首次写入来源为 frozen-redirect（stripFrozenSpans 剥离转写）
      expect(sources.map((r) => r.source)).toEqual(['frozen-redirect'])
    })

    it('手工收窄 spans：移除章的 appearance 被删除（保留章不动）', () => {
      store.updateConflict('manual-c-1', { chapterSpans: [[1, 1]] })
      expect(store.listAppearancesByEntity(projectId, 'conflict', 'manual-c-1'))
        .toEqual(['p2-chapter-1'])
    })

    it('location 的 appearChapters（扁平章节号数组）同样同步', () => {
      store.createLocation({
        id: 'manual-loc-1',
        projectId,
        name: '手工测试地点',
        description: '',
        type: 'city',
        parentId: null,
        factionId: null,
        significance: 'minor',
        firstChapter: null,
        status: 'normal',
        appearChapters: [],
      })
      store.updateLocation('manual-loc-1', { appearChapters: [1, 2] })
      expect(store.getLocation('manual-loc-1')?.appearChapters).toEqual([])
      expect(store.listAppearancesByEntity(projectId, 'location', 'manual-loc-1').sort())
        .toEqual(['p2-chapter-1', 'p2-chapter-2'])
    })

    it('narrative 的 chapterSpans 同样同步', () => {
      const created = store.createNarrative({
        projectId,
        description: '手工测试剧情',
        type: 'advance',
        chapterSpans: [],
        status: 'active',
      })
      store.updateNarrative(created.id, { chapterSpans: [[1, 2]] })
      expect(store.getNarrative(created.id)?.chapterSpans).toEqual([])
      expect(store.listAppearancesByEntity(projectId, 'narrative', created.id).sort())
        .toEqual(['p2-chapter-1', 'p2-chapter-2'])
    })

    it('实体删除级联清理 appearance（不产生孤儿行）', () => {
      store.createConflict({
        id: 'del-c-1',
        projectId,
        description: '删除级联测试',
        type: 'interest',
        intensity: 5,
        stage: 'escalating',
        participants: '[]',
        chapterSpans: [],
        tier: 'main',
      })
      store.updateConflict('del-c-1', { chapterSpans: [[1, 1]] })
      expect(store.listAppearancesByEntity(projectId, 'conflict', 'del-c-1')).toHaveLength(1)
      store.deleteConflict('del-c-1')
      expect(store.listAppearancesByEntity(projectId, 'conflict', 'del-c-1')).toHaveLength(0)
    })

    it('角色删除级联清理 appearance（character 是出场高频实体，必须防孤儿）', () => {
      store.createCharacter({
        id: 'del-chr-1',
        projectId,
        name: '待删除角色',
        description: '', identity: '', personality: '', appearance: '',
        currentState: '', currentGoal: '', currentPressure: '', secret: '',
        arcStage: '', arcHistory: '', speechStyle: '',
        isProtagonist: false, longTermDesire: '', plotRole: 'supporting', removalImpact: '',
      })
      // 直接写一条 appearance（AI 编排/同步入口的正常产物）
      store.recordAppearancesIfEnabled({
        projectId,
        chapterNumber: 1,
        entityType: 'character',
        entityIds: ['del-chr-1'],
        source: 'sync',
      })
      expect(store.listAppearancesByEntity(projectId, 'character', 'del-chr-1')).toHaveLength(1)
      store.deleteCharacter('del-chr-1')
      expect(store.listAppearancesByEntity(projectId, 'character', 'del-chr-1')).toHaveLength(0)
    })
  })

  describe('reconcileEntityAppearances 对账验收（MigrationAcceptance 形态）', () => {
    const rp = 'p2-reconcile-project'

    beforeAll(() => {
      store.createProject({
        id: rp,
        title: 'P2 对账测试',
        genre: '科幻',
        synopsis: '',
        targetWords: 3000,
        currentVolume: 1,
        currentChapter: 0,
        currentStage: 'setup',
        status: 'active',
      })
      const insertChapter = db.prepare(`
        INSERT INTO novel_chapters (id, project_id, chapter_number, volume, title, narrative_task, status)
        VALUES (?, ?, ?, 1, '对账章', '{"description":"测试","type":"advance_mainline","priority":"medium"}', 'draft')
      `)
      insertChapter.run('rc-chapter-1', rp, 1)
      insertChapter.run('rc-chapter-2', rp, 2)
    })

    it('旧列冻结后：spans 空 → sourceRows=0，appearance 行在 targetRows（单链语义）', () => {
      store.createConflict({
        id: 'rc-c-1',
        projectId: rp,
        description: '对账测试冲突',
        type: 'interest',
        intensity: 5,
        stage: 'escalating',
        participants: '[]',
        chapterSpans: [],
        tier: 'main',
      })
      store.updateConflict('rc-c-1', { chapterSpans: [[1, 2]] })
      const report = store.reconcileEntityAppearances(rp)
      // 单链：旧列冻结（sourceRows=0），出场全在 appearance（targetRows=2）
      expect(report.sourceRows).toBe(0)
      expect(report.targetRows).toBe(2)
      expect(report.orphanRows).toBe(0)
      expect(report.duplicateRows).toBe(0)
      expect(report.rollbackVerified).toBe(false)
      expect(report.checkedEntities).toBe(0)
      expect(report.details).toEqual([])
    })

    it('孤儿检出：指向不存在实体的 appearance 计入 orphanRows', () => {
      db.prepare(`
        INSERT INTO novel_entity_appearances
          (id, project_id, chapter_id, entity_type, entity_id, appearance_role, source, created_at)
        VALUES ('rc-orphan-1', ?, 'rc-chapter-1', 'conflict', 'ghost-entity', 'present', 'manual', 0)
      `).run(rp)
      expect(store.reconcileEntityAppearances(rp).orphanRows).toBe(1)
      db.prepare("DELETE FROM novel_entity_appearances WHERE id = 'rc-orphan-1'").run()
      expect(store.reconcileEntityAppearances(rp).orphanRows).toBe(0)
    })
  })
})
