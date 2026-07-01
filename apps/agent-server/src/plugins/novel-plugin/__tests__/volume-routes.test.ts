import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { createNovelRoutes } from '../novel-routes.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelServices } from '../novel-services.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
  return db
}

function createTestServices(store: NovelStore): NovelServices {
  return { store } as unknown as NovelServices
}

async function buildApp(store: NovelStore): Promise<FastifyInstance> {
  const app = Fastify()
  for (const r of createNovelRoutes(createTestServices(store))) {
    app.route({ method: r.method as any, url: r.path, handler: r.handler as any })
  }
  await app.ready()
  return app
}

function seedProject(store: NovelStore): string {
  const id = randomUUID()
  store.createProject({
    id, title: '测试项目', genre: 'test', synopsis: '', outline: '',
    targetWords: 0, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
  })
  return id
}

describe('卷与大纲 API', () => {
  let db: Database.Database
  let store: NovelStore
  let app: FastifyInstance
  let projectId: string

  beforeEach(async () => {
    db = createTestDb()
    store = new NovelStore(db)
    projectId = seedProject(store)
    app = await buildApp(store)
  })

  it('创建/列出/更新/删除卷', async () => {
    const created = await app.inject({
      method: 'POST', url: `/projects/${projectId}/volumes`,
      payload: { volumeNumber: 1, title: '起卷', outline: '卷纲内容' },
    })
    expect(created.statusCode).toBe(200)
    const vol = created.json().data
    expect(vol.title).toBe('起卷')
    expect(vol.outline).toBe('卷纲内容')

    const listed = await app.inject({ method: 'GET', url: `/projects/${projectId}/volumes` })
    expect(listed.json().data).toHaveLength(1)

    const patched = await app.inject({
      method: 'PATCH', url: `/volumes/${vol.id}`,
      payload: { title: '起卷改', outline: '新卷纲' },
    })
    expect(patched.json().data.title).toBe('起卷改')

    const deleted = await app.inject({ method: 'DELETE', url: `/volumes/${vol.id}` })
    expect(deleted.json().data.deleted).toBe(true)
  })

  it('PATCH 项目 outline', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/projects/${projectId}`,
      payload: { outline: '全书大纲文本' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.outline).toBe('全书大纲文本')
    // 未传字段不被覆盖
    expect(res.json().data.title).toBe('测试项目')
  })

  it('PATCH 章节 outline + volumeId，未传字段不被覆盖', async () => {
    const chapterId = randomUUID()
    store.createChapter({
      id: chapterId, projectId, volume: 1, chapterNumber: 1, title: '第一章',
      content: '', wordCount: 0, status: 'planned', narrativeTask: '原任务',
      outline: '', volumeId: null, acceptanceResult: null,
    })
    const vol = store.createVolume({
      id: randomUUID(), projectId, volumeNumber: 1, title: '', outline: '', sortOrder: 0,
    })
    const res = await app.inject({
      method: 'PATCH', url: `/chapters/${chapterId}`,
      payload: { outline: '章纲内容', volumeId: vol.id },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.outline).toBe('章纲内容')
    expect(data.volumeId).toBe(vol.id)
    expect(data.narrativeTask).toBe('原任务') // 未传不被覆盖
  })

  it('删除卷时章节 volume_id 置空，不删章', async () => {
    const vol = store.createVolume({
      id: randomUUID(), projectId, volumeNumber: 1, title: '', outline: '', sortOrder: 0,
    })
    const chapterId = randomUUID()
    store.createChapter({
      id: chapterId, projectId, volume: 1, chapterNumber: 1, title: '第一章',
      content: '', wordCount: 0, status: 'planned', narrativeTask: '',
      outline: '', volumeId: vol.id, acceptanceResult: null,
    })
    await app.inject({ method: 'DELETE', url: `/volumes/${vol.id}` })
    const chapter = store.getChapterById(chapterId)
    expect(chapter).toBeDefined()
    expect(chapter!.volumeId).toBeNull()
  })
})

describe('迁移 043 回填', () => {
  it('旧章节的 volume 自动建卷并回填 volume_id', () => {
    const db = createTestDb()
    const store = new NovelStore(db)
    const pid = seedProject(store)
    // 模拟旧数据：直接插 chapter 不带 volume_id（migration 042 后 volume_id 列已存在为 NULL）
    store.createChapter({
      id: randomUUID(), projectId: pid, volume: 2, chapterNumber: 1, title: '',
      content: '', wordCount: 0, status: 'planned', narrativeTask: '',
      outline: '', volumeId: null, acceptanceResult: null,
    })
    // 执行回填（043 的 sql 在建库时已执行过；此处校验对新插的旧式数据手动回填）
    db.exec(`INSERT INTO novel_volumes (id, project_id, volume_number, title, outline, sort_order, created_at, updated_at)
             SELECT lower(hex(randomblob(16))), project_id, volume, '第'||volume||'卷', '', volume, unixepoch(), unixepoch()
             FROM (SELECT DISTINCT project_id, volume FROM novel_chapters WHERE volume_id IS NULL) WHERE volume IS NOT NULL;
             UPDATE novel_chapters SET volume_id = (SELECT v.id FROM novel_volumes v WHERE v.project_id=novel_chapters.project_id AND v.volume_number=novel_chapters.volume) WHERE volume_id IS NULL;`)
    const chapters = store.listChapters(pid)
    expect(chapters[0].volumeId).not.toBeNull()
    expect(store.listVolumes(pid)).toHaveLength(1)
  })
})
