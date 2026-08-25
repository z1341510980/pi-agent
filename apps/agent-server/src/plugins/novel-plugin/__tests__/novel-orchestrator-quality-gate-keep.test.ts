/**
 * 质量门未过审不再扣留草稿（用户反馈驱动）。
 *
 * 背景（实测 novel_workflow_runs 数据）：
 *   旧逻辑在自动修订轮次耗尽仍未通过确定性质量门时 return error，
 *   Writer/Reviser 的几千字成果锁死在 run 记录里、章节正文为空 ——
 *   用户看到的就是"消失了"。30 次 run 里 10 份草稿被这样扣留。
 *
 * 新行为（本测试守护）：
 *   1. blocked 时不再返回 error：保留当前最好版本继续走 finalizer.finalize 落库；
 *   2. 结果携带 qualityWarnings（message + failedItems + revisionRounds），
 *      前端据此展示「待处理表达问题」，而不是静默通过；
 *   3. 版本来源 trigger 标注「未过审保留」，版本历史可审计；
 *   4. 未应用任何 patch 时保留原稿（而非空修订稿）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, it, expect, vi } from 'vitest'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'

async function invokeExtraTool(overrides: unknown, params: Record<string, unknown>): Promise<void> {
  const tools = (overrides as { extraTools?: Array<{ execute: (id: string, p: Record<string, unknown>) => Promise<unknown> }> } | undefined)?.extraTools
  if (!tools || tools.length === 0) return
  await tools[0]!.execute('test-call', params)
}

const DIRECTOR_TOOL_PARAMS = {
  taskType: 'advance_mainline',
  priority: 'high',
  narrativeTask: '本章核心目标：推进主线。',
  secondaryTasks: [],
  requiredReferences: [],
  chapterEndingHook: { type: 'suspense', description: '章尾钩子' },
  povCharacters: ['主角'],
  sceneCount: 1,
  positioning: 'high_pressure',
  timelineOffset: { days: 0, description: '同日' },
}

const REVIEWER_TOOL_PARAMS = {
  consistencyScore: 8, characterScore: 7, taskCompletionScore: 9, clueProgressScore: 6,
  foreshadowStatusScore: 8, conflictChangeScore: 7, pacingScore: 6, infoControlScore: 9,
  readerHookScore: 8, styleScore: 7, overallScore: 7.5, verdict: 'accept' as const,
  issues: [], suggestions: [],
}

const WRITER_DRAFT = '第一章的完整正文。'
const BLOCKED_CONTENT = '修订后的正文（未过审）'
const FAILED_ITEMS = [{ gateId: 'cliche-patterns', reason: 'AI 腔句式命中' }]
const ROUNDS = [
  { round: 1, appliedPatches: 1, failedPatches: 0, remainingFailures: FAILED_ITEMS, contentLength: BLOCKED_CONTENT.length },
]

/** 沿用 novel-orchestrator-interject.test.ts 的轻量编排模式 */
function createHarness(opts: { loopBlocked: boolean } = { loopBlocked: true }): {
  orchestrator: NovelOrchestrator
  finalizeMock: ReturnType<typeof vi.fn>
} {
  const instance = Object.create(NovelOrchestrator.prototype) as Record<string, unknown>
  instance.runStorage = new AsyncLocalStorage()
  instance.pendingUserMessages = new Map()
  instance.store = {
    getNovelModelId: () => undefined,
    getProject: () => ({ currentStage: 'setup', rhythmModelId: 'default', currentChapter: 1 }),
    getWritingStyleProfile: () => undefined,
    listChapters: () => [],
    listConflicts: () => [],
    listForeshadowing: () => [],
    getChapter: () => ({ id: 'chapter-1', positioning: null }),
    listHooksByChapter: () => [],
  }
  instance.promptBuilder = {
    stripEmDash: (value: string) => value,
    buildProseEditorIdentity: () => '文字编辑身份',
    buildReviewFactPack: vi.fn(() => ''),
    getChapterBoundaryContext: () => ({
      chapterNumber: 1,
      fromSnapshot: false,
      state: {},
      entities: {
        characters: [], relationships: [], conflicts: [], foreshadowing: [], clues: [],
        factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
      },
    }),
  }
  instance.context = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
  instance.engine = {
    buildChapterConstraints: () => ({ wordBudget: { target: 3000 } }),
    saveReview: vi.fn(async () => ({})),
  }
  instance.runAgent = vi.fn(async (
    agentType: string,
    _projectId: string,
    _chapterNumber: number,
    _input: string,
    _options: unknown,
    overrides?: unknown,
  ) => {
    if (agentType === 'director') {
      await invokeExtraTool(overrides, DIRECTOR_TOOL_PARAMS)
      return 'Director 已通过工具提交叙事任务'
    }
    if (agentType === 'writer') return WRITER_DRAFT
    if (agentType === 'reviewer') {
      await invokeExtraTool(overrides, REVIEWER_TOOL_PARAMS).catch(() => {})
    }
    return '验收通过'
  })
  instance.runPostWriteGuard = vi.fn(() => ({ shouldRewrite: false, reason: '' }))
  // 钉住修订循环结果：blocked（未过审）或 passed（对照）
  instance.runTargetedRevisionLoop = opts.loopBlocked
    ? vi.fn(async () => ({
        status: 'blocked' as const,
        content: BLOCKED_CONTENT,
        failedItems: FAILED_ITEMS,
        rounds: ROUNDS,
      }))
    : vi.fn(async () => ({ status: 'passed' as const, content: BLOCKED_CONTENT, failedItems: [], rounds: ROUNDS }))
  const finalizeMock = vi.fn(async ({ content }: { content: string }) => ({ status: 'completed', content }))
  instance.finalizer = { finalize: finalizeMock }
  return { orchestrator: instance as unknown as NovelOrchestrator, finalizeMock }
}

