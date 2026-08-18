/**
 * pi-subagents 服务端扩展宿主（§9.3.5：能力级接入，非 CLI）
 *
 * pi-subagents 0.49.0 的扩展工厂只依赖 ExtensionAPI 的一个子集，且全链路
 * 带 `hasUI=false` 无头分支。本模块用最小宿主桩承载它：
 *
 * - events：复用 @repo/shared/events 的 EventBus（桥接注册在 events.on 上）；
 * - registerTool / registerMessageRenderer / registerCommand / registerShortcut：
 *   收集器（无头模式不渲染，仅保留工具定义供可选注入）；
 * - on(event, handler)：生命周期事件注册表，宿主在 bindSession/dispose 时触发；
 * - 其余 API（sendMessage / exec / setModel / fs 兼容等）由 Proxy 兜底为安全 no-op。
 *
 * 委托协议（§9.3.5）：
 *   宿主 emit SUBAGENT_DELEGATION_REQUEST_EVENT → 扩展桥接校验/绑定上下文 →
 *   emit STARTED/UPDATE/RESPONSE。未绑定会话上下文时，有效请求得到确定性的
 *   `unavailable_context`；非法请求得到 `invalid_request` —— 均为无 LLM 的
 *   确定性协议闭环。绑定上下文后，扩展会派生 pi CLI 子进程真正执行子 Agent
 *   （PI_SUBAGENT_PI_BINARY 可覆盖），属于生产接线步骤。
 *
 * 边界：扩展假设单一交互会话（CLI 出身），多线程并发绑定时以最近绑定为准；
 * 小说工作流不依赖本宿主，AgentManager 自持子 Agent 生命周期。
 */

import type { EventBus } from '@repo/shared/events'
import * as nodeFs from 'node:fs'
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'node:timers'
// 编译期走 src/types/pi-subagents-shim.d.ts 垫片（tsconfig.json paths 映射，
// 避免真实包 TS 源码树进入类型程序）；运行时由 tsx 用 tsconfig.tsx.json
// （无 paths 映射）直接加载真实包，vitest 同理不应用 paths。
import registerSubagentExtension from 'pi-subagents'
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
  type SubagentDelegationStarted,
  type SubagentDelegationUpdate,
} from 'pi-subagents/delegation'

export interface PiSubagentsHostOptions {
  cwd: string
  eventBus: EventBus
  /** 会话身份桩（bindSession 时提供；未提供则无法绑定上下文） */
  sessionProvider?: (threadId: string) => {
    sessionId: string
    sessionFile: string | null
    entries: unknown[]
  }
}

export interface DelegationOutcome {
  started?: SubagentDelegationStarted
  updates: SubagentDelegationUpdate[]
  response: SubagentDelegationResponse
}

const DEFAULT_DELEGATION_TIMEOUT_MS = 30_000

export class PiSubagentsHost {
  private readonly api: Record<string, unknown>
  private readonly lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => void | Promise<void>>>()
  private readonly tools = new Map<string, unknown>()
  private loaded = false
  private disposed = false

  constructor(private readonly options: PiSubagentsHostOptions) {
    const host = this
    const noop = (): void => {}
    const noopAsync = async (): Promise<void> => {}
    const events = options.eventBus
    const base: Record<string, unknown> = {
      events,
      on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => {
        const list = host.lifecycleHandlers.get(event) ?? []
        list.push(handler)
        host.lifecycleHandlers.set(event, list)
      },
      registerTool: (tool: unknown) => {
        host.tools.set((tool as { name?: string })?.name ?? '', tool)
      },
      registerMessageRenderer: () => {},
      registerCommand: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      sendMessage: noop,
      sendUserMessage: noop,
      appendEntry: noop,
      setSessionName: noop,
      getSessionName: () => undefined,
      setLabel: noop,
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: noop,
      refreshTools: noop,
      getCommands: () => [],
      setModel: noopAsync,
      getThinkingLevel: () => 'medium',
      setThinkingLevel: noop,
      exec: async () => ({ code: 1, stdout: '', stderr: 'exec unavailable in headless host' }),
      registerProvider: noop,
      registerNativeProvider: noop,
      unregisterProvider: noop,
      // node 兼容垫片：扩展的 watchdog/文件扫描路径按真实实现工作
      setTimeout: nodeSetTimeout,
      clearTimeout: nodeClearTimeout,
      existsSync: nodeFs.existsSync,
      readFileSync: nodeFs.readFileSync,
      readdirSync: nodeFs.readdirSync,
      mkdirSync: nodeFs.mkdirSync,
      statSync: nodeFs.statSync,
      unlinkSync: nodeFs.unlinkSync,
      realpathSync: nodeFs.realpathSync,
      watch: nodeFs.watch,
    }
    // Proxy 兜底：扩展若触碰未建模的 API 面，函数返回 noop，其余返回 undefined
    this.api = new Proxy(base, {
      get(target, prop) {
        if (typeof prop === 'string' && prop in target) return target[prop]
        return noop
      },
      set(target, prop, value) {
        target[String(prop)] = value
        return true
      },
    })
  }

