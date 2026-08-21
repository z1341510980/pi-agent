/**
 * /api/plugins 契约测试（P2-3）
 *
 * 把 schemaVersion=1 的响应形状钉死：桌面端 plugin-client 的类型依赖这些字段。
 * 字段演进必须显式 bump schemaVersion 并同步更新本文件与桌面端类型 ——
 * 静默漂移会让 UI 在运行期拿到 undefined。
 *
 * 注意：JSON 序列化会丢弃值为 undefined 的字段，因此契约区分
 * 必选键（必须出现）与可选键（出现时不得超出白名单）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

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

/**
 * 必选键全部存在；实际键不得超出 必选 ∪ 可选 白名单。
 */
function expectContract(
  actual: object,
  required: string[],
  optional: string[] = []
): void {
  const keys = Object.keys(actual)
  const missing = required.filter((key) => !keys.includes(key))
  expect(missing, `缺少必选字段: ${missing.join(', ')}`).toEqual([])
  const allowed = new Set([...required, ...optional])
  const unknown = keys.filter((key) => !allowed.has(key))
  expect(unknown, `出现契约之外的字段: ${unknown.join(', ')}`).toEqual([])
}

describe('GET /api/plugins 列表契约', () => {
  it('外层结构为 { ok, data: { plugins, total } }', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expectContract(body, ['ok', 'data'])
    expect(body.ok).toBe(true)
    expectContract(body.data, ['schemaVersion', 'plugins', 'total'])
    expect(body.data.schemaVersion).toBe(1)
    expect(body.data.total).toBe(body.data.plugins.length)
  })

  it('列表项字段集与类型（schemaVersion=1）', async () => {
    const { plugins } = (
      await app.inject({ method: 'GET', url: '/api/plugins' })
    ).json().data
    const hello = plugins.find((item: { name: string }) => item.name === 'hello')
    expect(hello).toBeDefined()

    // error/runId/lastStop/dependencyDiagnostics 仅在非默认值时出现（JSON 丢弃 undefined）
    expectContract(hello, [
      'name',
      'version',
      'status',
      'source',
      'integrityStatus',
      'lifecycle',
      'desiredEnabled',
      'restartRequired',
      'unloadScope',
      'activationGeneration',
      'effectCount',
      'activeEffectCount',
      'hostAttached',
      'effectiveAfterRestart',
      'toolCount',
      'routeCount',
      'panelCount',
      'eventHandlerCount',
      'migrationCount',
      'sessionToolCount',
      'serviceCount',
    ], ['description', 'author', 'error', 'runId', 'lastStop', 'dependencyDiagnostics'])

    expect(typeof hello.version).toBe('string')
    expect(['loaded', 'enabled', 'disabled', 'error']).toContain(hello.status)
    expect(['builtin', 'local', 'npm']).toContain(hello.source)
    expect(['verified', 'unverified', 'not-applicable']).toContain(hello.integrityStatus)
    expect(typeof hello.desiredEnabled).toBe('boolean')
    expect(typeof hello.restartRequired).toBe('boolean')
    expect(['none', 'restart-required', 'session']).toContain(hello.unloadScope)
    expect(Number.isInteger(hello.activationGeneration)).toBe(true)
    expect(typeof hello.hostAttached).toBe('boolean')
    expect(typeof hello.effectiveAfterRestart).toBe('boolean')
    for (const key of [
      'effectCount',
      'activeEffectCount',
      'toolCount',
      'routeCount',
      'panelCount',
      'eventHandlerCount',
      'migrationCount',
      'sessionToolCount',
      'serviceCount',
    ]) {
      expect(Number.isInteger(hello[key])).toBe(true)
    }
  })
})

describe('GET /api/plugins/:id 详情契约', () => {
  it('详情字段集包含 grants/permissions/uiContributions 与列表项投影', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins/hello' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)

    const detail = body.data
    // 详情 = manifest 展开 + 运行投影；filePath/error 仅在非默认值时出现
    expectContract(detail, [
      'name',
      'version',
      'schemaVersion',
      'pluginId',
      'catalogId',
      'status',
      'source',
      'integrityStatus',
      'desiredEnabled',
      'dependencyDiagnostics',
      'effectiveAfterRestart',
      'grants',
      'permissions',
      'config',
      'tools',
      'routes',
      'panels',
      'uiContributions',
      'dependencies',
      'reloadable',
    ], ['description', 'author', 'error', 'lifecycle', 'activationGeneration', 'runId', 'effectCount', 'activeEffectCount', 'hostAttached', 'lastStop', 'restartRequired', 'unloadScope', 'toolCount', 'routeCount', 'panelCount', 'eventHandlerCount', 'migrationCount', 'sessionToolCount', 'serviceCount', 'toolNames', 'routePaths', 'panelIds', 'filePath', 'builtin', 'main'])
    expect(Array.isArray(detail.grants)).toBe(true)
    // builtin 默认持有全部 capability
    expect(detail.grants.length).toBeGreaterThan(0)
    expect(Array.isArray(detail.uiContributions)).toBe(true)
  })

  it('不存在的插件返回 404 + 错误码', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins/nonexistent' })
    expect(response.statusCode).toBe(404)
    const body = response.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('PLUGIN_NOT_FOUND')
  })
})

