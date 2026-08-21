/**
 * 插件 route/service 宿主挂载边界测试（研究文档 §10.11）
 *
 * 已证实的问题：Fastify 只能在启动期注册路由和 decoration。运行期 `/enable`
 * 之后 manager 的聚合视图会显示新的 route/service，但 HTTP 请求打不到，
 * `app.decorate` 也不会再执行。API 若只返回 `status: 'enabled'`，
 * 就在谎报"service 和 route 已可用"。
 *
 * 这里用真实的 createApp + inject 验证三件事：
 * 1. 启动期启用的插件，其 route 真的可访问，effectiveAfterRestart=false
 * 2. 运行期 enable 的插件，setup 成功但 route 打不到，effectiveAfterRestart=true
 * 3. disable 之后旧 route 仍然存活，API 明确标记 restartRequired
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'

let configDir: string
let dataDir: string
let app: FastifyInstance | undefined

function writeCatalog(lines: string[]): void {
  writeFileSync(join(configDir, 'plugins.yml'), lines.join('\n'), 'utf-8')
}

async function startApp(): Promise<FastifyInstance> {
  const { createApp } = await import('../app.js')
  const instance = await createApp()
  await instance.ready()
  return instance
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'pi-host-mount-config-'))
  dataDir = mkdtempSync(join(tmpdir(), 'pi-host-mount-data-'))
  process.env.PI_CONFIG_DIR = configDir
  process.env.PI_DATA_DIR = dataDir
  process.env.PI_CWD = dataDir
  process.env.PI_PLUGINS_ENABLE_EXAMPLES = 'true'
})

afterEach(async () => {
  if (app) {
    await app.close()
    app = undefined
  }
  delete process.env.PI_CONFIG_DIR
  delete process.env.PI_DATA_DIR
  delete process.env.PI_CWD
  delete process.env.PI_PLUGINS_ENABLE_EXAMPLES
  rmSync(configDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('启动期启用的插件：route 真的挂上了', () => {
  beforeEach(() => {
    writeCatalog(['plugins:', '  - id: hello-plugin', '    source: builtin', '    enabled: true'])
  })

  it('route 可访问，且 API 不声称需要重启才生效', async () => {
    app = await startApp()

    const status = await app.inject({ method: 'GET', url: '/api/plugins/hello/status' })
    expect(status.statusCode).toBe(200)
    expect(status.json().data.plugin).toBe('hello')

    const list = await app.inject({ method: 'GET', url: '/api/plugins' })
    const hello = list.json().data.plugins.find((item: { name: string }) => item.name === 'hello')
    expect(hello.status).toBe('enabled')
    expect(hello.effectiveAfterRestart).toBe(false)
    // route effect 已真正挂到宿主
    expect(hello.hostAttached).toBe(true)
  })

  it('inspect 的 route effect 标记 hostAttached', async () => {
    app = await startApp()

    const inspect = await app.inject({ method: 'GET', url: '/api/plugins/hello/inspect' })
    const routeEffects = inspect
      .json()
      .data.effects.filter((effect: { kind: string }) => effect.kind === 'route')
    expect(routeEffects.length).toBeGreaterThan(0)
    expect(routeEffects.every((effect: { hostAttached: boolean }) => effect.hostAttached)).toBe(
      true
    )
  })
})

describe('运行期 enable：setup 成功但 route 打不到', () => {
  beforeEach(() => {
    // 启动时关着：宿主启动期不会挂载它的 route
    writeCatalog(['plugins:', '  - id: hello-plugin', '    source: builtin', '    enabled: false'])
  })

  it('enable 返回 effectiveAfterRestart=true，且 route 仍是 404', async () => {
    app = await startApp()

    // 启动时未挂载：route 不存在
    const before = await app.inject({ method: 'GET', url: '/api/plugins/hello/status' })
    expect(before.statusCode).toBe(404)

    const enabled = await app.inject({ method: 'POST', url: '/api/plugins/hello/enable' })
    expect(enabled.statusCode).toBe(200)
    // setup 成功
    expect(enabled.json().data.status).toBe('enabled')
    // 但必须如实告知：route/service 要等重启
    expect(enabled.json().data.effectiveAfterRestart).toBe(true)

    // 关键断言：manager 说 enabled，Fastify 仍然没有这条路由
    const after = await app.inject({ method: 'GET', url: '/api/plugins/hello/status' })
    expect(after.statusCode).toBe(404)
  })

  it('list/inspect 一致地报告"需重启才生效"，不谎称已挂载', async () => {
    app = await startApp()
    await app.inject({ method: 'POST', url: '/api/plugins/hello/enable' })

    const list = await app.inject({ method: 'GET', url: '/api/plugins' })
    const hello = list.json().data.plugins.find((item: { name: string }) => item.name === 'hello')
    expect(hello.status).toBe('enabled')
    expect(hello.effectiveAfterRestart).toBe(true)
    expect(hello.hostAttached).toBe(false)

    const inspect = await app.inject({ method: 'GET', url: '/api/plugins/hello/inspect' })
    const data = inspect.json().data
    expect(data.plugin.effectiveAfterRestart).toBe(true)
    expect(data.diagnostics).toContain('本次启用注册的路由或服务需要重启服务后才会生效')
    const routeEffects = data.effects.filter(
      (effect: { kind: string; activationGeneration: number }) =>
        effect.kind === 'route' && effect.activationGeneration === data.plugin.activationGeneration
    )
    expect(routeEffects.length).toBeGreaterThan(0)
    expect(routeEffects.every((effect: { hostAttached: boolean }) => !effect.hostAttached)).toBe(
      true
    )
  })

  it('重启后同一插件的 route 才真正可用', async () => {
    app = await startApp()
    await app.inject({ method: 'POST', url: '/api/plugins/hello/enable' })
    expect((await app.inject({ method: 'GET', url: '/api/plugins/hello/status' })).statusCode).toBe(
      404
    )

    // enable 已写回 YAML：重启后按 enabled: true 在启动期挂载
    await app.close()
    app = await startApp()

    const status = await app.inject({ method: 'GET', url: '/api/plugins/hello/status' })
    expect(status.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: '/api/plugins' })
    const hello = list.json().data.plugins.find((item: { name: string }) => item.name === 'hello')
    expect(hello.effectiveAfterRestart).toBe(false)
    expect(hello.hostAttached).toBe(true)
  })
})

describe('disable 之后：旧 route 仍存活，状态如实标记', () => {
  beforeEach(() => {
    writeCatalog(['plugins:', '  - id: hello-plugin', '    source: builtin', '    enabled: true'])
  })

  it('manager 报 disabled + restartRequired，但 Fastify 仍能路由到旧 handler', async () => {
    app = await startApp()
    expect((await app.inject({ method: 'GET', url: '/api/plugins/hello/status' })).statusCode).toBe(
      200
    )

    const disabled = await app.inject({ method: 'POST', url: '/api/plugins/hello/disable' })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json().data.status).toBe('disabled')
    // Fastify 不支持注销路由，必须如实标记
    expect(disabled.json().data.restartRequired).toBe(true)

    // 旧 handler 仍在路由表里：这正是 restartRequired 要表达的事实
    const still = await app.inject({ method: 'GET', url: '/api/plugins/hello/status' })
    expect(still.statusCode).toBe(200)

    const inspect = await app.inject({ method: 'GET', url: '/api/plugins/hello/inspect' })
    expect(inspect.json().data.diagnostics).toContain('存在需要重启才能完全卸载的路由或服务')
  })

  it('重启后禁用真正生效，route 变为 404', async () => {
    app = await startApp()
    await app.inject({ method: 'POST', url: '/api/plugins/hello/disable' })

    await app.close()
    app = await startApp()

    const status = await app.inject({ method: 'GET', url: '/api/plugins/hello/status' })
    expect(status.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/plugins' })
    const hello = list.json().data.plugins.find((item: { name: string }) => item.name === 'hello')
    expect(hello.status).toBe('disabled')
    expect(hello.desiredEnabled).toBe(false)
  })
})
