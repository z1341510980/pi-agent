import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ChapterOutlineContinuityRisk, ChapterOutlineDraft } from '@repo/shared/novel'

const outlineRiskSchema = z.object({
  type: z.enum(['continuity', 'unknown_entity', 'timeline', 'requires_confirmation']),
  severity: z.enum(['low', 'medium', 'high']),
  description: z.string().trim().min(1).max(1000)
})

const characterIdSchema = z.string().trim().min(1).max(200)
const rawPovSuggestionSchema = z.discriminatedUnion('mode', [
  z.object({ characterId: characterIdSchema, mode: z.literal('single') }),
  z.object({ characterId: characterIdSchema.nullish(), mode: z.literal('omniscient') }),
  z.object({ characterId: characterIdSchema.nullish(), mode: z.literal('none') })
])

const rawChapterOutlineDraftSchema = z.object({
  // 协议版本只是标签：在 parseChapterOutlineDraft 入口处归一化，
  // 不在此处用 z.literal 一票否决——模型偶发输出 "1"（字符串）或自增版本号
  // 不影响其余字段的协议符合性，却会让整次章纲调用作废。
  version: z.number().int().positive(),
  outlineText: z.string().trim().min(20).max(20000),
  chapterGoal: z.string().trim().min(1).max(2000),
  openingState: z.string().trim().min(1).max(2000),
  progression: z.array(z.string().trim().min(1).max(2000)).min(1).max(12),
  // 空即合法的数组字段统一 default([])：模型省略键时不再让整次章纲作废
  obstacles: z.array(z.string().trim().min(1).max(2000)).max(8).default([]),
  turningPoint: z.string().trim().min(1).max(2000),
  endingState: z.string().trim().min(1).max(2000),
  hook: z.string().trim().min(1).max(2000),
  sceneCountEstimate: z.number().int().min(1).max(20),
  povSuggestions: z.array(rawPovSuggestionSchema).max(4).default([]),
  storylines: z
    .array(
      z.object({
        storylineId: z.string().trim().min(1).max(200),
        intendedProgress: z.string().trim().min(1).max(2000)
      })
    )
    .max(12)
    .default([]),
  continuityRisks: z.array(outlineRiskSchema).max(20).default([])
})

