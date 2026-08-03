import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { EventBus } from '@repo/shared/events'
import { PluginManager, measurePayload } from '../core/plugin/plugin-manager.js'
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
    level: 'silent',
  } as unknown as FastifyInstance['log']
  return logger
}

/** 创建一个最小化的 mock db（测试插件不使用迁移功能，无需真实数据库） */
function createMockDb() {
  return {
    prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
    exec: () => undefined,
    transaction: (fn: () => unknown) => fn,
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
      description: `测试插件 ${options.name}`,
    },
    async setup(ctx) {
      if (options.shouldFail) {
        throw new Error(`插件 ${options.name} setup 失败`)
      }
      if (options.setupFn) {
        await options.setupFn(ctx)
      }
    },
    teardown: options.teardownFn,
  }
}

describe('PluginManager', () => {
  it('measurePayload counts a top-level provider system prompt', () => {
    const payload = { system: 'system text', messages: [{ role: 'user', content: 'hello' }], tools: [] }
    const stats = measurePayload(payload)
    expect(stats.messagesChars).toBe(JSON.stringify(payload.system).length + JSON.stringify(payload.messages).length)
    expect(stats.totalChars).toBe(JSON.stringify(payload).length)
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
        builtinPlugins: [{ plugin }],
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
        builtinPlugins: [{ plugin }],
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
        builtinPlugins: [{ plugin }],
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
        builtinPlugins: [{ plugin }],
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
          { plugin: createTestPlugin({ name: 'ok-plugin-2', setupFn: okSetup }) },
        ],
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
        },
      })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }],
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
        builtinPlugins: [{ plugin }],
      })

      await manager.init()
      await manager.enable('test-1')

      expect(manager.get('test-1')?.status).toBe('enabled')
    })

    it('disable 禁用指定插件', async () => {
      const plugin = createTestPlugin({ name: 'test-1' })
      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }],
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
        builtinPlugins: [{ plugin }],
      })

      await manager.init()
      await manager.start()
      // 不应抛出异常
      await manager.enable('test-1')
      expect(manager.get('test-1')?.status).toBe('enabled')
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
            },
          })
          ctx.registerRoute({
            method: 'GET',
            path: '/test',
            async handler() {
              return { ok: true }
            },
          })
          ctx.registerPanel({
            id: 'full-panel',
            title: '测试面板',
            component: 'TestPanel',
          })
          ctx.onEvent('test:event', eventHandler)
        },
      }

      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }],
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

    it('disable 后插件注册的事件监听被取消', async () => {
      const eventHandler = vi.fn()
      const plugin: Plugin = {
        manifest: { name: 'event-plugin', version: '1.0.0' },
        async setup(ctx: PluginContext) {
          ctx.onEvent('test:event', eventHandler)
        },
      }

      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }],
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
            },
          })
          ctx.registerRoute({
            method: 'GET',
            path: '/r',
            async handler() {
              return {}
            },
          })
          ctx.registerPanel({
            id: 'reg-panel',
            title: 'T',
            component: 'C',
          })
        },
      }

      manager = new PluginManager(createSilentLogger(), eventBus, createMockDb(), '', '', {
        builtinPlugins: [{ plugin }],
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
          { plugin: createTestPlugin({ name: 'b', version: '2.0.0' }) },
        ],
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
        builtinPlugins: [{ plugin }],
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
        builtinPlugins: [{ plugin: createHelloPlugin() }],
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
        builtinPlugins: [{ plugin: createHelloPlugin() }],
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
    const names = list.map(p => p.name)
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
      url: '/api/plugins',
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
  })

  it('GET /api/plugins/hello 返回插件详情', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/hello',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.name).toBe('hello')
    expect(body.data.version).toBe('1.0.0')
    expect(body.data.tools).toBeInstanceOf(Array)
    expect(body.data.tools.length).toBeGreaterThan(0)
  })

  it('GET /api/plugins/nonexistent 返回 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/nonexistent',
    })

    expect(response.statusCode).toBe(404)
  })

  it('GET /api/plugins/hello/status（插件注册的路由）返回插件状态', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/hello/status',
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
      body: { name: 'Tester', language: 'zh', times: 2 },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.messages).toHaveLength(2)
    expect(body.data.messages[0]).toContain('Tester')
  })

  it('POST /api/plugins/hello/disable 禁用插件', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/hello/disable',
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
      url: '/api/plugins/hello/disable',
    })

    // 再启用
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/hello/enable',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.status).toBe('enabled')
  })

  it('GET /api/plugins/hello/tools 列出插件工具', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/hello/tools',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.tools).toBeInstanceOf(Array)
    const greetTool = body.data.tools.find((t: { name: string }) => t.name === 'hello.greet')
    expect(greetTool).toBeDefined()
  })

  it('GET /api/plugins/panels/all 列出所有面板', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/panels/all',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.panels).toBeInstanceOf(Array)
    const helloPanel = body.data.panels.find((p: { id: string }) => p.id === 'hello-panel')
    expect(helloPanel).toBeDefined()
  })
})
