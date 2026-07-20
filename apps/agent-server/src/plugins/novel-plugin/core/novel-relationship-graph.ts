/**
 * 统一关系查询层
 *
 * 在 store 之上聚合三处分散的图数据，提供统一的图查询 API：
 * 1. novel_edges 表（用户手动画的线，持久化）
 * 2. 实体 JSON 字段派生的自动边（运行时计算，不持久化，避免双重真相源）
 *    - conflict.participants → involvement（冲突 → 角色）
 *    - faction.leaderId → member（势力 → 角色）
 *    - faction.allies → alliance（势力 ↔ 势力）
 *    - faction.enemies → rivalry（势力 ↔ 势力）
 *    - location.parentId → hierarchy（地点 → 地点）
 *    - location.factionId → association（地点 → 势力）
 *    - worldElement.parentId → hierarchy（世界要素 → 世界要素）
 * 3. novel_relationships 表（角色语义关系，承载 alignment/trend/stageHistory 等富字段）
 *
 * 设计原则：
 * - 不持久化派生边：JSON 字段是真相源，派生边只是运行时投影
 * - 不合并 novel_relationships：它有 9 个富语义字段，edges 表只有 label，职责不同
 * - 只读：本模块只做查询聚合，不写入数据
 */

import type { NovelStore } from './novel-store.js'
import type { NovelMemoryStore } from './novel-memory-store.js'
import type {
  NovelEdge,
  NovelEdgeType,
  NovelNodeType,
  NovelRelationship,
  GraphNode,
  GraphEdge,
  GraphPath,
  EntityChapterPresence,
} from '@repo/shared/novel'
import { createEntityStrategies, type EntityStrategy, type GraphEntityType } from './entity-strategies.js'

// 关系图 4 件套类型（GraphNode/GraphEdge/GraphPath/EntityChapterPresence）
// 已迁入 @repo/shared/novel 共享包，此处 re-export 供本插件内部模块沿用相对路径引入。
export type {
  GraphNode,
  GraphEdge,
  GraphPath,
  EntityChapterPresence,
} from '@repo/shared/novel'

/**
 * 统一关系图查询层
 *
 * 使用方式：
 * ```ts
 * const graph = new RelationshipGraph(store, memoryStore)
 * const neighbors = graph.findNeighbors(characterId)
 * const path = graph.findPath(charAId, charBId)
 * const chapters = graph.findEntityChapters(characterId)
 * ```
 */
export class RelationshipGraph {
  private readonly strategies: ReadonlyMap<GraphEntityType, EntityStrategy>

  constructor(
    private readonly store: NovelStore,
    private readonly memoryStore?: NovelMemoryStore,
  ) {
    this.strategies = createEntityStrategies(store)
  }

  /**
   * 查找实体的所有邻居（双向：作为 source 或 target）
   *
   * 聚合三个数据源：
   * 1. novel_edges 表中所有以该实体为端点的边
   * 2. 从 JSON 字段派生的自动边
   * 3. novel_relationships 表（仅当实体是角色时）
   *
   * @param entityId 实体 ID
   * @param edgeTypes 可选，限定边类型
   */
  findNeighbors(entityId: string, edgeTypes?: NovelEdgeType[]): GraphEdge[] {
    const allEdges = this.getAllEdges(entityId)
    const filtered = edgeTypes
      ? allEdges.filter((e) => edgeTypes.includes(e.edgeType))
      : allEdges
    // 去重：相同 (source, target, edgeType) 组合只保留一条，优先持久化边
    const seen = new Set<string>()
    const result: GraphEdge[] = []
    // 持久化边优先（auto=false 优先）
    const sorted = [...filtered].sort((a, b) => Number(a.auto) - Number(b.auto))
    for (const edge of sorted) {
      const key = `${edge.sourceId}|${edge.targetId}|${edge.edgeType}`
      const reverseKey = `${edge.targetId}|${edge.sourceId}|${edge.edgeType}`
      if (seen.has(key) || seen.has(reverseKey)) continue
      seen.add(key)
      result.push(edge)
    }
    return result
  }

