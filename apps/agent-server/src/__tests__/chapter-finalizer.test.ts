import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { ChapterFinalizer } from '../core/agent/chapter-finalizer.js'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'

/** Memory 中途失败专项：结构化提取抛错 → 降级空结果，不阻断流程，通用日志留痕 error */
describe('runMemoryAgent - Memory 中途失败', () => {
  it('generate 抛错时降级为空结果并记录 error（不 throw）', async () => {
    const calls: Array<Record<string, unknown>> = []
    const finalizer = Object.create(ChapterFinalizer.prototype) as any
    finalizer.context = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agentCallLogger: { record: (entry: Record<string, unknown>) => calls.push(entry) },
    }
    finalizer.emitProgress = vi.fn()
    finalizer.persistMemoryLogs = vi.fn()
    finalizer.memoryGenerator = {
      generate: vi.fn(async () => { throw new Error('503 No available channel') }),
    }

    const summary = await finalizer.runMemoryAgent('p1', 3, '正文', {
      emit: vi.fn(), onCheckpoint: vi.fn() as any, onProgress: vi.fn(),
      signal: undefined,
    })

    expect(summary).toContain('记忆提取失败')
    expect(finalizer.persistMemoryLogs).toHaveBeenCalled()
    // 通用日志记录 error 状态
    expect(calls.length).toBe(1)
    expect(calls[0].status).toBe('error')
    expect(calls[0].error).toContain('503')
  })

  it('generate 返回 error status（非 throw）同样降级', async () => {
    const finalizer = Object.create(ChapterFinalizer.prototype) as any
    finalizer.context = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agentCallLogger: undefined,
    }
    finalizer.emitProgress = vi.fn()
    finalizer.persistMemoryLogs = vi.fn()
    finalizer.memoryGenerator = {
      generate: vi.fn(async () => ({ status: 'error', error: '解析失败', summary: 'x', stats: { total: 0 } })),
    }
    const summary = await finalizer.runMemoryAgent('p1', 3, '正文', {
      emit: vi.fn(), onCheckpoint: vi.fn() as any, onProgress: vi.fn(), signal: undefined,
    })
    // error status 走结构化错误分支（含分类重试），最终返回错误文案而非空成功
    expect(summary).toContain('解析失败')
  })
})

