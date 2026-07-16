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
      factions: new Map(), locations: new Map(), relationships: new Map(), infoLayers: new Map(),
    } as any

    function makeFinalizer(foreshadows: any[]): { finalizer: ChapterFinalizer; updateForeshadow: ReturnType<typeof vi.fn> } {
      const updateForeshadow = vi.fn()
      const store = {
        listCharacters: vi.fn(() => []),
        listConflicts: vi.fn(() => []),
        listForeshadowing: vi.fn(() => foreshadows),
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
})
