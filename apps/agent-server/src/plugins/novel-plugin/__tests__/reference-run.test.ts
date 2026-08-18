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
import { createReferenceRunRoutes } from '../routes/reference-run-routes.js'
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

interface Harness {
  db: Database.Database
  app: FastifyInstance
  novelStore: NovelStore
  reference: ReferenceAnalysisService
  runStore: ReferenceAnalysisRunStore
  worker: ReferenceAnalysisRunWorker
  profileStore: ReferenceProfileStore
  sourceId: string
  estimateHash: string
}

/** 场景级/书级两路 LLM 假回复 */
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

async function createHarness(replies: string[]): Promise<Harness> {
  const db = createDb()
  const novelStore = new NovelStore(db)
  const projectId = randomUUID()
  novelStore.createProject({
    id: projectId, title: 'P4P5', genre: 'test', synopsis: '', targetWords: 3000,
    currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active',
  })
  const referenceStore = new ReferenceAnalysisStore(db)
  const reference = new ReferenceAnalysisService(referenceStore, novelStore)

  // 阶段 1：预检（paste 文本含两章）→ 导入选项 → 解析
  const text = [
    '第一章 起点',
    '夜色里他握紧了手中的旧怀表，表盖内侧刻着一个陌生的名字。他沿着河堤走出很远，直到灯火在身后缩成一点。',
    '第二章 转折',
    '第二天清晨，那封信被放到了桌上。信封上的字迹与他记忆里的完全不同，他忽然明白昨夜的一切都是安排好的。',
  ].join('\n')
  const preflight = reference.preflight(projectId, { inputKind: 'paste', displayName: '测试参考', text })
  reference.updateImportOptions(preflight.sourceDraftId, {
    version: preflight.version,
    encoding: preflight.encoding,
    retentionPolicy: 'keep_local',
    rightsConfirmed: true,
  })
  const source = referenceStore.requireSource(preflight.sourceDraftId)
  reference.parse(source.id, source.version)

  const runStore = new ReferenceAnalysisRunStore(db)
  const profileStore = new ReferenceProfileStore(db)
  const context = createFakeContext(replies)
  const worker = new ReferenceAnalysisRunWorker(context, runStore, profileStore, reference)

  const services = {
    context,
    referenceAnalysis: reference,
    referenceAnalysisRuns: runStore,
    referenceAnalysisWorker: worker,
    referenceProfiles: profileStore,
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
  for (const route of createReferenceRunRoutes(services)) {
    app.route({ method: route.method as any, url: `${PREFIX}${route.path}`, handler: route.handler as any })
  }

  const estimate = reference.estimateBudget(source.id, {
    providerId: 'provider-1', modelId: 'model-1',
    model: { contextWindow: 32768, maxTokens: 4096, cost: { input: 2, output: 8 } } as never,
  })
  return { db, app, novelStore, reference, runStore, worker, profileStore, sourceId: source.id, estimateHash: estimate.estimateHash }
}

const SCENE_REPLY = JSON.stringify({
  observations: [
    { metric: 'pacing.sentence_rhythm', value: '短句为主，节奏偏快', confidence: 0.8, evidence: ['夜色里他握紧了手中的旧怀表'] },
    { metric: 'technique.sensory_detail', value: '触觉与视觉细节交替', confidence: 0.7, evidence: [] },
  ],
})

const BOOK_REPLY = JSON.stringify({
  spirit: { summary: '冷静克制的叙事精神', rules: ['避免直接抒情'] },
  technique: { summary: '以物件承载情绪', rules: ['关键情绪通过道具呈现'] },
  power: { summary: '笔力集中在中段', rules: [] },
  pacing: { summary: '逐章推进带钩子', rules: ['章末留悬念'] },
  findings: [
    { category: 'pacing', observation: '每章结尾留钩子', rule: '章末必须留悬念', strength: 'hard', evidence: ['直到灯火在身后缩成一点'] },
    { category: 'technique', observation: '旧物承载记忆', rule: '用旧物触发回忆', strength: 'soft', evidence: [] },
  ],
  safetyHints: { directQuotes: ['他沿着河堤走出很远，直到灯火在身后缩成一点'], properNouns: [], plotSequences: [], uniqueScenes: [] },
})

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000 })
})

