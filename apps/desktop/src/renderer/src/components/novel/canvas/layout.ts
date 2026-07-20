import { type Edge, type Node } from '@xyflow/react'
import type { NovelEdgeType } from '@/api/novel-client'
import type { CreationPhase } from '@/hooks/use-novel-creation-flow'
import {
  CHAR_X,
  CONFLICT_X_OFFSET,
  FACTION_X,
  FACTION_Y_START,
  FORESHADOW_X_START,
  FORESHADOW_Y,
  LOCATION_X_START,
  LOCATION_Y,
  NODE_SPACING_X,
  NODE_SPACING_Y,
  WORLD_ELEMENT_X_START,
  WORLD_ELEMENT_Y,
} from './constants'
import { nodeId, parseParticipants } from './node-utils'

// ── 边打包：统计同一 target 的边数，用于降低视觉密度 ──

export function computeTargetBundleCount(edges: Edge[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const e of edges) {
    if (e.target) {
      counts.set(e.target, (counts.get(e.target) ?? 0) + 1)
    }
  }
  return counts
}

// ── 连接规则校验 ──

/**
 * 判断源节点到目标节点的连接是否合法（纯实体关系图）。
 * 允许：
 *   - character ↔ character  （角色关系）
 *   - conflict  → character   （冲突涉及角色，方向性）
 *   - faction   ↔ character   （势力与角色：首领/成员）
 *   - location  ↔ location    （地点层级：父/子）
 *   - faction   ↔ location    （势力归属地点）
 *   - faction   ↔ faction     （势力间盟友/敌对关系）
 *   - foreshadow ↔ any / any ↔ foreshadow （伏笔可关联任意实体）
 *   - group     ↔ any / any ↔ group       （视觉分组可关联任意实体）
 *   - world_element → any / any → world_element （世界观要素可关联任意实体）
 * 禁止：
 *   - character → conflict    （应使用 conflict → character）
 */
export function isValidConnection(sourceType: string, targetType: string): boolean {
  // 明确禁止：character → conflict（方向性冲突，应反向连接）
  if (sourceType === 'character' && targetType === 'conflict') return false

  // world_element 与任意实体可互连（世界观要素是元数据层）
  if (sourceType === 'world_element' || targetType === 'world_element') return true

  // foreshadow 与任意实体可互连（伏笔可关联角色/冲突等）
  if (sourceType === 'foreshadow' || targetType === 'foreshadow') return true

  // group 与任意实体可互连（视觉分组）
  if (sourceType === 'group' || targetType === 'group') return true

  // character ↔ character
  if (sourceType === 'character' && targetType === 'character') return true

  // conflict → character（方向性，反向已被上方规则禁止）
  if (sourceType === 'conflict' && targetType === 'character') return true

  // faction ↔ character（势力首领/成员）
  if (
    (sourceType === 'faction' && targetType === 'character') ||
    (sourceType === 'character' && targetType === 'faction')
  ) return true

  // location ↔ location（地点层级：父/子）
  if (sourceType === 'location' && targetType === 'location') return true

  // faction ↔ location（势力归属地点）
  if (
    (sourceType === 'faction' && targetType === 'location') ||
    (sourceType === 'location' && targetType === 'faction')
  ) return true

  // faction ↔ faction（势力间盟友/敌对关系）
  if (sourceType === 'faction' && targetType === 'faction') return true

  return false
}

// ── 布局函数：根据 store 数据生成节点与边 ──

export interface LayoutResult {
  nodes: Node[]
  edges: Edge[]
}

