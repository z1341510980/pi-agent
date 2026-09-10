import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { EventBus } from '@repo/shared/events'
import {
  buildPluginSessionPrompt,
  PluginManager,
  measurePayload
} from '../core/plugin/plugin-manager.js'
import { eventBusPlugin } from '../plugins/event-bus.plugin.js'
import { pluginLoaderPlugin } from '../plugins/plugin-loader.plugin.js'
import { createHelloPlugin } from '../plugins/examples/hello-plugin/index.js'
import type { Plugin, PluginContext } from '../core/plugin/plugin-types.js'

/** 创建一个最小化的 Fastify 日志器（用于 PluginManager 单元测试） */
function createSilentLogger() {
  const noop = () => {}
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
    level: 'silent'
  } as unknown as FastifyInstance['log']
  return logger
}

/** 创建一个最小化的 mock db（测试插件不使用迁移功能，无需真实数据库） */
function createMockDb() {
  return {
    prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
    exec: () => undefined,
    transaction: (fn: () => unknown) => fn
  } as unknown as import('better-sqlite3').Database
}

/** 创建一个测试插件 */
function createTestPlugin(options: {
  name: string
  version?: string
  setupFn?: (ctx: PluginContext) => void | Promise<void>
  teardownFn?: () => void | Promise<void>
  shouldFail?: boolean
}): Plugin {
  return {
    manifest: {
      name: options.name,
      version: options.version ?? '1.0.0',
      description: `测试插件 ${options.name}`
    },
    async setup(ctx) {
      if (options.shouldFail) {
        throw new Error(`插件 ${options.name} setup 失败`)
      }
      if (options.setupFn) {
        await options.setupFn(ctx)
      }
    },
    teardown: options.teardownFn
  }
}

