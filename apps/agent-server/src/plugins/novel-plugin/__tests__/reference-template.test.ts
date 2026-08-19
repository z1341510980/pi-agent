import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { novelMigrations } from '../novel-migrations.js'
import { NovelStore } from '../core/novel-store.js'
import { ReferenceAnalysisStore } from '../core/analysis/reference-analysis-store.js'
import { ReferenceAnalysisService } from '../core/analysis/reference-analysis-service.js'
import { ReferenceAnalysisRunStore } from '../core/analysis/reference-analysis-run-store.js'
import { ReferenceAnalysisRunWorker } from '../core/analysis/reference-analysis-run-worker.js'
import { ReferenceProfileStore } from '../core/analysis/reference-profile-store.js'
import { ReferenceTemplateStore } from '../core/analysis/reference-template-store.js'
import { ReferenceValidationRunStore } from '../core/analysis/reference-validation-run-store.js'
import { ReferenceValidationRunWorker } from '../core/analysis/reference-validation-run-worker.js'
import { createReferenceRunRoutes } from '../routes/reference-run-routes.js'
import { createReferenceTemplateRoutes } from '../routes/reference-template-routes.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { errorHandlerPlugin } from '../../../plugins/error-handler.plugin.js'
import { requestContextPlugin } from '../../../plugins/request-context.plugin.js'

const PREFIX = '/api/plugins/novel'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

/** 按调用序消费 replies：scene×2 → book → （P7）baseline/template/ruleHits */
function createFakeContext(replies: string[]): PluginContext {
  let call = 0
  return {
    createSession: async () => ({
      promptStream: async () => {
        const reply = replies[Math.min(call, replies.length - 1)]
        call += 1
        return reply
      },
      dispose: () => {},
    }),
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  } as unknown as PluginContext
}

const SCENE_REPLY = JSON.stringify({
  observations: [{ metric: 'pacing.hook', value: '章末留钩子', confidence: 0.8, evidence: [] }],
})
const BOOK_REPLY = JSON.stringify({
  spirit: { summary: '克制', rules: [] },
  technique: { summary: '', rules: [] },
  power: { summary: '', rules: [] },
  pacing: { summary: '快节奏', rules: [] },
  findings: [
    { category: 'pacing', observation: '章末留钩子', rule: '每章结尾必须留下悬念钩子', strength: 'hard' },
    { category: 'technique', observation: '短句制造紧张', rule: '用短句提升紧张段落节奏', strength: 'soft' },
  ],
  safetyHints: { directQuotes: [], properNouns: ['怀表镇'], plotSequences: [], uniqueScenes: [] },
})

interface Harness {
  db: Database.Database
  app: FastifyInstance
  profileStore: ReferenceProfileStore
  templateStore: ReferenceTemplateStore
  validationStore: ReferenceValidationRunStore
  validationWorker: ReferenceValidationRunWorker
  profileId: string
  dispose: () => void
}

