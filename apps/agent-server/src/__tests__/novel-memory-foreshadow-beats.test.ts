import { describe, expect, it, vi } from 'vitest'
import { NovelMemoryGenerator } from '../plugins/novel-plugin/core/novel-memory-generator.js'

describe('NovelMemoryGenerator - 伏笔事件链', () => {
  it('把本章明确的强化状态写成离散 reinforce 节点', () => {
    const foreshadow = {
      id: 'f1',
      description: '旧钥匙上的缺口',
      status: 'planted',
      beats: [{ chapter: 1, type: 'plant' }],
    }
    const updateForeshadow = vi.fn()
    const store = {
      listForeshadowing: vi.fn(() => [foreshadow]),
      updateForeshadow,
    }
    const context = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    const generator = new NovelMemoryGenerator({} as any, {} as any, context as any, store as any, {} as any)

    const stats = (generator as any).applyChanges('p1', {
      foreshadowUpdates: [{
        description: '旧钥匙上的缺口',
        status: 'reinforced',
        beatType: 'reinforce',
        beatNote: '同样的缺口出现在密室锁芯上',
      }],
    }, 5)

    expect(updateForeshadow).toHaveBeenCalledWith('f1', {
      status: 'reinforced',
      beats: [
        { chapter: 1, type: 'plant' },
        { chapter: 5, type: 'reinforce', note: '同样的缺口出现在密室锁芯上' },
      ],
    })
    expect(stats.foreshadowUpdatesApplied).toBe(1)
  })

  it('仅保持原状态时不会凭空生成章节节点', () => {
    const foreshadow = {
      id: 'f1', description: '旧钥匙上的缺口', status: 'reinforced',
      beats: [{ chapter: 1, type: 'plant' }, { chapter: 5, type: 'reinforce' }],
    }
    const updateForeshadow = vi.fn()
    const store = { listForeshadowing: vi.fn(() => [foreshadow]), updateForeshadow }
    const context = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
    const generator = new NovelMemoryGenerator({} as any, {} as any, context as any, store as any, {} as any)

    ;(generator as any).applyChanges('p1', {
      foreshadowUpdates: [{ description: '旧钥匙上的缺口', status: 'reinforced' }],
    }, 6)

    expect(updateForeshadow).toHaveBeenCalledWith('f1', { status: 'reinforced' })
  })
})
