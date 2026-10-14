/**
 * 章节投影 → 事件账本的记录器（S4-1a）。
 *
 * ## 它补的是什么缺口
 *
 * S4-1 的对账实测（真实项目，11 章）显示一致率只有 38.6%，其中最大一块是
 * "账本缺记录" 66 条 —— 势力 14 条、地点 18 条**全缺**，因为账本侧从来没有为
 * 这两类实体写过任何变化记录；角色/线索/冲突/伏笔也各有缺失，来源是手工编辑
 * 实体字段、Memory Agent 工具、前端矩阵拖拽这些不经过编排器的路径。
 *
 * 只要账本不完整，S4-2 把矩阵读路径切到账本就会让整条势力轨和地点轨消失。
 * 这个记录器挂在 NovelStore 的投影观察者上，把所有写入路径收口到一处。
 *
 * ## 设计要点
 *
 * - **幂等**：写入前先查同 (subject, chapter, dimension) 是否已有记录。
 *   这让重复触发、以及未来的存量回填都安全。
 * - **只记新增**：账本是追加式事件流，"某章不再有它"属于更正操作而非发生过的事，
 *   不产生账本条目（矩阵仍从实体字段读到正确结果，对账会把它算作"投影缺"而非漂移）。
 * - **按章聚合**：同一章的多次投影变更挂在同一个 story event 下，避免账本被
 *   逐字段变更打成碎片。
 */
import type { NovelMemoryStore } from '../novel-memory-store.js'
import type { ChapterProjectionChange, ChapterProjectionObserver } from '../novel-store.js'
import type { NovelStoryEntityType } from '../types.js'

/** 投影记录统一用 `<类型>.arranged` 维度，与 generateAndArrange 的账本投影保持一致 */
function dimensionFor(entityType: ChapterProjectionChange['entityType']): string {
  return `${entityType}.arranged`
}

/** 实时收口写入时使用的事件标题 */
export const CHAPTER_PROJECTION_EVENT_TITLE = '章节投影变更'
/** 存量回填写入时使用的事件标题（与实时写入区分，便于审计与回滚） */
export const CHAPTER_PROJECTION_BACKFILL_EVENT_TITLE = '存量投影回填'

export interface ChapterProjectionRecorderOptions {
  /** 记录失败时的告警出口；回调完成后错误仍会继续抛出以触发外层事务回滚。 */
  onError?: (err: unknown, projectId: string, change: ChapterProjectionChange) => void
  /**
   * story event 标题。默认为实时收口用的标题；
   * 存量回填传 CHAPTER_PROJECTION_BACKFILL_EVENT_TITLE，让两类写入在账本里可区分。
   */
  eventTitle?: string
  /** 事件摘要生成器（默认按实时收口的措辞） */
  eventSummary?: (chapterNumber: number) => string
}

/**
 * 创建观察者：把"实体新增了某章出场"写成账本变化记录。
 *
 * 返回的函数直接交给 `store.setChapterProjectionObserver()`。
 */
export function createChapterProjectionRecorder(
  memoryStore: NovelMemoryStore,
  options?: ChapterProjectionRecorderOptions,
): ChapterProjectionObserver {
  const eventTitle = options?.eventTitle ?? CHAPTER_PROJECTION_EVENT_TITLE
  const eventSummary = options?.eventSummary
    ?? ((chapterNumber: number) => `第 ${chapterNumber} 章的实体投影变更（矩阵编辑 / 工具写入 / 状态推进）`)

  return (projectId, change) => {
    if (change.addedChapters.length === 0) return
    try {
      const dimension = dimensionFor(change.entityType)
      const subjectType = change.entityType as NovelStoryEntityType

      for (const chapterNumber of change.addedChapters) {
        // 幂等：同一实体在同一章的同一维度只记一条
        const existing = memoryStore.listChangeRecords(projectId, {
          chapterNumber,
          subjectType,
          subjectId: change.entityId,
          dimension,
        })
        if (existing.length > 0) continue

        // 同章的投影变更复用同一个 story event，避免账本碎片化
        const event = memoryStore.listStoryEvents(projectId, { chapterNumber })
          .find((candidate) => candidate.title === eventTitle)
          ?? memoryStore.createStoryEvent({
            projectId,
            chapterNumber,
            sceneId: null,
            sceneOrder: 0,
            type: 'transition',
            title: eventTitle,
            summary: eventSummary(chapterNumber),
            outcome: '',
            status: 'confirmed',
            parentEventId: null,
            source: 'manual',
          })

        memoryStore.createStoryEventEntityRef(event.id, {
          entityType: subjectType,
          entityId: change.entityId,
          role: 'affected',
          note: `投影变更：${change.origin}`,
        })
        memoryStore.createChangeRecord({
          projectId,
          storyEventId: event.id,
          chapterNumber,
          sceneOrder: 0,
          subjectType,
          subjectId: change.entityId,
          dimension,
          targetType: null,
          targetId: null,
          valueType: 'reference',
          beforeValue: null,
          afterValue: { chapter: chapterNumber },
          reason: `编排进第 ${chapterNumber} 章（${change.origin}）`,
          significance: 3,
          source: 'manual',
          cause: null,
          effectIds: [],
        })
      }
    } catch (err) {
      options?.onError?.(err, projectId, change)
      throw err
    }
  }
}
