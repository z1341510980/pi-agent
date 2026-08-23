import { randomUUID } from 'node:crypto'
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
  /** 规划的未来章数（默认 6，夹在 3-8） */
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

    const count = Math.min(8, Math.max(3, params.count ?? DEFAULT_BEAT_COUNT))
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
        operation: 'generate',
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
