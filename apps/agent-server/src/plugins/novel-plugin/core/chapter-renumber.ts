/**
 * 章节号重排规格（借鉴 PlotPilot ChapterRenumberSpec）
 *
 * 当删除某章节后，所有引用了 chapter_number 的字段需要：
 * - 大于被删章节的：减 1
 * - 等于被删章节的：清除（返回 null / 从数组移除）
 * - 小于被删章节的：不变
 *
 * 三类字段处理：
 * 1. 标量 chapter_number：shiftChapterNumber
 * 2. JSON 数组 [[start,end],...]：shiftChapterSpans（冲突/势力跨度）
 * 3. JSON 列表 [n,n,...]：shiftChapterList（地点出现章节）
 *
 * 字段映射常量 CHAPTER_RENUMBER_FIELDS 在 NovelStore.deleteChapter 中使用，
 * 列出所有需要被重排的表/列，便于后续扩展。
 */

export interface ChapterRenumberSpec {
  /** 被删除的章节号 */
  readonly deletedChapter: number
  /** 偏移量：删章 = -1（默认），插章 = +1（预留） */
  readonly delta: number
}

export function createChapterRenumberSpec(
  deletedChapter: number,
  delta: number = -1,
): ChapterRenumberSpec {
  if (!Number.isInteger(deletedChapter) || deletedChapter < 1) {
    throw new Error(`deletedChapter 必须是正整数，收到: ${deletedChapter}`)
  }
  if (delta !== -1 && delta !== 1) {
    throw new Error(`delta 仅支持 -1（删章）和 +1（插章），收到: ${delta}`)
  }
  return { deletedChapter, delta }
}

/**
 * 处理标量 chapter_number 字段
 * @returns 新章节号；若字段引用的就是被删章节，返回 null（调用方负责清除或删除该行）
 */
export function shiftChapterNumber(
  current: number | null | undefined,
  spec: ChapterRenumberSpec,
): number | null {
  if (current == null) return null
  if (current === spec.deletedChapter) return null
  if (spec.delta === -1 && current > spec.deletedChapter) return current - 1
  if (spec.delta === 1 && current >= spec.deletedChapter) return current + 1
  return current
}

/**
 * 处理 chapter_spans JSON 数组 [[start,end],...]
 * - 跨度完全等于被删章节（[3,3] 删第 3 章）：移除该段
 * - 跨度包含被删章节：调整 end（删章则 end-1）
 * - 跨度起点大于被删章节：start 和 end 都 shift
 * - 跨度终点小于被删章节：不变
 */
export function shiftChapterSpans(
  spans: Array<[number, number]>,
  spec: ChapterRenumberSpec,
): Array<[number, number]> {
  const result: Array<[number, number]> = []
  for (const [start, end] of spans) {
    if (start > end) {
      // 非法跨度，原样保留
      result.push([start, end])
      continue
    }
    // 整段都被删（[3,3] 删 3）
    if (start === spec.deletedChapter && end === spec.deletedChapter) {
      continue
    }
    let newStart = start
    let newEnd = end
    if (spec.delta === -1) {
      if (start > spec.deletedChapter) newStart = start - 1
      if (end >= spec.deletedChapter) newEnd = end - 1
    } else {
      // 插章：>= deletedChapter 的都 +1
      if (start >= spec.deletedChapter) newStart = start + 1
      if (end >= spec.deletedChapter) newEnd = end + 1
    }
    result.push([newStart, newEnd])
  }
  return result
}

/**
 * 处理 appear_chapters JSON 列表 [n,n,...]
 * - 等于被删章节的元素：移除
 * - 大于被删章节的元素：减 1
 * - 小于被删章节的元素：不变
 */
export function shiftChapterList(
  chapters: number[],
  spec: ChapterRenumberSpec,
): number[] {
  const result: number[] = []
  for (const ch of chapters) {
    if (ch === spec.deletedChapter) continue
    if (spec.delta === -1 && ch > spec.deletedChapter) {
      result.push(ch - 1)
    } else if (spec.delta === 1 && ch >= spec.deletedChapter) {
      result.push(ch + 1)
    } else {
      result.push(ch)
    }
  }
  return result
}

/**
 * 字段映射常量：列出所有引用 chapter_number 的表和列
 *
 * 借鉴 PlotPilot DEFAULT_CHAPTER_INTEGER_JSON_KEYS frozenset 思路，
 * 但更细化——区分三类字段：
 *   scalar  - 整数标量字段，用 shiftChapterNumber
 *   spans   - JSON 跨度数组，用 shiftChapterSpans
 *   list    - JSON 列表，用 shiftChapterList
 *
 * scalar 字段的 nullable 属性决定被删章节引用的处理方式：
 *   nullable=true  - SET NULL（保留行，丢失章节关联，如 character_history）
 *   nullable=false - DELETE 行（NOT NULL 列无法置空，如 markers/memory_events）
 *
 * NovelStore.deleteChapter 遍历此常量，对每张表执行相应 UPDATE。
 */
export type ChapterRenumberField =
  | { table: string; column: string; kind: 'scalar'; nullable: boolean }
  | { table: string; column: string; kind: 'spans' }
  | { table: string; column: string; kind: 'list' }

export const CHAPTER_RENUMBER_FIELDS: ChapterRenumberField[] = [
  // novel_chapters 的被删行已在 deleteChapter 中删除，此处 nullable 不影响（DELETE/SET NULL 均为 no-op）
  { table: 'novel_chapters', column: 'chapter_number', kind: 'scalar', nullable: false },
  { table: 'novel_memory_events', column: 'chapter_number', kind: 'scalar', nullable: false },
  { table: 'novel_memory_snapshots', column: 'chapter_number', kind: 'scalar', nullable: false },
  { table: 'novel_agent_logs', column: 'chapter_number', kind: 'scalar', nullable: false },
  { table: 'novel_character_history', column: 'chapter_number', kind: 'scalar', nullable: true },
  { table: 'novel_markers', column: 'chapter', kind: 'scalar', nullable: false },
  { table: 'novel_conflicts', column: 'chapter_spans', kind: 'spans' },
  { table: 'novel_factions', column: 'chapter_spans', kind: 'spans' },
  { table: 'novel_locations', column: 'appear_chapters', kind: 'list' },
]

// 启动时校验 CHAPTER_RENUMBER_FIELDS 的标识符合法性（防御性，防止未来误传用户输入）
// 模块加载时即校验，运行时无额外开销
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
for (const f of CHAPTER_RENUMBER_FIELDS) {
  if (!IDENT_RE.test(f.table)) throw new Error(`非法 table 标识符: ${f.table}`)
  if (!IDENT_RE.test(f.column)) throw new Error(`非法 column 标识符: ${f.column}`)
}
