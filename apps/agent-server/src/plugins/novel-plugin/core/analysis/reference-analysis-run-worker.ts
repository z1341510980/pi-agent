/**
 * ReferenceAnalysisRunWorker：P4 远端分析执行器（方案 §8 P4）。
 *
 * 顺序阶段：validating_source → parsing_text → deterministic_analysis →
 * scene_analysis（按章节边界合并分包 LLM 抽取）→ chapter_aggregation（确定性聚合）→
 * book_aggregation（单次 LLM 汇总四类 profile + findings + 安全线索）→
 * safety_scan（确定性核对直接引用）→ awaiting_review。
 *
 * 不变量：
 * - 只有结构化 chunk 结果落库后才写 checkpoint；断线不等于取消；
 * - 事件表只存阶段与摘要，不保存原文、完整 Prompt 或完整生成正文；
 * - 取消立即中断 LLM 调用并保留 checkpoint，恢复从最近 checkpoint 继续；
 * - 输出 JSON 解析失败按 chunk 失败处理并记录错误，不猜测字段。
 */
import { createHash } from 'node:crypto'
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  PluginContext,
  PluginPayloadStats,
  PluginSessionHandle
} from '../../../../core/plugin/plugin-types.js'
import type { ReferenceSection, ReferenceSourceDetail } from '@repo/shared/novel'
import type { ReferenceAnalysisService } from './reference-analysis-service.js'
import { REFERENCE_ANALYZER_VERSION } from './reference-analysis.js'
import type {
  ReferenceAnalysisRunStore,
  ReferenceAnalysisRun
} from './reference-analysis-run-store.js'
import type { ReferenceProfileStore } from './reference-profile-store.js'
import { NovelStore } from '../novel-store.js'
import {
  addLlmUsage,
  extractLlmUsageFromMessage,
  hasLlmUsage,
  type LlmUsageSnapshot
} from '../agent-run-utils.js'
import { classifyDataQuality } from '../../../../core/observability/model-call-telemetry.js'
import { resolveJsonSchemaSupport } from '../../../../core/plugin/structured-outputs-support.js'

export const REFERENCE_EXTRACTOR_VERSION = 'reference-extractor-v1'
export const REFERENCE_PROMPT_VERSION = 'reference-analysis-prompt-v1'

// ── 结构化提交工具（方案 D）─────────────────────────────────────────
//
// 分包抽取与全书汇总不再依赖"模型自觉输出合法 JSON 文本"——那在兼容网关上
// 反复被寒暄前缀（「已收到《XX》…」）、Markdown 围栏、尾逗号打穿。
// 改为闭包捕获式提交工具：参数 schema 由 provider 侧约束，SDK 校验后直接
// 落进 draft 对象，天然免疫任何包裹文本。文本 JSON 解析保留为兜底路径。

interface SubmitDraftHolder {
  payload?: Record<string, unknown>
}

const ChunkObservationsParams = Type.Object({
  observations: Type.Array(
    Type.Object({
      sectionId: Type.String({ description: '来自输入章节标签的 sectionId' }),
      metric: Type.String({ description: '观察指标名，如 pacing.sentence_rhythm' }),
      value: Type.String({ description: '观察结论（不超过 2000 字）' }),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      evidence: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: '<=30 字原文短引用' })),
      counterexamples: Type.Optional(Type.Array(Type.String(), { maxItems: 8 }))
    }),
    { minItems: 0, maxItems: 20 }
  )
})

function createChunkObservationsSubmitTool(draft: SubmitDraftHolder): ToolDefinition<typeof ChunkObservationsParams> {
  return defineTool({
    name: 'submit_chunk_observations',
    label: '提交分包语义观察',
    description:
      '把本分包的可核验观察以结构化对象提交。必须调用本工具提交结果；' +
      '不要在对话文本中输出 JSON 或 Markdown 围栏。',
    parameters: ChunkObservationsParams,
    async execute(_toolCallId, params) {
      draft.payload = params as unknown as Record<string, unknown>
      return {
        content: [{ type: 'text', text: `已收到 ${params.observations.length} 条观察并入库` }],
        details: undefined
      }
    }
  })
}

const BookProfileParams = Type.Object({
  spirit: Type.Object({
    summary: Type.String({ description: '文风精神摘要（<=2000 字）' }),
    rules: Type.Array(Type.String(), { maxItems: 20 })
  }),
  technique: Type.Object({
    summary: Type.String(),
    rules: Type.Array(Type.String(), { maxItems: 20 })
  }),
  power: Type.Object({
    summary: Type.String(),
    rules: Type.Array(Type.String(), { maxItems: 20 })
  }),
  pacing: Type.Object({
    summary: Type.String(),
    rules: Type.Array(Type.String(), { maxItems: 20 })
  }),
  findings: Type.Array(
    Type.Object({
      category: Type.Union([
        Type.Literal('spirit'),
        Type.Literal('technique'),
        Type.Literal('power'),
        Type.Literal('pacing')
      ]),
      observation: Type.String(),
      rule: Type.String(),
      strength: Type.Union([Type.Literal('hard'), Type.Literal('soft'), Type.Literal('reference')]),
      evidence: Type.Optional(Type.Array(Type.String(), { maxItems: 8 }))
    }),
    { minItems: 5, maxItems: 12, description: '5-12 条发现' }
  ),
  safetyHints: Type.Optional(
    Type.Object({
      directQuotes: Type.Array(Type.String(), { maxItems: 10, description: '<=30 字原文短引用' }),
      properNouns: Type.Array(Type.String(), { maxItems: 40 }),
      plotSequences: Type.Array(Type.String(), { maxItems: 40 }),
      uniqueScenes: Type.Array(Type.String(), { maxItems: 40 })
    })
  )
})

