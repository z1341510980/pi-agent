/**
 * ReferenceAnalysisRunWorker：P4 远端分析执行器（方案 §8 P4）。
 *
 * 顺序阶段：validating_source → parsing_text → deterministic_analysis →
 * scene_analysis（逐 section LLM 抽取）→ chapter_aggregation（确定性聚合）→
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
import type { PluginContext } from '../../../../core/plugin/plugin-types.js'
import type { ReferenceAnalysisService } from './reference-analysis-service.js'
import { REFERENCE_ANALYZER_VERSION } from './reference-analysis.js'
import type { ReferenceAnalysisRunStore, ReferenceAnalysisRun } from './reference-analysis-run-store.js'
import type { ReferenceProfileStore } from './reference-profile-store.js'

export const REFERENCE_EXTRACTOR_VERSION = 'reference-extractor-v1'
export const REFERENCE_PROMPT_VERSION = 'reference-analysis-prompt-v1'

/** 单条 scene 级观察的结构（LLM 输出条目；evidence 为短引用，落库前转换为偏移） */
interface SceneObservationDraft {
  metric: string
  value: string
  confidence?: number
  evidence?: string[]
  counterexamples?: string[]
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
  sectionId: string
  observations: Array<{ metric: string; value: unknown; confidence: number | null; evidenceOffsets: unknown[]; counterexampleOffsets: unknown[] }>
}

