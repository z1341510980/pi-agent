import { deleteApi, getApi, patchApi, postApi } from './http-client'

/**
 * 媒体生成 Provider 客户端（spec §3/§5）
 *
 * 对应 agent-server 路由 `/api/media-providers`：
 * - GET    /api/media-providers?modality=   — 列出 Provider（Key 脱敏 keyHint）+ adapters 元数据
 * - POST   /api/media-providers             — 创建（每模态首条自动设为默认）
 * - PATCH  /api/media-providers/:id         — 部分更新（空 apiKey 保留旧值）
 * - DELETE /api/media-providers/:id         — 删除
 * - POST   /api/media-providers/:id/default — 设为模态默认（同模态唯一）
 *
 * text 模态不落 media_providers 表（复用 LLM Provider 体系），本客户端不提供 text 写入。
 */

export type MediaModality = 'text' | 'image' | 'audio' | 'video'

/** media_providers 表实际存储的模态（text 由 provider-config-store 承载） */
export type StoredMediaModality = Exclude<MediaModality, 'text'>

/** adapter 声明式表单字段：驱动设置页动态渲染（size/resolution/language 等） */
export interface MediaAdapterFormField {
  key: string
  label: string
  type: 'text' | 'select' | 'number'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  required?: boolean
}

/** adapter 元数据（GET 响应内嵌，供设置页动态表单与能力展示） */
export interface MediaAdapterMeta {
  id: string
  label: string
  modality: StoredMediaModality
  capabilities: {
    generate: boolean
    edit?: boolean
    mask?: boolean
    analyze?: boolean
  }
  formSchema: MediaAdapterFormField[]
}

/** GET 响应行：不含 apiKey，附 keyHint（首 4…尾 4）供列表展示 */
export interface MediaProviderRow {
  id: string
  name: string
  modality: StoredMediaModality
  adapter: string
  baseUrl: string
  model: string
  params: Record<string, string>
  enabled: boolean
  isDefault: boolean
  keyHint: string
  createdAt: number
  updatedAt: number
}

export interface MediaAdaptersResponse {
  adapters: MediaAdapterMeta[]
}

export interface CreateMediaProviderInput {
  name: string
  modality: StoredMediaModality
  adapter: string
  baseUrl?: string
  apiKey?: string
  model?: string
  params?: Record<string, string>
}

export type UpdateMediaProviderPatch = Partial<{
  name: string
  modality: StoredMediaModality
  adapter: string
  baseUrl: string
  apiKey: string
  model: string
  params: Record<string, string>
  enabled: boolean
}>

/** GET /api/media-providers 的 data 载荷：rows 与 adapters 同响应返回 */
interface MediaProvidersPayload {
  rows: MediaProviderRow[]
  adapters: MediaAdapterMeta[]
}

/** 列出媒体 Provider；指定模态时服务端按模态过滤（text 恒返回空行） */
export async function listMediaProviders(modality?: MediaModality): Promise<MediaProviderRow[]> {
  const qs = modality ? `?modality=${encodeURIComponent(modality)}` : ''
  const data = await getApi<MediaProvidersPayload>(`/api/media-providers${qs}`)
  return data.rows ?? []
}

/** 列出全部已注册 adapter 元数据（未指定模态 → 返回所有存储模态的 adapter） */
export async function listMediaAdapters(): Promise<MediaAdaptersResponse> {
  const data = await getApi<MediaProvidersPayload>('/api/media-providers')
  return { adapters: data.adapters ?? [] }
}

/** 创建 Provider；每模态首条由服务端自动设为默认 */
export function createMediaProvider(input: CreateMediaProviderInput): Promise<MediaProviderRow> {
  return postApi<MediaProviderRow>('/api/media-providers', input)
}

/** 部分更新；apiKey 传空串时由服务端保留旧值（客户端通常直接省略该字段） */
export function updateMediaProvider(
  id: string,
  patch: UpdateMediaProviderPatch
): Promise<MediaProviderRow> {
  return patchApi<MediaProviderRow>(`/api/media-providers/${encodeURIComponent(id)}`, patch)
}

/** 删除 Provider；默认行删除后模态默认空缺（resolve 时报「未配置」引导） */
export async function deleteMediaProvider(id: string): Promise<void> {
  await deleteApi<{ deleted: boolean }>(`/api/media-providers/${encodeURIComponent(id)}`)
}

/** 设为模态默认（同模态唯一，服务端事务处理） */
export async function setMediaProviderDefault(id: string): Promise<void> {
  await postApi<{ id: string; modality: string }>(
    `/api/media-providers/${encodeURIComponent(id)}/default`,
    {}
  )
}
