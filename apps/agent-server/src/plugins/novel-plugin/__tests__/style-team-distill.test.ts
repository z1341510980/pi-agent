import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { NovelStore } from '../core/novel-store.js'
import { ReferenceAnalysisStore } from '../core/analysis/reference-analysis-store.js'
import { ReferenceAnalysisService } from '../core/analysis/reference-analysis-service.js'
import { createNovelRoutes } from '../novel-routes.js'
import { novelMigrations } from '../novel-migrations.js'
import type { NovelServices } from '../novel-services.js'
import { errorHandlerPlugin } from '../../../plugins/error-handler.plugin.js'
import { requestContextPlugin } from '../../../plugins/request-context.plugin.js'

const PREFIX = '/api/plugins/novel'

/** 可切换的蒸馏 mock 响应：维度蒸馏路由测试的核心桩。 */
let mockDistillResponse = '{}'

function makeMockContext(db: Database.Database): unknown {
  return {
    db,
    logger: { warn: () => undefined, debug: () => undefined, error: () => undefined },
    agentCallLogger: undefined,
    createAgUiSession: async () => ({
      session: { prompt: async () => mockDistillResponse },
      dispose: () => undefined
    })
  }
}

/** 构造一份合法的维度蒸馏 payload（techniques 可注入）。 */
function makeDistillPayload(techniques: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    name: '对话·潜台词压制',
    description: '对话不把话说完',
    distilledPrompt: '迁移提示词：对话只写七成',
    techniques,
    exclusions: ['人物专名'],
    expressionDna: { sentence: '短句为主' },
    tensions: [{ name: '克制', between: ['克制', '引爆'], resolution: '只引爆一次' }],
    antiPatterns: ['旁白解释动机'],
    boundaries: ['不适合群战'],
    exemplarPassages: []
  })
}

function makeTechnique(dimension: string, id: string): Record<string, unknown> {
  return {
    id,
    dimension,
    name: `${id}手法`,
    mechanism: '机制',
    transfer: '迁移',
    failureMode: '失效条件',
    evidence: [],
    confidence: 'verified',
    kept: true
  }
}