export function buildLayout(params: {
  characters: Array<{ id: string; name: string; identity: string; arcStage: string; currentState: string }>
  conflicts: Array<{ id: string; description: string; type: string; intensity: number; stage: string; participants: string }>
  foreshadows: Array<{ id: string; description: string; category: string; status: string; firstChapter: number | null; lastChapter: number | null; recoverByChapter: number | null }>
  factions: Array<{ id: string; name: string; description: string; type: string; strength: string; status: string; leaderId: string | null; allies: string[]; enemies: string[] }>
  locations: Array<{ id: string; name: string; description: string; type: string; parentId: string | null; factionId: string | null; significance: string; firstChapter: number | null; status: string }>
  worldElements: Array<{ id: string; name: string; description: string; category: string; parentId: string | null; attributes: Record<string, unknown> }>
  savedPositions: Map<string, { x: number; y: number }>
  /** 已持久化的手动边（auto=false），与自动边合并并按 source-target 去重 */
  manualEdges: import('@/api/novel-client').NovelEdge[]
}): LayoutResult {
  const { characters, conflicts, foreshadows, factions, locations, worldElements, savedPositions, manualEdges } = params
  const nodes: Node[] = []
  const edges: Edge[] = []

  /** 优先使用已保存位置，否则使用计算位置 */
  const resolvePos = (type: string, id: string, computed: { x: number; y: number }) => {
    const saved = savedPositions.get(`${type}:${id}`)
    return saved ?? computed
  }

  // 角色节点（左侧竖向排列）
  const charYStart = -((characters.length - 1) * NODE_SPACING_Y) / 2
  characters.forEach((c, i) => {
    nodes.push({
      id: nodeId('character', c.id),
      type: 'character',
      position: resolvePos('character', c.id, { x: CHAR_X, y: charYStart + i * NODE_SPACING_Y }),
      data: { entity: c },
    })
  })

  // 冲突节点（连接到参与角色，保留原有 conflict → character 边）
  conflicts.forEach((cf, i) => {
    const participants = parseParticipants(cf.participants)
    const firstParticipant = participants[0]
    const charIdx = firstParticipant ? characters.findIndex((c) => c.id === firstParticipant) : -1
    const baseY = charIdx >= 0 ? -((characters.length - 1) * NODE_SPACING_Y) / 2 + charIdx * NODE_SPACING_Y : i * NODE_SPACING_Y
    nodes.push({
      id: nodeId('conflict', cf.id),
      type: 'conflict',
      position: resolvePos('conflict', cf.id, { x: CHAR_X + CONFLICT_X_OFFSET, y: baseY + 60 }),
      data: { entity: cf },
    })
    // 连接冲突 → 参与角色
    participants.forEach((pid) => {
      if (characters.some((c) => c.id === pid)) {
        edges.push({
          id: `e-conf-${cf.id}-char-${pid}`,
          source: nodeId('conflict', cf.id),
          target: nodeId('character', pid),
          style: { stroke: 'var(--color-danger)', strokeWidth: 1.5, strokeDasharray: '4 3' },
          data: { auto: true, edgeType: 'involvement' as NovelEdgeType },
        })
      }
    })
  })

  // 伏笔节点（横向排列，纯实体关系图不再关联章节）
  foreshadows.forEach((f, i) => {
    nodes.push({
      id: nodeId('foreshadow', f.id),
      type: 'foreshadow',
      position: resolvePos('foreshadow', f.id, { x: FORESHADOW_X_START + i * NODE_SPACING_X, y: FORESHADOW_Y }),
      data: { entity: f },
    })
  })

  // 势力节点（右侧竖向排列，连接首领角色与盟友/敌对势力）
  factions.forEach((f, i) => {
    nodes.push({
      id: nodeId('faction', f.id),
      type: 'faction',
      position: resolvePos('faction', f.id, { x: FACTION_X, y: FACTION_Y_START + i * NODE_SPACING_Y }),
      data: { entity: f },
    })
    // 势力 → 首领角色
    if (f.leaderId && characters.some((c) => c.id === f.leaderId)) {
      edges.push({
        id: `e-fac-${f.id}-leader-${f.leaderId}`,
        source: nodeId('faction', f.id),
        target: nodeId('character', f.leaderId),
        style: { stroke: '#a855f7', strokeWidth: 1.5 },
        data: { auto: true, edgeType: 'member' as NovelEdgeType },
      })
    }
    // 势力 → 盟友势力
    f.allies.forEach((aid) => {
      if (factions.some((x) => x.id === aid)) {
        edges.push({
          id: `e-fac-${f.id}-ally-${aid}`,
          source: nodeId('faction', f.id),
          target: nodeId('faction', aid),
          style: { stroke: '#15a877', strokeWidth: 1, strokeDasharray: '2 3' },
          data: { auto: true, edgeType: 'alliance' as NovelEdgeType },
        })
      }
    })
    // 势力 → 敌对势力
    f.enemies.forEach((eid) => {
      if (factions.some((x) => x.id === eid)) {
        edges.push({
          id: `e-fac-${f.id}-enemy-${eid}`,
          source: nodeId('faction', f.id),
          target: nodeId('faction', eid),
          style: { stroke: '#f43f5e', strokeWidth: 1, strokeDasharray: '4 2' },
          data: { auto: true, edgeType: 'rivalry' as NovelEdgeType },
        })
      }
    })
  })

  // 地点节点（左下方横向排列，构建父子层级与势力归属）
  locations.forEach((l, i) => {
    nodes.push({
      id: nodeId('location', l.id),
      type: 'location',
      position: resolvePos('location', l.id, { x: LOCATION_X_START + i * NODE_SPACING_X, y: LOCATION_Y }),
      data: { entity: l },
    })
    // 地点 → 父级地点
    if (l.parentId && locations.some((x) => x.id === l.parentId)) {
      edges.push({
        id: `e-loc-${l.id}-parent-${l.parentId}`,
        source: nodeId('location', l.id),
        target: nodeId('location', l.parentId),
        style: { stroke: '#06b6d4', strokeWidth: 1, strokeDasharray: '2 3' },
        data: { auto: true, edgeType: 'hierarchy' as NovelEdgeType },
      })
    }
    // 地点 → 归属势力
    if (l.factionId && factions.some((x) => x.id === l.factionId)) {
      edges.push({
        id: `e-loc-${l.id}-fac-${l.factionId}`,
        source: nodeId('location', l.id),
        target: nodeId('faction', l.factionId),
        style: { stroke: '#0891b2', strokeWidth: 1, strokeDasharray: '3 2' },
        data: { auto: true, edgeType: 'association' as NovelEdgeType },
      })
    }
  })

  // 世界观要素节点（最下方横向排列，构建父子层级）
  worldElements.forEach((we, i) => {
    nodes.push({
      id: nodeId('world_element', we.id),
      type: 'world_element',
      position: resolvePos('world_element', we.id, { x: WORLD_ELEMENT_X_START + i * NODE_SPACING_X, y: WORLD_ELEMENT_Y }),
      data: { entity: we },
    })
    // 世界观要素 → 父级要素
    if (we.parentId && worldElements.some((x) => x.id === we.parentId)) {
      edges.push({
        id: `e-we-${we.id}-parent-${we.parentId}`,
        source: nodeId('world_element', we.id),
        target: nodeId('world_element', we.parentId),
        style: { stroke: '#3f31c6', strokeWidth: 1, strokeDasharray: '2 3' },
        data: { auto: true, edgeType: 'hierarchy' as NovelEdgeType },
      })
    }
  })

  // ── 合并手动边（从 store 读取的已持久化边，auto=false）──
  // 与自动边按 source-target 去重，手动边优先保留（用户意图优先于算法推断）
  const manualFlowEdges: Edge[] = manualEdges
    .filter((e) => !e.auto)
    .map((e) => ({
      id: `edge-${e.id}`,
      source: `${e.sourceType}:${e.sourceId}`,
      target: `${e.targetType}:${e.targetId}`,
      type: 'smoothstep',
      animated: false,
      // cursor:pointer + 略粗线宽提示可交互（hover/选中样式由全局 CSS 控制）
      style: { stroke: 'var(--color-primary)', strokeWidth: 1.5, cursor: 'pointer' },
      data: { auto: false, edgeId: e.id, edgeType: e.edgeType },
    }))

  if (manualFlowEdges.length > 0) {
    const seen = new Set<string>()
    for (const e of edges) {
      const key = `${e.source}-${e.target}`
      seen.add(key)
    }
    for (const me of manualFlowEdges) {
      const key = `${me.source}-${me.target}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(me)
    }
  }

  // ── 边打包：同一 target 有多条边时降低透明度与线宽 ──
  const bundleCounts = computeTargetBundleCount(edges)
  for (const e of edges) {
    const count = e.target ? bundleCounts.get(e.target) ?? 0 : 0
    if (count > 3) {
      // 打包：使用 smoothstep 类型 + 降低视觉权重
      e.type = 'smoothstep'
      e.animated = false
      e.style = {
        ...(e.style ?? {}),
        strokeWidth: 1,
        opacity: 0.5,
      }
    }
  }

  return { nodes, edges }
}

// ── 创作流程节点高亮 ──

/** 根据创作阶段返回应高亮（脉冲）的节点 ID 集合 */
export function computePulsingNodeIds(
  phase: CreationPhase,
  characters: Array<{ id: string }>,
  conflicts: Array<{ id: string }>,
  foreshadows: Array<{ id: string }>,
): Set<string> {
  const ids = new Set<string>()
  if (phase === 'idle' || phase === 'completed' || phase === 'cancelled' || phase === 'error') {
    return ids
  }

  // memory：高亮角色/冲突/伏笔节点（状态更新目标）
  // 注：画布已收敛为纯实体关系图，project/chapter 节点不再渲染，
  // 故 directing/writing 等阶段不再产生脉冲节点
  if (phase === 'memory') {
    characters.forEach((c) => ids.add(nodeId('character', c.id)))
    conflicts.forEach((c) => ids.add(nodeId('conflict', c.id)))
    foreshadows.forEach((f) => ids.add(nodeId('foreshadow', f.id)))
  }

  return ids
}
