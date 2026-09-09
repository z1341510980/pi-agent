import { browserConfig } from '@repo/config/browser'
import type { ApiResponse } from '@repo/shared/api'
import { ApiClientError, apiErrorDetails, deleteApi, getApi, patchApi, postApi, putApi } from './http-client'

export type CanvasNodeType = 'image' | 'text' | 'config' | 'video' | 'audio' | 'group'
export type CanvasBackgroundMode = 'dots' | 'lines' | 'blank'

export type CanvasGenerationResourceKind = 'text' | 'image' | 'video' | 'audio'

export interface CanvasGenerationReference {
  nodeId: string
  title: string
  kind: CanvasGenerationResourceKind
  label?: string
  text?: string
  dataUrl?: string
  url?: string
  storageKey?: string
  mimeType?: string
  bytes?: number
  width?: number
  height?: number
  durationMs?: number
}

export interface CanvasGenerationContext {
  text: CanvasGenerationReference[]
  images: CanvasGenerationReference[]
  videos: CanvasGenerationReference[]
  audios: CanvasGenerationReference[]
}

export interface CanvasGeneratedImage {
  id: string
  content: string
  status: 'idle' | 'success' | 'loading' | 'error'
  errorDetails?: string
  storageKey?: string
  naturalWidth?: number
  naturalHeight?: number
  bytes?: number
  mimeType?: string
}

/** 兼容旧版 images: string[] 与新版对象化批量图片元数据。 */
export function canvasGeneratedImageContent(value: CanvasGeneratedImage | string): string {
  return typeof value === 'string' ? value : value.content
}

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
  providerId?: string
  size?: string
  quality?: string
  background?: string
  count?: number
  seconds?: number
  voice?: string
  format?: string
  speed?: number
  generateAudio?: boolean
  watermark?: boolean
  naturalWidth?: number
  naturalHeight?: number
  bytes?: number
  mimeType?: string
  durationMs?: number
  storageKey?: string
  images?: Array<CanvasGeneratedImage | string>
  primaryImageId?: string
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

/**
 * 统一图片地址处理：
 * - 服务端本地资产（/assets/:id，相对路径）→ 补全为后端绝对地址（file:// 打包环境下相对路径解析不到）
 * - 外部 http(s) 图片 → 走服务端代理回传（部分域名直连不可达、部分图床拒绝浏览器直连）
 * - data:/blob:/其他相对路径直接放行
 */
export function proxyExternalImageUrl(url: string): string {
  if (url.startsWith(`${BASE}/assets/`)) {
    return `${browserConfig.apiBaseUrl}${url}`
  }
  if (url.startsWith(`${browserConfig.apiBaseUrl}${BASE}/assets/`)) {
    return url
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (url.startsWith(`${browserConfig.apiBaseUrl}${BASE}/proxy-image`)) return url
    return `${browserConfig.apiBaseUrl}${BASE}/proxy-image?url=${encodeURIComponent(url)}`
  }
  return url
}

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
  payload: {
    nodeId?: string
    prompt: string
    mode?: string
    context?: string
    resourceContext?: CanvasGenerationContext
  },
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
    resourceContext?: CanvasGenerationContext
    references?: string[]
    model?: string
    providerId?: string
    size?: string
    quality?: string
    background?: string
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
    context?: string
    resourceContext?: CanvasGenerationContext
    model?: string
    providerId?: string
    voice?: string
    format?: string
    speed?: number
    size?: string
    seconds?: number
    generateAudio?: boolean
    watermark?: boolean
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
  payload: { prompt: string; image: string; images?: string[]; mask?: string; model?: string; size?: string },
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

// ── 提示词来源（服务端代理 + SQLite 缓存） ──

export interface PromptSourceInfo {
  id: string
  name: string
  url: string
  homepage: string
  enabled: boolean
  lastFetchedAt: number | null
  lastError: string | null
  itemCount: number
}

export interface NormalizedPromptItem {
  id: string
  sourceId: string
  sourceName: string
  title: string
  prompt: string
  description: string
  tags: string[]
  coverUrl: string
}

export async function listPromptSources(): Promise<PromptSourceInfo[]> {
  return getApi<PromptSourceInfo[]>(`${BASE}/prompt-sources`)
}

