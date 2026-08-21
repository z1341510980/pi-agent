/**
 * Run payload 桥测试（方案 §10.12-5）
 *
 * 核心回归：连续两次带不同 temperature / max_tokens 的 run 不叠加 onPayload wrapper，
 * 第二次 payload 不含第一次的参数。
 */
import { describe, expect, it, vi } from 'vitest'
import { installRunPayloadBridge } from '../core/agent/run-payload-bridge.js'

interface FakeAgent {
  onPayload?: (payload: unknown, ...rest: unknown[]) => unknown | Promise<unknown>
}

function createSession(nativeOnPayload?: FakeAgent['onPayload']) {
  const agent: FakeAgent = { onPayload: nativeOnPayload }
  return { session: { agent }, agent }
}

const basePayload = (): Record<string, unknown> => ({ messages: [{ role: 'user' }] })

describe('installRunPayloadBridge', () => {
  it('session 没有 agent 时返回 null', () => {
    expect(installRunPayloadBridge({})).toBeNull()
    expect(installRunPayloadBridge(undefined)).toBeNull()
  })

  it('保留 Pi 原生 onPayload 的结果并 await', async () => {
    const native = vi.fn(async (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      fromNative: true,
    }))
    const { session, agent } = createSession(native)
    const bridge = installRunPayloadBridge(session)!
    bridge.setRunOptions({ inject: { temperature: 0.2 } })

    const result = (await agent.onPayload!(basePayload())) as Record<string, unknown>
    expect(native).toHaveBeenCalledTimes(1)
    // messages 必须保留：await 缺失会让 spread Promise 丢字段，网关会报 400
    expect(result.messages).toEqual([{ role: 'user' }])
    expect(result.fromNative).toBe(true)
    expect(result.temperature).toBe(0.2)
  })

  it('多次安装幂等：只包一层，返回同一个 bridge', () => {
    const { session, agent } = createSession(async (payload) => payload)
    const first = installRunPayloadBridge(session)
    const wrapped = agent.onPayload
    const second = installRunPayloadBridge(session)
    expect(second).toBe(first)
    expect(agent.onPayload).toBe(wrapped)
  })

  it('无活跃 run 参数时只透传原 payload', async () => {
    const { session, agent } = createSession(async (payload) => payload)
    installRunPayloadBridge(session)
    const result = await agent.onPayload!({ ...basePayload(), stream_options: { x: 1 } })
    expect(result).toEqual({ messages: [{ role: 'user' }], stream_options: { x: 1 } })
  })

  it('连续两次不同参数的 run 不叠加：第二次不含第一次的 temperature', async () => {
    const { session, agent } = createSession(async (payload) => payload)

    // 第一次 run：由 pi-agui-agent 安装桥并设置参数
    const first = installRunPayloadBridge(session)!
    first.setRunOptions({ inject: { temperature: 0.9, max_tokens: 1000 } })
    const firstPayload = (await agent.onPayload!(basePayload())) as Record<string, unknown>
    expect(firstPayload.temperature).toBe(0.9)
    expect(firstPayload.max_tokens).toBe(1000)
    first.clearRunOptions()

    // 第二次 run：同一 session 复用桥，只设置 max_tokens
    const second = installRunPayloadBridge(session)!
    expect(second).toBe(first)
    second.setRunOptions({ inject: { max_tokens: 2000 } })
    const secondPayload = (await agent.onPayload!(basePayload())) as Record<string, unknown>
    expect(secondPayload.max_tokens).toBe(2000)
    expect(secondPayload).not.toHaveProperty('temperature')
    second.clearRunOptions()
  })

  it('clearRunOptions 后 payload 回到原样', async () => {
    const { session, agent } = createSession(async (payload) => payload)
    const bridge = installRunPayloadBridge(session)!
    bridge.setRunOptions({ inject: { temperature: 0.5 } })
    bridge.clearRunOptions()
    expect(bridge.hasRunOptions()).toBe(false)
    const result = (await agent.onPayload!(basePayload())) as Record<string, unknown>
    expect(result).not.toHaveProperty('temperature')
  })

  it('stripStreamOptions 只在本次 run 生效', async () => {
    const { session, agent } = createSession(async (payload) => payload)
    const bridge = installRunPayloadBridge(session)!

    bridge.setRunOptions({ stripStreamOptions: true })
    const stripped = (await agent.onPayload!({
      ...basePayload(),
      stream_options: { include_usage: true },
    })) as Record<string, unknown>
    expect(stripped).not.toHaveProperty('stream_options')
    bridge.clearRunOptions()

    bridge.setRunOptions({ inject: { temperature: 0.1 } })
    const kept = (await agent.onPayload!({
      ...basePayload(),
      stream_options: { include_usage: true },
    })) as Record<string, unknown>
    expect(kept.stream_options).toEqual({ include_usage: true })
  })

  it('空 inject 且不 strip 时视为无参数，不改写 payload', async () => {
    const { session, agent } = createSession(async (payload) => payload)
    const bridge = installRunPayloadBridge(session)!
    bridge.setRunOptions({ inject: {}, stripStreamOptions: false })
    expect(bridge.hasRunOptions()).toBe(false)
    const result = await agent.onPayload!(basePayload())
    expect(result).toEqual(basePayload())
  })

  it('没有 Pi 原生 onPayload 时也能工作', async () => {
    const { session, agent } = createSession(undefined)
    const bridge = installRunPayloadBridge(session)!
    bridge.setRunOptions({ inject: { temperature: 0.3 } })
    const result = (await agent.onPayload!(basePayload())) as Record<string, unknown>
    expect(result.temperature).toBe(0.3)
    expect(result.messages).toEqual([{ role: 'user' }])
  })

  it('原生回调收到 payload 之外的其余参数（如 model）', async () => {
    const native = vi.fn(async (payload: unknown) => payload)
    const { session, agent } = createSession(native)
    installRunPayloadBridge(session)
    await agent.onPayload!(basePayload(), { provider: 'openai' })
    expect(native).toHaveBeenCalledWith(basePayload(), { provider: 'openai' })
  })
})
