/**
 * Subagent 协作插件
 *
 * 参考 ARCHITECTURE.md §9，初始化多 Agent 协作核心组件：
 * - AgentChannel：Agent 间频道/DM 通信
 * - ConcurrencyLimiter：并发限流（通过 AgentManager 持有）
 * - AgentManager：Agent 注册与 subagent 派遣
 *
 * 通过 fastify.subagentManager 暴露给路由和其他插件使用。
 *
 * 默认注册一个 'default' Agent，对应主 Agent。
 */

import fp from 'fastify-plugin'
import { AgentChannel } from '../core/agent/agent-channel.js'
import { AgentManager, type AgentConfig } from '../core/agent/subagent-tool.js'
import { DEFAULT_LIMITS, type ConcurrencyLimits } from '../core/agent/concurrency-limiter.js'

export interface SubagentPluginOptions {
  /** 并发限制配置 */
  limits?: Partial<ConcurrencyLimits>
  /** 初始注册的 Agent 列表 */
  agents?: AgentConfig[]
}

export const subagentPlugin = fp(async (app, rawOptions) => {
  const options = (rawOptions ?? {}) as SubagentPluginOptions

  // 1. 创建 AgentChannel（集成 EventBus）
  const channel = new AgentChannel(app.eventBus)

  // 2. 创建 AgentManager（持有 ConcurrencyLimiter）
  const limits: ConcurrencyLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const manager = new AgentManager({
    limits,
    channel,
  })

  // 3. 注册默认 Agent
  const defaultAgent: AgentConfig = {
    id: 'default',
    name: 'Pi Agent',
    description: '默认主 Agent',
  }
  manager.registerAgent(defaultAgent)

  // 4. 注册用户提供的 Agent
  if (options.agents) {
    for (const agent of options.agents) {
      manager.registerAgent(agent)
    }
  }

  // 5. 注入派遣函数：使用 PiSessionStore 创建隔离 Session 执行子任务
  manager.setDispatchFn(async (agentId, task, dispatchOptions) => {
    // 为 subagent 创建独立的 threadId
    const subagentThreadId = `subagent-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const threadSession = await app.piSessionStore.getOrCreate(subagentThreadId)

    // 如果目标 Agent 配置了模型，切换模型
    const agentConfig = manager.getAgent(agentId)
    if (agentConfig?.model) {
      const targetModel = app.modelRegistry.find(agentConfig.model.provider, agentConfig.model.modelId)
      if (targetModel) {
        await threadSession.session.setModel(targetModel)
      }
    }

    // 执行任务（通过 session.prompt）
    // dispatchOptions.signal 用于超时/取消控制
    if (dispatchOptions.signal?.aborted) {
      throw new Error('子任务在执行前已被取消')
    }

    // 监听取消信号
    const abortPromise = new Promise<never>((_, reject) => {
      if (dispatchOptions.signal) {
        dispatchOptions.signal.addEventListener('abort', () => {
          reject(new Error('子任务已被取消'))
        }, { once: true })
      }
    })

    const promptPromise = threadSession.session.prompt(task)
    const result = await Promise.race([promptPromise, abortPromise])

    // 返回执行结果文本
    if (typeof result === 'string') {
      return result
    }
    if (result && typeof result === 'object' && 'content' in result) {
      const content = (result as { content: unknown }).content
      return typeof content === 'string' ? content : JSON.stringify(content)
    }
    return String(result ?? '')
  })

  // 6. 挂载到 Fastify 实例
  app.decorate('subagentManager', manager)

  app.log.info(
    { agentCount: manager.listAgents().length, limits },
    'Subagent 协作插件已初始化',
  )
})
