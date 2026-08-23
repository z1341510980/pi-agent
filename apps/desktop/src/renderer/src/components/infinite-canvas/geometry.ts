import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import type { CanvasNodeTypeId, ConnectionHandle, Position } from './types'
import { getCanvasExtensionDefinition } from './node-registry'

export const CANVAS_NODE_TYPES = ['image', 'text', 'config', 'video', 'audio', 'group'] as const

/** 与参考项目一致的节点默认尺寸与初始元数据。 */
export const NODE_DEFAULT_SIZE: Record<string, { width: number; height: number; title: string }> = {
  image: { width: 340, height: 240, title: '图片' },
  text: { width: 340, height: 240, title: '文本' },
  config: { width: 340, height: 240, title: '生成配置' },
  video: { width: 420, height: 236, title: '视频' },
  audio: { width: 340, height: 120, title: '音频' },
  group: { width: 760, height: 480, title: '分组' }
}

const NODE_SPECS: Record<
  string,
  { width: number; height: number; title: string; metadata?: Record<string, unknown> }
> = {
  image: { ...NODE_DEFAULT_SIZE.image, metadata: { content: '', status: 'idle' } },
  text: { ...NODE_DEFAULT_SIZE.text, metadata: { content: '', status: 'idle', fontSize: 14 } },
  config: {
    ...NODE_DEFAULT_SIZE.config,
    metadata: { content: '', status: 'idle', generationMode: 'image' }
  },
  video: { ...NODE_DEFAULT_SIZE.video, metadata: { content: '', status: 'idle' } },
  audio: { ...NODE_DEFAULT_SIZE.audio, metadata: { content: '', status: 'idle' } },
  group: { ...NODE_DEFAULT_SIZE.group, metadata: { status: 'idle' } }
}

export function getNodeSpec(type: string): {
  width: number
  height: number
  title: string
  metadata?: Record<string, unknown>
} {
  const builtin = NODE_SPECS[type]
  if (builtin) return builtin
  const extension = getCanvasExtensionDefinition(type)
  return extension
    ? {
        width: extension.defaultSize.width,
        height: extension.defaultSize.height,
        title: extension.title,
        metadata: extension.defaultMetadata
      }
    : NODE_DEFAULT_SIZE.text
}

let nodeSequence = 0