export interface ChapterOutlineReferenceNames {
  characters: ReadonlyMap<string, string>
  storylines: ReadonlyMap<string, string>
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced) return fenced[1].trim()

  const unclosedFence = trimmed.match(/```(?:json)?\s*([\s\S]*)/i)
  return unclosedFence ? unclosedFence[1].trim() : trimmed
}

function extractJsonObjects(text: string): string[] {
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
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
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char !== '}' || depth === 0) continue
    depth -= 1
    if (depth === 0 && start >= 0) {
      objects.push(text.slice(start, index + 1))
      start = -1
    }
  }

  return objects
}

function parseJsonResponse(text: string): unknown {
  const stripped = stripJsonFence(text)
  const candidates = [stripped, ...extractJsonObjects(stripped)]
  let cause: unknown

  for (const candidate of new Set(candidates)) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch (err) {
      cause = err
    }
  }

  throw new Error('章纲模型返回的 JSON 无法解析', { cause })
}

function appendUniqueRisk(
  risks: ChapterOutlineContinuityRisk[],
  risk: ChapterOutlineContinuityRisk
): void {
  if (risks.some((item) => item.type === risk.type && item.description === risk.description)) return
  risks.push(risk)
}

/**
 * 协议字段的常见漂移别名（模型偶发用中文键或近义键）。
 * 只在规范键缺失时补位，绝不覆盖模型已给出的值。
 */
const OUTLINE_KEY_ALIASES: Record<string, string> = {
  正文: 'outlineText',
  章纲内容: 'outlineText',
  内容: 'outlineText',
  章节目标: 'chapterGoal',
  本章目标: 'chapterGoal',
  目标: 'chapterGoal',
  开场状态: 'openingState',
  开场: 'openingState',
  推进: 'progression',
  情节推进: 'progression',
  步骤: 'progression',
  障碍: 'obstacles',
  转折点: 'turningPoint',
  转折: 'turningPoint',
  结尾状态: 'endingState',
  结尾: 'endingState',
  章末钩子: 'hook',
  钩子: 'hook',
  场景数: 'sceneCountEstimate',
  场景数量: 'sceneCountEstimate',
  POV建议: 'povSuggestions',
  视角建议: 'povSuggestions',
  故事线: 'storylines',
  连续性风险: 'continuityRisks',
  风险: 'continuityRisks'
}

/** 判定一个对象是否"长得像章纲草稿"：命中签名键（规范键或其漂移别名）的数量 */
const DRAFT_SIGNATURE_KEYS = new Set([
  'outlineText',
  'chapterGoal',
  'progression',
  'turningPoint',
  'endingState',
  'hook',
  ...Object.keys(OUTLINE_KEY_ALIASES)
])

function countDraftSignatureKeys(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const record = value as Record<string, unknown>
  let hits = 0
  for (const key of Object.keys(record)) {
    if (DRAFT_SIGNATURE_KEYS.has(key)) hits += 1
  }
  return hits
}

/**
 * 结构漂移归一：
 * 1. 单键包装剥离（{"data":{…}} / {"result":{…}} / {"章纲":{…}}）；
 * 2. 若顶层缺少签名键，做有界深度优先搜索定位最像章纲草稿的嵌套对象；
 * 3. 中文/近义键按别名表补位到规范键（不覆盖已有值）；
 * 4. 基元类型轻度矫正：schema 期望 string 的字段收到 number/boolean 时转字符串。
 */
function normalizeDraftContainer(input: unknown): unknown {
  let node: unknown = input

  // 1) 单键包装逐层剥离（最多 3 层，防止病态嵌套）
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      node &&
      typeof node === 'object' &&
      !Array.isArray(node) &&
      Object.keys(node as Record<string, unknown>).length === 1
    ) {
      const [onlyKey, onlyValue] = Object.entries(node as Record<string, unknown>)[0]
      if (onlyValue && typeof onlyValue === 'object') {
        node = onlyValue
        void onlyKey
        continue
      }
    }
    break
  }

  // 2) 顶层缺签名键时，广度优先找最像草稿的嵌套对象（深度 ≤ 3）
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  if (isRecord(node) && countDraftSignatureKeys(node) === 0) {
    const queue: Array<{ value: unknown; depth: number }> = Object.values(node).map((value) => ({
      value,
      depth: 1
    }))
    let best: Record<string, unknown> | null = null
    let bestScore = 0
    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.depth > 3) continue
      if (isRecord(current.value)) {
        const score = countDraftSignatureKeys(current.value)
        if (score > bestScore) {
          bestScore = score
          best = current.value
        }
        for (const child of Object.values(current.value)) queue.push({ value: child, depth: current.depth + 1 })
      }
    }
    if (best && bestScore >= 2) node = best
  }

  if (!isRecord(node)) return node

  // 3) 别名补位
  const record = node as Record<string, unknown>
  for (const [alias, canonical] of Object.entries(OUTLINE_KEY_ALIASES)) {
    if (canonical in record) continue
    if (alias in record) record[canonical] = record[alias]
  }

  // 4) 基元矫正：期望 string 的标量字段被数字/布尔填充时转字符串
  const stringFields = [
    'outlineText', 'chapterGoal', 'openingState', 'turningPoint', 'endingState', 'hook'
  ] as const
  for (const field of stringFields) {
    const value = record[field]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      record[field] = String(value)
    }
  }
  if (typeof record.sceneCountEstimate === 'string') {
    const parsedCount = Number.parseInt(record.sceneCountEstimate, 10)
    if (Number.isFinite(parsedCount)) record.sceneCountEstimate = parsedCount
  }
  return record
}

/** 严格解析 LLM JSON，并把实体 ID 映射为可信的展示名称。 */
export function parseChapterOutlineDraft(
  text: string,
  references: ChapterOutlineReferenceNames
): ChapterOutlineDraft {
  const json = parseJsonResponse(text)

  // 结构漂移归一先执行：剥包装 / 别名补位 / 基元矫正；
  // 随后再做协议版本归一化（内层的 "1"/自增值也会随对象一起被归一）。
  let normalized = normalizeDraftContainer(json)
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const record = normalized as Record<string, unknown>
    if (!('version' in record) || record.version === undefined || record.version === null) {
      record.version = 1
    } else {
      const numeric =
        typeof record.version === 'number'
          ? record.version
          : Number.parseInt(String(record.version), 10)
      if (Number.isFinite(numeric) && numeric > 0) record.version = 1
    }
  }

  const parsed = rawChapterOutlineDraftSchema.safeParse(normalized)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || 'root'
    throw new Error(`章纲模型返回不符合协议：${path} ${issue?.message ?? '字段无效'}`)
  }

  return resolveDraftReferences(parsed.data, references)
}

/** POV/故事线 ID 解析 + 风险合并 + 版本钉回（文本解析与工具提交共用） */
function resolveDraftReferences(
  data: z.infer<typeof rawChapterOutlineDraftSchema>,
  references: ChapterOutlineReferenceNames
): ChapterOutlineDraft {
  const risks: ChapterOutlineContinuityRisk[] = [...data.continuityRisks]
  const povSuggestions: ChapterOutlineDraft['povSuggestions'] = data.povSuggestions.flatMap<
    ChapterOutlineDraft['povSuggestions'][number]
  >(
    (suggestion) => {
    if (suggestion.mode !== 'single') {
      return [{ mode: suggestion.mode, characterId: null, characterName: null }]
    }
    const characterName = references.characters.get(suggestion.characterId)
    if (!characterName) {
      appendUniqueRisk(risks, {
        type: 'unknown_entity',
        severity: 'high',
        description: `模型引用了不存在的 POV 角色：${suggestion.characterId}`
      })
      return []
    }
    return [{ mode: suggestion.mode, characterId: suggestion.characterId, characterName }]
  })
  const storylines = data.storylines.flatMap((suggestion) => {
    const storylineName = references.storylines.get(suggestion.storylineId)
    if (!storylineName) {
      appendUniqueRisk(risks, {
        type: 'unknown_entity',
        severity: 'high',
        description: `模型引用了不存在的故事线：${suggestion.storylineId}`
      })
      return []
    }
    return [{ ...suggestion, storylineName }]
  })

  return {
    ...data,
    // 归一化后协议版本恒为当前版本；显式钉回字面量以匹配 ChapterOutlineDraft 契约
    version: 1 as const,
    povSuggestions,
    storylines,
    continuityRisks: risks.slice(0, 20)
  }
}

// ── 结构化提交工具（方案 D）─────────────────────────────────────────
//
// 章纲生成此前依赖"模型自觉输出符合协议的 JSON 文本"——version 标签、元信息
// 包装、povSuggestions 字符串数组等漂移反复打穿校验。改为闭包捕获式提交工具：
// 参数结构由 provider 约束、SDK 校验，文本解析降级为兜底路径。

export interface ChapterOutlineSubmitDraftHolder {
  payload?: Record<string, unknown>
}

const ChapterOutlineSubmitParams = Type.Object({
  version: Type.Optional(Type.Number({ description: '协议版本，可省略（当前为 1）' })),
  outlineText: Type.String({ description: '完整章纲正文（>=20 字）' }),
  chapterGoal: Type.String({ description: '本章目标' }),
  openingState: Type.String({ description: '开场状态' }),
  progression: Type.Array(Type.String(), { minItems: 1, maxItems: 12, description: '推进步骤' }),
  obstacles: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: '障碍' })),
  turningPoint: Type.String({ description: '转折点' }),
  endingState: Type.String({ description: '结尾状态' }),
  hook: Type.String({ description: '章末钩子' }),
  sceneCountEstimate: Type.Integer({ minimum: 1, maximum: 20, description: '场景数估算' }),
  povSuggestions: Type.Array(
    Type.Object({
      characterId: Type.Optional(Type.String({ description: 'mode=single 时必填的章节角色 ID' })),
      mode: Type.Union([
        Type.Literal('single'),
        Type.Literal('omniscient'),
        Type.Literal('none')
      ])
    }),
    { maxItems: 4 }
  ),
  storylines: Type.Array(
    Type.Object({
      storylineId: Type.String(),
      intendedProgress: Type.String()
    }),
    { maxItems: 12 }
  ),
  continuityRisks: Type.Array(
    Type.Object({
      type: Type.Union([
        Type.Literal('continuity'),
        Type.Literal('unknown_entity'),
        Type.Literal('timeline'),
        Type.Literal('requires_confirmation')
      ]),
      severity: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
      description: Type.String()
    }),
    { maxItems: 20 }
  )
})

export function createChapterOutlineSubmitTool(
  draft: ChapterOutlineSubmitDraftHolder
): ToolDefinition<typeof ChapterOutlineSubmitParams> {
  return defineTool({
    name: 'submit_chapter_outline',
    label: '提交本章章纲',
    description:
      '把本章章纲以结构化对象提交。必须调用本工具提交结果；' +
      '不要在对话文本中输出 JSON 或 Markdown 围栏。',
    parameters: ChapterOutlineSubmitParams,
    async execute(_toolCallId, params) {
      draft.payload = params as unknown as Record<string, unknown>
      // 防御式摘要：SDK 校验正常时字段齐备，直连调用（测试/宽松 provider）缺字段也不崩
      const outlineLength = typeof params.outlineText === 'string' ? params.outlineText.length : 0
      const progressionCount = params.progression?.length ?? 0
      return {
        content: [{
          type: 'text',
          text: `章纲已提交（正文 ${outlineLength} 字，推进 ${progressionCount} 步）`
        }],
        details: undefined
      }
    }
  })
}

/**
 * 工具提交路径：把捕获的结构化 payload 装配成章纲草稿。
 * 与文本解析共用 schema 校验与 ID→名称解析。
 */
export function buildChapterOutlineDraftFromSubmit(
  payload: Record<string, unknown>,
  references: ChapterOutlineReferenceNames
): ChapterOutlineDraft {
  const normalized = { ...(payload as Record<string, unknown>) }
  if (!('version' in normalized) || normalized.version === undefined || normalized.version === null) {
    normalized.version = 1
  } else {
    const numeric =
      typeof normalized.version === 'number'
        ? normalized.version
        : Number.parseInt(String(normalized.version), 10)
    if (Number.isFinite(numeric) && numeric > 0) normalized.version = 1
  }

  const parsed = rawChapterOutlineDraftSchema.safeParse(normalized)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || 'root'
    throw new Error(`章纲提交参数不符合协议：${path} ${issue?.message ?? '字段无效'}`)
  }
  return resolveDraftReferences(parsed.data, references)
}

export function hashChapterOutline(outline: string | null | undefined): string {
  return createHash('sha256')
    .update(outline ?? '', 'utf8')
    .digest('hex')
}

export function hashChapterOutlineContext(context: unknown): string {
  return createHash('sha256').update(JSON.stringify(context), 'utf8').digest('hex')
}