describe('GET /api/plugins/:id/inspect 契约', () => {
  it('schemaVersion=1，plugin/effects/slots/diagnostics 四段结构', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins/hello/inspect' })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.schemaVersion).toBe(1)

    expectContract(data, ['schemaVersion', 'plugin', 'effects', 'slots', 'diagnostics'])

    // runId/error/lastStop 在健康插件上为 undefined，JSON 中不出现
    expectContract(data.plugin, [
      'pluginId',
      'catalogId',
      'packageName',
      'version',
      'status',
      'lifecycle',
      'integrityStatus',
      'desiredEnabled',
      'activationGeneration',
      'restartRequired',
      'effectiveAfterRestart',
      'unloadScope',
      'dependencyDiagnostics',
    ], ['runId', 'error', 'lastStop'])

    expect(data.effects.length).toBeGreaterThan(0)
    for (const effect of data.effects) {
      // disposer 绝不出现在 API 投影里
      expectContract(effect, [
        'id',
        'kind',
        'resourceId',
        'owner',
        'activationGeneration',
        'unloadScope',
        'state',
        'hostAttached',
        'createdAt',
        'disposeAttempts',
      ], ['disposedAt', 'lastError'])
      expect(effect).not.toHaveProperty('dispose')
    }

    for (const slot of data.slots) {
      expectContract(slot, [
        'contributionId',
        'slot',
        'scope',
        'priority',
        'rendererKey',
        'state',
      ])
    }

    expect(Array.isArray(data.diagnostics)).toBe(true)
    expect(data.diagnostics.every((item: unknown) => typeof item === 'string')).toBe(true)
  })
})

describe('GET /api/plugins/ui-contributions 契约', () => {
  it('schemaVersion=1，只含受信 renderer 声明，不含可执行源码', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins/ui-contributions' })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.schemaVersion).toBe(1)

    const hello = data.contributions.find(
      (item: { contributionId: string }) => item.contributionId === 'hello-panel'
    )
    expect(hello).toBeDefined()
    // entryKey/label 仅在对应场景出现（keyed slot 用 entryKey；有 title 的面板带 label）
    expectContract(hello, [
      'contributionId',
      'slot',
      'scope',
      'priority',
      'rendererKey',
      'state',
      'pluginId',
      'activationGeneration',
    ], ['entryKey', 'props', 'label'])
    expect(hello.label).toBe('Hello 插件面板')    // rendererKey 必须能被桌面白名单解析；component 源码字符串绝不下发
    expect(typeof hello.rendererKey).toBe('string')
    expect(hello).not.toHaveProperty('component')
  })
})

describe('enable/disable 响应契约', () => {
  it('toggle 返回 status/desiredEnabled/effectiveAfterRestart/restartRequired', async () => {
    const disabled = await app.inject({ method: 'POST', url: '/api/plugins/hello/disable' })
    expect(disabled.statusCode).toBe(200)
    expectContract(disabled.json().data, [
      'pluginId',
      'status',
      'desiredEnabled',
      'effectiveAfterRestart',
      'restartRequired',
    ])
    expect(disabled.json().data.desiredEnabled).toBe(false)

    const enabled = await app.inject({ method: 'POST', url: '/api/plugins/hello/enable' })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().data.desiredEnabled).toBe(true)
    // 运行期重新 enable：宿主已过启动期挂载阶段，新 activation 的 route
    // 必须重启才会挂载 —— 这正是 effectiveAfterRestart 要如实表达的事实
    expect(enabled.json().data.effectiveAfterRestart).toBe(true)
  })

  it('依赖不满足的 enable 返回 409 + PLUGIN_DEPENDENCY_UNMET', async () => {
    // 直接构造一个带缺失依赖的插件条目验证错误码契约
    const manager = app.pluginManager
    await manager.loadPluginEntry({
      manifest: { name: 'contract-broken', version: '1.0.0', dependencies: ['absent-dep'] },
      setup: () => {},
    }, 'builtin')

    const response = await app.inject({ method: 'POST', url: '/api/plugins/contract-broken/enable' })
    expect(response.statusCode).toBe(409)
    const body = response.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('PLUGIN_DEPENDENCY_UNMET')
  })
})

describe('capability 契约', () => {
  it('grants 更新拒绝未知 capability', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/plugins/hello/grants',
      payload: { grants: ['tools.register', 'not.a.capability'] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('INVALID_CAPABILITY')
  })

  it('grants 接受本轮新增的三个 capability', async () => {
    // 服务端 ALL_PLUGIN_CAPABILITIES 与桌面端授权弹窗必须同集合，
    // 否则用户在 UI 里勾了却被服务端拒绝。
    const response = await app.inject({
      method: 'PUT',
      url: '/api/plugins/hello/grants',
      payload: {
        grants: ['session.create', 'agent.orchestrate', 'confirmation.request'],
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.grants).toEqual(
      expect.arrayContaining(['session.create', 'agent.orchestrate', 'confirmation.request'])
    )
  })
})
