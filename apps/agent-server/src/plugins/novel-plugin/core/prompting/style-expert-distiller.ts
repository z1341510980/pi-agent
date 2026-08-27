import type { PluginContext } from '../../../../core/plugin/plugin-types.js'
import { resolveJsonSchemaSupport } from '../../../../core/plugin/structured-outputs-support.js'
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ReferenceSection } from '@repo/shared/novel'
import type { StyleMetricsSnapshot } from '../analysis/style-measurement.js'
import { buildReferenceLocalChunkPlan } from '../analysis/reference-analysis.js'
import { parseJsonObject } from '../analysis/reference-analysis-run-worker.js'

export type StyleCraftDimension =
  | 'scene_craft'
  | 'character_craft'
  | 'dialogue_craft'
  | 'action_craft'
  | 'emotion_craft'
  | 'conflict_craft'
  | 'narrative_craft'

export interface StyleTechniqueDraft {
  id: string
  dimension: StyleCraftDimension
  name: string
  mechanism: string
  transfer: string
  /** 什么情况下这条手法失效或必须让位；缺失则不允许标 verified。 */
  failureMode?: string
  evidence: Array<{ sectionId: string; quote: string }>
  metricAnchors: string[]
  /** 三重验证记录（跨域复现 / 生成力 / 排他性）。 */
  validation?: {
    crossDomain?: number
    generative?: boolean
    exclusive?: boolean
  }
  confidence: 'verified' | 'unverified' | 'rejected'
  kept: boolean
}

export interface StyleExpressionDna {
  sentence?: string
  lexicon?: string
  rhythm?: string
  humor?: string
  certainty?: string
  distance?: string
}

export interface StyleTension {
  name: string
  between: [string, string]
  resolution: string
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
  /** 语言指纹六项；缺字段不报错，但会削弱注入效果。 */
  expressionDna?: StyleExpressionDna
  /** 内在张力：只有正向规则的专家会把正文推成"样样都做到"的模板腔。 */
  tensions: StyleTension[]
  /** 该文风明确避免的写法（区别于 exclusions 的不可搬运内容）。 */
  antiPatterns: string[]
  /** 这套能力覆盖不到的场景，防止被当万能风格。 */
  boundaries: string[]
}

const STYLE_DIMENSIONS = new Set<StyleCraftDimension>([
  'scene_craft',
  'character_craft',
  'dialogue_craft',
  'action_craft',
  'emotion_craft',
  'conflict_craft',
  'narrative_craft'
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
    segments.push(
      `【分层样本 ${index + 1}/${segmentCount}】\n${normalized.slice(start, start + windowSize)}`
    )
  }
  return segments.join('\n\n')
}

/** 分层抽样时保留章节标签，让模型给出的 sectionId 能与引文来源对应。 */
export function buildSectionAwareStyleSample(
  sections: ReferenceSection[],
  sectionTexts: Record<string, string> | undefined,
  fallbackText: string,
  maxChars = 24000
): string {
  if (!sectionTexts) return buildLayeredStyleSample(fallbackText, maxChars)
  const available = sections
    .map((section) => ({ section, text: sectionTexts[section.id]?.trim() ?? '' }))
    .filter((item) => item.text.length > 0)
  if (available.length === 0) return buildLayeredStyleSample(fallbackText, maxChars)

  const labeled = available
    .map(({ section, text }) => `【sectionId=${section.id} title=${section.title ?? ''}】\n${text}`)
    .join('\n\n')
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
    segments.push(
      [
        `【分层样本 ${index + 1}/${segmentCount} sectionId=${selected.section.id} title=${selected.section.title ?? ''}】`,
        selected.text.slice(start, start + windowSize)
      ].join('\n')
    )
  }
  return segments.join('\n\n')
}

/**
 * 长参考小说先在本地按章节分包，再从分布均匀的分包取样。
 * 最终仍受 maxChars 约束，不会把整本原文直接放进文风蒸馏模型上下文。
 */
