import { memo } from 'react'
import { MiniMap, type Node, type NodeTypes } from '@xyflow/react'
import { CharacterNode } from '../nodes/CharacterNode'
import { ConflictNode } from '../nodes/ConflictNode'
import { ForeshadowNode } from '../nodes/ForeshadowNode'
import { GroupNode } from '../nodes/GroupNode'
import { FactionNode } from '../nodes/FactionNode'
import { LocationNode } from '../nodes/LocationNode'
import { WorldElementNode } from '../nodes/WorldElementNode'

// ── 节点类型注册（必须在组件外定义，避免每次渲染重建） ──

export const nodeTypes: NodeTypes = {
  character: CharacterNode,
  conflict: ConflictNode,
  foreshadow: ForeshadowNode,
  group: GroupNode,
  faction: FactionNode,
  location: LocationNode,
  world_element: WorldElementNode,
}

// ── MiniMap 性能优化 ──
// 说明：@xyflow/react v12 的 <MiniMap> 不再接受 onlyRenderVisibleElements 属性
// （该属性在 v11 中曾存在，v12 将其合并到 <ReactFlow> 顶层，控制 NodeRenderer /
//  EdgeRenderer 的视口裁剪）。因此这里采用两种互补优化：
//   1. 在 <ReactFlow> 上启用 onlyRenderVisibleElements（节点/边虚拟化）
//   2. 将 <MiniMap> 包装为 memo 组件，仅在节点数 > COMPACT_THRESHOLD 时挂载
//      小项目下 MiniMap 价值有限，省去 SVG 全量渲染开销；大项目时才出现
//      导航缩略图。nodeColor 提到模块作用域以稳定 props 引用，避免不必要重渲染。

export function miniMapNodeColor(n: Node): string {
  const type = n.type
  if (type === 'character') return '#3b82f6'
  if (type === 'conflict') return '#f43f5e'
  if (type === 'foreshadow') return '#f59e0b'
  if (type === 'group') return '#4b3fe3'
  if (type === 'faction') return '#a855f7'
  if (type === 'location') return '#06b6d4'
  if (type === 'world_element') return '#3f31c6'
  return '#6b7280'
}

export const MemoizedMiniMap = memo(function MemoizedMiniMap({ visible, 'data-tour': dataTour }: { visible: boolean; 'data-tour'?: string }) {
  if (!visible) return null
  return (
    <MiniMap
      pannable
      zoomable
      className="!bg-card !border !border-border"
      maskColor="rgba(0,0,0,0.05)"
      nodeColor={miniMapNodeColor}
      data-tour={dataTour}
    />
  )
})
