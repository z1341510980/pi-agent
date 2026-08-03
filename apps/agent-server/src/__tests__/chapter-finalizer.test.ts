import { describe, expect, it, vi } from 'vitest'
import { ChapterFinalizer } from '../core/agent/chapter-finalizer.js'

describe('ChapterFinalizer', () => {
  // 用 mock 依赖构造实例，测试纯函数方法
  const mockContext = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any
  const finalizer = new ChapterFinalizer(
    {} as any, {} as any, {} as any, {} as any, mockContext,
  )

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
        getProject: () => ({ currentChapter: 4 }),
        getChapter: (_projectId: string, chapterNumber: number) => ({
          content: chapterNumber === 3 ? '第三章已有正文' : '',
        }),
      }
      const guardedFinalizer = new ChapterFinalizer(
        store as any, {} as any, {} as any, {} as any, mockContext,
      ) as any

      expect(guardedFinalizer.hasLaterCompletedChapter('p1', 2)).toBe(true)
      expect(guardedFinalizer.hasLaterCompletedChapter('p1', 4)).toBe(false)
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
        listFactions: vi.fn(() => []), listLocations: vi.fn(() => []),
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
