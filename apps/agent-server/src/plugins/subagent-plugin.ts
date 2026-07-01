/**
 * Subagent 协作插件
 *
 * 参考 ARCHITECTURE.md §9，初始化多 Agent 协作核心组件：
 * - AgentChannel：Agent 间频道/DM 通信
 * - ConcurrencyLimiter：并发限流（通过 AgentManager 持有）
 * - AgentManager：Agent 注册与 subagent 派遣
 * - SqliteAgentStore：Agent 配置持久化到 SQLite
 *
 * 通过 fastify.subagentManager 暴露给路由和其他插件使用。
 *
 * 默认注册一个 'default' Agent，对应主 Agent。
 */

import fp from 'fastify-plugin'
import { AgentChannel } from '../core/agent/agent-channel.js'
import { AgentManager, type AgentConfig } from '../core/agent/subagent-tool.js'
import { SqliteAgentStore } from '../core/agent/agent-persistence.js'
import { withAgentConfig } from '../core/agent/pi-session.js'
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

  // 2. 创建 SQLite 持久化存储
  const store = new SqliteAgentStore(app.db)

  // 3. 创建 AgentManager（持有 ConcurrencyLimiter + 持久化存储）
  const limits: ConcurrencyLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const manager = new AgentManager({
    limits,
    channel,
    store,
  })

  // 4. 从数据库加载已持久化的 Agent
  manager.loadPersistedAgents()

  // 5. 注册默认 Agent（如果不存在）
  if (!manager.getAgent('default')) {
    const defaultAgent: AgentConfig = {
      id: 'default',
      name: 'Pi Agent',
      description: '默认主 Agent',
    }
    manager.registerAgent(defaultAgent)
  }

  // 6. 注册用户提供的 Agent
  if (options.agents) {
    for (const agent of options.agents) {
      manager.registerAgent(agent)
    }
  }

  // 7. 注入派遣函数：使用 PiSessionStore 创建隔离 Session 执行子任务
  manager.setDispatchFn(async (agentId, task, dispatchOptions) => {
    const agentConfig = manager.getAgent(agentId)
    if (!agentConfig) {
      throw new Error(`Agent 不存在: ${agentId}`)
    }

    // 在 AgentConfig 上下文中创建 session，使 buildSystemPrompt 能注入身份/人格模板
    return withAgentConfig(agentConfig, async () => {
      // 为 subagent 创建独立的 threadId
      const subagentThreadId = `subagent-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const threadSession = await app.piSessionStore.getOrCreate(subagentThreadId)

      // 如果目标 Agent 配置了模型，切换模型
      if (agentConfig.model) {
        const targetModel = app.modelRegistry.find(agentConfig.model.provider, agentConfig.model.modelId)
        if (targetModel) {
          await threadSession.session.setModel(targetModel)
        }
      }

      // 注入生成参数到 provider payload（temperature / max_tokens）
      // Agent.onPayload 在 provider 请求发送前调用，返回修改后的 payload
      const inject: Record<string, unknown> = {}
      if (agentConfig.temperature !== undefined) {
        inject.temperature = agentConfig.temperature
      }
      // 从模型配置读取 maxTokens
      if (agentConfig.model) {
        const model = app.modelRegistry.find(agentConfig.model.provider, agentConfig.model.modelId)
        if (model?.maxTokens) {
          inject.max_tokens = model.maxTokens
        }
      }
      if (Object.keys(inject).length > 0) {
        const piSession = threadSession.session as {
          agent?: { onPayload?: (payload: unknown) => unknown }
        }
        if (piSession.agent) {
          piSession.agent.onPayload = (payload: unknown) => ({
            ...(payload as Record<string, unknown>),
            ...inject,
          })
        }
      }

      // 检查取消信号
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

      // 监听 subagent session 事件，转发为 onProgress
      if (dispatchOptions.onProgress) {
        threadSession.session.subscribe((event: any) => {
          if (event.type === 'tool_execution_start') {
            const toolName = event.toolName ?? 'unknown'
            dispatchOptions.onProgress!({
              text: `子 Agent 调用工具: ${toolName}`,
              phase: 'tool_call',
            })
          }
          if (event.type === 'message_update') {
            dispatchOptions.onProgress!({
              text: '子 Agent 思考中...',
              phase: 'thinking',
            })
          }
        })
      }

      const promptPromise = threadSession.session.prompt(task)
      const rawResult = await Promise.race([promptPromise, abortPromise])

      // 解析执行结果文本
      let result: string
      if (typeof rawResult === 'string') {
        result = rawResult
      } else if (rawResult && typeof rawResult === 'object' && 'content' in rawResult) {
        const content = (rawResult as { content: unknown }).content
        result = typeof content === 'string' ? content : JSON.stringify(content)
      } else {
        result = String(rawResult ?? '')
      }

      return { result, threadId: subagentThreadId }
    })
  })

  // 8. 挂载到 Fastify 实例
  app.decorate('subagentManager', manager)

  app.log.info(
    { agentCount: manager.listAgents().length, limits },
    'Subagent 协作插件已初始化',
  )
})
