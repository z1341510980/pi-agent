export type CanvasNodeType =
  | 'image'
  | 'text'
  | 'config'
  | 'video'
  | 'audio'
  | 'group'
  | 'design-board'
/** 旧版节点类型：不再由 UI 创建，但保留读取兼容。 */
export type LegacyCanvasNodeType = 'prompt' | 'file' | 'agent'
export type ExtensionCanvasNodeType = `${string}:${string}`
export type AnyCanvasNodeType = CanvasNodeType | LegacyCanvasNodeType | ExtensionCanvasNodeType

export interface CanvasNode {
  id: string
  projectId: string
  type: AnyCanvasNodeType
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface CanvasConnection {
  id: string
  projectId: string
  fromNodeId: string
  toNodeId: string
  createdAt: number
}

export type CanvasBackgroundMode = 'dots' | 'lines' | 'blank'

export interface CanvasProjectSettings {
  backgroundMode: CanvasBackgroundMode
  showImageInfo: boolean
}

export interface CanvasProject {
  id: string
  title: string
  description: string
  viewport: { x: number; y: number; zoom: number }
  settings: CanvasProjectSettings
  createdAt: number
  updatedAt: number
  nodes: CanvasNode[]
  connections: CanvasConnection[]
}

export interface CreateNodeInput {
  type: AnyCanvasNodeType
  title?: string
  content?: string
  x?: number
  y?: number
  width?: number
  height?: number
  metadata?: Record<string, unknown>
}

/** replaceGraph 的节点载荷：id 由客户端生成，类型兼容旧值。 */
export interface UpsertNodeInput extends CreateNodeInput {
  id: string
}