export class ReferenceAnalysisRunWorker {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly context: PluginContext,
    private readonly runStore: ReferenceAnalysisRunStore,
    private readonly profileStore: ReferenceProfileStore,
    private readonly referenceService: ReferenceAnalysisService,
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
    const completedSections = new Set<string>(
      Array.isArray(checkpoint.completedSectionIds)
        ? checkpoint.completedSectionIds.filter((item): item is string => typeof item === 'string')
        : [],
    )
    const observationsBySection = new Map<string, AnalysisChunkResult['observations']>(
      Array.isArray(checkpoint.observationsBySection)
        ? (checkpoint.observationsBySection as Array<[string, AnalysisChunkResult['observations']]>).filter(Array.isArray)
        : [],
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
    const includedIds = run.includedSectionIds.length > 0
      ? run.includedSectionIds
      : sections.filter((section) => section.included).map((section) => section.id)
    const selected = sections.filter((section) => includedIds.includes(section.id) && section.included)
    if (selected.length === 0) {
      this.runStore.fail(runId, '分析范围内没有可用的参考章节')
      return
    }
    const { sectionTexts } = this.referenceService.getSectionsText(run.sourceId, selected.map((section) => section.id))
    signal.throwIfAborted()

    // ── deterministic_analysis：本地报告的测量值转 observation（无 LLM 成本） ──
    this.runStore.setStage(runId, 'deterministic_analysis', '落地本地确定性测量')
    const local = this.referenceService.getLocalReport(run.sourceId)
    this.runStore.addObservation({
      analysisRunId: runId, sectionId: null, level: 'measurement', metric: 'sentence.length.average',
      value: local.sentenceLengths.average, measurementMethod: REFERENCE_ANALYZER_VERSION, confidence: 0.95,
      evidenceOffsets: [], counterexampleOffsets: [], safetyFlags: [],
    })
    this.runStore.addObservation({
      analysisRunId: runId, sectionId: null, level: 'measurement', metric: 'dialogue.ratio',
      value: local.dialogue.ratio, measurementMethod: REFERENCE_ANALYZER_VERSION, confidence: 0.9,
      evidenceOffsets: [], counterexampleOffsets: [], safetyFlags: [],
    })
    this.runStore.addObservation({
      analysisRunId: runId, sectionId: null, level: 'measurement', metric: 'paragraph.length.average',
      value: local.paragraphLengths.average, measurementMethod: REFERENCE_ANALYZER_VERSION, confidence: 0.9,
      evidenceOffsets: [], counterexampleOffsets: [], safetyFlags: [],
    })

    // ── scene_analysis：逐 section 抽取（checkpoint 跳过已完成 chunk，不重复计费） ──
    this.runStore.setStage(runId, 'scene_analysis', `逐章语义抽取（${selected.length} 章）`)
    let actualCalls = Number(checkpoint.llmCalls ?? 0)
    for (const section of selected) {
      signal.throwIfAborted()
      run = this.runStore.getRun(runId)!
      if (!run || !['queued', 'running'].includes(run.status)) return
      if (completedSections.has(section.id)) continue

      const text = sectionTexts[section.id] ?? ''
      if (!text.trim()) continue
      try {
        const chunk = await this.analyzeSection(runId, section.id, text, signal)
        for (const observation of chunk) {
          this.runStore.addObservation({
            analysisRunId: runId, sectionId: section.id, level: 'scene', metric: observation.metric,
            value: observation.value, measurementMethod: REFERENCE_EXTRACTOR_VERSION,
            confidence: observation.confidence, evidenceOffsets: observation.evidenceOffsets,
            counterexampleOffsets: observation.counterexampleOffsets, safetyFlags: [],
          })
        }
        observationsBySection.set(section.id, chunk)
        completedSections.add(section.id)
        actualCalls += 1
        this.runStore.setCheckpoint(runId, {
          completedSectionIds: [...completedSections],
          observationsBySection: [...observationsBySection.entries()],
          llmCalls: actualCalls,
        }, { llmCalls: actualCalls })
      } catch (error) {
        if (signal.aborted) return
        this.runStore.fail(runId, `第 ${section.order + 1} 章语义抽取失败：${error instanceof Error ? error.message : '未知错误'}`)
        return
      }
    }

    // ── chapter_aggregation：确定性聚合 scene 观察 ──
    this.runStore.setStage(runId, 'chapter_aggregation', '按章聚合观察')
    for (const [sectionId, observations] of observationsBySection) {
      this.runStore.addObservation({
        analysisRunId: runId, sectionId, level: 'chapter', metric: 'scene.observation.count',
        value: observations.length, measurementMethod: `${REFERENCE_EXTRACTOR_VERSION}:aggregate`, confidence: 1,
        evidenceOffsets: [], counterexampleOffsets: [], safetyFlags: [],
      })
    }

    // ── book_aggregation：单次 LLM 汇总 ──
    this.runStore.setStage(runId, 'book_aggregation', '全书汇总四类档案')
    let book: BookAggregationDraft
    try {
      const digest = buildBookDigest(observationsBySection, local.languageToneObservations)
      book = await this.aggregateBook(runId, digest, signal)
      actualCalls += 1
      this.runStore.setCheckpoint(runId, {
        completedSectionIds: [...completedSections],
        observationsBySection: [...observationsBySection.entries()],
        llmCalls: actualCalls,
        bookDigestHash: hash(digest),
      }, { llmCalls: actualCalls })
    } catch (error) {
      if (signal.aborted) return
      this.runStore.fail(runId, `全书汇总失败：${error instanceof Error ? error.message : '未知错误'}`)
      return
    }

    // ── safety_scan：确定性核对直接引用（quote 必须真实存在于原文） ──
    this.runStore.setStage(runId, 'safety_scan', '核对安全线索')
    const fullText = Object.values(sectionTexts).join('\n')
    const quotes = (book.safetyHints?.directQuotes ?? []).filter((quote) => quote.length >= 12 && fullText.includes(quote))
    for (const quote of quotes) {
      this.runStore.addObservation({
        analysisRunId: runId, sectionId: null, level: 'book', metric: 'safety.direct_quote',
        value: { length: quote.length, prefix: quote.slice(0, 10) }, measurementMethod: `${REFERENCE_EXTRACTOR_VERSION}:safety`,
        confidence: 1, evidenceOffsets: [], counterexampleOffsets: [],
        safetyFlags: ['direct_quote'],
      })
    }

    // ── awaiting_review：生成 profile 草稿并完成 ──
    this.runStore.setStage(runId, 'awaiting_review', '生成待审核档案')
    const profile = this.profileStore.createProfileFromRun(run, book, quotes)
    this.runStore.complete(runId, profile.id)
  }

