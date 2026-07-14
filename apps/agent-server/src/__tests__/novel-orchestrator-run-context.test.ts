import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { NovelOrchestrator } from '../plugins/novel-plugin/core/novel-orchestrator.js'

describe('NovelOrchestrator request context', () => {
  it('并发 create-flow 使用独立的编排实体上下文', async () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.runStorage = new AsyncLocalStorage()
    orchestrator.pendingUserMessages = new Map()
    orchestrator.createChapterWithFlowInContext = vi.fn(async (
      _projectId: string,
      _chapterNumber: number,
      _options: unknown,
    ) => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5))
      return {
        status: 'completed',
        content: orchestrator.requireRunContext().arrangedEntities.characterIds[0],
      }
    })

    const [first, second] = await Promise.all([
      orchestrator.createChapterWithFlow('project', 1, {
        arrangedEntities: { characterIds: ['char-a'] },
      }),
      orchestrator.createChapterWithFlow('project', 2, {
        arrangedEntities: { characterIds: ['char-b'] },
      }),
    ])

    expect(first.content).toBe('char-a')
    expect(second.content).toBe('char-b')
  })

  it('检查点用户消息按项目和章节隔离', () => {
    const orchestrator = Object.create(NovelOrchestrator.prototype) as any
    orchestrator.pendingUserMessages = new Map()

    orchestrator.setUserMessages('project', 1, ['第一章意见'])
    orchestrator.setUserMessages('project', 2, ['第二章意见'])

    expect(orchestrator.pendingUserMessages.get('project|1')).toEqual(['第一章意见'])
    expect(orchestrator.pendingUserMessages.get('project|2')).toEqual(['第二章意见'])
  })
})
