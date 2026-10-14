/**
 * Subagent 工具与 AgentManager
 *
 * 参考 ARCHITECTURE.md §9.2-9.3，实现：
 * - AgentConfig：Agent 配置定义
 * - AgentManager：管理 Agent 注册、subagent 派遣、持久化
 * - subagent / subagent_reply / subagent_close 工具（defineTool + TypeBox 格式）
 *
 * subagent 工具通过 ConcurrencyLimiter 控制并发，
 * 通过 AsyncLocalStorage 跟踪嵌套深度，防止无限递归。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Type, type Static } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { ConcurrencyLimiter, type ConcurrencyLimits, type ReleaseFunction } from './concurrency-limiter.js'
import { AgentChannel } from './agent-channel.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { AgentPersistenceStore } from './agent-persistence.js'
import type { AgentCallLogger } from './agent-call-logger.js'

/** Agent 配置 */
export interface AgentConfig {
  /** Agent ID（唯一标识） */
  id: string
  /** Agent 名称 */
  name: string
  /** Agent 描述（专长、用途） */
  description?: string
  /** 模型选择 */
  model?: {
    provider: string
    modelId: string
    /** 可选思考强度；未设置时使用模型/SDK 默认值。 */
    thinkingLevel?: ThinkingLevel | null
  }
  /** 系统提示词覆盖 */
  systemPrompt?: string
  /** 可用工具列表（不指定则使用全部） */
  tools?: string[]
  /** 身份模板（identity.md 内容） */
  identity?: string
  /** 人格模板（personality.md 内容） */
  personality?: string
  /** LLM 温度（0-2，未配置则使用 SDK 默认） */
  temperature?: number
  /**
   * 本次 Agent 调用显式授权的 Skill 文件路径。
   *
   * plugin:* 会话仍保持 noSkills=true，不扫描用户或项目的全部 Skills；
   * 这里只通过 DefaultResourceLoader.additionalSkillPaths 定向加载白名单 Skill。
   */
  skillPaths?: string[]
  /**
   * 动态系统提示词构造器（可选）
   * 若提供，dispatchFn 调用前会执行此构造器，覆盖 AgentConfig.systemPrompt
   * 用于需要 per-call 动态构造 prompt 的场景（如 novel 的三层缓存 prompt）
   */
  systemPromptBuilder?: (context: { task: string; [key: string]: unknown }) => string
  /**
   * 工具过滤器（可选）
   * 若提供，dispatchFn 调用前会执行此过滤器，返回允许使用的工具名列表
   * 用于按 Agent 角色限制工具权限（覆盖静态 tools 字段）
   */
  toolFilter?: (context: { task: string; [key: string]: unknown }) => string[]
  /**
   * 动态注入的额外工具实例（可选，含 execute 实现）
   *
   * ⚠️ 工具化方案专用：用于 per-call 注入闭包工具。
   * 与 tools 字段（白名单 string[]）的区别：
   * - tools：只过滤已注册到 pluginSessionTools 的工具
   * - extraTools：携带 execute 实现的工具实例，直接加入 customTools
   *
   * 使用场景：
   * - novel_submit_narrative_task：Director 调用时通过闭包绑定 narrativeDraft
   * - novel_apply_revision：Reviser 调用时通过闭包绑定 revisionDraft
   * - novel_submit_review：Reviewer 调用时通过闭包绑定 reviewDraft
   *
   * 这些工具不进入全局 pluginSessionTools（避免闭包状态污染），
   * 而是通过 withAgentConfig 在 session 创建期间临时注入。
   */
  extraTools?: ToolDefinition[]
}

/** subagent 执行结果 */
export interface SubagentResult {
  /** 子 Agent ID */
  agentId: string
  /** 执行的任务描述 */
  task: string
  /** 执行结果文本 */
  result: string
  /** 是否成功 */
  success: boolean
  /** 错误信息（失败时） */
  error?: string
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 嵌套深度 */
  depth: number
  /** 子 Agent 的 threadId（供 subagent_reply 续接使用） */
  threadId?: string
}

/** 流式进度回调 */
export interface SubagentProgress {
  /** 进度文本 */
  text: string
  /** 阶段 */
  phase: 'thinking' | 'tool_call' | 'output'
}

