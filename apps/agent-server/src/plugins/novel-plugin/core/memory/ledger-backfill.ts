/**
 * 存量投影回填（S4-1b）。
 *
 * ## 它解决什么
 *
 * S4-1a 把账本写入收口到 NovelStore 的投影观察者上，但那只影响**此后**的写入。
 * 已有项目的历史投影（真实项目实测 66 条：势力 14、地点 18、角色 12、线索 8、
 * 冲突 9、伏笔 5）不会追溯生成，账本仍然不完整 —— 而 S4-2 一旦把矩阵读路径
 * 切到账本，这些缺失会表现为"势力轨和地点轨整体消失"。
 *
 * 回填做的事很窄：把对账报告里"账本缺记录"的那些 `(实体, 章节)` 补写进账本。
 *
 * ## 为什么可以放心跑
 *
 * - 复用 S4-1a 的记录器，写入路径与实时收口完全一致，**幂等**：重复跑不会翻倍。
 * - 只补"实体字段有、账本无"的条目；不改任何实体字段，不删任何账本记录。
 * - 悬空引用（指向已删除实体）被对账单独分类，回填不会碰它们。
 * - 事件标题用「存量投影回填」，与实时写入的「章节投影变更」区分，便于审计与回滚。
 * - 默认 dry-run：先出清单，确认后才落库。
 */
import type { NovelStore } from '../novel-store.js'
import type { NovelMemoryStore } from '../novel-memory-store.js'
import {
  createChapterProjectionRecorder,
  CHAPTER_PROJECTION_BACKFILL_EVENT_TITLE,
} from '../chapters/chapter-projection-recorder.js'
import { reconcileMatrixProjection, type ChapterPresence } from '../analysis/matrix-projection.js'

export interface BackfillPlan {
  projectId: string
  projectTitle: string
  /** 待补写的条目（＝对账的"账本缺记录"） */
  items: ChapterPresence[]
  /** 按实体类型汇总待补条数 */
  byEntityType: Record<string, number>
  /** 悬空引用条数（回填不处理，仅提示） */
  danglingRefs: number
  /** 反向漂移条数（账本有、实体字段无；回填不处理） */
  missingInEntityFields: number
}

export interface BackfillResult extends BackfillPlan {
  /** 实际写入的变化记录条数 */
  written: number
}

/** 只计算回填清单，不写任何数据 */
export function planLedgerBackfill(
  store: NovelStore,
  memoryStore: NovelMemoryStore,
  projectId: string,
): BackfillPlan {
  const report = reconcileMatrixProjection(store, memoryStore, projectId)
  const byEntityType: Record<string, number> = {}
  for (const item of report.missingInLedger) {
    byEntityType[item.entityType] = (byEntityType[item.entityType] ?? 0) + 1
  }
  return {
    projectId,
    projectTitle: report.projectTitle,
    items: report.missingInLedger,
    byEntityType,
    danglingRefs: report.danglingRefs.length,
    missingInEntityFields: report.missingInEntityFields.length,
  }
}

/**
 * 执行回填。
 *
 * 写入前后各跑一次对账：`written` 用写入后实际减少的"账本缺"条数核对，
 * 而不是用"我以为写了几条"，避免幂等跳过被算成成功。
 */
export function applyLedgerBackfill(
  store: NovelStore,
  memoryStore: NovelMemoryStore,
  projectId: string,
): BackfillResult {
  const plan = planLedgerBackfill(store, memoryStore, projectId)
  if (plan.items.length === 0) return { ...plan, written: 0 }

  const recorder = createChapterProjectionRecorder(memoryStore, {
    eventTitle: CHAPTER_PROJECTION_BACKFILL_EVENT_TITLE,
    eventSummary: (chapterNumber) =>
      `第 ${chapterNumber} 章的存量投影回填（S4-1b：把历史实体字段投影补写进账本）`,
    onError: (err) => { throw err },
  })

  // 同一实体的多章合并成一次通知，减少 story event 查询次数
  const grouped = new Map<string, { item: ChapterPresence; chapters: number[] }>()
  for (const item of plan.items) {
    const key = `${item.entityType}:${item.entityId}`
    const bucket = grouped.get(key)
    if (bucket) bucket.chapters.push(item.chapterNumber)
    else grouped.set(key, { item, chapters: [item.chapterNumber] })
  }

  for (const { item, chapters } of grouped.values()) {
    recorder(projectId, {
      entityType: item.entityType,
      entityId: item.entityId,
      addedChapters: [...chapters].sort((a, b) => a - b),
      removedChapters: [],
      origin: 'backfill',
    })
  }

  const after = planLedgerBackfill(store, memoryStore, projectId)
  return { ...plan, written: plan.items.length - after.items.length }
}

/** 渲染回填清单/结果为可读文本 */
export function formatBackfillPlan(
  plan: BackfillPlan | BackfillResult,
  options?: { maxRows?: number; applied?: boolean },
): string {
  const maxRows = options?.maxRows ?? 60
  const lines: string[] = []
  lines.push(`## ${plan.projectTitle}`)
  lines.push(`项目 ID：${plan.projectId}`)
  lines.push('')
  lines.push(`待补写条目：${plan.items.length}`)
  for (const [type, count] of Object.entries(plan.byEntityType).sort()) {
    lines.push(`  ${type}：${count}`)
  }
  if ('written' in plan) lines.push(`实际写入：${plan.written}`)
  lines.push('')
  lines.push(`回填不处理的两类差异：`)
  lines.push(`  悬空引用（指向已删除实体）：${plan.danglingRefs}  → 见 S4-1c`)
  lines.push(`  反向漂移（账本有、实体字段无）：${plan.missingInEntityFields}  → 需人工判断哪边对`)

  if (plan.items.length > 0) {
    lines.push('')
    lines.push(`### ${options?.applied ? '已补写' : '将补写'}的条目`)
    for (const item of plan.items.slice(0, maxRows)) {
      lines.push(`- 第 ${item.chapterNumber} 章 · ${item.entityType} · ${item.entityName} ← ${item.source}`)
    }
    if (plan.items.length > maxRows) lines.push(`- …其余 ${plan.items.length - maxRows} 条省略`)
  }
  return lines.join('\n')
}
