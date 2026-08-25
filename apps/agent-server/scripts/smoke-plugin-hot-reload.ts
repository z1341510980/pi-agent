/**
 * 热更新子树失效冒烟验证（需在真实 node/tsx 进程里跑，vitest 的 vite-node
 * 管道不经过 module.register 钩子，测不出这条链路）。
 *
 * 断言：修改被入口依赖的子模块后，带新代数戳重导入口，能看到子模块的新值。
 * 子树失效失效（钩子未生效）时 gen2 仍是旧值 1。
 *
 * 用法：pnpm --filter agent-server exec tsx --tsconfig tsconfig.tsx.json scripts/smoke-plugin-hot-reload.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bumpHotGeneration, ensureHotResolveHooks } from '../src/core/plugin/hot-module-cache.js'

const dir = mkdtempSync(join(tmpdir(), 'pi-hot-smoke-'))
try {
  writeFileSync(join(dir, 'b.mjs'), 'export const v = 1\n', 'utf-8')
  writeFileSync(
    join(dir, 'a.mjs'),
    'import { v } from "./b.mjs"\nexport const get = () => v\n',
    'utf-8'
  )
  const entryUrl = pathToFileURL(join(dir, 'a.mjs')).href

  await ensureHotResolveHooks()

  const mod1 = await import(`${entryUrl}?hot=${bumpHotGeneration()}`)
  console.log('[smoke] gen1 value:', mod1.get())
  if (mod1.get() !== 1) throw new Error(`gen1 应为 1，实际 ${mod1.get()}`)

  // 只改子模块 b.mjs，入口 a.mjs 不动
  writeFileSync(join(dir, 'b.mjs'), 'export const v = 2\n', 'utf-8')

  const mod2 = await import(`${entryUrl}?hot=${bumpHotGeneration()}`)
  console.log('[smoke] gen2 value:', mod2.get())
  if (mod2.get() !== 2) {
    throw new Error(`子树失效失败：gen2 应为 2（子模块新值），实际 ${mod2.get()} —— 解析钩子未生效`)
  }

  console.log('[smoke] OK：多文件插件的子模块热更新生效')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
