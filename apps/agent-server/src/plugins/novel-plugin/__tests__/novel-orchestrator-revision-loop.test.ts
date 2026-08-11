/**
 * NovelOrchestrator 定向修订循环（runTargetedRevisionLoop）护栏测试。
 *
 * 背景（用户反馈：点击「修订」后仍未通过正文表达质量门，最终阻止落库）：
 *   旧实现里 Reviser 结束即各自判断：cliche 残留直接 return error（无补救轮）、
 *   形态问题最多一次修补，且失败后修订稿随服务端进程丢弃 —— 前端只能「整条重跑」，
 *   从 Director 重新生成，token 全部白烧。
 *
 * 新实现（本测试守护的行为）：
 *   1. **保留成果**：失败结果返回当前修订稿 content + failedItems + revisionRounds，
 *      不再丢弃修订稿。
 *   2. **限轮次**：最多 MAX_AUTO_REVISION_ROUNDS（2）轮自动修订，绝不无限重试。
 *   3. **定向**：第 2 轮起只针对未通过项（buildRoundPrompt 收到 failedItems）。
 *   4. **防停滞**：上一轮 0 patch 应用则立即停止，不再白烧一轮。
 *   5. **起点即干净**：earlyPassIfClean=true（re-revise）时扫描无未通过项直接通过。
 *
 * 测试直接调用私有 runTargetedRevisionLoop，把 runAgent mock 成「应用一个 patch」
 * 来驱动循环（工具化方案下 patch 通过 novel_apply_revision 工具的闭包写入 draft）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'
import type { NovelEngine } from '../core/novel-engine.js'
import type { PluginContext } from '../../../core/plugin/plugin-types.js'
import type { CreationOptions } from '../../../core/agent/chapter-finalizer.js'
import { createNovelFixture, FIXTURE_TARGET_CHAPTER, type NovelFixture } from './fixtures/novel-fixture.js'

/** 恒定命中的强制 AI 腔句式（ending_summary）：修订复检必不过 */
const DIRTY_FRAGMENT = '就这样，一切都结束了。'
/** 替换用的干净结尾（无 AI 腔句式） */
const CLEAN_FRAGMENT = '他关上门，走廊里的灯熄了。'

/** 干净叙述：单个长段、无对话、无 AI 腔句式（段落数 < 形态检查下限 → 形态门跳过） */
function cleanNarration(): string {
  const sentences: string[] = []
  for (let i = 1; i <= 40; i += 1) {
    sentences.push(`他走到窗边数到第${i}下，把窗帘拉上，又回到桌前坐好。`)
  }
  return sentences.join('')
}

/** 恒脏正文：干净叙述末尾带一个强制 AI 腔句式 */
function dirtyContent(): string {
  return `${cleanNarration()}${DIRTY_FRAGMENT}`
}

/** runAgent 的 mock 类型：能拿到 overrides.extraTools[0]（novel_apply_revision 工具） */
type ApplyRevisionTool = {
  execute: (id: string, params: { pairs: Array<{ from: string; to: string }> }) => Promise<unknown>
}

interface LoopInvocationParams {
  initialContent: string
  earlyPassIfClean?: boolean
}

interface LoopInvocationResult {
  content: string
  status: 'passed' | 'blocked'
  rounds: Array<{
    round: number
    appliedPatches: number
    failedPatches: number
    remainingFailures: Array<{ gateId: string }>
    contentLength: number
  }>
  failedItems: Array<{ gateId: string; reason: string }>
}