/** 创建节点：position 以点击点为中心。 */
export function createNodeData(
  type: CanvasNodeTypeId,
  position: Position,
  metadata?: Record<string, unknown>
): CanvasNodeData {
  const spec = getNodeSpec(type)
  nodeSequence += 1
  return {
    id: `${type}-${Date.now()}-${nodeSequence}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    title: spec.title,
    position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
    width: spec.width,
    height: spec.height,
    metadata: { ...(spec.metadata ?? {}), ...(metadata ?? {}) }
  }
}

// ── 尺寸工具 ──

export function fitNodeSize(
  width: number,
  height: number,
  maxWidth = 640,
  maxHeight = 640
): { width: number; height: number } {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const scale = Math.min(1, maxWidth / w, maxHeight / h)
  return { width: w * scale, height: h * scale }
}

export function readImageMeta(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = url
  })
}

// ── 几何：包围盒 / 分组 ──

export function nodeBounds(nodes: CanvasNodeData[]): {
  left: number
  top: number
  right: number
  bottom: number
} {
  return nodes.reduce(
    (acc, node) => ({
      left: Math.min(acc.left, node.position.x),
      top: Math.min(acc.top, node.position.y),
      right: Math.max(acc.right, node.position.x + node.width),
      bottom: Math.max(acc.bottom, node.position.y + node.height)
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  )
}

/** 拖拽释放时的分组落点：任一移动节点中心落入的、倒序最近的 group。 */
export function findGroupDropTarget(
  movedIds: Set<string>,
  nodes: CanvasNodeData[]
): CanvasNodeData | null {
  if (nodes.some((node) => movedIds.has(node.id) && node.type === 'group')) return null
  const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== 'group')
  if (!movingNodes.length) return null
  return (
    [...nodes].reverse().find((group) => {
      if (group.type !== 'group' || movedIds.has(group.id)) return false
      return movingNodes.some((node) => {
        const centerX = node.position.x + node.width / 2
        const centerY = node.position.y + node.height / 2
        return (
          centerX >= group.position.x &&
          centerX <= group.position.x + group.width &&
          centerY >= group.position.y &&
          centerY <= group.position.y + group.height
        )
      })
    }) || null
  )
}

const GROUP_SNAP_PAD = 24

/** 把移动节点吸附进 group 边界内（pad=24），并写入 groupId。 */
export function snapNodesIntoGroup(
  movedIds: Set<string>,
  nodes: CanvasNodeData[],
  group: CanvasNodeData
): CanvasNodeData[] {
  const movingNodes = nodes.filter((node) => movedIds.has(node.id) && node.type !== 'group')
  if (!movingNodes.length) return nodes
  const bounds = nodeBounds(movingNodes)
  const left = group.position.x + GROUP_SNAP_PAD
  const top = group.position.y + GROUP_SNAP_PAD
  const right = group.position.x + group.width - GROUP_SNAP_PAD
  const bottom = group.position.y + group.height - GROUP_SNAP_PAD
  const dx =
    bounds.right - bounds.left > right - left
      ? left - bounds.left
      : bounds.left < left
        ? left - bounds.left
        : bounds.right > right
          ? right - bounds.right
          : 0
  const dy =
    bounds.bottom - bounds.top > bottom - top
      ? top - bounds.top
      : bounds.top < top
        ? top - bounds.top
        : bounds.bottom > bottom
          ? bottom - bounds.bottom
          : 0
  return nodes.map((node) => {
    if (!movedIds.has(node.id) || node.type === 'group') return node
    return {
      ...node,
      position: { x: node.position.x + dx, y: node.position.y + dy },
      metadata: { ...node.metadata, groupId: group.id }
    }
  })
}

/** 单节点中心所在的最上层 group（无则为 undefined）。 */
export function findContainingGroupId(
  node: CanvasNodeData,
  nodes: CanvasNodeData[]
): string | undefined {
  const centerX = node.position.x + node.width / 2
  const centerY = node.position.y + node.height / 2
  return (
    [...nodes]
      .reverse()
      .find(
        (group) =>
          group.type === 'group' &&
          group.id !== node.id &&
          centerX >= group.position.x &&
          centerX <= group.position.x + group.width &&
          centerY >= group.position.y &&
          centerY <= group.position.y + group.height
      )?.id || undefined
  )
}

// ── 连线 ──

export function getConnectionTargetAnchor(
  node: CanvasNodeData,
  current: ConnectionHandle
): Position {
  return {
    x: current.handleType === 'source' ? node.position.x : node.position.x + node.width,
    y: node.position.y + node.height / 2
  }
}

/**
 * 归一化连线方向：config 节点只进不出；两个 config 之间不能连。
 * 返回 { fromNodeId, toNodeId } 或 null（不可连）。
 */
export function normalizeConnection(
  firstNodeId: string,
  secondNodeId: string,
  nodes: CanvasNodeData[],
  firstHandleType: 'source' | 'target'
): { fromNodeId: string; toNodeId: string } | null {
  const first = nodes.find((node) => node.id === firstNodeId)
  const second = nodes.find((node) => node.id === secondNodeId)
  if (!first || !second || first.id === second.id) return null
  if (first.type === 'group' || second.type === 'group') return null
  if (first.type === 'config' && second.type === 'config') return null
  if (second.type === 'config') return { fromNodeId: first.id, toNodeId: second.id }
  if (first.type === 'config' && firstHandleType === 'target')
    return { fromNodeId: second.id, toNodeId: first.id }
  if (first.type === 'config') return { fromNodeId: first.id, toNodeId: second.id }
  return { fromNodeId: first.id, toNodeId: second.id }
}
