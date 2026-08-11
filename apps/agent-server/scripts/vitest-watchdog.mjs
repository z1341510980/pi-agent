#!/usr/bin/env node
/**
 * vitest watchdog 包装器（Windows 专用兜底）
 *
 * 背景：vitest + better-sqlite3（原生模块）在本机 Windows 环境存在已知兼容问题——
 * 测试全部跑完后主进程不退出（worker 残留 SimpleWriteWrap），表现为"没有返回"。
 * 测试结果本身完全正确（vitest 的 JSON reporter 在测试跑完、挂起之前已写入文件）。
 *
 * 本脚本：
 *   1. 以 `--reporter=json --outputFile=<临时文件>` 启动 vitest
 *   2. vitest 正常退出 → 透传退出码
 *   3. 轮询 JSON 报告：测试跑完后 vitest 仍不退出（挂起）→ 主动强杀进程树，
 *      从 JSON 报告判断结果并返回正确退出码（有失败=1，全过=0）
 *   4. 超过 VITEST_TIMEOUT_MS（默认 900s）仍未出结果 → 强制兜底结束
 *
 * 用法：node scripts/vitest-watchdog.mjs run [vitest 参数...]
 * 环境变量：VITEST_TIMEOUT_MS（挂起兜底超时，默认 900000ms=15 分钟）
 */
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// agent-server 根目录（scripts/ 的上一级）
const rootDir = join(__dirname, '..')
const vitestEntry = join(rootDir, 'node_modules', 'vitest', 'vitest.mjs')

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log('用法: node scripts/vitest-watchdog.mjs run [vitest 参数...]')
  console.log('环境变量: VITEST_TIMEOUT_MS=900000（挂起兜底超时，默认 15 分钟）')
  process.exit(0)
}

if (!existsSync(vitestEntry)) {
  console.error(`未找到 vitest 入口: ${vitestEntry}\n请先安装依赖（pnpm install）`)
  process.exit(1)
}

const timeoutMs = Number.parseInt(process.env.VITEST_TIMEOUT_MS ?? '900000', 10)
const jsonPath = join(tmpdir(), `vitest-report-${process.pid}-${Date.now()}.json`)

console.log(`[watchdog] vitest 入口: ${vitestEntry}`)
console.log(`[watchdog] 结果报告: ${jsonPath}`)
console.log(`[watchdog] 挂起兜底超时: ${timeoutMs / 1000}s（VITEST_TIMEOUT_MS 可调）`)

const child = spawn(
  process.execPath,
  [vitestEntry, ...args, '--reporter=json', `--outputFile=${jsonPath}`, '--reporter=default'],
  {
    stdio: 'inherit',
    cwd: rootDir,
    env: { ...process.env, CI: 'true' },
  },
)

let finished = false
let forceKilled = false

function readReport() {
  try {
    if (existsSync(jsonPath)) {
      const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
      // 只有测试真正跑完（含 testResults）才认为报告有效
      return Array.isArray(report.testResults) ? report : null
    }
  } catch {
    // JSON 未写完/损坏则忽略，继续轮询
  }
  return null
}

function cleanup() {
  if (existsSync(jsonPath)) {
    try { unlinkSync(jsonPath) } catch { /* 忽略 */ }
  }
}

function finish(reason, fallbackCode) {
  if (finished) return
  finished = true
  clearTimeout(hardTimer)
  if (pollTimer) clearInterval(pollTimer)
  const report = readReport()
  if (report) {
    const failed = (report.numFailedTests ?? 0) + (report.numFailedTestSuites ?? 0)
    const total = report.numTotalTests ?? 0
    const passed = report.numPassedTests ?? 0
    if (failed > 0) {
      console.error(`[watchdog] ${reason}。测试结果：${passed}/${total} 通过，${failed} 个失败 → 退出码 1`)
      cleanup()
      process.exit(1)
    }
    console.log(`[watchdog] ${reason}。测试结果：${passed}/${total} 全部通过 → 退出码 0`)
    cleanup()
    process.exit(0)
  }
  console.error(`[watchdog] ${reason}。未能读取 JSON 报告（vitest 可能未正常启动），透传 vitest 退出码 ${fallbackCode}`)
  cleanup()
  process.exit(fallbackCode || 1)
}

function forceKill() {
  if (forceKilled) return
  forceKilled = true
  console.warn('[watchdog] 检测到测试已跑完但 vitest 进程未退出（Windows 已知挂起问题），强制结束进程树...')
  try {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } catch { /* 忽略 */ }
  try { child.kill('SIGKILL') } catch { /* 忽略 */ }
}

// 兜底超时：无论如何都要返回
const hardTimer = setTimeout(() => {
  forceKill()
  // 给 kill 一点时间落盘/收尾，然后从 JSON 报告收尾
  setTimeout(() => finish('测试进程超过兜底超时被强制结束后', child.exitCode ?? 1), 2000)
}, timeoutMs)

// 轮询：JSON 报告出现（测试已跑完）且 vitest 仍活着 → 主动强杀结束
let pollTimer = setInterval(() => {
  if (finished) return
  if (readReport() && child.exitCode === null) {
    // 报告已生成但进程还挂着：等 1.5s 给它最后一次自己退出的机会
    setTimeout(() => {
      if (finished) return
      if (child.exitCode === null) {
        forceKill()
        setTimeout(() => finish('测试跑完后 vitest 进程挂起，强制结束后', 0), 1500)
      }
    }, 1500)
  }
}, 2000)

child.on('exit', (code) => {
  if (finished) return
  if (forceKilled) return // 强杀路径由 finish 统一收尾
  finish(`vitest 正常退出（exit code ${code}）`, code ?? 1)
})

child.on('error', (err) => {
  if (finished) return
  console.error(`[watchdog] 启动 vitest 失败: ${err.message}`)
  cleanup()
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  console.error(`[watchdog] 未捕获异常: ${err.message}`)
  finish('watchdog 内部异常', 1)
})
