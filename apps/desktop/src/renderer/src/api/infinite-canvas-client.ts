import { deleteApi, getApi, patchApi, postApi, putApi } from './http-client'

export type CanvasNodeType = 'image' | 'text' | 'config' | 'video' | 'audio' | 'group'
export type CanvasBackgroundMode = 'dots' | 'lines' | 'blank'

/** 画布节点元数据（与参考项目 basketikun/infinite-canvas 对齐的字段子集）。 */
export interface CanvasNodeMetadata {
  content?: string
  composerContent?: string
  prompt?: string
  status?: 'idle' | 'success' | 'loading' | 'error'
  errorDetails?: string
  fontSize?: number
  generationMode?: 'text' | 'image' | 'video' | 'audio'
  model?: string
  size?: string
  naturalWidth?: number
  naturalHeight?: number
  bytes?: number
  mimeType?: string
  durationMs?: number
  groupId?: string
  freeResize?: boolean
  [key: string]: unknown
}

/** 客户端节点模型：position/width/height 直接驱动渲染。 */
export interface CanvasNodeData {
  id: string
  type: CanvasNodeType | (string & {})
  title: string
  position: { x: number; y: number }
  width: number
  height: number
  metadata?: CanvasNodeMetadata
}

export interface CanvasGraphConnection {
  id: string
  fromNodeId: string
  toNodeId: string
}

export interface ViewportTransform {
  x: number
  y: number
  k: number
}

export interface CanvasProjectSettings {
  backgroundMode: CanvasBackgroundMode
  showImageInfo: boolean
}

/** 服务端返回的项目行（nodes 为服务端行格式）。 */
export interface CanvasNodeRow {
  id: string
  projectId: string
  type: string
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
export interface CanvasProject {
  id: string
  title: string
  description: string
  viewport: { x: number; y: number; zoom: number }
  settings: CanvasProjectSettings
  createdAt: number
  updatedAt: number
  nodes: CanvasNodeRow[]
  connections: Array<{
    id: string
    projectId: string
    fromNodeId: string
    toNodeId: string
    createdAt: number
  }>
}

const BASE = '/api/plugins/infinite-canvas'

export async function listCanvasProjects(): Promise<
  Array<Omit<CanvasProject, 'nodes' | 'connections'>>
> {
  return getApi<Array<Omit<CanvasProject, 'nodes' | 'connections'>>>(`${BASE}/projects`)
}
export async function getCanvasProject(id: string): Promise<CanvasProject> {
  return getApi<CanvasProject>(`${BASE}/projects/${encodeURIComponent(id)}`)
}
export async function createCanvasProject(payload: {
  title?: string
  description?: string
}): Promise<CanvasProject> {
  return postApi<CanvasProject>(`${BASE}/projects`, payload)
}
export async function renameCanvasProject(id: string, title: string): Promise<CanvasProject> {
  return patchApi<CanvasProject>(`${BASE}/projects/${encodeURIComponent(id)}`, { title })
}
export async function updateCanvasProject(
  id: string,
  payload: Partial<Pick<CanvasProject, 'title' | 'description' | 'viewport'>>
): Promise<CanvasProject> {
  return patchApi<CanvasProject>(`${BASE}/projects/${encodeURIComponent(id)}`, payload)
}
export async function deleteCanvasProject(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`${BASE}/projects/${encodeURIComponent(id)}`)
}

/** 整图同步载荷：客户端会话状态的完整快照。 */
export interface CanvasGraphPayload {
  nodes: Array<{
    id: string
    type: string
    title: string
    content?: string
    x: number
    y: number
    width: number
    height: number
    metadata?: Record<string, unknown>
  }>
  connections: CanvasGraphConnection[]
  viewport: { x: number; y: number; zoom: number }
  settings: CanvasProjectSettings
}

/** 本地优先编辑后的持久化入口：一次 PUT 替换项目的全部节点、连线、视口与设置。 */
export async function saveCanvasGraph(
  id: string,
  payload: CanvasGraphPayload
): Promise<CanvasProject> {
  return putApi<CanvasProject>(`${BASE}/projects/${encodeURIComponent(id)}/graph`, payload)
}

export async function generateCanvasText(
  projectId: string,
  payload: { nodeId?: string; prompt: string; mode?: string; context?: string },
  options?: { signal?: AbortSignal }
): Promise<{ text: string }> {
  return postApi<{ text: string }>(
    `${BASE}/projects/${encodeURIComponent(projectId)}/generate`,
    payload,
    options
  )
}

export async function generateCanvasImage(
  projectId: string,
  payload: {
    nodeId?: string
    prompt: string
    context?: string
    model?: string
    size?: string
    count?: number
  },
  options?: { signal?: AbortSignal }
): Promise<{ images: string[] }> {
  return postApi<{ images: string[] }>(
    `${BASE}/projects/${encodeURIComponent(projectId)}/generate-image`,
    payload,
    options
  )
}

export async function generateCanvasMedia(
  projectId: string,
  payload: {
    mode: 'audio' | 'video'
    prompt: string
    model?: string
    voice?: string
    format?: string
    speed?: number
    size?: string
    seconds?: number
  },
  options?: { signal?: AbortSignal }
): Promise<{ outputs: Array<{ url: string; mimeType: string }> }> {
  return postApi<{ outputs: Array<{ url: string; mimeType: string }> }>(
    `${BASE}/projects/${encodeURIComponent(projectId)}/generate-media`,
    payload,
    options
  )
}

/** 蒙版局部重绘：原图 + 涂抹蒙版交给 /images/edits。 */
export async function editCanvasImage(
  projectId: string,
  payload: { prompt: string; image: string; mask?: string; model?: string; size?: string },
  options?: { signal?: AbortSignal }
): Promise<{ images: string[] }> {
  return postApi<{ images: string[] }>(
    `${BASE}/projects/${encodeURIComponent(projectId)}/edit-image`,
    payload,
    options
  )
}

/** 反推提示词：视觉模型描述图片，输出可复用的生成提示词。 */
export async function reverseCanvasPrompt(
  projectId: string,
  payload: { image: string; instruction?: string },
  options?: { signal?: AbortSignal }
): Promise<{ text: string }> {
  return postApi<{ text: string }>(
    `${BASE}/projects/${encodeURIComponent(projectId)}/reverse-prompt`,
    payload,
    options
  )
}
