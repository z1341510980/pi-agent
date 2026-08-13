/**
 * V2 双写对账（T05）。
 *
 * 渐进迁移第 2 步：比较 V1（旧字段/公式）与 V2（scene revision / plan budget）
 * 对同一业务事实的计算结果，供灰度判断"差异已收敛，可以切读/停旧写"。
 *
 * 维度（§10 第 2 步）：
 * - 章节目标字数：V1（定位倍率公式）vs V2（plan budget.resolvedTarget）
 * - 场景数：旧规范来源已停用；V2（最新 plan 的场景版本数）为唯一主数据
 * - 事件 scene 字段残留：story_events.scene_id 非空计数（停旧写后应趋近 0）
 *
 * 只读、不修数据、不做裁决；差异由人判断（补 V2 或接受旧数据）。
 */
import type Database from 'better-sqlite3'
import type { NovelStore } from './novel-store.js'
import type { ChapterPositioning } from './types.js'

/** V1 定位倍率（与 rhythm-controller POSITIONING_RULES 的 wordBudgetMultiplier 一致） */
const V1_POSITIONING_MULTIPLIERS: Record<ChapterPositioning, number> = {
  high_pressure: 1.3,
  advancement: 1.0,
  cultivation: 0.9,
  relationship: 0.95,
  low_pressure: 0.85,
  information: 0.9,
}

export interface WordBudgetReconcileItem {
  chapterNumber: number
  /** V1：定位倍率公式（无定位 = base，节奏不参与本维度对比） */
  v1Target: number
  /** V2：最新生效 plan 的 resolvedTarget；无 plan 时为 null（不参与对比） */
  v2Target: number | null
  matched: boolean
}

export interface SceneCountReconcileItem {
  chapterNumber: number
  /** 旧规范场景来源已停用，恒为 null；DiscussionRun.scenes 仅用于断点恢复 */
  v1Scenes: number | null
  /** V2：最新生效 plan 的场景版本数；无 plan 时为 null */
  v2Scenes: number | null
  matched: boolean
}

export interface ReconciliationReport {
  projectId: string
  projectTitle: string
  chapterRange: [number, number] | null
  wordBudget: { matched: number; mismatched: number; items: WordBudgetReconcileItem[] }
  sceneCount: { matched: number; mismatched: number; items: SceneCountReconcileItem[] }
  eventSceneFields: { totalEvents: number; eventsWithSceneId: number }
  overallMatched: boolean
}

function v1TargetWords(projectTargetWords: number | undefined, positioning: ChapterPositioning | null | undefined): number {
  const base = projectTargetWords !== undefined && projectTargetWords > 0 ? Math.round(projectTargetWords) : 3000
  if (!positioning) return base
  return Math.round(base * (V1_POSITIONING_MULTIPLIERS[positioning] ?? 1))
}

export function reconcileV2(
  db: Database.Database,
  store: NovelStore,
  projectId: string,
): ReconciliationReport {
  const project = store.getProject(projectId)
  const chapters = store.listChapters(projectId)
  const chapterRange: [number, number] | null =
    chapters.length > 0 ? [chapters[0].chapterNumber, chapters[chapters.length - 1].chapterNumber] : null

  // DiscussionRun.scenes 是失败运行的恢复输入，不是规范场景主数据。
  // 保留空映射，使报告结构兼容，但不再把运行快照当作 V1 来源。
  const v1SceneCountByChapter = new Map<number, number>()

  const wordBudgetItems: WordBudgetReconcileItem[] = []
  const sceneCountItems: SceneCountReconcileItem[] = []
  let wordBudgetMatched = 0
  let wordBudgetMismatched = 0
  let sceneCountMatched = 0
  let sceneCountMismatched = 0

  for (const chapter of chapters) {
    const v1Target = v1TargetWords(project?.targetWords, chapter.positioning as ChapterPositioning | null)
    const plan = store.getCurrentPlan(chapter.id)
    const v2Target = plan?.budget.resolvedTarget ?? null
    const wbMatched = v2Target != null && v1Target === v2Target
    wordBudgetItems.push({ chapterNumber: chapter.chapterNumber, v1Target, v2Target, matched: wbMatched })
    if (v2Target != null) wbMatched ? wordBudgetMatched++ : wordBudgetMismatched++

    const v1Scenes = v1SceneCountByChapter.get(chapter.chapterNumber) ?? null
    const v2Scenes = plan ? store.listSceneRevisionsByPlan(plan.id).length : null
    const scMatched = v1Scenes != null && v2Scenes != null && v1Scenes === v2Scenes
    sceneCountItems.push({ chapterNumber: chapter.chapterNumber, v1Scenes, v2Scenes, matched: scMatched })
    if (v1Scenes != null && v2Scenes != null) scMatched ? sceneCountMatched++ : sceneCountMismatched++
  }

  const eventStats = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN scene_id IS NOT NULL AND scene_id != '' THEN 1 ELSE 0 END) as withScene
     FROM novel_story_events WHERE project_id = ?`,
  ).get(projectId) as { total: number; withScene: number | null }

  const overallMatched =
    wordBudgetMismatched === 0 && sceneCountMismatched === 0

  return {
    projectId,
    projectTitle: project?.title ?? '',
    chapterRange,
    wordBudget: { matched: wordBudgetMatched, mismatched: wordBudgetMismatched, items: wordBudgetItems },
    sceneCount: { matched: sceneCountMatched, mismatched: sceneCountMismatched, items: sceneCountItems },
    eventSceneFields: { totalEvents: eventStats.total, eventsWithSceneId: eventStats.withScene ?? 0 },
    overallMatched,
  }
}

/** 对账辅助：输出人类可读摘要（脚本/日志用） */
export function formatReconciliationReport(report: ReconciliationReport): string {
  const lines = [
    `项目 ${report.projectTitle} (${report.projectId.slice(0, 8)}) 章节 ${report.chapterRange?.[0] ?? '-'}~${report.chapterRange?.[1] ?? '-'}`,
    `字数：匹配 ${report.wordBudget.matched} / 不匹配 ${report.wordBudget.mismatched}`,
    `场景数：匹配 ${report.sceneCount.matched} / 不匹配 ${report.sceneCount.mismatched}`,
    `事件 scene 字段残留：${report.eventSceneFields.eventsWithSceneId}/${report.eventSceneFields.totalEvents}`,
    `总体：${report.overallMatched ? '✅ 一致（可考虑切读）' : '❌ 存在差异（继续双写）'}`,
  ]
  for (const item of report.wordBudget.items) {
    if (item.v2Target != null && !item.matched) {
      lines.push(`  ⚠️ 第${item.chapterNumber}章字数 V1=${item.v1Target} V2=${item.v2Target}`)
    }
  }
  for (const item of report.sceneCount.items) {
    if (item.v1Scenes != null && item.v2Scenes != null && !item.matched) {
      lines.push(`  ⚠️ 第${item.chapterNumber}章场景数 V1=${item.v1Scenes} V2=${item.v2Scenes}`)
    }
  }
  return lines.join('\n')
}