function createBookProfileSubmitTool(draft: SubmitDraftHolder): ToolDefinition<typeof BookProfileParams> {
  return defineTool({
    name: 'submit_book_profile',
    label: '提交全书四类档案',
    description:
      '把全书汇总的四类档案（spirit/technique/power/pacing）、findings 与安全线索以结构化对象提交。' +
      '必须调用本工具提交结果；不要在对话文本中输出 JSON。',
    parameters: BookProfileParams,
    async execute(_toolCallId, params) {
      draft.payload = params as unknown as Record<string, unknown>
      return {
        content: [{
          type: 'text',
          text: `已收到全书档案：findings=${params.findings.length} 条`
        }],
        details: undefined
      }
    }
  })
}

/** book 聚合输出：四类 profile + findings + 安全线索 */
interface BookAggregationDraft {
  spirit: { summary: string; rules: string[] }
  technique: { summary: string; rules: string[] }
  power: { summary: string; rules: string[] }
  pacing: { summary: string; rules: string[] }
  findings: Array<{
    category: 'spirit' | 'technique' | 'power' | 'pacing'
    observation: string
    rule: string
    strength?: 'hard' | 'soft' | 'reference'
    evidence?: string[]
  }>
  safetyHints?: {
    directQuotes?: string[]
    properNouns?: string[]
    plotSequences?: string[]
    uniqueScenes?: string[]
  }
}

export interface AnalysisChunkResult {
  chunkId: string
  observations: Array<{
    sectionId: string | null
    metric: string
    value: unknown
    confidence: number | null
    evidenceOffsets: unknown[]
    counterexampleOffsets: unknown[]
  }>
}

interface ReferenceAnalysisChunk {
  id: string
  order: number
  sections: ReferenceSection[]
}

interface JsonCallResult {
  parsed: Record<string, unknown>
  usage: LlmUsageSnapshot
}

