import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { NovelBeatPlan, BeatDramaticFunction, NovelChapter } from '@repo/shared/novel'
import type {
  PluginContext,
  PluginPayloadStats,
  PluginSessionHandle
} from '../../../../core/plugin/plugin-types.js'
import type { NovelStore } from '../novel-store.js'
import type { PromptManager } from '../prompting/prompt-manager.js'
import { parseNovelModelRef, type NovelModelSelection } from '../domain/novel-model-ref.js'
import {
  addLlmUsage,
  extractLlmUsageFromMessage,
  type LlmUsageSnapshot
} from '../agent-run-utils.js'

const PROMPT_VERSION = 'beat-planner-v1'
const DEFAULT_BEAT_COUNT = 6
const MIN_VOLUME_OUTLINE_CHARS = 50
const BEAT_FUNCTIONS: readonly BeatDramaticFunction[] = [
  'setup',
  'escalation',
  'false_victory',
  'false_defeat',
  'midpoint_turn',
  'low_point',
  'climax',
  'payoff',
  'aftermath',
  'breather'
]

export interface GenerateBeatPlanParams {
  projectId: string
  volumeNumber: number
  /** 规划的未来章数（默认 6，夹在 3-100） */
  count?: number
  instruction?: string
  modelId?: NovelModelSelection
  signal?: AbortSignal
}

export interface BeatPlanGenerationResult {
  generationId: string
  volumeNumber: number
  startChapter: number
  beats: NovelBeatPlan[]
  notes: string
  warnings: string[]
  /** 提示词版本（诊断与缓存失效用） */
  promptVersion: string
}

export interface GenerateChapterBeatParams {
  projectId: string
  chapterNumber: number
  instruction?: string
  modelId?: NovelModelSelection
  signal?: AbortSignal
}

export interface ChapterBeatGenerationResult {
  generationId: string
  chapterNumber: number
  beat: NovelBeatPlan
  promptVersion: string
}

interface PayloadTotals {
  messagesChars: number
  toolsChars: number
  toolCount: number
  totalChars: number
  roundTrips: number
}

export interface BeatPlanDraftItem {
  chapterNumber: number
  dramaticFunction: BeatDramaticFunction
  emotionalDebt: string
  payoff: string
  arcPosition: string
  summary: string
}

export interface BeatPlanDraft {
  beats: BeatPlanDraftItem[]
  notes: string
}

