/**
 * 小说 Agent 角色温度配置存储（AgentManager 薄封装）
 *
 * B5 改造：原直接读写 novel_agent_config 表，现改为 AgentManager 的薄封装，
 * 消除温度配置双轨制（novel_agent_config 表与 agents 表 temperature 字段语义重叠）。
 *
 * - getAll / getByType：从 agentManager.getAgent(id).temperature 读取，
 *   agentManager 不可用或 agent 未注册时回退到 NOVEL_AGENT_CONFIGS 默认值。
 * - upsert / upsertMany：调用 agentManager.updateAgent(id, { temperature })。
 *
 * 向后兼容：novel_agent_config 表保留不删，但不再读写。
 * db 参数保留用于未来扩展（如旧数据迁移），当前不读写该表。
 */

import type Database from 'better-sqlite3'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from './novel-agents.js'
import type { AgentManager } from '../../../core/agent/subagent-tool.js'

/** 小说角色温度配置（合并后，含全部 4 角色） */
export type NovelAgentTemperatures = Record<NovelAgentType, number>

export class NovelAgentConfigStore {
  constructor(
    private db: Database.Database,
    private agentManager?: AgentManager,
  ) {
    // db 保留用于未来扩展（如旧数据迁移），当前不再读写 novel_agent_config 表
  }

  /** 获取全部角色温度（AgentManager 覆盖 > NOVEL_AGENT_CONFIGS 默认值） */
  getAll(): NovelAgentTemperatures {
    return {
      director: this.getByType('director'),
      writer: this.getByType('writer'),
      reviewer: this.getByType('reviewer'),
      memory: this.getByType('memory'),
    }
  }

  /** 获取单个角色温度（AgentManager 覆盖 > NOVEL_AGENT_CONFIGS 默认值） */
  getByType(agentType: NovelAgentType): number {
    const config = NOVEL_AGENT_CONFIGS[agentType]
    if (this.agentManager) {
      const agent = this.agentManager.getAgent(config.id)
      if (agent?.temperature !== undefined) {
        return agent.temperature
      }
    }
    return config.temperature
  }

  /** 覆盖单个角色温度（写入 AgentManager） */
  upsert(agentType: NovelAgentType, temperature: number): void {
    const config = NOVEL_AGENT_CONFIGS[agentType]
    if (!this.agentManager) return
    // agent 未注册时跳过（updateAgent 在 agent 不存在时会抛错）
    // 首次注册前调用 upsert 不应报错，回退为 no-op
    if (!this.agentManager.getAgent(config.id)) return
    // updateAgent 为 async，但内存更新（agents.set）在首个 await 前同步完成，
    // 后续 getAgent 立即可见新温度。持久化部分 fire-and-forget，保持 upsert 同步签名。
    void this.agentManager.updateAgent(config.id, { temperature })
  }

  /** 批量覆盖 */
  upsertMany(items: Array<{ agentType: NovelAgentType; temperature: number }>): void {
    for (const item of items) {
      this.upsert(item.agentType, item.temperature)
    }
  }
}
