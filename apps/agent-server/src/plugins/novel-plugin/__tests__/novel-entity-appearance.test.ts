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

  describe('手工编辑双写（syncManualSpanAppearances）', () => {
    beforeAll(() => {
      // 补第 2 章（双写增删需要两个已落库章节）
      db.prepare(`
        INSERT INTO novel_chapters (id, project_id, chapter_number, volume, title, narrative_task, status)
        VALUES (?, ?, 2, 1, '测试章2', '{"description":"测试","type":"advance_mainline","priority":"medium"}', 'draft')
      `).run('p2-chapter-2', projectId)
    })

    it('appearanceV2Write 关闭（默认）：手工改 spans 只落旧列，不产生 appearance', () => {
      store.updateProject(projectId, { flags: { appearanceV2Write: false } })
      store.createConflict({
        id: 'manual-c-1',
        projectId,
        description: '双写测试冲突',
        type: 'interest',
        intensity: 5,
        stage: 'escalating',
        participants: '[]',
        chapterSpans: [],
        tier: 'main',
      })
      store.updateConflict('manual-c-1', { chapterSpans: [[1, 1]] })
      expect(store.getConflict('manual-c-1')?.chapterSpans).toEqual([[1, 1]])
      expect(store.listAppearancesByEntity(projectId, 'conflict', 'manual-c-1')).toHaveLength(0)
    })

    it('双写开启：手工增章写入 appearance（source=manual），旧列同步更新', () => {
      store.updateProject(projectId, { flags: { appearanceV2Write: true, chapterSpansFrozen: false } })
      store.updateConflict('manual-c-1', { chapterSpans: [[1, 2]] })
      expect(store.getConflict('manual-c-1')?.chapterSpans).toEqual([[1, 2]])
      expect(store.listAppearancesByEntity(projectId, 'conflict', 'manual-c-1').sort())
        .toEqual(['p2-chapter-1', 'p2-chapter-2'])
      const sources = db.prepare(
        "SELECT DISTINCT source FROM novel_entity_appearances WHERE project_id = ? AND entity_id = 'manual-c-1'",
      ).all(projectId) as Array<{ source: string }>
      expect(sources.map((r) => r.source)).toEqual(['manual'])
    })

    it('手工收窄 spans：移除章的 appearance 被删除（保留章不动）', () => {
      store.updateConflict('manual-c-1', { chapterSpans: [[1, 1]] })
      expect(store.listAppearancesByEntity(projectId, 'conflict', 'manual-c-1'))
        .toEqual(['p2-chapter-1'])
    })

    it('location 的 appearChapters（扁平章节号数组）同样双写', () => {
      store.createLocation({
        id: 'manual-loc-1',
        projectId,
        name: '双写测试地点',
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
      expect(store.getLocation('manual-loc-1')?.appearChapters).toEqual([1, 2])
      expect(store.listAppearancesByEntity(projectId, 'location', 'manual-loc-1').sort())
        .toEqual(['p2-chapter-1', 'p2-chapter-2'])
    })

    it('narrative 的 chapterSpans 同样双写', () => {
      const created = store.createNarrative({
        projectId,
        description: '双写测试剧情',
        type: 'advance',
        chapterSpans: [],
        status: 'active',
      })
      store.updateNarrative(created.id, { chapterSpans: [[1, 2]] })
      expect(store.getNarrative(created.id)?.chapterSpans).toEqual([[1, 2]])
      expect(store.listAppearancesByEntity(projectId, 'narrative', created.id).sort())
        .toEqual(['p2-chapter-1', 'p2-chapter-2'])
    })

    it('chapterSpansFrozen 开启时不产生 manual 来源（短路，走 frozen-redirect）', () => {
      store.updateProject(projectId, { flags: { appearanceV2Write: true, chapterSpansFrozen: true } })
      store.createConflict({
        id: 'manual-c-frozen',
        projectId,
        description: '冻结短路测试',
        type: 'interest',
        intensity: 5,
        stage: 'escalating',
        participants: '[]',
        chapterSpans: [],
        tier: 'main',
      })
      store.updateConflict('manual-c-frozen', { chapterSpans: [[1, 1]] })
      const sources = db.prepare(
        "SELECT DISTINCT source FROM novel_entity_appearances WHERE project_id = ? AND entity_id = 'manual-c-frozen'",
      ).all(projectId) as Array<{ source: string }>
      expect(sources.map((r) => r.source)).toEqual(['frozen-redirect'])
      store.updateProject(projectId, { flags: { appearanceV2Write: true, chapterSpansFrozen: false } })
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
      store.updateProject(rp, { flags: { appearanceV2Write: true, chapterSpansFrozen: false } })
    })

    it('双写一致时：mismatch/orphan/duplicate = 0，源目标行数相等', () => {
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
      expect(report.mismatchRows).toBe(0)
      expect(report.orphanRows).toBe(0)
      expect(report.duplicateRows).toBe(0)
      expect(report.rollbackVerified).toBe(false)
      expect(report.checkedEntities).toBe(1)
      expect(report.sourceRows).toBe(2)
      expect(report.targetRows).toBe(2)
      expect(report.details).toEqual([])
    })

    it('未落库章节引用单独统计（unpersistedRefs），不算 mismatch', () => {
      store.updateConflict('rc-c-1', { chapterSpans: [[1, 3]] })
      const report = store.reconcileEntityAppearances(rp)
      expect(report.unpersistedRefs).toBe(1)
      expect(report.mismatchRows).toBe(0)
      store.updateConflict('rc-c-1', { chapterSpans: [[1, 2]] })
    })

    it('缺写检出：appearance 缺失一条即 mismatch=1，明细给出缺章；修复后归零', () => {
      db.prepare(
        "DELETE FROM novel_entity_appearances WHERE project_id = ? AND entity_id = 'rc-c-1' AND chapter_id = 'rc-chapter-2'",
      ).run(rp)
      const report = store.reconcileEntityAppearances(rp)
      expect(report.mismatchRows).toBe(1)
      expect(report.details[0]).toEqual({
        entityType: 'conflict',
        entityId: 'rc-c-1',
        missingChapters: [2],
        extraChapters: [],
      })
      // 手工双写即修复手段：重写同样的 spans 会补齐缺章
      store.updateConflict('rc-c-1', { chapterSpans: [[1, 2]] })
      expect(store.reconcileEntityAppearances(rp).mismatchRows).toBe(0)
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

    it('location 扁平章节数组参与对账且一致', () => {
      store.createLocation({
        id: 'rc-loc-1',
        projectId: rp,
        name: '对账测试地点',
        description: '',
        type: 'city',
        parentId: null,
        factionId: null,
        significance: 'minor',
        firstChapter: null,
        status: 'normal',
        appearChapters: [],
      })
      store.updateLocation('rc-loc-1', { appearChapters: [1] })
      const report = store.reconcileEntityAppearances(rp)
      expect(report.mismatchRows).toBe(0)
      expect(report.checkedEntities).toBe(2)
    })
  })
})
