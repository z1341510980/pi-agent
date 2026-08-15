/**
 * AgentRuntime 抽象（方案 §9.3）
 *
 * 把「插件会话的运行时」从 PluginManager 内部实现中抽象出来，为接入第三方
 * 运行时（pi-subagents 子 Agent 生命周期 / pi-actors 长任务 Run 内核）留出
 * 统一适配层：
 *
 * - AgentRuntime：一个运行时 = 能按 PluginSessionOptions 创建会话句柄；
 * - PluginSessionOptions.runtime：本次会话选择哪个运行时（默认 'pi-session'）；
 * - AgentRuntimeRegistry：运行时注册表，未注册的 kind 在 createSession 时显式抛错。
 *
 * 当前唯一实现是 PiSessionAgentRuntime（直连 Pi SDK，即原有路径）。
 * pi-subagents / pi-actors 适配器在引入对应依赖包后注册为新的 kind，
 * 无需改动 NovelOrchestrator / TeamDiscussionEngine 等编排层。
 *
 * 注意：PluginSessionHandle 的 prompt()/promptStream() 语义（发送创建时指定的
 * userMessage，含 /skill: 展开与多 Skill 组合）由句柄自身保证，运行时适配器
 * 只需忠实返回句柄，因此接口刻意保持最小。
 */

import type { PluginSessionHandle, PluginSessionOptions } from '../plugin/plugin-types.js'

/** 默认运行时：直连 Pi SDK（原有 createSession 路径）。 */
export const DEFAULT_AGENT_RUNTIME_KIND = 'pi-session'

export interface AgentRuntime {
  /** 运行时标识（PluginSessionOptions.runtime 引用） */
  readonly kind: string
  /** 按选项创建会话句柄；prompt() 语义由句柄自身决定 */
  createSession(options: PluginSessionOptions): Promise<PluginSessionHandle>
}

/** 运行时注册表：createSession 时按 kind 查找。 */
export class AgentRuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>()

  register(runtime: AgentRuntime): void {
    if (this.runtimes.has(runtime.kind)) {
      throw new Error(`AgentRuntime 重复注册: ${runtime.kind}`)
    }
    this.runtimes.set(runtime.kind, runtime)
  }

  get(kind: string): AgentRuntime | undefined {
    return this.runtimes.get(kind)
  }

  listKinds(): string[] {
    return Array.from(this.runtimes.keys()).sort()
  }
}

/** 直连 Pi SDK 的默认运行时：把会话创建委托给内部工厂。 */
export class PiSessionAgentRuntime implements AgentRuntime {
  readonly kind = DEFAULT_AGENT_RUNTIME_KIND

  constructor(
    private readonly factory: (options: PluginSessionOptions) => Promise<PluginSessionHandle>,
  ) {}

  createSession(options: PluginSessionOptions): Promise<PluginSessionHandle> {
    return this.factory(options)
  }
}