export function buildChunkedSectionAwareStyleSample(
  sections: ReferenceSection[],
  sectionTexts: Record<string, string> | undefined,
  fallbackText: string,
  maxChars = 24000
): string {
  if (!sectionTexts) return buildLayeredStyleSample(fallbackText, maxChars)
  const plan = buildReferenceLocalChunkPlan(sections)
  if (plan.chunks.length <= 1) {
    return buildSectionAwareStyleSample(sections, sectionTexts, fallbackText, maxChars)
  }

  const sampledChunkCount = Math.min(8, plan.chunks.length)
  const sampledChunks = Array.from({ length: sampledChunkCount }, (_, index) => {
    const position =
      sampledChunkCount === 1
        ? 0
        : Math.round((index * (plan.chunks.length - 1)) / (sampledChunkCount - 1))
    return plan.chunks[position]!
  })
  const charsPerChunk = Math.max(1, Math.floor(maxChars / sampledChunks.length))

  return sampledChunks
    .map((chunk, index) => {
      const sectionIds = new Set(chunk.sectionIds)
      const chunkSections = sections.filter((section) => sectionIds.has(section.id))
      const chunkTexts = Object.fromEntries(
        chunkSections.map((section) => [section.id, sectionTexts[section.id] ?? ''])
      )
      const chunkText = chunkSections.map((section) => chunkTexts[section.id]).join('\n\n')
      return [
        `【本地章节分包 ${index + 1}/${plan.chunks.length}】`,
        buildSectionAwareStyleSample(chunkSections, chunkTexts, chunkText, charsPerChunk)
      ].join('\n')
    })
    .join('\n\n')
}

const DISTILL_SYSTEM_PROMPT = `你是小说写作手法分析师，不是作者模仿器。你的任务是从参考小说样本中提炼可迁移的写作机制，生成一个可被召集的文风能力专家。只提炼写作机制，不复制原作内容。

## 手法认定：三重验证（核心方法）

一条观察要成为"手法"，必须同时通过三重验证，否则降级或丢弃：

1. **跨域复现**：同一机制在至少 2 个不同场景/维度中出现（对话场与动作场、日常与高压）。只出现一次的写法是偶然，不是手法。
2. **生成力**：拿着这条手法能推断"新场景下该怎么写"。无法生成新写法的描述（如"文笔细腻"）不是手法。
3. **排他性**：不是所有作者都这样写。所有小说都成立的常识（如"对话要推动情节"）没有区分度，不要收录。

三项全过 → confidence: verified；仅过 1-2 项 → unverified；0 项 → 不要输出。
**宁少勿多：3 条真正有排他性的手法远好于 10 条泛泛而谈。**

## 每条手法必须回答四件事

- mechanism：它在原文里如何运作（不是它"好在哪"）
- transfer：如何迁移到新文本（可执行动作，不是抽象原则）
- failureMode：**什么情况下这条手法失效或必须让位**。没有失效条件的手法会被无差别套用，正文反而变模板。这是必填项。
- evidence：样本原文短句（≤80 字），不得编造

## 除手法之外必须产出

1. **expressionDna（语言指纹六项）**：sentence（长短句配比与落点句处理）、lexicon（高频词/专属句法/禁忌词）、rhythm（先结论还是先铺垫、转折方式）、humor（讽刺/自嘲/荒诞/冷幽默/不幽默）、certainty（断言型还是保留型）、distance（叙述距离与视角贴合方式）。每项一句可执行描述。
2. **tensions（内在张力，2-3 条）**：这套文风自身相互拉扯的两股力量，以及取舍原则。例如"克制 vs 引爆"——大部分篇幅克制，唯一引爆点必须彻底失态；两者都要就变成全程中等强度。张力缺失的专家会让 Writer 试图样样满分，产出平均而无记忆点的正文。
3. **antiPatterns（反模式）**：这套文风明确避免的写法（如"用旁白解释人物动机"）。区别于 exclusions（不可搬运的具体内容）。
4. **boundaries（诚实边界）**：这套能力覆盖不到什么场景（如"不适合快节奏群战"）。防止被当万能风格套用。
5. **exclusions（不可迁移内容）**：人物、剧情、专名、世界观、独有比喻、原句。

## 七个维度

必须分别分析：场景描写（scene_craft）、人物描写（character_craft）、对话描写（dialogue_craft）、动作/打斗（action_craft）、感情引爆（emotion_craft）、冲突构建（conflict_craft）、叙事结构（narrative_craft）。
感情引爆必须具体说明：铺垫、蓄势、引爆点、爆发时的语言/节奏变化、爆发后的余韵。
冲突构建必须具体说明：冲突如何埋设（双方欲望如何先于对抗出现）、升级路径（代价如何逐步加码）、对撞时刻（压力最大时语言与节奏怎么处理）、冲突余波（对抗结束后的关系与代价如何显影）。

## 禁止

- 输出“像某作者”“画面感强”“文笔细腻”等不可执行评价
- 把通用常识包装成该文风的独特手法（通不过排他性验证）
- 编造原文中不存在的引文
- 只写手法优点不写失效条件

## 输出方式

必须调用 submit_style_distill 工具提交全部字段（字段含义见工具参数描述）。
不要在对话文本中输出 JSON 或 Markdown 围栏。
若运行环境确实无法调用工具，才退化为仅输出一个合法 JSON 对象，字段名与工具参数一致。`