async function createHarness(p7Replies: string[]): Promise<Harness> {
  const db = createDb()
  const novelStore = new NovelStore(db)
  const projectId = randomUUID()
  novelStore.createProject({
    id: projectId, title: 'P6P7', genre: 'test', synopsis: '', targetWords: 3000,
    currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
  })
  const referenceStore = new ReferenceAnalysisStore(db)
  const reference = new ReferenceAnalysisService(referenceStore, novelStore)
  const text = [
    '第一章 起点',
    '清晨的雾还没有散。他站在旧桥上，看河水从桥洞里涌出来。',
    '第二章 转折',
    '信封放在桌上，字迹陌生。他把窗推开一条缝，风灌了进来。',
  ].join('\n')
  const preflight = reference.preflight(projectId, { inputKind: 'paste', displayName: '测试参考', text })
  reference.updateImportOptions(preflight.sourceDraftId, {
    version: preflight.version, encoding: preflight.encoding,
    retentionPolicy: 'keep_local', rightsConfirmed: true,
  })
  const source = referenceStore.requireSource(preflight.sourceDraftId)
  reference.parse(source.id, source.version)

  const runStore = new ReferenceAnalysisRunStore(db)
  const profileStore = new ReferenceProfileStore(db)
  const analysisContext = createFakeContext([SCENE_REPLY, SCENE_REPLY, BOOK_REPLY])
  const analysisWorker = new ReferenceAnalysisRunWorker(analysisContext, runStore, profileStore, reference)
  const templateStore = new ReferenceTemplateStore(db, profileStore)
  const validationStore = new ReferenceValidationRunStore(db)
  const validationWorker = new ReferenceValidationRunWorker(
    createFakeContext(p7Replies), validationStore, templateStore, profileStore, reference,
  )

  const services = {
    context: analysisContext, store: novelStore, referenceAnalysis: reference,
    referenceAnalysisRuns: runStore, referenceAnalysisWorker: analysisWorker, referenceProfiles: profileStore,
    referenceTemplates: templateStore, referenceValidationRuns: validationStore, referenceValidationWorker: validationWorker,
  } as unknown as NovelServices

  const app = Fastify({ logger: false })
  await app.register(requestContextPlugin)
  await app.register(errorHandlerPlugin)
  app.decorate('providerConfigStore', {
    get: (id: string) =>
      id === 'provider-1'
        ? { id, name: '测试 Provider', models: [{ id: 'model-1', name: '测试模型', contextWindow: 32768, maxTokens: 4096, cost: { input: 2, output: 8 } }] }
        : undefined,
  } as any)
  for (const route of [...createReferenceRunRoutes(services), ...createReferenceTemplateRoutes(services)]) {
    app.route({ method: route.method as any, url: `${PREFIX}${route.path}`, handler: route.handler as any })
  }

  // P4 全链路 → awaiting_review + profile
  const estimate = reference.estimateBudget(source.id, {
    providerId: 'provider-1', modelId: 'model-1',
    model: { contextWindow: 32768, maxTokens: 4096, cost: { input: 2, output: 8 } } as never,
  })
  const start = await app.inject({
    method: 'POST', url: `${PREFIX}/reference-sources/${source.id}/analysis-runs`,
    payload: { providerId: 'provider-1', modelId: 'model-1', estimateHash: estimate.estimateHash, highCostConfirmed: true },
  })
  const runId = start.json().data.id
  await analysisWorker.run(runId)
  const profileId = runStore.getRun(runId)!.profileId!

  return {
    db, app, profileStore, templateStore, validationStore, validationWorker, profileId,
    dispose: () => db.close(),
  }
}

beforeAll(() => { vi.setConfig({ testTimeout: 30_000 }) })
afterAll(() => { vi.setConfig({ testTimeout: 5_000 }) })

