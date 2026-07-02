import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { NovelAgentConfigStore } from '../plugins/novel-plugin/core/novel-agent-config-store.js'
import { NOVEL_AGENT_CONFIGS, type NovelAgentType } from '../plugins/novel-plugin/core/novel-agents.js'
import type { AgentManager, AgentConfig } from '../core/agent/subagent-tool.js'

/**
 * 创建 mock AgentManager，仅实现 NovelAgentConfigStore 依赖的方法：
 * - getAgent(id)：从内存 Map 返回 AgentConfig 或 undefined
 * - updateAgent(id, patch)：合并 patch 写回内存 Map
 * - registerAgent(config)：写入内存 Map（测试前置注册用）
 *
 * 真实 AgentManager 的 updateAgent 内存更新（agents.set）在首个 await 前同步完成，
 * mock 保持同样语义以确保 upsert 后 getAgent 立即可见新温度。
 */
function createMockAgentManager(preRegisterAgents = true): AgentManager {
  const agents = new Map<string, AgentConfig>()
  if (preRegisterAgents) {
    for (const config of Object.values(NOVEL_AGENT_CONFIGS)) {
      agents.set(config.id, {
        id: config.id,
        name: config.name,
        description: config.identity,
        systemPrompt: config.identity,
        identity: config.identity,
        tools: config.tools,
        temperature: config.temperature,
      })
    }
  }
  return {
    getAgent: (id: string) => agents.get(id),
    registerAgent: (config: AgentConfig) => { agents.set(config.id, config) },
    updateAgent: async (id: string, patch: Partial<AgentConfig>) => {
      const existing = agents.get(id)
      if (!existing) throw new Error(`Agent 不存在: ${id}`)
      const updated = { ...existing, ...patch, id }
      agents.set(id, updated)
      return updated
    },
  } as unknown as AgentManager
}

describe('NovelAgentConfigStore', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  describe('agentManager 不可用时（回退到默认值）', () => {
    let store: NovelAgentConfigStore

    beforeEach(() => {
      store = new NovelAgentConfigStore(db)
    })

    it('getAll 返回 NOVEL_AGENT_CONFIGS 默认温度', () => {
      const all = store.getAll()
      expect(all.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
      expect(all.writer).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
      expect(all.reviewer).toBe(NOVEL_AGENT_CONFIGS.reviewer.temperature)
      expect(all.memory).toBe(NOVEL_AGENT_CONFIGS.memory.temperature)
    })

    it('getByType 返回默认温度', () => {
      expect(store.getByType('director')).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
      expect(store.getByType('writer')).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
    })

    it('upsert 在 agentManager 不可用时为 no-op（不抛错）', () => {
      expect(() => store.upsert('writer', 1.1)).not.toThrow()
      // 仍返回默认值（未写入任何地方）
      expect(store.getByType('writer')).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
    })
  })

  describe('agentManager 可用时（薄封装）', () => {
    let store: NovelAgentConfigStore
    let agentManager: AgentManager

    beforeEach(() => {
      agentManager = createMockAgentManager()
      store = new NovelAgentConfigStore(db, agentManager)
    })

    it('无覆盖时 getAll 返回默认温度', () => {
      const all = store.getAll()
      expect(all.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
      expect(all.writer).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
      expect(all.reviewer).toBe(NOVEL_AGENT_CONFIGS.reviewer.temperature)
      expect(all.memory).toBe(NOVEL_AGENT_CONFIGS.memory.temperature)
    })

    it('upsert 覆盖后 getAll 返回覆盖值', () => {
      store.upsert('writer', 1.1)
      const all = store.getAll()
      expect(all.writer).toBe(1.1)
      expect(all.director).toBe(NOVEL_AGENT_CONFIGS.director.temperature)
    })

    it('getByType 返回合并后温度（覆盖优先）', () => {
      store.upsert('director', 0.3)
      expect(store.getByType('director')).toBe(0.3)
      expect(store.getByType('writer')).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
    })

    it('upsertMany 批量覆盖', () => {
      store.upsertMany([
        { agentType: 'director', temperature: 0.6 },
        { agentType: 'writer', temperature: 1.0 },
      ])
      expect(store.getByType('director')).toBe(0.6)
      expect(store.getByType('writer')).toBe(1.0)
      expect(store.getByType('reviewer')).toBe(NOVEL_AGENT_CONFIGS.reviewer.temperature)
    })

    it('upsert 同步更新 AgentManager 内存（getAgent 立即可见）', () => {
      store.upsert('memory', 0.42)
      // 验证温度确实写入了 AgentManager（而非 novel_agent_config 表）
      const agent = agentManager.getAgent(NOVEL_AGENT_CONFIGS.memory.id)
      expect(agent?.temperature).toBe(0.42)
    })

    it('agent 未注册时 upsert 为 no-op（不抛错）', () => {
      const emptyAgentManager = createMockAgentManager(false)
      const emptyStore = new NovelAgentConfigStore(db, emptyAgentManager)
      // 未注册 agent，upsert 不应抛错（updateAgent 在 agent 不存在时会抛错）
      expect(() => emptyStore.upsert('writer', 1.1)).not.toThrow()
      // getByType 回退到默认值
      expect(emptyStore.getByType('writer')).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
    })
  })

  describe('novel_agent_config 表不再读写（向后兼容保留表结构）', () => {
    it('即使表存在也不从中读取', () => {
      // 创建表并写入旧数据（模拟历史遗留）
      db.exec(`
        CREATE TABLE IF NOT EXISTS novel_agent_config (
          agent_type    TEXT PRIMARY KEY,
          temperature   REAL,
          updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `)
      db.prepare('INSERT INTO novel_agent_config (agent_type, temperature) VALUES (?, ?)').run('writer', 1.5)

      const agentManager = createMockAgentManager()
      const store = new NovelAgentConfigStore(db, agentManager)

      // 应返回 AgentManager 的默认值（0.9），而非表中的 1.5
      expect(store.getByType('writer')).toBe(NOVEL_AGENT_CONFIGS.writer.temperature)
      // 表中的数据未被修改
      const row = db.prepare('SELECT temperature FROM novel_agent_config WHERE agent_type = ?').get('writer') as { temperature: number }
      expect(row.temperature).toBe(1.5)
    })
  })
})
