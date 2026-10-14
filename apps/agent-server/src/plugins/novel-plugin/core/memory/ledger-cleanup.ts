/**
 * 悬空账本引用的清理（S4-1c）。
 *
 * ## 悬空引用是什么
 *
 * `novel_story_event_entities.entity_id` 与 `novel_memory_events.subject_id` 是
 * **多态引用**，没有外键指向具体实体表，所以删除实体不会级联清理。
 * S4-1 对账在真实项目里实测到 11 条：10 条 change record 指向已删除的冲突，
 * 1 条 character_history 指向已删除的角色。
 *
 * 这类差异既不能靠"补账本"（实体已不存在），也不能靠"补投影"解决，
 * 所以对账把它单独分类。修法只有两条：清理引用，或恢复实体。
 *
 * ## 两个层面
 *
 * - **此后**：`NovelStore` 的删除方法已接上 `EntityDeletedObserver`，
 *   删实体时同步清理账本引用与 character_history（见 novel-services 的装配）。
 * - **存量**：本模块提供一次性清理，默认 dry-run。
 */
import type { NovelStore } from '../novel-store.js'
import type { NovelMemoryStore } from '../novel-memory-store.js'
import { projectFromEntityFields, reconcileMatrixProjection, type ChapterPresence } from '../analysis/matrix-projection.js'

export interface DanglingCleanupPlan {
  projectId: string
  projectTitle: string
  /** 悬空引用条目（按实体去重后的列表） */
  entities: Array<{ entityType: string; entityId: string; chapters: number[]; sides: string[] }>
  /** 原始条目数（未按实体去重） */
  itemCount: number
}

export interface DanglingCleanupResult extends DanglingCleanupPlan {
  deletedEntityRefs: number
  deletedChangeRecords: number
  deletedMemoryEvents: number
  deletedCharacterHistory: number
  prunedEmptyEvents: number
}

function groupByEntity(items: ChapterPresence[]): DanglingCleanupPlan['entities'] {
  const grouped = new Map<string, { entityType: string; entityId: string; chapters: number[]; sides: Set<string> }>()
  for (const item of items) {
    const key = `${item.entityType}:${item.entityId}`
    const bucket = grouped.get(key)
    if (bucket) {
      bucket.chapters.push(item.chapterNumber)
      bucket.sides.add(item.side)
    } else {
      grouped.set(key, {
        entityType: item.entityType,
        entityId: item.entityId,
        chapters: [item.chapterNumber],
        sides: new Set([item.side]),
      })
    }
  }
  return [...grouped.values()]
    .map((b) => ({
      entityType: b.entityType,
      entityId: b.entityId,
      chapters: [...new Set(b.chapters)].sort((a, c) => a - c),
      sides: [...b.sides].sort(),
    }))
    .sort((a, b) => a.entityType.localeCompare(b.entityType) || a.entityId.localeCompare(b.entityId))
}

/** 只计算清理清单，不删任何数据 */
export function planDanglingCleanup(
  store: NovelStore,
  memoryStore: NovelMemoryStore,
  projectId: string,
): DanglingCleanupPlan {
  const report = reconcileMatrixProjection(store, memoryStore, projectId)
  const dangling = [...report.danglingRefs]
  // 2026-08-12 逻辑统一：对账基准切 appearance 表（不含 character_history），
  // character_history 的悬空出场仍需单独纳入清理清单（实体字段侧防御性清理）。
  for (const presence of projectFromEntityFields(store, projectId).byKey.values()) {
    if (!presence.entityExists && presence.entityType === 'character') {
      dangling.push(presence)
    }
  }
  return {
    projectId,
    projectTitle: report.projectTitle,
    entities: groupByEntity(dangling),
    itemCount: dangling.length,
  }
}

/**
 * 执行清理。
 *
 * 两侧都清：
 * - 账本侧：story_event_entities 引用 + change records + memory events
 * - 实体字段侧：character_history 里指向已删角色的行
 * 最后 prune 掉清理后变空的 story event。
 */
export function applyDanglingCleanup(
  store: NovelStore,
  memoryStore: NovelMemoryStore,
  projectId: string,
): DanglingCleanupResult {
  return store.withTransaction(() => {
    const plan = planDanglingCleanup(store, memoryStore, projectId)
    let deletedEntityRefs = 0
    let deletedChangeRecords = 0
    let deletedMemoryEvents = 0
    let deletedCharacterHistory = 0

    for (const entity of plan.entities) {
      const removed = memoryStore.deleteLedgerReferencesByEntity(projectId, entity.entityId)
      deletedEntityRefs += removed.entityRefs
      deletedChangeRecords += removed.changeRecords
      deletedMemoryEvents += removed.memoryEvents

      if (entity.entityType === 'character') {
        // 实体字段侧：指向已删角色的出场记录
        deletedCharacterHistory += store.deleteCharacterHistoryByCharacter(entity.entityId)
      }
    }

    const prunedEmptyEvents = memoryStore.pruneEmptyStoryEvents(projectId)

    return {
      ...plan,
      deletedEntityRefs,
      deletedChangeRecords,
      deletedMemoryEvents,
      deletedCharacterHistory,
      prunedEmptyEvents,
    }
  })
}

export function formatDanglingCleanupPlan(
  plan: DanglingCleanupPlan | DanglingCleanupResult,
  options?: { applied?: boolean },
): string {
  const lines: string[] = []
  lines.push(`## ${plan.projectTitle}`)
  lines.push(`项目 ID：${plan.projectId}`)
  lines.push('')
  lines.push(`悬空引用：${plan.itemCount} 条，涉及 ${plan.entities.length} 个已删除实体`)
  if ('deletedEntityRefs' in plan) {
    lines.push('')
    lines.push('已删除：')
    lines.push(`  story event 实体引用：${plan.deletedEntityRefs}`)
    lines.push(`  账本变化记录：${plan.deletedChangeRecords}`)
    lines.push(`  记忆事件：${plan.deletedMemoryEvents}`)
    lines.push(`  角色出场记录（character_history）：${plan.deletedCharacterHistory}`)
    lines.push(`  清理后变空的 story event：${plan.prunedEmptyEvents}`)
  }
  if (plan.entities.length > 0) {
    lines.push('')
    lines.push(`### ${options?.applied ? '已清理' : '将清理'}的实体`)
    for (const entity of plan.entities) {
      lines.push(`- ${entity.entityType} ${entity.entityId}（涉及第 ${entity.chapters.join('、')} 章；来源：${entity.sides.join('、')}）`)
    }
  }
  return lines.join('\n')
}
