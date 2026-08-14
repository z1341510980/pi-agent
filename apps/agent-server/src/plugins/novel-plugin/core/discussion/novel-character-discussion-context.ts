import type { DiscussionMember } from './../../../../core/agent/discussion-types.js'
import type { NovelCharacter, ArrangedEntity } from '../types.js'
import type { NovelStore } from '../novel-store.js'
import type { NovelPromptBuilder, ChapterBoundaryContext } from '../prompting/prompt-builder.js'
import {
  ANSWER_MODE_LABELS,
  REGISTER_LABELS,
  SENTENCE_LENGTH_LABELS,
  type CharacterVoiceProfile,
} from '../entities/character-voice.js'
import { resolveChapterBoundaryEntity } from '../chapters/chapter-boundary-resolution.js'

export type CharacterKnowledge = NonNullable<DiscussionMember['knowledge']>

export function buildCharacterSystemPrompt(): string {
  return '你参与小说章节的角色推演。严格依据后续章节上下文和角色身份行动，不得自行改写世界设定。'
}

export function buildCharacterIdentityPrompt(input: {
  projectId: string
  character: NovelCharacter
  promptBuilder: NovelPromptBuilder
  mode: 'discussion' | 'free_chat'
  voiceProfile?: CharacterVoiceProfile
  hasBoundaryState?: boolean
}): string {
  const {
    projectId,
    character,
    promptBuilder,
    mode,
    voiceProfile,
    hasBoundaryState = true,
  } = input
  const lines: string[] = [
    mode === 'discussion'
      ? `你是小说中的角色「${character.name}」，以第一人称视角参与群聊共创。`
      : `你是小说中的角色「${character.name}」，以第一人称视角与用户讨论当前章节。`,
    '',
    '## 你的设定',
  ]
  if (character.identity) lines.push(`- 身份：${character.identity}`)
  if (character.personality) lines.push(`- 性格：${character.personality}`)
  if (hasBoundaryState && character.currentState) lines.push(`- 当前状态：${character.currentState}`)
  if (hasBoundaryState && character.currentGoal) lines.push(`- 当前目标：${character.currentGoal}`)
  if (hasBoundaryState && character.secret) lines.push(`- 隐藏秘密：${character.secret}`)
  if (hasBoundaryState && character.arcStage) lines.push(`- 角色弧光阶段：${character.arcStage}`)
  if (character.speechStyle?.trim()) {
    lines.push(`- 说话风格（台词必须严格符合此风格，包括长短句、用词、口头禅和语气词）：${character.speechStyle}`)
  }
  if (voiceProfile) {
    lines.push(
      '- 你的说话参数：',
      `  · 句长：${SENTENCE_LENGTH_LABELS[voiceProfile.sentenceLength]}`,
      `  · 语域：${REGISTER_LABELS[voiceProfile.register]}`,
      `  · 被追问时：${ANSWER_MODE_LABELS[voiceProfile.answerMode]}`,
    )
    if (voiceProfile.tics.length > 0) {
      lines.push(`  · 口头禅：${voiceProfile.tics.join('、')}（自然出现，不要每句都挂）`)
    }
    if (voiceProfile.banned.length > 0) {
      lines.push(`  · 你不会用这些词：${voiceProfile.banned.join('、')}`)
    }
  }

  lines.push('')
  if (mode === 'discussion') {
    lines.push(promptBuilder.buildAgentIdentity(projectId, 'character-actor', true))
  } else {
    lines.push(
      '## 对话要求',
      '- 只依据你的角色卡、可见背景和已经听到的内容回答，不得采用作者全知视角',
      '- 以角色口吻直接回应用户，保持性格、目标和说话参数一致',
      '- 可以拒答角色不知道或不愿透露的信息，不要为了配合用户而编造设定',
      '- 回答简洁、聚焦，不写小说正文，不替其他角色发言',
      '- 绝不使用破折号"——"，转折用句号，补充用逗号，列举用顿号',
    )
  }
  return lines.join('\n')
}

export function collectCharacterKnowledge(
  store: NovelStore,
  projectId: string,
  character: NovelCharacter,
  boundary?: ChapterBoundaryContext,
): CharacterKnowledge | undefined {
  const knowledge: CharacterKnowledge = {}
  const layers = boundary?.entities.informationLayers ?? store.listInformationLayers(projectId)
  for (const layer of layers) {
    try {
      const map = JSON.parse(layer.characterKnowledge) as Record<string, CharacterKnowledge[string]>
      const state = map[character.id]
      if (state) knowledge[layer.id] = state
    } catch {
      // 损坏的旧数据不得让角色获得作者真相，也不得参与错误的合并判定。
      return undefined
    }
  }
  return knowledge
}

