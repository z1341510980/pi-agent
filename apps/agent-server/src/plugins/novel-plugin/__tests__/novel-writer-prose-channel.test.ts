/**
 * Writer 正文通道隔离（2026-10）。
 *
 * ## 复现的问题
 *
 * 上游网关（灵算 edge.lingsuan.org 的 gemini-3.8-flash-high）把 Gemini 的 thought
 * 摘要拍平进 `delta.content`：既没有 `reasoning_content` 字段，usage 里也没有
 * `reasoning_tokens`，而思考与草稿**逐句交替**：
 *
 *   `墨蓝色的天幕低垂，一轮清冷的明月被薄云半遮。 This forms the initial setting, focusing on…`
 *
 * 于是"思考"与"正文"在 content 通道里字段级/增量级都无法区分。实测 ch7 有 writer
 * 输出把英文思考原样带进正文（`陈建国 asks about the purpose of the demonstration; …`），
 * 并且被后续 prompt 当作"当前场正文"回灌，越滚越脏。
 *
 * ## 修复
 *
 * 正文改由 `novel_submit_prose` 工具提交，走 `tool_calls` 通道，与 content 物理隔离。
 * 文本通道保留兜底（provider 不支持工具、模型漏调用），并配一次同会话纠正轮。
 *
 * 这组用例就是"脏文本 + 干净工具参数"这个组合的回归护栏。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { NovelOrchestrator } from '../core/novel-orchestrator.js'
import type { CreationOptions } from '../core/chapter-finalizer.js'

/** 实测形态的脏输出：中文思考摘要 → 英文推理 → 真正的正文。 */
const CONTAMINATED_RAW = [
  '陈建国审视战术图，强调前线容错率低。热兵器在异界环境不稳定，冷兵器更可靠。',
  '',
  'Prioritizing immediate solutions: medical supplies are the first requirement, followed by rapid implementation of protective gear.',
  '',
  '陈建国抬手在电子战术板上一划，潼关周边的红点态势图瞬间放大。',
  '',
  '“这是前线，没有试错的余暇。”陈建国声音不高，砸在会议桌上却沉重如铁。',
].join('\n')

/** 工具通道提交的干净正文。 */
const CLEAN_PROSE = [
  '陈建国抬手在电子战术板上一划，潼关周边的红点态势图瞬间放大。',
  '',
  '“这是前线，没有试错的余暇。”陈建国声音不高，砸在会议桌上却沉重如铁。',
  '',
  '林薇双手在控制台上快得几乎化作残影，屏幕上的波形图剧烈抖动。',
].join('\n')

interface SessionCapture {
  tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>
  followUpPrompt?: (raw: string) => string | undefined | Promise<string | undefined>
  userMessage?: string
}

function createHarness(config: {
  rawText: string
  submitProse?: string | string[]
  agentType?: string
}): {
  invoke: () => Promise<string>
  capture: SessionCapture
} {
  const orchestrator = Object.create(NovelOrchestrator.prototype) as any
  orchestrator.runStorage = new AsyncLocalStorage()
  orchestrator.pendingUserMessages = new Map()
  orchestrator.store = {
    getChapter: () => ({ narrativeTask: '推进主线', positioning: null }),
    insertAgentLog: vi.fn((entry: Record<string, unknown>) => ({ id: 'log-1', ...entry })),
  }
  orchestrator.engine = {
    buildChapterConstraints: () => ({
      wordBudget: { target: 3000 },
      conflictTargets: [],
      suspenseHooks: [],
      rhythmConstraint: '',
    }),
  }
  orchestrator.promptBuilder = {
    buildAgentIdentity: () => 'identity',
    buildSystemPrompt: () => 'system',
    getChapterBoundaryContext: () => ({
      chapterNumber: 3,
      fromSnapshot: false,
      state: {},
      entities: {
        characters: [], relationships: [], conflicts: [], foreshadowing: [], clues: [],
        factions: [], locations: [], items: [], worldElements: [], informationLayers: [], edges: [],
      },
    }),
    buildChapterContextChunks: () => [{ chunkId: 'chapter-info', content: 'shared' }],
    assembleSharedFromChunks: (chunks: Array<{ chunkId: string; content: string }>) =>
      chunks.map((c) => c.content).join('\n\n---\n\n'),
    chooseChapterEntitySummaryMode: () => 'full',
    buildChapterContextSuffix: () => 'suffix',
    buildArrangedEntitiesSection: () => '',
    buildReferenceFactPack: () => '',
    buildReviewFactPack: () => '',
    buildWriterSceneExpertFocus: () => '',
    stripEmDash: (value: string) => value,
  }
  orchestrator.novelTools = []
  orchestrator.emitProgress = vi.fn()

  const capture: SessionCapture = { tools: [] }
  const submissions = config.submitProse === undefined
    ? []
    : Array.isArray(config.submitProse) ? config.submitProse : [config.submitProse]

  orchestrator.context = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: { prepare: vi.fn() },
    subagentManager: undefined,
    agentCallLogger: undefined,
    createAgUiSession: vi.fn(async (opts: SessionCapture) => {
      capture.tools = opts.tools ?? []
      capture.followUpPrompt = opts.followUpPrompt
      capture.userMessage = opts.userMessage
      let promptCount = 0
      return {
        sessionId: 'session-1',
        session: {
          sessionId: 'session-1',
          subscribe: () => () => {},
          prompt: async (): Promise<string> => {
            const proseTool = capture.tools.find((tool) => tool.name === 'novel_submit_prose')
            // 模拟"模型调用工具交稿"：只在第一轮提交（纠正轮不再提交）
            if (proseTool && promptCount < submissions.length) {
              await proseTool.execute(`call-${promptCount}`, { content: submissions[promptCount] })
            }
            promptCount += 1
            return config.rawText
          },
        },
        streamEmitter: { finishTextMessage: vi.fn(), handleSessionEvent: vi.fn() },
        messageId: 'message-1',
        dispose: vi.fn(),
      }
    }),
  }

  const invoke = async (): Promise<string> => orchestrator.runStorage.run(
    {
      askStoryPolicy: 'allOffWithReferences',
      factPackPathActive: true,
      semiLayerSharedCache: null,
      budget: undefined,
    },
    () => orchestrator.runAgentOnce(
      config.agentType ?? 'writer',
      'p1',
      3,
      '请执行第 1 场的已批准场景契约，写完调用 novel_submit_prose 工具提交本场正文。',
      { emit: vi.fn(), onCheckpoint: vi.fn(), onProgress: vi.fn() } as unknown as CreationOptions,
      {},
    ),
  )

  return { invoke, capture }
}

