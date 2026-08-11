/**
 * 实体"章节维度字段"的纯函数抽取。
 *
 * 每类实体用不同的字段表达"它在哪些章出场"：
 *   - 角色：character_history 的离散章节号（无 chapterSpans）
 *   - 冲突 / 线索 / 势力 / 物品：chapterSpans 跨度
 *   - 伏笔：beats 的离散节点（空则退到埋设章）
 *   - 地点：appearChapters 离散章节号
 *
 * 这些规则同时被三处使用：矩阵对账、store 层的投影变更观察者、前端矩阵派生。
 * 抽成纯函数放在这里，避免三处各写一遍然后漂移（这正是 S4 要治的病）。
 * 本模块不依赖 store，可被 store 与 matrix-projection 同时 import 而不产生循环。
 */
import type { ChapterSpan, NovelClue, NovelConflict, NovelFaction, NovelForeshadow, NovelItem, NovelLocation, NovelNarrative } from './types.js'

/** 参与矩阵投影的实体类型（关系/世界要素等不占章节格） */
export const PROJECTION_ENTITY_TYPES = [
  'character', 'conflict', 'foreshadow', 'clue', 'faction', 'location', 'item', 'narrative',
] as const
export type ProjectionEntityType = typeof PROJECTION_ENTITY_TYPES[number]

export const PROJECTION_TYPE_SET: ReadonlySet<string> = new Set<string>(PROJECTION_ENTITY_TYPES)

/** 展开 chapterSpans 为离散章节号（升序去重） */
export function expandChapterSpans(spans: ChapterSpan[] | undefined): number[] {
  const out = new Set<number>()
  for (const [start, end] of spans ?? []) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    for (let n = Math.max(1, start); n <= end; n += 1) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

function normalizeChapters(chapters: Iterable<number>): number[] {
  const out = new Set<number>()
  for (const n of chapters) {
    if (Number.isInteger(n) && n >= 1) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

export function chaptersOfConflict(entity: Pick<NovelConflict, 'chapterSpans'>): number[] {
  return expandChapterSpans(entity.chapterSpans)
}

export function chaptersOfClue(entity: Pick<NovelClue, 'chapterSpans'>): number[] {
  return expandChapterSpans(entity.chapterSpans)
}

export function chaptersOfFaction(entity: Pick<NovelFaction, 'chapterSpans'>): number[] {
  return expandChapterSpans(entity.chapterSpans)
}

export function chaptersOfItem(entity: Pick<NovelItem, 'chapterSpans'>): number[] {
  return expandChapterSpans(entity.chapterSpans)
}

export function chaptersOfLocation(entity: Pick<NovelLocation, 'appearChapters'>): number[] {
  return normalizeChapters(entity.appearChapters ?? [])
}

export function chaptersOfNarrative(entity: Pick<NovelNarrative, 'chapterSpans'>): number[] {
  return expandChapterSpans(entity.chapterSpans)
}

/**
 * 伏笔是离散事件链：只有 beats 里的章节算出场。
 * beats 为空时退到埋设章（兼容 beats 之前的旧数据）。
 * 计划回收章不算出场 —— 它是意图，不是已发生的节点。
 */
export function chaptersOfForeshadow(
  entity: Pick<NovelForeshadow, 'beats' | 'firstChapter'>,
): number[] {
  const beats = entity.beats ?? []
  if (beats.length > 0) return normalizeChapters(beats.map((beat) => beat.chapter))
  return entity.firstChapter != null ? normalizeChapters([entity.firstChapter]) : []
}

/** 两组章节的差集（用于检测投影变更） */
export function diffChapters(before: number[], after: number[]): { added: number[]; removed: number[] } {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((n) => !beforeSet.has(n)),
    removed: before.filter((n) => !afterSet.has(n)),
  }
}
