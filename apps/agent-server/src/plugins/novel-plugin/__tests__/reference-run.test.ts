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
  projectId: string
  sourceId: string
  estimateHash: string
  sessionOptions: Array<{
    modelId?: { provider: string; modelId: string }
    userMessage: string
    tools?: unknown
    responseJsonSchema?: { name: string }
  }>
  genericCallLogs: Array<{ agentId: string }>
}

/** 场景级/书级两路 LLM 假回复 */
function createFakeContext(
  replies: string[],
  genericCallLogs: Array<{ agentId: string }> = [],
  options: {
    promptReplies?: string[]
    /** 工具调用路径：第 N 个会话的提交工具直接以此 payload 执行（模拟模型发起 tool call） */
    toolPayloads?: Array<Record<string, unknown> | undefined>
  } = {}
): PluginContext {
  let call = 0
  let promptCall = 0
  let createdSessions = 0

  function deepReplaceSectionId(value: unknown, sectionId: string): unknown {
    if (typeof value === 'string') return value.replaceAll('__SECTION_ID__', sectionId)
    if (Array.isArray(value)) return value.map((item) => deepReplaceSectionId(item, sectionId))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, deepReplaceSectionId(item, sectionId)])
      )
    }
    return value
  }

  return {
    createSession: async (sessionOptions: {
      userMessage: string
      modelId?: { provider: string; modelId: string }
      tools?: Array<{ execute: (id: string, args: unknown) => Promise<unknown> }>
    }) => {
      const sessionIndex = createdSessions
      createdSessions += 1
      const toolPayload =
        options.toolPayloads && typeof options.toolPayloads[sessionIndex] !== 'undefined'
          ? options.toolPayloads[sessionIndex]
          : undefined
      return {
        promptStream: async () => {
          // ── 工具路径模拟：模型发起 tool call → SDK 执行工具 → 助手仅回确认语 ──
          if (
            toolPayload !== undefined &&
            Array.isArray(sessionOptions.tools) &&
            sessionOptions.tools.length > 0
          ) {
            const tool = sessionOptions.tools[0]!
            const sectionId =
              sessionOptions.userMessage.match(/sectionId=([^\s\]]+)/)?.[1] ?? ''
            await tool.execute('fake-tool-call', deepReplaceSectionId(toolPayload, sectionId))
            return '已通过结构化提交工具入库。'
          }
          const reply = replies[Math.min(call, replies.length - 1)]
          call += 1
          const sectionId = sessionOptions.userMessage.match(/sectionId=([^\s\]]+)/)?.[1] ?? ''
          return reply.replaceAll('__SECTION_ID__', sectionId)
        },
        // JSON 解析失败后的同会话修复轮；按调用顺序消费修复回复队列
        prompt: async () => {
          const reply =
            options.promptReplies?.[Math.min(promptCall, options.promptReplies.length - 1)] ?? ''
          promptCall += 1
          const sectionId = sessionOptions.userMessage.match(/sectionId=([^\s\]]+)/)?.[1] ?? ''
          return reply.replaceAll('__SECTION_ID__', sectionId)
        },
        dispose: () => {}
      }
    },
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    agentCallLogger: { record: (entry: { agentId: string }) => genericCallLogs.push(entry) }
  } as unknown as PluginContext
}

