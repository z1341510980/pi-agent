import type { PluginContext } from '../../../../core/plugin/plugin-types.js'
import type { ReferenceSection } from '@repo/shared/novel'
import type { StyleMetricsSnapshot } from '../analysis/style-measurement.js'

export type StyleCraftDimension =
  | 'scene_craft'
  | 'character_craft'
  | 'dialogue_craft'
  | 'action_craft'
  | 'emotion_craft'
  | 'narrative_craft'

export interface StyleTechniqueDraft {
  id: string
  dimension: StyleCraftDimension
  name: string
  mechanism: string
  transfer: string
  evidence: Array<{ sectionId: string; quote: string }>
  metricAnchors: string[]
  confidence: 'verified' | 'unverified' | 'rejected'
  kept: boolean
}

export interface StyleDistillInput {
  sourceId: string
  sections: ReferenceSection[]
  text: string
  sectionTexts?: Record<string, string>
  metrics: StyleMetricsSnapshot
  notes?: string
}

export interface StyleDistillDraft {
  name: string
  sourceTitle: string
  description: string
  distilledPrompt: string
  exclusions: string[]
  techniques: StyleTechniqueDraft[]
  metrics: StyleMetricsSnapshot
  exemplarPassages: Array<{ sectionId: string; text: string; reason: string }>
}

const STYLE_DIMENSIONS = new Set<StyleCraftDimension>([
  'scene_craft',
  'character_craft',
  'dialogue_craft',
  'action_craft',
  'emotion_craft',
  'narrative_craft',
])

function normalizeEvidenceText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
}

/** 允许模型漏掉中文引号、空格或标点，但不能凭空造证据。 */
function evidenceQuoteExists(sample: string, quote: string): boolean {
  const trimmed = quote.trim()
  if (!trimmed) return false
  if (sample.includes(trimmed)) return true
  const normalizedSample = normalizeEvidenceText(sample)
  const normalizedQuote = normalizeEvidenceText(trimmed)
  return normalizedQuote.length >= 4 && normalizedSample.includes(normalizedQuote)
}

function flattenMetricKeys(value: unknown, prefix = ''): Set<string> {
  const keys = new Set<string>()
  if (!value || typeof value !== 'object') return keys
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    keys.add(path)
    for (const nested of flattenMetricKeys(child, path)) keys.add(nested)
  }
  return keys
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 从头/中段/尾部抽取 6～10 个窗口，保持总预算并避免只分析开头。 */
export function buildLayeredStyleSample(text: string, maxChars = 24000): string {
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  const segmentCount = Math.min(8, Math.max(1, Math.floor(maxChars / 600)))
  const windowSize = Math.max(1, Math.floor(maxChars / segmentCount))
  const maxStart = Math.max(0, normalized.length - windowSize)
  const segments: string[] = []
  for (let index = 0; index < segmentCount; index += 1) {
    const ratio = segmentCount === 1 ? 0 : index / (segmentCount - 1)
    const start = Math.min(maxStart, Math.floor(maxStart * ratio))
    segments.push(`【分层样本 ${index + 1}/${segmentCount}】\n${normalized.slice(start, start + windowSize)}`)
  }
  return segments.join('\n\n')
}

/** 分层抽样时保留章节标签，让模型给出的 sectionId 能与引文来源对应。 */
export function buildSectionAwareStyleSample(
  sections: ReferenceSection[],
  sectionTexts: Record<string, string> | undefined,
  fallbackText: string,
  maxChars = 24000,
): string {
  if (!sectionTexts) return buildLayeredStyleSample(fallbackText, maxChars)
  const available = sections
    .map((section) => ({ section, text: sectionTexts[section.id]?.trim() ?? '' }))
    .filter((item) => item.text.length > 0)
  if (available.length === 0) return buildLayeredStyleSample(fallbackText, maxChars)

  const labeled = available.map(({ section, text }) =>
    `【sectionId=${section.id} title=${section.title ?? ''}】\n${text}`,
  ).join('\n\n')
  if (labeled.length <= maxChars) return labeled

  const segmentCount = Math.min(8, Math.max(1, Math.floor(maxChars / 600)))
  const windowSize = Math.max(1, Math.floor(maxChars / segmentCount) - 100)
  const totalLength = available.reduce((sum, item) => sum + item.text.length, 0)
  const segments: string[] = []
  for (let index = 0; index < segmentCount; index += 1) {
    const ratio = segmentCount === 1 ? 0 : index / (segmentCount - 1)
    const target = Math.min(totalLength - 1, Math.floor((totalLength - 1) * ratio))
    let offset = 0
    let selected = available[available.length - 1]
    for (const item of available) {
      if (target < offset + item.text.length) {
        selected = item
        break
      }
      offset += item.text.length
    }
    const localTarget = Math.max(0, target - offset)
    const maxStart = Math.max(0, selected.text.length - windowSize)
    const start = Math.min(maxStart, Math.max(0, localTarget - Math.floor(windowSize / 2)))
    segments.push([
      `【分层样本 ${index + 1}/${segmentCount} sectionId=${selected.section.id} title=${selected.section.title ?? ''}】`,
      selected.text.slice(start, start + windowSize),
    ].join('\n'))
  }
  return segments.join('\n\n')
}