describe('ChapterFinalizer', () => {
  // 用 mock 依赖构造实例，测试纯函数方法
  const mockContext = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any
  const finalizer = new ChapterFinalizer(
    {} as any, {} as any, {} as any, {} as any, mockContext,
  )

  it('标题和提要生成使用本次模型', async () => {
    const session = {
      prompt: vi.fn().mockResolvedValue('候选标题'),
      dispose: vi.fn(),
    }
    const createSession = vi.fn().mockResolvedValue(session)
    const modelAwareFinalizer = new ChapterFinalizer(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { ...mockContext, createSession } as any,
    )
    const modelId = { provider: 'selected', modelId: 'run-model' }

    await modelAwareFinalizer.generateChapterTitles('p1', 1, '正文', undefined, modelId)
    await modelAwareFinalizer.generateChapterRecap('p1', 1, '正文', undefined, modelId)

    expect(createSession).toHaveBeenCalledTimes(2)
    expect(createSession).toHaveBeenNthCalledWith(1, expect.objectContaining({ modelId }))
    expect(createSession).toHaveBeenNthCalledWith(2, expect.objectContaining({ modelId }))
  })

  describe('stripThinkingPrelude', () => {
    it('清洗 prelude 标签', () => {
      expect(finalizer.stripThinkingPrelude('<prelude>思考</prelude>正文')).toBe('<prelude>思考</prelude>正文')
    })

    it('清洗智库块', () => {
      expect(finalizer.stripThinkingPrelude('智库这是思考过程智库结束正文内容')).toBe('正文内容')
    })

    it('清洗思考前缀 + 分隔符', () => {
      const input = '看完了全部约束。开始写作。\n---\n正文内容'
      expect(finalizer.stripThinkingPrelude(input)).toBe('正文内容')
    })

    it('无 prelude 标签时原样返回', () => {
      expect(finalizer.stripThinkingPrelude('纯正文')).toBe('纯正文')
    })

    it('空字符串原样返回', () => {
      expect(finalizer.stripThinkingPrelude('')).toBe('')
    })

    it('保留含多个句号结尾句子的合法正文（不误清洗）', () => {
      const legit = '第一章开头。\n这是第二句。\n---\n后续内容'
      // 前缀有 2 个句号结尾的句子，不应被清洗
      expect(finalizer.stripThinkingPrelude(legit)).toBe(legit)
    })
  })

  describe('parseIdList', () => {
    it('解析 JSON 数组', () => {
      expect(finalizer.parseIdList('["a","b"]')).toEqual(['a', 'b'])
    })

    it('空字符串返回空数组', () => {
      expect(finalizer.parseIdList('')).toEqual([])
    })

    it('无效 JSON 返回空数组', () => {
      expect(finalizer.parseIdList('invalid')).toEqual([])
    })

    it('非数组 JSON 返回空数组', () => {
      expect(finalizer.parseIdList('{"a":1}')).toEqual([])
    })

    it('过滤非字符串元素', () => {
      expect(finalizer.parseIdList('["a", 1, true, "b"]')).toEqual(['a', 'b'])
    })
  })

  describe('中间章节重写保护', () => {
    it('后续已有正文时识别为历史重写', () => {
      const store = {
        listChapters: () => [
          { chapterNumber: 2, content: '第二章正文' },
          { chapterNumber: 3, content: '第三章已有正文' },
          { chapterNumber: 4, content: '' },
        ],
      }
      const guardedFinalizer = new ChapterFinalizer(
        store as any, {} as any, {} as any, {} as any, mockContext,
      ) as any

      expect(guardedFinalizer.hasLaterCompletedChapter('p1', 2)).toBe(true)
      expect(guardedFinalizer.hasLaterCompletedChapter('p1', 4)).toBe(false)
    })
  })

  describe('finalize 原子提交', () => {
    it('快照写入失败时回滚正文、revision、Memory 实体和事件', async () => {
      const db = new Database(':memory:')
      try {
        for (const migration of novelMigrations) db.exec(migration.sql)
        const store = new NovelStore(db)
        const memoryStore = new NovelMemoryStore(db)
        const projectId = randomUUID()
        const chapterId = randomUUID()
        const characterId = randomUUID()
        store.createProject({
          id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
          targetWords: 3000, currentVolume: 1, currentChapter: 1,
          currentStage: 'rising', status: 'active',
        })
        store.createChapter({
          id: chapterId, projectId, volume: 1, chapterNumber: 1,
          title: '第一章', content: '旧正文', wordCount: 3,
          status: 'drafting', narrativeTask: '', outline: '', volumeId: null,
          acceptanceResult: null, tension: null, positioning: null,
          timeOffset: null, chapterEndingHook: null, recap: null,
        })
        store.createCharacter({
          id: characterId, projectId, name: '叶明远', description: '', identity: '',
          personality: '', appearance: '', currentState: '平静', currentGoal: '',
          currentPressure: '', secret: '', arcStage: 'introduction', arcHistory: '[]',
          speechStyle: '', isProtagonist: true, longTermDesire: '',
          plotRole: 'protagonist', removalImpact: '',
        })
        const analyzed = {
          status: 'success', summary: '角色状态变化', analysis: {},
          stats: { total: 0 },
        } as any
        const memoryGenerator = {
          analyze: vi.fn(async () => analyzed),
          applyAnalysis: vi.fn(() => {
            store.updateCharacter(characterId, { currentState: '受伤' })
            return { ...analyzed, analysis: undefined, stats: { total: 1 } }
          }),
        }
        db.exec(`
          CREATE TRIGGER reject_finalizer_snapshot
          BEFORE INSERT ON novel_memory_snapshots
          BEGIN
            SELECT RAISE(ABORT, 'forced snapshot failure');
          END;
        `)
        const atomicFinalizer = new ChapterFinalizer(
          store,
          memoryStore,
          {} as any,
          {} as any,
          mockContext,
          memoryGenerator as any,
        )

        await expect(atomicFinalizer.finalize({
          projectId,
          chapterNumber: 1,
          chapterId,
          content: '新正文',
          versionSource: { phase: 'writer_initial', agentType: 'writer' },
          options: { emit: vi.fn(), onCheckpoint: vi.fn(), onProgress: vi.fn() },
        })).rejects.toThrow(/forced snapshot failure/)

        expect(store.getChapterById(chapterId)!.content).toBe('旧正文')
        expect(store.listContentRevisions(chapterId)).toHaveLength(1)
        expect(store.getCharacter(characterId)!.currentState).toBe('平静')
        expect(db.prepare('SELECT COUNT(*) AS count FROM novel_memory_events').get()).toMatchObject({ count: 0 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM novel_memory_snapshots').get()).toMatchObject({ count: 0 })
      } finally {
        db.close()
      }
    })

    it('校准快照失败时只回滚补偿事务，保留正文核心提交', async () => {
      const db = new Database(':memory:')
      try {
        for (const migration of novelMigrations) db.exec(migration.sql)
        const store = new NovelStore(db)
        const memoryStore = new NovelMemoryStore(db)
        const projectId = randomUUID()
        const chapterId = randomUUID()
        const characterId = randomUUID()
        store.createProject({
          id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
          targetWords: 3000, currentVolume: 1, currentChapter: 10,
          currentStage: 'rising', status: 'active',
        })
        store.createChapter({
          id: chapterId, projectId, volume: 1, chapterNumber: 10,
          title: '第十章', content: '旧正文', wordCount: 3,
          status: 'drafting', narrativeTask: '', outline: '', volumeId: null,
          acceptanceResult: null, tension: null, positioning: null,
          timeOffset: null, chapterEndingHook: null, recap: null,
        })
        store.createCharacter({
          id: characterId, projectId, name: '叶明远', description: '', identity: '',
          personality: '', appearance: '', currentState: '平静', currentGoal: '',
          currentPressure: '', secret: '', arcStage: 'introduction', arcHistory: '[]',
          speechStyle: '', isProtagonist: true, longTermDesire: '',
          plotRole: 'protagonist', removalImpact: '',
        })
        const normalAnalysis = {
          status: 'success', summary: '逐章分析完成', analysis: { kind: 'normal' }, stats: { total: 0 },
        } as any
        const calibrationAnalysis = {
          status: 'success', summary: '校准分析完成', analysis: { kind: 'calibration' }, stats: { total: 0 },
        } as any
        const memoryGenerator = {
          analyze: vi.fn(async () => normalAnalysis),
          analyzeFullCalibration: vi.fn(async () => calibrationAnalysis),
          applyAnalysis: vi.fn((_projectId: string, _chapterNumber: number, analyzed: any) => {
            if (analyzed.analysis?.kind === 'calibration') {
              store.updateCharacter(characterId, { currentState: '校准后' })
              return { ...analyzed, analysis: undefined, stats: { total: 1 } }
            }
            return { ...analyzed, analysis: undefined, stats: { total: 0 } }
          }),
        }
        db.exec(`
          CREATE TRIGGER reject_calibrated_snapshot
          BEFORE INSERT ON novel_memory_snapshots
          WHEN (SELECT current_state FROM novel_characters WHERE id = '${characterId}') = '校准后'
          BEGIN
            SELECT RAISE(ABORT, 'forced calibration snapshot failure');
          END;
        `)
        const calibrationFinalizer = new ChapterFinalizer(
          store,
          memoryStore,
          {} as any,
          {} as any,
          mockContext,
          memoryGenerator as any,
        ) as any
        calibrationFinalizer.generateChapterTitles = vi.fn(async () => [])
        calibrationFinalizer.generateChapterRecap = vi.fn(async () => '')

        await expect(calibrationFinalizer.finalize({
          projectId,
          chapterNumber: 10,
          chapterId,
          content: '新正文',
          versionSource: { phase: 'writer_initial', agentType: 'writer' },
          options: { emit: vi.fn(), onCheckpoint: vi.fn(), onProgress: vi.fn() },
        })).resolves.toMatchObject({ status: 'completed', content: '新正文' })

        expect(store.getChapterById(chapterId)).toMatchObject({ content: '新正文', status: 'review' })
        expect(store.getCharacter(characterId)!.currentState).toBe('平静')
        expect(memoryStore.listSnapshots(projectId, { chapterNumber: 10, snapshotType: 'full' })).toHaveLength(1)
        expect(db.prepare('SELECT COUNT(*) AS count FROM novel_memory_events').get()).toMatchObject({ count: 0 })
      } finally {
        db.close()
      }
    })

    it('返回给前端的正文与清洗后实际提交的正文一致', async () => {
      const db = new Database(':memory:')
      try {
        for (const migration of novelMigrations) db.exec(migration.sql)
        const store = new NovelStore(db)
        const memoryStore = new NovelMemoryStore(db)
        const projectId = randomUUID()
        const chapterId = randomUUID()
        store.createProject({
          id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
          targetWords: 3000, currentVolume: 1, currentChapter: 1,
          currentStage: 'rising', status: 'active',
        })
        store.createChapter({
          id: chapterId, projectId, volume: 1, chapterNumber: 1,
          title: '第一章', content: '', wordCount: 0,
          status: 'drafting', narrativeTask: '', outline: '', volumeId: null,
          acceptanceResult: null, tension: null, positioning: null,
          timeOffset: null, chapterEndingHook: null, recap: null,
        })
        const memoryGenerator = {
          analyze: vi.fn(async () => ({
            status: 'success', summary: '无状态变化', analysis: {}, stats: { total: 0 },
          })),
          applyAnalysis: vi.fn((_: string, __: number, result: any) => result),
        }
        const committedFinalizer = new ChapterFinalizer(
          store, memoryStore, {} as any, {} as any, mockContext, memoryGenerator as any,
        ) as any
        committedFinalizer.generateChapterTitles = vi.fn(async () => [])
        committedFinalizer.generateChapterRecap = vi.fn(async () => '')

        const result = await committedFinalizer.finalize({
          projectId,
          chapterNumber: 1,
          chapterId,
          content: '看完了全部约束。开始写作。\n---\n正文内容',
          versionSource: { phase: 'writer_initial', agentType: 'writer' },
          options: { emit: vi.fn(), onCheckpoint: vi.fn(), onProgress: vi.fn() },
        })

        expect(store.getChapterById(chapterId)!.content).toBe('正文内容')
        expect(result.content).toBe('正文内容')
      } finally {
        db.close()
      }
    })
  })

  describe('syncChapterDimensions - 伏笔事件链', () => {
    const emptyBefore = {
      characters: new Map(), conflicts: new Map(), foreshadowing: new Map(),
      clues: new Map(),
      factions: new Map(), locations: new Map(), relationships: new Map(), infoLayers: new Map(),
    } as any

    function makeFinalizer(foreshadows: any[]): { finalizer: ChapterFinalizer; updateForeshadow: ReturnType<typeof vi.fn> } {
      const updateForeshadow = vi.fn()
      const store = {
        listCharacters: vi.fn(() => []),
        listConflicts: vi.fn(() => []),
        listForeshadowing: vi.fn(() => foreshadows),
        listClues: vi.fn(() => []),
        listFactions: vi.fn(() => []),
        listLocations: vi.fn(() => []),
        listItems: vi.fn(() => []),
        listNarratives: vi.fn(() => []),
        updateForeshadow,
      }
      return {
        finalizer: new ChapterFinalizer(store as any, {} as any, {} as any, {} as any, mockContext),
        updateForeshadow,
      }
    }

    it('已有埋设点时不把本章自动追加为伏笔节点', () => {
      const foreshadow = { id: 'f1', beats: [{ chapter: 1, type: 'plant' }], firstChapter: 1 }
      const { finalizer, updateForeshadow } = makeFinalizer([foreshadow])

      finalizer.syncChapterDimensions('p1', 5, null, { foreshadowIds: ['f1'] } as any, emptyBefore)

      expect(updateForeshadow).toHaveBeenCalledWith('f1', { lastChapter: 5 })
    })

    it('尚未埋设时只补一个 plant 节点', () => {
      const foreshadow = { id: 'f2', beats: [], firstChapter: null }
      const { finalizer, updateForeshadow } = makeFinalizer([foreshadow])

      finalizer.syncChapterDimensions('p1', 3, null, { foreshadowIds: ['f2'] } as any, emptyBefore)

      expect(updateForeshadow).toHaveBeenCalledWith('f2', {
        lastChapter: 3,
        beats: [{ chapter: 3, type: 'plant' }],
      })
    })
  })

  describe('syncChapterDimensions - 线索轨道', () => {
    it('把矩阵选中的线索补入本章跨度', () => {
      const updateClue = vi.fn()
      const store = {
        listCharacters: vi.fn(() => []), listCharacterHistory: vi.fn(() => []),
        listConflicts: vi.fn(() => []), listForeshadowing: vi.fn(() => []),
        listClues: vi.fn(() => [{ id: 'clue-1', chapterSpans: [[1, 1]] }]),
        listFactions: vi.fn(() => []), listLocations: vi.fn(() => []), listItems: vi.fn(() => []), listNarratives: vi.fn(() => []),
        updateClue,
      }
      const clueFinalizer = new ChapterFinalizer(
        store as any, {} as any, {} as any, {} as any, mockContext,
      )
      const before = {
        characters: new Map(), conflicts: new Map(), foreshadowing: new Map(), clues: new Map([
          ['clue-1', { chapterSpans: [[1, 1]] }],
        ]), factions: new Map(), locations: new Map(), relationships: new Map(), infoLayers: new Map(),
      } as any

      clueFinalizer.syncChapterDimensions(
        'p1', 3, null,
        { characterIds: [], conflictIds: [], foreshadowIds: [], clueIds: ['clue-1'], factionIds: [], locationIds: [] },
        before,
      )

      expect(updateClue).toHaveBeenCalledWith('clue-1', { chapterSpans: [[1, 1], [3, 3]] })
    })
  })

  describe('syncChapterDimensions - item/narrative 出场补齐（P2 sync 入口）', () => {
    it('item：arranged + Memory 新建都补 chapterSpans + 双写 appearance', () => {
      const updateItem = vi.fn()
      const recordAppearances = vi.fn()
      const store = {
        listCharacters: vi.fn(() => []), listCharacterHistory: vi.fn(() => []),
        listConflicts: vi.fn(() => []), listForeshadowing: vi.fn(() => []),
        listClues: vi.fn(() => []), listFactions: vi.fn(() => []),
        listLocations: vi.fn(() => []),
        listItems: vi.fn(() => [
          { id: 'it-arr', chapterSpans: [[1, 1]] },     // arranged
          { id: 'it-new', chapterSpans: [] },           // Memory 新建
        ]),
        listNarratives: vi.fn(() => []),
        updateItem, recordAppearancesIfEnabled: recordAppearances,
      }
      const f = new ChapterFinalizer(store as any, {} as any, {} as any, {} as any, mockContext)
      const before = {
        characters: new Map(), conflicts: new Map(), foreshadowing: new Map(),
        clues: new Map(), factions: new Map(), locations: new Map(),
        items: new Map([['it-arr', {}]]),                 // it-arr 已存在；it-new 不在
        narratives: new Map(), relationships: new Map(), infoLayers: new Map(),
      } as any
      f.syncChapterDimensions('p1', 5, 'ch-5',
        { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [], itemIds: ['it-arr'] } as any,
        before,
      )
      expect(updateItem).toHaveBeenCalledWith('it-arr', { chapterSpans: [[1, 1], [5, 5]] })
      expect(updateItem).toHaveBeenCalledWith('it-new', { chapterSpans: [[5, 5]] })
      // appearance 双写：source='sync'，item 类型全覆盖两 ID
      const itemCalls = recordAppearances.mock.calls.filter((c: any[]) => c[0].entityType === 'item')
      expect(itemCalls).toHaveLength(1)
      expect(itemCalls[0][0].entityIds).toEqual(expect.arrayContaining(['it-arr', 'it-new']))
      expect(itemCalls[0][0].source).toBe('sync')
    })

    it('narrative：Memory 新建补 chapterSpans + 双写 appearance（narrative 无 arranged 项）', () => {
      const updateNarrative = vi.fn()
      const recordAppearances = vi.fn()
      const store = {
        listCharacters: vi.fn(() => []), listCharacterHistory: vi.fn(() => []),
        listConflicts: vi.fn(() => []), listForeshadowing: vi.fn(() => []),
        listClues: vi.fn(() => []), listFactions: vi.fn(() => []),
        listLocations: vi.fn(() => []), listItems: vi.fn(() => []),
        listNarratives: vi.fn(() => [{ id: 'nv-new', chapterSpans: [] }]),
        updateNarrative, recordAppearancesIfEnabled: recordAppearances,
      }
      const f = new ChapterFinalizer(store as any, {} as any, {} as any, {} as any, mockContext)
      const before = {
        characters: new Map(), conflicts: new Map(), foreshadowing: new Map(),
        clues: new Map(), factions: new Map(), locations: new Map(), items: new Map(),
        narratives: new Map(), relationships: new Map(), infoLayers: new Map(),
      } as any
      f.syncChapterDimensions('p1', 7, 'ch-7',
        { characterIds: [], conflictIds: [], foreshadowIds: [], factionIds: [], locationIds: [] } as any,
        before,
      )
      expect(updateNarrative).toHaveBeenCalledWith('nv-new', { chapterSpans: [[7, 7]] })
      const narrCalls = recordAppearances.mock.calls.filter((c: any[]) => c[0].entityType === 'narrative')
      expect(narrCalls).toHaveLength(1)
      expect(narrCalls[0][0].entityIds).toEqual(['nv-new'])
    })
  })

  describe('runMemoryAgent', () => {
    it('logs calibration as a measured parent and session detail', () => {
      const insertAgentLog = vi.fn((input) => ({ ...input, id: 'calibration-parent' }))
      const calibrationFinalizer = new ChapterFinalizer(
        { insertAgentLog } as any, {} as any, {} as any, {} as any, mockContext,
      ) as any
      calibrationFinalizer.persistMemoryLogs('p1', 10, [{
        operation: 'calibration', durationMs: 25,
        result: {
          status: 'success', summary: '校准完成', stats: {},
          logContext: {
            systemPrompt: 'cal-system', userMessage: 'cal-user', sessionId: 'cal-session',
            payloadStats: { messagesChars: 120, toolsChars: 0, toolCount: 0, totalChars: 140, roundTrips: 1 },
          },
        },
      }], 'calibration')

      expect(insertAgentLog).toHaveBeenCalledTimes(2)
      expect(insertAgentLog.mock.calls[0][0]).toEqual(expect.objectContaining({
        agentType: 'memory', operation: 'calibration', llmRoundTrips: 1,
      }))
      expect(insertAgentLog.mock.calls[1][0]).toEqual(expect.objectContaining({
        agentType: 'memory-detail', operation: 'calibration', sessionId: 'cal-session',
        parentLogId: 'calibration-parent',
      }))
    })

    it('结构化提取失败时先重试一次，仍失败才切换工具模式（并把 projectId 带给工具）', async () => {
      const insertAgentLog = vi.fn((input) => ({ ...input, id: 'memory-parent' }))
      const memoryGenerator = {
        generate: vi.fn(async () => ({
          status: 'error' as const,
          summary: '记忆提取失败，未应用状态变更',
          stats: {},
          error: '502 status code (no body)',
        })),
      }
      const fallback = vi.fn(async () => '工具模式提取成功')
      const messages: Array<{ content: string; metadata?: Record<string, unknown> }> = []
      const memoryFinalizer = new ChapterFinalizer(
        { insertAgentLog } as any,
        {} as any,
        {} as any,
        {} as any,
        mockContext,
        memoryGenerator as any,
        fallback,
      )

      const result = await memoryFinalizer.runMemoryAgent('p1', 1, '章节正文', {
        emit: vi.fn(),
        onCheckpoint: vi.fn(),
        onProgress: vi.fn(),
        onConversationMessage: (message) => messages.push(message),
      })

      expect(result).toBe('工具模式提取成功')
      // 502 属 transient：先重试结构化提取一次（首次 + 重试 = 2 次），再回退
      expect(memoryGenerator.generate).toHaveBeenCalledTimes(2)
      // 回退路径必须带 projectId —— 18 个记忆工具都把它列为必填，
      // 缺了它 Agent 只会输出「未提供 projectId」而一条变更都写不进去
      expect(fallback).toHaveBeenCalledWith(
        'memory', 'p1', 1,
        expect.objectContaining({
          projectId: 'p1',
          task: expect.stringContaining('502 status code'),
        }),
        expect.any(Object),
      )
      expect(insertAgentLog).toHaveBeenCalledWith(expect.objectContaining({
        agentType: 'memory', operation: 'memory', status: 'success', result: '工具模式提取成功',
      }))
      expect(insertAgentLog).toHaveBeenCalledWith(expect.objectContaining({
        agentType: 'memory-detail', status: 'error', error: '502 status code (no body)',
      }))
      expect(insertAgentLog).toHaveBeenCalledWith(expect.objectContaining({
        agentType: 'memory-detail', operation: 'fallback', status: 'success',
      }))
      expect(messages).toContainEqual(expect.objectContaining({
        content: '工具模式提取成功',
        metadata: expect.objectContaining({ fallback: true }),
      }))
    })

    it('结构化提取重试成功时不走工具模式', async () => {
      let calls = 0
      const insertAgentLog = vi.fn((input) => ({ ...input, id: `log-${insertAgentLog.mock.calls.length}` }))
      const memoryGenerator = {
        generate: vi.fn(async () => {
          calls += 1
          return calls === 1
            ? {
                status: 'error' as const, summary: '失败', stats: {}, error: '503 Service temporarily unavailable',
                logContext: {
                  systemPrompt: 'sys-1', userMessage: 'user-1', sessionId: 'memory-session-1',
                  payloadStats: { messagesChars: 100, toolsChars: 20, toolCount: 4, totalChars: 150, roundTrips: 1 },
                },
              }
            : {
                status: 'success' as const, summary: '重试后提取成功', stats: {},
                logContext: {
                  systemPrompt: 'sys-2', userMessage: 'user-2', sessionId: 'memory-session-2',
                  payloadStats: { messagesChars: 200, toolsChars: 10, toolCount: 2, totalChars: 240, roundTrips: 2 },
                },
              }
        }),
      }
      const fallback = vi.fn(async () => '不该走到这里')
      const messages: Array<{ content: string; metadata?: Record<string, unknown> }> = []
      const finalizer2 = new ChapterFinalizer(
        { insertAgentLog } as any,
        {} as any, {} as any, {} as any, mockContext,
        memoryGenerator as any,
        fallback,
      )

      const result = await finalizer2.runMemoryAgent('p1', 1, '章节正文', {
        emit: vi.fn(),
        onCheckpoint: vi.fn(),
        onProgress: vi.fn(),
        onConversationMessage: (message) => messages.push(message),
      })

      expect(result).toBe('重试后提取成功')
      // 关键：省掉了昂贵的工具循环（实测 4 轮往返 / 78k 字符工具 schema）
      expect(fallback).not.toHaveBeenCalled()
      expect(insertAgentLog).toHaveBeenCalledTimes(3)
      expect(insertAgentLog.mock.calls[0][0]).toEqual(expect.objectContaining({
        agentType: 'memory', operation: 'memory', parentLogId: null,
        payloadMessagesChars: 300, payloadToolsChars: 30, payloadToolCount: 4,
        payloadTotalChars: 390, llmRoundTrips: 3,
      }))
      expect(insertAgentLog.mock.calls[1][0]).toEqual(expect.objectContaining({
        agentType: 'memory-detail', operation: 'memory', sessionId: 'memory-session-1', parentLogId: 'log-1',
      }))
      expect(insertAgentLog.mock.calls[2][0]).toEqual(expect.objectContaining({
        agentType: 'memory-detail', operation: 'retry', sessionId: 'memory-session-2', parentLogId: 'log-1',
      }))
      expect(messages).toContainEqual(expect.objectContaining({
        content: '重试后提取成功',
        metadata: expect.objectContaining({ retried: true }),
      }))
    })

    it('账户类错误不重试，直接走工具模式', async () => {
      const memoryGenerator = {
        generate: vi.fn(async () => ({
          status: 'error' as const,
          summary: '失败',
          stats: {},
          error: '401 "Invalid API key"',
        })),
      }
      const fallback = vi.fn(async () => '工具模式提取成功')
      const finalizer3 = new ChapterFinalizer(
        { insertAgentLog: vi.fn() } as any,
        {} as any, {} as any, {} as any, mockContext,
        memoryGenerator as any,
        fallback,
      )

      await finalizer3.runMemoryAgent('p1', 1, '章节正文', {
        emit: vi.fn(),
        onCheckpoint: vi.fn(),
        onProgress: vi.fn(),
        onConversationMessage: vi.fn(),
      })

      // 401 重试一万次也不会好，不该浪费一次调用
      expect(memoryGenerator.generate).toHaveBeenCalledTimes(1)
      expect(fallback).toHaveBeenCalled()
    })

    it('records thrown generate and retry attempts with empty measurements', async () => {
      const insertAgentLog = vi.fn((input) => ({ ...input, id: 'parent' }))
      const memoryGenerator = { generate: vi.fn(async () => { throw new Error('503 unavailable') }) }
      const finalizer = new ChapterFinalizer(
        { insertAgentLog } as any, {} as any, {} as any, {} as any, mockContext,
        memoryGenerator as any,
      )

      await finalizer.runMemoryAgent('p1', 1, '正文', {
        emit: vi.fn(), onCheckpoint: vi.fn(), onProgress: vi.fn(), onConversationMessage: vi.fn(),
      })

      expect(insertAgentLog).toHaveBeenCalledTimes(3)
      expect(insertAgentLog).toHaveBeenCalledWith(expect.objectContaining({
        agentType: 'memory-detail', operation: 'memory', status: 'error', payloadTotalChars: 0,
      }))
      expect(insertAgentLog).toHaveBeenCalledWith(expect.objectContaining({
        agentType: 'memory-detail', operation: 'retry', status: 'error', payloadTotalChars: 0,
      }))
    })
  })
})