async function createHarness(
  replies: string[],
  fakeOptions: {
    promptReplies?: string[]
    toolPayloads?: Array<Record<string, unknown> | undefined>
  } = {}
): Promise<Harness> {
  const db = createDb()
  const novelStore = new NovelStore(db)
  const projectId = randomUUID()
  novelStore.createProject({
    id: projectId,
    title: 'P4P5',
    genre: 'test',
    synopsis: '',
    targetWords: 3000,
    currentVolume: 1,
    currentChapter: 0,
    currentStage: 'setup',
    status: 'active'
  })
  const referenceStore = new ReferenceAnalysisStore(db)
  const reference = new ReferenceAnalysisService(referenceStore, novelStore)

  // 阶段 1：预检（paste 文本含两章）→ 导入选项 → 解析
  const text = [
    '第一章 起点',
    '夜色里他握紧了手中的旧怀表，表盖内侧刻着一个陌生的名字。他沿着河堤走出很远，直到灯火在身后缩成一点。',
    '第二章 转折',
    '第二天清晨，那封信被放到了桌上。信封上的字迹与他记忆里的完全不同，他忽然明白昨夜的一切都是安排好的。'
  ].join('\n')
  const preflight = reference.preflight(projectId, {
    inputKind: 'paste',
    displayName: '测试参考',
    text
  })
  reference.updateImportOptions(preflight.sourceDraftId, {
    version: preflight.version,
    encoding: preflight.encoding,
    retentionPolicy: 'keep_local',
    rightsConfirmed: true
  })
  const source = referenceStore.requireSource(preflight.sourceDraftId)
  reference.parse(source.id, source.version)

  const runStore = new ReferenceAnalysisRunStore(db)
  const profileStore = new ReferenceProfileStore(db)
  const sessionOptions: Array<{
    modelId?: { provider: string; modelId: string }
    userMessage: string
    tools?: unknown
    responseJsonSchema?: { name: string }
  }> = []
  const genericCallLogs: Array<{ agentId: string }> = []
  const context = createFakeContext(replies, genericCallLogs, fakeOptions)
  const originalCreateSession = context.createSession
  context.createSession = async (options) => {
    sessionOptions.push({
      modelId: options.modelId,
      userMessage: options.userMessage,
      // 记录原始 options 供 A2 断言：strict 模式无工具、携带 json_schema
      tools: (options as { tools?: unknown }).tools,
      responseJsonSchema: (options as { responseJsonSchema?: { name: string } }).responseJsonSchema
    })
    return originalCreateSession(options)
  }
  const worker = new ReferenceAnalysisRunWorker(
    context,
    runStore,
    profileStore,
    reference,
    novelStore
  )

  const services = {
    context,
    referenceAnalysis: reference,
    referenceAnalysisRuns: runStore,
    referenceAnalysisWorker: worker,
    referenceProfiles: profileStore
  } as unknown as NovelServices

  const app = Fastify({ logger: false })
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
              }
            ]
          }
        : undefined
  } as any)
  for (const route of createReferenceRunRoutes(services)) {
    app.route({
      method: route.method as any,
      url: `${PREFIX}${route.path}`,
      handler: route.handler as any
    })
  }

  const estimate = reference.estimateBudget(source.id, {
    providerId: 'provider-1',
    modelId: 'model-1',
    model: { contextWindow: 32768, maxTokens: 4096, cost: { input: 2, output: 8 } } as never
  })
  return {
    db,
    app,
    novelStore,
    reference,
    runStore,
    worker,
    profileStore,
    projectId,
    sourceId: source.id,
    estimateHash: estimate.estimateHash,
    sessionOptions,
    genericCallLogs
  }
}

const SCENE_REPLY = JSON.stringify({
  observations: [
    {
      sectionId: '__SECTION_ID__',
      metric: 'pacing.sentence_rhythm',
      value: '短句为主，节奏偏快',
      confidence: 0.8,
      evidence: ['夜色里他握紧了手中的旧怀表']
    },
    {
      sectionId: '__SECTION_ID__',
      metric: 'technique.sensory_detail',
      value: '触觉与视觉细节交替',
      confidence: 0.7,
      evidence: []
    }
  ]
})

const BOOK_REPLY = JSON.stringify({
  spirit: { summary: '冷静克制的叙事精神', rules: ['避免直接抒情'] },
  technique: { summary: '以物件承载情绪', rules: ['关键情绪通过道具呈现'] },
  power: { summary: '笔力集中在中段', rules: [] },
  pacing: { summary: '逐章推进带钩子', rules: ['章末留悬念'] },
  findings: [
    {
      category: 'pacing',
      observation: '每章结尾留钩子',
      rule: '章末必须留悬念',
      strength: 'hard',
      evidence: ['直到灯火在身后缩成一点']
    },
    {
      category: 'technique',
      observation: '旧物承载记忆',
      rule: '用旧物触发回忆',
      strength: 'soft',
      evidence: []
    }
  ],
  safetyHints: {
    directQuotes: ['他沿着河堤走出很远，直到灯火在身后缩成一点'],
    properNouns: [],
    plotSequences: [],
    uniqueScenes: []
  }
})

const fencedJson = (value: string): string => `\`\`\`json\n${value}\n\`\`\``

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000 })
})

