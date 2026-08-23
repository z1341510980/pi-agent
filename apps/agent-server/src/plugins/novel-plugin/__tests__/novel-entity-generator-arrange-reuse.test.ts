import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelEntityGenerator, type GeneratedEntity } from '../core/generation/novel-entity-generator.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { NovelStore } from '../core/novel-store.js'
import { createChapterProjectionRecorder } from '../core/chapters/chapter-projection-recorder.js'
import { novelMigrations } from '../novel-migrations.js'

/**
 * 覆盖 ai-arrange（source='outline'）对"已推进实体"的处理：
 *
 * 1. 已埋设过的伏笔被复用时，必须按规划给出的 chapterAction 落本章 beat。
 *    旧实现只更新 lastChapter，于是矩阵格子为空、前端 collectArrangedEntities
 *    也筛不出这条伏笔，Writer 完全不知道要推进它。
 * 2. 章纲编排必须写账本（旧实现只有 reverse-arrange 写），
 *    且区分 created / arranged 两类，复用实体不能被算成"再次创建"。
 * 3. 实体名匹配要对括注/标点噪声免疫，否则已推进实体会被当新实体重造。
 */

interface Harness {
  db: Database.Database
  store: NovelStore
  memoryStore: NovelMemoryStore
  projectId: string
  generator: NovelEntityGenerator
  warnings: Array<{ payload: unknown; message: string }>
}

function createHarness(): Harness {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const migration of novelMigrations) db.exec(migration.sql)

  const store = new NovelStore(db)
  const memoryStore = new NovelMemoryStore(db)
  // 与生产装配一致：复用实体的 `<类型>.arranged` 由章节投影观察者写入，
  // 不再由 recordArrangeProjection 重复写一遍（同一事实只保留一个写入方）。
  store.setChapterProjectionObserver(createChapterProjectionRecorder(memoryStore))
  const projectId = randomUUID()
  store.createProject({
    id: projectId,
    title: 'Arrange reuse test',
    genre: 'test',
    synopsis: '',
    outline: '',
    targetWords: 0,
    currentVolume: 1,
    currentChapter: 0,
    currentStage: 'setup',
    status: 'active',
  })
  // 2026-08-12 逻辑统一：出场事实在 appearance 表，需目标章节已落库才能写入
  // （recordAppearancesIfEnabled 依赖 chapterId 解析；缺章时 appearance 不写、observer 不触发）。
  for (let n = 1; n <= 20; n += 1) {
    store.createChapter({
      id: randomUUID(), projectId, volume: 1, chapterNumber: n,
      title: `第${n}章`, content: '', wordCount: 0, status: 'planned',
      narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
      tension: null, positioning: null, timeOffset: null,
      chapterEndingHook: null, recap: null,
    })
  }

  const warnings: Array<{ payload: unknown; message: string }> = []
  const generator = new NovelEntityGenerator(
    {} as never,
    {} as never,
    {
      logger: {
        info: () => undefined,
        warn: (payload: unknown, message?: string) => { warnings.push({ payload, message: message ?? '' }) },
        error: () => undefined,
      },
    } as never,
    {} as never,
    store,
    memoryStore,
  )
  return { db, store, memoryStore, projectId, generator, warnings }
}

/** 让 generator 跳过 LLM，直接使用给定的 plan + 生成结果 */
function stubPlan(generator: NovelEntityGenerator, plan: unknown, generated: Map<object, GeneratedEntity>): void {
  ;(generator as any).planEntitiesFromOutline = async () => ({
    plan,
    logContext: { systemPrompt: '', userMessage: '', rawResult: '', status: 'success', error: '' },
  })
  ;(generator as any).generatePlanInBatches = async () => ({
    generated,
    itemCount: generated.size,
    batchCount: 1,
    retryCount: 0,
    fallbackCount: 0,
    unbatchedGenerationCount: 0,
  })
}

const EMPTY_PLAN = { characters: [], conflicts: [], foreshadows: [], factions: [], locations: [], items: [] }