/** subagent 派遣函数：由外部注入实际执行逻辑 */
export type DispatchFn = (
  agentId: string,
  task: string,
  options: {
    signal?: AbortSignal
    depth: number
    /** 流式进度回调（可选） */
    onProgress?: (progress: SubagentProgress) => void
  },
) => Promise<{ result: string; threadId: string }>

// ─── TypeBox Schema 定义 ───

/** subagent 工具参数 */
const SubagentToolParams = Type.Object({
  agentId: Type.String({ description: '目标 Agent ID' }),
  task: Type.String({ minLength: 1, description: '任务描述' }),
  timeout: Type.Number({
    minimum: 1000,
    maximum: 600000,
    default: 60000,
    description: '超时毫秒数（默认 60s）',
  }),
})

/** subagent_reply 工具参数 */
const SubagentReplyParams = Type.Object({
  threadId: Type.String({ description: '子 Agent 的 threadId（从 subagent 调用结果中获取）' }),
  task: Type.String({ minLength: 1, description: '后续任务描述' }),
  timeout: Type.Number({ minimum: 1000, maximum: 600000, default: 60000 }),
})

/** subagent_close 工具参数 */
const SubagentCloseParams = Type.Object({
  threadId: Type.String({ description: '要关闭的子 Agent threadId' }),
})

/** AsyncLocalStorage 用于跟踪当前 subagent 嵌套深度 */
const depthStorage = new AsyncLocalStorage<number>()

/**
 * AgentManager：管理 Agent 注册与 subagent 派遣
 *
 * 关键不变量：
 * 1. 每个 Agent ID 唯一，重复注册会覆盖
 * 2. dispatchToAgent 通过 ConcurrencyLimiter 控制并发与深度
 * 3. 嵌套深度通过 AsyncLocalStorage 自动传递
 * 4. Agent 配置持久化到 SQLite（如果 store 提供）
 */
export class AgentManager {
  private readonly agents = new Map<string, AgentConfig>()
  private readonly limiter: ConcurrencyLimiter
  private readonly channel: AgentChannel
  private readonly store?: AgentPersistenceStore
  /** 通用 Agent 调用日志记录器（可选，注入后 dispatchToAgent 自动记录调用日志） */
  private readonly callLogger?: AgentCallLogger
  private dispatchFn?: DispatchFn
  /** 活跃的子 Agent session 注册表 */
  private readonly activeSubagentSessions = new Map<string, {
    threadId: string
    agentId: string
    createdAt: number
  }>()

  constructor(options: {
    limits?: ConcurrencyLimits
    channel: AgentChannel
    store?: AgentPersistenceStore
    /** 通用 Agent 调用日志记录器（可选） */
    callLogger?: AgentCallLogger
  }) {
    this.limiter = new ConcurrencyLimiter(options.limits)
    this.channel = options.channel
    this.store = options.store
    this.callLogger = options.callLogger
  }

  /** 设置派遣函数（由插件注入实际执行逻辑） */
  setDispatchFn(fn: DispatchFn): void {
    this.dispatchFn = fn
  }

  /** 注册 Agent（仅内存） */
  registerAgent(config: AgentConfig): void {
    this.agents.set(config.id, config)
  }

