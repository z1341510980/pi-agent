import type { ArrangedEntity } from '../core/types.js'
import type { NovelStore } from '../core/novel-store.js'

/**
 * AI 编排审核时展示的只读实体摘要。
 *
 * 这里不直接把内部实体对象透传给前端：审核卡片只需要让用户确认
 * “哪些实体会进入本章，以及本章使用它们的什么约束”，不应暴露时间戳、
 * 项目归属等存储细节。
 */
export interface ArrangeReviewDetails {
  characters: Array<{
    id: string
    name: string
    description: string
    plotFunction?: string
    functionNote?: string
    currentState?: string
    currentGoal?: string
  }>
  conflicts: Array<{
    id: string
    description: string
    type: string
    intensity: number
    stage: string
    tier: string
    stakes?: string | null
    plotFunction?: string
    progressionMode?: string
    climaxChapter?: number | null
    climaxType?: string | null
  }>
  foreshadows: Array<{
    id: string
    description: string
    category: string
    status: string
    chapterAction?: string
    beatNote?: string
    recoverByChapter?: number | null
    plantMethod?: string
    recoverMethod?: string
  }>
  clues: Array<{
    id: string
    description: string
    pointsTo: string
    progress: number
    currentStep: string
    nextStep: string
    isMisleading: boolean
  }>
  factions: Array<{
    id: string
    name: string
    description: string
    type: string
    ideology: string
    strength: string
    status: string
  }>
  locations: Array<{
    id: string
    name: string
    description: string
    type: string
    significance: string
    status: string
  }>
  items: Array<{
    id: string
    name: string
    description: string
    type: string
    abilities: string
    origin: string
    status: string
    ownerId: string | null
  }>
  narratives: Array<{
    id: string
    description: string
    type: string
    status: string
  }>
}

/** 从当前项目的实体快照构造审核展示 DTO。 */
export function buildArrangeReviewDetails(
  store: NovelStore,
  arranged: ArrangedEntity,
  chapterNumber: number
): ArrangeReviewDetails {
  const characterFunctions = new Map(
    (arranged.characterFunctions ?? []).map((entry) => [entry.characterId, entry])
  )
  // 兼容路由单测/第三方注入的精简 Store；正式实现始终提供这些读方法。
  const safeGet = <T>(
    method: ((id: string) => T | undefined) | undefined
  ): ((id: string) => T | undefined) => {
    if (typeof method !== 'function') return () => undefined
    return method.bind(store)
  }
  const getCharacter = safeGet(store.getCharacter)
  const getConflict = safeGet(store.getConflict)
  const getForeshadow = safeGet(store.getForeshadow)
  const getClue = safeGet(store.getClue)
  const getFaction = safeGet(store.getFaction)
  const getLocation = safeGet(store.getLocation)
  const getItem = safeGet(store.getItem)
  const getNarrative = safeGet(store.getNarrative)

  return {
    characters: arranged.characterIds.flatMap((id) => {
      const entity = getCharacter(id)
      if (!entity) return []
      const fn = characterFunctions.get(id)
      return [
        {
          id: entity.id,
          name: entity.name,
          description: entity.description,
          ...(fn?.function ? { plotFunction: fn.function } : {}),
          ...(fn?.note ? { functionNote: fn.note } : {}),
          ...(entity.currentState ? { currentState: entity.currentState } : {}),
          ...(entity.currentGoal ? { currentGoal: entity.currentGoal } : {})
        }
      ]
    }),
    conflicts: arranged.conflictIds.flatMap((id) => {
      const entity = getConflict(id)
      if (!entity) return []
      return [
        {
          id: entity.id,
          description: entity.description,
          type: entity.type,
          intensity: entity.intensity,
          stage: entity.stage,
          tier: entity.tier,
          ...(entity.stakes ? { stakes: entity.stakes } : {}),
          ...(entity.plotFunction ? { plotFunction: entity.plotFunction } : {}),
          ...(entity.progressionMode ? { progressionMode: entity.progressionMode } : {}),
          ...(entity.climaxChapter != null ? { climaxChapter: entity.climaxChapter } : {}),
          ...(entity.climaxType ? { climaxType: entity.climaxType } : {})
        }
      ]
    }),
    foreshadows: arranged.foreshadowIds.flatMap((id) => {
      const entity = getForeshadow(id)
      if (!entity) return []
      const beat = entity.beats?.find((item) => item.chapter === chapterNumber)
      return [
        {
          id: entity.id,
          description: entity.description,
          category: entity.category,
          status: entity.status,
          ...(beat?.type ? { chapterAction: beat.type } : {}),
          ...(beat?.note ? { beatNote: beat.note } : {}),
          ...(entity.recoverByChapter != null ? { recoverByChapter: entity.recoverByChapter } : {}),
          ...(entity.plantMethod ? { plantMethod: entity.plantMethod } : {}),
          ...(entity.recoverMethod ? { recoverMethod: entity.recoverMethod } : {})
        }
      ]
    }),
    clues: (arranged.clueIds ?? []).flatMap((id) => {
      const entity = getClue(id)
      if (!entity) return []
      return [
        {
          id: entity.id,
          description: entity.description,
          pointsTo: entity.pointsTo,
          progress: entity.progress,
          currentStep: entity.currentStep,
          nextStep: entity.nextStep,
          isMisleading: entity.isMisleading
        }
      ]
    }),
    factions: arranged.factionIds.flatMap((id) => {
      const entity = getFaction(id)
      if (!entity) return []
      return [
        {
          id: entity.id,
          name: entity.name,
          description: entity.description,
          type: entity.type,
          ideology: entity.ideology,
          strength: entity.strength,
          status: entity.status
        }
      ]
    }),
    locations: arranged.locationIds.flatMap((id) => {
      const entity = getLocation(id)
      if (!entity) return []
      return [
        {
          id: entity.id,
          name: entity.name,
          description: entity.description,
          type: entity.type,
          significance: entity.significance,
          status: entity.status
        }
      ]
    }),
    items: (arranged.itemIds ?? []).flatMap((id) => {
      const entity = getItem(id)
      if (!entity) return []
      return [
        {
          id: entity.id,
          name: entity.name,
          description: entity.description,
          type: entity.type,
          abilities: entity.abilities,
          origin: entity.origin,
          status: entity.status,
          ownerId: entity.ownerId
        }
      ]
    }),
    narratives: (arranged.narrativeIds ?? []).flatMap((id) => {
      const entity = getNarrative(id)
      if (!entity) return []
      return [
        {
          id: entity.id,
          description: entity.description,
          type: entity.type,
          status: entity.status
        }
      ]
    })
  }
}
