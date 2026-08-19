import {
  EventType,
  type RunFinishedEvent,
  type RunStartedEvent,
  type RunErrorEvent,
  type MessagesSnapshotEvent,
  type ToolCallResultEvent
} from '@ag-ui/core'
import { randomUUID } from 'node:crypto'
import type { AgUiEventSink } from '@repo/protocol/events'
import type { EventBus } from '@repo/shared/events'
import type { PiSessionStore, PiThreadSession } from './session-store.js'
import type { ProviderConfigStore } from '../config/provider-config-store.js'
import type { ThreadSettingsStore } from './thread-settings-store.js'
import { StreamEmitter, emitSingleAssistantMessage } from './stream-emitter.js'
import { ReasoningPipeline } from './reasoning-pipeline.js'
import { AppError, ErrorCode } from '@repo/shared/errors'
import type { Tracer } from '../tracer/tracer.js'
import type { TraceEvent } from '../tracer/types.js'

/** streamRun 输入（宽松类型，兼容 @repo/protocol schema 输出） */
export interface StreamRunInput {
  threadId: string
  runId: string
  messages: Array<{
    id: string
    role: string
    content: string | unknown
    toolCallId?: string
  }>
  /** 模型选择：允许前端指定 provider + modelId */
  model?: {
    provider: string
    modelId: string
  }
  /** 生成温度（0-2），未传则不注入 */
  temperature?: number
}

export interface StreamRunOptions {
  signal?: AbortSignal
}

/** steer/follow-up 结果 */
export interface SteerResult {
  status: 'accepted' | 'no_active_run'
  threadId: string
}

/**
 * PiAgUiAgent：AG-UI 适配层核心类
 *
 * 关键不变量：
 * 1. 一次 streamRun 恰好发射一个终止事件（RUN_FINISHED 或 RUN_ERROR），之后不再发射任何事件
 * 2. abort 视为正常终止，发射 RUN_FINISHED（reason: 'aborted'），不发射 RUN_ERROR
 * 3. 同一 threadId 同时只允许一个活跃 run，并发 run 返回 409
 */
export class PiAgUiAgent {
  readonly agentId: string
  private readonly tracer?: Tracer

  constructor(
    private readonly sessionStore: PiSessionStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly modelRegistry: any,
    private readonly providerConfigStore: ProviderConfigStore,
    private readonly threadSettingsStore: ThreadSettingsStore,
    private readonly eventBus?: EventBus,
    agentId = 'default',
    tracer?: Tracer,
  ) {
    this.agentId = agentId
    this.tracer = tracer
  }

