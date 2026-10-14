/**
 * runAgent 的重试外壳
 *
 * 实测 Director 有 28% 的调用失败且全部可重试，而修复前外层没有任何重试 ——
 * 一次网关 502 就废掉整个 create-flow。这里直接驱动 `runAgent`（重试外壳），
 * 把 `runAgentOnce`（单次尝试）替换为可编排的 mock，验证：
 *   - 瞬时失败会重试、成功后返回结果
 *   - 账户类立即失败并换成可操作文案
 *   - 用户取消不重试
 *   - **重试不占 MAX_GUARD_REWRITE 配额** —— 这是最容易被后续改动破坏的一条：
 *     若把重试实现在 createChapterWithFlow 层，几次网络抖动就会吃掉本该
 *     留给「正文质量不合格」的重写次数。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'
import { createChapterBudgetUsage, type ChapterBudgetUsage } from '../core/chapters/chapter-budget.js'

interface Harness {
  orchestrator: {
    runAgent: (
      agentType: string,
      projectId: string,
      chapterNumber: number,
      input: unknown,
      options: unknown,
    ) => Promise<string>
  }
  attempts: () => number
  progressMessages: () => string[]
  warnCount: () => number
  checkpoints: () => Array<{ type: string; data: unknown; options?: string[] }>
  budget: () => ChapterBudgetUsage | undefined
}

/**
 * 构造只含重试/闸门所需依赖的 orchestrator。
 *
 * `sleep` 被替换为立即 resolve：退避时长本身由 llm-error-policy 的单测钉住，
 * 这里只关心重试次数与终止条件，不真的等 17 秒。
 */
function createRetryHarness(
  outcomes: Array<Error | string>,
  options: {
    signal?: { aborted: boolean }
    /** 预置的单章用量，用于驱动成本闸门 */
    budget?: Partial<ChapterBudgetUsage>
    /** 成本闸门检查点的决策 */
    checkpointDecision?: 'approve' | 'reject' | 'revise' | 'rewrite'
  } = {},
): Harness {
  const orchestrator = Object.create(NovelOrchestrator.prototype) as Record<string, unknown>
  const warn = vi.fn()
  orchestrator.context = {
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
  }

  // runAgent 现在会读 run context 里的 budget 做成本闸门判定
  const runStorage = new AsyncLocalStorage<{ budget: ChapterBudgetUsage }>()
  orchestrator.runStorage = runStorage
  const runContext = { budget: { ...createChapterBudgetUsage(), ...options.budget } }

  let attempts = 0
  orchestrator.runAgentOnce = vi.fn(async () => {
    const outcome = outcomes[Math.min(attempts, outcomes.length - 1)]
    attempts += 1
    if (outcome instanceof Error) throw outcome
    return outcome
  })

  // 不真的等待，但保留「signal 中断等待」的语义由生产代码自己处理
  orchestrator.sleep = vi.fn(async () => {})

  const progressMessages: string[] = []
  orchestrator.emitProgress = vi.fn((_options: unknown, _phase: unknown, _type: unknown, data: unknown) => {
    const message = (data as { message?: string })?.message
    if (message) progressMessages.push(message)
  })

  const checkpoints: Array<{ type: string; data: unknown; options?: string[] }> = []
  const runOptions = {
    signal: options.signal,
    onProgress: vi.fn(),
    emit: vi.fn(),
    onCheckpoint: vi.fn(async (cp: { type: string; data: unknown; options?: string[] }) => {
      checkpoints.push(cp)
      return options.checkpointDecision ?? 'approve'
    }),
  }

  return {
    orchestrator: {
      runAgent: (agentType, projectId, chapterNumber, input) =>
        runStorage.run(runContext, () =>
          (orchestrator.runAgent as (...args: unknown[]) => Promise<string>).call(
            orchestrator, agentType, projectId, chapterNumber, input, runOptions,
          ),
        ),
    },
    attempts: () => attempts,
    progressMessages: () => progressMessages,
    warnCount: () => warn.mock.calls.filter((c) => String(c[1] ?? '').includes('重试')).length,
    checkpoints: () => checkpoints,
    budget: () => runContext.budget,
  }
}

describe('runAgent 重试外壳：瞬时失败', () => {
  it('502 后重试并最终成功', async () => {
    const h = createRetryHarness([new Error('502 status code (no body)'), '正文内容'])

    const result = await h.orchestrator.runAgent('director', 'p1', 1, 'task', {})

    expect(result).toBe('正文内容')
    expect(h.attempts()).toBe(2)
  })

  it('连续瞬时失败耗尽 3 次重试后抛出原始错误', async () => {
    const err = new Error('503 Service temporarily unavailable')
    const h = createRetryHarness([err])

    await expect(h.orchestrator.runAgent('director', 'p1', 1, 'task', {})).rejects.toBe(err)

    // 1 次首发 + 3 次重试
    expect(h.attempts()).toBe(4)
  })

  it('重试期间推送进度，避免长时间静默看起来像卡死', async () => {
    const h = createRetryHarness([new Error('Request timed out'), '正文内容'])

    await h.orchestrator.runAgent('director', 'p1', 1, 'task', {})

    expect(h.progressMessages().some((m) => m.includes('重试'))).toBe(true)
  })

  it('每次重试都留下 warn 级日志，便于事后统计抖动频率', async () => {
    const h = createRetryHarness([new Error('fetch failed')])

    await expect(h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})).rejects.toThrow()

    expect(h.warnCount()).toBe(3)
  })
})

