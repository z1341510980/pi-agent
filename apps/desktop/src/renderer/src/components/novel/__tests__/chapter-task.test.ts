import { describe, expect, it } from 'vitest'
import {
  foreshadowHasBeatAtChapter,
  resolveChapterTaskKind,
  resolveRetryChapterTask,
  resolveWritingTaskKind,
} from '../chapter-task'

describe('foreshadowHasBeatAtChapter', () => {
  it('事件链模式只在实际节点章节向 Writer 注入伏笔', () => {
    const foreshadow = {
      firstChapter: 2,
      recoverByChapter: 10,
      beats: [
        { chapter: 2, type: 'plant' as const },
        { chapter: 5, type: 'reinforce' as const },
        { chapter: 10, type: 'payoff' as const },
      ],
    }

    expect(foreshadowHasBeatAtChapter(foreshadow, 2)).toBe(true)
    expect(foreshadowHasBeatAtChapter(foreshadow, 5)).toBe(true)
    expect(foreshadowHasBeatAtChapter(foreshadow, 10)).toBe(true)
    expect(foreshadowHasBeatAtChapter(foreshadow, 3)).toBe(false)
    expect(foreshadowHasBeatAtChapter(foreshadow, 9)).toBe(false)
  })

  it('旧数据没有 beats 时仅回退到埋设点和回收点', () => {
    const legacyForeshadow = {
      firstChapter: 2,
      recoverByChapter: 10,
    }

    expect(foreshadowHasBeatAtChapter(legacyForeshadow, 2)).toBe(true)
    expect(foreshadowHasBeatAtChapter(legacyForeshadow, 10)).toBe(true)
    expect(foreshadowHasBeatAtChapter(legacyForeshadow, 6)).toBe(false)
  })
})

describe('chapter task resolution', () => {
  it('按 Tab 和启动方式解析准确任务类型', () => {
    expect(resolveChapterTaskKind('workflow', 'manual')).toBe('workflow')
    expect(resolveChapterTaskKind('discussion', 'manual')).toBe('discussion')
    expect(resolveChapterTaskKind('reverse', 'manual')).toBe('reverse')
    expect(resolveChapterTaskKind('arrange', 'ai-arrange')).toBe('arrange')
  })

  it('章节重新生成只保留写作引擎，不误触编排或反推', () => {
    expect(resolveWritingTaskKind('discussion')).toBe('discussion')
    expect(resolveWritingTaskKind('workflow')).toBe('workflow')
    expect(resolveWritingTaskKind('reverse')).toBe('workflow')
    expect(resolveWritingTaskKind('arrange')).toBe('workflow')
  })

  it('失败后切换 Tab，重试仍执行原任务快照', () => {
    const originalTask = {
      kind: 'reverse' as const,
      projectId: 'project-1',
      chapterNumber: 8,
    }

    expect(resolveRetryChapterTask(originalTask, 'discussion', 'project-1', 8)).toEqual(originalTask)
    expect(resolveRetryChapterTask(originalTask, 'discussion', 'project-1', 9)).toEqual({
      kind: 'discussion',
      projectId: 'project-1',
      chapterNumber: 9,
    })
  })
})