describe('P4 远端分析 run 闭环', () => {
  it('启动→全阶段推进→awaiting_review，事件按序落库且不含原文', async () => {
    const h = await createHarness([SCENE_REPLY, BOOK_REPLY])
    const res = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })
    expect(res.statusCode).toBe(200)
    const { data: run } = res.json()
    await h.worker.run(run.id)

    const final = h.runStore.getRun(run.id)!
    expect(final.status).toBe('awaiting_review')
    expect(final.currentStage).toBe('awaiting_review')
    expect(final.profileId).not.toBeNull()
    expect(final.actualUsage.llmCalls).toBe(2) // 1 个章节分包 + 1 次全书汇总
    expect(h.sessionOptions.map((options) => options.modelId)).toEqual([
      { provider: 'provider-1', modelId: 'model-1' },
      { provider: 'provider-1', modelId: 'model-1' }
    ])
    expect(h.sessionOptions[0]!.userMessage.match(/sectionId=/g)).toHaveLength(2)

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

    // observations：measurement（本地）+ scene（LLM）+ chunk（聚合）
    const all = h.runStore.listObservations(run.id)
    expect(all.filter((item) => item.level === 'measurement').length).toBeGreaterThanOrEqual(3)
    expect(all.filter((item) => item.level === 'scene').length).toBe(2)
    expect(all.filter((item) => item.level === 'chapter').length).toBe(1)
    // 安全核对：直接引用已核实（存在于原文）
    expect(all.filter((item) => item.metric === 'safety.direct_quote').length).toBe(1)

    // GET 详情/observations/事件重放
    const detail = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-analysis-runs/${run.id}`
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data.status).toBe('awaiting_review')
    const observations = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-analysis-runs/${run.id}/observations?level=scene&limit=2`
    })
    expect(observations.statusCode).toBe(200)
    expect(observations.json().data.observations).toHaveLength(2)
    expect(observations.json().data.nextCursor).toBeNull()
    const sse = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-analysis-runs/${run.id}/events`
    })
    expect(sse.statusCode).toBe(200)
    expect(sse.body).toContain('referenceRunEvent')
    const projectLogs = h.novelStore.listAgentLogsByProject(h.projectId, 10)
    expect(
      projectLogs.filter((log) => log.agentType.startsWith('reference-analysis-'))
    ).toHaveLength(2)
    expect(h.genericCallLogs.map((log) => log.agentId)).toEqual([
      'reference-analysis-chunk',
      'reference-analysis-book'
    ])
    h.db.close()
  })

  it('估算过期启动被拒（409），未确认费用被拒', async () => {
    const h = await createHarness([SCENE_REPLY])
    const stale = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: '0'.repeat(64),
        highCostConfirmed: true
      }
    })
    expect(stale.statusCode).toBe(409)
    const unconfirmed = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: false
      }
    })
    expect(unconfirmed.statusCode).toBe(409)
    h.db.close()
  })

  it('兼容 JSON mode 被网关错误包裹的 Markdown 围栏', async () => {
    const h = await createHarness([fencedJson(SCENE_REPLY), fencedJson(BOOK_REPLY)])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })

    await h.worker.run(start.json().data.id)

    expect(h.runStore.getRun(start.json().data.id)).toMatchObject({
      status: 'awaiting_review',
      currentStage: 'awaiting_review'
    })
    h.db.close()
  })

  it('分包回复带寒暄前缀（已收到《XX》…）：确定性抽取 JSON，任务照常完成', async () => {
    const h = await createHarness([`已收到《测试参考》，下面给出分析结果。\n${SCENE_REPLY}`, BOOK_REPLY])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })

    await h.worker.run(start.json().data.id)

    // 抽取路径不消耗修复轮：调用数仍是 1 分包 + 1 汇总
    expect(h.runStore.getRun(start.json().data.id)).toMatchObject({
      status: 'awaiting_review',
      currentStage: 'awaiting_review'
    })
    expect(h.runStore.getRun(start.json().data.id)!.actualUsage.llmCalls).toBe(2)
    h.db.close()
  })

  it('模型先寒暄且无 JSON：同会话修复轮重取后完成', async () => {
    const h = await createHarness(
      ['已收到《黑暗血时代》，我这就开始为您分析。'],
      { promptReplies: [SCENE_REPLY, BOOK_REPLY] }
    )
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })

    await h.worker.run(start.json().data.id)

    const final = h.runStore.getRun(start.json().data.id)!
    if (final.status !== 'awaiting_review') {
      console.log('FINAL-RUN-DIAG:', JSON.stringify(final, null, 1))
    }
    expect(final.status).toBe('awaiting_review')
    expect(final.currentStage).toBe('awaiting_review')
    expect(final.actualUsage.llmCalls).toBe(2)
    // 修复轮发生在同一会话：会话数不变（1 分包 + 1 汇总）
    expect(h.sessionOptions).toHaveLength(2)
    h.db.close()
  })

  it('工具提交路径：模型发起 tool call，结构化参数经闭包捕获，任务完成且不走文本解析', async () => {
    const scenePayload = JSON.parse(SCENE_REPLY) as Record<string, unknown>
    const bookPayload = JSON.parse(BOOK_REPLY) as Record<string, unknown>
    const h = await createHarness([], { toolPayloads: [scenePayload, bookPayload] })
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })

    await h.worker.run(start.json().data.id)

    const final = h.runStore.getRun(start.json().data.id)!
    expect(final.status).toBe('awaiting_review')
    expect(final.actualUsage.llmCalls).toBe(2)

    // scene 观察确实来自工具捕获的 payload（含 sectionId 校验后的两条）
    const all = h.runStore.listObservations(final.id)
    expect(all.filter((item) => item.level === 'scene').length).toBe(2)
    h.db.close()
  })

  it('A2 严格结构化输出：strict provider 下跳过工具、携带 json_schema，文本直解完成任务', async () => {
    vi.stubEnv('PI_JSON_SCHEMA_STRICT_PROVIDERS', 'provider-1')
    try {
      const h = await createHarness([SCENE_REPLY, BOOK_REPLY])
      const start = await h.app.inject({
        method: 'POST',
        url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
        payload: {
          providerId: 'provider-1',
          modelId: 'model-1',
          estimateHash: h.estimateHash,
          highCostConfirmed: true
        }
      })

      await h.worker.run(start.json().data.id)

      const finalA2 = h.runStore.getRun(start.json().data.id)!
      if (finalA2.status !== 'awaiting_review') {
        console.log('A2-DIAG:', finalA2.error)
      }
      expect(finalA2).toMatchObject({
        status: 'awaiting_review',
        currentStage: 'awaiting_review'
      })
      expect(h.sessionOptions[0]!.tools).toBeUndefined()
      expect((h.sessionOptions[0] as unknown as { responseJsonSchema?: { name: string } }).responseJsonSchema?.name)
        .toBe('chunk_observations')
      expect((h.sessionOptions[1] as unknown as { responseJsonSchema?: { name: string } }).responseJsonSchema?.name)
        .toBe('book_profile')
      h.db.close()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('修复 JSON 字符串中未转义的控制字符', async () => {
    const malformedScene = SCENE_REPLY.replace('短句为主，节奏偏快', '短句为主\n节奏偏快')
    const h = await createHarness([malformedScene, BOOK_REPLY])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })

    await h.worker.run(start.json().data.id)

    expect(h.runStore.getRun(start.json().data.id)).toMatchObject({
      status: 'awaiting_review',
      currentStage: 'awaiting_review'
    })
    h.db.close()
  })

  it('取消保留 checkpoint；恢复复用 checkpoint 不重复计费', async () => {
    // 全书汇总失败（非法 JSON）→ run failed；checkpoint 已含第一个分包
    const h = await createHarness([SCENE_REPLY, 'not-json'])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })
    const runId = start.json().data.id
    await h.worker.run(runId)
    const failed = h.runStore.getRun(runId)!
    expect(failed.status).toBe('failed')
    expect(failed.checkpoint).not.toBeNull()
    expect((failed.checkpoint!.completedChunkIds as string[]).length).toBe(1)

    const cancel = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-analysis-runs/${runId}/cancel`,
      payload: { reason: '测试' }
    })
    expect(cancel.statusCode).toBe(200)
    expect(cancel.json().data.status).toBe('cancelled')

    // 恢复：新 attempt 继承 checkpoint
    const resume = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-analysis-runs/${runId}/resume`,
      payload: { highCostConfirmed: true }
    })
    expect(resume.statusCode).toBe(200)
    const resumedRun = resume.json().data
    expect(resumedRun.attempt).toBe(2)
    expect(resumedRun.parentAttemptId).toBe(runId)
    expect(resumedRun.checkpoint.completedChunkIds).toHaveLength(1)
    h.db.close()
  })
})

describe('P5 档案与 finding 审核', () => {
  it('findings 列表/单项审核/批量审核生成新版本/安全报告/证据定位', async () => {
    const h = await createHarness([SCENE_REPLY, BOOK_REPLY])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })
    const run = h.runStore.getRun(start.json().data.id)!
    await h.worker.run(run.id)
    const profileId = h.runStore.getRun(run.id)!.profileId!

    // 档案详情
    const profileRes = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-profiles/${profileId}`
    })
    expect(profileRes.statusCode).toBe(200)
    const profile = profileRes.json().data
    expect(profile.version).toBe(1)
    expect(profile.findings).toHaveLength(2)
    expect(profile.spirit.summary).toContain('克制')

    // findings + 计数
    const findingsRes = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-profiles/${profileId}/findings?category=pacing`
    })
    expect(findingsRes.statusCode).toBe(200)
    expect(findingsRes.json().data.findings).toHaveLength(1)
    expect(findingsRes.json().data.counts.byCategory.pacing).toBe(1)

    // 证据定位（原文存在 → 偏移可用）
    const evidenceRes = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-profiles/${profileId}/findings/pacing-001/evidence`
    })
    expect(evidenceRes.statusCode).toBe(200)
    const evidence = evidenceRes.json().data
    expect(evidence.evidence[0].available).toBe(true)
    expect(evidence.evidence[0].sectionId).not.toBeNull()

    // 单项审核：非法 Agent 目标（Memory 不接收参考分析）被 schema 拒绝
    const badAgent = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/reference-profiles/${profileId}/findings/pacing-001/review`,
      payload: { decision: 'accepted', agentTargets: ['Memory'] }
    })
    expect(badAgent.statusCode).toBe(400)
    // 合法单项审核
    const single = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/reference-profiles/${profileId}/findings/technique-001/review`,
      payload: {
        decision: 'edited',
        editedRule: '用旧物触发回忆（编辑后）',
        strength: 'hard',
        agentTargets: ['Writer', 'Reviser']
      }
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
          {
            findingKey: 'pacing-001',
            decision: 'accepted',
            promptEnabled: true,
            agentTargets: ['Director']
          },
          { findingKey: 'technique-001', decision: 'accepted', note: '保留编辑值' }
        ]
      }
    })
    // technique-001 已审核会被跳过；pacing-001 进入批次
    expect(batch.statusCode).toBe(200)
    const next = batch.json().data.profile
    expect(next.version).toBe(2)
    expect(next.parentVersionId).toBe(profileId)

    // 版本列表 + 比较
    const versions = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-profiles/${profileId}/versions`
    })
    expect(versions.statusCode).toBe(200)
    expect(versions.json().data).toHaveLength(2)
    const compare = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-profiles/${profileId}/compare?fromVersionId=${profileId}&toVersionId=${next.id}`
    })
    expect(compare.statusCode).toBe(200)
    expect(compare.json().data.findingChanges.length).toBeGreaterThan(0)

    // 安全报告：直接引用已核实 → blocking
    const safety = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-profiles/${profileId}/safety-report`
    })
    expect(safety.statusCode).toBe(200)
    expect(safety.json().data.blocking).toBe(true)
    expect(safety.json().data.directQuotes).toHaveLength(1)
    h.db.close()
  })

  it('原文删除后证据接口返回 410', async () => {
    const h = await createHarness([SCENE_REPLY, BOOK_REPLY])
    const start = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/reference-sources/${h.sourceId}/analysis-runs`,
      payload: {
        providerId: 'provider-1',
        modelId: 'model-1',
        estimateHash: h.estimateHash,
        highCostConfirmed: true
      }
    })
    const run = h.runStore.getRun(start.json().data.id)!
    await h.worker.run(run.id)
    const profileId = h.runStore.getRun(run.id)!.profileId!
    // 清空 sections 模拟原文删除
    h.db.prepare('DELETE FROM novel_reference_sections WHERE source_id = ?').run(h.sourceId)
    const evidenceRes = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/reference-profiles/${profileId}/findings/pacing-001/evidence`
    })
    expect(evidenceRes.statusCode).toBe(410)
    h.db.close()
  })
})

afterAll(() => {
  vi.setConfig({ testTimeout: 5_000 })
})
