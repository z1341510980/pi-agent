/**
 * 小说 Agent 角色温度配置 API 客户端
 *
 * 端点（自动加 /api/plugins/novel 前缀）：
 * - GET  /agent-config  → 获取 5 角色温度列表
 * - PUT  /agent-config  → 批量更新角色温度
 *
 * 类型镜像后端 apps/agent-server/src/plugins/novel-plugin/core/novel-agent-config-store.ts
 */

import { getApi, putApi } from './http-client'

// ── 基础路径 ──

const BASE = '/api/plugins/novel'

// ── 类型 ──

export type NovelAgentType = 'director' | 'writer' | 'reviser' | 'reviewer' | 'memory'

/** per-Agent 模型覆盖（P2-2 审稿异源：null = 回退项目主模型） */
export interface NovelAgentModelSelection {
  provider: string
  modelId: string
}

export interface NovelAgentConfigEntry {
  agentType: NovelAgentType
  temperature: number
  model: NovelAgentModelSelection | null
}

export interface NovelAgentTemperature {
  agentType: NovelAgentType
  temperature: number
}

export interface UpdateAgentConfigInput {
  items: Array<{
    agentType: NovelAgentType
    temperature: number
    /** 可选：仅传该字段时更新模型；null 清除覆盖 */
    model?: NovelAgentModelSelection | null
  }>
}

// ── API 方法 ──

/** 获取全部角色配置（温度 + 模型覆盖，合并默认值与持久化覆盖） */
export function getNovelAgentConfig(): Promise<NovelAgentConfigEntry[]> {
  return getApi<NovelAgentConfigEntry[]>(`${BASE}/agent-config`)
}

/** 批量更新角色配置（温度必填；model 仅在传入时更新），返回合并后的全部条目 */
export function updateNovelAgentConfig(
  items: UpdateAgentConfigInput['items'],
): Promise<NovelAgentConfigEntry[]> {
  return putApi<NovelAgentConfigEntry[]>(`${BASE}/agent-config`, { items })
}