describe('参考小说专家团与自动基线', () => {
  let db: Database.Database
  let app: FastifyInstance
  let store: NovelStore
  let projectId: string
  let sourceId: string
  let sectionIds: string[]

  beforeAll(async () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    projectId = crypto.randomUUID()
    store.createProject({
      id: projectId,
      title: '专家团测试',
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
      store
    )
    const context = makeMockContext(db)
    const services = { referenceAnalysis, store, context } as unknown as NovelServices

    app = Fastify({ logger: false })
    await app.register(requestContextPlugin)
    await app.register(errorHandlerPlugin)
    // createNovelRoutes 已聚合 reference-analysis-routes 与 auto-baseline
    const routes = createNovelRoutes(services)
    for (const route of routes) {
      app.route({
        method: route.method as any,
        url: `${PREFIX}${route.path}`,
        handler: route.handler as any,
        bodyLimit: route.bodyLimit
      })
    }
    await app.ready()

    // 导入 10 章参考源（分层取样需要多章才能区分头/中/尾）
    const chapters = Array.from({ length: 10 }, (_, index) =>
      `第${index + 1}章 标题${index + 1}\n\n${'夜色压在窗棂上，他没有点灯。'.repeat(20)}`
    ).join('\n\n')
    const preflight = await app.inject({
      method: 'POST',
      url: `${PREFIX}/projects/${projectId}/reference-sources/preflight`,
      payload: { inputKind: 'paste', displayName: '参考小说A', text: chapters }
    })
    expect(preflight.statusCode).toBe(200)
    const draft = preflight.json().data
    const options = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/import-options`,
      payload: {
        encoding: 'utf-8',
        retentionPolicy: 'manual_delete',
        rightsConfirmed: true,
        version: draft.version
      }
    })
    const parsed = await app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${draft.sourceDraftId}/parse`,
      payload: { version: options.json().data.source.version }
    })
    expect(parsed.statusCode).toBe(200)
    sourceId = draft.sourceDraftId
    const sectionsResponse = await app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-sources/${sourceId}/sections`
    })
    sectionIds = (sectionsResponse.json().data as Array<{ id: string }>).map((item) => item.id)
    expect(sectionIds).toHaveLength(10)

    // 建文风档案（auto-baseline 的前置条件）
    const profileResponse = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/projects/${projectId}/writing-style-profile`,
      payload: { name: '测试档案' }
    })
    expect(profileResponse.statusCode).toBe(200)
  })

  afterAll(async () => {
    await app.close()
    db.close()
  })

  it('维度蒸馏：混杂维度只保留目标维度，入库为草稿专家', async () => {
    mockDistillResponse = makeDistillPayload([
      makeTechnique('dialogue_craft', 't1'),
      makeTechnique('action_craft', 't2')
    ])
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${sourceId}/style-team-distill/dimension`,
      payload: { sectionIds, dimension: 'dialogue_craft' }
    })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.skipped).toBe(false)
    expect(data.expert).toMatchObject({
      teamKey: sourceId,
      dimension: 'dialogue_craft',
      reviewStatus: 'draft',
      enabled: false
    })
    // 维度硬过滤：混杂输入只保留 dialogue_craft 那条
    expect(data.expert.techniques).toHaveLength(1)
    expect(data.expert.techniques[0].dimension).toBe('dialogue_craft')

    const stored = store.listStyleExperts(projectId).find((expert) => expert.dimension === 'dialogue_craft')
    expect(stored).toBeDefined()
    expect(stored!.teamKey).toBe(sourceId)
    expect(stored!.reviewStatus).toBe('draft')
    expect(stored!.enabled).toBe(false)
  })

  it('维度蒸馏幂等：同团队同维度重复请求直接跳过', async () => {
    mockDistillResponse = makeDistillPayload([makeTechnique('dialogue_craft', 't9')])
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${sourceId}/style-team-distill/dimension`,
      payload: { sectionIds, dimension: 'dialogue_craft' }
    })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.skipped).toBe(true)
    expect(data.reason).toBe('exists')
    // 幂等跳过不应新增行
    expect(
      store.listStyleExperts(projectId).filter((expert) => expert.dimension === 'dialogue_craft')
    ).toHaveLength(1)
  })

  it('空维度：没有可迁移手法时跳过且不建专家', async () => {
    mockDistillResponse = makeDistillPayload([])
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${sourceId}/style-team-distill/dimension`,
      payload: { sectionIds, dimension: 'conflict_craft' }
    })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.skipped).toBe(true)
    expect(data.reason).toBe('empty')
    expect(
      store.listStyleExperts(projectId).filter((expert) => expert.dimension === 'conflict_craft')
    ).toHaveLength(0)
  })

  it('自动基线：按头/中/尾分层取样正向样本，首条为锚定', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/projects/${projectId}/writing-style-profile/auto-baseline`,
      payload: { sourceId, sectionIds }
    })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.added).toBe(5)
    expect(data.anchorIsNew).toBe(true)

    const profile = store.getWritingStyleProfile(projectId)!
    expect(profile.positiveExamples).toHaveLength(5)
    // 分层位置 [0, 0.1, 0.35, 0.6, 0.85] → 章节序 1/2/4/6/9
    const titles = profile.positiveExamples.map((example) => example.split('\n')[0])
    expect(titles[0]).toContain('第1章')
    expect(titles[1]).toContain('第2章')
    expect(titles[2]).toContain('第4章')
    expect(titles[3]).toContain('第6章')
    expect(titles[4]).toContain('第9章')
  })

  it('自动基线：样本位已满时跳过且不改动档案', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/projects/${projectId}/writing-style-profile/auto-baseline`,
      payload: { sourceId, sectionIds }
    })
    expect(response.statusCode).toBe(200)
    const data = response.json().data
    expect(data.added).toBe(0)
    expect(data.reason).toBe('full')
    expect(store.getWritingStyleProfile(projectId)!.positiveExamples).toHaveLength(5)
  })

  it('专家启用流转：草稿审核启用后脱离待审核态', async () => {
    const expert = store.listStyleExperts(projectId).find((item) => item.dimension === 'dialogue_craft')!
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/projects/${projectId}/writing-style-experts/${expert.id}`,
      payload: { enabled: true }
    })
    expect(response.statusCode).toBe(200)
    const updated = store.listStyleExperts(projectId).find((item) => item.id === expert.id)!
    expect(updated.enabled).toBe(true)
    expect(updated.reviewStatus).toBe('approved')
  })

  it('迁移 119：历史专家默认 approved', () => {
    // 新库默认值验证：直接插入一行不指定 review_status / dimension / team_key
    db.prepare(
      `INSERT INTO novel_style_experts (id, project_id, name, source_title, description,
       distilled_prompt, enabled, sort_order, version, created_at, updated_at)
       VALUES ('legacy-1', ?, '历史专家', '旧来源', '描述', '提示词', 1, 0, 1, 0, 0)`
    ).run(projectId)
    const legacy = db
      .prepare('SELECT review_status, dimension, team_key FROM novel_style_experts WHERE id = ?')
      .get('legacy-1') as { review_status: string; dimension: string | null; team_key: string | null }
    expect(legacy.review_status).toBe('approved')
    expect(legacy.dimension).toBeNull()
    expect(legacy.team_key).toBeNull()
    // 读侧映射：历史行经 store 读出后 reviewStatus 为 approved
    const mapped = store.listStyleExperts(projectId).find((item) => item.id === 'legacy-1')
    expect(mapped?.reviewStatus).toBe('approved')
  })
})