export async function listPromptItems(sourceId?: string): Promise<NormalizedPromptItem[]> {
  const qs = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : ''
  return getApi<NormalizedPromptItem[]>(`${BASE}/prompt-items${qs}`)
}

export interface PromptTagInfo {
  tag: string
  count: number
}

export async function listPromptTags(): Promise<PromptTagInfo[]> {
  return getApi<PromptTagInfo[]>(`${BASE}/prompt-tags`)
}

export async function refreshPromptSources(): Promise<{ successCount: number; failureCount: number }> {
  return postApi<{ successCount: number; failureCount: number }>(
    `${BASE}/prompt-sources/refresh`,
    {}
  )
}

export async function togglePromptSource(
  sourceId: string,
  enabled: boolean
): Promise<{ id: string; enabled: boolean }> {
  return patchApi<{ id: string; enabled: boolean }>(
    `${BASE}/prompt-sources/${encodeURIComponent(sourceId)}/toggle`,
    { enabled }
  )
}

// ── 画布独立生图配置 ──

export interface CanvasMediaConfigStatus {
  configured: boolean
  baseUrl: string
  model: string
  imageSize: string
  imageProtocol: 'openai-images' | 'apimart'
  imageResolution: string
  imageLanguage: string
  keyHint: string
}

export async function getMediaConfig(): Promise<CanvasMediaConfigStatus> {
  return getApi<CanvasMediaConfigStatus>(`${BASE}/media-config`)
}

export async function updateMediaConfig(payload: {
  imageBaseUrl?: string
  imageApiKey?: string
  imageModel?: string
  imageSize?: string
  imageProtocol?: 'openai-images' | 'apimart'
  imageResolution?: string
  imageLanguage?: string
}): Promise<CanvasMediaConfigStatus> {
  return putApi<CanvasMediaConfigStatus>(`${BASE}/media-config`, payload)
}

// ── 媒体生成日志 ──

export interface MediaLogReference {
  preview: string
  bytes: number
}

export interface MediaLogEntry {
  id: string
  kind: 'generate' | 'edit'
  projectId: string | null
  endpoint: string
  model: string | null
  size: string | null
  prompt: string
  references: MediaLogReference[]
  maskPath: string | null
  responseImages: string[]
  error: string | null
  status: 'ok' | 'error'
  durationMs: number
  traceId: string | null
  createdAt: number
}

/** 最近的媒体生成日志（请求/响应留痕，图片可直接预览）。 */
export async function listMediaLogs(limit = 50): Promise<MediaLogEntry[]> {
  return getApi<MediaLogEntry[]>(`${BASE}/media-logs?limit=${limit}`)
}

/** 上传 data URL 图片为服务端资产，返回可在节点里引用的本地路径。 */
export async function uploadCanvasAsset(
  dataUrl: string,
  projectId?: string
): Promise<string | null> {
  const response = await fetch(`${browserConfig.apiBaseUrl}${BASE}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, ...(projectId ? { projectId } : {}) })
  })
  const body = (await response.json().catch(() => null)) as {
    ok: boolean
    data?: { path: string }
  } | null
  if (!response.ok || !body?.ok || !body.data?.path) return null
  return body.data.path
}

/**
 * 画布整图保存（调用方已序列化好的 JSON 字符串）：
 * 大画布序列化一次要几十毫秒，调用方复用同一份字符串做体积检查与保存，
 * 避免重复 stringify。
 */
export async function saveCanvasGraphBody(
  id: string,
  bodyJson: string
): Promise<CanvasProject> {
  const response = await fetch(
    `${browserConfig.apiBaseUrl}${BASE}/projects/${encodeURIComponent(id)}/graph`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: bodyJson
    }
  )
  const parsed = (await response.json().catch(() => null)) as ApiResponse<CanvasProject> | null
  if (!parsed) {
    throw new ApiClientError(`API 请求失败: HTTP ${response.status}`, 'API_ERROR')
  }
  if (!parsed.ok) {
    const error = apiErrorDetails(parsed, response.status)
    throw new ApiClientError(error.message, error.code, error.traceId, error.details)
  }
  return parsed.data
}
