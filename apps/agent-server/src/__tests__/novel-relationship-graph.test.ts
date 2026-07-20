import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { RelationshipGraph } from '../plugins/novel-plugin/core/novel-relationship-graph.js'

let db: Database.Database
let store: NovelStore
let graph: RelationshipGraph

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  store = new NovelStore(db)
  graph = new RelationshipGraph(store)
})

afterEach(() => {
  db.close()
})

/** 创建测试项目的辅助函数 */
function setupProject(projectId = 'p-1') {
  store.createProject({
    id: projectId,
    title: '测试小说',
    genre: '玄幻',
    synopsis: '',
    targetWords: 0,
    currentVolume: 1,
    currentChapter: 0,
    currentStage: 'setup',
    status: 'active',
  })
  return projectId
}

/** 创建测试角色 */
function setupCharacter(projectId: string, id: string, name: string) {
  return store.createCharacter({
    id,
    projectId,
    name,
    description: '',
    identity: '',
    personality: '',
    appearance: '',
    currentState: '',
    currentGoal: '',
    currentPressure: '',
    secret: '',
    arcStage: 'introduction',
    arcHistory: '[]',
    speechStyle: '',
    isProtagonist: false,
    longTermDesire: '',
    plotRole: 'supporting',
    removalImpact: '',
  })
}

describe('RelationshipGraph - findNeighbors', () => {
  it('空项目返回空数组', () => {
    const projectId = setupProject()
    const c = setupCharacter(projectId, 'c-1', '林墨')
    expect(graph.findNeighbors(c.id)).toEqual([])
  })

  it('聚合 novel_edges 表的手动边', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    store.createEdge(projectId, {
      sourceId: c1.id,
      sourceType: 'character',
      targetId: c2.id,
      targetType: 'character',
      edgeType: 'relationship',
      label: '师徒',
    })
    const neighbors = graph.findNeighbors(c1.id)
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].edgeType).toBe('relationship')
    expect(neighbors[0].auto).toBe(false)
    expect(neighbors[0].label).toBe('师徒')
  })

  it('聚合 conflict.participants 派生的 involvement 边', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    store.createConflict({
      id: 'cf-1',
      projectId,
      description: '师门之争',
      type: 'interest',
      intensity: 5,
      stage: 'emerging',
      participants: JSON.stringify([c1.id, c2.id]),
      chapterSpans: [],
      tier: 'main',
    })
    const neighbors = graph.findNeighbors(c1.id, ['involvement'])
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].edgeType).toBe('involvement')
    expect(neighbors[0].auto).toBe(true)
    expect(neighbors[0].sourceType).toBe('conflict')
    expect(neighbors[0].targetId).toBe(c1.id)
  })

  it('聚合 faction.leaderId 派生的 member 边', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    store.createFaction({
      id: 'f-1',
      projectId,
      name: '青云门',
      description: '',
      type: 'sect',
      leaderId: c1.id,
      ideology: '',
      strength: 'medium',
      resources: [],
      allies: [],
      enemies: [],
      status: 'active',
      chapterSpans: [],
    })
    const neighbors = graph.findNeighbors(c1.id, ['member'])
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].edgeType).toBe('member')
    expect(neighbors[0].sourceType).toBe('faction')
  })

  it('聚合 faction.allies 派生的 alliance 边（双向）', () => {
    const projectId = setupProject()
    store.createFaction({
      id: 'f-1', projectId, name: '青云门', description: '', type: 'sect',
      leaderId: null, ideology: '', strength: 'medium', resources: [],
      allies: ['f-2'], enemies: [], status: 'active', chapterSpans: [],
    })
    store.createFaction({
      id: 'f-2', projectId, name: '天剑宗', description: '', type: 'sect',
      leaderId: null, ideology: '', strength: 'medium', resources: [],
      allies: [], enemies: [], status: 'active', chapterSpans: [],
    })
    const neighbors = graph.findNeighbors('f-1', ['alliance'])
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].edgeType).toBe('alliance')
    expect(neighbors[0].targetId).toBe('f-2')
  })

  it('聚合 novel_relationships 表的角色关系边', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    store.createRelationship({
      id: 'r-1',
      projectId,
      characterA: c1.id,
      characterB: c2.id,
      relationType: '恋人',
      currentStage: '相识',
      stageHistory: '[]',
      dynamicRole: '',
      alignment: 'ally',
      trend: 'warming',
      chapterHint: '',
      lastUpdatedChapter: null,
    })
    const neighbors = graph.findNeighbors(c1.id, ['relationship'])
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].fromRelationship).toBe(true)
    expect(neighbors[0].label).toBe('恋人')
    expect(neighbors[0].relationship?.alignment).toBe('ally')
  })

  it('edgeTypes 过滤：只返回指定类型的边', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    // 一条手动 relationship 边
    store.createEdge(projectId, {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '师徒',
    })
    // 一条手动 mentor 边
    store.createEdge(projectId, {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'mentor', label: '',
    })
    const onlyRelationship = graph.findNeighbors(c1.id, ['relationship'])
    expect(onlyRelationship).toHaveLength(1)
    expect(onlyRelationship[0].edgeType).toBe('relationship')

    const onlyMentor = graph.findNeighbors(c1.id, ['mentor'])
    expect(onlyMentor).toHaveLength(1)
    expect(onlyMentor[0].edgeType).toBe('mentor')
  })

  it('去重：相同 (source, target, edgeType) 优先保留持久化边', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    // 手动边
    store.createEdge(projectId, {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '手动',
    })
    // 同对角色的 relationships 表记录（派生边）
    store.createRelationship({
      id: 'r-1', projectId,
      characterA: c1.id, characterB: c2.id,
      relationType: '恋人', currentStage: '相识', stageHistory: '[]',
      dynamicRole: '', alignment: 'ally', trend: 'warming',
      chapterHint: '', lastUpdatedChapter: null,
    })
    const neighbors = graph.findNeighbors(c1.id, ['relationship'])
    // 应该去重为 1 条，优先保留手动边
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].auto).toBe(false)
    expect(neighbors[0].label).toBe('手动')
  })
})

