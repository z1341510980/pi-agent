/**
 * 插件完整性校验的加载侧集成测试（研究文档 §6.3）
 *
 * 用真实的临时 local 插件验证：
 * - 锁定信息匹配时插件正常加载
 * - 文件被篡改后拒绝加载，但 catalog 仍然可见（不能假装它不存在）
 * - 版本锁定不匹配时同样拒绝
 * - 锁定字段在 catalog 回写后不丢失
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computePackageIntegrity } from '../core/plugin/plugin-integrity.js'
import type { FastifyInstance } from 'fastify'

let configDir: string
let dataDir: string
let pluginDir: string
let app: FastifyInstance | undefined

const PLUGIN_SOURCE = [
  'export default {',
  '  manifest: { name: "sealed-plugin", version: "2.0.0", description: "integrity fixture" },',
  '  setup() {}',
  '}',
].join('\n')

function writePlugin(source: string): void {
  writeFileSync(join(pluginDir, 'index.mjs'), source, 'utf-8')
}

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
  configDir = mkdtempSync(join(tmpdir(), 'pi-seal-config-'))
  dataDir = mkdtempSync(join(tmpdir(), 'pi-seal-data-'))
  pluginDir = mkdtempSync(join(tmpdir(), 'pi-seal-plugin-'))
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'sealed-plugin', version: '2.0.0' }),
    'utf-8'
  )
  writePlugin(PLUGIN_SOURCE)
  process.env.PI_CONFIG_DIR = configDir
  process.env.PI_DATA_DIR = dataDir
  process.env.PI_CWD = dataDir
})

afterEach(async () => {
  if (app) {
    await app.close()
    app = undefined
  }
  delete process.env.PI_CONFIG_DIR
  delete process.env.PI_DATA_DIR
  delete process.env.PI_CWD
  rmSync(configDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(pluginDir, { recursive: true, force: true })
})

/** Windows 路径里的反斜杠必须转义才能写进 YAML 双引号字符串 */
const yamlEntryPath = (): string => JSON.stringify(join(pluginDir, 'index.mjs'))