/** 专家团维度说明：聚焦蒸馏时注入，让单次调用只挖一个维度的手法。 */
export const STYLE_DIMENSION_LABELS: Record<StyleCraftDimension, string> = {
  scene_craft: '场景描写',
  character_craft: '人物描写',
  dialogue_craft: '对话描写',
  action_craft: '动作/打斗',
  emotion_craft: '感情引爆',
  conflict_craft: '冲突构建',
  narrative_craft: '叙事结构'
}

const STYLE_DIMENSION_FOCUS: Record<StyleCraftDimension, string> = {
  scene_craft:
    '环境如何承载情绪与信息：感官锚点的选取与分布、空间调度的顺序、环境细节何时让位于动作、闲笔如何服务氛围。',
  character_craft:
    '人物如何被显影：外貌/动作/习惯的取舍、出场方式、身体反应如何代替心理描写、多人在场时的区分手段。',
  dialogue_craft:
    '对话的呼吸：潜台词压在动作里的方式、打断与半句的处理、答非所问的时机、不同人物声音差异的实现。',
  action_craft:
    '动作/打斗的节奏：短句推进的密度变化、感官锚点的位置、后果如何即时可见、身体反馈与疼痛的处理。',
  emotion_craft:
    '感情的引爆链路：铺垫如何布置、蓄势如何收窄感官、引爆点的语言与节奏突变、爆发后的余韵如何降温。',
  conflict_craft:
    '冲突的构建：双方欲望如何先于对抗出现（埋设）、代价如何逐步加码（升级路径）、压力最大的对撞时刻怎么写、对抗结束后的关系与代价如何显影（余波）。',
  narrative_craft:
    '叙事的结构：POV 切换的时机与标记、信息释放的控制、章节钩子与收束方式、跨场景的节奏布局。'
}

function buildDimensionFocusPrompt(dimension: StyleCraftDimension): string {
  return [
    `## 本次任务只分析一个维度：${STYLE_DIMENSION_LABELS[dimension]}（${dimension}）`,
    STYLE_DIMENSION_FOCUS[dimension],
    'techniques 只提交该维度的手法；其他维度即使观察到也不要提交。',
    'name 以「' + STYLE_DIMENSION_LABELS[dimension] + '·」开头，后接这个能力自己的名字（如「' + STYLE_DIMENSION_LABELS[dimension] + '·蓄压引爆」）。'
  ].join('\n')
}

// ── 结构化提交工具（方案 D）─────────────────────────────────────────
//
// 蒸馏产物此前靠"模型自觉输出合法 JSON 文本 + 正则截取"，寒暄前缀/围栏/尾逗号
// 都会打穿。改为闭包捕获式提交工具：参数结构由 provider 约束、SDK 校验，
// 文本解析仅保留为 provider 不支持工具调用时的兜底路径。

const STYLE_DIMENSION_SCHEMAS = [
  Type.Literal('scene_craft'),
  Type.Literal('character_craft'),
  Type.Literal('dialogue_craft'),
  Type.Literal('action_craft'),
  Type.Literal('emotion_craft'),
  Type.Literal('conflict_craft'),
  Type.Literal('narrative_craft')
] as const

