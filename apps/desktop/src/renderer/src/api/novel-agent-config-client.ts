/**
 * 小说 Agent 角色温度配置 API 客户端
 *
 * 端点（自动加 /api/plugins/novel 前缀）：
 * - GET  /agent-config  → 获取 4 角色温度列表
 * - PUT  /agent-config  → 批量更新角色温度
 *
 * 类型镜像后端 apps/agent-server/src/plugins/novel-plugin/core/novel-agent-config-store.ts
 */

import { getApi, putApi } from './http-client'

// ── 基础路径 ──

const BASE = '/api/plugins/novel'

// ── 类型 ──

export type NovelAgentType = 'director' | 'writer' | 'reviewer' | 'memory'

export interface NovelAgentTemperature {
  agentType: NovelAgentType
  temperature: number
}

export interface UpdateAgentConfigInput {
  items: Array<{ agentType: NovelAgentType; temperature: number }>
}

// ── API 方法 ──

/** 获取全部角色温度（合并默认值与持久化覆盖） */
export function getNovelAgentConfig(): Promise<NovelAgentTemperature[]> {
  return getApi<NovelAgentTemperature[]>(`${BASE}/agent-config`)
}

/** 批量覆盖角色温度，返回合并后的全部温度列表 */
export function updateNovelAgentConfig(
  items: Array<{ agentType: NovelAgentType; temperature: number }>,
): Promise<NovelAgentTemperature[]> {
  return putApi<NovelAgentTemperature[]>(`${BASE}/agent-config`, { items })
}
