/**
 * ChapterScenePlan：统一场景计划契约（T01）。
 *
 * 为 docs/novel/2026-08-05-剧情推进模型重构方案.md §5 的契约提供权威 TS 类型
 * 与可单测的校验函数。T02 的 plan store 与 T03 的 Director/群聊 adapter 直接复用。
 *
 * 关键语义（与已确认决策一致）：
 * - 单场景单 POV：povMode='single' 必须恰好 1 个 povCharacterId；
 *   omniscient/none 必须 0 个；不保留 ensemble。
 * - 功能角色 functional cast：必须带 function，默认 prominence='brief'；
 *   brief 且非 POV/focus 不得有独立内心/背景段（结构由 Writer 提示词约束，此处只校验结构）。
 * - 每场最多 5 个 focus。
 * - scene targetWords 之和必须等于 resolvedTarget（±1 容差，舍入差额给最后一场）。
 */
import type { ChapterPositioning, ChapterRhythm } from '../types.js'

export type ScenePovMode = 'single' | 'omniscient' | 'none'

export type PlotFunction = string

export type CastProminence = 'lead' | 'support' | 'brief'

export type ProgressType = 'setup' | 'advance' | 'turn' | 'reveal' | 'resolve' | 'pause'

export interface SceneFunctionalCastEntry {
  characterId: string
  function: PlotFunction
  prominence: CastProminence
}

export interface SceneProgressIntent {
  storylineId: string
  primary: boolean
  type: ProgressType
  expectedChange: string
}

export interface ChapterScenePlanScene {
  /** 章内稳定标识（如 's1'），校验时与 order 一同参与唯一性 */
  sceneKey: string
  order: number
  title: string
  goal: string
  locationText: string
  timeText: string
  povMode: ScenePovMode
  povCharacterId: string | null
  focusCharacterIds: string[]
  presentCharacterIds: string[]
  functionalCast: SceneFunctionalCastEntry[]
  targetWords: number
  progresses: SceneProgressIntent[]
}

export interface ChapterScenePlanBudget {
  baseTarget: number
  adjustmentPct: number
  resolvedTarget: number
  min: number
  max: number
}

export interface ChapterScenePlan {
  planRevisionId: string
  chapterId: string
  baseContentRevisionId: string | null
  positioning: ChapterPositioning
  rhythm: ChapterRhythm
  budget: ChapterScenePlanBudget
  scenes: ChapterScenePlanScene[]
}

export interface ScenePlanValidationIssue {
  code: string
  sceneKey?: string
  message: string
}

/** scene target 之和与 resolvedTarget 的容差（±1，覆盖舍入差额） */
const BUDGET_TOLERANCE = 1
const MAX_FOCUS_PER_SCENE = 5

/**
 * 校验 ChapterScenePlan。返回问题列表；空数组表示通过。
 *
 * 规则（违规 code 见各分支注释）：
 * - scenes 非空；sceneKey/order 章内唯一
 * - sum(targetWords) 与 resolvedTarget 差 <= 1
 * - 每场 focus <= 5
 * - functionalCast 每项必须带非空 function
 * - povMode='single' → 恰 1 个 povCharacterId；omniscient/none → 0 个
 */
export function validateChapterScenePlan(plan: ChapterScenePlan): ScenePlanValidationIssue[] {
  const issues: ScenePlanValidationIssue[] = []

  if (!plan.scenes || plan.scenes.length === 0) {
    issues.push({ code: 'empty_scenes', message: '场景列表不能为空' })
    return issues
  }

  const seenKeys = new Set<string>()
  const seenOrders = new Set<number>()

  for (const scene of plan.scenes) {
    const scope = { sceneKey: scene.sceneKey }

    // duplicate_scene_key / duplicate_scene_order
    if (scene.sceneKey == null || scene.sceneKey === '') {
      issues.push({ ...scope, code: 'missing_scene_key', message: '场景缺少 sceneKey' })
    } else if (seenKeys.has(scene.sceneKey)) {
      issues.push({ ...scope, code: 'duplicate_scene_key', message: `sceneKey 重复: ${scene.sceneKey}` })
    } else {
      seenKeys.add(scene.sceneKey)
    }

    if (!Number.isInteger(scene.order) || scene.order < 0) {
      issues.push({ ...scope, code: 'invalid_scene_order', message: `order 必须是非负整数: ${String(scene.order)}` })
    } else if (seenOrders.has(scene.order)) {
      issues.push({ ...scope, code: 'duplicate_scene_order', message: `order 重复: ${scene.order}` })
    } else {
      seenOrders.add(scene.order)
    }

    // too_many_focus
    if (scene.focusCharacterIds.length > MAX_FOCUS_PER_SCENE) {
      issues.push({
        ...scope,
        code: 'too_many_focus',
        message: `focus 角色 ${scene.focusCharacterIds.length} 个，超过上限 ${MAX_FOCUS_PER_SCENE}`,
      })
    }

    // functional_cast_missing_function
    for (const entry of scene.functionalCast) {
      if (!entry.function || entry.function.trim() === '') {
        issues.push({
          ...scope,
          code: 'functional_cast_missing_function',
          message: `functional cast 角色 ${entry.characterId} 缺少 function`,
        })
      }
    }

    // pov_count_mismatch
    const povCount = scene.povCharacterId && scene.povCharacterId.trim() !== '' ? 1 : 0
    if (scene.povMode === 'single' && povCount !== 1) {
      issues.push({ ...scope, code: 'pov_count_mismatch', message: 'single 模式必须恰好 1 个 povCharacterId' })
    } else if ((scene.povMode === 'omniscient' || scene.povMode === 'none') && povCount !== 0) {
      issues.push({ ...scope, code: 'pov_count_mismatch', message: `${scene.povMode} 模式不得指定 povCharacterId` })
    }
  }

  // scene_budget_mismatch（±1 容差）
  const sceneTotal = plan.scenes.reduce((sum, scene) => sum + (scene.targetWords || 0), 0)
  if (Math.abs(sceneTotal - plan.budget.resolvedTarget) > BUDGET_TOLERANCE) {
    issues.push({
      code: 'scene_budget_mismatch',
      message: `场景字数之和 ${sceneTotal} 与 resolvedTarget ${plan.budget.resolvedTarget} 差距超过容差 ±${BUDGET_TOLERANCE}`,
    })
  }

  return issues
}