export class ReferenceAnalysisRunWorker {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly context: PluginContext,
    private readonly runStore: ReferenceAnalysisRunStore,
    private readonly profileStore: ReferenceProfileStore,
    private readonly referenceService: ReferenceAnalysisService,
    private readonly novelStore?: NovelStore
  ) {}

  isRunning(runId: string): boolean {
    return this.running.has(runId)
  }

  requestCancel(runId: string): void {
    this.running.get(runId)?.abort()
  }

  async run(runId: string): Promise<void> {
    if (this.running.has(runId)) return
    const controller = new AbortController()
    this.running.set(runId, controller)
    try {
      await this.runStages(runId, controller.signal)
    } finally {
      this.running.delete(runId)
    }
  }

  private async runStages(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.runStore.getRun(runId)
    if (!run || !['queued', 'running'].includes(run.status)) return
    const checkpoint = run.checkpoint ?? {}
    const legacyCheckpoint =
      Array.isArray(checkpoint.completedSectionIds) ||
      Array.isArray(checkpoint.observationsBySection)
    const completedValue: unknown = legacyCheckpoint
      ? checkpoint.completedSectionIds
      : checkpoint.completedChunkIds
    const completedChunkIds = new Set<string>(
      Array.isArray(completedValue)
        ? completedValue.filter((item): item is string => typeof item === 'string')
        : []
    )
    const storedObservations = legacyCheckpoint
      ? checkpoint.observationsBySection
      : checkpoint.observationsByChunk
    const observationsByChunk = new Map<string, AnalysisChunkResult['observations']>(
      Array.isArray(storedObservations)
        ? (storedObservations as Array<[string, AnalysisChunkResult['observations']]>).filter(
            Array.isArray
          )
        : []
    )

    // ── validating_source ──
    this.runStore.setStage(runId, 'validating_source', '校验参考源与授权状态')
    const source = this.referenceService.getSource(run.sourceId)
    if (!source.rights.confirmed) {
      this.runStore.fail(runId, '参考源未确认分析授权，不能启动远端分析')
      return
    }
    if (source.parseStatus !== 'parsed' && source.parseStatus !== 'confirmed') {
      this.runStore.fail(runId, '参考源尚未完成本地解析，请先完成阶段 1')
      return
    }
    signal.throwIfAborted()

    // ── parsing_text ──
    this.runStore.setStage(runId, 'parsing_text', '装载分析范围文本')
    const sections = this.referenceService.listSections(run.sourceId)
    const includedIds =
      run.includedSectionIds.length > 0
        ? run.includedSectionIds
        : sections.filter((section) => section.included).map((section) => section.id)
    const selected = sections.filter(
      (section) => includedIds.includes(section.id) && section.included
    )
    if (selected.length === 0) {
      this.runStore.fail(runId, '分析范围内没有可用的参考章节')
      return
    }
    const { sectionTexts } = this.referenceService.getSectionsText(
      run.sourceId,
      selected.map((section) => section.id)
    )
    signal.throwIfAborted()

    // ── deterministic_analysis：本地报告的测量值转 observation（无 LLM 成本） ──
    this.runStore.setStage(runId, 'deterministic_analysis', '落地本地确定性测量')
    const local = this.referenceService.getLocalReport(run.sourceId)
    this.runStore.addObservation({
      analysisRunId: runId,
      sectionId: null,
      level: 'measurement',
      metric: 'sentence.length.average',
      value: local.sentenceLengths.average,
      measurementMethod: REFERENCE_ANALYZER_VERSION,
      confidence: 0.95,
      evidenceOffsets: [],
      counterexampleOffsets: [],
      safetyFlags: []
    })
    this.runStore.addObservation({
      analysisRunId: runId,
      sectionId: null,
      level: 'measurement',
      metric: 'dialogue.ratio',
      value: local.dialogue.ratio,
      measurementMethod: REFERENCE_ANALYZER_VERSION,
      confidence: 0.9,
      evidenceOffsets: [],
      counterexampleOffsets: [],
      safetyFlags: []
    })
    this.runStore.addObservation({
      analysisRunId: runId,
      sectionId: null,
      level: 'measurement',
      metric: 'paragraph.length.average',
      value: local.paragraphLengths.average,
      measurementMethod: REFERENCE_ANALYZER_VERSION,
      confidence: 0.9,
      evidenceOffsets: [],
      counterexampleOffsets: [],
      safetyFlags: []
    })

    // ── scene_analysis：按章节边界合并分包抽取（checkpoint 跳过已完成 chunk，不重复计费） ──
    const chunks = this.buildAnalysisChunks(run, selected, legacyCheckpoint)
    this.runStore.setStage(
      runId,
      'scene_analysis',
      `本地章节分包 ${chunks.length} 组，合并语义抽取（${selected.length} 章）`
    )
    let actualCalls = Number(checkpoint.llmCalls ?? 0)
    for (const chunk of chunks) {
      signal.throwIfAborted()
      run = this.runStore.getRun(runId)!
      if (!run || !['queued', 'running'].includes(run.status)) return
      if (completedChunkIds.has(chunk.id)) continue

      const text = chunk.sections
        .map((section) => formatSectionForAnalysis(section, sectionTexts[section.id] ?? ''))
        .join('\n\n')
      const chunkSectionTexts = Object.fromEntries(
        chunk.sections.map((section) => [section.id, sectionTexts[section.id] ?? ''])
      )
      if (!text.trim()) continue
      try {
        const result = await this.analyzeChunk(run, source, chunk, text, chunkSectionTexts, signal)
        for (const observation of result.observations) {
          this.runStore.addObservation({
            analysisRunId: runId,
            sectionId: observation.sectionId,
            level: 'scene',
            metric: observation.metric,
            value: observation.value,
            measurementMethod: REFERENCE_EXTRACTOR_VERSION,
            confidence: observation.confidence,
            evidenceOffsets: observation.evidenceOffsets,
            counterexampleOffsets: observation.counterexampleOffsets,
            safetyFlags: []
          })
        }
        observationsByChunk.set(chunk.id, result.observations)
        completedChunkIds.add(chunk.id)
        actualCalls += 1
        this.runStore.setCheckpoint(
          runId,
          {
            completedChunkIds: [...completedChunkIds],
            observationsByChunk: [...observationsByChunk.entries()],
            llmCalls: actualCalls
          },
          { llmCalls: actualCalls }
        )
      } catch (error) {
        if (signal.aborted) return
        this.runStore.fail(
          runId,
          `第 ${chunk.order + 1} 个参考分包语义抽取失败：${error instanceof Error ? error.message : '未知错误'}`
        )
        return
      }
    }

    // ── chapter_aggregation：确定性聚合 scene 观察 ──
    this.runStore.setStage(runId, 'chapter_aggregation', '按章聚合观察')
    for (const [chunkId, observations] of observationsByChunk) {
      this.runStore.addObservation({
        analysisRunId: runId,
        sectionId: null,
        level: 'chapter',
        metric: 'chunk.observation.count',
        value: { chunkId, count: observations.length },
        measurementMethod: `${REFERENCE_EXTRACTOR_VERSION}:aggregate`,
        confidence: 1,
        evidenceOffsets: [],
        counterexampleOffsets: [],
        safetyFlags: []
      })
    }

    // ── book_aggregation：单次 LLM 汇总 ──
    this.runStore.setStage(runId, 'book_aggregation', '全书汇总四类档案')
    let book: BookAggregationDraft
    try {
      const digest = buildBookDigest(observationsByChunk, local.languageToneObservations)
      book = await this.aggregateBook(run, source, digest, signal)
      actualCalls += 1
      this.runStore.setCheckpoint(
        runId,
        {
          completedChunkIds: [...completedChunkIds],
          observationsByChunk: [...observationsByChunk.entries()],
          llmCalls: actualCalls,
          bookDigestHash: hash(digest)
        },
        { llmCalls: actualCalls }
      )
    } catch (error) {
      if (signal.aborted) return
      this.runStore.fail(
        runId,
        `全书汇总失败：${error instanceof Error ? error.message : '未知错误'}`
      )
      return
    }

    // ── safety_scan：确定性核对直接引用（quote 必须真实存在于原文） ──
    this.runStore.setStage(runId, 'safety_scan', '核对安全线索')
    const fullText = Object.values(sectionTexts).join('\n')
    const quotes = (book.safetyHints?.directQuotes ?? []).filter(
      (quote) => quote.length >= 12 && fullText.includes(quote)
    )
    for (const quote of quotes) {
      this.runStore.addObservation({
        analysisRunId: runId,
        sectionId: null,
        level: 'book',
        metric: 'safety.direct_quote',
        value: { length: quote.length, prefix: quote.slice(0, 10) },
        measurementMethod: `${REFERENCE_EXTRACTOR_VERSION}:safety`,
        confidence: 1,
        evidenceOffsets: [],
        counterexampleOffsets: [],
        safetyFlags: ['direct_quote']
      })
    }

    // ── awaiting_review：生成 profile 草稿并完成 ──
    this.runStore.setStage(runId, 'awaiting_review', '生成待审核档案')
    const profile = this.profileStore.createProfileFromRun(run, book, quotes)
    this.runStore.complete(runId, profile.id)
  }

  private buildAnalysisChunks(
    run: ReferenceAnalysisRun,
    sections: ReferenceSection[],
    legacyCheckpoint: boolean
  ): ReferenceAnalysisChunk[] {
    if (legacyCheckpoint) {
      // 旧 checkpoint 的最小恢复单位是章节，继续按原粒度恢复以免重复计费。
      return sections.map((section, order) => ({ id: section.id, order, sections: [section] }))
    }
    const plan = (
      run.estimateSnapshot as {
        localChunkPlan?: { chunks?: Array<{ id?: unknown; order?: unknown; sectionIds?: unknown }> }
      }
    ).localChunkPlan
    const sectionById = new Map(sections.map((section) => [section.id, section]))
    const planned = plan?.chunks
      ?.map((chunk, order) => {
        const sectionIds = Array.isArray(chunk.sectionIds)
          ? chunk.sectionIds.filter((id): id is string => typeof id === 'string')
          : []
        const selected = sectionIds
          .map((sectionId) => sectionById.get(sectionId))
          .filter((section): section is ReferenceSection => Boolean(section))
        return {
          id: typeof chunk.id === 'string' && chunk.id ? chunk.id : `local-chunk-${order + 1}`,
          order: typeof chunk.order === 'number' ? chunk.order : order,
          sections: selected
        }
      })
      .filter((chunk) => chunk.sections.length > 0)
    if (planned && planned.length > 0) return planned

    // 兼容没有预算快照的历史任务：仍保持每章一次，避免暗中改变已启动任务的成本边界。
    return sections.map((section, order) => ({ id: section.id, order, sections: [section] }))
  }

  private async analyzeChunk(
    run: ReferenceAnalysisRun,
    source: ReferenceSourceDetail,
    chunk: ReferenceAnalysisChunk,
    text: string,
    sectionTexts: Record<string, string>,
    signal: AbortSignal
  ): Promise<AnalysisChunkResult> {
    const draft: SubmitDraftHolder = {}
    const submitTool = createChunkObservationsSubmitTool(draft)
    const systemPrompt = [
      '你是小说文风观察提取器。仅依据提供的一组连续参考章节，输出可核验的观察。',
      '章节标签只用于定位证据；不要把不同章节的事实或情节串接为新事实。',
      '不要创作正文，不要复述大段原文；evidence 只允许 <=30 字的原文短引用。',
      '每条 observations 必须填写 sectionId，并且 sectionId 必须来自输入章节标签。',
      '必须调用 submit_chunk_observations 工具提交 2-10 条观察；',
      '若你所在的运行环境无法调用工具，才退化为仅输出一个合法 JSON 对象（无围栏、无寒暄）。'
    ].join('\n')
    const call = await this.runJsonCall({
      run,
      source,
      operation: 'chunk',
      agentName: '参考文本分包分析',
      systemPrompt,
      userMessage: `## 参考章节分包 ${chunk.order + 1}\n${text}`,
      taskInput: JSON.stringify({
        chunkId: chunk.id,
        sectionIds: chunk.sections.map((section) => section.id),
        sectionTitles: chunk.sections.map((section) => section.title ?? '')
      }),
      submit: { tool: submitTool as ToolDefinition<never>, draft },
      signal
    })
    const validSectionIds = new Set(chunk.sections.map((section) => section.id))
    const observations = call.parsed.observations
    if (!Array.isArray(observations)) return { chunkId: chunk.id, observations: [] }
    const results: AnalysisChunkResult['observations'] = []
    for (const item of observations) {
      if (!item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      const sectionId =
        typeof candidate.sectionId === 'string' && validSectionIds.has(candidate.sectionId)
          ? candidate.sectionId
          : chunk.sections.length === 1
            ? chunk.sections[0]!.id
            : null
      const metric =
        typeof candidate.metric === 'string' && /^[a-z][a-z0-9_.]{2,60}$/.test(candidate.metric)
          ? candidate.metric
          : null
      const value =
        typeof candidate.value === 'string' && candidate.value.trim()
          ? candidate.value.trim().slice(0, 2000)
          : null
      if (!sectionId || !metric || !value) continue
      const sectionText = sectionTexts[sectionId] ?? ''
      results.push({
        sectionId,
        metric,
        value,
        confidence:
          typeof candidate.confidence === 'number' &&
          candidate.confidence >= 0 &&
          candidate.confidence <= 1
            ? candidate.confidence
            : null,
        evidenceOffsets: locateQuotes(collectShortStrings(candidate.evidence), sectionText),
        counterexampleOffsets: locateQuotes(
          collectShortStrings(candidate.counterexamples),
          sectionText
        )
      })
    }
    return { chunkId: chunk.id, observations: results.slice(0, 20) }
  }

  private async aggregateBook(
    run: ReferenceAnalysisRun,
    source: ReferenceSourceDetail,
    digest: string,
    signal: AbortSignal
  ): Promise<BookAggregationDraft> {
    const draft: SubmitDraftHolder = {}
    const submitTool = createBookProfileSubmitTool(draft)
    const systemPrompt = [
      '你是小说参考分析汇总器。基于各分包观察摘要生成四类档案（spirit 文风精神 / technique 文笔技法 / power 笔力控制 / pacing 推进节奏）与 findings。',
      '不要输出正文或长引用；safetyHints.directQuotes 只填你在观察里见过的 <=30 字原文短引用。',
      '必须调用 submit_book_profile 工具提交结果，findings 5-12 条；',
      '若你所在的运行环境无法调用工具，才退化为仅输出一个合法 JSON 对象（无围栏、无寒暄）。'
    ].join('\n')
    const call = await this.runJsonCall({
      run,
      source,
      operation: 'book_aggregation',
      agentName: '参考小说全书汇总',
      systemPrompt,
      userMessage: `## 各分包观察摘要\n${digest}`,
      taskInput: JSON.stringify({ analysisRunId: run.id, digestLength: digest.length }),
      submit: { tool: submitTool as ToolDefinition<never>, draft },
      signal
    })
    return normalizeBookDraft(call.parsed)
  }

  private async runJsonCall(input: {
    run: ReferenceAnalysisRun
    source: ReferenceSourceDetail
    operation: 'chunk' | 'book_aggregation'
    agentName: string
    systemPrompt: string
    userMessage: string
    taskInput: string
    /** 结构化提交工具（方案 D）：传入后 session 挂载该工具，结果经闭包捕获 */
    submit?: {
      tool: ToolDefinition<never>
      draft: SubmitDraftHolder
    }
    signal: AbortSignal
  }): Promise<JsonCallResult> {
    const startedAt = Date.now()
    let session: PluginSessionHandle | undefined
    let capturedUsage: LlmUsageSnapshot | undefined
    let payload: PluginPayloadStats = {
      messagesChars: 0,
      toolsChars: 0,
      toolCount: 0,
      totalChars: 0
    }
    let roundTrips = 0
    let resultSummary = ''
    let failure = ''
    // ── 方案 A2 模式选择 ──
    // provider 探测为 strict（OpenAI 官方端点或显式清单）时，跳过工具路径、
    // 直接用 json_schema 严格结构化输出——合法性与结构同时得到推理期保证。
    // 其余情况维持方案 D 双轨：工具提交为主，容错解析兜底。
    const schemaSupport = resolveJsonSchemaSupport({
      provider: input.run.providerId ?? undefined,
      baseUrl: undefined
    })
    const useStrictSchema = schemaSupport === 'strict'
    if (useStrictSchema) {
      this.context.logger.debug(
        { runId: input.run.id, operation: input.operation },
        '参考分析使用 json_schema 严格结构化输出（A2）'
      )
    }
    try {
      session = await this.context.createSession({
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        // 三种互斥模式（优先级从上到下）：
        // A2-strict：json_schema 严格结构化输出，无工具
        // D-primary：挂载提交工具（结构由 provider 工具 schema 约束）
        // legacy    ：json_object + 容错解析兜底
        ...(useStrictSchema
          ? {
              responseJsonSchema: {
                name:
                  input.operation === 'chunk' ? 'chunk_observations' : 'book_profile',
                schema:
                  input.operation === 'chunk'
                    ? (ChunkObservationsParams as unknown as Record<string, unknown>)
                    : (BookProfileParams as unknown as Record<string, unknown>)
              }
            }
            : input.submit
              ? { tools: [input.submit.tool] }
              : { tools: [] as never[], responseFormat: 'json' as const }),
        modelId:
          input.run.providerId && input.run.modelId
            ? { provider: input.run.providerId, modelId: input.run.modelId }
            : undefined,
        timeoutMs: 300_000,
        signal: input.signal,
        onPayloadStats: (stats) => {
          payload = {
            messagesChars: payload.messagesChars + stats.messagesChars,
            toolsChars: payload.toolsChars + stats.toolsChars,
            toolCount: Math.max(payload.toolCount, stats.toolCount),
            totalChars: payload.totalChars + stats.totalChars
          }
          roundTrips += 1
        }
      })
      const unsubscribe = session.subscribe?.((event) => {
        if (event.type !== 'message_end') return
        const usage = extractLlmUsageFromMessage(
          event.message as Record<string, unknown> | undefined
        )
        if (usage) capturedUsage = addLlmUsage(capturedUsage, usage)
      })
      try {
        const raw = await session.promptStream(() => {})
        const stageLabel = input.operation === 'chunk' ? '参考分包语义抽取' : '全书汇总'
        let parsed: Record<string, unknown>

        // ── 主路径：工具提交（方案 D）──
        // 结构化参数经 provider schema 约束 + SDK 校验后由闭包捕获，
        // 免疫寒暄前缀 / Markdown 围栏 / 尾逗号等一切包裹文本。
        if (input.submit?.draft.payload) {
          parsed = input.submit.draft.payload
          resultSummary = '[tool-submit] '
        } else {
          // ── 兜底路径：容错解析自由文本（A2-strict 下由推理期约束保证可解）──
          try {
            parsed = parseJsonObject(raw, stageLabel)
            resultSummary = useStrictSchema ? '[a2-strict] ' : '[json-fallback] '
          } catch (firstError) {
            // 一次性修复轮：同一会话内要求模型只重发 JSON 本体。
            // 多数失败只是寒暄前缀/尾部说明，明确指令后一次即可修正；
            // 仍失败则按协议违规向上抛出（携带原始输出开头便于定位）。
            if (input.signal.aborted) throw firstError
            this.context.logger.warn(
              { runId: input.run.id, operation: input.operation, rawHead: raw.slice(0, 120) },
              '参考分析 JSON 解析失败，发起同会话修复轮'
            )
            const repaired = await session.prompt(
              '你上一条回复无法被解析为 JSON 对象。请重新输出，并且只输出一个合法的 JSON 对象本体：不要 Markdown 代码围栏、不要任何解释或确认语（如「已收到」）。'
            )
            parsed = parseJsonObject(
              repaired,
              `${stageLabel}（修复轮）`
            )
            resultSummary = '[json-repair] '
            void firstError
          }
        }
        resultSummary += summarizeJsonResult(parsed)
        return {
          parsed,
          usage: hasLlmUsage(capturedUsage)
            ? capturedUsage
            : (this.readUsageForSession(session.sessionId, input.run) ?? emptyUsage(input.run))
        }
      } finally {
        unsubscribe?.()
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : '未知错误'
      throw error
    } finally {
      const usage = hasLlmUsage(capturedUsage)
        ? capturedUsage
        : (this.readUsageForSession(session?.sessionId, input.run) ?? emptyUsage(input.run))
      session?.dispose()
      this.recordCallLog({
        ...input,
        sessionId: session?.sessionId ?? '',
        resultSummary,
        failure,
        durationMs: Date.now() - startedAt,
        usage,
        payload,
        roundTrips
      })
    }
  }

  private readUsageForSession(
    sessionId: string | undefined,
    run: ReferenceAnalysisRun
  ): LlmUsageSnapshot | undefined {
    try {
      if (!sessionId) return undefined
      const rows = this.context.db
        .prepare(
          `SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
           FROM usage_records WHERE session_id = ? ORDER BY timestamp ASC`
        )
        .all(sessionId) as Array<{
        provider: string
        model: string
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number | null
        cache_write_tokens: number | null
      }>
      if (rows.length === 0) return undefined
      return rows.reduce<LlmUsageSnapshot>(
        (usage, row) => ({
          inputTokens: usage.inputTokens + (row.input_tokens ?? 0),
          outputTokens: usage.outputTokens + (row.output_tokens ?? 0),
          cacheReadTokens: usage.cacheReadTokens + (row.cache_read_tokens ?? 0),
          cacheWriteTokens: usage.cacheWriteTokens + (row.cache_write_tokens ?? 0),
          llmProvider: row.provider || usage.llmProvider,
          llmModel: row.model || usage.llmModel
        }),
        emptyUsage(run)
      )
    } catch (error) {
      this.context.logger.debug({ error, sessionId }, '参考分析调用 usage 回填失败')
      return undefined
    }
  }

  private recordCallLog(input: {
    run: ReferenceAnalysisRun
    source: ReferenceSourceDetail
    operation: 'chunk' | 'book_aggregation'
    agentName: string
    systemPrompt: string
    userMessage: string
    taskInput: string
    sessionId: string
    resultSummary: string
    failure: string
    durationMs: number
    usage: LlmUsageSnapshot
    payload: PluginPayloadStats
    roundTrips: number
  }): void {
    const status = input.failure ? 'error' : 'success'
    const agentType =
      input.operation === 'chunk' ? 'reference-analysis-chunk' : 'reference-analysis-book'
    try {
      this.novelStore?.insertAgentLog({
        projectId: input.source.projectId,
        chapterNumber: 0,
        agentType,
        agentName: input.agentName,
        displayAgentType: agentType,
        displayAgentName: input.agentName,
        phase: 'reference-analysis',
        systemPrompt: input.systemPrompt,
        chapterContext: '',
        userMessage: input.operation === 'chunk' ? '参考文本分包语义抽取' : '参考文本全书汇总',
        taskInput: input.taskInput,
        userInstructions: [],
        tools: [],
        toolNames: [],
        askStoryPolicy: 'allOffWithReferences',
        askStoryEnabled: false,
        result: input.resultSummary,
        resultLength: input.resultSummary.length,
        durationMs: input.durationMs,
        status,
        error: input.failure,
        sessionId: input.sessionId,
        operation: input.operation,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        llmProvider: input.usage.llmProvider || input.run.providerId || '',
        llmModel: input.usage.llmModel || input.run.modelId || '',
        payloadMessagesChars: input.payload.messagesChars,
        payloadToolsChars: input.payload.toolsChars,
        payloadToolCount: input.payload.toolCount,
        payloadTotalChars: input.payload.totalChars,
        llmRoundTrips: input.roundTrips,
        dataQuality: classifyDataQuality(input.usage)
      })
    } catch (error) {
      this.context.logger.warn({ error, runId: input.run.id }, '参考分析项目日志写入失败')
    }
    try {
      this.context.agentCallLogger?.record({
        agentId: agentType,
        agentName: input.agentName,
        threadId: input.sessionId,
        systemPrompt: input.systemPrompt,
        userMessage: input.operation === 'chunk' ? '参考文本分包语义抽取' : '参考文本全书汇总',
        taskInput: input.taskInput,
        tools: '[]',
        toolNames: '[]',
        result: input.resultSummary,
        resultLength: input.resultSummary.length,
        durationMs: input.durationMs,
        status,
        error: input.failure,
        metadata: JSON.stringify({
          projectId: input.source.projectId,
          referenceSourceId: input.source.id,
          referenceAnalysisRunId: input.run.id,
          operation: input.operation,
          providerId: input.run.providerId,
          modelId: input.run.modelId,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheReadTokens: input.usage.cacheReadTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          payloadTotalChars: input.payload.totalChars,
          llmRoundTrips: input.roundTrips
        })
      })
    } catch (error) {
      this.context.logger.warn({ error, runId: input.run.id }, '参考分析通用调用日志写入失败')
    }
  }
}

/**
 * 分包语义抽取与全书汇总的 JSON 解析。
 *
 * provider 的 response_format='json' 只是尽力声明：不少兼容网关不生效，
 * 模型仍会在对象前后带寒暄或说明（如「已收到《XX》……{...}」）。此前任何
 * 混入正文的响应都直接判失败，导致整条分析任务反复挂在第一步。
 *
 * 现在按确定性层级容错（不做内容猜测）：
 *   1. 原文直解；
 *   2. 剥离完整围栏后直解；
 *   3. 扫描第一个括号平衡的 `{...}` 片段再解（容忍前缀寒暄/尾部说明）；
 *   每一层都附带控制符转义与尾逗号修复两个变体。
 * 全部失败仍然硬失败，错误信息携带原文开头便于定位。
 */
export function parseJsonObject(raw: string, stage: string): Record<string, unknown> {
  const trimmed = raw.trim().replace(/^\uFEFF/, '')
  const requireObject = (value: unknown): Record<string, unknown> => {
    // 合法 JSON 但不是对象（如裸数组）：协议违规直接报错，不做内容猜测
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${stage}结果必须是 JSON 对象`)
    }
    return value as Record<string, unknown>
  }
  const candidates: string[] = [trimmed]
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced?.[1]?.trim()) candidates.push(fenced[1].trim())
  // 零散围栏标记混在正文里（开头有寒暄时常见）
  if (trimmed.includes('```')) candidates.push(trimmed.replace(/```(?:json)?/gi, '').trim())
  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate)
    if (parsed === null) continue
    if (parsed === 'not-an-object') {
      // 该候选本身是合法 JSON：失败原因是类型而非语法，无需再抽取
      throw new Error(`${stage}结果必须是 JSON 对象`)
    }
    return parsed
  }
  const extracted = extractFirstBalancedJsonObject(trimmed)
  if (extracted) {
    const parsed = tryParseJsonObject(extracted)
    if (parsed && parsed !== 'not-an-object') return parsed
  }
  throw new Error(`${stage}结果不是合法 JSON 对象（原始回复开头：${trimmed.slice(0, 120)}）`)
}

