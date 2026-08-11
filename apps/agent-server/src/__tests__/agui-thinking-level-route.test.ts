/**
 * /ag-ui/agent/default/threads/:threadId/thinking-level 端点集成测试
 *
 * 验证 POST 端点的：
 * - 成功设置并落库
 * - 返回当前值
 * - 参数校验（无效 level 拒绝）
 * - 与 ThreadSettingsStore 联动
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.js'

describe('thinking-level 端点', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pi-thinking-level-'))
    process.env.PI_DATA_DIR = dataDir
    process.env.PI_CWD = dataDir
    app = await createApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    delete process.env.PI_DATA_DIR
    delete process.env.PI_CWD
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('GET 默认返回 null', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/default/threads/thread-unset/thinking-level',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ threadId: 'thread-unset', level: null })
  })

  it('POST 设置成功后 GET 返回设置值', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/threads/thread-1/thinking-level',
      body: { threadId: 'thread-1', level: 'high' },
    })
    expect(post.statusCode).toBe(200)
    expect(post.json()).toEqual({ threadId: 'thread-1', level: 'high' })

    const get = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/default/threads/thread-1/thinking-level',
    })
    expect(get.json()).toEqual({ threadId: 'thread-1', level: 'high' })
  })

  it('POST 接受 6 档合法 level', async () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      const response = await app.inject({
        method: 'POST',
        url: `/ag-ui/agent/default/threads/thread-${level}/thinking-level`,
        body: { threadId: `thread-${level}`, level },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().level).toBe(level)
    }
  })

  it('POST 拒绝无效的 level（zod 校验失败）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/threads/thread-bad/thinking-level',
      body: { threadId: 'thread-bad', level: 'bogus-level' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('POST 拒绝缺失 threadId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/threads/thread-x/thinking-level',
      body: { level: 'high' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('POST 后清空 session 缓存（getStats 计数清零）', async () => {
    // 触发一次 session 创建以填缓存
    const run = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/run',
      headers: { 'content-type': 'application/json' },
      body: { threadId: 'thread-cache-test', runId: 'r1', messages: [] },
    })
    // 接受流式响应（200 + text/event-stream）；此时 session 已被 getOrCreate 缓存
    expect(run.statusCode).toBe(200)
    // 消费流（fastify.inject 的 body 直接是字符串）
    expect(typeof run.body).toBe('string')

    const before = app.piSessionStore.getStats()
    expect(before.threadCount).toBeGreaterThan(0)

    // POST thinkingLevel → 应清空缓存
    const post = await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/threads/thread-cache-test/thinking-level',
      body: { threadId: 'thread-cache-test', level: 'low' },
    })
    expect(post.statusCode).toBe(200)

    const after = app.piSessionStore.getStats()
    expect(after.threadCount).toBe(0)
  })

  it('不同 thread 的 thinkingLevel 独立（不互相覆盖）', async () => {
    await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/threads/thread-a/thinking-level',
      body: { threadId: 'thread-a', level: 'low' },
    })
    await app.inject({
      method: 'POST',
      url: '/ag-ui/agent/default/threads/thread-b/thinking-level',
      body: { threadId: 'thread-b', level: 'xhigh' },
    })
    const a = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/default/threads/thread-a/thinking-level',
    })
    const b = await app.inject({
      method: 'GET',
      url: '/ag-ui/agent/default/threads/thread-b/thinking-level',
    })
    expect(a.json().level).toBe('low')
    expect(b.json().level).toBe('xhigh')
  })
})