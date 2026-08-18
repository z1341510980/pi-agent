import { createHash } from 'node:crypto'
import { z } from 'zod'
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
  version: z.literal(1),
  outlineText: z.string().trim().min(20).max(20000),
  chapterGoal: z.string().trim().min(1).max(2000),
  openingState: z.string().trim().min(1).max(2000),
  progression: z.array(z.string().trim().min(1).max(2000)).min(1).max(12),
  obstacles: z.array(z.string().trim().min(1).max(2000)).max(8),
  turningPoint: z.string().trim().min(1).max(2000),
  endingState: z.string().trim().min(1).max(2000),
  hook: z.string().trim().min(1).max(2000),
  sceneCountEstimate: z.number().int().min(1).max(20),
  povSuggestions: z.array(rawPovSuggestionSchema).max(4),
  storylines: z
    .array(
      z.object({
        storylineId: z.string().trim().min(1).max(200),
        intendedProgress: z.string().trim().min(1).max(2000)
      })
    )
    .max(12),
  continuityRisks: z.array(outlineRiskSchema).max(20)
})

export interface ChapterOutlineReferenceNames {
  characters: ReadonlyMap<string, string>
  storylines: ReadonlyMap<string, string>
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

function appendUniqueRisk(
  risks: ChapterOutlineContinuityRisk[],
  risk: ChapterOutlineContinuityRisk
): void {
  if (risks.some((item) => item.type === risk.type && item.description === risk.description)) return
  risks.push(risk)
}

/** 严格解析 LLM JSON，并把实体 ID 映射为可信的展示名称。 */
export function parseChapterOutlineDraft(
  text: string,
  references: ChapterOutlineReferenceNames
): ChapterOutlineDraft {
  let json: unknown
  try {
    json = JSON.parse(stripJsonFence(text))
  } catch (err) {
    throw new Error('章纲模型返回的 JSON 无法解析', { cause: err })
  }

  const parsed = rawChapterOutlineDraftSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || 'root'
    throw new Error(`章纲模型返回不符合协议：${path} ${issue?.message ?? '字段无效'}`)
  }

  const risks: ChapterOutlineContinuityRisk[] = [...parsed.data.continuityRisks]
  const povSuggestions: ChapterOutlineDraft['povSuggestions'] = parsed.data.povSuggestions.flatMap<
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
  const storylines = parsed.data.storylines.flatMap((suggestion) => {
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
    ...parsed.data,
    povSuggestions,
    storylines,
    continuityRisks: risks.slice(0, 20)
  }
}

export function hashChapterOutline(outline: string | null | undefined): string {
  return createHash('sha256')
    .update(outline ?? '', 'utf8')
    .digest('hex')
}

export function hashChapterOutlineContext(context: unknown): string {
  return createHash('sha256').update(JSON.stringify(context), 'utf8').digest('hex')
}