const DISTILL_SYSTEM_PROMPT = `你是小说写作手法分析师，不是作者模仿器。你的任务是从参考小说样本中提炼可迁移的写作机制，生成一个可被召集的文风能力专家。只提炼写作机制，不复制原作内容。

硬规则：
1. 你的分析主体必须是写作手法，而不是词频、平均句长或“文笔很好”之类空话。统计指标只作为辅助标注。
2. 必须分别分析六个维度：场景描写、人物描写、对话描写、动作/打斗描写、感情引爆、叙事结构。
3. 每条手法必须说明：它如何运作、何时使用、如何迁移到新文本。
4. 每条手法必须引用样本原文短句作为证据，引用不超过 80 字，且不得编造。
5. 感情引爆必须具体说明：铺垫、蓄势、引爆点、爆发时的语言/节奏变化、爆发后的余韵。
6. 明确列出不可迁移内容：人物、剧情、专名、世界观、独有比喻和原句。
7. 不要输出“像某作者”“画面感强”“文笔细腻”等不可执行评价。
8. 只返回 JSON，不要 Markdown 围栏：
{
  "name": "独立文风能力名称",
  "description": "能力摘要",
  "distilledPrompt": "可直接给 Writer/Reviewer/Reviser 使用的迁移提示词",
  "exclusions": ["不可迁移内容"],
  "techniques": [{"id":"","dimension":"scene_craft|character_craft|dialogue_craft|action_craft|emotion_craft|narrative_craft","name":"","mechanism":"","transfer":"","evidence":[{"sectionId":"","quote":""}],"metricAnchors":[],"confidence":"verified|unverified|rejected","kept":true}],
  "exemplarPassages": [{"sectionId":"","text":"不超过 500 字","reason":"为什么选它"}]
}`