describe('PluginManager', () => {
  it('buildPluginSessionPrompt 显式展开授权 Skill 并保留原任务', () => {
    const prompt = buildPluginSessionPrompt('请验收第 3 章', {
      name: 'novel-reviewer',
      path: 'D:/skills/novel-reviewer/SKILL.md'
    })
    expect(prompt).toBe('/skill:novel-reviewer 请验收第 3 章')
    expect(
      buildPluginSessionPrompt('请规划第 4 章叙事任务', {
        name: 'novel-director',
        path: 'D:/skills/novel-director/SKILL.md'
      })
    ).toBe('/skill:novel-director 请规划第 4 章叙事任务')
    expect(buildPluginSessionPrompt('普通任务')).toBe('普通任务')
  })

  it('measurePayload counts a top-level provider system prompt', () => {
    const payload = {
      system: 'system text',
      messages: [{ role: 'user', content: 'hello' }],
      tools: []
    }
    const stats = measurePayload(payload)
    expect(stats.messagesChars).toBe(
      JSON.stringify(payload.system).length + JSON.stringify(payload.messages).length
    )
    expect(stats.totalChars).toBe(JSON.stringify(payload).length)
  })

  it('rejects an explicitly selected model that is not registered instead of using the default model', async () => {
    let context: PluginContext | undefined
    const session = {
      subscribe: vi.fn(() => () => undefined),
      setModel: vi.fn()
    }
    manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
      builtinPlugins: [
        {
          plugin: createTestPlugin({
            name: 'model-selection-test',
            setupFn: (pluginContext) => {
              context = pluginContext
            }
          })
        }
      ]
    })
    manager.setSessionStore({ getOrCreate: vi.fn().mockResolvedValue({ session }) } as any)
    manager.setModelRegistry({ find: vi.fn(() => undefined) })
    await manager.init()
    await manager.start()

    await expect(
      context!.createSession({
        systemPrompt: 'system',
        userMessage: 'user',
        modelId: { provider: 'missing-provider', modelId: 'missing-model' }
      })
    ).rejects.toThrow('未找到所选模型：missing-provider/missing-model')
    expect(session.setModel).not.toHaveBeenCalled()
  })

  /**
   * 模拟 Pi AgentSession 的流式守卫：
   * prompt 生命周期内（含模拟的自动压缩收尾）再次 prompt 会抛
   * "Agent is already processing"。终态 message_end 先于 promise 落定到达，
   * 与真实 SDK 行为一致。
   */
  function createStreamingGuardSession() {
    const handlers = new Set<(event: Record<string, unknown>) => void>()
    let isStreaming = false
    let turn = 0
    const prompts: Array<string | undefined> = []
    const emit = (event: Record<string, unknown>): void => {
      for (const handler of handlers) handler(event)
    }
    return {
      prompts,
      session: {
        subscribe: (handler: (event: Record<string, unknown>) => void) => {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
        async prompt(text?: string): Promise<string> {
          prompts.push(text)
          if (isStreaming) {
            throw new Error(
              "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
            )
          }
          isStreaming = true
          turn += 1
          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: `turn-${turn}` }
          })
          emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
          // 关键：终态事件之后 prompt promise 仍延迟落定，模拟自动压缩等收尾
          await new Promise((resolve) => setTimeout(resolve, 25))
          isStreaming = false
          return `result-${turn}`
        }
      }
    }
  }

  it('serializes multi-turn prompt() calls so the second turn does not hit the Pi streaming guard', async () => {
    let context: PluginContext | undefined
    const fake = createStreamingGuardSession()
    manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
      builtinPlugins: [
        {
          plugin: createTestPlugin({
            name: 'multi-turn-session-test',
            setupFn: (pluginContext) => {
              context = pluginContext
            }
          })
        }
      ]
    })
    manager.setSessionStore({
      getOrCreate: vi.fn().mockResolvedValue({ session: fake.session })
    } as any)
    await manager.init()
    await manager.start()

    const handle = await context!.createSession({ systemPrompt: 'sys', userMessage: 'setup' })

    // 模拟同会话分包/修复轮：首轮之后继续追加用户消息连续多轮 prompt。
    // 回归背景：waitForFinalAssistantOrPrompt 在终态消息即返回，而上一轮
    // promptPromise 尚未落定，第二轮直接撞 Pi 的 "Agent is already processing"。
    const first = await handle.prompt('【第 1 段输入】')
    const second = await handle.prompt('【第 2 段输入】')
    const third = await handle.prompt('请给出最终结论。')

    // 句柄返回的是事件流累积的 assistant 文本（text_delta 拼接），不是 SDK 返回值
    expect(first).toBe('turn-1')
    expect(second).toBe('turn-2')
    expect(third).toBe('turn-3')
    expect(fake.prompts).toEqual([
      '【第 1 段输入】',
      '【第 2 段输入】',
      '请给出最终结论。'
    ])
    handle.dispose()
  })

  it('runs one protocol follow-up in the same session and does not repeat it', async () => {
    let context: PluginContext | undefined
    const fake = createStreamingGuardSession()
    manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
      builtinPlugins: [
        {
          plugin: createTestPlugin({
            name: 'protocol-follow-up-test',
            setupFn: (pluginContext) => {
              context = pluginContext
            },
          }),
        },
      ],
    })
    manager.setSessionStore({
      getOrCreate: vi.fn().mockResolvedValue({ session: fake.session }),
    } as any)
    await manager.init()
    await manager.start()

    const seen: string[] = []
    const handle = await context!.createSession({
      systemPrompt: 'sys',
      userMessage: 'setup',
      followUpPrompt: (raw) => {
        seen.push(raw)
        return raw === 'turn-1' ? '请通过工具提交结果。' : undefined
      },
    })

    const first = await handle.prompt('首轮')
    const second = await handle.prompt('普通后续')

    expect(seen).toEqual(['turn-1'])
    expect(first).toBe('turn-2')
    expect(second).toBe('turn-3')
    expect(fake.prompts).toEqual(['首轮', '请通过工具提交结果。', '普通后续'])
    handle.dispose()
  })

  /**
   * 模拟「终答成功之后维护往返失败」：Pi Session 在 stopReason='stop' 之后仍会
   * 继续 emit message_end（自动压缩等维护动作），实测出现过其中一次报
   * "A server error occurred"。旧实现无条件把它计入 lastErrorMessage，
   * 已写满的正文被判定为失败，整章 create-flow 作废。
   */
  function createPostSuccessErrorSession() {
    const handlers = new Set<(event: Record<string, unknown>) => void>()
    const emit = (event: Record<string, unknown>): void => {
      for (const handler of handlers) handler(event)
    }
    return {
      session: {
        subscribe: (handler: (event: Record<string, unknown>) => void) => {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
        async prompt(): Promise<string> {
          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: '完整正文' }
          })
          emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
          // 终答之后的维护往返失败
          emit({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'A server error occurred. Please try again.'
            }
          })
          return 'sdk-result'
        }
      }
    }
  }

  it('keeps the completed response when a post-success maintenance turn fails', async () => {
    let context: PluginContext | undefined
    const fake = createPostSuccessErrorSession()
    manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
      builtinPlugins: [
        {
          plugin: createTestPlugin({
            name: 'post-success-error-test',
            setupFn: (pluginContext) => {
              context = pluginContext
            }
          })
        }
      ]
    })
    manager.setSessionStore({
      getOrCreate: vi.fn().mockResolvedValue({ session: fake.session })
    } as any)
    await manager.init()
    await manager.start()

    const handle = await context!.createSession({ systemPrompt: 'sys', userMessage: 'write' })
    await expect(handle.prompt()).resolves.toBe('完整正文')
    handle.dispose()
  })

  it('still fails when the error arrives before any final assistant success', async () => {
    let context: PluginContext | undefined
    const handlers = new Set<(event: Record<string, unknown>) => void>()
    const session = {
      subscribe: (handler: (event: Record<string, unknown>) => void) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      async prompt(): Promise<string> {
        for (const handler of handlers) {
          handler({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'A server error occurred. Please try again.'
            }
          })
        }
        return ''
      }
    }
    manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
      builtinPlugins: [
        {
          plugin: createTestPlugin({
            name: 'pre-success-error-test',
            setupFn: (pluginContext) => {
              context = pluginContext
            }
          })
        }
      ]
    })
    manager.setSessionStore({
      getOrCreate: vi.fn().mockResolvedValue({ session })
    } as any)
    await manager.init()
    await manager.start()

    const handle = await context!.createSession({ systemPrompt: 'sys', userMessage: 'write' })
    await expect(handle.prompt()).rejects.toThrow('A server error occurred')
    handle.dispose()
  })

  let eventBus: EventBus
  let manager: PluginManager

  beforeEach(() => {
    eventBus = new EventBus()
    manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {})
  })

  describe('init / start / stop', () => {
    it('init 加载内置插件但不启动', async () => {
      const plugin = createTestPlugin({ name: 'test-1' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()

      const list = manager.list()
      expect(list).toHaveLength(1)
      expect(list[0].name).toBe('test-1')
      expect(list[0].status).toBe('loaded')
    })

    it('start 启用所有已加载插件', async () => {
      const setupFn = vi.fn()
      const plugin = createTestPlugin({ name: 'test-1', setupFn })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()

      expect(setupFn).toHaveBeenCalledOnce()
      const entry = manager.get('test-1')
      expect(entry?.status).toBe('enabled')
    })

    it('stop 停止所有已启用插件', async () => {
      const teardownFn = vi.fn()
      const plugin = createTestPlugin({ name: 'test-1', teardownFn })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()
      await manager.stop()

      expect(teardownFn).toHaveBeenCalledOnce()
      const entry = manager.get('test-1')
      expect(entry?.status).toBe('disabled')
    })

    it('重复 init 会被忽略', async () => {
      const plugin = createTestPlugin({ name: 'test-1' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.init() // 重复调用

      expect(manager.list()).toHaveLength(1)
    })
  })

  describe('错误隔离', () => {
    it('单个插件 setup 失败不影响其他插件', async () => {
      const okSetup = vi.fn()
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [
          { plugin: createTestPlugin({ name: 'ok-plugin', setupFn: okSetup }) },
          { plugin: createTestPlugin({ name: 'bad-plugin', shouldFail: true }) },
          { plugin: createTestPlugin({ name: 'ok-plugin-2', setupFn: okSetup }) }
        ]
      })

      await manager.init()
      await manager.start()

      // 失败的插件状态为 error
      const badEntry = manager.get('bad-plugin')
      expect(badEntry?.status).toBe('error')
      expect(badEntry?.error).toContain('setup 失败')

      // 其他插件正常启用
      expect(okSetup).toHaveBeenCalledTimes(2)
      expect(manager.get('ok-plugin')?.status).toBe('enabled')
      expect(manager.get('ok-plugin-2')?.status).toBe('enabled')
    })

    it('teardown 失败不影响 stop 流程', async () => {
      const plugin = createTestPlugin({
        name: 'test-1',
        teardownFn: () => {
          throw new Error('teardown 失败')
        }
      })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()
      // 不应抛出异常
      await manager.stop()

      expect(manager.get('test-1')?.status).toBe('disabled')
    })
  })

  describe('enable / disable', () => {
    it('enable 启用指定插件', async () => {
      const plugin = createTestPlugin({ name: 'test-1' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.enable('test-1')

      expect(manager.get('test-1')?.status).toBe('enabled')
    })

    it('disable 禁用指定插件', async () => {
      const plugin = createTestPlugin({ name: 'test-1' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()
      await manager.disable('test-1')

      expect(manager.get('test-1')?.status).toBe('disabled')
    })

    it('enable 不存在的插件抛出错误', async () => {
      await expect(manager.enable('nonexistent')).rejects.toThrow('插件不存在')
    })

    it('disable 不存在的插件抛出错误', async () => {
      await expect(manager.disable('nonexistent')).rejects.toThrow('插件不存在')
    })

    it('已启用的插件再次 enable 不报错', async () => {
      const plugin = createTestPlugin({ name: 'test-1' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()
      // 不应抛出异常
      await manager.enable('test-1')
      expect(manager.get('test-1')?.status).toBe('enabled')
    })
  })

  describe('desiredState 与实际状态分离（研究文档 §10.2）', () => {
    it('catalog 中 enabled: false 的插件仍可见，start 不 setup', async () => {
      let setupCalled = false
      const plugin = createTestPlugin({
        name: 'off-plugin',
        setupFn: () => {
          setupCalled = true
        }
      })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })
      manager.setCatalogConfigs([
        { catalogId: 'off-plugin', source: 'builtin', enabled: false }
      ])

      await manager.init()
      await manager.start()

      const entry = manager.get('off-plugin')
      // 可见：不是"未发现"
      expect(entry).toBeDefined()
      expect(entry?.desiredEnabled).toBe(false)
      expect(entry?.status).toBe('disabled')
      expect(setupCalled).toBe(false)
      expect(manager.list().map((item) => item.name)).toContain('off-plugin')
    })

    it('配置中被禁用的插件可以在运行期 enable 恢复', async () => {
      const plugin = createTestPlugin({ name: 'off-plugin' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })
      manager.setCatalogConfigs([
        { catalogId: 'off-plugin', source: 'builtin', enabled: false }
      ])

      await manager.init()
      await manager.start()
      await manager.enable('off-plugin')

      expect(manager.get('off-plugin')?.status).toBe('enabled')
      expect(manager.get('off-plugin')?.desiredEnabled).toBe(true)
    })

    it('disable 记录期望状态，即使插件当前不是 enabled', async () => {
      const plugin = createTestPlugin({ name: 'test-1' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      // 尚未 start：状态是 loaded
      await manager.disable('test-1')

      expect(manager.get('test-1')?.desiredEnabled).toBe(false)
    })
  })

  describe('依赖图（研究文档 §10.2）', () => {
    it('start 按依赖拓扑排序，依赖先于消费方 setup', async () => {
      const order: string[] = []
      const base = createTestPlugin({
        name: 'base',
        setupFn: () => {
          order.push('base')
        }
      })
      const consumer: Plugin = {
        manifest: { name: 'consumer', version: '1.0.0', dependencies: ['base'] },
        setup: () => {
          order.push('consumer')
        }
      }
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        // 故意把 consumer 放前面：排序必须由 dependencies 决定，不是声明顺序
        builtinPlugins: [{ plugin: consumer }, { plugin: base }]
      })

      await manager.init()
      await manager.start()

      expect(order).toEqual(['base', 'consumer'])
    })

    it('缺失依赖的插件不 setup，标记 error 并给出诊断', async () => {
      let setupCalled = false
      const consumer: Plugin = {
        manifest: { name: 'consumer', version: '1.0.0', dependencies: ['absent'] },
        setup: () => {
          setupCalled = true
        }
      }
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin: consumer }]
      })

      await manager.init()
      await manager.start()

      const entry = manager.get('consumer')
      expect(setupCalled).toBe(false)
      expect(entry?.status).toBe('error')
      expect(entry?.dependencyDiagnostics?.join(' ')).toContain('absent')
    })

    it('循环依赖被检出，两端都不 setup', async () => {
      const a: Plugin = {
        manifest: { name: 'a', version: '1.0.0', dependencies: ['b'] },
        setup: () => {}
      }
      const b: Plugin = {
        manifest: { name: 'b', version: '1.0.0', dependencies: ['a'] },
        setup: () => {}
      }
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin: a }, { plugin: b }]
      })

      await manager.init()
      await manager.start()

      expect(manager.get('a')?.status).toBe('error')
      expect(manager.get('b')?.status).toBe('error')
      expect(manager.get('a')?.dependencyDiagnostics?.join(' ')).toContain('循环依赖')
    })

    it('依赖不满足的插件被 enable 时明确拒绝', async () => {
      const consumer: Plugin = {
        manifest: { name: 'consumer', version: '1.0.0', dependencies: ['absent'] },
        setup: () => {}
      }
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin: consumer }]
      })

      await manager.init()
      await expect(manager.enable('consumer')).rejects.toThrow('依赖不满足')
    })

    it('健康插件不被同批次的坏插件牵连', async () => {
      const broken: Plugin = {
        manifest: { name: 'broken', version: '1.0.0', dependencies: ['absent'] },
        setup: () => {}
      }
      const healthy = createTestPlugin({ name: 'healthy' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin: broken }, { plugin: healthy }]
      })

      await manager.init()
      await manager.start()

      expect(manager.get('broken')?.status).toBe('error')
      expect(manager.get('healthy')?.status).toBe('enabled')
    })
  })

  describe('reload 预检（研究文档 §10.11）', () => {
    it('builtin reload 在 stop/delete 之前就被拒绝，插件仍在 catalog 中', async () => {
      let teardownCalled = false
      const plugin = createTestPlugin({
        name: 'builtin-1',
        teardownFn: () => {
          teardownCalled = true
        }
      })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()

      // 无源码入口的 builtin 依旧被拒绝，文案随热更新改造更新为"没有可重载的源码入口"
      await expect(manager.reload('builtin-1')).rejects.toThrow('没有可重载的源码入口')

      // 关键：拒绝不能是破坏性的 —— 条目仍在，状态未变，teardown 未被调用
      expect(manager.get('builtin-1')?.status).toBe('enabled')
      expect(teardownCalled).toBe(false)
      expect(manager.list().map((item) => item.name)).toContain('builtin-1')
    })

    it('reload 不存在的插件抛错', async () => {
      await expect(manager.reload('nonexistent')).rejects.toThrow('插件不存在')
    })
  })

  describe('插件能力注册', () => {
    it('插件可注册工具、路由、面板、事件监听', async () => {
      const eventHandler = vi.fn()
      const plugin: Plugin = {
        manifest: { name: 'full-plugin', version: '1.0.0' },
        async setup(ctx: PluginContext) {
          ctx.registerTool({
            name: 'full.tool',
            description: '测试工具',
            async execute() {
              return { ok: true, data: 'tool-result' }
            }
          })
          ctx.registerRoute({
            method: 'GET',
            path: '/test',
            async handler() {
              return { ok: true }
            }
          })
          ctx.registerPanel({
            id: 'full-panel',
            title: '测试面板',
            component: 'TestPanel'
          })
          ctx.onEvent('test:event', eventHandler)
        }
      }

      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()

      // 验证工具
      const tools = manager.getAllTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('full.tool')
      const result = await tools[0].execute({}, {})
      expect(result.data).toBe('tool-result')

      // 验证路由
      const routes = manager.getAllRoutes()
      expect(routes).toHaveLength(1)
      expect(routes[0].pluginName).toBe('full-plugin')
      expect(routes[0].route.method).toBe('GET')
      expect(routes[0].route.path).toBe('/test')

      // 验证面板
      const panels = manager.getAllPanels()
      expect(panels).toHaveLength(1)
      expect(panels[0].id).toBe('full-panel')

      // 验证事件监听
      eventBus.emit('test:event', { foo: 'bar' })
      expect(eventHandler).toHaveBeenCalledWith({ foo: 'bar' })
    })

    it('非 builtin 插件未获 capability 时不暴露 db/process/network', async () => {
      const manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '')
      const plugin = createTestPlugin({
        name: 'external-capability-test',
        setupFn: (ctx) => {
          expect(() => ctx.db.prepare('select 1')).toThrow('storage.plugin')
          expect(ctx.process).toBeUndefined()
          expect(ctx.network).toBeUndefined()
        }
      })
      await manager.loadPluginEntry(plugin, 'local')
      await manager.start()
      expect(manager.get('external-capability-test')?.status).toBe('enabled')
    })

    it('未获 agent.orchestrate / confirmation.request 时不暴露宿主管理器', async () => {
      const manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '')
      const plugin = createTestPlugin({
        name: 'external-manager-test',
        setupFn: (ctx) => {
          // 原始管理器与 process/network 采用同一"条件注入"约定：未授予即 undefined，
          // 而不是交出可直接操作宿主状态的引用。
          expect(ctx.subagentManager).toBeUndefined()
          expect(ctx.teamManager).toBeUndefined()
          expect(ctx.agentCallLogger).toBeUndefined()
          expect(ctx.confirmationManager).toBeUndefined()
        }
      })
      await manager.loadPluginEntry(plugin, 'local')
      await manager.start()
      expect(manager.get('external-manager-test')?.status).toBe('enabled')
    })

    it('textBridge 按 media.generate 授权条件注入并保持惰性求值', async () => {
      const contexts = new Map<string, PluginContext>()
      const manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '')
      // local 插件的 grants 只来自宿主 catalog：显式授予 media.generate
      manager.setCatalogConfigs([
        {
          catalogId: 'text-bridge-granted',
          source: 'builtin',
          enabled: true,
          grants: ['media.generate']
        }
      ])
      await manager.loadPluginEntry(
        createTestPlugin({
          name: 'text-bridge-granted',
          setupFn: (ctx) => {
            contexts.set('text-bridge-granted', ctx)
          }
        }),
        'local',
        undefined,
        undefined,
        undefined,
        'text-bridge-granted'
      )
      await manager.loadPluginEntry(
        createTestPlugin({
          name: 'text-bridge-denied',
          setupFn: (ctx) => {
            contexts.set('text-bridge-denied', ctx)
          }
        }),
        'local'
      )
      const bridge = vi.fn(async () => null)
      manager.setTextBridge(bridge)
      await manager.start()

      // 未授予 media.generate：宿主桥接不可见
      expect(contexts.get('text-bridge-denied')?.textBridge).toBeUndefined()
      // 授予后惰性 getter 返回宿主桥接函数（setTextBridge 晚于 setup 注入也生效）
      const grantedBridge = contexts.get('text-bridge-granted')?.textBridge
      expect(grantedBridge).toBeTypeOf('function')
      await expect(grantedBridge!('llm-1')).resolves.toBeNull()
      expect(bridge).toHaveBeenCalledWith('llm-1')
    })

    it('未获 session.create 时 createSession 抛错且可审计', async () => {
      const manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '')
      let rejection: Error | undefined
      const plugin = createTestPlugin({
        name: 'external-session-test',
        setupFn: async (ctx) => {
          await ctx
            .createSession({ systemPrompt: 'x', userMessage: 'y' })
            .catch((err: Error) => {
              rejection = err
            })
        }
      })
      await manager.loadPluginEntry(plugin, 'local')
      await manager.start()
      expect(rejection?.message).toContain('session.create')
      expect(rejection?.message).toContain('external-session-test')
    })

    it('resolvePath 把路径钉在 dataDir 内，越界抛错', async () => {
      const manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '')
      let inside: string | undefined
      let escaped: Error | undefined
      const plugin = createTestPlugin({
        name: 'path-guard-test',
        setupFn: (ctx) => {
          inside = ctx.resolvePath('cache', 'a.json')
          try {
            ctx.resolvePath('..', '..', 'etc', 'passwd')
          } catch (err) {
            escaped = err as Error
          }
        }
      })
      await manager.loadPluginEntry(plugin, 'local')
      await manager.start()
      expect(inside).toContain('path-guard-test')
      expect(escaped?.message).toContain('越出 dataDir 边界')
    })

    it('disable 后插件注册的事件监听被取消', async () => {
      const eventHandler = vi.fn()
      const plugin: Plugin = {
        manifest: { name: 'event-plugin', version: '1.0.0' },
        async setup(ctx: PluginContext) {
          ctx.onEvent('test:event', eventHandler)
        }
      }

      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()

      // 启用时事件可收到
      eventBus.emit('test:event', { a: 1 })
      expect(eventHandler).toHaveBeenCalledTimes(1)

      // 禁用后事件不再收到
      await manager.disable('event-plugin')
      eventBus.emit('test:event', { a: 2 })
      expect(eventHandler).toHaveBeenCalledTimes(1) // 仍然是 1 次
    })

    it('disable 后 getAllTools/getAllRoutes/getAllPanels 不返回该插件的注册项', async () => {
      const plugin: Plugin = {
        manifest: { name: 'reg-plugin', version: '1.0.0' },
        async setup(ctx: PluginContext) {
          ctx.registerTool({
            name: 'reg.tool',
            description: '测试',
            async execute() {
              return { ok: true }
            }
          })
          ctx.registerRoute({
            method: 'GET',
            path: '/r',
            async handler() {
              return {}
            }
          })
          ctx.registerPanel({
            id: 'reg-panel',
            title: 'T',
            component: 'C'
          })
        }
      }

      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()
      await manager.start()

      expect(manager.getAllTools()).toHaveLength(1)
      expect(manager.getAllRoutes()).toHaveLength(1)
      expect(manager.getAllPanels()).toHaveLength(1)

      await manager.disable('reg-plugin')

      expect(manager.getAllTools()).toHaveLength(0)
      expect(manager.getAllRoutes()).toHaveLength(0)
      expect(manager.getAllPanels()).toHaveLength(0)
    })
  })

  describe('list / get', () => {
    it('list 返回所有插件的摘要信息', async () => {
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [
          { plugin: createTestPlugin({ name: 'a', version: '1.0.0' }) },
          { plugin: createTestPlugin({ name: 'b', version: '2.0.0' }) }
        ]
      })

      await manager.init()

      const list = manager.list()
      expect(list).toHaveLength(2)
      expect(list.map((p) => p.name).sort()).toEqual(['a', 'b'])
      expect(list[0].source).toBe('builtin')
      expect(list[0].toolCount).toBe(0)
    })

    it('get 返回插件详情', async () => {
      const plugin = createTestPlugin({ name: 'test-1' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }]
      })

      await manager.init()

      const entry = manager.get('test-1')
      expect(entry).toBeDefined()
      expect(entry?.manifest.name).toBe('test-1')
      expect(entry?.source).toBe('builtin')
    })

    it('get 不存在的插件返回 undefined', () => {
      expect(manager.get('nonexistent')).toBeUndefined()
    })
  })

  describe('Hello 示例插件', () => {
    it('createHelloPlugin 返回有效插件', () => {
      const plugin = createHelloPlugin()
      expect(plugin.manifest.name).toBe('hello')
      expect(plugin.manifest.version).toBe('1.0.0')
      expect(typeof plugin.setup).toBe('function')
    })

    it('hello 插件注册工具、路由、面板、事件监听', async () => {
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin: createHelloPlugin() }]
      })

      await manager.init()
      await manager.start()

      const entry = manager.get('hello')
      expect(entry?.status).toBe('enabled')
      expect(entry?.tools.length).toBeGreaterThan(0)
      expect(entry?.routes.length).toBeGreaterThan(0)
      expect(entry?.panels.length).toBeGreaterThan(0)
      expect(entry?.eventHandlers.length).toBeGreaterThan(0)
    })

    it('hello.greet 工具执行正确', async () => {
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin: createHelloPlugin() }]
      })

      await manager.init()
      await manager.start()

      const tools = manager.getAllTools()
      const greetTool = tools.find((t) => t.name === 'hello.greet')
      expect(greetTool).toBeDefined()

      const result = await greetTool!.execute({ name: 'World', language: 'en' }, {})
      expect(result.ok).toBe(true)
      expect(result.data).toBeDefined()
      const data = result.data as { messages: string[]; greetCount: number }
      expect(data.messages).toContain('Hello, World!')
    })
  })
})

