/**
 * ChapterScenePlanAdapter：从现有规划产物派生 V2 场景计划（T03 影子写）。
 *
 * 迁移期（§10 第 1 步：建表与影子写）把两条旧规划路径映射为统一 ChapterScenePlan，
 * 落库后不改变任何生成行为，只让 V2 存储拿到可对账的影子数据：
 * - 普通工作流：Director 的 NarrativeTask（章节级）→ 按 sceneCount 拆场；
 * - 群聊：SceneDefinition[] → 逐场映射。
 *
 * 映射原则（与已确认决策一致）：
 * - 无法确定单 POV 的章节/场景 → povMode='omniscient'（povCharacterId=null），
 *   绝不从角色名瞎猜 POV id；单 POV 且能解析到角色 id 时才用 'single'。
 * - functional cast 无信息 → 空数组（不伪造功能位）。
 * - 场景字数均分 resolvedTarget，余数给最后一场（文档 §5 校验规则）。
 */
import type { NarrativeTask, ArrangedEntity } from './types.js'
import type { SceneDefinition } from '../../../core/agent/discussion-types.js'
import type { ChapterScenePlan, ChapterScenePlanScene } from './chapter-scene-plan.js'
import type { ChapterPlanRevision } from './types.js'

/** 场景计划预算（与 scene-plan-store 的 PlanBudget 同构） */
export type PlanBudget = ChapterPlanRevision['budget']

export interface NarrativeTaskPlanInput {
  planRevisionId: string
  chapterId: string
  projectId: string
  task: NarrativeTask
  budget: PlanBudget
  baseContentRevisionId?: string | null
  /** 角色名 → 角色 id 的解析表（来自 arrangedEntities / 档案） */
  characterIdByName?: ReadonlyMap<string, string>
  arrangedEntities?: ArrangedEntity
}

export interface SceneDefinitionsPlanInput {
  planRevisionId: string
  chapterId: string
  projectId: string
  sceneDefinitions: SceneDefinition[]
  budget: PlanBudget
  baseContentRevisionId?: string | null
}

/** 拆 N 份字数，余数给最后一份 */
export function splitTargetWords(total: number, count: number): number[] {
  if (count <= 0) return [total]
  const base = Math.floor(total / count)
  const remainder = total - base * count
  return Array.from({ length: count }, (_, i) => base + (i === count - 1 ? remainder : 0))
}

/**
 * NarrativeTask（章节级）→ ChapterScenePlan。
 * - 场景数：task.sceneCount ?? 1（Director 已限 1-5）
 * - POV：恰好 1 个且能解析为角色 id → single；否则 omniscient（不猜）
 * - focus/present：arrangedEntities.characterIds（有编排时），否则 []
 * - 每场 goal 复用任务描述（影子写不臆造逐场目标）
 */
export function buildScenePlanFromNarrativeTask(input: NarrativeTaskPlanInput): ChapterScenePlan {
  const { task, budget } = input
  const sceneCount = Math.min(Math.max(task.sceneCount ?? 1, 1), 5)
  const splits = splitTargetWords(budget.resolvedTarget, sceneCount)

  const singlePovId = resolveSinglePovCharacterId(task, input.characterIdByName)
  const arrangedIds = input.arrangedEntities?.characterIds ?? []
  const presentIds = arrangedIds.length > 0 ? arrangedIds : []

  const scenes: ChapterScenePlanScene[] = Array.from({ length: sceneCount }, (_, i) => ({
    sceneKey: `s${i + 1}`,
    order: i + 1,
    title: `场景${i + 1}`,
    goal: task.description,
    locationText: '',
    timeText: '',
    povMode: singlePovId ? 'single' : 'omniscient',
    povCharacterId: singlePovId,
    focusCharacterIds: presentIds.slice(0, 5),
    presentCharacterIds: presentIds,
    functionalCast: [],
    targetWords: splits[i],
    progresses: [],
  }))

  return {
    planRevisionId: input.planRevisionId,
    chapterId: input.chapterId,
    baseContentRevisionId: input.baseContentRevisionId ?? null,
    positioning: task.positioning ?? 'advancement',
    rhythm: 'rising',
    budget,
    scenes,
  }
}

/**
 * 群聊 SceneDefinition[] → ChapterScenePlan。
 * 群聊场景无 POV 声明 → 一律 omniscient；present = SceneDefinition.presentCharacters
 * （成员 id 即角色 id）；focus 取前 5 个在场角色。
 */
export function buildScenePlanFromSceneDefinitions(input: SceneDefinitionsPlanInput): ChapterScenePlan {
  const { sceneDefinitions, budget } = input
  const scenes: ChapterScenePlanScene[] = sceneDefinitions.map((sd, i) => {
    const present = sd.presentCharacters ?? []
    return {
      sceneKey: `s${sd.sceneId ?? i + 1}`,
      order: sd.sceneId ?? i + 1,
      title: sd.title || `场景${i + 1}`,
      goal: sd.goal,
      locationText: sd.location ?? '',
      timeText: sd.time ?? '',
      povMode: 'omniscient',
      povCharacterId: null,
      focusCharacterIds: present.slice(0, 5),
      presentCharacterIds: present,
      functionalCast: [],
      targetWords: 0,
      progresses: [],
    }
  })

  // 场景字数均分（群聊未声明逐场预算）
  if (scenes.length > 0) {
    const splits = splitTargetWords(budget.resolvedTarget, scenes.length)
    scenes.forEach((s, i) => { s.targetWords = splits[i] })
  }

  return {
    planRevisionId: input.planRevisionId,
    chapterId: input.chapterId,
    baseContentRevisionId: input.baseContentRevisionId ?? null,
    positioning: 'advancement',
    rhythm: 'rising',
    budget,
    scenes,
  }
}

/** 解析单 POV：恰 1 个角色名且能解析到 id → id；否则 null（不猜测） */
function resolveSinglePovCharacterId(
  task: NarrativeTask,
  characterIdByName?: ReadonlyMap<string, string>,
): string | null {
  const povNames = (task.povCharacters ?? []).filter(Boolean)
  if (povNames.length !== 1) return null
  if (!characterIdByName) return null
  return characterIdByName.get(povNames[0]) ?? null
}
