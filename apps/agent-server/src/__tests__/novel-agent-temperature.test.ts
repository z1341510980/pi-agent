import { describe, expect, it, vi } from 'vitest'
import {
  NOVEL_AGENT_CONFIGS,
  getNovelAgentTemperature,
  getAllNovelAgentTemperatures,
  updateNovelAgentTemperature,
  updateNovelAgentTemperatures,
  type NovelAgentType,
} from '../plugins/novel-plugin/core/novel-agents.js'

/** 构造可控的 mock AgentManager（结构类型兼容 AgentManagerLike） */
function makeMockAgentManager(agents: Record<string, { temperature?: number } | undefined>) {
  return {
    getAgent: vi.fn((id: string) => agents[id]),
    updateAgent: vi.fn((id: string, patch: { temperature?: number }) => {
      // 模拟真实 AgentManager：在内存 Map 中同步更新
      agents[id] = { ...agents[id], ...patch }
      return Promise.resolve(agents[id])
    }),
  }
}

describe('getNovelAgentTemperature', () => {
  it('agentManager 为 undefined 时回退到 NOVEL_AGENT_CONFIGS 默认值', () => {
    for (const [agentType, config] of Object.entries(NOVEL_AGENT_CONFIGS)) {
      expect(getNovelAgentTemperature(agentType as NovelAgentType, undefined)).toBe(config.temperature)
    }
  })

  it('agent 未注册时（getAgent 返回 undefined）回退到默认值', () => {
    const agentManager = makeMockAgentManager({})  // 空表
    for (const [agentType, config] of Object.entries(NOVEL_AGENT_CONFIGS)) {
      expect(getNovelAgentTemperature(agentType as NovelAgentType, agentManager)).toBe(config.temperature)
    }
  })

  it('agent.temperature 为 undefined 时回退到默认值', () => {
    const agentManager = makeMockAgentManager({
      'novel-writer': { temperature: undefined },
    })
    expect(getNovelAgentTemperature('writer', agentManager)).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
  })

  it('agent.temperature 有值时优先返回 AgentManager 中的覆盖值', () => {
    const agentManager = makeMockAgentManager({
      'novel-writer': { temperature: 0.42 },
    })
    expect(getNovelAgentTemperature('writer', agentManager)).toBe(0.42)
  })

  it('覆盖值可以为 0（边界值，不被 || 视为 falsy）', () => {
    const agentManager = makeMockAgentManager({
      'novel-director': { temperature: 0 },
    })
    expect(getNovelAgentTemperature('director', agentManager)).toBe(0)
  })

  it('覆盖值可以为 2（上限边界）', () => {
    const agentManager = makeMockAgentManager({
      'novel-memory': { temperature: 2 },
    })
    expect(getNovelAgentTemperature('memory', agentManager)).toBe(2)
  })
})