describe('RelationshipGraph - findPath', () => {
  it('相同实体返回单节点路径', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const path = graph.findPath(c1.id, c1.id)
    expect(path.found).toBe(true)
    expect(path.nodes).toHaveLength(1)
    expect(path.edges).toHaveLength(0)
  })

  it('直连路径（深度 1）', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    store.createEdge(projectId, {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })
    const path = graph.findPath(c1.id, c2.id)
    expect(path.found).toBe(true)
    expect(path.edges).toHaveLength(1)
    expect(path.nodes).toHaveLength(2)
    expect(path.nodes[0].id).toBe(c1.id)
    expect(path.nodes[1].id).toBe(c2.id)
  })

  it('两跳路径（深度 2）', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    const c3 = setupCharacter(projectId, 'c-3', '陈玄')
    store.createEdge(projectId, {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })
    store.createEdge(projectId, {
      sourceId: c2.id, sourceType: 'character',
      targetId: c3.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })
    const path = graph.findPath(c1.id, c3.id)
    expect(path.found).toBe(true)
    expect(path.edges).toHaveLength(2)
    expect(path.nodes).toHaveLength(3)
  })

  it('无路径时 found=false', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    const path = graph.findPath(c1.id, c2.id)
    expect(path.found).toBe(false)
    expect(path.edges).toHaveLength(0)
  })

  it('maxDepth 限制搜索深度', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    const c3 = setupCharacter(projectId, 'c-3', '陈玄')
    store.createEdge(projectId, {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })
    store.createEdge(projectId, {
      sourceId: c2.id, sourceType: 'character',
      targetId: c3.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })
    // maxDepth=1 找不到 c3
    const path = graph.findPath(c1.id, c3.id, 1)
    expect(path.found).toBe(false)
  })
})

