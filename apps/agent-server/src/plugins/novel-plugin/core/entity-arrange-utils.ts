/**
 * 编排落库的共用原语。
 *
 * 背景：`generateAndArrange` 里 6 类实体各有一套「复用 → 二次查重 → 新建」循环，
 * 其中"把本章写进章节维度字段"的代码被复制了 8 遍（冲突/势力/物品各 2 遍、地点 2 遍）。
 * 复制是漏改的直接来源——伏笔那一份就漏了 beat，导致编排结果在 Writer 侧凭空消失。
 *
 * 这里只抽真正逐字相同的部分，不改变任何行为；行为由 golden-arrange 快照守护。
 */
import type { ChapterSpan } from './types.js'

/** 章节跨度里是否已经覆盖了该章 */
export function spansCoverChapter(spans: ChapterSpan[] | undefined, chapterNumber: number): boolean {
  return (spans ?? []).some(([start, end]) => chapterNumber >= start && chapterNumber <= end)
}

/**
 * 追加本章到 chapterSpans。
 *
 * @returns 新的 spans；若本章已被覆盖则返回 null（表示无需更新）
 */
export function nextChapterSpans(
  spans: ChapterSpan[] | undefined,
  chapterNumber: number,
): ChapterSpan[] | null {
  const current = spans ?? []
  if (spansCoverChapter(current, chapterNumber)) return null
  return [...current, [chapterNumber, chapterNumber] as ChapterSpan]
}

/**
 * 追加本章到 appearChapters（地点用离散章节号而非跨度）。
 *
 * @returns 新的章节号数组；若已包含则返回 null
 */
export function nextAppearChapters(
  appearChapters: number[] | undefined,
  chapterNumber: number,
): number[] | null {
  const current = appearChapters ?? []
  if (current.includes(chapterNumber)) return null
  return [...current, chapterNumber]
}

/**
 * 把本章写入实体的 chapterSpans，并登记回滚。
 *
 * 只适用于"除 chapterSpans 外不改别的字段"的场景；
 * 需要一次性写多个字段时用 nextChapterSpans 自行拼 patch。
 */
export function appendChapterSpanWithRollback<T extends { id: string; chapterSpans?: ChapterSpan[] }>(
  entity: T,
  chapterNumber: number,
  update: (id: string, patch: { chapterSpans: ChapterSpan[] }) => unknown,
  rollbackActions: Array<() => void>,
): void {
  const merged = nextChapterSpans(entity.chapterSpans, chapterNumber)
  if (!merged) return
  const original = entity.chapterSpans ?? []
  rollbackActions.push(() => { update(entity.id, { chapterSpans: original }) })
  update(entity.id, { chapterSpans: merged })
}
