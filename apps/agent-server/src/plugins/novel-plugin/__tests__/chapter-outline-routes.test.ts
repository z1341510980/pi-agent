import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { createChapterRoutes } from '../routes/chapter-routes.js'
import { createChapterOutlineRoutes } from '../routes/chapter-outline-routes.js'
import { hashChapterOutline } from '../core/chapters/chapter-outline.js'
import type { NovelServices } from '../novel-services.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

describe('章节章纲生成与保存接口', () => {
  let db: Database.Database
  let store: NovelStore
  let app: FastifyInstance
  let services: NovelServices
  let projectId: string
  let chapterId: string
  const generate = vi.fn()

  beforeEach(async () => {
    db = createTestDb()
    store = new NovelStore(db)
    projectId = randomUUID()
    chapterId = randomUUID()
    store.createProject({
      id: projectId,
      title: '测试小说',
      genre: '悬疑',
      synopsis: '一桩失踪案。',
      outline: '主角追查失踪案。',
      targetWords: 3000,
      currentVolume: 1,
      currentChapter: 1,
      currentStage: 'setup',
      status: 'active'
    })
    store.createChapter({
      id: chapterId,
      projectId,
      volume: 1,
      chapterNumber: 1,
      title: '旧城区',
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: '',
      outline: '原章纲',
      volumeId: null,
      acceptanceResult: null
    })

    generate.mockReset()
    generate.mockResolvedValue({
      generationId: randomUUID(),
      draft: {
        version: 1,
        outlineText: '这是模型生成的完整章纲草稿，用户确认之前不会写入数据库。',
        chapterGoal: '推进调查',
        openingState: '线索不足',
        progression: ['调查'],
        obstacles: [],
        turningPoint: '发现证人',
        endingState: '获得线索',
        hook: '危险逼近',
        sceneCountEstimate: 2,
        povSuggestions: [],
        storylines: [],
        continuityRisks: []
      },
      base: {
        chapterId,
        outlineHash: hashChapterOutline('原章纲'),
        contentRevisionId: null,
        planRevisionId: null,
        contextFingerprint: 'fingerprint'
      },
      model: { modelId: 'test:model', promptVersion: 'outline-planner-v1' },
      warnings: []
    })
    services = {
      store,
      outlineGenerator: { generate } as any,
      engine: {} as any,
      context: { logger: { error: vi.fn(), info: vi.fn() } } as any
    } as NovelServices

    app = Fastify()
    for (const route of [
      ...createChapterRoutes(services),
      ...createChapterOutlineRoutes(services)
    ]) {
      app.route({ method: route.method as any, url: route.path, handler: route.handler as any })
    }
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  it('生成接口只返回草稿，不修改持久化章纲', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/chapters/1/outline/generate`,
      payload: {
        mode: 'rewrite',
        currentOutline: '原章纲',
        expectedOutline: '原章纲',
        instruction: '增强悬念'
      }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.draft.outlineText).toContain('模型生成')
    expect(store.getChapter(projectId, 1)?.outline).toBe('原章纲')
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        chapterNumber: 1,
        mode: 'rewrite',
        currentOutline: '原章纲',
        expectedOutline: '原章纲',
        instruction: '增强悬念'
      })
    )
  })

  it('页面持有的章纲已过期时，不调用 LLM', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/chapters/1/outline/generate`,
      payload: {
        mode: 'rewrite',
        currentOutline: '旧页面内容',
        expectedOutline: '旧页面内容'
      }
    })

    expect(response.statusCode).toBe(409)
    expect(generate).not.toHaveBeenCalled()
    expect(store.getChapter(projectId, 1)?.outline).toBe('原章纲')
  })

  it('采用草稿时通过原有 PATCH 原子保存，并校验章纲 hash', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: {
        title: '新标题',
        outline: '采用后的章纲',
        expectedOutlineHash: hashChapterOutline('原章纲'),
        expectedContentRevisionId: null,
        outlineGenerationId: randomUUID()
      }
    })

    expect(response.statusCode).toBe(200)
    expect(store.getChapterById(chapterId)).toMatchObject({
      title: '新标题',
      outline: '采用后的章纲'
    })

    const staleResponse = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: {
        outline: '不应覆盖',
        expectedOutlineHash: hashChapterOutline('原章纲'),
        expectedContentRevisionId: null,
        outlineGenerationId: randomUUID()
      }
    })
    expect(staleResponse.statusCode).toBe(409)
    expect(store.getChapterById(chapterId)?.outline).toBe('采用后的章纲')
  })

  it('采用 AI 草稿时拒绝缺少任一并发校验字段', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: {
        outline: '不应保存的章纲',
        outlineGenerationId: randomUUID()
      }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('必须同时提交')
    expect(store.getChapterById(chapterId)?.outline).toBe('原章纲')
  })

  it('生成后正文 revision 变化时拒绝保存草稿', async () => {
    const expectedRevisionId = store.getCurrentContentRevision(chapterId)?.id ?? null
    store.updateChapterContent(chapterId, '生成之后新增的正文', 9, {
      phase: 'manual_patch',
      trigger: '测试'
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: {
        outline: '过期草稿',
        expectedOutlineHash: hashChapterOutline('原章纲'),
        expectedContentRevisionId: expectedRevisionId,
        outlineGenerationId: randomUUID()
      }
    })

    expect(response.statusCode).toBe(409)
    expect(store.getChapterById(chapterId)?.outline).toBe('原章纲')
  })
})