function flowOptions(reviewCheckpointDecision: 'revise' | 'approve' = 'revise'): {
  emit: ReturnType<typeof vi.fn>
  onCheckpoint: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
} {
  return {
    emit: vi.fn(),
    // 检查点 1（叙事任务）必须 approve，否则会重跑 Director 形成死循环；
    // 只有检查点 2（验收报告）按用例意图返回 revise/approve。
    onCheckpoint: vi.fn(async (cp: { type: string }) =>
      cp.type === 'narrative_task' ? ('approve' as const) : reviewCheckpointDecision),
    onProgress: vi.fn(),
  }
}

describe('质量门未过审：草稿绝不扣留', () => {
  it('修订循环 blocked 时仍落库，结果携带 qualityWarnings，版本标注未过审保留', async () => {
    const { orchestrator: orch, finalizeMock } = createHarness({ loopBlocked: true })

    const result = await orch.createChapterWithFlow('project', 1, flowOptions('revise'))

    // 不再是 error：修订稿已落库
    expect(result.status).toBe('completed')
    expect(result.content).toBe(BLOCKED_CONTENT)
    expect(finalizeMock).toHaveBeenCalledTimes(1)
    // 警告随结果返回：前端据此展示待处理问题与修订审计
    expect(result.qualityWarnings).toBeDefined()
    expect(result.qualityWarnings?.failedItems).toEqual(FAILED_ITEMS)
    expect(result.qualityWarnings?.revisionRounds).toEqual(ROUNDS)
    expect(result.qualityWarnings?.message).toContain('1 轮后仍有 1 项')
    expect(result.qualityWarnings?.message).toContain('保留')
    // 版本来源标注可审计
    const finalizeParams = finalizeMock.mock.calls[0]?.[0] as { versionSource?: { trigger?: string } }
    expect(finalizeParams.versionSource?.trigger).toContain('未过审')
    expect(finalizeParams.versionSource?.trigger).toContain('1 项待处理')
    // 无 errorCode / failedPhase：不是失败语义
    expect(result.errorCode).toBeUndefined()
    expect(result.failedPhase).toBeUndefined()
  })

  it('零 patch 应用时保留原稿落库，消息说明"按审稿意见保留原稿"', async () => {
    const { orchestrator: orch, finalizeMock } = createHarness({ loopBlocked: true })
    ;(orch as unknown as { runTargetedRevisionLoop: ReturnType<typeof vi.fn> }).runTargetedRevisionLoop
      .mockResolvedValue({
        status: 'blocked',
        content: WRITER_DRAFT, // 未应用任何修改：内容等于初稿
        failedItems: FAILED_ITEMS,
        rounds: [{ round: 1, appliedPatches: 0, failedPatches: 1, remainingFailures: FAILED_ITEMS, contentLength: WRITER_DRAFT.length }],
      })

    const result = await orch.createChapterWithFlow('project', 1, flowOptions('revise'))

    expect(result.status).toBe('completed')
    expect(result.content).toBe(WRITER_DRAFT)
    expect(result.qualityWarnings?.message).toContain('保留原稿')
    const finalizeParams = finalizeMock.mock.calls[0]?.[0] as { versionSource?: { trigger?: string } }
    expect(finalizeParams.versionSource?.trigger).toContain('按原稿保留落库')
  })

  it('对照：修订通过时无 qualityWarnings，版本来源为常规 Reviser 落库', async () => {
    const { orchestrator: orch, finalizeMock } = createHarness({ loopBlocked: false })

    const result = await orch.createChapterWithFlow('project', 1, flowOptions('revise'))

    expect(result.status).toBe('completed')
    expect(result.qualityWarnings).toBeUndefined()
    const finalizeParams = finalizeMock.mock.calls[0]?.[0] as { versionSource?: { trigger?: string } }
    expect(finalizeParams.versionSource?.trigger).toBe('Reviser 修订后落库')
  })
})