describe('runAgent 重试外壳：不可重试的失败', () => {
  it('402 余额不足立即失败，换成可操作文案而非原始英文', async () => {
    const h = createRetryHarness([new Error('402 Insufficient Balance')])

    await expect(h.orchestrator.runAgent('director', 'p1', 1, 'task', {}))
      .rejects.toThrow(/余额不足/)

    expect(h.attempts()).toBe(1)
  })

  it('401 无效 key 立即失败并保留原始错误作为 cause', async () => {
    const original = new Error('401 Invalid API key')
    const h = createRetryHarness([original])

    await expect(h.orchestrator.runAgent('director', 'p1', 1, 'task', {}))
      .rejects.toMatchObject({ cause: original })
  })

  it('tool_calls 未配对立即失败：重试同一份不合法消息必然再失败', async () => {
    const h = createRetryHarness([
      new Error("400 An assistant message with 'tool_calls' must be followed by tool messages"),
    ])

    await expect(h.orchestrator.runAgent('director', 'p1', 1, 'task', {}))
      .rejects.toThrow(/工具调用/)

    expect(h.attempts()).toBe(1)
  })

  it('未识别错误不重试，原样抛出', async () => {
    const err = new Error('某个前所未见的错误')
    const h = createRetryHarness([err])

    await expect(h.orchestrator.runAgent('director', 'p1', 1, 'task', {})).rejects.toBe(err)
    expect(h.attempts()).toBe(1)
  })

  it('Writer 正文格式校验失败不重试，避免同一坏响应进入写作循环', async () => {
    const err = new Error('Writer 输出无效：未返回中文正文，疑似只返回了思考或写作说明')
    const h = createRetryHarness([err])

    await expect(h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})).rejects.toBe(err)
    expect(h.attempts()).toBe(1)
  })

  it('用户已取消时不重试 —— 按了停止不应再打 LLM', async () => {
    const err = new Error('Request was aborted')
    const h = createRetryHarness([err], { signal: { aborted: true } })

    await expect(h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})).rejects.toBe(err)
    expect(h.attempts()).toBe(1)
  })
})

describe('runAgent 重试外壳：与质量重写配额隔离', () => {
  it('重试完全发生在 runAgent 内部，调用方看不到中间失败', async () => {
    // 若重试实现在 createChapterWithFlow 层，网络抖动会消耗 MAX_GUARD_REWRITE，
    // 挤占本该留给「正文质量不合格」的重写次数。这里断言外部只看到一次成功返回。
    const h = createRetryHarness([
      new Error('502 status code (no body)'),
      new Error('Stream ended without finish_reason'),
      '正文内容',
    ])

    const result = await h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})

    expect(result).toBe('正文内容')
    expect(h.attempts()).toBe(3)
  })

  it('MAX_GUARD_REWRITE 仍是 2，未被重试逻辑改动', () => {
    const guardLimit = (NovelOrchestrator as unknown as { MAX_GUARD_REWRITE: number }).MAX_GUARD_REWRITE
    expect(guardLimit).toBe(2)
  })
})

describe('成本闸门：超预算时弹检查点而非硬停', () => {
  it('未超预算不弹检查点', async () => {
    const h = createRetryHarness(['正文内容'], { budget: { llmCalls: 3 } })

    await h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})

    expect(h.checkpoints()).toHaveLength(0)
  })

  it('超预算弹 chapter_budget 检查点，用户选继续则照常调用', async () => {
    const h = createRetryHarness(['正文内容'], { budget: { llmCalls: 30 } })

    const result = await h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})

    expect(result).toBe('正文内容')
    expect(h.checkpoints()[0]?.type).toBe('chapter_budget')
  })

  it('检查点携带各维度当前值与上限，用户才能判断值不值得继续', async () => {
    const h = createRetryHarness(['正文内容'], { budget: { llmCalls: 30, inputTokens: 123_456 } })

    await h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})

    expect(h.checkpoints()[0]?.data).toMatchObject({
      dimension: 'llmCalls',
      llmCalls: 30,
      maxLlmCalls: 30,
      inputTokens: 123_456,
      chapterNumber: 1,
      categories: expect.objectContaining({
        fullChapterRewrites: 0,
        guardWriterRewrites: 0,
        reviserRuns: 0,
        reviewerRuns: 0,
      }),
    })
    expect(h.checkpoints()[0]).toMatchObject({ options: ['approve', 'reject'] })
  })

  it('成本闸门拒绝已移除的 revise 决策且不发起调用', async () => {
    const h = createRetryHarness(['正文内容'], {
      budget: { llmCalls: 30 },
      checkpointDecision: 'revise',
    })

    await expect(h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})).rejects.toThrow(/不支持决策/)
    expect(h.attempts()).toBe(0)
  })

  it('用户选停止 → 抛错，走既有 cancelled 路径，且不发起调用', async () => {
    const h = createRetryHarness(['正文内容'], {
      budget: { llmCalls: 30 },
      checkpointDecision: 'reject',
    })

    await expect(h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})).rejects.toThrow(/成本闸门/)

    // 闸门在发起调用之前生效，不白花一次
    expect(h.attempts()).toBe(0)
  })

  it('确认后标记 acknowledged，同一章不再重复弹框', async () => {
    const h = createRetryHarness(['正文内容'], { budget: { llmCalls: 30 } })

    await h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})
    await h.orchestrator.runAgent('reviewer', 'p1', 1, 'task', {})

    expect(h.budget()?.acknowledged).toBe(true)
    expect(h.checkpoints()).toHaveLength(1)
  })

  it('已 acknowledged 的章节直接跳过闸门', async () => {
    const h = createRetryHarness(['正文内容'], {
      budget: { llmCalls: 90, inputTokens: 2_000_000, acknowledged: true },
    })

    await h.orchestrator.runAgent('writer', 'p1', 1, 'task', {})

    expect(h.checkpoints()).toHaveLength(0)
  })
})
