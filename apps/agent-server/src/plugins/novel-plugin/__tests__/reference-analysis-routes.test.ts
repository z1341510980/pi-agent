import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { ReferenceAnalysisStore } from '../core/reference-analysis-store.js'
import { ReferenceAnalysisService } from '../core/reference-analysis-service.js'
import { createReferenceAnalysisRoutes } from '../routes/reference-analysis-routes.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelServices } from '../novel-services.js'
import { errorHandlerPlugin } from '../../../plugins/error-handler.plugin.js'
import { requestContextPlugin } from '../../../plugins/request-context.plugin.js'

const PREFIX = '/api/plugins/novel'

describe('参考小说分析阶段 1 路由闭环', () => {
  let db: Database.Database
  let app: FastifyInstance
  let projectId: string

  beforeAll(async () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const migration of novelMigrations) db.exec(migration.sql)
    const novelStore = new NovelStore(db)
    projectId = crypto.randomUUID()
    novelStore.createProject({
      id: projectId,
      title: '参考分析测试',
      genre: '悬疑',
      synopsis: '',
      targetWords: 3000,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active'
    })
    const referenceAnalysis = new ReferenceAnalysisService(
      new ReferenceAnalysisStore(db),
      novelStore
    )
    const services = { referenceAnalysis } as unknown as NovelServices

    app = Fastify({ logger: false })
    await app.register(requestContextPlugin)
    await app.register(errorHandlerPlugin)
    app.decorate('providerConfigStore', {
      get: (id: string) =>
        id === 'provider-1'
          ? {
              id,
              name: '测试 Provider',
              models: [
                {
                  id: 'model-1',
                  name: '测试模型',
                  contextWindow: 32768,
                  maxTokens: 4096,
                  cost: { input: 2, output: 8 }
                },
                {
                  id: 'model-too-small',
                  name: '小上下文模型',
                  contextWindow: 6000,
                  maxTokens: 1024,
                  cost: { input: 2, output: 8 }
                }
              ]
            }
          : undefined
    } as any)
    const routes = createReferenceAnalysisRoutes(services)
    expect(routes.find((route) => route.path.endsWith('/preflight'))?.bodyLimit).toBeGreaterThan(
      20 * 1024 * 1024
    )
    for (const route of routes) {
      app.route({
        method: route.method as any,
        url: `${PREFIX}${route.path}`,
        handler: route.handler as any,
        bodyLimit: route.bodyLimit
      })
    }
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    db.close()
  })

  it('完成粘贴预检、选项确认、解析、手调、报告和预算估算', async () => {
    const firstChapterBody = '长'.repeat(2500)
    const preflight = await app.inject({
      method: 'POST',
      url: `${PREFIX}/projects/${projectId}/reference-sources/preflight`,
      payload: {
        inputKind: 'paste',
        displayName: '参考文本',
        text: `第一章 开始\n\n${firstChapterBody}\n\n第二章 继续\n\n风很冷，他听见门响。`
      }
    })
    expect(preflight.statusCode).toBe(200)
    const draft = preflight.json().data
    expect(draft).toMatchObject({
      inputKind: 'paste',
      detectedEncoding: 'utf-8',
      estimatedChapterCount: 2
    })

    const invalidPasteEncoding = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/import-options`,
      payload: {
        encoding: 'gbk',
        retentionPolicy: 'manual_delete',
        rightsConfirmed: true,
        version: draft.version
      }
    })
    expect(invalidPasteEncoding.statusCode).toBe(400)
    expect(invalidPasteEncoding.json().error.message).toContain('不能改选')

    const options = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/import-options`,
      payload: {
        encoding: 'utf-8',
        retentionPolicy: 'manual_delete',
        rightsConfirmed: true,
        rightsStatement: '测试文本',
        cloudAnalysisConfirmed: false,
        version: draft.version
      }
    })
    expect(options.statusCode).toBe(200)
    const confirmed = options.json().data.source

    const parsedResponse = await app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/parse`,
      payload: { version: confirmed.version }
    })
    expect(parsedResponse.statusCode).toBe(200)
    const parsed = parsedResponse.json().data.source
    expect(parsed).toMatchObject({ parseStatus: 'parsed', chapterCount: 2 })

    const sectionsResponse = await app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/sections`
    })
    const sections = sectionsResponse.json().data
    expect(sections).toHaveLength(2)

    const preview = await app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/text-preview?sectionId=${sections[0].id}&contextChars=20`
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({
      sourceId: draft.sourceDraftId,
      sectionId: sections[0].id,
      excluded: false,
      truncated: true
    })
    expect(preview.json().data.text).toContain('第一章 开始')
    expect(preview.json().data.text.length).toBeLessThanOrEqual(2000)

    const adjustedResponse = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/reference-sections/${sections[1].id}`,
      payload: { included: false, exclusionReason: '本轮不分析', version: sections[1].version }
    })
    expect(adjustedResponse.statusCode).toBe(200)
    expect(adjustedResponse.json().data.section.included).toBe(false)

    const quality = await app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/quality-report`
    })
    expect(quality.statusCode).toBe(200)
    expect(quality.json().data).toHaveProperty('chapterBoundaryConfidence')

    const report = await app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/local-analysis-report`
    })
    expect(report.statusCode).toBe(200)
    expect(report.json().data.chapterLengths).toHaveLength(2)
    expect(report.json().data.dataQuality.includedCharacterRatio).toBeLessThan(1)

    const estimate = await app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/analysis-estimate`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        selectedSectionIds: [sections[0].id],
        outputReserveTokens: 2048
      }
    })
    expect(estimate.statusCode).toBe(200)
    expect(estimate.json().data).toMatchObject({
      providerId: 'provider-1',
      modelId: 'model-1',
      contextWindow: 32768,
      withinLimit: true,
      pricingSource: 'provider_config'
    })
    expect(estimate.json().data.estimateHash).toHaveLength(64)

    const blockedEstimate = await app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/analysis-estimate`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-too-small',
        selectedSectionIds: [sections[0].id],
        outputReserveTokens: 512
      }
    })
    expect(blockedEstimate.statusCode).toBe(200)
    expect(blockedEstimate.json().data.withinLimit).toBe(false)
    expect(blockedEstimate.json().data.excessTokens).toBeGreaterThan(0)

    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM novel_characters').get() as { count: number })
        .count
    ).toBe(0)
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM novel_story_events').get() as { count: number })
        .count
    ).toBe(0)
  })

  it('保留 GBK 文件原始字节，并拒绝未确认权利时解析', async () => {
    const gbkBytes = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xb2, 0xe2, 0xca, 0xd4])
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/projects/${projectId}/reference-sources/preflight`,
      payload: {
        inputKind: 'file',
        displayName: 'GBK 文件',
        fileName: 'reference.txt',
        bytesBase64: gbkBytes.toString('base64')
      }
    })
    const draft = response.json().data
    expect(draft.detectedEncoding).toBe('gbk')

    const parsed = await app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/parse`,
      payload: { version: draft.version }
    })
    expect(parsed.statusCode).toBe(400)
    expect(parsed.json().error.message).toContain('确认有权分析')
  })
})
