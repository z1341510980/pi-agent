/**
 * 章节号重排规格（借鉴 PlotPilot ChapterRenumberSpec）
 *
 * 当删除某章节后，所有引用了 chapter_number 的字段需要：
 * - 大于被删章节的：减 1
 * - 等于被删章节的：清除（返回 null / 从数组移除）
 * - 小于被删章节的：不变
 *
 * 四类字段处理：
 * 1. 标量 chapter_number：shiftChapterNumber
 * 2. JSON 数组 [[start,end],...]：shiftChapterSpans（冲突/势力跨度）
 * 3. JSON 列表 [n,n,...]：shiftChapterList（地点出现章节）
 * 4. JSON 事件数组 [{chapter,...}]：shiftChapterEvents（伏笔事件链）
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

/** 重排带 chapter 字段的离散事件（如伏笔事件链）。 */
export function shiftChapterEvents<T extends { chapter: number }>(
  events: T[],
  spec: ChapterRenumberSpec,
): T[] {
  return events.flatMap((event) => {
    const chapter = shiftChapterNumber(event.chapter, spec)
    return chapter == null ? [] : [{ ...event, chapter }]
  })
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
  | { table: string; column: string; kind: 'events' }

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
  { table: 'novel_foreshadowing', column: 'chapter_spans', kind: 'spans' },
  { table: 'novel_foreshadowing', column: 'first_chapter', kind: 'scalar', nullable: true },
  { table: 'novel_foreshadowing', column: 'last_chapter', kind: 'scalar', nullable: true },
  { table: 'novel_foreshadowing', column: 'recover_by_chapter', kind: 'scalar', nullable: true },
  { table: 'novel_foreshadowing', column: 'beats', kind: 'events' },
  { table: 'novel_locations', column: 'appear_chapters', kind: 'list' },
  // novel_locations.first_chapter 是首次出场章（与 appear_chapters 并存），同样需要重排
  { table: 'novel_locations', column: 'first_chapter', kind: 'scalar', nullable: true },
  // ── 2026-08-11 生成链路专项审查补漏 ──
  // 线索 / 道具 / 剧情轨道：chapter_spans 跨度（与 conflict 同模式）
  { table: 'novel_clues', column: 'chapter_spans', kind: 'spans' },
  { table: 'novel_items', column: 'chapter_spans', kind: 'spans' },
  { table: 'novel_items', column: 'first_chapter', kind: 'scalar', nullable: true },
  { table: 'novel_narratives', column: 'chapter_spans', kind: 'spans' },
  // 故事事件账本：NOT NULL chapter_number → 被删章的行随之删除（事件隶属该章）
  { table: 'novel_story_events', column: 'chapter_number', kind: 'scalar', nullable: false },
  // 钩子：埋设章 NOT NULL（被删章的行删除）；兑现章可空（置 NULL 保留钩子）
  { table: 'novel_hooks', column: 'chapter_number', kind: 'scalar', nullable: false },
  { table: 'novel_hooks', column: 'fulfilled_at_chapter', kind: 'scalar', nullable: true },
  // 章节聊天 / 讨论运行：隶属章节的对话记录，被删章的行删除，其余前移
  { table: 'novel_chapter_chat_messages', column: 'chapter_number', kind: 'scalar', nullable: false },
  { table: 'novel_discussion_runs', column: 'chapter_number', kind: 'scalar', nullable: false },
  // 批注范围端点：可空，命中被删章置 NULL（保留批注本体）
  { table: 'novel_annotations', column: 'chapter_start', kind: 'scalar', nullable: true },
  { table: 'novel_annotations', column: 'chapter_end', kind: 'scalar', nullable: true },
  // 关系最近推进章：可空标记，命中被删章置 NULL
  { table: 'novel_relationships', column: 'last_updated_chapter', kind: 'scalar', nullable: true },
  // 上下文成本埋点：与 agent_logs 同口径（被删章的行删除，其余前移）
  { table: 'novel_context_section_metrics', column: 'chapter_number', kind: 'scalar', nullable: false },
  // 卷级节拍表：NOT NULL chapter_number → 被删章的节拍行删除，其余前移，
  // 否则删章后节拍仍指向旧章号，节拍↔章节映射静默错位
  { table: 'novel_beat_plans', column: 'chapter_number', kind: 'scalar', nullable: false },
  // 信息层揭示章：可空 → 命中被删章置 NULL（保留信息层本体，揭示计划失效待作者重排）
  { table: 'novel_information_layers', column: 'reveal_chapter', kind: 'scalar', nullable: true },
  // 实体候选章号：可空 → 命中被删章置 NULL（候选的 content_revision 已随章节级联删除）
  { table: 'novel_entity_candidates', column: 'chapter_number', kind: 'scalar', nullable: true },
  // 工作流运行快照：NOT NULL → 被删章的 run 行删除，其余前移。
  // 不重排的话 getLatestResumable(新 N 章) 会捞出旧章号的半成品快照，
  // resumable-runs 列表也会把断点挂到错误章节下
  { table: 'novel_workflow_runs', column: 'chapter_number', kind: 'scalar', nullable: false },
]

// 启动时校验 CHAPTER_RENUMBER_FIELDS 的标识符合法性（防御性，防止未来误传用户输入）
// 模块加载时即校验，运行时无额外开销
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
for (const f of CHAPTER_RENUMBER_FIELDS) {
  if (!IDENT_RE.test(f.table)) throw new Error(`非法 table 标识符: ${f.table}`)
  if (!IDENT_RE.test(f.column)) throw new Error(`非法 column 标识符: ${f.column}`)
}