  /** 注销 Agent */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId)
  }

  /** 获取 Agent 配置 */
  getAgent(agentId: string): AgentConfig | undefined {
    return this.agents.get(agentId)
  }

  /** 列出所有 Agent */
  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values())
  }

  /** 获取并发限流器 */
  getLimiter(): ConcurrencyLimiter {
    return this.limiter
  }

  /** 获取通信通道 */
  getChannel(): AgentChannel {
    return this.channel
  }

  /** 从持久化存储加载所有 Agent */
  loadPersistedAgents(): void {
    if (!this.store) return
    const agents = this.store.loadAll()
    for (const agent of agents) {
      this.agents.set(agent.id, agent)
    }
  }

  /** 创建 Agent（注册 + 持久化） */
  async createAgent(config: AgentConfig): Promise<AgentConfig> {
    this.agents.set(config.id, config)
    this.store?.save(config)
    return config
  }

  /** 更新 Agent 配置 */
  async updateAgent(id: string, patch: Partial<AgentConfig>): Promise<AgentConfig> {
    const existing = this.agents.get(id)
    if (!existing) {
      throw new AppError(ErrorCode.NOT_FOUND, `Agent 不存在: ${id}`, 404)
    }
    const updated = { ...existing, ...patch, id }
    this.agents.set(id, updated)
    this.store?.save(updated)
    return updated
  }

  /** 删除 Agent（注销 + 从持久化存储删除） */
  async deleteAgent(id: string): Promise<void> {
    this.agents.delete(id)
    this.store?.delete(id)
  }

  /**
   * 派遣子任务给指定 Agent
   */
  async dispatchToAgent(
    agentId: string,
    task: string,
    options: {
      timeoutMs?: number
      signal?: AbortSignal
      onProgress?: (progress: SubagentProgress) => void
    } = {},
  ): Promise<SubagentResult> {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, `Agent 不存在: ${agentId}`, 404)
    }

    if (!this.dispatchFn) {
      throw new AppError(ErrorCode.CONFIG_ERROR, '派遣函数未设置，请先调用 setDispatchFn', 500)
    }

    const currentDepth = depthStorage.getStore() ?? 0
    const childDepth = currentDepth + 1

    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? 60000

    let release: ReleaseFunction
    try {
      release = await this.limiter.acquire(childDepth, {
        timeoutMs: timeoutMs > 5000 ? 5000 : timeoutMs,
      })
    } catch (error) {
      return {
        agentId,
        task,
        result: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        depth: childDepth,
      }
    }

    const abortController = new AbortController()
    const timeoutTimer = setTimeout(() => abortController.abort(), timeoutMs)

    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort()
      } else {
        options.signal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
    }

    // 用于 finally 块记录日志的状态变量
    let callResult = ''
    let callThreadId = ''
    let callError = ''
    let callSuccess = true

    try {
      const { result, threadId } = await depthStorage.run(childDepth, () =>
        this.dispatchFn!(agentId, task, {
          signal: abortController.signal,
          depth: childDepth,
          onProgress: options.onProgress,
        }),
      )

      callResult = result
      callThreadId = threadId

      // 记录活跃 session
      this.activeSubagentSessions.set(threadId, {
        threadId,
        agentId,
        createdAt: Date.now(),
      })

      return {
        agentId,
        task,
        result,
        success: true,
        durationMs: Date.now() - startedAt,
        depth: childDepth,
        threadId,
      }
    } catch (error) {
      callSuccess = false
      callError = error instanceof Error ? error.message : String(error)
      return {
        agentId,
        task,
        result: '',
        success: false,
        error: callError,
        durationMs: Date.now() - startedAt,
        depth: childDepth,
      }
    } finally {
      clearTimeout(timeoutTimer)
      release()

      // 自动记录 Agent 调用日志（fire-and-forget，失败不影响主流程）
      if (this.callLogger) {
        try {
          this.callLogger.record({
            agentId,
            agentName: agent.name,
            threadId: callThreadId,
            systemPrompt: agent.systemPrompt ?? '',
            userMessage: task,
            taskInput: task,
            tools: JSON.stringify(agent.tools ?? []),
            toolNames: JSON.stringify(agent.tools ?? []),
            result: callResult,
            resultLength: callResult.length,
            durationMs: Date.now() - startedAt,
            status: callSuccess ? 'success' : 'error',
            error: callError,
            metadata: JSON.stringify({ depth: childDepth, source: 'subagent' }),
          })
        } catch {
          // 日志写入失败不影响主流程
        }
      }
    }
  }

  /**
   * 续接已有子 Agent session
   */
  async replyToAgent(
    threadId: string,
    task: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SubagentResult> {
    const sessionInfo = this.activeSubagentSessions.get(threadId)
    if (!sessionInfo) {
      return {
        agentId: 'unknown',
        task,
        result: '',
        success: false,
        error: `子 Agent 会话不存在或已关闭: ${threadId}`,
        durationMs: 0,
        depth: 0,
      }
    }

    if (!this.dispatchFn) {
      throw new AppError(ErrorCode.CONFIG_ERROR, '派遣函数未设置', 500)
    }

    const currentDepth = depthStorage.getStore() ?? 0
    const childDepth = currentDepth + 1
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? 60000

    let release: ReleaseFunction
    try {
      release = await this.limiter.acquire(childDepth, {
        timeoutMs: timeoutMs > 5000 ? 5000 : timeoutMs,
      })
    } catch (error) {
      return {
        agentId: sessionInfo.agentId,
        task,
        result: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        depth: childDepth,
      }
    }

    const abortController = new AbortController()
    const timeoutTimer = setTimeout(() => abortController.abort(), timeoutMs)

    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort()
      } else {
        options.signal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
    }

    try {
      const { result } = await depthStorage.run(childDepth, () =>
        this.dispatchFn!(sessionInfo.agentId, task, {
          signal: abortController.signal,
          depth: childDepth,
        }),
      )

      return {
        agentId: sessionInfo.agentId,
        task,
        result,
        success: true,
        durationMs: Date.now() - startedAt,
        depth: childDepth,
        threadId,
      }
    } catch (error) {
      return {
        agentId: sessionInfo.agentId,
        task,
        result: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        depth: childDepth,
      }
    } finally {
      clearTimeout(timeoutTimer)
      release()
    }
  }

  /**
   * 关闭子 Agent session，释放资源
   */
  async closeAgentSession(threadId: string): Promise<void> {
    this.activeSubagentSessions.delete(threadId)
  }

  /** 获取 Agent 的活跃 subagent sessions */
  getActiveSessions(agentId?: string): Array<{ threadId: string; agentId: string; createdAt: number }> {
    const all = Array.from(this.activeSubagentSessions.values())
    return agentId ? all.filter((s) => s.agentId === agentId) : all
  }

  /** 重置限流器 */
  resetLimiter(): void {
    this.limiter.reset()
  }
}