const StyleDistillSubmitParams = Type.Object({
  name: Type.String({ description: '独立文风能力名称' }),
  description: Type.String({ description: '能力摘要' }),
  distilledPrompt: Type.String({ description: '可直接给 Writer/Reviewer/Reviser 使用的迁移提示词' }),
  exclusions: Type.Optional(Type.Array(Type.String(), { description: '不可迁移内容：人物/剧情/专名/世界观/原句' })),
  antiPatterns: Type.Optional(Type.Array(Type.String(), { description: '该文风明确避免的写法' })),
  boundaries: Type.Optional(Type.Array(Type.String(), { description: '这套能力覆盖不到的场景' })),
  expressionDna: Type.Optional(
    Type.Object({
      sentence: Type.Optional(Type.String()),
      lexicon: Type.Optional(Type.String()),
      rhythm: Type.Optional(Type.String()),
      humor: Type.Optional(Type.String()),
      certainty: Type.Optional(Type.String()),
      distance: Type.Optional(Type.String())
    })
  ),
  tensions: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({ description: '张力名称' }),
        between: Type.Array(Type.String(), { minItems: 2, maxItems: 2, description: '相互拉扯的两股力量' }),
        resolution: Type.String({ description: '取舍原则' })
      }),
      { maxItems: 5 }
    )
  ),
  techniques: Type.Array(
    Type.Object({
      dimension: Type.Union([...STYLE_DIMENSION_SCHEMAS]),
      name: Type.String(),
      mechanism: Type.String({ description: '机制在原文里如何运作' }),
      transfer: Type.String({ description: '如何迁移到新文本（可执行动作）' }),
      failureMode: Type.String({ description: '什么情况下失效或必须让位（必填）' }),
      evidence: Type.Array(
        Type.Object({ sectionId: Type.String(), quote: Type.String() }),
        { minItems: 1, description: '<=80 字原文短引用，不得编造' }
      ),
      metricAnchors: Type.Optional(Type.Array(Type.String())),
      validation: Type.Optional(
        Type.Object({
          crossDomain: Type.Number({ description: '跨域复现场景数（>=2 才算过）' }),
          generative: Type.Boolean({ description: '能否据此推断新场景写法' }),
          exclusive: Type.Boolean({ description: '是否具有排他性而非通用常识' })
        })
      ),
      confidence: Type.Union([
        Type.Literal('verified'),
        Type.Literal('unverified'),
        Type.Literal('rejected')
      ]),
      kept: Type.Boolean()
    }),
    { minItems: 1 }
  ),
  exemplarPassages: Type.Optional(
    Type.Array(
      Type.Object({
        sectionId: Type.String(),
        text: Type.String({ description: '不超过 500 字的连续原文' }),
        reason: Type.String()
      })
    )
  )
})

interface StyleSubmitDraftHolder {
  payload?: Record<string, unknown>
}

function createStyleDistillSubmitTool(draft: StyleSubmitDraftHolder): ToolDefinition<typeof StyleDistillSubmitParams> {
  return defineTool({
    name: 'submit_style_distill',
    label: '提交文风蒸馏结果',
    description:
      '提交从参考样本提炼的文风能力专家全量字段。必须调用本工具提交；不要在对话文本中输出 JSON。',
    parameters: StyleDistillSubmitParams,
    async execute(_toolCallId, params) {
      // 工具路径不要求模型编 id：按顺序自动补齐
      const record = params as unknown as Record<string, unknown>
      const techniques = Array.isArray(record.techniques)
        ? (record.techniques as Array<Record<string, unknown>>).map((technique, index) => ({
            ...technique,
            id: typeof technique.id === 'string' && technique.id ? technique.id : `t${index + 1}`
          }))
        : record.techniques
      draft.payload = { ...record, techniques }
      const count = Array.isArray(record.techniques) ? record.techniques.length : 0
      const verified = Array.isArray(record.techniques)
        ? (record.techniques as Array<{ confidence?: string }>).filter((t) => t.confidence === 'verified').length
        : 0
      return {
        content: [{ type: 'text', text: `已收到 ${count} 条手法（verified ${verified} 条），蒸馏结果已入库待审` }],
        details: undefined
      }
    }
  })
}

/** 容错解析蒸馏自由文本；失败返回 null 交给上层降级链，不直接抛错。 */
function tryParseDistillJsonObject(
  raw: string
): (Partial<StyleDistillDraft> & { prompt?: unknown }) | null {
  try {
    return parseJsonObject(raw, '文风手法分析') as Partial<StyleDistillDraft> & {
      prompt?: unknown
    }
  } catch {
    return null
  }
}

