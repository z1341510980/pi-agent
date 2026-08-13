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
      withTransaction: (fn: () => unknown) => fn(),
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
    const store = { listForeshadowing: vi.fn(() => [foreshadow]), updateForeshadow, withTransaction: (fn: () => unknown) => fn() }
    const context = { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
    const generator = new NovelMemoryGenerator({} as any, {} as any, context as any, store as any, {} as any)

    ;(generator as any).applyChanges('p1', {
      foreshadowUpdates: [{ description: '旧钥匙上的缺口', status: 'reinforced' }],
    }, 6)

    expect(updateForeshadow).toHaveBeenCalledWith('f1', { status: 'reinforced' })
  })

  it('普通疑点进入线索系统，不满足准入条件的新伏笔会被拦截', () => {
    const createForeshadow = vi.fn()
    const createClue = vi.fn()
    const createEntityCandidate = vi.fn()
    const store = {
      listForeshadowing: vi.fn(() => []),
      createForeshadow,
      listClues: vi.fn(() => []),
      createClue,
      createEntityCandidate,
      withTransaction: (fn: () => unknown) => fn(),
    }
    const context = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    const generator = new NovelMemoryGenerator({} as any, {} as any, context as any, store as any, {} as any)

    const stats = (generator as any).applyChanges('p1', {
      foreshadowCreates: [{
        description: '赵岩没有询问孙疤去向',
        category: 'event',
        beatNote: '赵岩保持沉默',
      }],
      clueCreates: [{
        description: '赵岩的笔记本上记录着孙疤失踪前夜的活动',
        pointsTo: '赵岩可能知道孙疤失踪的内情',
        progress: 10,
        currentStep: '叶明远注意到异常沉默',
        nextStep: '观察赵岩是否暗中调查',
      }],
    }, 9)

    expect(createForeshadow).not.toHaveBeenCalled()
    // V2 决策 3：全新线索不再直接创建正式实体，转为 needs_review 候选待用户确认
    expect(createClue).not.toHaveBeenCalled()
    expect(createEntityCandidate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1',
      entityType: 'clue',
      payload: expect.objectContaining({
        description: '赵岩的笔记本上记录着孙疤失踪前夜的活动',
        pointsTo: '赵岩可能知道孙疤失踪的内情',
        progress: 10,
      }),
    }))
    expect(stats.foreshadowCreatesApplied).toBe(0)
    expect(stats.clueCreatesApplied).toBe(0)
    expect(stats.candidateCreatesApplied).toBe(1)
  })

  it('高价值暗线伏笔有隐藏问题和回收计划时才允许创建', () => {
    const createForeshadow = vi.fn()
    const store = {
      listForeshadowing: vi.fn(() => []),
      createForeshadow,
      withTransaction: (fn: () => unknown) => fn(),
    }
    const context = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    const generator = new NovelMemoryGenerator({} as any, {} as any, context as any, store as any, {} as any)

    const stats = (generator as any).applyChanges('p1', {
      foreshadowCreates: [{
        description: '父亲遗物编号与旧案卷宗一致',
        category: 'secret',
        importance: 'critical',
        narrativeRole: 'dark_line',
        hiddenQuestion: '父亲真正因何死亡',
        plannedPayoff: '查到旧案主谋时揭示编号来源',
        beatNote: '主角第一次看到相同编号',
      }],
    }, 3)

    expect(createForeshadow).toHaveBeenCalledTimes(1)
    expect(createForeshadow).toHaveBeenCalledWith(expect.objectContaining({
      description: '父亲遗物编号与旧案卷宗一致',
      status: 'planted',
      beats: [{ chapter: 3, type: 'plant', note: '主角第一次看到相同编号' }],
    }))
    expect(stats.foreshadowCreatesApplied).toBe(1)
  })
})