describe('local 插件的完整性锁定', () => {
  it('锁定信息匹配时正常加载', async () => {
    const { sri } = computePackageIntegrity(pluginDir)
    writeCatalog([
      'plugins:',
      '  - id: sealed-plugin',
      '    source: local',
      `    sourceRef: ${yamlEntryPath()}`,
      '    enabled: true',
      '    resolvedVersion: "2.0.0"',
      `    integrity: ${JSON.stringify(sri)}`,
    ])
    app = await startApp()

    expect(app.pluginManager.get('sealed-plugin')?.status).toBe('enabled')
    expect(app.pluginManager.get('sealed-plugin')?.integrityStatus).toBe('verified')
  })

  it('无锁的 catalog 条目仍加载，但标记 unverified 并进入诊断', async () => {
    writeCatalog([
      'plugins:',
      '  - id: sealed-plugin',
      '    source: local',
      `    sourceRef: ${yamlEntryPath()}`,
      '    enabled: true',
    ])
    app = await startApp()

    // 无锁不阻断本地开发，但状态必须如实上报为未校验
    expect(app.pluginManager.get('sealed-plugin')?.status).toBe('enabled')
    expect(app.pluginManager.get('sealed-plugin')?.integrityStatus).toBe('unverified')

    const listed = (await app.inject({ method: 'GET', url: '/api/plugins' })).json().data
    expect(listed.schemaVersion).toBe(1)
    const item = listed.plugins.find((p: { name: string }) => p.name === 'sealed-plugin')
    expect(item.integrityStatus).toBe('unverified')

    const inspect = (
      await app.inject({ method: 'GET', url: '/api/plugins/sealed-plugin/inspect' })
    ).json().data
    expect(inspect.plugin.integrityStatus).toBe('unverified')
    expect(inspect.diagnostics.join('\n')).toContain('未经完整性校验')
  })

  it('builtin 插件的 integrityStatus 是 not-applicable', async () => {
    writeCatalog(['plugins: []'])
    app = await startApp()

    // builtin 随应用一起构建，不适用包级锁；不能显示成"未校验"来制造噪声
    expect(app.pluginManager.get('hello')?.integrityStatus).toBe('not-applicable')
  })

  it('文件被篡改后拒绝加载，catalog 仍可见', async () => {
    const { sri } = computePackageIntegrity(pluginDir)
    writeCatalog([
      'plugins:',
      '  - id: sealed-plugin',
      '    source: local',
      `    sourceRef: ${yamlEntryPath()}`,
      '    enabled: true',
      `    integrity: ${JSON.stringify(sri)}`,
    ])

    // 先启动一次确认能加载，再篡改后"重启"
    app = await startApp()
    expect(app.pluginManager.get('sealed-plugin')?.status).toBe('enabled')
    await app.close()

    writePlugin(PLUGIN_SOURCE.replace('setup() {}', 'setup() { /* backdoor */ }'))
    app = await startApp()

    // 关键：被篡改的代码绝不进入运行时
    expect(app.pluginManager.get('sealed-plugin')).toBeUndefined()
    // 但它没有被从 catalog 里抹掉：用户需要看到"有东西装着但没通过校验"
    const catalogIds = (
      await app.inject({ method: 'GET', url: '/api/plugins/catalog' })
    ).json().data.map((item: { catalogId: string }) => item.catalogId)
    expect(catalogIds).toContain('sealed-plugin')
  })

  it('版本锁定不匹配时拒绝加载', async () => {
    const { sri } = computePackageIntegrity(pluginDir)
    writeCatalog([
      'plugins:',
      '  - id: sealed-plugin',
      '    source: local',
      `    sourceRef: ${yamlEntryPath()}`,
      '    enabled: true',
      '    resolvedVersion: "1.0.0"',
      `    integrity: ${JSON.stringify(sri)}`,
    ])
    app = await startApp()

    expect(app.pluginManager.get('sealed-plugin')).toBeUndefined()
  })

  it('integrity 格式非法时拒绝加载（不能当作未锁定）', async () => {
    writeCatalog([
      'plugins:',
      '  - id: sealed-plugin',
      '    source: local',
      `    sourceRef: ${yamlEntryPath()}`,
      '    enabled: true',
      '    integrity: "md5-not-a-real-lock"',
    ])
    app = await startApp()

    expect(app.pluginManager.get('sealed-plugin')).toBeUndefined()
  })

  it('sha384/sha512 的锁在 catalog 校验阶段就被拒绝', async () => {
    // 目录摘要只用 sha256。放行更强算法名会让配置通过校验却在加载期永久失败，
    // 因此解析/校验两侧都必须在同一处拒绝。
    writeCatalog([
      'plugins:',
      '  - id: sealed-plugin',
      '    source: local',
      `    sourceRef: ${yamlEntryPath()}`,
      '    enabled: true',
      '    integrity: "sha512-AAAA"',
    ])
    app = await startApp()

    expect(app.pluginManager.get('sealed-plugin')).toBeUndefined()
  })

  it('enable 触发的 catalog 回写保留锁定字段', async () => {
    const { sri } = computePackageIntegrity(pluginDir)
    writeCatalog([
      'plugins:',
      '  - id: sealed-plugin',
      '    source: local',
      `    sourceRef: ${yamlEntryPath()}`,
      '    enabled: false',
      '    resolvedVersion: "2.0.0"',
      `    integrity: ${JSON.stringify(sri)}`,
    ])
    app = await startApp()

    // disabled 的 local 插件没有 import，先确认不可见
    expect(app.pluginManager.get('sealed-plugin')).toBeUndefined()

    // 运行期 enable：没有 entry 时记录期望状态并写回 YAML（重启后才真正加载）
    const enabled = await app.inject({ method: 'POST', url: '/api/plugins/sealed-plugin/enable' })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().data.status).toBe('pending-restart')
    expect(enabled.json().data.effectiveAfterRestart).toBe(true)

    // 仍然没有 entry：代码没有被 import
    expect(app.pluginManager.get('sealed-plugin')).toBeUndefined()

    const persisted = (
      await app.inject({ method: 'GET', url: '/api/plugins/catalog' })
    ).json().data.find((item: { catalogId: string }) => item.catalogId === 'sealed-plugin')
    expect(persisted.enabled).toBe(true)
    expect(persisted.integrity).toBe(sri)
    expect(persisted.resolvedVersion).toBe('2.0.0')

    // 重启后按新期望状态在启动期加载并通过校验
    await app.close()
    app = await startApp()
    expect(app.pluginManager.get('sealed-plugin')?.status).toBe('enabled')
  })
})