/**
 * 尝试解析候选文本：
 * - 返回解析出的对象；
 * - 返回 'not-an-object' 表示 JSON 合法但类型不符（数组/标量）；
 * - 返回 null 表示存在语法错误，可尝试下一个变体。
 */
function tryParseJsonObject(text: string): Record<string, unknown> | 'not-an-object' | null {
  if (!text.includes('{')) return null
  for (const variant of [text, text.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed: unknown = JSON.parse(escapeControlCharactersInJsonStrings(variant))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return 'not-an-object'
    } catch {
      /* 尝试下一个变体 */
    }
  }
  return null
}

/** 扫描第一个括号平衡的 JSON 对象片段（正确跳过字符串字面量与转义） */
function extractFirstBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return raw.slice(start, index + 1)
    }
  }
  return null
}

function escapeControlCharactersInJsonStrings(value: string): string {
  let escaped = false
  let inString = false
  let result = ''
  for (const char of value) {
    if (!inString) {
      if (char === '"') inString = true
      result += char
      continue
    }
    if (escaped) {
      escaped = false
      result += char
      continue
    }
    if (char === '\\') {
      escaped = true
      result += char
      continue
    }
    if (char === '"') {
      inString = false
      result += char
      continue
    }
    const codePoint = char.charCodeAt(0)
    if (codePoint < 0x20) {
      result +=
        char === '\n'
          ? '\\n'
          : char === '\r'
            ? '\\r'
            : char === '\t'
              ? '\\t'
              : `\\u${codePoint.toString(16).padStart(4, '0')}`
      continue
    }
    result += char
  }
  return result
}

