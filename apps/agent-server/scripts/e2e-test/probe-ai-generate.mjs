/**
 * 单独测试 ai-generate 角色 SSE 流（隔离 entity_generator 内部问题）
 *
 * 用法：node apps/agent-server/scripts/e2e-test/probe-ai-generate.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SseClient } from './lib/sse-client.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(__dirname, 'output')
mkdirSync(OUTPUT_DIR, { recursive: true })

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3900'

async function http(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { _raw: text }
  }
  return { status: res.status, ok: res.ok, data: json }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  ai-generate 单角色 SSE 诊断')
  console.log('  Base URL:', BASE_URL)
  console.log('═══════════════════════════════════════════════════════════════')

  // 创建测试项目
  const projectRes = await http('POST', '/api/plugins/novel/projects', {
    title: 'probe-ai-generate-' + Date.now(),
    genre: '玄幻',
    synopsis: '测试',
    targetWords: 50000,
  })
  if (!projectRes.ok) {
    console.error('创建项目失败:', projectRes.data)
    process.exit(1)
  }
  const projectId = projectRes.data.data.id
  console.log('项目已创建:', projectId)

  // 触发 ai-generate
  const url = `${BASE_URL}/api/plugins/novel/projects/${projectId}/characters/ai-generate`
  const events = []
  let firstTokenAt = null
  let runFinished = false
  let runError = null
  const t0 = Date.now()

  const sse = new SseClient(url, {
    body: { coreStyle: '沉默寡言的剑客，背负血海深仇' },
  })

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      runError = '60s 超时未收到 RUN_FINISHED'
      sse.stop().finally(resolve)
    }, 60_000)

    sse.start({
      onEvent: (event) => {
        events.push(event)
        const elapsed = Date.now() - t0
        console.log(`[${elapsed}ms] ${event.type}${event.name ? ':' + event.name : ''} ${event.message || event.value?.message || ''}`)

        if (event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_DELTA') {
          if (!firstTokenAt) firstTokenAt = Date.now()
        }
        if (event.type === 'RUN_FINISHED') {
          runFinished = true
          clearTimeout(timeout)
          resolve()
        }
        if (event.type === 'RUN_ERROR') {
          runError = event.message
          clearTimeout(timeout)
          resolve()
        }
      },
      onError: (err) => {
        runError = `SSE Error: ${err.message}`
        clearTimeout(timeout)
        resolve()
      },
      onClose: () => {
        clearTimeout(timeout)
        resolve()
      },
    })
  })

  const totalMs = Date.now() - t0
  console.log('\n═══════════════════════════════════════════════════════════════')
  console.log('  结果')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  总耗时       : ${totalMs}ms`)
  console.log(`  首 token    : ${firstTokenAt ? firstTokenAt - t0 + 'ms' : '未收到'}`)
  console.log(`  RUN_FINISHED: ${runFinished}`)
  console.log(`  错误        : ${runError || '无'}`)
  console.log(`  事件总数    : ${events.length}`)

  const eventTypes = {}
  for (const e of events) {
    const key = e.type + (e.name ? ':' + e.name : '')
    eventTypes[key] = (eventTypes[key] || 0) + 1
  }
  console.log('  事件类型    :', JSON.stringify(eventTypes))

  // 写完整事件日志
  const logPath = join(OUTPUT_DIR, `probe-ai-generate-${Date.now()}.log`)
  writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  console.log('  日志        :', logPath)

  // 清理
  await http('DELETE', `/api/plugins/novel/projects/${projectId}`)
  console.log('项目已清理')

  process.exit(runFinished ? 0 : 1)
}

main().catch((err) => {
  console.error('未捕获错误:', err)
  process.exit(1)
})