describe('getAllNovelAgentTemperatures', () => {
  it('agentManager 为 undefined 时返回全部 5 角色默认温度', () => {
    const result = getAllNovelAgentTemperatures(undefined)
    expect(Object.keys(result)).toHaveLength(5)
    expect(result.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
    expect(result.writer).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
    expect(result.reviser).toBe(NOVEL_AGENT_CONFIGS.reviser.temperature)
    expect(result.reviewer).toBe(NOVEL_AGENT_CONFIGS.reviewer.temperature)
    expect(result.memory).toBe(NOVEL_AGENT_CONFIGS.memory.temperature)
  })

  it('部分角色有覆盖时混合返回覆盖值与默认值', () => {
    const agentManager = makeMockAgentManager({
      'novel-writer': { temperature: 0.95 },
      'novel-reviewer': { temperature: 0.5 },
    })
    const result = getAllNovelAgentTemperatures(agentManager)
    expect(result.writer).toBe(0.95)
    expect(result.reviewer).toBe(0.5)
    // 未覆盖的角色保持默认
    expect(result.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
    expect(result.reviser).toBe(NOVEL_AGENT_CONFIGS.reviser.temperature)
    expect(result.memory).toBe(NOVEL_AGENT_CONFIGS.memory.temperature)
  })
})

describe('updateNovelAgentTemperature', () => {
  it('agentManager 为 undefined 时为 no-op（不抛错）', () => {
    expect(() => updateNovelAgentTemperature('writer', 0.5, undefined)).not.toThrow()
  })

  it('agent 未注册时为 no-op（不调用 updateAgent）', () => {
    const agentManager = makeMockAgentManager({})
    updateNovelAgentTemperature('writer', 0.7, agentManager)
    expect(agentManager.updateAgent).not.toHaveBeenCalled()
  })

  it('agent 已注册时调用 updateAgent 写入新温度', () => {
    const agentManager = makeMockAgentManager({
      'novel-writer': { temperature: 0.9 },
    })
    updateNovelAgentTemperature('writer', 0.6, agentManager)
    expect(agentManager.updateAgent).toHaveBeenCalledTimes(1)
    expect(agentManager.updateAgent).toHaveBeenCalledWith('novel-writer', { temperature: 0.6 })
  })

  it('updateAgent 内部同步写入后 getAgent 立即可见新温度（fire-and-forget 一致性）', () => {
    const agentManager = makeMockAgentManager({
      'novel-writer': { temperature: 0.9 },
    })
    updateNovelAgentTemperature('writer', 0.55, agentManager)
    // 立即查询应看到新温度（不依赖 Promise resolve）
    expect(getNovelAgentTemperature('writer', agentManager)).toBe(0.55)
  })

  it('返回值为 void（fire-and-forget）', () => {
    const agentManager = makeMockAgentManager({
      'novel-writer': { temperature: 0.9 },
    })
    const result = updateNovelAgentTemperature('writer', 0.8, agentManager)
    expect(result).toBeUndefined()
  })
})

describe('updateNovelAgentTemperatures', () => {
  it('空数组为 no-op', () => {
    const agentManager = makeMockAgentManager({
      'novel-writer': { temperature: 0.9 },
    })
    updateNovelAgentTemperatures([], agentManager)
    expect(agentManager.updateAgent).not.toHaveBeenCalled()
  })

  it('批量更新多个角色温度', () => {
    const agentManager = makeMockAgentManager({
      'novel-director': { temperature: 0.5 },
      'novel-writer': { temperature: 0.9 },
      'novel-reviser': { temperature: 0.7 },
      'novel-reviewer': { temperature: 0.3 },
      'novel-memory': { temperature: 0.2 },
    })
    updateNovelAgentTemperatures(
      [
        { agentType: 'director', temperature: 0.6 },
        { agentType: 'writer', temperature: 1.0 },
        { agentType: 'memory', temperature: 0.3 },
      ],
      agentManager,
    )
    expect(agentManager.updateAgent).toHaveBeenCalledTimes(3)
    expect(agentManager.updateAgent).toHaveBeenNthCalledWith(1, 'novel-director', { temperature: 0.6 })
    expect(agentManager.updateAgent).toHaveBeenNthCalledWith(2, 'novel-writer', { temperature: 1.0 })
    expect(agentManager.updateAgent).toHaveBeenNthCalledWith(3, 'novel-memory', { temperature: 0.3 })
  })

  it('批量更新中混合未注册角色时跳过未注册项（不抛错）', () => {
    const agentManager = makeMockAgentManager({
      'novel-writer': { temperature: 0.9 },
      // director/reviewer 未注册
    })
    updateNovelAgentTemperatures(
      [
        { agentType: 'director', temperature: 0.5 },   // 未注册，跳过
        { agentType: 'writer', temperature: 0.85 },    // 已注册，更新
        { agentType: 'reviewer', temperature: 0.4 },   // 未注册，跳过
      ],
      agentManager,
    )
    expect(agentManager.updateAgent).toHaveBeenCalledTimes(1)
    expect(agentManager.updateAgent).toHaveBeenCalledWith('novel-writer', { temperature: 0.85 })
  })

  it('agentManager 为 undefined 时整个调用为 no-op', () => {
    expect(() => {
      updateNovelAgentTemperatures(
        [
          { agentType: 'director', temperature: 0.5 },
          { agentType: 'writer', temperature: 0.9 },
        ],
        undefined,
      )
    }).not.toThrow()
  })

  it('批量更新后 getAll 立即反映所有变更', () => {
    const agentManager = makeMockAgentManager({
      'novel-director': { temperature: 0.5 },
      'novel-writer': { temperature: 0.9 },
      'novel-reviser': { temperature: 0.7 },
      'novel-reviewer': { temperature: 0.3 },
      'novel-memory': { temperature: 0.2 },
    })
    updateNovelAgentTemperatures(
      [
        { agentType: 'director', temperature: 0.7 },
        { agentType: 'writer', temperature: 1.1 },
      ],
      agentManager,
    )
    const result = getAllNovelAgentTemperatures(agentManager)
    expect(result.director).toBe(0.7)
    expect(result.writer).toBe(1.1)
    // 其他角色保持原值
    expect(result.reviser).toBe(0.7)
    expect(result.reviewer).toBe(0.3)
    expect(result.memory).toBe(0.2)
  })
})
