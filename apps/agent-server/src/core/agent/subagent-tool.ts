/**
 * Subagent 工具与 AgentManager
 *
 * 参考 ARCHITECTURE.md §9.2-9.3，实现：
 * - AgentConfig：Agent 配置定义
 * - AgentManager：管理 Agent 注册、subagent 派遣
 * - SubagentTool：subagent 工具定义与执行
 *
 * subagent 工具通过 ConcurrencyLimiter 控制并发，
 * 通过 AsyncLocalStorage 跟踪嵌套深度，防止无限递归。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { ConcurrencyLimiter, type ConcurrencyLimits, type ReleaseFunction } from './concurrency-limiter.js'
import { AgentChannel } from './agent-channel.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

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
  }
  /** 系统提示词覆盖 */
  systemPrompt?: string
  /** 可用工具列表（不指定则使用全部） */
  tools?: string[]
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
}

/** subagent 派遣函数：由外部注入实际执行逻辑 */
export type DispatchFn = (
  agentId: string,
  task: string,
  options: { signal?: AbortSignal; depth: number },
) => Promise<string>

/** subagent 工具参数 schema */
export const subagentToolSchema = z.object({
  agentId: z.string().describe('目标 Agent ID'),
  task: z.string().min(1).describe('任务描述'),
  timeout: z.number().min(1000).max(600000).default(60000).describe('超时毫秒数（默认 60s）'),
})

export type SubagentToolInput = z.infer<typeof subagentToolSchema>

/** subagent 工具定义（JSON Schema 格式，兼容 Pi SDK customTools） */
export const subagentToolDefinition = {
  name: 'subagent',
  description:
    '派遣子任务给指定 Agent 执行。当需要其他 Agent 的专长时调用此工具。' +
    '注意：嵌套深度和并发数受限流器控制，超限时会抛错。',
  parameters: {
    type: 'object' as const,
    properties: {
      agentId: { type: 'string', description: '目标 Agent ID' },
      task: { type: 'string', description: '任务描述' },
      timeout: {
        type: 'number',
        description: '超时毫秒数（默认 60000，即 60s）',
        default: 60000,
      },
    },
    required: ['agentId', 'task'],
  },
}

/** AsyncLocalStorage 用于跟踪当前 subagent 嵌套深度 */
const depthStorage = new AsyncLocalStorage<number>()

/**
 * AgentManager：管理 Agent 注册与 subagent 派遣
 *
 * 关键不变量：
 * 1. 每个 Agent ID 唯一，重复注册会覆盖
 * 2. dispatchToAgent 通过 ConcurrencyLimiter 控制并发与深度
 * 3. 嵌套深度通过 AsyncLocalStorage 自动传递
 */
export class AgentManager {
  private readonly agents = new Map<string, AgentConfig>()
  private readonly limiter: ConcurrencyLimiter
  private readonly channel: AgentChannel
  private dispatchFn?: DispatchFn

  constructor(options: {
    limits?: ConcurrencyLimits
    channel: AgentChannel
  }) {
    this.limiter = new ConcurrencyLimiter(options.limits)
    this.channel = options.channel
  }

  /** 设置派遣函数（由插件注入实际执行逻辑） */
  setDispatchFn(fn: DispatchFn): void {
    this.dispatchFn = fn
  }

  /** 注册 Agent */
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

  /**
   * 派遣子任务给指定 Agent
   *
   * @param agentId 目标 Agent ID
   * @param task 任务描述
   * @param options 超时等选项
   * @returns 子 Agent 执行结果
   */
  async dispatchToAgent(
    agentId: string,
    task: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SubagentResult> {
    // 检查目标 Agent 是否存在
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `Agent 不存在: ${agentId}`,
        404,
      )
    }

    // 检查派遣函数是否已注入
    if (!this.dispatchFn) {
      throw new AppError(
        ErrorCode.CONFIG_ERROR,
        '派遣函数未设置，请先调用 setDispatchFn',
        500,
      )
    }

    // 获取当前嵌套深度（主 Agent 调用时为 0）
    const currentDepth = depthStorage.getStore() ?? 0
    const childDepth = currentDepth + 1

    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? 60000

    // 获取并发槽位（带超时等待）
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

    // 创建超时 AbortController
    const abortController = new AbortController()
    const timeoutTimer = setTimeout(() => {
      abortController.abort()
    }, timeoutMs)

    // 如果外部传入了 signal，联动取消
    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort()
      } else {
        options.signal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
    }

    try {
      // 在新的 AsyncLocalStorage 上下文中执行，传递子深度
      const result = await depthStorage.run(childDepth, () =>
        this.dispatchFn!(agentId, task, {
          signal: abortController.signal,
          depth: childDepth,
        }),
      )

      return {
        agentId,
        task,
        result,
        success: true,
        durationMs: Date.now() - startedAt,
        depth: childDepth,
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return {
        agentId,
        task,
        result: '',
        success: false,
        error: errorMsg,
        durationMs: Date.now() - startedAt,
        depth: childDepth,
      }
    } finally {
      clearTimeout(timeoutTimer)
      release()
    }
  }

  /**
   * 执行 subagent 工具
   * 供 Pi SDK customTools 调用
   */
  async executeSubagentTool(input: SubagentToolInput): Promise<SubagentResult> {
    return this.dispatchToAgent(input.agentId, input.task, {
      timeoutMs: input.timeout,
    })
  }

  /** 重置限流器（新一轮主任务开始时调用） */
  resetLimiter(): void {
    this.limiter.reset()
  }
}

/**
 * 创建 subagent 工具的执行函数
 *
 * 返回一个可直接用于 Pi SDK customTools 的 execute 函数。
 * 调用时自动从 AgentManager 获取限流器和派遣逻辑。
 */
export function createSubagentToolExecutor(manager: AgentManager) {
  return async (args: SubagentToolInput): Promise<string> => {
    const result = await manager.executeSubagentTool(args)
    if (!result.success) {
      return `子 Agent 执行失败: ${result.error ?? '未知错误'}`
    }
    return result.result
  }
}
