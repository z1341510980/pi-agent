/**
 * ChapterScenePlanAdapter：从 Director 规划产物派生 V2 场景计划（scene-wise-writing T2）。
 *
 * 两条映射路径统一为 ChapterScenePlan 落库：
 * - 普通工作流：Director 的 NarrativeTask。scene-wise-writing T1 起 Director 通过
 *   `novel_submit_narrative_task` 提交结构化 `scenes[]`（含逐场 targetWords/emphasis/
 *   因果契约），本模块**直接消费结构化字段**——场景计划是 Writer 逐场预算的生成依据，
 *   不再是仅供对账的影子数据。无 scenes（旧数据/工具未提交）时回退均分。
 * - 群聊：SceneDefinition[] → 逐场映射。
 *
 * 映射原则（与已确认决策一致）：
 * - 无法确定单 POV 的章节/场景 → povMode='omniscient'（povCharacterId=null），
 *   绝不从角色名瞎猜 POV id；单 POV 且能解析到角色 id 时才用 'single'。
 * - functional cast 无信息 → 空数组（不伪造功能位）。
 * - 回退路径的场景字数均分 resolvedTarget，余数给最后一场（文档 §5 校验规则）。
 */
import type { NarrativeTask, ArrangedEntity, NarrativeTaskScene } from '../types.js'
import type { SceneDefinition } from '../discussion/engine/discussion-types.js'
import type { ChapterScenePlan, ChapterScenePlanScene } from './chapter-scene-plan.js'
import type { ChapterPlanRevision } from '../types.js'

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

/** 场景笔墨等级：核心承载主任务/高潮，过场只做承接与过渡（scene-wise-writing T1 结构化字段） */
export type SceneEmphasis = 'core' | 'transition'

/**
 * 逐场字数预算提示（注入 Writer 创作指令的 {{scene_budgets}} 占位符）。
 *
 * scene-wise-writing T1/T2：优先读取 Director 结构化 `scenes[]` 的逐场 targetWords
 * （工具已校验总和=本章目标），主次标注与预算都来自 Director 的显式分配。
 * 无 scenes 时回退均分（旧数据/工具未提交；群聊路径不经此函数）。
 *
 * 背景（2026-09-01）：此前只让 Writer「目标÷场数自己分配」，模型自计数不可靠，
 * 首稿惯性超写且前场写满、核心剧情没展开就爆字数。这里把结果逐场写死，
 * Writer 只需按行核对；历史版本曾按文本正则解析主次标注再加权（核心 2 : 过场 1），
 * scene-wise-writing 起正则解析整体退役（违反 AGENTS.md 方案 D 约定）。
 */
export function formatSceneBudgetGuidance(
  sceneCount: number | undefined,
  targetWords: number,
  scenes?: NarrativeTaskScene[],
): string {
  if (sceneCount == null || sceneCount < 1) {
    return '叙事任务未标注场景数：按叙事任务的自然分段拆场，给每场分配预算（约等于目标字数 ÷ 场数）。'
  }
  const n = Math.min(sceneCount, 5)
  if (n === 1) {
    return `本章单场景写透：全场预算 ${targetWords} 字，写到该收就收，不要为了填满而加戏。`
  }
  const structured = scenes && scenes.length === n ? scenes : undefined
  const budgets = structured
    ? structured.map((scene) => scene.targetWords)
    : splitTargetWords(targetWords, n)
  const lines = budgets
    .map((w, i) => {
      const tag = structured
        ? `（${structured[i].emphasis === 'core' ? '核心' : '过场'}）`
        : ''
      return `场景 ${i + 1}${tag} ≈ ${w} 字`
    })
    .join(' / ')
  return (
    `逐场预算（写完一场就核对累计字数，超了立刻在下一场压缩）：${lines}。` +
    '这不是建议值：任一场超出本场预算 20% 以上就必须就地删减，不能靠"后面写短一点"补回来。'
  )
}

/**
 * NarrativeTask（章节级）→ ChapterScenePlan。
 * - 有结构化 scenes[]：逐场 goal/title/targetWords 直接取 Director 分配（生成依据）
 * - 无 scenes（旧数据/未提交）：按 sceneCount 均分，每场 goal 复用任务描述（不臆造）
 * - POV：恰好 1 个且能解析为角色 id → single；否则 omniscient（不猜）
 * - focus/present：arrangedEntities.characterIds（有编排时），否则 []
 */
export function buildScenePlanFromNarrativeTask(input: NarrativeTaskPlanInput): ChapterScenePlan {
  const { task, budget } = input
  const structured = task.scenes && task.scenes.length > 0 ? task.scenes : undefined
  const sceneCount = Math.min(Math.max(task.sceneCount ?? structured?.length ?? 1, 1), 5)
  const splits = splitTargetWords(budget.resolvedTarget, sceneCount)

  const singlePovId = resolveSinglePovCharacterId(task, input.characterIdByName)
  const arrangedIds = input.arrangedEntities?.characterIds ?? []
  const presentIds = arrangedIds.length > 0 ? arrangedIds : []

  const scenes: ChapterScenePlanScene[] = Array.from({ length: sceneCount }, (_, i) => {
    const source: NarrativeTaskScene | undefined = structured?.[i]
    return {
      sceneKey: `s${i + 1}`,
      order: i + 1,
      title: source?.title ?? `场景${i + 1}`,
      goal: source?.goal ?? task.description,
      locationText: '',
      timeText: '',
      povMode: singlePovId ? 'single' : 'omniscient',
      povCharacterId: singlePovId,
      focusCharacterIds: presentIds.slice(0, 5),
      presentCharacterIds: presentIds,
      functionalCast: [],
      targetWords: source?.targetWords ?? splits[i],
      progresses: [],
    }
  })

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