function formatSectionForAnalysis(section: ReferenceSection, text: string): string {
  return `【sectionId=${section.id} title=${section.title ?? `第 ${section.order + 1} 章`}】\n${text}`
}

function emptyUsage(run: ReferenceAnalysisRun): LlmUsageSnapshot {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    llmProvider: run.providerId ?? '',
    llmModel: run.modelId ?? ''
  }
}

function summarizeJsonResult(value: Record<string, unknown>): string {
  const observations = Array.isArray(value.observations) ? value.observations.length : undefined
  const findings = Array.isArray(value.findings) ? value.findings.length : undefined
  if (observations !== undefined) return `已生成 ${observations} 条分包观察。`
  if (findings !== undefined) return `已生成 ${findings} 条全书发现。`
  return `已生成结构化 JSON（字段：${Object.keys(value).slice(0, 8).join(', ')}）。`
}

function buildBookDigest(
  observationsByChunk: Map<string, AnalysisChunkResult['observations']>,
  toneObservations: string[]
): string {
  const lines: string[] = []
  let index = 0
  for (const [chunkId, observations] of observationsByChunk) {
    index += 1
    const summary = observations
      .map(
        (item) =>
          `${item.metric}=${String(typeof item.value === 'string' ? item.value : JSON.stringify(item.value)).slice(0, 120)}`
      )
      .join('；')
    lines.push(`- 参考分包${index}（${chunkId.slice(0, 8)}）：${summary || '（无观察）'}`)
    if (lines.join('\n').length > 60_000) break
  }
  if (toneObservations.length > 0) {
    lines.push(`- 语调观察：${toneObservations.slice(0, 10).join('；')}`)
  }
  return lines.join('\n')
}

