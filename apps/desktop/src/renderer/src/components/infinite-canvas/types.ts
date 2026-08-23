import type { CanvasNodeData, ViewportTransform } from '@/api/infinite-canvas-client'

export type Position = { x: number; y: number }

export type CanvasNodeTypeId = CanvasNodeData['type']

export type ConnectionHandleType = 'source' | 'target'

export interface ConnectionHandle {
  nodeId: string
  handleType: ConnectionHandleType
}

export interface SelectionBox {
  startWorldX: number
  startWorldY: number
  currentWorldX: number
  currentWorldY: number
  additive: boolean
  initialSelectedNodeIds: string[]
}

export type ContextMenuState =
  | { type: 'node'; x: number; y: number; nodeId: string }
  | { type: 'connection'; x: number; y: number; connectionId: string }

export interface PendingConnectionCreate {
  connection: ConnectionHandle
  position: Position
}

export type CanvasTool = 'select' | 'pan'

export type { CanvasNodeData, ViewportTransform }
