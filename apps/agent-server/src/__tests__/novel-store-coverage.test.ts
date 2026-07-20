/**
 * NovelStore 拆分前补测试（PR-5a）
 *
 * 目的：为 PR-5b 的 NovelStore 拆分建立行为基线，确保 9 个子 Store + Facade
 * 重构后行为一致。
 *
 * 覆盖范围（原 novel-store.test.ts 未覆盖的 13 个模块）：
 *   1.  Volume CRUD
 *   2.  Faction CRUD + 删除时清理 edges
 *   3.  Location CRUD + 删除时清理 edges
 *   4.  WorldElement CRUD + 删除时清理 edges
 *   5.  Edge CRUD + deleteEdgesByEntity 级联
 *   6.  WorldRule / StyleGuide / Constraint / InfoLayer CRUD
 *   7.  Marker CRUD
 *   8.  Relationship CRUD
 *   9.  AgentLog CRUD + 过滤
 *   10. ChapterVersion 快照与回滚
 *   11. Deduplicate / mergeWithPlan（7 处 switch 所在的业务核心）
 *   12. 软删除 trash/restore/purge/emptyTrash
 *   13. deleteProject 级联（外键 CASCADE 验证）
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'

let db: Database.Database
let store: NovelStore

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  store = new NovelStore(db)
})

afterEach(() => {
  db.close()
})

// ── 测试辅助 ──

function setupProject(id = 'p-1') {
  store.createProject({
    id, title: '测试小说', genre: '玄幻', synopsis: '', targetWords: 0,
    currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
  })
  return id
}

function setupChapter(projectId: string, id: string, chapterNumber: number) {
  return store.createChapter({
    id, projectId, volume: 1, chapterNumber,
    title: `第${chapterNumber}章`, content: '', wordCount: 0,
    status: 'drafting', narrativeTask: '', acceptanceResult: null,
  })
}

function setupCharacter(projectId: string, id: string, name: string) {
  return store.createCharacter({
    id, projectId, name, description: '', identity: '', personality: '',
    appearance: '', currentState: '', currentGoal: '', currentPressure: '',
    secret: '', arcStage: 'introduction', arcHistory: '[]', speechStyle: '',
    isProtagonist: false, longTermDesire: '', plotRole: 'supporting', removalImpact: '',
  })
}

// ═══════════════════════════════════════════════════════════════
// 1. Volume CRUD
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - Volume CRUD', () => {
  beforeEach(() => setupProject())

  it('createVolume 创建卷并返回完整对象', () => {
    const v = store.createVolume({
      id: 'v-1', projectId: 'p-1', volumeNumber: 1,
      title: '第一卷', outline: '', sortOrder: 0,
    })
    expect(v.id).toBe('v-1')
    expect(v.title).toBe('第一卷')
    expect(v.createdAt).toBeGreaterThan(0)
  })

  it('listVolumes 按 sortOrder 返回项目下所有卷', () => {
    store.createVolume({ id: 'v-2', projectId: 'p-1', volumeNumber: 2, title: 'B', outline: '', sortOrder: 2 })
    store.createVolume({ id: 'v-1', projectId: 'p-1', volumeNumber: 1, title: 'A', outline: '', sortOrder: 1 })
    const list = store.listVolumes('p-1')
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('v-1')
    expect(list[1].id).toBe('v-2')
  })

  it('updateVolume 更新字段', () => {
    store.createVolume({ id: 'v-1', projectId: 'p-1', volumeNumber: 1, title: '原标题', outline: '', sortOrder: 0 })
    const updated = store.updateVolume('v-1', { title: '新标题', sortOrder: 5 })
    expect(updated?.title).toBe('新标题')
    expect(updated?.sortOrder).toBe(5)
  })

  it('updateVolume 不存在返回 undefined', () => {
    expect(store.updateVolume('nonexistent', { title: 'x' })).toBeUndefined()
  })

  it('deleteVolume 删卷时把章节 volume_id 置空', () => {
    store.createVolume({ id: 'v-1', projectId: 'p-1', volumeNumber: 1, title: '', outline: '', sortOrder: 0 })
    setupChapter('p-1', 'ch-1', 1)
    store.updateChapter('ch-1', { volumeId: 'v-1' })
    expect(store.deleteVolume('v-1')).toBe(true)
    expect(store.getVolume('v-1')).toBeUndefined()
    // 章节仍在但 volume_id 已置空
    const ch = store.getChapterById('ch-1')
    expect(ch).toBeDefined()
    expect(ch!.volumeId).toBeNull()
  })

  it('deleteVolume 不存在返回 false', () => {
    expect(store.deleteVolume('nonexistent')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// 2. Faction CRUD
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - Faction CRUD', () => {
  beforeEach(() => setupProject())

  function createFaction(id: string, name: string, leaderId: string | null = null) {
    return store.createFaction({
      id, projectId: 'p-1', name, description: '', type: 'sect',
      leaderId, ideology: '', strength: 'medium', resources: [],
      allies: [], enemies: [], status: 'active', chapterSpans: [],
    })
  }

  it('createFaction 创建势力并返回完整对象', () => {
    const f = createFaction('f-1', '青云门')
    expect(f.id).toBe('f-1')
    expect(f.name).toBe('青云门')
    expect(f.chapterSpans).toEqual([])
  })

  it('listFactions 返回项目下所有势力', () => {
    createFaction('f-1', 'A')
    createFaction('f-2', 'B')
    expect(store.listFactions('p-1')).toHaveLength(2)
  })

  it('updateFaction 更新字段', () => {
    createFaction('f-1', 'A')
    const updated = store.updateFaction('f-1', { name: 'B', strength: 'strong' })
    expect(updated?.name).toBe('B')
    expect(updated?.strength).toBe('strong')
  })

  it('updateFaction 不存在返回 undefined', () => {
    expect(store.updateFaction('nonexistent', { name: 'x' })).toBeUndefined()
  })

  it('deleteFaction 删除势力时级联清理 edges', () => {
    const c1 = setupCharacter('p-1', 'c-1', '林墨')
    createFaction('f-1', 'A', c1.id)
    // 手动建一条 faction → character 边
    store.createEdge('p-1', {
      sourceId: 'f-1', sourceType: 'faction',
      targetId: c1.id, targetType: 'character',
      edgeType: 'member', label: '门主',
    })
    expect(store.deleteFaction('f-1')).toBe(true)
    expect(store.getFaction('f-1')).toBeUndefined()
    // 边也应被清理
    expect(store.listEdges('p-1').filter((e) => e.sourceId === 'f-1' || e.targetId === 'f-1')).toHaveLength(0)
  })

  it('deleteFaction 不存在返回 false', () => {
    expect(store.deleteFaction('nonexistent')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// 3. Location CRUD
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - Location CRUD', () => {
  beforeEach(() => setupProject())

  function createLocation(id: string, name: string, parentId: string | null = null, factionId: string | null = null) {
    return store.createLocation({
      id, projectId: 'p-1', name, description: '',
      type: 'city', parentId, factionId,
      significance: 'moderate', firstChapter: null,
      appearChapters: [1, 2], status: 'normal',
    })
  }

  it('createLocation 创建地点并返回完整对象', () => {
    const l = createLocation('loc-1', '长安城')
    expect(l.id).toBe('loc-1')
    expect(l.appearChapters).toEqual([1, 2])
  })

  it('listLocations 返回项目下所有地点', () => {
    createLocation('loc-1', 'A')
    createLocation('loc-2', 'B')
    expect(store.listLocations('p-1')).toHaveLength(2)
  })

  it('updateLocation 更新字段', () => {
    createLocation('loc-1', 'A')
    const updated = store.updateLocation('loc-1', { name: 'B', status: 'destroyed' })
    expect(updated?.name).toBe('B')
    expect(updated?.status).toBe('destroyed')
  })

  it('updateLocation 不存在返回 undefined', () => {
    expect(store.updateLocation('nonexistent', { name: 'x' })).toBeUndefined()
  })

  it('deleteLocation 删除地点时级联清理 edges', () => {
    createLocation('loc-1', 'A')
    store.createEdge('p-1', {
      sourceId: 'loc-1', sourceType: 'location',
      targetId: 'loc-1', targetType: 'location',
      edgeType: 'hierarchy', label: '',
    })
    expect(store.deleteLocation('loc-1')).toBe(true)
    expect(store.getLocation('loc-1')).toBeUndefined()
    expect(store.listEdges('p-1')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// 4. WorldElement CRUD
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - WorldElement CRUD', () => {
  beforeEach(() => setupProject())

  function createWorldElement(id: string, name: string, parentId: string | null = null) {
    return store.createWorldElement({
      id, projectId: 'p-1', category: 'power_system',
      name, description: '', parentId, attributes: { key: 'value' },
    })
  }

  it('createWorldElement 创建世界要素', () => {
    const w = createWorldElement('w-1', '灵力体系')
    expect(w.id).toBe('w-1')
    expect(w.attributes).toEqual({ key: 'value' })
  })

  it('listWorldElements 返回项目下所有要素', () => {
    createWorldElement('w-1', 'A')
    createWorldElement('w-2', 'B')
    expect(store.listWorldElements('p-1')).toHaveLength(2)
  })

  it('updateWorldElement 更新字段', () => {
    createWorldElement('w-1', 'A')
    const updated = store.updateWorldElement('w-1', { name: 'B', attributes: { x: 1 } })
    expect(updated?.name).toBe('B')
    expect(updated?.attributes).toEqual({ x: 1 })
  })

  it('deleteWorldElement 删除时清理 edges', () => {
    createWorldElement('w-1', 'A')
    store.createEdge('p-1', {
      sourceId: 'w-1', sourceType: 'world_element',
      targetId: 'w-1', targetType: 'world_element',
      edgeType: 'hierarchy', label: '',
    })
    expect(store.deleteWorldElement('w-1')).toBe(true)
    expect(store.listEdges('p-1')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// 5. Edge CRUD + deleteEdgesByEntity
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - Edge CRUD', () => {
  beforeEach(() => setupProject())

  it('createEdge 创建边并生成 id', () => {
    const c1 = setupCharacter('p-1', 'c-1', 'A')
    const c2 = setupCharacter('p-1', 'c-2', 'B')
    const e = store.createEdge('p-1', {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '师徒',
    })
    expect(e.id).toBeDefined()
    expect(e.label).toBe('师徒')
    expect(e.auto).toBe(false)
  })

  it('listEdges 返回项目下所有边', () => {
    const c1 = setupCharacter('p-1', 'c-1', 'A')
    const c2 = setupCharacter('p-1', 'c-2', 'B')
    store.createEdge('p-1', {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })
    expect(store.listEdges('p-1')).toHaveLength(1)
  })

  it('deleteEdge 删除指定边', () => {
    const c1 = setupCharacter('p-1', 'c-1', 'A')
    const c2 = setupCharacter('p-1', 'c-2', 'B')
    const e = store.createEdge('p-1', {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })
    expect(store.deleteEdge(e.id)).toBe(true)
    expect(store.deleteEdge(e.id)).toBe(false)
  })

  it('deleteEdgesByEntity 删除实体相关的所有边', () => {
    const c1 = setupCharacter('p-1', 'c-1', 'A')
    const c2 = setupCharacter('p-1', 'c-2', 'B')
    const c3 = setupCharacter('p-1', 'c-3', 'C')
    store.createEdge('p-1', { sourceId: c1.id, sourceType: 'character', targetId: c2.id, targetType: 'character', edgeType: 'relationship', label: '' })
    store.createEdge('p-1', { sourceId: c1.id, sourceType: 'character', targetId: c3.id, targetType: 'character', edgeType: 'mentor', label: '' })
    store.createEdge('p-1', { sourceId: c2.id, sourceType: 'character', targetId: c3.id, targetType: 'character', edgeType: 'rivalry', label: '' })
    // 删除 c1 相关的 2 条边
    const deleted = store.deleteEdgesByEntity(c1.id)
    expect(deleted).toBe(2)
    // 只剩 c2-c3 一条
    expect(store.listEdges('p-1')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════
// 6. WorldRule / StyleGuide / Constraint / InfoLayer CRUD
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - WorldRule CRUD', () => {
  beforeEach(() => setupProject())

  it('createWorldRule + getWorldRule round-trip', () => {
    store.createWorldRule({ id: 'wr-1', projectId: 'p-1', category: 'magic', rule: '灵力守恒', cost: null, isFixed: true })
    const list = store.listWorldRules('p-1')
    expect(list).toHaveLength(1)
    expect(list[0].rule).toBe('灵力守恒')
    expect(list[0].isFixed).toBe(true)
  })

  it('updateWorldRule 动态字段更新', () => {
    store.createWorldRule({ id: 'wr-1', projectId: 'p-1', category: 'magic', rule: 'A', cost: null, isFixed: false })
    const updated = store.updateWorldRule('wr-1', { rule: 'B', isFixed: true })
    expect(updated?.rule).toBe('B')
    expect(updated?.isFixed).toBe(true)
  })

  it('deleteWorldRule', () => {
    store.createWorldRule({ id: 'wr-1', projectId: 'p-1', category: 'magic', rule: 'A', cost: null, isFixed: false })
    expect(store.deleteWorldRule('wr-1')).toBe(true)
    expect(store.deleteWorldRule('wr-1')).toBe(false)
  })
})

describe('NovelStore - StyleGuide CRUD', () => {
  beforeEach(() => setupProject())

  it('createStyleGuide + listStyleGuide round-trip', () => {
    store.createStyleGuide({ id: 'sg-1', projectId: 'p-1', category: 'dialog', rule: '短句为主', example: '是的。' })
    const list = store.listStyleGuide('p-1')
    expect(list).toHaveLength(1)
    expect(list[0].example).toBe('是的。')
  })

  it('updateStyleGuide + deleteStyleGuide', () => {
    store.createStyleGuide({ id: 'sg-1', projectId: 'p-1', category: 'dialog', rule: 'A', example: null })
    expect(store.updateStyleGuide('sg-1', { rule: 'B' })?.rule).toBe('B')
    expect(store.deleteStyleGuide('sg-1')).toBe(true)
    expect(store.deleteStyleGuide('sg-1')).toBe(false)
  })
})

describe('NovelStore - Constraint CRUD', () => {
  beforeEach(() => setupProject())

  it('createConstraint + listConstraints round-trip', () => {
    store.createConstraint({
      id: 'ct-1', projectId: 'p-1', type: 'fact',
      scope: 'global', rule: '不可有龙傲天', isActive: true, relatedEntityId: null,
    })
    const list = store.listConstraints('p-1')
    expect(list).toHaveLength(1)
    expect(list[0].rule).toBe('不可有龙傲天')
  })

  it('updateConstraint + deleteConstraint', () => {
    store.createConstraint({
      id: 'ct-1', projectId: 'p-1', type: 'fact',
      scope: 'global', rule: 'A', isActive: true, relatedEntityId: null,
    })
    expect(store.updateConstraint('ct-1', { rule: 'B' })?.rule).toBe('B')
    expect(store.deleteConstraint('ct-1')).toBe(true)
  })
})

describe('NovelStore - InfoLayer CRUD', () => {
  beforeEach(() => setupProject())

  it('createInformationLayer + listInformationLayers round-trip', () => {
    store.createInformationLayer({
      id: 'il-1', projectId: 'p-1',
      infoDescription: '主角知道自己的身世',
      authorKnows: true, readerKnows: false,
      characterKnowledge: '{}', revealStage: 'mid', revealChapter: null,
      isRevealed: false, linkedForeshadows: '[]',
    })
    const list = store.listInformationLayers('p-1')
    expect(list).toHaveLength(1)
    expect(list[0].authorKnows).toBe(true)
  })

  it('getInformationLayer 按 id 查询', () => {
    store.createInformationLayer({
      id: 'il-1', projectId: 'p-1',
      infoDescription: 'X', authorKnows: true, readerKnows: false,
      characterKnowledge: '{}', revealStage: null, revealChapter: null,
      isRevealed: false, linkedForeshadows: '[]',
    })
    expect(store.getInformationLayer('il-1')?.infoDescription).toBe('X')
    expect(store.getInformationLayer('nonexistent')).toBeUndefined()
  })

  it('updateInfoLayer + deleteInfoLayer', () => {
    store.createInformationLayer({
      id: 'il-1', projectId: 'p-1',
      infoDescription: 'A', authorKnows: false, readerKnows: false,
      characterKnowledge: '{}', revealStage: null, revealChapter: null,
      isRevealed: false, linkedForeshadows: '[]',
    })
    const updated = store.updateInfoLayer('il-1', { authorKnows: true, isRevealed: true })
    expect(updated?.authorKnows).toBe(true)
    expect(updated?.isRevealed).toBe(true)
    expect(store.deleteInfoLayer('il-1')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// 7. Marker CRUD
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - Marker CRUD', () => {
  beforeEach(() => setupProject())

  it('createMarker + getMarker round-trip', () => {
    store.createMarker({
      id: 'm-1', projectId: 'p-1', chapter: 5,
      title: '关键转折', note: '此处主角觉醒',
      type: 'turning-point', color: 'red',
      entityType: 'character', entityId: 'c-1',
    })
    const m = store.getMarker('m-1')
    expect(m?.title).toBe('关键转折')
    expect(m?.color).toBe('red')
    expect(m?.entityType).toBe('character')
  })

  it('listMarkers 返回项目下所有标记', () => {
    store.createMarker({ id: 'm-1', projectId: 'p-1', chapter: 1, title: '', note: '', type: 'turning-point', color: 'blue', entityType: null, entityId: null })
    store.createMarker({ id: 'm-2', projectId: 'p-1', chapter: 2, title: '', note: '', type: 'turning-point', color: 'blue', entityType: null, entityId: null })
    expect(store.listMarkers('p-1')).toHaveLength(2)
  })

  it('updateMarker + deleteMarker', () => {
    store.createMarker({ id: 'm-1', projectId: 'p-1', chapter: 1, title: 'A', note: '', type: 'turning-point', color: 'blue', entityType: null, entityId: null })
    expect(store.updateMarker('m-1', { title: 'B', color: 'red' })?.title).toBe('B')
    expect(store.deleteMarker('m-1')).toBe(true)
    expect(store.deleteMarker('m-1')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// 8. Relationship CRUD
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - Relationship CRUD', () => {
  beforeEach(() => setupProject())

  it('createRelationship 创建关系', () => {
    const c1 = setupCharacter('p-1', 'c-1', '林墨')
    const c2 = setupCharacter('p-1', 'c-2', '苏雪')
    const r = store.createRelationship({
      id: 'r-1', projectId: 'p-1',
      characterA: c1.id, characterB: c2.id,
      relationType: '恋人', currentStage: '相识', stageHistory: '[]',
      dynamicRole: '', alignment: 'ally', trend: 'warming',
      chapterHint: '', lastUpdatedChapter: null,
    })
    expect(r.id).toBe('r-1')
    expect(r.alignment).toBe('ally')
  })

  it('listRelationships 返回项目下所有关系', () => {
    const c1 = setupCharacter('p-1', 'c-1', 'A')
    const c2 = setupCharacter('p-1', 'c-2', 'B')
    store.createRelationship({
      id: 'r-1', projectId: 'p-1',
      characterA: c1.id, characterB: c2.id,
      relationType: '朋友', currentStage: '', stageHistory: '[]',
      dynamicRole: '', alignment: 'neutral', trend: 'stable',
      chapterHint: '', lastUpdatedChapter: null,
    })
    expect(store.listRelationships('p-1')).toHaveLength(1)
  })

  it('updateRelationship 更新阶段与字段', () => {
    const c1 = setupCharacter('p-1', 'c-1', 'A')
    const c2 = setupCharacter('p-1', 'c-2', 'B')
    store.createRelationship({
      id: 'r-1', projectId: 'p-1',
      characterA: c1.id, characterB: c2.id,
      relationType: '朋友', currentStage: '相识', stageHistory: '[]',
      dynamicRole: '', alignment: 'neutral', trend: 'stable',
      chapterHint: '', lastUpdatedChapter: null,
    })
    const updated = store.updateRelationship('r-1', {
      currentStage: '相爱', alignment: 'ally', trend: 'warming',
    })
    expect(updated?.currentStage).toBe('相爱')
    expect(updated?.alignment).toBe('ally')
  })

  it('deleteRelationship', () => {
    const c1 = setupCharacter('p-1', 'c-1', 'A')
    const c2 = setupCharacter('p-1', 'c-2', 'B')
    store.createRelationship({
      id: 'r-1', projectId: 'p-1',
      characterA: c1.id, characterB: c2.id,
      relationType: '朋友', currentStage: '', stageHistory: '[]',
      dynamicRole: '', alignment: 'neutral', trend: 'stable',
      chapterHint: '', lastUpdatedChapter: null,
    })
    expect(store.deleteRelationship('r-1')).toBe(true)
    expect(store.deleteRelationship('r-1')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// 9. AgentLog CRUD + 过滤
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - AgentLog CRUD', () => {
  beforeEach(() => setupProject())

  function createLog(id: string, agentType: string, chapterNumber: number | null = 1) {
    return store.insertAgentLog({
      projectId: 'p-1', chapterNumber, agentType,
      agentName: agentType, displayAgentType: agentType, displayAgentName: agentType,
      phase: 'writing', systemPrompt: 'sys', chapterContext: 'ctx', userMessage: 'u',
      taskInput: '', userInstructions: [], tools: [], toolNames: [],
      result: 'ok', resultLength: 2, durationMs: 100, status: 'success',
      error: '', sessionId: '',
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
      llmProvider: 'test', llmModel: 'test-model',
    } as Parameters<NovelStore['insertAgentLog']>[0])
  }

  it('insertAgentLog 写入日志并生成 id', () => {
    const log = createLog('ignore', 'writer')
    expect(log.id).toBeDefined()
    expect(log.agentType).toBe('writer')
    expect(log.inputTokens).toBe(10)
  })

  it('getAgentLog 按 id 查询完整日志', () => {
    const log = createLog('ignore', 'writer')
    const got = store.getAgentLog(log.id)
    expect(got?.systemPrompt).toBe('sys')
    expect(got?.result).toBe('ok')
  })

  it('listAgentLogs 默认返回全部', () => {
    createLog('ignore', 'writer', 1)
    createLog('ignore', 'reviewer', 2)
    const list = store.listAgentLogs('p-1')
    expect(list).toHaveLength(2)
  })

  it('listAgentLogs 按 agentType 过滤', () => {
    createLog('ignore', 'writer', 1)
    createLog('ignore', 'reviewer', 2)
    const list = store.listAgentLogs('p-1', { agentType: 'writer' })
    expect(list).toHaveLength(1)
    expect(list[0].agentType).toBe('writer')
  })

  it('listAgentLogs 按 chapterNumber 过滤', () => {
    createLog('ignore', 'writer', 1)
    createLog('ignore', 'reviewer', 2)
    const list = store.listAgentLogs('p-1', { chapterNumber: 2 })
    expect(list).toHaveLength(1)
    expect(list[0].chapterNumber).toBe(2)
  })

  it('deleteAgentLogsByProject 清空项目日志', () => {
    createLog('ignore', 'writer', 1)
    createLog('ignore', 'reviewer', 2)
    const deleted = store.deleteAgentLogsByProject('p-1')
    expect(deleted).toBe(2)
    expect(store.listAgentLogs('p-1')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// 10. ChapterVersion 快照与回滚
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - ChapterVersion 快照与回滚', () => {
  beforeEach(() => setupProject())

  it('updateChapter 改 content 时自动存版本（存档旧值）', () => {
    const ch = setupChapter('p-1', 'ch-1', 1)
    // 初始 content 为 ''，第一次更新前先把 '' 存为版本，再更新为 '第一版'
    store.updateChapterContent(ch.id, '第一版正文', 5, { phase: 'writer_initial', agentType: 'writer' })
    // 第二次更新前先把 '第一版正文' 存为版本，再更新为 '第二版'
    store.updateChapterContent(ch.id, '第二版正文', 10, { phase: 'reviser_final', agentType: 'reviser' })

    const versions = store.listChapterVersions(ch.id)
    expect(versions).toHaveLength(2)
    // 倒序返回：最新（sequence 最大）在前
    expect(versions[0].isCurrent).toBe(true)
    // 最新版存的是 '第一版正文'（被覆盖前的旧值），字数 5
    expect(versions[0].wordCount).toBe(5)
    expect(versions[1].isCurrent).toBe(false)
    expect(versions[1].wordCountDelta).toBe(0) // 最旧版 delta 为 0
  })

  it('createVersionSnapshot 显式快照（存当前正文）', () => {
    const ch = setupChapter('p-1', 'ch-1', 1)
    // 先用 'skip' 把正文设为 '正文'，不触发自动存档
    store.updateChapterContent(ch.id, '正文', 5, 'skip')
    // 再显式存档当前 '正文'
    const snap = store.createVersionSnapshot(ch.id, { phase: 'manual_snapshot', trigger: '手动快照' })
    expect(snap).toBeDefined()
    expect(snap?.phase).toBe('manual_snapshot')
    expect(snap?.trigger).toBe('手动快照')
    expect(snap?.wordCount).toBe(5)
  })

  it('getChapterVersion 按 id 取详情含全文', () => {
    const ch = setupChapter('p-1', 'ch-1', 1)
    store.updateChapterContent(ch.id, '正文', 2, 'skip')
    // 显式快照当前 '正文'
    store.createVersionSnapshot(ch.id, { phase: 'manual_snapshot' })
    const versions = store.listChapterVersions(ch.id)
    expect(versions).toHaveLength(1)
    const detail = store.getChapterVersion(versions[0].id)
    expect(detail?.content).toBe('正文')
  })

  it('rollbackToVersion 三步原子回滚', () => {
    const ch = setupChapter('p-1', 'ch-1', 1)
    // 用 'skip' 设置初始正文 '原版'，不自动存档
    store.updateChapterContent(ch.id, '原版正文', 5, 'skip')
    // 显式快照 '原版正文'
    const originalSnap = store.createVersionSnapshot(ch.id, { phase: 'manual_snapshot', trigger: '原版' })
    // 用 'skip' 更新为 '修改版'，不自动存档
    store.updateChapterContent(ch.id, '修改后正文', 10, 'skip')

    // 回滚到原版快照
    const result = store.rollbackToVersion(ch.id, originalSnap!.id)
    expect(result.savedVersionId).toBeDefined()
    expect(result.currentContent).toBe('原版正文')
    expect(result.currentWordCount).toBe(5)

    // 回滚后：manual_snapshot / rollback_pre（存'修改后正文'）/ rollback_applied（存'原版正文'）= 3 个版本
    const finalVersions = store.listChapterVersions(ch.id)
    expect(finalVersions).toHaveLength(3)
    // 当前正文已恢复为原版
    const current = store.getChapterById(ch.id)
    expect(current?.content).toBe('原版正文')
  })

  it('rollbackToVersion 当前正文已是目标内容时抛错', () => {
    const ch = setupChapter('p-1', 'ch-1', 1)
    store.updateChapterContent(ch.id, '正文', 5, 'skip')
    const snap = store.createVersionSnapshot(ch.id, { phase: 'manual_snapshot' })
    // 当前正文 = '正文'，与快照内容相同，应抛错
    expect(() => store.rollbackToVersion(ch.id, snap!.id)).toThrow(/无需回滚/)
  })

  it('rollbackToVersion 版本不存在时抛错', () => {
    const ch = setupChapter('p-1', 'ch-1', 1)
    expect(() => store.rollbackToVersion(ch.id, 'nonexistent')).toThrow('版本不存在')
  })
})

// ═══════════════════════════════════════════════════════════════
// 11. Deduplicate / mergeWithPlan（业务核心）
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - deduplicateEntities', () => {
  beforeEach(() => setupProject())

  it('dryRun 只扫描不删除', () => {
    setupCharacter('p-1', 'c-1', '林墨')
    setupCharacter('p-1', 'c-2', '林墨') // 同名重复
    setupCharacter('p-1', 'c-3', '苏雪')

    const report = store.deduplicateEntities('p-1', { dryRun: true })
    expect(report.groups).toHaveLength(1)
    expect(report.groups[0].kind).toBe('character')
    expect(report.groups[0].key).toBe('林墨')
    expect(report.groups[0].removed).toHaveLength(1)
    expect(report.totalRemoved).toBe(1)
    // dryRun 不实际删除
    expect(store.listCharacters('p-1')).toHaveLength(3)
  })

  it('character 按 name 小写归一化判重', () => {
    setupCharacter('p-1', 'c-1', '林墨')
    setupCharacter('p-1', 'c-2', '林墨') // 完全相同
    setupCharacter('p-1', 'c-3', '苏雪')

    const report = store.deduplicateEntities('p-1')
    expect(report.totalRemoved).toBe(1)
    expect(store.listCharacters('p-1')).toHaveLength(2)
  })

  it('character 保留 createdAt 最早的', () => {
    const c1 = setupCharacter('p-1', 'c-1', '林墨')
    // 手动改 c-1 的 createdAt 让它更早
    db.prepare('UPDATE novel_characters SET created_at = ? WHERE id = ?').run(1000, c1.id)
    setupCharacter('p-1', 'c-2', '林墨')

    const report = store.deduplicateEntities('p-1')
    expect(report.groups[0].keptId).toBe(c1.id)
    // c-2 被删除
    expect(store.getCharacter('c-2')).toBeUndefined()
    expect(store.getCharacter(c1.id)).toBeDefined()
  })

  it('conflict 按 description 判重', () => {
    store.createConflict({
      id: 'cf-1', projectId: 'p-1', description: '师门之争',
      type: 'interest', intensity: 5, stage: 'emerging',
      participants: '[]', chapterSpans: [], tier: 'main',
    })
    store.createConflict({
      id: 'cf-2', projectId: 'p-1', description: '师门之争',
      type: 'interest', intensity: 5, stage: 'emerging',
      participants: '[]', chapterSpans: [], tier: 'main',
    })
    const report = store.deduplicateEntities('p-1')
    expect(report.groups[0].kind).toBe('conflict')
    expect(report.totalRemoved).toBe(1)
    expect(store.listConflicts('p-1')).toHaveLength(1)
  })

  it('faction 按 name 判重并迁移 locations.faction_id', () => {
    store.createFaction({
      id: 'f-1', projectId: 'p-1', name: '青云门', description: '', type: 'sect',
      leaderId: null, ideology: '', strength: 'medium', resources: [],
      allies: [], enemies: [], status: 'active', chapterSpans: [],
    })
    store.createFaction({
      id: 'f-2', projectId: 'p-1', name: '青云门', description: '', type: 'sect',
      leaderId: null, ideology: '', strength: 'medium', resources: [],
      allies: [], enemies: [], status: 'active', chapterSpans: [],
    })
    store.createLocation({
      id: 'loc-1', projectId: 'p-1', name: 'A', description: '',
      type: 'city', parentId: null, factionId: 'f-2',
      significance: 'moderate', firstChapter: null,
      appearChapters: [], status: 'normal',
    })

    const report = store.deduplicateEntities('p-1')
    expect(report.totalRemoved).toBe(1)
    // f-2 被删除，location 的 factionId 应迁到 f-1
    const loc = store.getLocation('loc-1')
    expect(loc?.factionId).toBe('f-1')
  })

  it('无重复时返回空报告', () => {
    setupCharacter('p-1', 'c-1', 'A')
    setupCharacter('p-1', 'c-2', 'B')
    const report = store.deduplicateEntities('p-1')
    expect(report.groups).toHaveLength(0)
    expect(report.totalRemoved).toBe(0)
  })
})

describe('NovelStore - mergeWithPlan', () => {
  beforeEach(() => setupProject())

  it('按 LLM 方案合并 character 并迁移 edges + relationships', () => {
    const c1 = setupCharacter('p-1', 'c-1', '林墨')
    const c2 = setupCharacter('p-1', 'c-2', '林墨之') // 相似但不同名
    const c3 = setupCharacter('p-1', 'c-3', '苏雪')

    // c2 → c3 的关系
    store.createRelationship({
      id: 'r-1', projectId: 'p-1',
      characterA: c2.id, characterB: c3.id,
      relationType: '朋友', currentStage: '', stageHistory: '[]',
      dynamicRole: '', alignment: 'neutral', trend: 'stable',
      chapterHint: '', lastUpdatedChapter: null,
    })
    // c2 → c3 的边
    store.createEdge('p-1', {
      sourceId: c2.id, sourceType: 'character',
      targetId: c3.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })

    const result = store.mergeWithPlan('p-1', [{
      kind: 'character',
      reason: '都是主角的化身',
      similarity: 0.8,
      keptId: c1.id,
      removed: [{ id: c2.id, name: '林墨之' }],
    }])

    expect(result.totalMerged).toBe(1)
    // c2 被删除
    expect(store.getCharacter(c2.id)).toBeUndefined()
    // 关系和边应迁移到 c1
    const rel = store.listRelationships('p-1')
    expect(rel).toHaveLength(1)
    expect(rel[0].characterA).toBe(c1.id)
    expect(rel[0].characterB).toBe(c3.id)
    const edges = store.listEdges('p-1')
    expect(edges).toHaveLength(1)
    expect(edges[0].sourceId).toBe(c1.id)
  })

  it('fieldMerges 先迁移字段值再删除', () => {
    const c1 = setupCharacter('p-1', 'c-1', '林墨')
    const c2 = setupCharacter('p-1', 'c-2', '林墨之')

    // c2 有更丰富的 description
    store.updateCharacter(c2.id, { description: '更详细的描述' })

    store.mergeWithPlan('p-1', [{
      kind: 'character',
      reason: '相似',
      similarity: 0.7,
      keptId: c1.id,
      removed: [{ id: c2.id, name: '林墨之' }],
      fieldMerges: [{ field: 'description', fromId: c2.id, fromName: '林墨之', reason: '保留更详细版本' }],
    }])

    // c1 的 description 应已被 c2 的值覆盖
    const kept = store.getCharacter(c1.id)
    expect(kept?.description).toBe('更详细的描述')
  })

  it('跨项目实体被拒绝', () => {
    store.createProject({
      id: 'p-2', title: '另一本', genre: 'x', synopsis: '', targetWords: 0,
      currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
    })
    const c1 = setupCharacter('p-1', 'c-1', 'A')
    const c2 = setupCharacter('p-2', 'c-2', 'A')

    expect(() => {
      store.mergeWithPlan('p-1', [{
        kind: 'character', reason: '', similarity: 0.5,
        keptId: c1.id, removed: [{ id: c2.id, name: 'A' }],
      }])
    }).toThrow(/非当前项目实体/)

    // 失败后两个角色都应仍存在（事务回滚）
    expect(store.getCharacter(c1.id)).toBeDefined()
    expect(store.getCharacter(c2.id)).toBeDefined()
  })

  it('空数组直接返回 0', () => {
    const result = store.mergeWithPlan('p-1', [])
    expect(result.totalMerged).toBe(0)
  })

  it('world_element kind 走 retargetEdges + delete（无独立关联表）', () => {
    const w1 = store.createWorldElement({
      id: 'w-1', projectId: 'p-1', category: 'power_system',
      name: '灵力', description: '', parentId: null, attributes: {},
    })
    const w2 = store.createWorldElement({
      id: 'w-2', projectId: 'p-1', category: 'power_system',
      name: '灵力体系', description: '', parentId: null, attributes: {},
    })
    // 手动建一条 w2 → w1 的边
    store.createEdge('p-1', {
      sourceId: w2.id, sourceType: 'world_element',
      targetId: w1.id, targetType: 'world_element',
      edgeType: 'hierarchy', label: '',
    })

    store.mergeWithPlan('p-1', [{
      kind: 'world_element', reason: '相似', similarity: 0.8,
      keptId: w1.id, removed: [{ id: w2.id, name: '灵力体系' }],
    }])

    expect(store.getWorldElement(w2.id)).toBeUndefined()
    // 边应迁移为 w1 → w1 自环后被删除（合并后自环删除）
    expect(store.listEdges('p-1')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// 12. 软删除 trash/restore/purge/emptyTrash
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - 项目软删除', () => {
  beforeEach(() => setupProject())

  it('deleteProject 软删除（移入回收站）', () => {
    expect(store.deleteProject('p-1')).toBe(true)
    // listProjects 不含已删除
    expect(store.listProjects()).toHaveLength(0)
    // listTrashedProjects 含已删除
    expect(store.listTrashedProjects()).toHaveLength(1)
    expect(store.listTrashedProjects()[0].id).toBe('p-1')
  })

  it('deleteProject 重复删除返回 false', () => {
    expect(store.deleteProject('p-1')).toBe(true)
    expect(store.deleteProject('p-1')).toBe(false)
  })

  it('restoreProject 从回收站恢复', () => {
    store.deleteProject('p-1')
    expect(store.restoreProject('p-1')).toBe(true)
    expect(store.listProjects()).toHaveLength(1)
    expect(store.listTrashedProjects()).toHaveLength(0)
  })

  it('restoreProject 不在回收站返回 false', () => {
    expect(store.restoreProject('p-1')).toBe(false)
  })

  it('purgeProject 永久删除（仅限回收站中的项目）', () => {
    // 未删除时 purge 应失败
    expect(store.purgeProject('p-1')).toBe(false)
    // 软删除后才能 purge
    store.deleteProject('p-1')
    expect(store.purgeProject('p-1')).toBe(true)
    expect(store.listTrashedProjects()).toHaveLength(0)
  })

  it('emptyTrash 清空回收站', () => {
    setupProject('p-2')
    store.deleteProject('p-1')
    store.deleteProject('p-2')
    const count = store.emptyTrash()
    expect(count).toBe(2)
    expect(store.listTrashedProjects()).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// 13. deleteProject 级联（外键 CASCADE 验证）
// ═══════════════════════════════════════════════════════════════

describe('NovelStore - purgeProject 级联清理', () => {
  beforeEach(() => setupProject())

  it('purgeProject 后项目关联数据全部清理', () => {
    // 准备各类关联数据
    setupChapter('p-1', 'ch-1', 1)
    setupCharacter('p-1', 'c-1', '林墨')
    store.createVolume({ id: 'v-1', projectId: 'p-1', volumeNumber: 1, title: '', outline: '', sortOrder: 0 })
    store.createWorldRule({ id: 'wr-1', projectId: 'p-1', category: 'magic', rule: 'A', cost: null, isFixed: false })

    store.deleteProject('p-1')
    store.purgeProject('p-1')

    // 项目已不存在
    expect(store.getProject('p-1')).toBeUndefined()
    // 章节级联删除
    expect(store.listChapters('p-1')).toHaveLength(0)
    // 角色级联删除
    expect(store.listCharacters('p-1')).toHaveLength(0)
    // 卷级联删除
    expect(store.listVolumes('p-1')).toHaveLength(0)
    // 世界规则级联删除
    expect(store.listWorldRules('p-1')).toHaveLength(0)
  })

  it('purgeProject 清理无 ON DELETE CASCADE 的关联表', () => {
    // node_positions 和 character_history 无级联
    setupCharacter('p-1', 'c-1', '林墨')
    store.createCharacterHistory({
      projectId: 'p-1', characterId: 'c-1', chapterId: null,
      fieldName: 'currentState', oldValue: null, newValue: '觉醒',
      reason: '剧情推进', chapterNumber: 1,
    })
    store.upsertNodePosition('p-1', 'character', 'c-1', 100, 200)

    store.deleteProject('p-1')
    store.purgeProject('p-1')

    // character_history 应被手动清理
    const remainingHistory = db.prepare('SELECT * FROM novel_character_history WHERE project_id = ?').all('p-1')
    expect(remainingHistory).toHaveLength(0)
    // node_positions 应被手动清理
    const remainingPositions = db.prepare('SELECT * FROM novel_node_positions WHERE project_id = ?').all('p-1')
    expect(remainingPositions).toHaveLength(0)
  })
})
