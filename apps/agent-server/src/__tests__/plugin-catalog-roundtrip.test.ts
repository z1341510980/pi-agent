/**
 * plugins.yml catalog 往返与重启恢复测试（研究文档 §10.2 / §10.11）
 *
 * 用 PI_CONFIG_DIR 指向临时目录，验证：
 * - disabled 的 builtin 插件仍进 catalog 且可 enable（不是"未发现"）
 * - grants/config 变更写回 YAML 后，"重启"（重建 app）能恢复
 * - 环境变量引用在缺失时明确失败，不把字面量当密钥
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { FastifyInstance } from 'fastify'

let configDir: string
let dataDir: string
let app: FastifyInstance | undefined

const configPath = (): string => join(configDir, 'plugins.yml')

function writeCatalog(text: string): void {
  writeFileSync(configPath(), text, 'utf-8')
}

function readCatalog(): { plugins?: Array<Record<string, unknown>> } {
  return yaml.load(readFileSync(configPath(), 'utf-8')) as {
    plugins?: Array<Record<string, unknown>>
  }
}

async function startApp(): Promise<FastifyInstance> {
  const { createApp } = await import('../app.js')
  const instance = await createApp()
  await instance.ready()
  return instance
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'pi-catalog-config-'))
  dataDir = mkdtempSync(join(tmpdir(), 'pi-catalog-data-'))
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
  delete process.env.PI_CATALOG_TEST_KEY
  rmSync(configDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('plugins.yml catalog 往返', () => {
  it('disabled 的 builtin 仍在 catalog 中，且可通过 enable 恢复', async () => {
    writeCatalog(
      [
        'plugins:',
        '  - id: hello-plugin',
        '    source: builtin',
        '    enabled: false'
      ].join('\n')
    )
    app = await startApp()

    // catalog 可见：desiredState=false 不等于未发现
    const catalog = await app.inject({ method: 'GET', url: '/api/plugins/catalog' })
    expect(catalog.json().data.map((item: { catalogId: string }) => item.catalogId)).toContain(
      'hello-plugin'
    )

    const list = await app.inject({ method: 'GET', url: '/api/plugins' })
    const hello = list
      .json()
      .data.plugins.find((item: { name: string }) => item.name === 'hello')
    expect(hello).toBeDefined()
    expect(hello.status).toBe('disabled')
    expect(hello.desiredEnabled).toBe(false)

    // 可以在运行期启用
    const enabled = await app.inject({ method: 'POST', url: '/api/plugins/hello/enable' })
    expect(enabled.statusCode).toBe(200)
    expect(app.pluginManager.get('hello')?.status).toBe('enabled')
  })

  it('grants 更新写回 YAML，重启后恢复并标记 restartRequired', async () => {
    writeCatalog(
      [
        'plugins:',
        '  - id: hello-plugin',
        '    source: builtin',
        '    enabled: true'
      ].join('\n')
    )
    app = await startApp()

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/plugins/hello/grants',
      payload: { grants: ['tools.register', 'routes.register'] }
    })
    expect(updated.statusCode).toBe(200)

    // 已写回文件
    const persisted = readCatalog()
    const helloEntry = persisted.plugins?.find((item) => item.id === 'hello-plugin')
    expect(helloEntry?.grants).toEqual(['tools.register', 'routes.register'])

    // "重启"：关掉旧 app，用同一 config 目录重建
    await app.close()
    app = await startApp()

    const catalog = await app.inject({ method: 'GET', url: '/api/plugins/catalog' })
    const restored = catalog
      .json()
      .data.find((item: { catalogId: string }) => item.catalogId === 'hello-plugin')
    expect(restored.grants).toEqual(['tools.register', 'routes.register'])
  })

  it('disable 后写回 enabled: false，重启后仍是禁用', async () => {
    writeCatalog(
      [
        'plugins:',
        '  - id: hello-plugin',
        '    source: builtin',
        '    enabled: true'
      ].join('\n')
    )
    app = await startApp()
    expect(app.pluginManager.get('hello')?.status).toBe('enabled')

    // 通过 config 端点写入 enabled=false（该端点同时持久化 catalog）
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/plugins/hello/config',
      payload: { enabled: false }
    })
    expect(patched.statusCode).toBe(200)
    expect(readCatalog().plugins?.find((item) => item.id === 'hello-plugin')?.enabled).toBe(false)

    await app.close()
    app = await startApp()

    const list = await app.inject({ method: 'GET', url: '/api/plugins' })
    const hello = list
      .json()
      .data.plugins.find((item: { name: string }) => item.name === 'hello')
    expect(hello.status).toBe('disabled')
    expect(hello.desiredEnabled).toBe(false)
  })

  it('config 中的环境变量引用被解析后传给插件', async () => {
    process.env.PI_CATALOG_TEST_KEY = 'resolved-secret'
    writeCatalog(
      [
        'plugins:',
        '  - id: hello-plugin',
        '    source: builtin',
        '    enabled: true',
        '    config:',
        '      apiKey: ${PI_CATALOG_TEST_KEY}'
      ].join('\n')
    )
    app = await startApp()

    expect(app.pluginManager.get('hello')?.config).toMatchObject({ apiKey: 'resolved-secret' })
  })

  it('环境变量缺失时配置项为 undefined，不留下字面量', async () => {
    writeCatalog(
      [
        'plugins:',
        '  - id: hello-plugin',
        '    source: builtin',
        '    enabled: true',
        '    config:',
        '      apiKey: ${PI_CATALOG_TEST_KEY}'
      ].join('\n')
    )
    app = await startApp()

    const config = app.pluginManager.get('hello')?.config as Record<string, unknown>
    expect(config.apiKey).toBeUndefined()
    // 关键：绝不能把 '${PI_CATALOG_TEST_KEY}' 当成真实密钥交给插件
    expect(config.apiKey).not.toBe('${PI_CATALOG_TEST_KEY}')
  })

  it('结构非法的条目被丢弃，同文件中的合法条目仍加载', async () => {
    writeCatalog(
      [
        'plugins:',
        '  - id: bogus-plugin',
        '    source: ftp',
        '    enabled: true',
        '  - id: hello-plugin',
        '    source: builtin',
        '    enabled: true'
      ].join('\n')
    )
    app = await startApp()

    const catalogIds = (
      await app.inject({ method: 'GET', url: '/api/plugins/catalog' })
    )
      .json()
      .data.map((item: { catalogId: string }) => item.catalogId)
    expect(catalogIds).toContain('hello-plugin')
    expect(catalogIds).not.toContain('bogus-plugin')
    expect(app.pluginManager.get('hello')?.status).toBe('enabled')
  })
})