  /**
   * 查找两个实体之间的最短路径（BFS）
   *
   * @param fromId 起点实体 ID
   * @param toId 终点实体 ID
   * @param maxDepth 最大深度（默认 4，避免大图爆炸）
   */
  findPath(fromId: string, toId: string, maxDepth = 4): GraphPath {
    if (fromId === toId) {
      const node = this.getEntitySummary(fromId)
      return node
        ? { nodes: [node], edges: [], found: true }
        : { nodes: [], edges: [], found: false }
    }

    const queue: Array<{ id: string; path: GraphEdge[] }> = [{ id: fromId, path: [] }]
    const visited = new Set<string>([fromId])

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.path.length >= maxDepth) continue

      const neighbors = this.findNeighbors(current.id)
      for (const edge of neighbors) {
        const nextId = edge.sourceId === current.id ? edge.targetId : edge.sourceId
        if (visited.has(nextId)) continue
        visited.add(nextId)

        const newPath = [...current.path, edge]
        if (nextId === toId) {
          const nodes = this.resolvePathNodes(fromId, toId, newPath)
          return { nodes, edges: newPath, found: true }
        }
        queue.push({ id: nextId, path: newPath })
      }
    }

    return { nodes: [], edges: [], found: false }
  }

  /**
   * 查找实体在哪些章节出现
   *
   * 数据来源：
   * - 角色：novel_character_history 表反查
   * - 冲突/势力/线索：chapterSpans 字段展开
   * - 伏笔：beats 字段
   * - 地点：appearChapters 字段
   *
   * @param entityId 实体 ID
   * @param entityType 实体类型
   */
  findEntityChapters(entityId: string, entityType: NovelNodeType): EntityChapterPresence | null {
    const projectId = this.findProjectIdByEntity(entityId, entityType)
    if (!projectId) return null

    const name = this.getEntityName(entityId, entityType) ?? ''
    const chapters = this.collectEntityChapters(projectId, entityId, entityType)

    return {
      entityId,
      entityType,
      name,
      chapters: [...new Set(chapters)].sort((a, b) => a - b),
    }
  }

  /**
   * 获取项目所有图边（聚合三个数据源）
   *
   * 注意：大项目（100+ 实体）下派生边可能较多，建议仅在需要全图遍历时调用
   *
   * @param projectId 项目 ID
   */
  getAllGraphEdges(projectId: string): GraphEdge[] {
    return this.getAllEdgesForProject(projectId)
  }

  /**
   * 获取项目所有图节点（轻量视图）
   *
   * @param projectId 项目 ID
   */
  getAllGraphNodes(projectId: string): GraphNode[] {
    const nodes: GraphNode[] = []
    for (const c of this.store.listCharacters(projectId)) {
      nodes.push({ id: c.id, type: 'character', name: c.name })
    }
    for (const c of this.store.listConflicts(projectId)) {
      nodes.push({ id: c.id, type: 'conflict', name: c.description.slice(0, 40) })
    }
    for (const f of this.store.listForeshadowing(projectId)) {
      nodes.push({ id: f.id, type: 'foreshadow', name: f.description.slice(0, 40) })
    }
    for (const f of this.store.listFactions(projectId)) {
      nodes.push({ id: f.id, type: 'faction', name: f.name })
    }
    for (const l of this.store.listLocations(projectId)) {
      nodes.push({ id: l.id, type: 'location', name: l.name })
    }
    for (const w of this.store.listWorldElements(projectId)) {
      nodes.push({ id: w.id, type: 'world_element', name: w.name })
    }
    return nodes
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部实现
  // ═══════════════════════════════════════════════════════════════

  /** 获取单个实体相关的所有边（用于 findNeighbors） */
  private getAllEdges(entityId: string): GraphEdge[] {
    const projectId = this.findProjectIdByEntityAny(entityId)
    if (!projectId) return []
    const allEdges = this.getAllEdgesForProject(projectId)
    return allEdges.filter((e) => e.sourceId === entityId || e.targetId === entityId)
  }

  /** 获取项目所有边（聚合三处数据源） */
  private getAllEdgesForProject(projectId: string): GraphEdge[] {
    const edges: GraphEdge[] = []

    // 数据源 1：novel_edges 表（持久化手动边）
    for (const e of this.store.listEdges(projectId)) {
      edges.push(this.toGraphEdge(e))
    }

    // 数据源 2：派生自动边（从 JSON 字段计算）
    edges.push(...this.deriveAutoEdges(projectId))

    // 数据源 3：novel_relationships 表（角色语义关系）
    for (const r of this.store.listRelationships(projectId)) {
      edges.push(this.relationshipToGraphEdge(r))
    }

    return edges
  }

  /** 派生自动边（对应画布 buildLayout 的 7 个派生分支） */
  private deriveAutoEdges(projectId: string): GraphEdge[] {
    const edges: GraphEdge[] = []

    // ① 冲突 → 参与角色（involvement）
    for (const cf of this.store.listConflicts(projectId)) {
      const participants = this.parseIdList(cf.participants)
      for (const pid of participants) {
        edges.push({
          id: `derived:involvement:${cf.id}:${pid}`,
          sourceId: cf.id,
          sourceType: 'conflict',
          targetId: pid,
          targetType: 'character',
          edgeType: 'involvement',
          label: '',
          auto: true,
          createdAt: 0,
          updatedAt: 0,
        })
      }
    }

    // ② 势力 → 首领角色（member）
    // ③ 势力 → 盟友（alliance）
    // ④ 势力 → 敌对（rivalry）
    for (const f of this.store.listFactions(projectId)) {
      if (f.leaderId) {
        edges.push({
          id: `derived:member:${f.id}:${f.leaderId}`,
          sourceId: f.id,
          sourceType: 'faction',
          targetId: f.leaderId,
          targetType: 'character',
          edgeType: 'member',
          label: '',
          auto: true,
          createdAt: 0,
          updatedAt: 0,
        })
      }
      for (const aid of f.allies) {
        edges.push({
          id: `derived:alliance:${f.id}:${aid}`,
          sourceId: f.id,
          sourceType: 'faction',
          targetId: aid,
          targetType: 'faction',
          edgeType: 'alliance',
          label: '',
          auto: true,
          createdAt: 0,
          updatedAt: 0,
        })
      }
      for (const eid of f.enemies) {
        edges.push({
          id: `derived:rivalry:${f.id}:${eid}`,
          sourceId: f.id,
          sourceType: 'faction',
          targetId: eid,
          targetType: 'faction',
          edgeType: 'rivalry',
          label: '',
          auto: true,
          createdAt: 0,
          updatedAt: 0,
        })
      }
    }

    // ⑤ 地点 → 父地点（hierarchy）
    // ⑥ 地点 → 归属势力（association）
    for (const l of this.store.listLocations(projectId)) {
      if (l.parentId) {
        edges.push({
          id: `derived:hierarchy:location:${l.id}:${l.parentId}`,
          sourceId: l.id,
          sourceType: 'location',
          targetId: l.parentId,
          targetType: 'location',
          edgeType: 'hierarchy',
          label: '',
          auto: true,
          createdAt: 0,
          updatedAt: 0,
        })
      }
      if (l.factionId) {
        edges.push({
          id: `derived:association:${l.id}:${l.factionId}`,
          sourceId: l.id,
          sourceType: 'location',
          targetId: l.factionId,
          targetType: 'faction',
          edgeType: 'association',
          label: '',
          auto: true,
          createdAt: 0,
          updatedAt: 0,
        })
      }
    }

    // ⑦ 世界要素 → 父要素（hierarchy）
    for (const w of this.store.listWorldElements(projectId)) {
      if (w.parentId) {
        edges.push({
          id: `derived:hierarchy:world_element:${w.id}:${w.parentId}`,
          sourceId: w.id,
          sourceType: 'world_element',
          targetId: w.parentId,
          targetType: 'world_element',
          edgeType: 'hierarchy',
          label: '',
          auto: true,
          createdAt: 0,
          updatedAt: 0,
        })
      }
    }

    return edges
  }

  /** NovelEdge → GraphEdge */
  private toGraphEdge(e: NovelEdge): GraphEdge {
    return {
      id: e.id,
      sourceId: e.sourceId,
      sourceType: e.sourceType,
      targetId: e.targetId,
      targetType: e.targetType,
      edgeType: e.edgeType,
      label: e.label,
      auto: e.auto,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }
  }

  /** NovelRelationship → GraphEdge（角色语义关系，edgeType 统一为 relationship） */
  private relationshipToGraphEdge(r: NovelRelationship): GraphEdge {
    return {
      id: `relationship:${r.id}`,
      sourceId: r.characterA,
      sourceType: 'character',
      targetId: r.characterB,
      targetType: 'character',
      edgeType: 'relationship',
      label: r.relationType,
      auto: true,
      fromRelationship: true,
      relationship: r,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  }

  /** 任意实体 ID 反查项目 ID（遍历策略表） */
  private findProjectIdByEntityAny(entityId: string): string | null {
    for (const strategy of this.strategies.values()) {
      const projectId = strategy.getProjectId(entityId)
      if (projectId) return projectId
    }
    return null
  }

  /** 按类型查项目 ID */
  private findProjectIdByEntity(entityId: string, entityType: NovelNodeType): string | null {
    return this.strategies.get(entityType)?.getProjectId(entityId) ?? null
  }

  /** 获取实体名称 */
  private getEntityName(entityId: string, entityType: NovelNodeType): string | null {
    return this.strategies.get(entityType)?.getName(entityId) ?? null
  }

  /** 获取实体摘要（用于路径结果） */
  private getEntitySummary(entityId: string): GraphNode | null {
    // GraphNode.type 仅支持 NovelNodeType（不含 'clue'），所以遍历固定 6 类
    const summaryTypes: NovelNodeType[] = [
      'character', 'conflict', 'foreshadow', 'faction', 'location', 'world_element',
    ]
    for (const type of summaryTypes) {
      const strategy = this.strategies.get(type)
      if (!strategy) continue
      const name = strategy.getName(entityId)
      if (name) return { id: entityId, type, name }
    }
    return null
  }

  /** 收集实体出现的所有章节号 */
  private collectEntityChapters(projectId: string, entityId: string, entityType: NovelNodeType): number[] {
    // 'clue' 不在 NovelNodeType 中，但策略表包含 ClueStrategy
    // 调用方传入 NovelNodeType 合法值；若未来扩展传 'clue'，策略表也能响应
    return this.strategies.get(entityType as GraphEntityType)?.getChapters(projectId, entityId) ?? []
  }

  /** 解析路径节点序列 */
  private resolvePathNodes(fromId: string, toId: string, edges: GraphEdge[]): GraphNode[] {
    const nodes: GraphNode[] = []
    const startNode = this.getEntitySummary(fromId)
    if (startNode) nodes.push(startNode)
    for (const edge of edges) {
      const nextId = edge.sourceId === (nodes[nodes.length - 1]?.id ?? fromId) ? edge.targetId : edge.sourceId
      const node = this.getEntitySummary(nextId)
      if (node) nodes.push(node)
    }
    return nodes
  }

  /** JSON 字符串解析为 ID 数组 */
  private parseIdList(s: string): string[] {
    if (!s) return []
    try {
      const parsed = JSON.parse(s)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
}