describe('Plugin 系统 Fastify 集成', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    // 禁用示例插件以避免污染（每个测试单独注册）
    process.env.PI_PLUGINS_ENABLE_EXAMPLES = 'false'
    app = Fastify({ logger: false })
    // 装饰 mock db，pluginLoaderPlugin 启动时会读取 schema_migrations
    app.decorate('db', createMockDb())
    await app.register(eventBusPlugin)
    await app.register(pluginLoaderPlugin)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    delete process.env.PI_PLUGINS_ENABLE_EXAMPLES
  })

  it('pluginManager 已挂载到 Fastify 实例', () => {
    expect(app.pluginManager).toBeDefined()
    expect(typeof app.pluginManager.list).toBe('function')
  })

  it('默认不加载示例插件（禁用示例时）', () => {
    const list = app.pluginManager.list()
    // 禁用 PI_PLUGINS_ENABLE_EXAMPLES 后，hello 示例不加载，但内置插件（如 novel）仍加载
    const names = list.map((p) => p.name)
    expect(names).not.toContain('hello')
  })
})

describe('Plugin 系统 API 路由', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    process.env.PI_PLUGINS_ENABLE_EXAMPLES = 'true'
    const { createApp } = await import('../app.js')
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    delete process.env.PI_PLUGINS_ENABLE_EXAMPLES
  })

  it('GET /api/plugins 返回插件列表', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins'
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.plugins).toBeInstanceOf(Array)
    expect(body.data.total).toBeGreaterThan(0)

    // 应该包含 hello 插件
    const hello = body.data.plugins.find((p: { name: string }) => p.name === 'hello')
    expect(hello).toBeDefined()
    expect(hello.status).toBe('enabled')
    expect(hello.lifecycle).toBe('enabled')
    expect(hello.activationGeneration).toBeGreaterThan(0)
    expect(hello).toHaveProperty('effectCount')
    expect(hello).toHaveProperty('activeEffectCount')
  })

  it('GET /api/plugins/hello 返回插件详情', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/hello'
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.name).toBe('hello')
    expect(body.data.version).toBe('1.0.0')
    expect(body.data.tools).toBeInstanceOf(Array)
    expect(body.data.tools.length).toBeGreaterThan(0)
    expect(body.data.lifecycle).toBe('enabled')
    expect(body.data.activationGeneration).toBeGreaterThan(0)
    expect(body.data.uiContributions).toEqual([
      expect.objectContaining({
        contributionId: 'hello-panel',
        rendererKey: 'builtin.hello-panel',
        slot: 'plugin-page.top'
      })
    ])
  })

  it('GET /api/plugins/nonexistent 返回 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/nonexistent'
    })

    expect(response.statusCode).toBe(404)
  })

  it('GET /api/plugins/hello/status（插件注册的路由）返回插件状态', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/hello/status'
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.plugin).toBe('hello')
    expect(body.data.status).toBe('running')
  })

  it('POST /api/plugins/hello/greet（插件注册的路由）执行问候', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/hello/greet',
      headers: { 'content-type': 'application/json' },
      body: { name: 'Tester', language: 'zh', times: 2 }
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.messages).toHaveLength(2)
    expect(body.data.messages[0]).toContain('Tester')
  })

  it('POST /api/plugins/hello/disable 禁用插件', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/hello/disable'
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.status).toBe('disabled')

    // 验证插件确实被禁用
    const entry = app.pluginManager.get('hello')
    expect(entry?.status).toBe('disabled')
  })

  it('POST /api/plugins/hello/enable 启用插件', async () => {
    // 先禁用
    await app.inject({
      method: 'POST',
      url: '/api/plugins/hello/disable'
    })

    // 再启用
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/hello/enable'
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.status).toBe('enabled')
  })

  it('GET /api/plugins/hello/tools 列出插件工具', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/hello/tools'
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.tools).toBeInstanceOf(Array)
    const greetTool = body.data.tools.find((t: { name: string }) => t.name === 'hello.greet')
    expect(greetTool).toBeDefined()
  })

  it('GET /api/plugins/hello/inspect 返回运行、effect 和 Slot 诊断投影', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins/hello/inspect' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.schemaVersion).toBe(1)
    expect(body.data.plugin).toMatchObject({
      pluginId: 'hello',
      // catalogId 是配置身份（plugins.yml / 默认列表里的工厂键），与 manifest.name 不同
      catalogId: 'hello-plugin',
      version: '1.0.0',
      lifecycle: 'enabled'
    })
    expect(body.data.effects).toBeInstanceOf(Array)
    expect(
      body.data.effects.every((effect: Record<string, unknown>) => !('dispose' in effect))
    ).toBe(true)
    expect(body.data.slots).toEqual([
      expect.objectContaining({ contributionId: 'hello-panel', rendererKey: 'builtin.hello-panel' })
    ])
    expect(body.data.diagnostics).toContain('存在需要重启才能完全卸载的路由或服务')
  })

  it('GET /api/plugins/ui-contributions 返回版本化受信 renderer manifest', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins/ui-contributions' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.data.schemaVersion).toBe(1)
    const hello = body.data.contributions.find(
      (item: { contributionId: string }) => item.contributionId === 'hello-panel'
    )
    expect(hello).toMatchObject({
      pluginId: 'hello',
      slot: 'plugin-page.top',
      rendererKey: 'builtin.hello-panel',
      state: 'active'
    })
    expect(hello).not.toHaveProperty('componentSource')
  })

  it('GET /api/plugins/panels/all 列出所有面板', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/panels/all'
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.panels).toBeInstanceOf(Array)
    const helloPanel = body.data.panels.find((p: { id: string }) => p.id === 'hello-panel')
    expect(helloPanel).toBeDefined()
  })
})
