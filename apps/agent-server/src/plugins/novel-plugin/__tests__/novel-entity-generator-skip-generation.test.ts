/**
 * ai-arrange 全复用时跳过生成阶段
 *
 * `generatePlanInBatches` 此前无条件执行。项目实体齐备后，规划返回的清单
 * 常常全是「已有：X」—— 这是当前的典型情况，而不是边缘情况。
 * 此时批次循环虽然不会真的发起 LLM 调用（候选集为空），但外层仍会
 * 报「正在生成」的进度、写一条"生成完成"日志，并让 arrange 阶段
 * 等这个 async 往返。这里覆盖短路条件与边界：只要有一项是新建就不能跳过。
 */
import { describe, expect, it, vi } from 'vitest'
import { NovelEntityGenerator } from '../core/generation/novel-entity-generator.js'

interface ProgressEvent {
  phase: string
  message: string
  data?: unknown
}

const EMPTY_PLAN = {
  characters: [],
  conflicts: [],
  foreshadows: [],
  factions: [],
  locations: [],
  items: [],
}

function createGenerator(): {
  run: (plan: unknown) => Promise<{ itemCount: number; batchCount: number }>
  events: ProgressEvent[]
  batchCalls: () => number
  infoLogs: () => string[]
} {
  const generator = Object.create(NovelEntityGenerator.prototype) as Record<string, unknown>
  const infoLogs: string[] = []
  generator.context = {
    logger: {
      info: (_payload: unknown, message?: string) => { infoLogs.push(message ?? '') },
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }

  // 真正发起 LLM 调用的入口：断言它一次都没被调用
  const generateEntityBatch = vi.fn(async () => ({
    generated: new Map(),
    failedIndexes: [],
    usage: undefined,
  }))
  generator.generateEntityBatch = generateEntityBatch
  generator.kindLabel = (kind: string) => kind

  const events: ProgressEvent[] = []

  return {
    run: (plan) =>
      (generator.generatePlanInBatches as (...args: unknown[]) => Promise<{ itemCount: number; batchCount: number }>)
        .call(generator, 'p1', plan, (e: ProgressEvent) => events.push(e), undefined),
    events,
    batchCalls: () => generateEntityBatch.mock.calls.length,
    infoLogs: () => infoLogs,
  }
}

describe('generatePlanInBatches：全复用时短路', () => {
  it('清单全是「已有：X」→ 不发起任何生成调用', async () => {
    const g = createGenerator()

    const run = await g.run({
      ...EMPTY_PLAN,
      characters: [{ coreStyle: '已有：叶明远' }],
      foreshadows: [{ coreStyle: '已有：第七处深层节点' }, { coreStyle: '复用：旧伏笔' }],
    })

    expect(g.batchCalls()).toBe(0)
    expect(run.batchCount).toBe(0)
    expect(run.itemCount).toBe(0)
  })

  it('明确上报「全部复用」，而不是误报正在生成', async () => {
    const g = createGenerator()

    await g.run({ ...EMPTY_PLAN, characters: [{ coreStyle: '已有：叶明远' }] })

    expect(g.events).toHaveLength(1)
    expect(g.events[0]?.message).toContain('跳过实体生成')
    expect(g.events[0]?.data).toMatchObject({ skippedGeneration: true })
    expect(g.infoLogs().some((m) => m.includes('跳过生成阶段'))).toBe(true)
  })

  it('空清单同样短路（没有实体可编排）', async () => {
    const g = createGenerator()

    const run = await g.run(EMPTY_PLAN)

    expect(g.batchCalls()).toBe(0)
    expect(run.batchCount).toBe(0)
  })

  it('哪怕只有一项是新建也不跳过 —— 短路条件必须是"全部"复用', async () => {
    const g = createGenerator()

    await g.run({
      ...EMPTY_PLAN,
      characters: [{ coreStyle: '已有：叶明远' }, { coreStyle: '冷峻的调查员' }],
    })

    expect(g.batchCalls()).toBe(1)
    expect(g.events.some((e) => (e.data as { skippedGeneration?: boolean })?.skippedGeneration)).toBe(false)
  })

  it('新建项分布在不同实体类型时也不跳过', async () => {
    const g = createGenerator()

    await g.run({
      ...EMPTY_PLAN,
      characters: [{ coreStyle: '已有：叶明远' }],
      locations: [{ coreStyle: '废弃的地下实验室' }],
    })

    expect(g.batchCalls()).toBe(1)
  })

  it('英文 existing 与半角冒号写法同样识别为复用', async () => {
    const g = createGenerator()

    const run = await g.run({
      ...EMPTY_PLAN,
      items: [{ coreStyle: 'existing: 第七枚节点标记' }],
    })

    expect(g.batchCalls()).toBe(0)
    expect(run.itemCount).toBe(0)
  })
})