describe('P4 远端分析 run 闭环', () => {
  it('启动→全阶段推进→awaiting_review，事件按序落库且不含原文', async () => {
    const h = await createHarness([SCENE_REPLY, SCENE_REPLY, BOOK_REPLY])
    const res = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: { providerId: 'provider-1', modelId: 'model-1', estimateHash: h.estimateHash, highCostConfirmed: true },
    })
    expect(res.statusCode).toBe(200)
    const { data: run } = res.json()
    await h.worker.run(run.id)

    const final = h.runStore.getRun(run.id)!
    expect(final.status).toBe('awaiting_review')
    expect(final.currentStage).toBe('awaiting_review')
    expect(final.profileId).not.toBeNull()
    expect(final.actualUsage.llmCalls).toBe(3) // 2 章 scene + 1 book

    const events = h.runStore.listEvents(run.id)
    const types = events.map((event) => event.type)
    expect(types).toContain('run_queued')
    expect(types).toContain('stage_changed')
    expect(types).toContain('checkpoint_saved')
    expect(types).toContain('result_ready')
    // 事件只存摘要：不得包含完整正文片段
    for (const event of events) {
      expect(JSON.stringify(event.payload)).not.toContain('夜色里他握紧')
    }

    // observations：measurement（本地）+ scene（LLM）+ chapter（聚合）
    const all = h.runStore.listObservations(run.id)
    expect(all.filter((item) => item.level === 'measurement').length).toBeGreaterThanOrEqual(3)
    expect(all.filter((item) => item.level === 'scene').length).toBe(4)
    expect(all.filter((item) => item.level === 'chapter').length).toBe(2)
    // 安全核对：直接引用已核实（存在于原文）
    expect(all.filter((item) => item.metric === 'safety.direct_quote').length).toBe(1)

    // GET 详情/observations/事件重放
    const detail = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-analysis-runs/${run.id}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data.status).toBe('awaiting_review')
    const observations = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-analysis-runs/${run.id}/observations?level=scene&limit=2` })
    expect(observations.statusCode).toBe(200)
    expect(observations.json().data.observations).toHaveLength(2)
    expect(observations.json().data.nextCursor).toBe(2)
    const sse = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-analysis-runs/${run.id}/events` })
    expect(sse.statusCode).toBe(200)
    expect(sse.body).toContain('referenceRunEvent')
    h.db.close()
  })

  it('估算过期启动被拒（409），未确认费用被拒', async () => {
    const h = await createHarness([SCENE_REPLY])
    const stale = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: { providerId: 'provider-1', modelId: 'model-1', estimateHash: '0'.repeat(64), highCostConfirmed: true },
    })
    expect(stale.statusCode).toBe(409)
    const unconfirmed = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: { providerId: 'provider-1', modelId: 'model-1', estimateHash: h.estimateHash, highCostConfirmed: false },
    })
    expect(unconfirmed.statusCode).toBe(409)
    h.db.close()
  })

  it('取消保留 checkpoint；恢复复用 checkpoint 不重复计费', async () => {
    // 第 2 章 scene 失败（非法 JSON）→ run failed；checkpoint 已含第 1 章
    const h = await createHarness([SCENE_REPLY, 'not-json'])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: { providerId: 'provider-1', modelId: 'model-1', estimateHash: h.estimateHash, highCostConfirmed: true },
    })
    const runId = start.json().data.id
    await h.worker.run(runId)
    const failed = h.runStore.getRun(runId)!
    expect(failed.status).toBe('failed')
    expect(failed.checkpoint).not.toBeNull()
    expect((failed.checkpoint!.completedSectionIds as string[]).length).toBe(1)

    const cancel = await h.app.inject({ method: 'POST', url: `${PREFIX}/reference-analysis-runs/${runId}/cancel`, payload: { reason: '测试' } })
    expect(cancel.statusCode).toBe(200)
    expect(cancel.json().data.status).toBe('cancelled')

    // 恢复：新 attempt 继承 checkpoint
    const resume = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-analysis-runs/${runId}/resume`,
      payload: { highCostConfirmed: true },
    })
    expect(resume.statusCode).toBe(200)
    const resumedRun = resume.json().data
    expect(resumedRun.attempt).toBe(2)
    expect(resumedRun.parentAttemptId).toBe(runId)
    expect(resumedRun.checkpoint.completedSectionIds).toHaveLength(1)
    h.db.close()
  })
})

describe('P5 档案与 finding 审核', () => {
  it('findings 列表/单项审核/批量审核生成新版本/安全报告/证据定位', async () => {
    const h = await createHarness([SCENE_REPLY, SCENE_REPLY, BOOK_REPLY])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: { providerId: 'provider-1', modelId: 'model-1', estimateHash: h.estimateHash, highCostConfirmed: true },
    })
    const run = h.runStore.getRun(start.json().data.id)!
    await h.worker.run(run.id)
    const profileId = h.runStore.getRun(run.id)!.profileId!

    // 档案详情
    const profileRes = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-profiles/${profileId}` })
    expect(profileRes.statusCode).toBe(200)
    const profile = profileRes.json().data
    expect(profile.version).toBe(1)
    expect(profile.findings).toHaveLength(2)
    expect(profile.spirit.summary).toContain('克制')

    // findings + 计数
    const findingsRes = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-profiles/${profileId}/findings?category=pacing` })
    expect(findingsRes.statusCode).toBe(200)
    expect(findingsRes.json().data.findings).toHaveLength(1)
    expect(findingsRes.json().data.counts.byCategory.pacing).toBe(1)

    // 证据定位（原文存在 → 偏移可用）
    const evidenceRes = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-profiles/${profileId}/findings/pacing-001/evidence` })
    expect(evidenceRes.statusCode).toBe(200)
    const evidence = evidenceRes.json().data
    expect(evidence.evidence[0].available).toBe(true)
    expect(evidence.evidence[0].sectionId).not.toBeNull()

    // 单项审核：非法 Agent 目标（Memory 不接收参考分析）被 schema 拒绝
    const badAgent = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/reference-profiles/${profileId}/findings/pacing-001/review`,
      payload: { decision: 'accepted', agentTargets: ['Memory'] },
    })
    expect(badAgent.statusCode).toBe(400)
    // 合法单项审核
    const single = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/reference-profiles/${profileId}/findings/technique-001/review`,
      payload: { decision: 'edited', editedRule: '用旧物触发回忆（编辑后）', strength: 'hard', agentTargets: ['Writer', 'Reviser'] },
    })
    expect(single.statusCode).toBe(200)
    expect(single.json().data.review.decision).toBe('edited')
    expect(single.json().data.review.agentTargets).toEqual(['Writer', 'Reviser'])

    // 批量审核 → 新草稿版本 v2
    const batch = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-profiles/${profileId}/finding-reviews/batch`,
      payload: {
        version: 1,
        reviews: [
          { findingKey: 'pacing-001', decision: 'accepted', promptEnabled: true, agentTargets: ['Director'] },
          { findingKey: 'technique-001', decision: 'accepted', note: '保留编辑值' },
        ],
      },
    })
    // technique-001 已审核会被跳过；pacing-001 进入批次
    expect(batch.statusCode).toBe(200)
    const next = batch.json().data.profile
    expect(next.version).toBe(2)
    expect(next.parentVersionId).toBe(profileId)

    // 版本列表 + 比较
    const versions = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-profiles/${profileId}/versions` })
    expect(versions.statusCode).toBe(200)
    expect(versions.json().data).toHaveLength(2)
    const compare = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-profiles/${profileId}/compare?fromVersionId=${profileId}&toVersionId=${next.id}`,
    })
    expect(compare.statusCode).toBe(200)
    expect(compare.json().data.findingChanges.length).toBeGreaterThan(0)

    // 安全报告：直接引用已核实 → blocking
    const safety = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-profiles/${profileId}/safety-report` })
    expect(safety.statusCode).toBe(200)
    expect(safety.json().data.blocking).toBe(true)
    expect(safety.json().data.directQuotes).toHaveLength(1)
    h.db.close()
  })

  it('原文删除后证据接口返回 410', async () => {
    const h = await createHarness([SCENE_REPLY, SCENE_REPLY, BOOK_REPLY])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: { providerId: 'provider-1', modelId: 'model-1', estimateHash: h.estimateHash, highCostConfirmed: true },
    })
    const run = h.runStore.getRun(start.json().data.id)!
    await h.worker.run(run.id)
    const profileId = h.runStore.getRun(run.id)!.profileId!
    // 清空 sections 模拟原文删除
    h.db.prepare('DELETE FROM novel_reference_sections WHERE source_id = ?').run(h.sourceId)
    const evidenceRes = await h.app.inject({ method: 'GET', url: `${PREFIX}/reference-profiles/${profileId}/findings/pacing-001/evidence` })
    expect(evidenceRes.statusCode).toBe(410)
    h.db.close()
  })
})

afterAll(() => {
  vi.setConfig({ testTimeout: 5_000 })
})
