/**
 * d3-force 力导向布局
 *
 * 在画布"图谱模式"下使用，让相关节点自然聚类：
 * - 边吸引力：有连接的节点互相靠近
 * - 节点斥力：所有节点互相排斥，避免重叠
 * - 中心引力：防止节点飞出视野
 * - 碰撞检测：节点边界框互斥
 *
 * 已保存位置的节点（用户手动拖动过的）锁定不动，只对未保存位置的节点做模拟。
 * 这样切换布局模式不会破坏用户精心调整的位置。
 *
 * 不持久化力导向布局结果：切回分组模式时，仍能看到原 savedPositions；
 * 力导向模式下的位置仅在当前会话有效，用户拖动也不保存（避免污染 savedPositions）。
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type Simulation,
} from 'd3-force'
import type { Node, Edge } from '@xyflow/react'

/** d3-force 节点（xyflow Node 扩展位置字段） */
interface ForceNode extends SimulationNodeDatum {
  id: string
  /** 节点宽度（用于碰撞检测，xyflow 节点宽度估算） */
  radius: number
}

/** 力导向布局参数 */
export interface ForceLayoutOptions {
  /** 画布中心 X（默认 0） */
  centerX?: number
  /** 画布中心 Y（默认 0） */
  centerY?: number
  /**
   * 节点斥力强度（负值，绝对值越大斥力越强）
   * 默认 -2500：节点宽 200px，需要强斥力才能让节点充分散开（graphify 风格留白大）
   */
  chargeStrength?: number
  /**
   * 边的理想长度（默认 280）
   * 大于节点宽度 200px，让有连接的节点也保持距离，连线不挤
   */
  linkDistance?: number
  /** 中心引力强度（默认 0.02，弱引力让节点充分散开） */
  centerStrength?: number
  /** 模拟迭代次数（默认 800，复杂图需要更多迭代收敛） */
  iterations?: number
  /**
   * 节点半径估算（默认 130）
   * xyflow 节点 200x120，碰撞检测半径设略大于对角线一半，确保节点间有留白
   */
  nodeRadius?: number
  /** 初始位置分布半径（默认 400），节点在圆周上均匀分布作为模拟起点 */
  initialRadius?: number
}

/**
 * 对未保存位置的节点应用 d3-force 力导向布局
 *
 * @param nodes xyflow 节点列表（位置会被原地更新）
 * @param edges xyflow 边列表（用于计算吸引力）
 * @param savedPositionKeys 已保存位置的节点 ID 集合（这些节点固定不动）
 * @param options 力导向参数
 * @returns 新的节点列表（位置已更新）
 *
 * @example
 * ```ts
 * const newNodes = applyForceLayout(layout.nodes, layout.edges, savedKeys)
 * setNodes(newNodes)
 * ```
 */
export function applyForceLayout(
  nodes: Node[],
  edges: Edge[],
  savedPositionKeys: Set<string>,
  options: ForceLayoutOptions = {},
): Node[] {
  const {
    centerX = 0,
    centerY = 0,
    chargeStrength = -2500,
    linkDistance = 280,
    centerStrength = 0.02,
    iterations = 800,
    nodeRadius = 130,
    initialRadius = 400,
  } = options

  // 边界情况：无节点或全部已保存位置，直接返回
  if (nodes.length === 0) return nodes
  const unfixCount = nodes.filter((n) => !savedPositionKeys.has(n.id)).length
  if (unfixCount === 0) return nodes

  // ── 1. 构建 d3-force 节点 ──
  // 已保存位置的节点设为 fixed（fx/fy），不参与位置更新
  // 未保存位置的节点初始位置用圆形均匀分布（避免所有节点初始都在原点附近导致收敛慢、
  // 聚成一团）。圆形分布给力模拟一个良好的起点，让斥力能均匀推开节点。
  const angleStep = (2 * Math.PI) / unfixCount
  let unfixIndex = 0
  const forceNodes: ForceNode[] = nodes.map((n) => {
    const isFixed = savedPositionKeys.has(n.id)
    if (isFixed) {
      return {
        id: n.id,
        radius: nodeRadius,
        x: n.position.x,
        y: n.position.y,
        fx: n.position.x,
        fy: n.position.y,
      }
    }
    // 圆形均匀分布初始位置
    const angle = unfixIndex * angleStep
    unfixIndex++
    return {
      id: n.id,
      radius: nodeRadius,
      x: centerX + initialRadius * Math.cos(angle),
      y: centerY + initialRadius * Math.sin(angle),
    }
  })

  // id → ForceNode 索引（forceLink 需要按 source/target 解析）
  const nodeById = new Map(forceNodes.map((n) => [n.id, n]))

  // ── 2. 构建 d3-force 边（过滤掉指向不存在节点的边）──
  const forceLinks = edges
    .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }))

  // ── 3. 配置力模拟 ──
  // 不调用 onTick，只跑固定迭代次数后取最终位置（同步算法）
  // alphaDecay 设较高值让模拟更快收敛
  const simulation: Simulation<ForceNode, typeof forceLinks[number]> = forceSimulation<ForceNode>(
    forceNodes,
  )
    .force(
      'link',
      forceLink<ForceNode, typeof forceLinks[number]>(forceLinks)
        .id((d) => d.id)
        .distance(linkDistance)
        .strength(0.6),
    )
    .force('charge', forceManyBody().strength(chargeStrength))
    .force('center', forceCenter(centerX, centerY).strength(centerStrength))
    .force(
      'collide',
      forceCollide<ForceNode>().radius((d) => d.radius + 10),
    )
    .alphaDecay(0.05)
    .alphaMin(0.005)

  // ── 4. 跑迭代（同步阻塞，节点数 <200 时通常 <50ms）──
  // d3-force 的 stop() + tick() 模式让模拟同步完成
  simulation.stop()
  for (let i = 0; i < iterations; i++) {
    simulation.tick()
    // NaN 防护：极少数情况下力计算会产生 NaN（如孤立节点无连接）
    // 检测到 NaN 时回退到原位置，避免节点消失
    for (const fn of forceNodes) {
      if (Number.isNaN(fn.x) || Number.isNaN(fn.y)) {
        const orig = nodeById.get(fn.id)
        if (orig) {
          fn.x = orig.x ?? 0
          fn.y = orig.y ?? 0
        }
      }
    }
  }

  // ── 5. 把模拟结果写回 xyflow 节点 ──
  // 已 fixed 的节点位置不变（fx/fy 已锁定），未 fixed 的取模拟后 x/y
  const positionMap = new Map<string, { x: number; y: number }>()
  for (const fn of forceNodes) {
    positionMap.set(fn.id, { x: fn.x ?? 0, y: fn.y ?? 0 })
  }

  return nodes.map((n) => {
    const pos = positionMap.get(n.id)
    if (!pos) return n
    return { ...n, position: { x: pos.x, y: pos.y } }
  })
}