export function buildCharacterVisibleContext(input: {
  store: NovelStore
  projectId: string
  chapterNumber: number
  character?: NovelCharacter
  arrangedEntities?: ArrangedEntity
  boundary?: ChapterBoundaryContext
  includeCharacterConflictsWhenUnarranged?: boolean
}): string {
  const {
    store,
    projectId,
    chapterNumber,
    character,
    arrangedEntities,
    boundary,
    includeCharacterConflictsWhenUnarranged = false,
  } = input
  const chapter = store.getChapter(projectId, chapterNumber)
  const previous = chapterNumber > 1 ? store.getChapter(projectId, chapterNumber - 1) : undefined
  const previousTail = previous?.content?.trim().slice(-900) ?? ''
  const lines = [
    '## 本回合可见背景',
    `- 当前章节：第 ${chapterNumber} 章`,
    `- 本章任务：${chapter?.outline?.trim() || chapter?.narrativeTask?.trim() || '由当前场景推动'}`,
  ]
  if (chapter?.positioning) lines.push(`- 章节定位：${chapter.positioning}`)
  if (previousTail) {
    // 自然语言提醒不能形成信息隔离。只有 V2 Scene Cast 明确表明该角色出现在
    // 上一章最后场景时，才允许把结尾原文交给角色；旧章、临时角色或未建模场景
    // 一律不注入，避免角色从作者正文旁路获知 information layer 未授权的秘密。
    const currentPlan = previous ? store.getCurrentPlan(previous.id) : undefined
    const lastScene = currentPlan
      ? store.listSceneRevisionsByPlan(currentPlan.id)
          .slice()
          .sort((left, right) => right.order - left.order)[0]
      : undefined
    const cast = lastScene ? store.getSceneRevisionCast(lastScene.id) : undefined
    const visibleCharacterIds = new Set([
      ...(cast?.focus ?? []),
      ...(cast?.present ?? []),
      ...(cast?.functions.map(entry => entry.characterId) ?? []),
    ])
    if (character && visibleCharacterIds.has(character.id)) {
      lines.push(`\n### 上一章结尾（你的亲历场景）\n${previousTail}`)
    } else {
      lines.push('\n- 上一章存在你未被确认亲历的进展；不得根据上一章结尾原文行动。')
    }
  }

  const conflicts = new Map((boundary?.entities.conflicts ?? []).map(conflict => [conflict.id, conflict]))
  const locations = new Map((boundary?.entities.locations ?? []).map(location => [location.id, location]))
  const conflictIds = arrangedEntities?.conflictIds
    ?? (includeCharacterConflictsWhenUnarranged ? [...conflicts.keys()] : [])
  const conflictLines = conflictIds
    .map(id => resolveChapterBoundaryEntity(
      id,
      conflicts,
      entityId => store.getConflict(entityId),
      boundary?.fromSnapshot ?? false,
    ))
    .filter(resolved => resolved && (
      !character
      || !resolved.hasBoundaryState
      || parseIdList(resolved.entity.participants).includes(character.id)
    ))
    .slice(0, 3)
    .map((resolved) => {
      const conflict = resolved!.entity
      return resolved!.hasBoundaryState
        ? `- ${conflict.description}；当前阶段：${conflict.stage}；代价：${conflict.stakes || '未明'}`
        : `- ${conflict.description}；章前动态状态未知`
    })
  if (conflictLines.length > 0) lines.push(`\n### 你正身处的冲突\n${conflictLines.join('\n')}`)

  const locationLines = (arrangedEntities?.locationIds ?? [])
    .map(id => resolveChapterBoundaryEntity(
      id,
      locations,
      entityId => store.getLocation(entityId),
      boundary?.fromSnapshot ?? false,
    ))
    .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null)
    .slice(0, 3)
    .map(({ entity: location }) => `- ${location.name}：${location.description.slice(0, 180)}`)
  if (locationLines.length > 0) lines.push(`\n### 当前可能出现的地点\n${locationLines.join('\n')}`)

  if (character) {
    const visibleKnowledge: string[] = []
    const knowledge = collectCharacterKnowledge(store, projectId, character, boundary) ?? {}
    const layers = boundary?.entities.informationLayers ?? store.listInformationLayers(projectId)
    for (const layer of layers) {
      const state = knowledge[layer.id]
      if (!state) continue
      if (state.knows) visibleKnowledge.push(`- 你知道：${layer.infoDescription}`)
      else if (state.suspects) visibleKnowledge.push(`- 你有所怀疑：${layer.infoDescription}`)
      else if (state.misunderstands) visibleKnowledge.push(`- 你目前相信：${state.misunderstands}`)
    }
    if (visibleKnowledge.length > 0) {
      lines.push(`\n### 你的认知边界\n${visibleKnowledge.slice(0, 8).join('\n')}`)
    }
  }
  lines.push('\n只依据以上内容、角色卡、当前场景和已经听到的台词行动。未出现的信息视为不知道。')
  return lines.join('\n')
}

function parseIdList(raw: string): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}