function normalizeBookDraft(parsed: Record<string, unknown>): BookAggregationDraft {
  const empty = { summary: '', rules: [] as string[] }
  const readProfile = (key: string): { summary: string; rules: string[] } => {
    const value = parsed[key]
    if (!value || typeof value !== 'object') return { ...empty }
    const record = value as Record<string, unknown>
    return {
      summary: typeof record.summary === 'string' ? record.summary.slice(0, 2000) : '',
      rules: Array.isArray(record.rules)
        ? record.rules
            .filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0)
            .map((rule) => rule.slice(0, 500))
            .slice(0, 20)
        : []
    }
  }
  const findings: BookAggregationDraft['findings'] = []
  if (Array.isArray(parsed.findings)) {
    for (const item of parsed.findings) {
      if (!item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      const category = candidate.category
      if (
        category !== 'spirit' &&
        category !== 'technique' &&
        category !== 'power' &&
        category !== 'pacing'
      )
        continue
      const observation =
        typeof candidate.observation === 'string' ? candidate.observation.trim().slice(0, 1000) : ''
      const rule = typeof candidate.rule === 'string' ? candidate.rule.trim().slice(0, 1000) : ''
      if (!observation && !rule) continue
      const strength =
        candidate.strength === 'hard' ||
        candidate.strength === 'soft' ||
        candidate.strength === 'reference'
          ? candidate.strength
          : 'soft'
      findings.push({
        category,
        observation,
        rule,
        strength,
        evidence: collectShortStrings(candidate.evidence)
      })
    }
  }
  const hintsValue = parsed.safetyHints
  const hints =
    hintsValue && typeof hintsValue === 'object' ? (hintsValue as Record<string, unknown>) : {}
  return {
    spirit: readProfile('spirit'),
    technique: readProfile('technique'),
    power: readProfile('power'),
    pacing: readProfile('pacing'),
    findings: findings.slice(0, 20),
    safetyHints: {
      directQuotes: collectShortStrings(hints.directQuotes),
      properNouns: collectShortStrings(hints.properNouns).slice(0, 30),
      plotSequences: collectShortStrings(hints.plotSequences).slice(0, 20),
      uniqueScenes: collectShortStrings(hints.uniqueScenes).slice(0, 20)
    }
  }
}

function collectShortStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 60))
    .slice(0, 10)
}

/** 短引用 → 原文偏移（找不到的引用丢弃，不猜测位置） */
function locateQuotes(
  quotes: string[],
  text: string
): Array<{ start: number; end: number; length: number }> {
  const offsets: Array<{ start: number; end: number; length: number }> = []
  for (const quote of quotes) {
    const start = text.indexOf(quote)
    if (start >= 0) offsets.push({ start, end: start + quote.length, length: quote.length })
  }
  return offsets.slice(0, 5)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
