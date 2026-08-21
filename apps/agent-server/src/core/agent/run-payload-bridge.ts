/**
 * Run payload 桥（方案 §10.12-5）
 *
 * ## 问题
 *
 * 旧实现在每次 `streamRun()` 里保存 `prevOnPayload` 后重新赋值 `agent.onPayload`，
 * finally 不恢复。多轮运行会叠成 wrapper 链：上一轮的 `temperature`、`max_tokens`
 * 或 `strip_stream_options` 逻辑继续参与下一轮，最底层还可能是 Pi 的 Extension
 * provider-payload bridge。第二次 run 即使不传 temperature，也会带上第一次的值。
 *
 * ## 做法
 *
 * 每个 session 只安装一次组合桥（用 Symbol 标记，幂等）。桥先调用捕获到的 Pi 原
 * `onPayload`，再应用「当前 run」的产品参数。run 开始时在 lease 下 `setRunOptions()`，
 * finally `clearRunOptions()`；没有活跃 run 时桥只透传原 payload。
 *
 * @module core/agent/run-payload-bridge
 */

/** 本次 run 需要注入 provider payload 的产品参数 */
export interface RunPayloadOptions {
  /** 直接合并进 payload 顶层的字段（temperature / max_tokens 等） */
  inject?: Record<string, unknown>
  /** 是否移除 stream_options（部分 OpenAI 兼容中转不接受该字段） */
  stripStreamOptions?: boolean
}

/** 被安装了桥的 Pi Agent 的最小结构 */
interface PayloadAgent {
  onPayload?: (payload: unknown, ...rest: unknown[]) => unknown | Promise<unknown>
  [INSTALLED]?: RunPayloadBridge
}

interface PayloadSession {
  agent?: PayloadAgent
}

const INSTALLED = Symbol('pi-agent.runPayloadBridge')

/**
 * 单个 session 的 payload 桥句柄。
 *
 * `current` 是本次 run 的参数；桥读它而不是闭包捕获，因此 run 之间不会叠加。
 */
export class RunPayloadBridge {
  private current: RunPayloadOptions | null = null

  constructor(private readonly onLog?: (event: Record<string, unknown>) => void) {}

  /** 设置本次 run 的 payload 参数（应在持有 run lease 后调用） */
  setRunOptions(options: RunPayloadOptions | null): void {
    // 空 inject 且不 strip 等于"本次 run 不改写 payload"，直接视为无参数，
    // 避免桥在没有实际改写时仍走一遍 spread。
    const hasInject = options?.inject !== undefined && Object.keys(options.inject).length > 0
    const hasStrip = options?.stripStreamOptions === true
    this.current = options && (hasInject || hasStrip) ? options : null
  }

  /** 清除本次 run 的 payload 参数（run 的 finally 中调用） */
  clearRunOptions(): void {
    this.current = null
  }

  /** 当前是否有生效的 run 参数（诊断/测试用） */
  hasRunOptions(): boolean {
    return this.current !== null
  }

  /** 对 Pi 原 payload 结果应用当前 run 的参数 */
  apply(payload: unknown): unknown {
    const options = this.current
    if (!options) return payload
    let next = payload
    if (options.inject && Object.keys(options.inject).length > 0) {
      next = { ...(next as Record<string, unknown>), ...options.inject }
    }
    if (options.stripStreamOptions) {
      const record = next as Record<string, unknown>
      if (record && typeof record === 'object' && 'stream_options' in record) {
        const { stream_options: _removed, ...rest } = record
        this.onLog?.({ event: 'strip_stream_options' })
        next = rest
      }
    }
    return next
  }
}

/**
 * 在 session 上安装（或复用）payload 桥。
 *
 * 幂等：同一 session 多次调用返回同一个 bridge，`agent.onPayload` 只被包一层。
 *
 * @returns bridge 句柄；session 没有 agent 时返回 null
 */
export function installRunPayloadBridge(
  session: unknown,
  onLog?: (event: Record<string, unknown>) => void
): RunPayloadBridge | null {
  const agent = (session as PayloadSession | undefined)?.agent
  if (!agent) return null

  const existing = agent[INSTALLED]
  if (existing) return existing

  const bridge = new RunPayloadBridge(onLog)
  // 捕获 Pi SDK 已安装的回调（含 Extension provider-payload bridge）。
  // 必须 await：SDK 默认 onPayload 是 async，直接 spread Promise 会丢掉 messages。
  const nativeOnPayload = agent.onPayload
  agent.onPayload = async (payload: unknown, ...rest: unknown[]) => {
    const base = nativeOnPayload ? await nativeOnPayload.call(agent, payload, ...rest) : payload
    return bridge.apply(base)
  }
  agent[INSTALLED] = bridge
  return bridge
}