describe('RelationshipGraph - findEntityChapters', () => {
  it('角色：从 character_history 反查章节', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    store.createChapter({
      id: 'ch-1', projectId, volume: 1, chapterNumber: 1,
      title: '第一章', content: '林墨登场', wordCount: 100,
      status: 'published', narrativeTask: '', acceptanceResult: null,
    })
    store.createCharacterHistory({
      projectId, characterId: c1.id,
      chapterId: 'ch-1', chapterNumber: 1,
      fieldName: 'currentState', oldValue: null, newValue: '本章首次出场', reason: null,
    })
    const presence = graph.findEntityChapters(c1.id, 'character')
    expect(presence).not.toBeNull()
    expect(presence!.chapters).toEqual([1])
    expect(presence!.name).toBe('林墨')
  })

  it('冲突：展开 chapterSpans', () => {
    const projectId = setupProject()
    store.createConflict({
      id: 'cf-1', projectId, description: '师门之争',
      type: 'interest', intensity: 5, stage: 'emerging',
      participants: '[]', chapterSpans: [[1, 3], [5, 6]], tier: 'main',
    })
    const presence = graph.findEntityChapters('cf-1', 'conflict')
    expect(presence).not.toBeNull()
    expect(presence!.chapters).toEqual([1, 2, 3, 5, 6])
  })

  it('伏笔：聚合 beats 和 chapterSpans', () => {
    const projectId = setupProject()
    store.createForeshadow({
      id: 'fs-1', projectId, description: '神秘吊坠',
      category: 'item', status: 'planted',
      firstChapter: 2, lastChapter: null, recoverByChapter: null,
      linkedCharacters: '[]', linkedClues: '[]',
      linkedInfoLayers: '[]', chapterSpans: [],
      beats: [
        { chapter: 2, type: 'plant' },
        { chapter: 8, type: 'reinforce' },
      ],
    })
    const presence = graph.findEntityChapters('fs-1', 'foreshadow')
    expect(presence).not.toBeNull()
    expect(presence!.chapters).toEqual([2, 8])
  })

  it('地点：返回 appearChapters', () => {
    const projectId = setupProject()
    store.createLocation({
      id: 'loc-1', projectId, name: '青云山',
      description: '', type: 'region', parentId: null, factionId: null,
      significance: 'major', firstChapter: 1, status: 'normal',
      appearChapters: [1, 3, 5],
    })
    const presence = graph.findEntityChapters('loc-1', 'location')
    expect(presence).not.toBeNull()
    expect(presence!.chapters).toEqual([1, 3, 5])
  })

  it('实体不存在时返回 null', () => {
    setupProject()
    expect(graph.findEntityChapters('nonexistent', 'character')).toBeNull()
  })
})

describe('RelationshipGraph - getAllGraphNodes / getAllGraphEdges', () => {
  it('getAllGraphNodes 返回所有实体节点', () => {
    const projectId = setupProject()
    setupCharacter(projectId, 'c-1', '林墨')
    store.createConflict({
      id: 'cf-1', projectId, description: '师门之争',
      type: 'interest', intensity: 5, stage: 'emerging',
      participants: '[]', chapterSpans: [], tier: 'main',
    })
    const nodes = graph.getAllGraphNodes(projectId)
    expect(nodes).toHaveLength(2)
    expect(nodes.map((n) => n.type).sort()).toEqual(['character', 'conflict'])
  })

  it('getAllGraphEdges 聚合三处数据源', () => {
    const projectId = setupProject()
    const c1 = setupCharacter(projectId, 'c-1', '林墨')
    const c2 = setupCharacter(projectId, 'c-2', '苏雪')
    // 手动边
    store.createEdge(projectId, {
      sourceId: c1.id, sourceType: 'character',
      targetId: c2.id, targetType: 'character',
      edgeType: 'relationship', label: '',
    })
    // relationships 表
    store.createRelationship({
      id: 'r-1', projectId,
      characterA: c1.id, characterB: c2.id,
      relationType: '恋人', currentStage: '相识', stageHistory: '[]',
      dynamicRole: '', alignment: 'ally', trend: 'warming',
      chapterHint: '', lastUpdatedChapter: null,
    })
    const edges = graph.getAllGraphEdges(projectId)
    // 至少 2 条（手动 + relationship；去重仅作用于 findNeighbors，getAllGraphEdges 返回全部）
    expect(edges.length).toBeGreaterThanOrEqual(2)
    const types = edges.map((e) => e.edgeType)
    expect(types).toContain('relationship')
  })
})