  private async analyzeSection(runId: string, sectionId: string, text: string, signal: AbortSignal): Promise<AnalysisChunkResult['observations']> {
    const session = await this.context.createSession({
      systemPrompt: [
        '你是小说文风观察提取器。仅依据提供的单章参考文本，输出可核验的观察。',
        '不要创作正文，不要复述大段原文；evidence 只允许 ≤30 字的原文短引用。',
        '输出严格 JSON：{"observations":[{"metric":"...","value":"...","confidence":0.0,"evidence":["短引用"],"counterexamples":["短引用"]}]}，2-6 条。',
      ].join('\n'),
      userMessage: `## 参考章节文本\n${text}`,
      tools: [],
      responseFormat: 'json',
      timeoutMs: 300_000,
      signal,
    })
    try {
      const raw = await session.promptStream(() => {})
      const parsed = JSON.parse(raw) as { observations?: unknown }
      if (!Array.isArray(parsed.observations)) return []
      const results: AnalysisChunkResult['observations'] = []
      for (const item of parsed.observations) {
        if (!item || typeof item !== 'object') continue
        const candidate = item as Record<string, unknown>
        const metric = typeof candidate.metric === 'string' && /^[a-z][a-z0-9_.]{2,60}$/.test(candidate.metric) ? candidate.metric : null
        const value = typeof candidate.value === 'string' && candidate.value.trim() ? candidate.value.trim().slice(0, 2000) : null
        if (!metric || !value) continue
        results.push({
          metric,
          value,
          confidence: typeof candidate.confidence === 'number' && candidate.confidence >= 0 && candidate.confidence <= 1 ? candidate.confidence : null,
          evidenceOffsets: locateQuotes(collectShortStrings(candidate.evidence), text),
          counterexampleOffsets: locateQuotes(collectShortStrings(candidate.counterexamples), text),
        })
      }
      return results.slice(0, 10)
    } finally {
      session.dispose()
    }
  }

  private async aggregateBook(runId: string, digest: string, signal: AbortSignal): Promise<BookAggregationDraft> {
    const session = await this.context.createSession({
      systemPrompt: [
        '你是小说参考分析汇总器。基于各章观察摘要生成四类档案（spirit 文风精神 / technique 文笔技法 / power 笔力控制 / pacing 推进节奏）与 findings。',
        '不要输出正文或长引用；safetyHints.directQuotes 只填你在观察里见过的 ≤30 字原文短引用。',
        '输出严格 JSON：{"spirit":{"summary":"","rules":[]},"technique":{...},"power":{...},"pacing":{...},"findings":[{"category":"spirit","observation":"","rule":"","strength":"soft","evidence":[]}],"safetyHints":{"directQuotes":[],"properNouns":[],"plotSequences":[],"uniqueScenes":[]}}，findings 5-12 条。',
      ].join('\n'),
      userMessage: `## 各章观察摘要\n${digest}`,
      tools: [],
      responseFormat: 'json',
      timeoutMs: 300_000,
      signal,
    })
    try {
      const raw = await session.promptStream(() => {})
      return normalizeBookDraft(JSON.parse(raw) as Record<string, unknown>)
    } finally {
      session.dispose()
    }
  }
}

function buildBookDigest(observationsBySection: Map<string, AnalysisChunkResult['observations']>, toneObservations: string[]): string {
  const lines: string[] = []
  let index = 0
  for (const [sectionId, observations] of observationsBySection) {
    index += 1
    const summary = observations
      .map((item) => `${item.metric}=${String(typeof item.value === 'string' ? item.value : JSON.stringify(item.value)).slice(0, 120)}`)
      .join('；')
    lines.push(`- 章节${index}（${sectionId.slice(0, 8)}）：${summary || '（无观察）'}`)
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
        ? record.rules.filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0).map((rule) => rule.slice(0, 500)).slice(0, 20)
        : [],
    }
  }
  const findings: BookAggregationDraft['findings'] = []
  if (Array.isArray(parsed.findings)) {
    for (const item of parsed.findings) {
      if (!item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      const category = candidate.category
      if (category !== 'spirit' && category !== 'technique' && category !== 'power' && category !== 'pacing') continue
      const observation = typeof candidate.observation === 'string' ? candidate.observation.trim().slice(0, 1000) : ''
      const rule = typeof candidate.rule === 'string' ? candidate.rule.trim().slice(0, 1000) : ''
      if (!observation && !rule) continue
      const strength = candidate.strength === 'hard' || candidate.strength === 'soft' || candidate.strength === 'reference' ? candidate.strength : 'soft'
      findings.push({ category, observation, rule, strength, evidence: collectShortStrings(candidate.evidence) })
    }
  }
  const hintsValue = parsed.safetyHints
  const hints = hintsValue && typeof hintsValue === 'object' ? hintsValue as Record<string, unknown> : {}
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
      uniqueScenes: collectShortStrings(hints.uniqueScenes).slice(0, 20),
    },
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
function locateQuotes(quotes: string[], text: string): Array<{ start: number; end: number; length: number }> {
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
