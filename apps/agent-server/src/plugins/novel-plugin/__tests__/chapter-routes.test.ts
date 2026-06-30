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