describe('ai-arrange 复用已有实体', () => {
  it('writes aggregate payload sums/max and session-attributed child logs', async () => {
    const h = createHarness()
    try {
      const usage = {
        inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0,
        llmProvider: 'provider', llmModel: 'model',
      }
      const planCall = {
        operation: 'plan', sessionId: 'plan-session', systemPrompt: 'plan-system', userMessage: 'plan-user',
        result: '{}', durationMs: 5, status: 'success', error: '', usage,
        payloadStats: { messagesChars: 100, toolsChars: 20, toolCount: 4, totalChars: 150, roundTrips: 1 },
      }
      const batchCall = {
        operation: 'batch', sessionId: 'batch-session', systemPrompt: 'batch-system', userMessage: 'batch-user',
        result: '{}', durationMs: 6, status: 'success', error: '', usage,
        payloadStats: { messagesChars: 200, toolsChars: 10, toolCount: 2, totalChars: 240, roundTrips: 2 },
      }
      ;(h.generator as any).planEntitiesFromOutline = async () => ({
        plan: EMPTY_PLAN,
        logContext: {
          systemPrompt: 'plan-system', userMessage: 'plan-user', rawResult: '{}',
          status: 'success', error: '', usage, call: planCall,
        },
      })
      ;(h.generator as any).generatePlanInBatches = async () => ({
        generated: new Map(), itemCount: 0, batchCount: 1, retryCount: 0,
        fallbackCount: 0, unbatchedGenerationCount: 0, usage, calls: [batchCall],
      })

      await h.generator.generateAndArrange(h.projectId, 1, 'outline')

      const logs = h.store.listAgentLogsByProject(h.projectId, 10)
      const parent = logs.find((log) => log.agentType === 'arranger')
      const details = logs.filter((log) => log.agentType === 'arranger-detail')
      expect(parent).toEqual(expect.objectContaining({
        operation: 'aggregate', payloadMessagesChars: 300, payloadToolsChars: 30,
        payloadToolCount: 4, payloadTotalChars: 390, llmRoundTrips: 3,
      }))
      expect(details.map((log) => ({ operation: log.operation, sessionId: log.sessionId, parentLogId: log.parentLogId })))
        .toEqual(expect.arrayContaining([
          { operation: 'plan', sessionId: 'plan-session', parentLogId: parent?.id },
          { operation: 'batch', sessionId: 'batch-session', parentLogId: parent?.id },
        ]))
    } finally {
      h.db.close()
    }
  })

  it('按 chapterAction 为已埋设伏笔补本章 beat，并同步 status', async () => {
    const h = createHarness()
    try {
      const foreshadowId = randomUUID()
      h.store.createForeshadow({
        id: foreshadowId,
        projectId: h.projectId,
        description: '叶明远体内第七处深层节点在最低刺激下自行牵动前六点，形成完整图形',
        category: 'item',
        status: 'planted',
        firstChapter: 10,
        lastChapter: 10,
        recoverByChapter: null,
        plantMethod: 'implicit',
        recoverMethod: 'explicit',
        chapterSpans: [],
        beats: [{ chapter: 10, type: 'plant' }],
      })

      const plan = {
        ...EMPTY_PLAN,
        foreshadows: [{
          coreStyle: '已有：叶明远体内第七处深层节点在最低刺激下自行牵动前六',
          chapterAction: 'reinforce',
        }],
      }
      stubPlan(h.generator, plan, new Map())

      const arranged = await h.generator.generateAndArrange(h.projectId, 11, '章纲', undefined, 'outline')
      expect(arranged.foreshadowIds).toEqual([foreshadowId])

      const updated = h.store.getForeshadow(foreshadowId)!
      expect(updated.beats).toEqual([
        { chapter: 10, type: 'plant' },
        { chapter: 11, type: 'reinforce' },
      ])
      expect(updated.status).toBe('reinforced')
      expect(updated.lastChapter).toBe(11)
    } finally {
      h.db.close()
    }
  })

  it('已有本章 beat 时不重复追加', async () => {
    const h = createHarness()
    try {
      const foreshadowId = randomUUID()
      h.store.createForeshadow({
        id: foreshadowId,
        projectId: h.projectId,
        description: '旧藏残卷里的七枢内照图与主角体内结构一致',
        category: 'item',
        status: 'planted',
        firstChapter: 11,
        lastChapter: 11,
        recoverByChapter: null,
        plantMethod: 'explicit',
        recoverMethod: 'explicit',
        chapterSpans: [],
        beats: [{ chapter: 11, type: 'plant' }],
      })
      stubPlan(h.generator, {
        ...EMPTY_PLAN,
        foreshadows: [{ coreStyle: '已有：旧藏残卷里的七枢内照图与主角体内结构一致', chapterAction: 'reveal' }],
      }, new Map())

      await h.generator.generateAndArrange(h.projectId, 11, '章纲', undefined, 'outline')
      expect(h.store.getForeshadow(foreshadowId)!.beats).toHaveLength(1)
    } finally {
      h.db.close()
    }
  })

  it('章纲编排写账本，复用实体记为 arranged 而非 created', async () => {
    const h = createHarness()
    try {
      const factionId = randomUUID()
      h.store.createFaction({
        id: factionId,
        projectId: h.projectId,
        name: '国安总局',
        description: '蓝星侧主导机构',
        type: 'organization',
        leaderId: null,
        ideology: '秩序优先',
        strength: 'strong',
        resources: [],
        allies: [],
        enemies: [],
        status: 'active',
        chapterSpans: [[1, 10]],
      })
      stubPlan(h.generator, { ...EMPTY_PLAN, factions: [{ coreStyle: '已有：国安总局' }] }, new Map())

      await h.generator.generateAndArrange(h.projectId, 11, '章纲', undefined, 'outline')

      const changes = h.memoryStore.listChangeRecords(h.projectId, { chapterNumber: 11 })
      expect(changes).toHaveLength(1)
      expect(changes[0].dimension).toBe('faction.arranged')
      expect(changes[0].subjectId).toBe(factionId)

      // 编排事件仍然声明"本章涉及该势力"（entityRef），只是变化记录归观察者写
      const events = h.memoryStore.listStoryEvents(h.projectId, { chapterNumber: 11 })
      const arrangeEvent = events.find((e) => e.title === '章纲编排实体投影')
      expect(arrangeEvent).toBeDefined()
      expect(arrangeEvent!.status).toBe('planned')
      expect(h.memoryStore.listStoryEventEntityRefs(arrangeEvent!.id).map((r) => r.entityId)).toEqual([factionId])

      // 变化记录挂在观察者创建的"章节投影变更"事件下
      const projectionEvent = events.find((e) => e.title === '章节投影变更')
      expect(projectionEvent).toBeDefined()
      expect(changes[0].storyEventId).toBe(projectionEvent!.id)
    } finally {
      h.db.close()
    }
  })

  it('名字带括注时仍能匹配到已有角色，不再重造初始状态', async () => {
    const h = createHarness()
    try {
      const charId = randomUUID()
      h.store.createCharacter({
        id: charId,
        projectId: h.projectId,
        name: '叶明远',
        description: '程序员穿越者',
        identity: '外门弟子',
        personality: '{}',
        appearance: '',
        currentState: '带着未解的异象赴考',
        currentGoal: '通过考核',
        currentPressure: '风险陡增',
        secret: '',
        arcStage: 'rising',
        arcHistory: '[{"chapter":1}]',
        speechStyle: '{}',
        isProtagonist: true,
        longTermDesire: '',
        plotRole: 'protagonist',
        removalImpact: '',
      })
      // LLM 常把状态写进名字里；旧实现按名精确匹配，直接漏网并重建角色
      stubPlan(h.generator, { ...EMPTY_PLAN, characters: [{ coreStyle: '已有：叶明远（觉醒后）' }] }, new Map())

      const arranged = await h.generator.generateAndArrange(h.projectId, 11, '章纲', undefined, 'outline')

      expect(arranged.characterIds).toEqual([charId])
      expect(h.store.listCharacters(h.projectId)).toHaveLength(1)
      // 状态不被覆盖
      expect(h.store.getCharacter(charId)!.currentState).toBe('带着未解的异象赴考')
      // 未走"降级新建"分支
      expect(h.warnings.filter((w) => w.message.includes('降级为新建'))).toHaveLength(0)
    } finally {
      h.db.close()
    }
  })

  it('标注已有但确实匹配不到时留下告警（不再静默重造）', async () => {
    const h = createHarness()
    try {
      stubPlan(h.generator, { ...EMPTY_PLAN, factions: [{ coreStyle: '已有：完全不存在的势力名' }] }, new Map())
      // 降级分支会真的调 LLM 生成新实体，这里直接短路掉生成
      ;(h.generator as any).generate = async () => ({
        type: 'faction',
        data: {
          name: '完全不存在的势力名',
          description: '降级新建',
          type: 'organization',
          ideology: '',
          strength: 'medium',
          resources: [],
          allies: [],
          enemies: [],
          status: 'active',
        },
      })

      await h.generator.generateAndArrange(h.projectId, 11, '章纲', undefined, 'outline')

      const downgrade = h.warnings.filter((w) => w.message.includes('降级为新建'))
      expect(downgrade).toHaveLength(1)
      expect(JSON.stringify(downgrade[0].payload)).toContain('faction')
    } finally {
      h.db.close()
    }
  })
})