describe('P6 应用预览与模板草稿', () => {
  it('未完成审核时创建模板被拒；审核后预览给出规则/预算/残留并创建草稿', async () => {
    const h = await createHarness([])

    // 未审核 → 409
    const early = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/template-drafts`,
      payload: { name: '快节奏模板' },
    })
    expect(early.statusCode).toBe(409)

    // 全部接受
    const profile = h.profileStore.getProfile(h.profileId)!
    for (const finding of profile.findings) {
      await h.app.inject({
        method: 'PATCH', url: `${PREFIX}/reference-profiles/${h.profileId}/findings/${finding.key}/review`,
        payload: { decision: 'accepted', agentTargets: ['Writer'] },
      })
    }

    // 预览：规则编译 + Agent 预算 + 无阻断
    const preview = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/application-preview`,
      payload: {},
    })
    expect(preview.statusCode).toBe(200)
    const previewData = preview.json().data
    console.log('🔍 [TEST] previewData.agentPromptDiffs:', JSON.stringify(previewData.agentPromptDiffs, null, 2));
    console.log('🔍 [TEST] previewData.compiledRules:', JSON.stringify(previewData.compiledRules, null, 2));
    console.log('🔍 [TEST] previewData.blocking:', previewData.blocking);
    expect(previewData.compiledRules.pacing).toHaveLength(1)
    expect(previewData.compiledRules.technique).toHaveLength(1)
    expect(previewData.agentPromptDiffs.find((item: any) => item.agent === 'Writer').ruleCount).toBe(2)
    expect(previewData.blocking).toBe(false)
    expect(previewData.previewHash).toHaveLength(64)

    // 创建草稿（携带 previewHash）
    

    const draft = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/template-drafts`,
      payload: { name: '快节奏模板', description: '测试', previewHash: previewData.previewHash },
    })
    expect(draft.statusCode).toBe(200)
    const { template, version } = draft.json().data
    expect(template.status).toBe('draft')
    expect(version.version).toBe(1)
    expect(version.pacingRules).toHaveLength(1)

    // 版本修订：改强度与 Agent → v2；幂等创建返回同一模板
    const revision = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-template-versions/${version.id}/revisions`,
      payload: {
        ruleOverrides: [{ findingKey: version.pacingRules[0].findingKey, strength: 'soft' }],
        changeSummary: '降级为 soft',
      },
    })
    expect(revision.statusCode).toBe(200)
    expect(revision.json().data.version.version).toBe(2)
    expect(revision.json().data.version.pacingRules[0].strength).toBe('soft')

    const again = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/template-drafts`,
      payload: { name: '快节奏模板-2' },
    })
    expect(again.json().data.template.id).toBe(template.id)

    // 模板列表 / 详情
    const list = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-templates` })
    expect(list.statusCode).toBe(200)
    expect(list.json().data.length).toBeGreaterThanOrEqual(1)
    const detail = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-templates/${template.id}` })
    expect(detail.json().data.versions).toHaveLength(2)
    h.dispose()
  })

  it('规则文本含参考专名时预览阻断（422）', async () => {
    const h = await createHarness([])
    const profile = h.profileStore.getProfile(h.profileId)!
    // 让一条 finding 的规则包含安全报告中的专名「怀表镇」
    h.profileStore.reviewFinding(h.profileId, {
      findingKey: profile.findings[0]!.key,
      decision: 'edited',
      editedRule: `在怀表镇的段落里使用短句`,
      strength: 'hard',
    })
    const preview = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/application-preview`,
      payload: {},
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data.blocking).toBe(true)
    expect(preview.json().data.sourceSpecificMatches.length).toBeGreaterThan(0)

    const draft = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/template-drafts`,
      payload: { name: '含残留模板' },
    })
    expect(draft.statusCode).toBe(422)
    h.dispose()
  })
})

describe('P7 同场景验证', () => {
  const BASELINE_OUTPUT = '雾还没有散。他站在桥上，看河水涌出来。'
  const TEMPLATE_OUTPUT = '雾没散。他站上桥。河水涌出桥洞，声音很近。'

  it('原创场景：双路生成→规则命中→完成；决定 accepted 后 publishable', async () => {
    const h = await createHarness([BASELINE_OUTPUT, TEMPLATE_OUTPUT, JSON.stringify({ hits: ['pacing-001'], misses: [] })])
    const profile = h.profileStore.getProfile(h.profileId)!
    for (const finding of profile.findings) {
      h.profileStore.reviewFinding(h.profileId, { findingKey: finding.key, decision: 'accepted', agentTargets: ['Writer'] })
    }
    const draft = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/template-drafts`,
      payload: { name: '验证模板' },
    })
    const versionId = draft.json().data.version.id

    const scenarioFacts = '原创场景：一位钟表匠在暴雨夜赶修一座停摆的车站大钟，学徒在旁递工具。'
    // 未确认费用 → 409
    const noConfirm = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-template-versions/${versionId}/validation-runs`,
      payload: { scenarioSource: 'system_original', scenarioFacts, providerId: 'provider-1', modelId: 'model-1', highCostConfirmed: false },
    })
    expect(noConfirm.statusCode).toBe(409)

    const created = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-template-versions/${versionId}/validation-runs`,
      payload: { scenarioSource: 'system_original', scenarioFacts, providerId: 'provider-1', modelId: 'model-1', highCostConfirmed: true },
    })
    expect(created.statusCode).toBe(200)
    const run = created.json().data
    expect(run.fixedFactsHash).toHaveLength(64)
    await h.validationWorker.run(run.id, scenarioFacts)

    const detail = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-validation-runs/${run.id}` })
    expect(detail.statusCode).toBe(200)
    const done = detail.json().data
    expect(done.status).toBe('completed')
    expect(done.ruleHits.hits).toContain('pacing-001')
    expect(done.baselineOutput).toContain('雾')
    expect(done.safetyReport.similarity.ngramOverlap).toBeLessThan(0.25)

    // 决定：accepted（无阻断时）
    const decision = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-validation-runs/${run.id}/decision`,
      payload: { decision: 'accepted', note: '通过' },
    })
    expect(decision.statusCode).toBe(200)
    expect(decision.json().data.publishable).toBe(true)
    h.dispose()
  })

  it('场景含参考专名 → 422 拒绝；相似度超阈值 → 阻断决定', async () => {
    const h = await createHarness([])
    const profile = h.profileStore.getProfile(h.profileId)!
    for (const finding of profile.findings) {
      h.profileStore.reviewFinding(h.profileId, { findingKey: finding.key, decision: 'accepted', agentTargets: ['Writer'] })
    }
    const draft = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/template-drafts`,
      payload: { name: '阻断模板' },
    })
    const versionId = draft.json().data.version.id

    // 场景包含参考专名「怀表镇」→ 422
    const badScenario = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-template-versions/${versionId}/validation-runs`,
      payload: { scenarioSource: 'user_input', scenarioFacts: '怀表镇上的一位少年发现旧钟楼里藏着秘密。', providerId: 'provider-1', modelId: 'model-1', highCostConfirmed: true },
    })
    expect(badScenario.statusCode).toBe(422)

    // 直接落库一个高相似 run 验证决定阻断：模板输出直接复现参考原文
    const referenceText = '清晨的雾还没有散。他站在旧桥上，看河水从桥洞里涌出来。'
    const run = h.validationStore.createRun({
      templateVersionId: versionId, scenarioSource: 'system_original',
      scenarioFacts: '原创场景', providerId: 'provider-1', modelId: 'model-1',
    })
    h.validationStore.saveGenerationConfig(run.id, {}, {})
    h.validationStore.saveOutputs(run.id, {
      baselineOutput: '基准输出', templateOutput: referenceText, usage: {}, cost: {},
    })
    h.validationStore.completeRun(run.id, {
      ruleHits: { hits: [], misses: [] },
      safetyReport: { similarity: { ngramOverlap: 0.9, longestRun: 20 }, blockers: ['相似度超阈值'], degraded: false },
    })
    const decision = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-validation-runs/${run.id}/decision`,
      payload: { decision: 'accepted' },
    })
    expect(decision.statusCode).toBe(409)
    h.dispose()
  })

  it('regenerate 复用同一 facts hash；feedback 生成新草稿版本', async () => {
    const feedbackReply = JSON.stringify({
      suggestions: [{ findingKey: 'pacing-001', suggestedRule: '章末钩子改为一问一答收束', reason: '反馈要求更柔和' }],
    })
    const h = await createHarness([BASELINE_OUTPUT, TEMPLATE_OUTPUT, JSON.stringify({ hits: [], misses: ['pacing-001'] }), feedbackReply])
    const profile = h.profileStore.getProfile(h.profileId)!
    const pacingFinding = profile.findings.find((finding) => finding.category === 'pacing')!
    for (const finding of profile.findings) {
      h.profileStore.reviewFinding(h.profileId, { findingKey: finding.key, decision: 'accepted', agentTargets: ['Writer'] })
    }
    const draft = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-profiles/${h.profileId}/template-drafts`,
      payload: { name: '整改模板' },
    })
    const versionId = draft.json().data.version.id
    const scenarioFacts = '原创场景：灯塔守护员在风暴后清点损坏的灯芯。'
    const created = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-template-versions/${versionId}/validation-runs`,
      payload: { scenarioSource: 'system_original', scenarioFacts, providerId: 'provider-1', modelId: 'model-1', highCostConfirmed: true },
    })
    const runId = created.json().data.id
    await h.validationWorker.run(runId, scenarioFacts)

    // feedback → 新草稿版本（规则被修改）
    const feedback = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-validation-runs/${runId}/feedback`,
      payload: { feedback: '钩子太硬，改为更柔和的收束', targetFindingKeys: [pacingFinding.key] },
    })
    expect(feedback.statusCode).toBe(200)
    const feedbackData = feedback.json().data
    expect(feedbackData.ruleSuggestions).toHaveLength(1)
    expect(feedbackData.newVersionId).not.toBeNull()
    const newVersion = h.templateStore.getVersion(feedbackData.newVersionId!)
    expect(newVersion!.pacingRules[0]!.rule).toContain('一问一答')

    // regenerate 复用同一 facts hash 与场景版本
    const regenerate = await h.app.inject({
      method: 'POST', url: `${PREFIX}/reference-validation-runs/${runId}/regenerate`,
      payload: { highCostConfirmed: true, templateVersionId: feedbackData.newVersionId },
    })
    expect(regenerate.statusCode).toBe(200)
    const next = regenerate.json().data
    expect(next.fixedFactsHash).toBe(created.json().data.fixedFactsHash)
    expect(next.fixedScenarioVersion).toBe(created.json().data.fixedScenarioVersion)
    expect(next.templateVersionId).toBe(feedbackData.newVersionId)
    // §9 固定输入不变量：regenerate 复用同一场景事实文本，执行器不会拿到空场景
    expect(next.scenarioFacts).toBe(scenarioFacts)
    expect(created.json().data.scenarioFacts).toBe(scenarioFacts)
    h.dispose()
  })
})