// ─── defineTool 工具定义 ───

/** 创建 subagent 工具（Pi SDK ToolDefinition 格式） */
export function createSubagentTool(manager: AgentManager): ToolDefinition<typeof SubagentToolParams> {
  return defineTool({
    name: 'subagent',
    label: '子代理',
    description:
      '派遣子任务给指定 Agent 执行。当需要其他 Agent 的专长时调用此工具。' +
      '注意：嵌套深度和并发数受限流器控制，超限时会抛错。',
    promptSnippet: '派遣子任务给指定 Agent 执行',
    parameters: SubagentToolParams,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<undefined>> {
      // 通知前端：子 Agent 开始执行
      onUpdate?.({
        content: [{ type: 'text', text: `正在派遣任务给 ${params.agentId}...` }],
        details: undefined,
      })

      const result = await manager.dispatchToAgent(params.agentId, params.task, {
        timeoutMs: params.timeout,
        signal,
        onProgress: (progress) => {
          onUpdate?.({
            content: [{ type: 'text', text: progress.text }],
            details: undefined,
          })
        },
      })

      if (!result.success) {
        return {
          content: [{ type: 'text', text: `子 Agent 执行失败: ${result.error ?? '未知错误'}` }],
          details: undefined,
        }
      }
      // 在结果中附带 threadId，供 subagent_reply 使用
      return {
        content: [{ type: 'text', text: `${result.result}\n\n[threadId: ${result.threadId}]` }],
        details: undefined,
      }
    },
  })
}

/** 创建 subagent_reply 工具 */
export function createSubagentReplyTool(manager: AgentManager): ToolDefinition<typeof SubagentReplyParams> {
  return defineTool({
    name: 'subagent_reply',
    label: '子代理续接',
    description: '向已存在的子 Agent 会话发送后续消息，用于多轮交互。',
    promptSnippet: '续接已有子 Agent 会话',
    parameters: SubagentReplyParams,
    async execute(toolCallId, params, signal): Promise<AgentToolResult<undefined>> {
      const result = await manager.replyToAgent(params.threadId, params.task, {
        timeoutMs: params.timeout,
        signal,
      })
      if (!result.success) {
        return {
          content: [{ type: 'text', text: `续接失败: ${result.error}` }],
          details: undefined,
        }
      }
      return {
        content: [{ type: 'text', text: result.result }],
        details: undefined,
      }
    },
  })
}

/** 创建 subagent_close 工具 */
export function createSubagentCloseTool(manager: AgentManager): ToolDefinition<typeof SubagentCloseParams> {
  return defineTool({
    name: 'subagent_close',
    label: '子代理关闭',
    description: '关闭子 Agent 会话，释放资源。',
    promptSnippet: '关闭子 Agent 会话',
    parameters: SubagentCloseParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      await manager.closeAgentSession(params.threadId)
      return {
        content: [{ type: 'text', text: `子 Agent 会话 ${params.threadId} 已关闭` }],
        details: undefined,
      }
    },
  })
}
