/**
 * 生成插件包的锁定信息（resolvedVersion + integrity），用于写入 plugins.yml。
 *
 * 用法：
 *   pnpm --filter agent-server exec tsx --tsconfig tsconfig.tsx.json scripts/seal-plugin.ts <插件包目录或入口文件>
 *
 * 输出可直接粘贴到 plugins.yml 的对应条目下。摘要覆盖包目录内除
 * node_modules / .git 外的全部文件；安装依赖或改动代码后必须重新生成。
 */
import { resolve, dirname } from 'node:path'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { computePackageIntegrity } from '../src/core/plugin/plugin-integrity.js'

function main(): void {
  const input = process.argv[2]
  if (!input) {
    console.error('用法: tsx scripts/seal-plugin.ts <插件包目录或入口文件>')
    process.exit(1)
  }

  const resolved = resolve(input)
  if (!existsSync(resolved)) {
    console.error(`路径不存在: ${resolved}`)
    process.exit(1)
  }

  const packageDir = statSync(resolved).isFile() ? dirname(resolved) : resolved

  let version: string | undefined
  const pkgJsonPath = resolve(packageDir, 'package.json')
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version?: unknown }
      if (typeof pkg.version === 'string') version = pkg.version
    } catch {
      // package.json 损坏：只输出 integrity，不猜版本
    }
  }

  const { sri, fileCount } = computePackageIntegrity(packageDir)

  console.log('# 加入 plugins.yml 对应条目：')
  if (version) console.log(`resolvedVersion: ${JSON.stringify(version)}`)
  console.log(`integrity: ${JSON.stringify(sri)}`)
  console.log(`# 摘要覆盖 ${fileCount} 个文件（目录: ${packageDir}）`)
}

main()
