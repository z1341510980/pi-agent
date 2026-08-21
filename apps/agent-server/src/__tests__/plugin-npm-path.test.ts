/**
 * npm 插件加载的路径校验回归测试
 *
 * 覆盖 plugin-loader 里 node_modules 包含性判定的跨平台正确性。
 *
 * 背景：该判定原先写成 `resolved.startsWith(nodeModulesDir + '\\')`。
 * 硬编码 Windows 分隔符使它在 posix 上恒为假 —— 所有 plugins.yml 声明的
 * npm 插件都会被当成"逃逸 node_modules"而拒绝加载。本测试用真实包目录
 * 断言合法 npm 插件能被加载，并断言逃逸形态仍被拒绝。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'

let configDir: string
let dataDir: string
let cwdDir: string
let app: FastifyInstance | undefined

const PLUGIN_SOURCE = [
  'export default {',
  '  manifest: { name: "npm-fixture", version: "1.0.0", description: "npm path guard fixture" },',
  '  setup() {}',
  '}',
].join('\n')

/** 在临时 cwd 下造一个可被解析的 npm 包 */
function writeNpmPackage(packageName: string): void {
  const packageDir = join(cwdDir, 'node_modules', packageName)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', main: 'index.mjs' }),
    'utf-8'
  )
  writeFileSync(join(packageDir, 'index.mjs'), PLUGIN_SOURCE, 'utf-8')
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
  configDir = mkdtempSync(join(tmpdir(), 'pi-npm-config-'))
  dataDir = mkdtempSync(join(tmpdir(), 'pi-npm-data-'))
  cwdDir = mkdtempSync(join(tmpdir(), 'pi-npm-cwd-'))
  process.env.PI_CONFIG_DIR = configDir
  process.env.PI_DATA_DIR = dataDir
  // npm 包解析基准是 PI_CWD，不是进程 cwd
  process.env.PI_CWD = cwdDir
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
  rmSync(cwdDir, { recursive: true, force: true })
})

describe('npm 插件的 node_modules 路径校验', () => {
  it('普通包名解析到 node_modules 内部，插件正常加载', async () => {
    writeNpmPackage('wenlang-agent-plugin-demo')
    writeCatalog([
      'plugins:',
      '  - id: npm-demo',
      '    source: npm',
      '    sourceRef: wenlang-agent-plugin-demo',
      '    enabled: true',
    ])
    app = await startApp()

    // 修复前在 posix 上这里会是 undefined（被误判为逃逸）
    expect(app.pluginManager.get('npm-fixture')?.status).toBe('enabled')
    expect(app.pluginManager.get('npm-fixture')?.source).toBe('npm')
  })

  it('YAML 声明的 npm 插件不受 wenlang-agent-plugin- 前缀约束', async () => {
    // 前缀只约束目录扫描发现（PI_PLUGINS_ENABLE_NPM），不约束显式声明
    writeNpmPackage('some-vendor-plugin')
    writeCatalog([
      'plugins:',
      '  - id: npm-noprefix',
      '    source: npm',
      '    sourceRef: some-vendor-plugin',
      '    enabled: true',
    ])
    app = await startApp()

    expect(app.pluginManager.get('npm-fixture')?.status).toBe('enabled')
  })

  it('scoped 包名同样被接受', async () => {
    writeNpmPackage(join('@vendor', 'agent-plugin'))
    writeCatalog([
      'plugins:',
      '  - id: npm-scoped',
      '    source: npm',
      '    sourceRef: "@vendor/agent-plugin"',
      '    enabled: true',
    ])
    app = await startApp()

    expect(app.pluginManager.get('npm-fixture')?.status).toBe('enabled')
  })

  it('路径穿越形态的 sourceRef 被拒绝（不因修复而放松边界）', async () => {
    // 在 node_modules 外面放一个同样合法的插件包，确认它不会被加载到
    const outsideDir = join(cwdDir, 'outside-pkg')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(
      join(outsideDir, 'package.json'),
      JSON.stringify({ name: 'outside-pkg', version: '1.0.0', main: 'index.mjs' }),
      'utf-8'
    )
    writeFileSync(join(outsideDir, 'index.mjs'), PLUGIN_SOURCE, 'utf-8')

    writeCatalog([
      'plugins:',
      '  - id: npm-escape',
      '    source: npm',
      '    sourceRef: "../outside-pkg"',
      '    enabled: true',
    ])
    app = await startApp()

    expect(app.pluginManager.get('npm-fixture')).toBeUndefined()
  })

  it('包名恰好等于 node_modules 自身时被拒绝', async () => {
    writeCatalog([
      'plugins:',
      '  - id: npm-self',
      '    source: npm',
      '    sourceRef: "."',
      '    enabled: true',
    ])
    app = await startApp()

    expect(app.pluginManager.get('npm-fixture')).toBeUndefined()
  })
})