  async streamRun(
    input: StreamRunInput,
    emit: AgUiEventSink,
    runOptions: StreamRunOptions = {}
  ): Promise<void> {
    const threadId = input.threadId
    const runId = input.runId

    // 终止事件守卫：确保只发射一次
    let terminated = false
    const emitTermination = (event: RunFinishedEvent | RunErrorEvent) => {
      if (terminated) return
      terminated = true
      emit(event)
    }

    // ===== 追踪：开始 =====
    let traceId: string | undefined
    if (this.tracer) {
      const trace = this.tracer.startTrace({
        sessionId: threadId,
        runId,
        metadata: { agentId: this.agentId },
      })
      traceId = trace.id
      this.tracer.addEvent(traceId, {
        type: 'user_message',
        data: {
          messages: input.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
        },
        status: 'completed',
      })
    }

    this.eventBus?.emit('devlog:entry', {
      level: 'debug',
      message: `Run 开始: threadId=${threadId}, runId=${runId}${traceId ? `, traceId=${traceId}` : ''}`,
      source: 'agent',
    })

    emit({
      type: EventType.RUN_STARTED,
      threadId,
      runId
    } as RunStartedEvent)

    emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: input.messages
    } as MessagesSnapshotEvent)

    const lastMessage = input.messages[input.messages.length - 1]
    if (lastMessage?.role === 'tool') {
      const toolCallId = (lastMessage as { toolCallId?: string }).toolCallId
      if (toolCallId) {
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: lastMessage.id,
          toolCallId,
          content:
            typeof lastMessage.content === 'string'
              ? lastMessage.content
              : JSON.stringify(lastMessage.content),
          role: 'tool'
        } as ToolCallResultEvent)
        if (traceId) {
          this.tracer?.addEvent(traceId, {
            type: 'tool_result',
            data: { toolCallId, content: typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content) },
            status: 'completed',
          })
        }
      }
    }

    // 同线程 run 互斥：尝试占用 activeRunId
    const acquired = this.sessionStore.tryAcquireRun(threadId, runId)
    if (!acquired) {
      this.eventBus?.emit('devlog:entry', {
        level: 'warn',
        message: `Run 被拒绝（线程 ${threadId} 已有活跃 run）`,
        source: 'agent',
      })
      if (traceId) {
        this.tracer?.addEvent(traceId, {
          type: 'run_error',
          data: { message: `线程 ${threadId} 已有活跃 run` },
          status: 'failed',
        })
        this.tracer?.finishTrace(traceId, 'failed')
      }
      emitTermination({
        type: EventType.RUN_ERROR,
        message: `线程 ${threadId} 已有活跃 run，请等待完成或中断后再试`
      } as RunErrorEvent)
      return
    }

    let threadSession: PiThreadSession | null = null
    let unsubscribe: (() => void) | null = null
    let abortHandler: (() => void) | null = null

    try {
      threadSession = await this.sessionStore.getOrCreate(threadId)

      // 模型切换：如果前端传了 model，切换到指定模型
      if (input.model) {
        const targetModel = this.modelRegistry.find(input.model.provider, input.model.modelId)
        if (targetModel) {
          await threadSession.session.setModel(targetModel)
        } else {
          emitTermination({
            type: EventType.RUN_ERROR,
            message: `模型不可用：${input.model.provider}/${input.model.modelId}`
          } as RunErrorEvent)
          return
        }
      }

      // 注入生成参数到 provider payload（max_tokens + temperature）
      // max_tokens 从 ModelRegistry 自动读取，temperature 由前端传入
      const inject: Record<string, unknown> = {}
      if (input.model) {
        const model = this.modelRegistry.find(input.model.provider, input.model.modelId)
        if (model?.maxTokens) inject.max_tokens = model.maxTokens
      } else if (this.modelRegistry?.getAll) {
        const allModels = this.modelRegistry.getAll() as Array<{ maxTokens?: number }>
        if (allModels.length > 0 && allModels[0].maxTokens) {
          inject.max_tokens = allModels[0].maxTokens
        }
      }
      if (input.temperature !== undefined) {
        inject.temperature = input.temperature
      }
      // stream_options 屏蔽：与 plugin-manager.ts createSession 保持一致
      const stripStreamOptions = this.providerConfigStore.getStripStreamOptions()
      if (Object.keys(inject).length > 0 || stripStreamOptions) {
        const piSession = threadSession.session as {
          agent?: { onPayload?: (payload: unknown) => unknown | Promise<unknown> }
        }
        if (piSession.agent) {
          // 必须使用 async/await：Pi SDK 默认的 onPayload 是 async 函数，
          // 返回 Promise<payload>。若不 await，spread Promise 会得到空对象，
          // 导致 messages 字段丢失，LLM 网关返回 400。
          // 这与 plugin-manager.ts createSession 的 onPayload 修复保持一致。
          const prevOnPayload = piSession.agent.onPayload
          piSession.agent.onPayload = async (payload: unknown) => {
            let next = prevOnPayload ? await prevOnPayload(payload) : payload
            if (Object.keys(inject).length > 0) {
              next = { ...(next as Record<string, unknown>), ...inject }
            }
            if (stripStreamOptions) {
              const p = next as Record<string, unknown>
              if (p && typeof p === 'object' && 'stream_options' in p) {
                const { stream_options: _removed, ...rest } = p
                console.info('[pi-agui-agent] ✅ 已移除 stream_options 字段（兼容中转网关）', { threadId })
                next = rest
              }
            }
            return next
          }
          console.info(
            '[pi-agui-agent] 🔧 已注入 onPayload 钩子',
            { threadId, stripStreamOptions, injectKeys: Object.keys(inject) },
          )
        }
      }

      const assistantResponseMessageId = randomUUID()
      const reasoningPipeline = new ReasoningPipeline(emit, assistantResponseMessageId)
      const streamEmitter = new StreamEmitter(emit, assistantResponseMessageId, reasoningPipeline)
      let lastAssistantError = ''

      unsubscribe = threadSession.session.subscribe((event: Record<string, unknown>) => {
        streamEmitter.handleSessionEvent(event)

        // Pi SDK 会把部分 LLM 故障表示为 message_end(stopReason="error")，
        // session.prompt() 在自动重试耗尽后仍可能正常 resolve。记录最后一次
        // assistant 终态，避免将“空响应 + 503”等故障误报为 RUN_FINISHED。
        if (event.type === 'message_end') {
          const message = event.message as Record<string, unknown> | undefined
          if (message?.role === 'assistant') {
            lastAssistantError = message.stopReason === 'error'
              ? ((message.errorMessage as string) || '未知 LLM 错误')
              : ''
          }
        }
      })

      abortHandler = () => {
        void threadSession!.session.abort()
      }
      runOptions.signal?.addEventListener('abort', abortHandler, { once: true })

      const lastUserMessage = [...input.messages].reverse().find((m) => m.role === 'user')
      const userText = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : ''

      if (!userText) {
        if (traceId) {
          this.tracer?.addEvent(traceId, {
            type: 'run_error',
            data: { message: '无用户消息' },
            status: 'failed',
          })
          this.tracer?.finishTrace(traceId, 'failed')
        }
        emitSingleAssistantMessage(emit, '我需要一条用户消息才能继续。')
        emitTermination({
          type: EventType.RUN_FINISHED,
          threadId,
          runId
        } as RunFinishedEvent)
        return
      }

      // ===== 追踪：LLM 请求开始 =====
      if (traceId) {
        this.tracer?.addEvent(traceId, {
          type: 'llm_request',
          data: {
            userText,
            model: input.model,
            temperature: input.temperature,
          },
          status: 'pending',
        })
      }

      await threadSession.session.prompt(userText)

      if (lastAssistantError) {
        if (traceId) {
          this.tracer?.addEvent(traceId, {
            type: 'llm_response',
            data: { error: lastAssistantError },
            status: 'failed',
          })
          this.tracer?.finishTrace(traceId, 'failed')
        }
        throw new Error(`LLM 调用失败: ${lastAssistantError}`)
      }

      // 正常完成：先关闭文本消息，再发射 RUN_FINISHED
      streamEmitter.finishTextMessage()

      const completeText = streamEmitter.getCompleteAssistantText()
      this.eventBus?.emit('devlog:entry', {
        level: 'info',
        message: `Run 完成: threadId=${threadId}, runId=${runId}`,
        source: 'agent',
      })

      if (traceId) {
        this.tracer?.addEvent(traceId, {
          type: 'assistant_message',
          data: { content: completeText },
          status: 'completed',
        })
        this.tracer?.finishTrace(traceId, 'completed')
      }

      emitTermination({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        ...(completeText ? { result: completeText } : {})
      } as RunFinishedEvent)
    } catch (error) {
      // abort 视为正常终止，发射 RUN_FINISHED 而非 RUN_ERROR
      if (runOptions.signal?.aborted) {
        this.eventBus?.emit('devlog:entry', {
          level: 'info',
          message: `Run 已中断: threadId=${threadId}, runId=${runId}`,
          source: 'agent',
        })
        emitTermination({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          reason: 'aborted'
        } as RunFinishedEvent)
        return
      }

      const message = error instanceof Error ? error.message : '未知 AG-UI 运行错误'
      this.eventBus?.emit('devlog:entry', {
        level: 'error',
        message: `Run 错误: threadId=${threadId}, runId=${runId}, error=${message}`,
        source: 'agent',
      })
      this.eventBus?.emit('notification:push', {
        level: 'error',
        title: 'Agent 运行错误',
        message,
        category: 'agent',
        threadId,
      })
      emitTermination({
        type: EventType.RUN_ERROR,
        message
      } as RunErrorEvent)
    } finally {
      // 清理资源顺序：移除 abort 监听 → 取消订阅 → 清理 pendingToolCalls → 释放 run 占用
      if (abortHandler && runOptions.signal) {
        runOptions.signal.removeEventListener('abort', abortHandler)
      }
      if (unsubscribe) {
        unsubscribe()
      }
      if (threadSession) {
        threadSession.pendingToolCalls.clear()
        threadSession.lastRunId = runId
        threadSession.lastAccessedAt = Date.now()
      }
      this.sessionStore.releaseRun(threadId, runId)
    }
  }

  async steerThread(threadId: string, text: string): Promise<SteerResult> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)

    // 无活跃 run 时，steer 无意义，返回状态标识
    if (!this.sessionStore.hasActiveRun(threadId)) {
      return { status: 'no_active_run', threadId }
    }

    try {
      await threadSession.session.steer(text)
      threadSession.lastAccessedAt = Date.now()
      return { status: 'accepted', threadId }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'steer 失败'
      throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, `Steer 失败: ${message}`, 500)
    }
  }

  async followUpThread(threadId: string, text: string): Promise<SteerResult> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)

    try {
      await threadSession.session.followUp(text)
      threadSession.lastAccessedAt = Date.now()
      return { status: 'accepted', threadId }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'follow-up 失败'
      throw new AppError(ErrorCode.INTERNAL_SERVER_ERROR, `Follow-up 失败: ${message}`, 500)
    }
  }

  async forkThread(
    threadId: string,
    entryId: string
  ): Promise<{ selectedText: string; cancelled: boolean }> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const result = await threadSession.session.fork(entryId)
    threadSession.pendingToolCalls.clear()
    threadSession.lastAccessedAt = Date.now()
    return result
  }

  async navigateThread(
    threadId: string,
    targetId: string,
    options: { summarize?: boolean; customInstructions?: string } = {}
  ): Promise<Record<string, unknown>> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const result = await threadSession.session.navigateTree(targetId, {
      summarize: options.summarize ?? true,
      ...(options.customInstructions ? { customInstructions: options.customInstructions } : {})
    })
    threadSession.lastAccessedAt = Date.now()
    return isRecord(result) ? result : { result }
  }

  async compactThread(threadId: string, customInstructions?: string): Promise<unknown> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const startedAt = Date.now()
    this.eventBus?.emit('compaction:started', {
      threadId,
      reason: 'manual',
      startedAt,
    })
    this.eventBus?.emit('devlog:entry', {
      level: 'debug',
      message: `压缩开始: threadId=${threadId}`,
      source: 'compaction',
    })
    try {
      const result = await threadSession.session.compact(customInstructions)
      threadSession.lastAccessedAt = Date.now()
      const durationMs = Date.now() - startedAt
      this.eventBus?.emit('compaction:completed', {
        threadId,
        reason: 'manual',
        durationMs,
        result,
      })
      this.eventBus?.emit('devlog:entry', {
        level: 'info',
        message: `压缩完成: threadId=${threadId}, 耗时 ${durationMs}ms`,
        source: 'compaction',
      })
      this.eventBus?.emit('notification:push', {
        level: 'success',
        title: '上下文压缩完成',
        message: `耗时 ${durationMs}ms`,
        category: 'compaction',
        threadId,
      })
      return result
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.eventBus?.emit('compaction:failed', {
        threadId,
        reason: 'manual',
        error: errorMsg,
      })
      this.eventBus?.emit('devlog:entry', {
        level: 'error',
        message: `压缩失败: threadId=${threadId}, error=${errorMsg}`,
        source: 'compaction',
      })
      this.eventBus?.emit('notification:push', {
        level: 'error',
        title: '上下文压缩失败',
        message: errorMsg,
        category: 'compaction',
        threadId,
      })
      throw err
    }
  }

  async getThreadTree(threadId: string): Promise<unknown[]> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const tree = threadSession.session.sessionManager.getTree()
    threadSession.lastAccessedAt = Date.now()
    return tree
  }

  async getThreadModels(threadId: string): Promise<unknown[]> {
    // 只返回已配置 Provider 的模型（从 ProviderConfigStore 获取已注册的 Provider ID 列表）
    // 避免返回所有内置模型（如 openai、anthropic 等），那些需要用户配置 API Key 才可用
    void threadId // 保留参数以维持 API 兼容性
    const configuredProviders = this.providerConfigStore.list()
    if (configuredProviders.length === 0) {
      return []
    }
    const configuredProviderIds = new Set(configuredProviders.map((p) => p.id))
    const allModels = this.modelRegistry.getAll() as Array<{
      provider: string
      id: string
      name?: string
      contextWindow?: number
      maxTokens?: number
      reasoning?: boolean
      // SDK Model 字段，mapToSdkModel 已设置
      thinkingLevelMap?: Record<string, string | null>
      compat?: { thinkingFormat?: string }
      // ProviderConfigStore 上的业务字段（mapToSdkModel 未透传给 SDK），由 ProviderConfigStore 查表后合并
      supportedReasoningEfforts?: Array<'low' | 'medium' | 'high' | 'xhigh'>
      allowDisableThinking?: boolean
      defaultReasoningEffort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh'
    }>

    // 构造 provider → models 映射以便补充 ProviderConfigStore 上的业务字段
    const providerModelIndex = new Map<string, { supportedReasoningEfforts?: Array<'low'|'medium'|'high'|'xhigh'>; allowDisableThinking?: boolean; defaultReasoningEffort?: 'auto'|'low'|'medium'|'high'|'xhigh' }>()
    for (const p of configuredProviders) {
      for (const m of p.models) {
        providerModelIndex.set(`${p.id}:${m.id}`, {
          ...(m.supportedReasoningEfforts ? { supportedReasoningEfforts: m.supportedReasoningEfforts } : {}),
          ...(m.allowDisableThinking !== undefined ? { allowDisableThinking: m.allowDisableThinking } : {}),
          ...(m.defaultReasoningEffort !== undefined ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}),
        })
      }
    }

    // 从 SDK thinkingLevelMap 反推"supportedReasoningEfforts"（如果 ProviderConfigStore 未显式声明）：
    // - map 含 'off' 键 → allowDisableThinking=true
    // - 其他键（minimal/low/medium/high/xhigh）→ supportedReasoningEfforts 按键过滤
    const inferFromMap = (
      map: Record<string, string | null> | undefined,
    ): { supportedReasoningEfforts?: Array<'low'|'medium'|'high'|'xhigh'>; allowDisableThinking?: boolean } => {
      if (!map) return {}
      const levels: Array<'low'|'medium'|'high'|'xhigh'> = []
      if (map.low != null) levels.push('low')
      if (map.medium != null) levels.push('medium')
      if (map.high != null) levels.push('high')
      if (map.xhigh != null) levels.push('xhigh')
      return {
        ...(levels.length > 0 ? { supportedReasoningEfforts: levels } : {}),
        ...(map.off != null ? { allowDisableThinking: true } : {}),
      }
    }

    return allModels
      .filter((m) => configuredProviderIds.has(m.provider))
      .map((m) => {
        const override = providerModelIndex.get(`${m.provider}:${m.id}`) ?? {}
        const inferred = inferFromMap(m.thinkingLevelMap)
        const reasoning = m.reasoning ?? false
        // 已标记思考能力但未配置强度档位：给一组默认档位（低/中/高），
        // 避免"支持思考但选择器不出现"的割裂体验。
        // 用户在 Provider 设置里可随时覆盖为精确档位。
        const supportedReasoningEfforts =
          override.supportedReasoningEfforts ??
          inferred.supportedReasoningEfforts ??
          (reasoning ? (['low', 'medium', 'high'] as Array<'low'|'medium'|'high'|'xhigh'>) : undefined)
        return {
          provider: m.provider,
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning,
          ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
          ...(override.allowDisableThinking ?? inferred.allowDisableThinking
            ? { allowDisableThinking: override.allowDisableThinking ?? inferred.allowDisableThinking! }
            : {}),
          ...(override.defaultReasoningEffort ? { defaultReasoningEffort: override.defaultReasoningEffort } : {}),
        }
      })
  }

  /**
   * 读取指定 thread 的 thinkingLevel。
   * 返回 undefined 表示未设置（创建 PiSession 时走 SDK 全局默认）。
   */
  getThreadThinkingLevel(threadId: string): { level: string } | undefined {
    const level = this.threadSettingsStore.getThinkingLevel(threadId)
    return level ? { level } : undefined
  }

  /**
   * 设置指定 thread 的 thinkingLevel 并清掉 session 缓存，使下次请求按新 level 重建 Session。
   * 切换 thinkingLevel 不影响其他 thread 的 session。
   */
  setThreadThinkingLevel(threadId: string, level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): {
    threadId: string
    level: string
  } {
    this.threadSettingsStore.setThinkingLevel(threadId, level)
    // 思考强度作为 AgentSession 的初始化参数：必须在下次创建 Session 时生效
    this.sessionStore.clear()
    return { threadId, level }
  }

  async getThreadTools(threadId: string): Promise<{ tools: unknown[]; activeToolNames: string[] }> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    const tools = threadSession.session.getAllTools?.() ?? threadSession.session.tools ?? []
    const activeToolNames = threadSession.session.getActiveToolNames?.() ?? []
    threadSession.lastAccessedAt = Date.now()
    return { tools, activeToolNames }
  }

  async setThreadActiveTools(threadId: string, toolNames: string[]): Promise<string[]> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    if (threadSession.session.setActiveToolsByName) {
      threadSession.session.setActiveToolsByName(toolNames)
    }
    threadSession.lastAccessedAt = Date.now()
    return toolNames
  }

  async reloadThread(threadId: string): Promise<void> {
    const threadSession = await this.sessionStore.getOrCreate(threadId)
    await threadSession.session.reload()
    threadSession.lastAccessedAt = Date.now()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
