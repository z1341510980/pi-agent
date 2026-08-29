/**
 * 提示词模板管理 API 客户端
 *
 * 端点（自动加 /api/plugins/novel 前缀）：
 * - GET    /prompts            → 模板列表（分类/用途/效果/字符数/调用统计/来源）
 * - GET    /prompts/:name      → 生效内容 + 默认内容 + 来源 + 部件元数据
 * - PUT    /prompts/:name      → 保存运行时覆盖
 * - DELETE /prompts/:name      → 恢复默认（删除覆盖）
 */

import { getApi, putApi, deleteApi } from './http-client'

const BASE = '/api/plugins/novel'

export type PromptTemplateSource = 'runtime' | 'project-file' | 'default'

/** 与写作风格强相关、推荐用户自定义的模板 */
export const STYLE_RELATED_TEMPLATES = new Set([
  'chapter-instruction',
  'role-writer',
  'role-reviser',
  'role-prose-editor',
  'system-base-rules',
])

export interface PromptTemplateInfo {
  name: string
  source: PromptTemplateSource
  /** 分类（通用底座/主流程工种/群聊共创/规划与编排/分析与状态） */
  category?: string
  /** 面板展示名 */
  title?: string
  /** 用在哪里：装配位置描述 */
  usedBy?: string[]
  /** 效果说明 */
  effect?: string
  /** 当前生效内容字符数 */
  charCount?: number
  /** 关联 Agent 的最近调用次数（近 500 条日志窗口） */
  usage?: Record<string, number>
}

export interface PromptTemplateDetail {
  name: string
  /** 生效内容；不存在为 null */
  content: string | null
  source: PromptTemplateSource
  hasRuntimeOverride: boolean
  /** 内置默认内容（纯自定义模板无此项） */
  defaultContent?: string | null
  charCount?: number
}

export function listPromptTemplates(projectId?: string): Promise<PromptTemplateInfo[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  // 兼容旧后端返回 string[] 的格式（服务未重载时优雅降级为纯名称列表）
  return getApi<unknown[]>(`${BASE}/prompts${query}`).then((raw) =>
    (Array.isArray(raw) ? raw : [])
      .map((item): PromptTemplateInfo | null => {
        if (typeof item === 'string') return { name: item, source: 'default' }
        if (item != null && typeof item === 'object' && typeof (item as PromptTemplateInfo).name === 'string') {
          const info = item as PromptTemplateInfo
          return {
            name: info.name,
            source: info.source ?? 'default',
            category: info.category,
            title: info.title,
            usedBy: Array.isArray(info.usedBy) ? info.usedBy : undefined,
            effect: info.effect,
            charCount: typeof info.charCount === 'number' ? info.charCount : undefined,
            usage: info.usage && typeof info.usage === 'object' ? info.usage : undefined,
          }
        }
        return null
      })
      .filter((item): item is PromptTemplateInfo => item !== null),
  )
}

export function getPromptTemplate(name: string, projectId?: string): Promise<PromptTemplateDetail> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return getApi<PromptTemplateDetail>(`${BASE}/prompts/${encodeURIComponent(name)}${query}`)
}

export function savePromptTemplate(
  name: string,
  input: { content: string; projectId: string | null; description?: string },
): Promise<{ name: string; saved: boolean }> {
  return putApi<{ name: string; saved: boolean }>(
    `${BASE}/prompts/${encodeURIComponent(name)}`,
    input,
  )
}

/** 恢复默认：删除运行时覆盖（projectId 精确范围；不传则删全局） */
export function resetPromptTemplate(
  name: string,
  projectId?: string,
): Promise<{ name: string; reset: boolean }> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return deleteApi<{ name: string; reset: boolean }>(
    `${BASE}/prompts/${encodeURIComponent(name)}${query}`,
  )
}