describe('NovelOrchestrator 定向修订循环', () => {
  let fx: NovelFixture
  let orchestrator: NovelOrchestrator
  /** 每次用例前重设：默认「应用一个 patch（DIRTY_FRAGMENT→to）」 */
  let runAgentMock: ReturnType<typeof vi.fn>
  let promptByRound: string[]
  let progressEvents: Array<{ phase: string; data?: { message?: string } }>

  const options: CreationOptions = {
    emit: vi.fn(),
    onCheckpoint: vi.fn(async () => 'approve'),
    onProgress: (event: { phase: string; data?: { message?: string } }) => { progressEvents.push(event) },
    onConversationMessage: vi.fn(),
  } as unknown as CreationOptions

  beforeAll(() => {
    fx = createNovelFixture()
    const silentLogger = {
      debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {}, fatal: () => {},
      child: () => silentLogger,
    }
    const context = {
      logger: silentLogger,
      db: fx.db,
      subagentManager: undefined,
      agentCallLogger: undefined,
      createAgUiSession: vi.fn(),
    } as unknown as PluginContext
    const engine = { buildChapterConstraints: () => fx.constraints } as unknown as NovelEngine
    orchestrator = new NovelOrchestrator(
      fx.store,
      fx.memoryStore,
      [], // novelTools：修订循环的 apply_revision 工具由 overrides 注入
      undefined as never, // promptBuilder：runAgent 被 mock，不触达
      engine,
      context,
      undefined,
    )
  })

  afterAll(() => {
    fx.close()
  })

  beforeEach(() => {
    promptByRound = []
    progressEvents = []
    // 默认 mock：每个修订轮「应用 1 个成功 patch」—— 替换 DIRTY_FRAGMENT → to。
    // to 由用例指定：to === DIRTY_FRAGMENT（内容不变，恒失败）或干净结尾（一轮通过）。
    runAgentMock = vi.fn(async (_agentType: string, _projectId: string, _chapterNumber: number, _input: string, _opts: unknown, overrides?: { extraTools?: ApplyRevisionTool[] }) => {
      const tool = overrides?.extraTools?.[0]
      if (tool) {
        await tool.execute('test-tool-call', { pairs: [{ from: DIRTY_FRAGMENT, to: DIRTY_FRAGMENT }] })
      }
      return '已应用修订。'
    })
    vi.spyOn(orchestrator as unknown as { runAgent: typeof runAgentMock }, 'runAgent').mockImplementation(runAgentMock)
  })

  async function invokeLoop(params: LoopInvocationParams): Promise<LoopInvocationResult> {
    const result = await (orchestrator as unknown as {
      runTargetedRevisionLoop: (p: {
        projectId: string
        chapterNumber: number
        options: CreationOptions
        initialContent: string
        earlyPassIfClean?: boolean
        buildRoundPrompt: (ctx: { round: number; content: string }) => string
      }) => Promise<LoopInvocationResult>
    }).runTargetedRevisionLoop({
      projectId: fx.projectId,
      chapterNumber: FIXTURE_TARGET_CHAPTER,
      options,
      initialContent: params.initialContent,
      earlyPassIfClean: params.earlyPassIfClean,
      buildRoundPrompt: ({ round }) => {
        promptByRound.push(`round-${round}`)
        return `prompt-${round}`
      },
    })
    return result
  }

  it('恒脏正文：自动修订最多 2 轮即停，不无限重试', async () => {
    const result = await invokeLoop({ initialContent: dirtyContent() })

    expect(result.status).toBe('blocked')
    expect(result.rounds).toHaveLength(2) // 主修订 + 定向修补，恰好两轮
    expect(runAgentMock).toHaveBeenCalledTimes(2) // 两轮各一次 Reviser 调用
    expect(promptByRound).toEqual(['round-1', 'round-2'])
    // 每轮都成功应用了 1 个 patch（工具调用），但仍未通过
    expect(result.rounds.map(r => r.appliedPatches)).toEqual([1, 1])
    // 失败结果保留修订稿与具体未通过项（不再裸 error 丢弃成果）
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.failedItems.length).toBeGreaterThan(0)
    expect(result.failedItems[0].gateId).toBe('cliche-patterns')
    expect(result.rounds.every(r => r.remainingFailures.length > 0)).toBe(true)
  })

  it('上一轮 0 patch 应用：立即停止，不白烧第 2 轮', async () => {
    // mock 不调用工具 → 每轮 0 patch
    runAgentMock.mockImplementation(async () => '未调用工具。')
    const result = await invokeLoop({ initialContent: dirtyContent() })

    expect(result.status).toBe('blocked')
    expect(result.rounds).toHaveLength(1) // 第 1 轮 0 patch → 停止
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(result.rounds[0].appliedPatches).toBe(0)
  })

  it('首轮修订通过（patch 生效后复检干净）：单轮结束，返回 passed', async () => {
    // 每个修订轮把 DIRTY_FRAGMENT 替换成干净结尾 → 第 1 轮后复检即通过
    runAgentMock.mockImplementation(async (_a: string, _b: string, _c: number, _d: string, _o: unknown, overrides?: { extraTools?: ApplyRevisionTool[] }) => {
      const tool = overrides?.extraTools?.[0]
      if (tool) {
        await tool.execute('test-tool-call', { pairs: [{ from: DIRTY_FRAGMENT, to: CLEAN_FRAGMENT }] })
      }
      return '已应用修订。'
    })
    const result = await invokeLoop({ initialContent: dirtyContent() })

    expect(result.status).toBe('passed')
    expect(result.rounds).toHaveLength(1)
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(result.failedItems).toHaveLength(0)
    // 修订稿内容已更新（脏片段被替换）
    expect(result.content).toContain(CLEAN_FRAGMENT)
    expect(result.content).not.toContain(DIRTY_FRAGMENT)
  })

  it('earlyPassIfClean=true（re-revise）且起点已干净：零调用直接通过', async () => {
    const result = await invokeLoop({ initialContent: cleanNarration(), earlyPassIfClean: true })

    expect(result.status).toBe('passed')
    expect(result.rounds).toHaveLength(0) // 不白烧一轮
    expect(runAgentMock).not.toHaveBeenCalled()
  })

  it('主流程（earlyPassIfClean 缺省）即使起点干净也会走首轮（用户明确选择修订）', async () => {
    const result = await invokeLoop({ initialContent: cleanNarration() })

    // 主流程首轮必然执行：确定性门干净不代表语义审稿意见无可改之处。
    // 首轮结束后复检仍干净 → passed（不因「0 patch」误判为阻止落库：
    // 确定性质量门本就没有未通过项，没有理由拦住落库）。
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(result.rounds).toHaveLength(1)
    expect(result.status).toBe('passed')
    expect(result.failedItems).toHaveLength(0)
  })

  it('第 2 轮起提示词只带未通过项：buildRoundPrompt 第 2 次调用收到 failedItems（定向不扩散）', async () => {
    const receivedFailedItems: Array<unknown[]> = []
    await (orchestrator as unknown as {
      runTargetedRevisionLoop: (p: {
        projectId: string
        chapterNumber: number
        options: CreationOptions
        initialContent: string
        buildRoundPrompt: (ctx: { round: number; content: string; failedItems: unknown[] }) => string
      }) => Promise<unknown>
    }).runTargetedRevisionLoop({
      projectId: fx.projectId,
      chapterNumber: FIXTURE_TARGET_CHAPTER,
      options,
      initialContent: dirtyContent(),
      buildRoundPrompt: ({ round, failedItems }) => {
        receivedFailedItems.push(failedItems)
        return `prompt-${round}`
      },
    })

    // 两轮都带着当轮扫描出的未通过项
    expect(receivedFailedItems).toHaveLength(2)
    expect(receivedFailedItems[0]).toHaveLength(1) // cliche-patterns
    expect(receivedFailedItems[1]).toHaveLength(1) // 恒脏 → 第 2 轮仍只有 cliche-patterns
  })

  it('修订轮次有进度事件（第 2 轮起提示「定向修补」）', async () => {
    await invokeLoop({ initialContent: dirtyContent() })
    // emitProgress 把文案放在 event.data.message（CreationFlowEvent 契约）
    const repairMessage = progressEvents.find(
      e => e.phase === 'revising' && String(e.data?.message ?? '').includes('第 2 轮定向修补'),
    )
    expect(repairMessage).toBeDefined()
  })
})
