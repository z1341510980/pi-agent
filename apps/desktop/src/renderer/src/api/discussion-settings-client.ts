/**
 * 群聊模式设置 API 客户端
 *
 * 端点（自动加 /api/plugins/novel 前缀）：
 * - GET  /discussion-settings  → 获取群聊设置
 * - PUT  /discussion-settings  → 更新群聊设置
 *
 * 类型镜像后端群聊设置接口
 */

import { getApi, putApi } from './http-client'

// ── 基础路径 ──

const BASE = '/api/plugins/novel'

// ── 类型 ──

export interface ModeratorModel {
  provider: string
  modelId: string
}

export interface DiscussionSettings {
  moderatorModel?: ModeratorModel
  maxRounds?: number
  maxRoundsPerScene?: number
  characterTemperature?: number
}

// ── API 方法 ──

/** 获取群聊设置（合并默认值与持久化覆盖） */
export function getDiscussionSettings(): Promise<DiscussionSettings> {
  return getApi<DiscussionSettings>(`${BASE}/discussion-settings`)
}

/** 更新群聊设置，返回合并后的完整设置 */
export function updateDiscussionSettings(
  settings: Partial<DiscussionSettings>,
): Promise<DiscussionSettings> {
  return putApi<DiscussionSettings>(`${BASE}/discussion-settings`, settings)
}
