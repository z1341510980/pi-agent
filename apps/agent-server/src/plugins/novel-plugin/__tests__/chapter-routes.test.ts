import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { createNovelRoutes } from '../novel-routes.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelServices } from '../novel-services.js'

/** 用内存 SQLite 建库并执行 novel 迁移 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) {
    db.exec(m.sql)
  }
  return db
}

/** 构造仅含真实 store 的 NovelServices（其余字段测试路径不会触达） */
function createTestServices(store: NovelStore): NovelServices {
  return { store } as unknown as NovelServices
}

/** 注册 novel 路由到 Fastify 实例 */
async function buildApp(store: NovelStore): Promise<FastifyInstance> {
  const app = Fastify()
  const routes = createNovelRoutes(createTestServices(store))
  for (const r of routes) {
    app.route({
      method: r.method as any,
      url: r.path,
      handler: r.handler as any,
    })
  }
  await app.ready()
  return app
}

/**
 * 与前端 chapter-live-view.tsx 的 countWords 保持一致的算法，用于测试断言基准。
 */
function countWords(text: string): number {
  if (!text) return 0
  const cleaned = text.replace(/[#*`>\-\[\]()!]/g, '').replace(/\s+/g, '')
  return cleaned.length
}

describe('PATCH /chapters/:id wordCount 重算', () => {
  let db: Database.Database
  let store: NovelStore
  let app: FastifyInstance
  let chapterId: string

  beforeEach(async () => {
    db = createTestDb()
    store = new NovelStore(db)
    const project = store.createProject({
      id: randomUUID(),
      title: '测试项目',
      genre: 'test',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    chapterId = randomUUID()
    store.createChapter({
      id: chapterId,
      projectId: project.id,
      volume: 1,
      chapterNumber: 1,
      title: '第一章',
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: '',
      acceptanceResult: null,
    })
    app = await buildApp(store)
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  it('传 content 时自动重算 wordCount（与前端 countWords 算法一致）', async () => {
    // 含 Markdown 标记与空白，验证清理逻辑与前端一致
    const content = '# 一二三四五'
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { content },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.data.content).toBe(content)
    // 前端 countWords: 去除 # 与空白后为 '一二三四五' = 5
    expect(body.data.wordCount).toBe(countWords(content))
    expect(body.data.wordCount).toBe(5)
  })

  it('不传 content 时 wordCount 保持不变', async () => {
    // 先用 store 直接写入 content + wordCount，建立基线
    store.updateChapterContent(chapterId, '初始正文内容', 6)
    const before = store.getChapterById(chapterId)
    expect(before?.wordCount).toBe(6)

    // 仅 PATCH title，不应触碰 wordCount
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { title: '新标题' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.data.title).toBe('新标题')
    expect(body.data.wordCount).toBe(6)
  })
})

describe('PATCH /chapters/:id tension 字段', () => {
  let db: Database.Database
  let store: NovelStore
  let app: FastifyInstance
  let chapterId: string

  beforeEach(async () => {
    db = createTestDb()
    store = new NovelStore(db)
    const project = store.createProject({
      id: randomUUID(),
      title: '测试项目',
      genre: 'test',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    chapterId = randomUUID()
    store.createChapter({
      id: chapterId,
      projectId: project.id,
      volume: 1,
      chapterNumber: 1,
      title: '第一章',
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: '',
      acceptanceResult: null,
    })
    app = await buildApp(store)
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  it('PATCH tension=8 后 GET 返回 tension=8', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 8 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.tension).toBe(8)

    const get = await app.inject({ method: 'GET', url: `/chapters/${chapterId}` })
    expect(get.json().data.tension).toBe(8)
  })

  it('不传 tension 时保持原值（不覆盖）', async () => {
    // 先设为 7
    await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 7 },
    })
    // 再 PATCH title，tension 应保持 7
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { title: '新标题' },
    })
    expect(res.json().data.tension).toBe(7)
  })

  it('tension 超出 1-10 范围时返回 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 11 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('tension=null 清除张力值', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 5 },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.tension).toBeNull()
  })

  it('tension=0 返回 400（低于下界）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('tension=1 合法（下界）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 1 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.tension).toBe(1)
  })

  it('tension=10 合法（上界）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 10 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.tension).toBe(10)
  })

  it('tension=1.5 返回 400（非整数）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 1.5 },
    })
    expect(res.statusCode).toBe(400)
  })
})