export async function distillStyleExpertFromReference(
  context: PluginContext,
  input: StyleDistillInput,
  modelId?: { provider: string; modelId: string },
  options: { allowLegacyOutput?: boolean; dimension?: StyleCraftDimension } = {}
): Promise<StyleDistillDraft> {
  if (input.sections.length === 0) throw new Error('参考样本不足，至少选择一个章节')
  if (input.text.trim().length < 80) throw new Error('参考样本不足，至少需要 80 字符')
  const dimensionFocus = options.dimension ? buildDimensionFocusPrompt(options.dimension) : ''
  const systemPrompt = dimensionFocus
    ? `${DISTILL_SYSTEM_PROMPT}\n\n${dimensionFocus}`
    : DISTILL_SYSTEM_PROMPT
  const sectionContext = input.sections
    .map((section) => `【sectionId=${section.id} title=${section.title ?? ''}】`)
    .join('\n')
  // 方案 D+A2 三模降级（与参考分析 runJsonCall 同一套策略）：
  // strict provider → json_schema 严格结构化输出；
  // 其余 → 提交工具为主路径；工具未命中时先容错解析自由文本，
  // 再不行去掉 tools 用 responseFormat='json'（json_object + tool_choice=none）重试一次。
  const schemaSupport = resolveJsonSchemaSupport({ provider: modelId?.provider })
  const useStrictSchema = schemaSupport === 'strict'
  const submitDraft: StyleSubmitDraftHolder = {}
  const submitTool = createStyleDistillSubmitTool(submitDraft)
  const sessionBase = {
    systemPrompt,
    userMessage: [
      '参考章节索引：',
      sectionContext,
      '本地统计仅作为辅助标注：',
      JSON.stringify(input.metrics),
      input.notes ? `用户补充：${input.notes}` : '',
      '参考小说样本（本地按章节分包后分层抽样，避免只分析开头）：',
      buildChunkedSectionAwareStyleSample(input.sections, input.sectionTexts, input.text)
    ]
      .filter(Boolean)
      .join('\n\n'),
    modelId,
    emit: () => undefined,
    emitRaw: false
  }
  const handle = await context.createAgUiSession({
    ...sessionBase,
    ...(useStrictSchema
      ? { responseJsonSchema: { name: 'style_distill', schema: StyleDistillSubmitParams as unknown as Record<string, unknown> } }
      : { tools: [submitTool] })
  })
  try {
    const result = await handle.session.prompt()
    let parsedRaw: (Partial<StyleDistillDraft> & { prompt?: unknown }) | null
    if (!useStrictSchema && submitDraft.payload) {
      parsedRaw = submitDraft.payload as Partial<StyleDistillDraft> & { prompt?: unknown }
    } else {
      // 容错解析自由文本：剥围栏 / 括号平衡提取 / 控制符转义 / 尾逗号修复，
      // 与分包抽取、全书汇总共用 parseJsonObject 的确定性层级
      const raw = typeof result === 'string' ? result : JSON.stringify(result)
      parsedRaw = tryParseDistillJsonObject(raw)
      if (!parsedRaw && !useStrictSchema) {
        // 工具未被调用且自由文本无 JSON：降级为 json_object 模式重试一次（去工具）
        const retryHandle = await context.createAgUiSession({
          ...sessionBase,
          tools: [],
          responseFormat: 'json'
        })
        const retryResult = await retryHandle.session.prompt()
        const retryRaw = typeof retryResult === 'string' ? retryResult : JSON.stringify(retryResult)
        parsedRaw = tryParseDistillJsonObject(retryRaw)
      }
    }
    if (!parsedRaw) {
      throw new Error(
        '模型既未调用提交工具，降级 json_object 重试也未产出合法 JSON。请更换支持工具调用的蒸馏模型后重试'
      )
    }
    const parsed = parsedRaw
    const distilledPrompt =
      typeof parsed.distilledPrompt === 'string'
        ? parsed.distilledPrompt
        : options.allowLegacyOutput && typeof parsed.prompt === 'string'
          ? parsed.prompt
          : undefined
    const parsedTechniques: unknown[] | undefined = Array.isArray(parsed.techniques)
      ? (parsed.techniques as unknown[])
      : options.allowLegacyOutput
        ? []
        : undefined
    if (
      !isNonEmptyString(parsed.name) ||
      !isNonEmptyString(parsed.description) ||
      !distilledPrompt ||
      !parsedTechniques
    )
      throw new Error('文风手法分析结果缺少必要字段')
    const validSectionIds = new Set(input.sections.map((section) => section.id))
    const metricKeys = flattenMetricKeys(input.metrics)
    const techniques = parsedTechniques
      .filter(
        (technique): technique is Record<string, unknown> =>
          isRecord(technique) &&
          STYLE_DIMENSIONS.has(technique.dimension as StyleCraftDimension) &&
          isNonEmptyString(technique.id) &&
          isNonEmptyString(technique.name) &&
          isNonEmptyString(technique.mechanism) &&
          isNonEmptyString(technique.transfer)
      )
      .map((technique): StyleTechniqueDraft => {
        const evidence = Array.isArray(technique.evidence)
          ? (technique.evidence.filter((item) => {
              if (
                !isRecord(item) ||
                !isNonEmptyString(item.sectionId) ||
                !isNonEmptyString(item.quote)
              )
                return false
              if (!validSectionIds.has(item.sectionId)) return false
              return evidenceQuoteExists(
                input.sectionTexts?.[item.sectionId] ?? input.text,
                item.quote
              )
            }) as Array<{ sectionId: string; quote: string }>)
          : []
        const metricAnchors = Array.isArray(technique.metricAnchors)
          ? technique.metricAnchors.filter(
              (anchor): anchor is string => typeof anchor === 'string' && metricKeys.has(anchor)
            )
          : []
        const evidenceValid = evidence.length > 0
        const metricsValid =
          !Array.isArray(technique.metricAnchors) ||
          technique.metricAnchors.length === 0 ||
          metricAnchors.length > 0
        const failureMode = isNonEmptyString(technique.failureMode)
          ? technique.failureMode
          : undefined
        const rawValidation = isRecord(technique.validation) ? technique.validation : undefined
        const validation = rawValidation
          ? {
              crossDomain:
                typeof rawValidation.crossDomain === 'number'
                  ? rawValidation.crossDomain
                  : undefined,
              generative:
                typeof rawValidation.generative === 'boolean'
                  ? rawValidation.generative
                  : undefined,
              exclusive:
                typeof rawValidation.exclusive === 'boolean' ? rawValidation.exclusive : undefined
            }
          : undefined
        // 三重验证是 verified 的硬门槛：跨域≥2、有生成力、有排他性；
        // 再加"必须写出失效条件"——没有失效条件的手法会被 Writer 无差别套用。
        const tripleValidated =
          (validation?.crossDomain ?? 0) >= 2 &&
          validation?.generative === true &&
          validation?.exclusive === true
        return {
          id: technique.id as string,
          dimension: technique.dimension as StyleCraftDimension,
          name: technique.name as string,
          mechanism: technique.mechanism as string,
          transfer: technique.transfer as string,
          failureMode,
          evidence,
          metricAnchors,
          validation,
          confidence:
            technique.confidence === 'verified' &&
            evidenceValid &&
            metricsValid &&
            tripleValidated &&
            !!failureMode
              ? 'verified'
              : 'unverified',
          kept: technique.kept === true && evidenceValid
        }
      })
    const exemplarPassages = (
      Array.isArray(parsed.exemplarPassages) ? parsed.exemplarPassages : []
    ).filter((passage) => {
      if (
        !isRecord(passage) ||
        !isNonEmptyString(passage.sectionId) ||
        !isNonEmptyString(passage.text) ||
        !isNonEmptyString(passage.reason)
      )
        return false
      if (!validSectionIds.has(passage.sectionId)) return false
      return evidenceQuoteExists(
        input.sectionTexts?.[passage.sectionId] ?? input.text,
        passage.text
      )
    }) as Array<{ sectionId: string; text: string; reason: string }>
    const exclusions = (Array.isArray(parsed.exclusions) ? parsed.exclusions : []).filter(
      (item): item is string => isNonEmptyString(item)
    )
    const antiPatterns = (Array.isArray(parsed.antiPatterns) ? parsed.antiPatterns : []).filter(
      (item): item is string => isNonEmptyString(item)
    )
    const boundaries = (Array.isArray(parsed.boundaries) ? parsed.boundaries : []).filter(
      (item): item is string => isNonEmptyString(item)
    )
    const expressionDna = isRecord(parsed.expressionDna)
      ? (Object.fromEntries(
          (['sentence', 'lexicon', 'rhythm', 'humor', 'certainty', 'distance'] as const)
            .map((key) => [key, (parsed.expressionDna as Record<string, unknown>)[key]])
            .filter(([, value]) => isNonEmptyString(value))
        ) as StyleExpressionDna)
      : undefined
    // 张力必须成对（between 两端）且给出取舍原则，否则等于没做取舍
    const tensions = (Array.isArray(parsed.tensions) ? parsed.tensions : [])
      .filter(
        (item: unknown) =>
          isRecord(item) &&
          isNonEmptyString(item.name) &&
          isNonEmptyString(item.resolution) &&
          Array.isArray(item.between) &&
          item.between.length === 2 &&
          item.between.every((side: unknown) => isNonEmptyString(side))
      )
      .map((item): StyleTension => {
        const record = item as unknown as Record<string, unknown>
        const between = record.between as string[]
        return {
          name: record.name as string,
          between: [between[0], between[1]],
          resolution: record.resolution as string
        }
      })
    // 维度聚焦蒸馏：即使提示已聚焦，模型仍可能夹带其他维度手法——按目标维度硬过滤。
    // 过滤后为空数组是合法结果（该参考小说在此维度无排他性手法），由上层决定跳过入库。
    const dimensionTechniques = options.dimension
      ? techniques.filter((technique) => technique.dimension === options.dimension)
      : techniques
    return {
      ...parsed,
      distilledPrompt,
      metrics: input.metrics,
      techniques: dimensionTechniques,
      exclusions,
      exemplarPassages,
      expressionDna,
      tensions,
      antiPatterns,
      boundaries,
      sourceTitle: input.sections[0]?.title ?? '参考小说样本'
    } as StyleDistillDraft
  } finally {
    handle.dispose()
  }
}