export async function distillStyleExpertFromReference(
  context: PluginContext,
  input: StyleDistillInput,
  modelId?: { provider: string; modelId: string },
  options: { allowLegacyOutput?: boolean } = {},
): Promise<StyleDistillDraft> {
  if (input.sections.length === 0) throw new Error('参考样本不足，至少选择一个章节')
  if (input.text.trim().length < 80) throw new Error('参考样本不足，至少需要 80 字符')
  const sectionContext = input.sections.map((section) => `【sectionId=${section.id} title=${section.title ?? ''}】`).join('\n')
  const handle = await context.createAgUiSession({
    systemPrompt: DISTILL_SYSTEM_PROMPT,
    userMessage: [
      '参考章节索引：', sectionContext,
      '本地统计仅作为辅助标注：', JSON.stringify(input.metrics),
      input.notes ? `用户补充：${input.notes}` : '',
      '参考小说样本（分层抽样，避免只分析开头）：', buildSectionAwareStyleSample(input.sections, input.sectionTexts, input.text),
    ].filter(Boolean).join('\n\n'),
    tools: [], modelId, emit: () => undefined, emitRaw: false,
  })
  try {
    const result = await handle.session.prompt()
    const raw = typeof result === 'string' ? result : JSON.stringify(result)
    const json = raw.match(/\{[\s\S]*\}/)?.[0]
    if (!json) throw new Error('文风手法分析结果不是有效 JSON')
    const parsed = JSON.parse(json) as Partial<StyleDistillDraft> & { prompt?: unknown }
    const distilledPrompt = typeof parsed.distilledPrompt === 'string'
      ? parsed.distilledPrompt
      : options.allowLegacyOutput && typeof parsed.prompt === 'string'
        ? parsed.prompt
        : undefined
    const parsedTechniques: unknown[] | undefined = Array.isArray(parsed.techniques)
      ? parsed.techniques as unknown[]
      : options.allowLegacyOutput
        ? []
        : undefined
    if (!isNonEmptyString(parsed.name) || !isNonEmptyString(parsed.description) || !distilledPrompt || !parsedTechniques) throw new Error('文风手法分析结果缺少必要字段')
    const validSectionIds = new Set(input.sections.map((section) => section.id))
    const metricKeys = flattenMetricKeys(input.metrics)
    const techniques = parsedTechniques
      .filter((technique): technique is Record<string, unknown> =>
        isRecord(technique)
        && STYLE_DIMENSIONS.has(technique.dimension as StyleCraftDimension)
        && isNonEmptyString(technique.id)
        && isNonEmptyString(technique.name)
        && isNonEmptyString(technique.mechanism)
        && isNonEmptyString(technique.transfer),
      )
      .map((technique): StyleTechniqueDraft => {
        const evidence = Array.isArray(technique.evidence)
          ? technique.evidence.filter((item) => {
              if (!isRecord(item) || !isNonEmptyString(item.sectionId) || !isNonEmptyString(item.quote)) return false
              if (!validSectionIds.has(item.sectionId)) return false
              return evidenceQuoteExists(input.sectionTexts?.[item.sectionId] ?? input.text, item.quote)
            }) as Array<{ sectionId: string; quote: string }>
          : []
        const metricAnchors = Array.isArray(technique.metricAnchors)
          ? technique.metricAnchors.filter((anchor): anchor is string => typeof anchor === 'string' && metricKeys.has(anchor))
          : []
        const evidenceValid = evidence.length > 0
        const metricsValid = !Array.isArray(technique.metricAnchors) || technique.metricAnchors.length === 0 || metricAnchors.length > 0
        return {
          id: technique.id as string,
          dimension: technique.dimension as StyleCraftDimension,
          name: technique.name as string,
          mechanism: technique.mechanism as string,
          transfer: technique.transfer as string,
          evidence,
          metricAnchors,
          confidence: technique.confidence === 'verified' && evidenceValid && metricsValid ? 'verified' : 'unverified',
          kept: technique.kept === true && evidenceValid,
        }
      })
    const exemplarPassages = (Array.isArray(parsed.exemplarPassages) ? parsed.exemplarPassages : []).filter((passage) => {
      if (!isRecord(passage) || !isNonEmptyString(passage.sectionId) || !isNonEmptyString(passage.text) || !isNonEmptyString(passage.reason)) return false
      if (!validSectionIds.has(passage.sectionId)) return false
      return evidenceQuoteExists(input.sectionTexts?.[passage.sectionId] ?? input.text, passage.text)
    }) as Array<{ sectionId: string; text: string; reason: string }>
    const exclusions = (Array.isArray(parsed.exclusions) ? parsed.exclusions : [])
      .filter((item): item is string => isNonEmptyString(item))
    return { ...parsed, distilledPrompt, metrics: input.metrics, techniques, exclusions, exemplarPassages, sourceTitle: input.sections[0]?.title ?? '参考小说样本' } as StyleDistillDraft
  } finally {
    handle.dispose()
  }
}

/** 旧粘贴样本接口的兼容适配；新功能应使用 reference source + sectionIds。 */
export async function distillStyleExpert(
  context: PluginContext,
  input: { sourceTitle: string; sourceAuthor?: string; sample: string; notes?: string },
  modelId?: { provider: string; modelId: string },
): Promise<{ name: string; sourceTitle: string; sourceAuthor?: string; description: string; distilledPrompt: string; enabled: boolean }> {
  const draft = await distillStyleExpertFromReference(context, {
    sourceId: 'legacy-paste',
    sections: [{ id: 'legacy-paste', sourceId: 'legacy-paste', type: 'chapter', order: 0, title: input.sourceTitle, start: 0, end: input.sample.length, characterCount: input.sample.length, estimatedTokens: 0, boundaryConfidence: 1, contentHash: '', included: true, version: 1, warnings: [] }],
    text: input.sample,
    sectionTexts: { 'legacy-paste': input.sample },
    metrics: { characterCount: input.sample.length, paragraphCount: 0, sentenceCount: 0, sentenceLength: { count: 0, min: 0, max: 0, average: 0, median: 0, p90: 0, buckets: { '1-10': 0, '11-20': 0, '21-40': 0, '41+': 0 } }, paragraphLength: { count: 0, min: 0, max: 0, average: 0, median: 0, p90: 0 }, dialogue: { charRatio: 0, paragraphRatio: 0 }, metaphorDensity: 0, sensoryMix: { visual: 0, auditory: 0, olfactory: 0, tactile: 0, taste: 0, bodily: 0 }, personSignal: { first: 0, third: 0 }, narrativePerson: 'mixed', emotionalTemperature: 5, shortSentenceRatio: 0, longSentenceRatio: 0, trustworthy: false },
    notes: input.notes,
  }, modelId, { allowLegacyOutput: true })
  return { name: draft.name, sourceTitle: input.sourceTitle, sourceAuthor: input.sourceAuthor, description: draft.description, distilledPrompt: draft.distilledPrompt, enabled: true }
}
