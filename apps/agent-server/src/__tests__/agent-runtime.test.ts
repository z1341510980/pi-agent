/**
 * AgentRuntime 抽象（§9.3）测试：
 * - 注册表 register/get/listKinds 与重复注册报错；
 * - PiSessionAgentRuntime 把会话创建委托给工厂；
 * - PluginManager.createSession 按 options.runtime 路由第三方运行时，
 *   未注册的 kind 显式抛错，默认 'pi-session' 走内联路径。
 */
import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '@repo/shared/events'
import {
  AgentRuntimeRegistry,
  PiSessionAgentRuntime,
  DEFAULT_AGENT_RUNTIME_KIND,
} from '../core/agent/agent-runtime.js'
import { PluginManager } from '../core/plugin/plugin-manager.js'
import type { Plugin, PluginContext, PluginSessionHandle, PluginSessionOptions } from '../core/plugin/plugin-types.js'

const silentLogger = (() => {
  const noop = () => {}
  const logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => logger } as never
  return logger
})()

function createMockDb() {
  return {
    prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
    exec: () => undefined,
    transaction: (fn: () => unknown) => fn,
  } as unknown as import('better-sqlite3').Database
}

/** 装载测试插件并返回其捕获的 context.createSession。 */
async function loadAndCapture(
  registry: AgentRuntimeRegistry | undefined,
): Promise<PluginContext['createSession']> {
  let capturedCreate: PluginContext['createSession'] | undefined
  const plugin: Plugin = {
    manifest: { name: `runtime-probe-${Math.random().toString(36).slice(2, 8)}`, version: '1.0.0' },
    async setup(ctx) {
      capturedCreate = ctx.createSession
    },
  }
  const manager = new PluginManager(
    silentLogger,
    new EventBus(),
    createMockDb(),
    process.cwd(),
    process.cwd(),
    {
      builtinPlugins: [{ plugin }],
      ...(registry ? { runtimeRegistry: registry } : {}),
    },
  )
  await manager.init()
  await manager.start()
  expect(capturedCreate).toBeDefined()
  return capturedCreate!
}

describe('AgentRuntimeRegistry', () => {
  it('register/get/listKinds，重复注册抛错', () => {
    const registry = new AgentRuntimeRegistry()
    expect(registry.get('pi-session')).toBeUndefined()

    const fake = { kind: 'fake', createSession: async () => ({}) as PluginSessionHandle }
    registry.register(fake)
    expect(registry.get('fake')).toBe(fake)
    expect(registry.listKinds()).toEqual(['fake'])
    expect(() => registry.register(fake)).toThrow('重复注册')
  })

  it('PiSessionAgentRuntime 把创建委托给工厂', async () => {
    const handle = { prompt: async () => 'ok' } as unknown as PluginSessionHandle
    const factory = vi.fn(async (_options: PluginSessionOptions) => handle)
    const runtime = new PiSessionAgentRuntime(factory)
    expect(runtime.kind).toBe(DEFAULT_AGENT_RUNTIME_KIND)

    const options = { systemPrompt: 'sys', userMessage: 'hi' }
    await expect(runtime.createSession(options)).resolves.toBe(handle)
    expect(factory).toHaveBeenCalledWith(options)
  })
})

describe('PluginManager AgentRuntime 路由', () => {
  it('options.runtime 路由到已注册的第三方运行时', async () => {
    const registry = new AgentRuntimeRegistry()
    const fakeHandle = { prompt: async () => 'fake-result' } as unknown as PluginSessionHandle
    const fakeCreate = vi.fn(async () => fakeHandle)
    registry.register({ kind: 'fake-runtime', createSession: fakeCreate })

    const createSession = await loadAndCapture(registry)
    const options = { systemPrompt: 's', userMessage: 'u', runtime: 'fake-runtime' } as PluginSessionOptions
    await expect(createSession(options)).resolves.toBe(fakeHandle)
    expect(fakeCreate).toHaveBeenCalledWith(options)
  })

  it('未注册的 runtime kind 显式抛错', async () => {
    const createSession = await loadAndCapture(undefined)
    await expect(
      createSession({ systemPrompt: 's', userMessage: 'u', runtime: 'no-such-runtime' } as PluginSessionOptions),
    ).rejects.toThrow('未注册的 AgentRuntime: no-such-runtime')
  })

  it('默认 pi-session 走内联路径：未注入 SessionStore 时报既有错误', async () => {
    const createSession = await loadAndCapture(undefined)
    await expect(
      createSession({ systemPrompt: 's', userMessage: 'u' } as PluginSessionOptions),
    ).rejects.toThrow('SessionStore 未注入')
  })
})