/** 旧粘贴样本接口的兼容适配；新功能应使用 reference source + sectionIds。 */
export async function distillStyleExpert(
  context: PluginContext,
  input: { sourceTitle: string; sourceAuthor?: string; sample: string; notes?: string },
  modelId?: { provider: string; modelId: string }
): Promise<{
  name: string
  sourceTitle: string
  sourceAuthor?: string
  description: string
  distilledPrompt: string
  enabled: boolean
}> {
  const draft = await distillStyleExpertFromReference(
    context,
    {
      sourceId: 'legacy-paste',
      sections: [
        {
          id: 'legacy-paste',
          sourceId: 'legacy-paste',
          type: 'chapter',
          order: 0,
          title: input.sourceTitle,
          start: 0,
          end: input.sample.length,
          characterCount: input.sample.length,
          estimatedTokens: 0,
          boundaryConfidence: 1,
          contentHash: '',
          included: true,
          version: 1,
          warnings: []
        }
      ],
      text: input.sample,
      sectionTexts: { 'legacy-paste': input.sample },
      metrics: {
        characterCount: input.sample.length,
        paragraphCount: 0,
        sentenceCount: 0,
        sentenceLength: {
          count: 0,
          min: 0,
          max: 0,
          average: 0,
          median: 0,
          p90: 0,
          buckets: { '1-10': 0, '11-20': 0, '21-40': 0, '41+': 0 }
        },
        paragraphLength: { count: 0, min: 0, max: 0, average: 0, median: 0, p90: 0 },
        dialogue: { charRatio: 0, paragraphRatio: 0 },
        metaphorDensity: 0,
        sensoryMix: { visual: 0, auditory: 0, olfactory: 0, tactile: 0, taste: 0, bodily: 0 },
        personSignal: { first: 0, third: 0 },
        narrativePerson: 'mixed',
        emotionalTemperature: 5,
        shortSentenceRatio: 0,
        longSentenceRatio: 0,
        trustworthy: false
      },
      notes: input.notes
    },
    modelId,
    { allowLegacyOutput: true }
  )
  return {
    name: draft.name,
    sourceTitle: input.sourceTitle,
    sourceAuthor: input.sourceAuthor,
    description: draft.description,
    distilledPrompt: draft.distilledPrompt,
    enabled: true
  }
}