function truncate(value: string | null | undefined, limit: number): string {
  const text = value?.trim() ?? ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[内容已截断]`
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * 解析并校验节拍表草稿。
 *
 * 校验规则（任一失败抛错，调用方不落库）：
 * - beats 非空数组；dramaticFunction 必须是十种枚举之一（容忍大小写）
 * - chapterNumber 从 startChapter 起连续递增、无重复、不超过 count 个
 */
export function parseBeatPlanDraft(
  raw: string,
  options: { startChapter: number; count: number }
): BeatPlanDraft {
  const parsed = parseJsonRecord(
    raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
  )
  const rawBeats = parsed.beats
  if (!Array.isArray(rawBeats) || rawBeats.length === 0) {
    throw new Error('节拍表缺少 beats 数组或为空')
  }
  if (rawBeats.length > options.count) {
    throw new Error(`节拍数量 ${rawBeats.length} 超过规划上限 ${options.count}`)
  }

  const beats: BeatPlanDraftItem[] = []
  let expected = options.startChapter
  for (const item of rawBeats) {
    if (!item || typeof item !== 'object') throw new Error('beats 中存在非对象条目')
    const record = item as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    if (!Number.isInteger(chapterNumber)) {
      throw new Error(`节拍章号无效: ${String(record.chapterNumber)}`)
    }
    if (chapterNumber !== expected) {
      throw new Error(
        `节拍章号必须从第 ${options.startChapter} 章起连续：期望 ${expected}，实际 ${chapterNumber}`
      )
    }
    const fnRaw = String(record.dramaticFunction ?? '')
      .trim()
      .toLowerCase()
    if (!BEAT_FUNCTIONS.includes(fnRaw as BeatDramaticFunction)) {
      throw new Error(
        `未知戏剧功能: ${record.dramaticFunction as string}（允许值：${BEAT_FUNCTIONS.join('/')}）`
      )
    }
    beats.push({
      chapterNumber,
      dramaticFunction: fnRaw as BeatDramaticFunction,
      emotionalDebt: typeof record.emotionalDebt === 'string' ? record.emotionalDebt.trim() : '',
      payoff: typeof record.payoff === 'string' ? record.payoff.trim() : '',
      arcPosition: typeof record.arcPosition === 'string' ? record.arcPosition.trim() : '',
      summary: typeof record.summary === 'string' ? record.summary.trim() : ''
    })
    expected += 1
  }

  return {
    beats,
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : ''
  }
}

/**
 * 解析并校验单章节拍草稿（外科手术式生成协议）。
 *
 * 校验规则（任一失败抛错，调用方不落库）：
 * - 必须含 beat 对象（容忍裸对象或 Markdown 代码块包裹）
 * - chapterNumber 必须等于目标章号
 * - dramaticFunction 必须是十种枚举之一（容忍大小写）
 */
export function parseSingleBeatDraft(
  raw: string,
  options: { chapterNumber: number }
): BeatPlanDraftItem {
  const parsed = parseJsonRecord(
    raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
  )
  const candidate =
    parsed.beat && typeof parsed.beat === 'object' && !Array.isArray(parsed.beat)
      ? (parsed.beat as Record<string, unknown>)
      : typeof parsed.dramaticFunction === 'string'
        ? parsed
        : undefined
  if (!candidate) throw new Error('单章节拍缺少 beat 对象')

  const chapterNumber = Number(candidate.chapterNumber)
  if (!Number.isInteger(chapterNumber) || chapterNumber !== options.chapterNumber) {
    throw new Error(
      `节拍章号必须等于第 ${options.chapterNumber} 章，实际为 ${String(candidate.chapterNumber)}`
    )
  }
  const fnRaw = String(candidate.dramaticFunction ?? '')
    .trim()
    .toLowerCase()
  if (!BEAT_FUNCTIONS.includes(fnRaw as BeatDramaticFunction)) {
    throw new Error(
      `未知戏剧功能: ${candidate.dramaticFunction as string}（允许值：${BEAT_FUNCTIONS.join('/')}）`
    )
  }
  return {
    chapterNumber,
    dramaticFunction: fnRaw as BeatDramaticFunction,
    emotionalDebt: typeof candidate.emotionalDebt === 'string' ? candidate.emotionalDebt.trim() : '',
    payoff: typeof candidate.payoff === 'string' ? candidate.payoff.trim() : '',
    arcPosition: typeof candidate.arcPosition === 'string' ? candidate.arcPosition.trim() : '',
    summary: typeof candidate.summary === 'string' ? candidate.summary.trim() : ''
  }
}

// ── 单章节拍结构化提交工具（方案 D，与 submit_chapter_outline 同构）──
//
// 单章节拍此前依赖"模型自觉输出符合协议的 JSON 文本"（responseFormat: 'json' +
// parseSingleBeatDraft），实测模型返回的 beat 对象会漂移（dramaticFunction 键缺失/
// 大小写不一是轻的，键名改写直接打出"未知戏剧功能: undefined"）。改为闭包捕获式
// 提交工具：参数结构由 provider 约束 + SDK 校验；文本解析只作兜底，
// 仅在 provider 不支持工具时使用。

export interface ChapterBeatSubmitDraftHolder {
  /** 模型通过工具提交的单章节拍（未调用工具时为 undefined） */
  payload?: BeatPlanDraftItem
}

const ChapterBeatSubmitParams = Type.Object({
  chapterNumber: Type.Integer({
    description: '目标章号，必须等于任务指定的章节号'
  }),
  dramaticFunction: Type.String({
    description:
      '本章戏剧功能，十选一：setup/escalation/false_victory/false_defeat/midpoint_turn/low_point/climax/payoff/aftermath/breather（容忍大小写）'
  }),
  emotionalDebt: Type.Optional(Type.String({
    maxLength: 2000,
    description: '进入本章时的情绪债务；无则空字符串'
  })),
  payoff: Type.Optional(Type.String({
    maxLength: 2000,
    description: '本章爽点/回报'
  })),
  arcPosition: Type.Optional(Type.String({
    maxLength: 500,
    description: '本章在整卷弧光中的位置'
  })),
  summary: Type.Optional(Type.String({
    maxLength: 4000,
    description: '核心走向，1-2 句'
  }))
})

export function createChapterBeatSubmitTool(
  draft: ChapterBeatSubmitDraftHolder,
  expectedChapterNumber: number
): ToolDefinition<typeof ChapterBeatSubmitParams> {
  return defineTool({
    name: 'submit_chapter_beat',
    label: '提交本章节拍',
    description:
      '把本章的卷级节拍以结构化对象提交。必须调用本工具提交结果；' +
      '不要在对话文本中输出 JSON 或 Markdown 围栏。',
    promptSnippet: '提交结构化单章节拍（戏剧功能/情绪债务/爽点/弧光位置/走向）',
    parameters: ChapterBeatSubmitParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      // 防御式校验：SDK schema 校验正常时字段齐备，直连调用（测试/宽松 provider）在此兜底。
      // 不合法不写 draft，返回纠正提示让模型重调工具。
      const fn = String(params.dramaticFunction ?? '').trim().toLowerCase()
      if (params.chapterNumber !== expectedChapterNumber) {
        return {
          content: [{
            type: 'text',
            text: `章号不符：目标章节是第 ${expectedChapterNumber} 章，请以 chapterNumber=${expectedChapterNumber} 重新提交。`
          }],
          details: undefined
        }
      }
      if (!BEAT_FUNCTIONS.includes(fn as BeatDramaticFunction)) {
        return {
          content: [{
            type: 'text',
            text: `未知戏剧功能：${params.dramaticFunction}。必须十选一：${BEAT_FUNCTIONS.join('/')}。请重新提交。`
          }],
          details: undefined
        }
      }
      draft.payload = {
        chapterNumber: params.chapterNumber,
        dramaticFunction: fn as BeatDramaticFunction,
        emotionalDebt: (params.emotionalDebt ?? '').trim(),
        payoff: (params.payoff ?? '').trim(),
        arcPosition: (params.arcPosition ?? '').trim(),
        summary: (params.summary ?? '').trim()
      }
      return {
        content: [{ type: 'text', text: `本章节拍已提交：${fn}` }],
        details: undefined
      }
    }
  })
}

export class VolumeBeatPlanner {
  constructor(
    private readonly store: NovelStore,
    private readonly promptManager: PromptManager,
    private readonly context: PluginContext
  ) {}

  async generate(params: GenerateBeatPlanParams): Promise<BeatPlanGenerationResult> {
    params.signal?.throwIfAborted()
    const projectId = params.projectId
    const project = this.store.getProject(projectId)
    if (!project) throw new Error(`小说项目不存在: ${projectId}`)

    // ── 卷纲质量门：卷纲缺失或过薄时拒绝规划，避免垃圾输入产出垃圾节拍 ──
    const volume = this.store
      .listVolumes(projectId)
      .find((item) => item.volumeNumber === params.volumeNumber)
    if (!volume) throw new Error(`卷不存在: 第 ${params.volumeNumber} 卷`)
    const volumeOutline = volume.outline?.trim() ?? ''
    if (volumeOutline.length < MIN_VOLUME_OUTLINE_CHARS) {
      throw new Error(
        `第 ${params.volumeNumber} 卷尚未填写卷纲或卷纲少于 ${MIN_VOLUME_OUTLINE_CHARS} 字，请先补全卷纲再生成节拍表`
      )
    }

    const count = Math.min(100, Math.max(3, params.count ?? DEFAULT_BEAT_COUNT))
    const chapters = this.store
      .listChapters(projectId)
      .filter((item) => item.volume === params.volumeNumber)
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
    if (chapters.length === 0) throw new Error(`第 ${params.volumeNumber} 卷下没有章节`)

    const firstUnpublished = chapters.find((item) => item.status !== 'published')
    if (!firstUnpublished) {
      throw new Error(`第 ${params.volumeNumber} 卷所有章节均已发布，无需规划节拍`)
    }

    const warnings: string[] = []
    if (!project.outline?.trim()) warnings.push('项目尚未填写全书大纲，节拍只依据卷纲规划')

    // ── 构建上下文 ──
    const previousBeats = this.store
      .listBeatsByProject(projectId)
      .filter((item) => item.chapterNumber < firstUnpublished.chapterNumber)
      .slice(-3)
    const contextValue = this.buildContext(
      project,
      params.volumeNumber,
      volumeOutline,
      chapters,
      firstUnpublished.chapterNumber,
      count,
      previousBeats
    )
    const contextText = JSON.stringify(contextValue, null, 2)

    const rolePrompt = this.promptManager.getTemplate('role-beat-planner', projectId)
    const systemPrompt = this.promptManager.render(
      'system-base',
      { agent_type: 'beat-planner', agent_role: rolePrompt },
      projectId
    )
    const taskMessage = [
      `为第 ${params.volumeNumber} 卷规划未来 ${count} 章的节拍表。`,
      `第一个未发布章节是第 ${firstUnpublished.chapterNumber} 章，节拍必须从该章开始连续编号。`,
      params.instruction?.trim()
        ? `作者补充要求：${params.instruction.trim()}`
        : '作者补充要求：无',
      '依据下方上下文生成节拍表。只返回协议规定的 JSON。'
    ].join('\n')
    const userMessage = `${taskMessage}\n\n<beat_plan_context>\n${contextText}\n</beat_plan_context>`

    const projectModel = parseNovelModelRef(this.store.getNovelModelId(projectId))
    const directorAgent = this.context.subagentManager?.getAgent('novel-director')
    const modelId = params.modelId ?? projectModel ?? directorAgent?.model
    const payloadTotals: PayloadTotals = {
      messagesChars: 0,
      toolsChars: 0,
      toolCount: 0,
      totalChars: 0,
      roundTrips: 0
    }
    const addPayload = (stats: PluginPayloadStats): void => {
      payloadTotals.messagesChars += stats.messagesChars
      payloadTotals.toolsChars += stats.toolsChars
      payloadTotals.toolCount = Math.max(payloadTotals.toolCount, stats.toolCount)
      payloadTotals.totalChars += stats.totalChars
      payloadTotals.roundTrips += 1
    }

    const generationId = randomUUID()
    const startedAt = Date.now()
    let session: PluginSessionHandle
    try {
      session = await this.context.createSession({
        systemPrompt,
        userMessage,
        tools: [],
        responseFormat: 'json',
        modelId,
        temperature: directorAgent?.temperature ?? 0.4,
        timeoutMs: 180_000,
        signal: params.signal,
        promptCacheScope: `novel:${projectId}:beat:${params.volumeNumber}`,
        onPayloadStats: addPayload
      })
    } catch (err) {
      this.recordCall({
        projectId,
        volumeNumber: params.volumeNumber,
        chapterNumber: firstUnpublished.chapterNumber,
        generationId,
        systemPrompt,
        userMessage,
        result: '',
        durationMs: Date.now() - startedAt,
        status: params.signal?.aborted ? 'cancelled' : 'error',
        error: err instanceof Error ? err.message : String(err),
        sessionId: '',
        usage: undefined,
        payload: payloadTotals
      })
      throw err
    }

    let usage: LlmUsageSnapshot | undefined
    let rawResult = ''
    let status: 'success' | 'error' | 'cancelled' = 'success'
    let errorMessage = ''
    const unsubscribe = session.subscribe((event: Record<string, unknown>) => {
      if (event.type !== 'message_end') return
      const message = (event as { message?: Record<string, unknown> }).message
      if (!message || message.role !== 'assistant') return
      const next = extractLlmUsageFromMessage(message)
      if (next) usage = addLlmUsage(usage, next)
    })

    try {
      rawResult = await session.prompt()
      const draft = parseBeatPlanDraft(rawResult, {
        startChapter: firstUnpublished.chapterNumber,
        count
      })
      const saved = this.store.replaceVolumeBeatPlan(
        projectId,
        params.volumeNumber,
        draft.beats.map((beat) => ({
          chapterNumber: beat.chapterNumber,
          dramaticFunction: beat.dramaticFunction,
          emotionalDebt: beat.emotionalDebt,
          payoff: beat.payoff,
          arcPosition: beat.arcPosition,
          summary: beat.summary
        }))
      )
      return {
        generationId,
        volumeNumber: params.volumeNumber,
        startChapter: firstUnpublished.chapterNumber,
        beats: saved.filter((beat) => beat.chapterNumber >= firstUnpublished.chapterNumber),
        notes: draft.notes,
        warnings,
        promptVersion: PROMPT_VERSION
      }
    } catch (err) {
      status = params.signal?.aborted ? 'cancelled' : 'error'
      errorMessage = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      unsubscribe()
      session.dispose()
      this.recordCall({
        projectId,
        volumeNumber: params.volumeNumber,
        chapterNumber: firstUnpublished.chapterNumber,
        generationId,
        systemPrompt,
        userMessage,
        result: rawResult,
        durationMs: Date.now() - startedAt,
        status,
        error: errorMessage,
        sessionId: session.sessionId ?? '',
        usage,
        payload: payloadTotals
      })
    }
  }

  /**
   * 单章节拍生成/重生成（外科手术式语义）：只产出并替换目标章一行的节拍，
   * 不触碰其他章节的节拍行。上下文参考卷纲、本章章纲与前后既有节拍。
   */
  async generateForChapter(
    params: GenerateChapterBeatParams
  ): Promise<ChapterBeatGenerationResult> {
    params.signal?.throwIfAborted()
    const projectId = params.projectId
    const project = this.store.getProject(projectId)
    if (!project) throw new Error(`小说项目不存在: ${projectId}`)

    const chapter = this.store.getChapter(projectId, params.chapterNumber)
    if (!chapter) throw new Error(`章节不存在: 第 ${params.chapterNumber} 章`)
    if (chapter.status === 'published') {
      throw new Error(`第 ${params.chapterNumber} 章已发布，节拍已确认，无需重新生成`)
    }

    const volumes = this.store.listVolumes(projectId)
    const volume = chapter.volumeId
      ? volumes.find((item) => item.id === chapter.volumeId)
      : volumes.find((item) => item.volumeNumber === chapter.volume)
    if (!volume) {
      throw new Error(`第 ${params.chapterNumber} 章未归属任何卷，无法生成节拍`)
    }
    const volumeOutline = volume.outline?.trim() ?? ''
    if (volumeOutline.length < MIN_VOLUME_OUTLINE_CHARS) {
      throw new Error(
        `第 ${volume.volumeNumber} 卷尚未填写卷纲或卷纲少于 ${MIN_VOLUME_OUTLINE_CHARS} 字，请先补全卷纲再生成节拍`
      )
    }

    const contextValue = this.buildChapterContext(
      project,
      volume,
      volumeOutline,
      chapter,
      params.chapterNumber
    )
    const contextText = JSON.stringify(contextValue, null, 2)

    // 方案 D：结构化提交工具为主路径（参数结构由 provider 约束 + SDK 校验），
    // 文本 JSON 解析降级为 provider 不支持工具时的兜底。
    const submitDraft: ChapterBeatSubmitDraftHolder = {}
    const submitTool = createChapterBeatSubmitTool(submitDraft, params.chapterNumber)
    const rolePrompt = this.promptManager.getTemplate('role-chapter-beat-planner', projectId)
    const systemPrompt =
      this.promptManager.render(
        'system-base',
        { agent_type: 'beat-planner', agent_role: rolePrompt },
        projectId
      ) + '\n\n必须调用 submit_chapter_beat 工具提交本章节拍；不要在对话文本中输出 JSON。'
    const taskMessage = [
      `为第 ${params.chapterNumber} 章生成单章节拍（该章属于第 ${volume.volumeNumber} 卷）。`,
      `chapterNumber 必须为 ${params.chapterNumber}。`,
      params.instruction?.trim()
        ? `作者补充要求：${params.instruction.trim()}`
        : '作者补充要求：无',
      '依据下方上下文生成节拍，通过 submit_chapter_beat 工具提交；只提交本章一节课拍，不要输出其他章节的节拍。'
    ].join('\n')
    const userMessage = `${taskMessage}\n\n<chapter_beat_context>\n${contextText}\n</chapter_beat_context>`

    const projectModel = parseNovelModelRef(this.store.getNovelModelId(projectId))
    const directorAgent = this.context.subagentManager?.getAgent('novel-director')
    const modelId = params.modelId ?? projectModel ?? directorAgent?.model
    const payloadTotals: PayloadTotals = {
      messagesChars: 0,
      toolsChars: 0,
      toolCount: 0,
      totalChars: 0,
      roundTrips: 0
    }
    const addPayload = (stats: PluginPayloadStats): void => {
      payloadTotals.messagesChars += stats.messagesChars
      payloadTotals.toolsChars += stats.toolsChars
      payloadTotals.toolCount = Math.max(payloadTotals.toolCount, stats.toolCount)
      payloadTotals.totalChars += stats.totalChars
      payloadTotals.roundTrips += 1
    }

    const generationId = randomUUID()
    const startedAt = Date.now()
    let session: PluginSessionHandle
    try {
      session = await this.context.createSession({
        systemPrompt,
        userMessage,
        // 挂载提交工具时不声明 responseFormat='json'（底座会注入 tool_choice='none'，
        // 工具不会被调用，文本解析只作兜底——与 submit_chapter_outline 同构）
        tools: [submitTool],
        modelId,
        temperature: directorAgent?.temperature ?? 0.4,
        timeoutMs: 180_000,
        signal: params.signal,
        promptCacheScope: `novel:${projectId}:beat-ch:${params.chapterNumber}`,
        onPayloadStats: addPayload
      })
    } catch (err) {
      this.recordCall({
        projectId,
        volumeNumber: volume.volumeNumber,
        chapterNumber: params.chapterNumber,
        generationId,
        systemPrompt,
        userMessage,
        result: '',
        durationMs: Date.now() - startedAt,
        status: params.signal?.aborted ? 'cancelled' : 'error',
        error: err instanceof Error ? err.message : String(err),
        sessionId: '',
        usage: undefined,
        payload: payloadTotals,
        operation: 'generate_chapter'
      })
      throw err
    }

    let usage: LlmUsageSnapshot | undefined
    let rawResult = ''
    let status: 'success' | 'error' | 'cancelled' = 'success'
    let errorMessage = ''
    const unsubscribe = session.subscribe((event: Record<string, unknown>) => {
      if (event.type !== 'message_end') return
      const message = (event as { message?: Record<string, unknown> }).message
      if (!message || message.role !== 'assistant') return
      const next = extractLlmUsageFromMessage(message)
      if (next) usage = addLlmUsage(usage, next)
    })

    try {
      rawResult = await session.prompt()
      let draft: BeatPlanDraftItem
      if (submitDraft.payload) {
        // ── 主路径：工具提交（结构化参数经 provider 约束 + SDK 校验后闭包捕获）──
        draft = submitDraft.payload
      } else {
        // ── 兜底：provider 未发起工具调用 → 容错解析自由文本 + 一次修复轮 ──
        try {
          draft = parseSingleBeatDraft(rawResult, { chapterNumber: params.chapterNumber })
        } catch (firstError) {
          if (params.signal?.aborted) throw firstError
          this.context.logger.warn(
            { chapterNumber: params.chapterNumber, rawHead: rawResult.slice(0, 160), err: firstError },
            '单章节拍协议校验失败且未收到工具提交，发起同会话修复轮'
          )
          const repairedRaw = await session.prompt(
            [
              '你上一条回复不符合输出协议：' +
                (firstError instanceof Error ? firstError.message : String(firstError)),
              '',
              '请立即调用 submit_chapter_beat 工具提交本章节拍；',
              '若无法调用工具，则只输出一个合法 JSON 对象（形如 {"beat": {"chapterNumber", "dramaticFunction", "emotionalDebt", "payoff", "arcPosition", "summary"}}，dramaticFunction 十选一：' +
                BEAT_FUNCTIONS.join('/') +
                '），不要任何解释或元信息包装。'
            ].join('\n')
          )
          rawResult = repairedRaw
          if (submitDraft.payload) {
            draft = submitDraft.payload
          } else {
            draft = parseSingleBeatDraft(repairedRaw, { chapterNumber: params.chapterNumber })
          }
        }
      }
      const saved = this.store.upsertChapterBeatPlan(projectId, volume.volumeNumber, {
        chapterNumber: draft.chapterNumber,
        dramaticFunction: draft.dramaticFunction,
        emotionalDebt: draft.emotionalDebt,
        payoff: draft.payoff,
        arcPosition: draft.arcPosition,
        summary: draft.summary
      })
      if (!saved) throw new Error('节拍写入失败')
      return {
        generationId,
        chapterNumber: params.chapterNumber,
        beat: saved,
        promptVersion: PROMPT_VERSION
      }
    } catch (err) {
      status = params.signal?.aborted ? 'cancelled' : 'error'
      errorMessage = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      unsubscribe()
      session.dispose()
      this.recordCall({
        projectId,
        volumeNumber: volume.volumeNumber,
        chapterNumber: params.chapterNumber,
        generationId,
        systemPrompt,
        userMessage,
        result: rawResult,
        durationMs: Date.now() - startedAt,
        status,
        error: errorMessage,
        sessionId: session.sessionId ?? '',
        usage,
        payload: payloadTotals,
        operation: 'generate_chapter'
      })
    }
  }

  /** 单章生成的轻量上下文：卷纲 + 本章章纲 + 前后节拍 + 活跃实体精简版 */
  private buildChapterContext(
    project: NonNullable<ReturnType<NovelStore['getProject']>>,
    volume: { volumeNumber: number; outline?: string | null },
    volumeOutline: string,
    chapter: NovelChapter,
    chapterNumber: number
  ): Record<string, unknown> {
    const projectId = project.id
    const allBeats = this.store.listBeatsByProject(projectId)
    const previousBeats = allBeats.filter((item) => item.chapterNumber < chapterNumber).slice(-3)
    const followingBeats = allBeats.filter((item) => item.chapterNumber > chapterNumber).slice(0, 3)
    const conflicts = this.store
      .listConflicts(projectId)
      .filter((item) => item.stage !== 'resolved' && item.stage !== 'transformed')
      .slice(0, 5)
    const foreshadowing = this.store
      .listForeshadowing(projectId)
      .filter((item) => item.status !== 'recovered' && item.status !== 'abandoned')
      .slice(0, 5)

    return {
      project: {
        title: project.title,
        genre: project.genre,
        synopsis: truncate(project.synopsis, 800),
        outline: truncate(project.outline, 2000)
      },
      volume: {
        volumeNumber: volume.volumeNumber,
        outline: truncate(volumeOutline, 2000)
      },
      chapter: {
        chapterNumber,
        title: chapter.title,
        status: chapter.status,
        outline: truncate(chapter.outline, 800),
        narrativeTask: truncate(chapter.narrativeTask || '', 600)
      },
      previousBeats: previousBeats.map((item) => ({
        chapterNumber: item.chapterNumber,
        dramaticFunction: item.dramaticFunction,
        summary: truncate(item.summary, 200)
      })),
      followingBeats: followingBeats.map((item) => ({
        chapterNumber: item.chapterNumber,
        dramaticFunction: item.dramaticFunction,
        summary: truncate(item.summary, 200)
      })),
      activeEntities: {
        conflicts: conflicts.map((item) => ({
          description: truncate(item.description, 300),
          stage: item.stage,
          intensity: item.intensity
        })),
        foreshadowing: foreshadowing.map((item) => ({
          description: truncate(item.description, 300),
          status: item.status,
          recoverByChapter: item.recoverByChapter ?? null
        }))
      },
      storylines: this.store
        .listStorylines(projectId)
        .filter((item) => item.lifecycle === 'active')
        .slice(0, 5)
        .map((item) => ({
          name: item.name,
          kind: item.kind,
          description: truncate(item.description, 300)
        }))
    }
  }

  private buildContext(
    project: NonNullable<ReturnType<NovelStore['getProject']>>,
    volumeNumber: number,
    volumeOutline: string,
    chapters: NovelChapter[],
    startChapter: number,
    count: number,
    previousBeats: NovelBeatPlan[]
  ): Record<string, unknown> {
    const projectId = project.id
    const activeChapters = chapters.slice(0, startChapter + count)
    const conflicts = this.store
      .listConflicts(projectId)
      .filter((item) => item.stage !== 'resolved' && item.stage !== 'transformed')
      .slice(0, 10)
    const foreshadowing = this.store
      .listForeshadowing(projectId)
      .filter((item) => item.status !== 'recovered' && item.status !== 'abandoned')
      .slice(0, 10)
    const clues = this.store
      .listClues(projectId)
      .filter((item) => item.progress < 100)
      .slice(0, 8)

    return {
      project: {
        title: project.title,
        genre: project.genre,
        synopsis: truncate(project.synopsis, 1600),
        outline: truncate(project.outline, 5000),
        targetWords: project.targetWords
      },
      volume: {
        volumeNumber,
        outline: truncate(volumeOutline, 3500),
        publishedCount: chapters.filter((item) => item.status === 'published').length,
        totalCount: chapters.length
      },
      planWindow: {
        startChapter,
        maxBeats: count
      },
      existingChapters: activeChapters.map((item) => ({
        chapterNumber: item.chapterNumber,
        title: item.title,
        status: item.status,
        recap: truncate(item.recap || item.content, 400),
        outline: item.status === 'published' ? '' : truncate(item.outline, 800)
      })),
      previousBeats: previousBeats.map((item) => ({
        chapterNumber: item.chapterNumber,
        dramaticFunction: item.dramaticFunction,
        summary: truncate(item.summary, 300)
      })),
      activeEntities: {
        conflicts: conflicts.map((item) => ({
          description: truncate(item.description, 500),
          stage: item.stage,
          intensity: item.intensity
        })),
        foreshadowing: foreshadowing.map((item) => ({
          description: truncate(item.description, 500),
          status: item.status,
          recoverByChapter: item.recoverByChapter ?? null
        })),
        clues: clues.map((item) => ({
          description: truncate(item.description, 400),
          progress: item.progress
        }))
      },
      storylines: this.store
        .listStorylines(projectId)
        .filter((item) => item.lifecycle === 'active')
        .slice(0, 8)
        .map((item) => ({
          name: item.name,
          kind: item.kind,
          maturity: item.maturity,
          description: truncate(item.description, 400)
        }))
    }
  }

  private recordCall(input: {
    projectId: string
    volumeNumber: number
    chapterNumber: number
    generationId: string
    systemPrompt: string
    userMessage: string
    result: string
    durationMs: number
    status: 'success' | 'error' | 'cancelled'
    error: string
    sessionId: string
    usage?: LlmUsageSnapshot
    payload: PayloadTotals
    /** 区分整卷生成（generate）与单章生成（generate_chapter） */
    operation?: string
  }): void {
    try {
      this.store.insertAgentLog({
        projectId: input.projectId,
        chapterNumber: input.chapterNumber,
        agentType: 'beat-planner',
        agentName: '节拍规划师',
        displayAgentType: 'beat-planner',
        displayAgentName: '节拍规划师',
        phase: 'beat_plan',
        systemPrompt: input.systemPrompt,
        chapterContext: '',
        userMessage: input.userMessage,
        taskInput: '',
        userInstructions: [],
        tools: [],
        toolNames: [],
        askStoryPolicy: 'allOffWithReferences',
        askStoryEnabled: false,
        result: input.result,
        resultLength: input.result.length,
        durationMs: input.durationMs,
        status: input.status,
        error: input.error,
        sessionId: input.sessionId,
        operation: input.operation ?? 'generate',
        inputTokens: input.usage?.inputTokens ?? 0,
        outputTokens: input.usage?.outputTokens ?? 0,
        cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: input.usage?.cacheWriteTokens ?? 0,
        llmProvider: input.usage?.llmProvider ?? '',
        llmModel: input.usage?.llmModel ?? '',
        payloadMessagesChars: input.payload.messagesChars,
        payloadToolsChars: input.payload.toolsChars,
        payloadToolCount: input.payload.toolCount,
        payloadTotalChars: input.payload.totalChars,
        llmRoundTrips: input.payload.roundTrips,
        cacheKey: `novel:${input.projectId}:beat:${input.volumeNumber}`,
        requestFingerprint: input.generationId,
        cacheablePrefixChars: input.systemPrompt.length
      })
    } catch (err) {
      this.context.logger.warn({ err, projectId: input.projectId }, '节拍规划日志写入失败')
    }
  }
}