describe('Writer 正文通道隔离', () => {
  it('工具通道优先：脏文本（中文摘要+英文推理+正文）不再进入正文', async () => {
    const { invoke, capture } = createHarness({
      rawText: CONTAMINATED_RAW,
      submitProse: CLEAN_PROSE,
    })

    const result = await invoke()

    expect(result).toBe(CLEAN_PROSE)
    expect(result).not.toContain('Prioritizing immediate solutions')
    expect(result).not.toContain('陈建国审视战术图')
    // Writer 的会话里必须挂上提交工具
    expect(capture.tools.map((tool) => tool.name)).toContain('novel_submit_prose')
  })

  it('漏调工具时文本兜底仍然脆弱：思考首行是中文就裁不掉（工具通道存在的理由）', async () => {
    const { invoke } = createHarness({ rawText: CONTAMINATED_RAW })

    const result = await invoke()

    // 已知局限：normalizeNovelWriterOutput 以"第一个中文行"为正文起点。
    // 思考摘要用中文写时（本项目实测形态）首行即中文 → 摘要与随后的英文推理都被保留。
    // 这不是回归，而是文本通道能力的上界；工具通道正是为了绕开它。
    // 若将来给文本通道加"最后一个 \n\n\n 之后"之类启发式，请连同本用例一起更新。
    expect(result).toContain('陈建国审视战术图')
    expect(result).toContain('Prioritizing immediate solutions')
    expect(result).toContain('陈建国抬手在电子战术板上一划')
  })

  it('对比：同一条脏文本走工具通道后，只有正文留下', async () => {
    const viaTool = createHarness({ rawText: CONTAMINATED_RAW, submitProse: CLEAN_PROSE })
    const result = await viaTool.invoke()

    expect(result).not.toContain('陈建国审视战术图')
    expect(result).not.toContain('Prioritizing immediate solutions')
  })

  it('漏调工具且正文完全不可用时抛错，不把分析文本当正文', async () => {
    const { invoke } = createHarness({
      rawText: 'The task is to write the scene. I will first check the outline, then draft it.',
    })

    await expect(invoke()).rejects.toThrow(/Writer 输出无效/)
  })

  it('工具参数被拒时不顶掉文本兜底：仍能拿到正文', async () => {
    const { invoke } = createHarness({
      rawText: CONTAMINATED_RAW,
      // 模型把纯英文分析当正文提交 → 工具拒收
      submitProse: 'Analysis: the scene needs more pressure. I will revise it next turn.',
    })

    const result = await invoke()

    expect(result).toContain('陈建国抬手在电子战术板上一划')
  })

  it('漏调工具时提供一次同会话纠正轮；工具已提交时不打扰', async () => {
    const missed = createHarness({ rawText: CONTAMINATED_RAW })
    await missed.invoke()
    const followUp = missed.capture.followUpPrompt
    expect(followUp).toBeTypeOf('function')
    const reminder = await followUp!(CONTAMINATED_RAW)
    expect(reminder).toContain('novel_submit_prose')
    expect(reminder).toContain('对话文本中的正文不会被采用')

    const submitted = createHarness({ rawText: CONTAMINATED_RAW, submitProse: CLEAN_PROSE })
    await submitted.invoke()
    // 已经拿到正文 → 不再要求模型重交（省一轮 LLM）
    expect(await submitted.capture.followUpPrompt!(CONTAMINATED_RAW)).toBeUndefined()
  })

  it('[DIRECTOR_PUSHBACK] 是控制协议：不发纠正轮，也不被工具通道改写', async () => {
    const pushback = '[DIRECTOR_PUSHBACK] 角色动机与章纲存在硬冲突，无法按当前契约创作。'
    const { invoke, capture } = createHarness({ rawText: pushback })

    const result = await invoke()

    expect(result).toBe(pushback)
    expect(await capture.followUpPrompt!(pushback)).toBeUndefined()
  })

  it('工具只挂给 Writer：其他 Agent 的会话里没有 novel_submit_prose', async () => {
    const { invoke, capture } = createHarness({
      agentType: 'director',
      rawText: '规划完成。',
    })

    await invoke()

    expect(capture.tools.map((tool) => tool.name)).not.toContain('novel_submit_prose')
  })
})