  /** 加载 pi-subagents 扩展工厂（幂等）。 */
  async start(): Promise<void> {
    if (this.loaded) return
    // 扩展默认导出即工厂函数；无头宿主传入最小 ExtensionAPI。
    await registerSubagentExtension(this.api)
    this.loaded = true
  }

  /** 扩展是否注册了 subagent 工具（能力就绪探针）。 */
  hasSubagentTool(): boolean {
    return this.tools.has('subagent')
  }

  /** 列出扩展注册的工具名。 */
  listToolNames(): string[] {
    return Array.from(this.tools.keys()).filter(Boolean)
  }

  /**
   * 绑定会话上下文（触发 session_start 生命周期）。
   * 之后有效委托请求将进入真实子 Agent 执行路径（派生 pi CLI 子进程）。
   */
  async bindSession(threadId: string): Promise<void> {
    const session = this.options.sessionProvider?.(threadId)
    if (!session) throw new Error(`pi-subagents host：未提供 sessionProvider，无法绑定会话 ${threadId}`)
    const ctx = this.buildHeadlessContext(session.sessionId, session.sessionFile, session.entries)
    await this.emitLifecycle('session_start', { reason: 'startup' }, ctx)
  }

  /**
   * 发起一次结构化委托（事件协议闭环）。
   * 未绑定上下文时：有效请求 → unavailable_context；非法请求 → invalid_request。
   */
  delegate(request: SubagentDelegationRequest, timeoutMs = DEFAULT_DELEGATION_TIMEOUT_MS): Promise<DelegationOutcome> {
    const { eventBus } = this.options
    const outcome: DelegationOutcome = {
      updates: [],
      response: {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: 'failed',
        error: 'timeout',
      },
    }
    return new Promise<DelegationOutcome>((resolve, reject) => {
      const onStarted = (payload: unknown): void => {
        const started = payload as SubagentDelegationStarted
        if (started.requestId === request.requestId) outcome.started = started
      }
      const onUpdate = (payload: unknown): void => {
        const update = payload as SubagentDelegationUpdate
        if (update.requestId === request.requestId) outcome.updates.push(update)
      }
      const onResponse = (payload: unknown): void => {
        const response = payload as SubagentDelegationResponse
        if (response.requestId !== request.requestId) return
        outcome.response = response
        cleanup()
        resolve(outcome)
      }
      const cleanup = () => {
        clearTimeout(timer)
        eventBus.off(SUBAGENT_DELEGATION_STARTED_EVENT, onStarted)
        eventBus.off(SUBAGENT_DELEGATION_UPDATE_EVENT, onUpdate)
        eventBus.off(SUBAGENT_DELEGATION_RESPONSE_EVENT, onResponse)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`pi-subagents 委托超时（${timeoutMs}ms，无终态响应）`))
      }, timeoutMs)
      eventBus.on(SUBAGENT_DELEGATION_STARTED_EVENT, onStarted)
      eventBus.on(SUBAGENT_DELEGATION_UPDATE_EVENT, onUpdate)
      eventBus.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, onResponse)
      eventBus.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request)
    })
  }

  /** 取消指定 requestId 的委托。 */
  cancel(requestId: string): void {
    this.options.eventBus.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId })
  }

  /** 触发 session_shutdown 并停止宿主（幂等）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.emitLifecycle('session_shutdown', {}, undefined)
    } catch {
      // 扩展清理失败不阻塞宿主关闭
    }
    this.lifecycleHandlers.clear()
    this.tools.clear()
  }

  private async emitLifecycle(event: string, payload: unknown, ctx: unknown): Promise<void> {
    const handlers = this.lifecycleHandlers.get(event) ?? []
    for (const handler of handlers) {
      await handler(payload, ctx)
    }
  }

  /** 无头 ExtensionContext 桩（hasUI=false 全链路线） */
  private buildHeadlessContext(
    sessionId: string,
    sessionFile: string | null,
    entries: unknown[],
  ): Record<string, unknown> {
    const noop = (): void => {}
    const ui = new Proxy({}, {
      get: () => noop,
      set: (target, prop, value) => {
        ;(target as Record<string, unknown>)[prop as string] = value
        return true
      },
    })
    return {
      mode: 'rpc',
      hasUI: false,
      cwd: this.options.cwd,
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getEntries: () => entries,
      },
      modelRegistry: {
        find: () => undefined,
        getAll: () => [],
        getAvailable: () => [],
      },
      model: undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: noop,
      hasPendingMessages: () => false,
      getContextUsage: () => null,
      compact: noop,
      getSystemPrompt: () => '',
      getSystemPromptOptions: () => ({}),
      ui,
      shutdown: noop,
      waitForIdle: async () => {},
    }
  }
}
