/**
 * matrix-logic：章节-实体矩阵视图的纯函数模块
 *
 * 数据模型：
 * - MatrixGroup：分组（角色/冲突/伏笔/势力/地点/世界要素）
 * - MatrixEntity：实体行，包含该实体在矩阵中的渲染所需数据
 * - 单元格符号系统由调用方根据 entity 的字段计算
 *
 * 与旧 timeline 的区别：
 * - 不输出 Track/Clip，输出扁平的 Group[] + MatrixEntity
 * - 跨度/伏笔的起止由纯函数计算，渲染层负责绘制色带/连线
 */

import type {
  NovelCharacter,
  NovelChapter,
  NovelConflict,
  NovelClue,
  NovelForeshadow,
  NovelFaction,
  NovelLocation,
  NovelItem,
  NovelCharacterHistory,
  ForeshadowBeatType,
} from '@/api/novel-client'

// buildGroups 已迁移至 ./matrix-model，此处保留 re-export 以向后兼容
export { buildGroups } from './matrix-model'

// ── 实体类型（分组）──

export type MatrixEntityKind =
  | 'character'
  | 'conflict'
  | 'clue'
  | 'foreshadow'
  | 'faction'
  | 'location'
  | 'world_element'
  | 'info_layer'
  | 'item'
  | 'narrative'

/** 联动右侧详情面板时使用的实体类型 */
export type SelectableEntityType = MatrixEntityKind

/**
 * 实体快照投影到子轨道的最小数据单元。
 *
 * ChangeRecord 是子轨道的权威历史来源；存量项目中的实体往往还没有完整账本，
 * 因此矩阵保留一份当前快照作为可见的保底数据。账本中出现同 key 的记录后会在
 * matrix-model 中优先使用账本轨道，避免把快照误当成逐章历史。
 */
export type MatrixSubtrackSnapshotValueType =
  | 'enum'
  | 'level'
  | 'number'
  | 'set'
  | 'reference'
  | 'text'

export interface MatrixSubtrackSnapshot {
  /** 与 ChangeRecord.dimension 对齐的稳定维度 key */
  key: string
  /** 左侧轨道显示名 */
  label: string
  valueType: MatrixSubtrackSnapshotValueType
  value: unknown
  /** hover 卡展示值；保留 value 的原始类型供 number / set 编码计算 */
  displayValue?: string
  /** 当前快照在矩阵中的锚点章节 */
  chapter: number
  /** enum / level 快照可覆盖实体已知的有效片段（保留非连续跨度） */
  spans?: Array<[number, number]>
  /** hover 卡说明，标识该值是静态快照而非账本历史 */
  desc?: string
}

// ── 拖拽数据载荷（@dnd-kit useDraggable.data）──
// 四种拖源统一用 source 字段区分，放置时由 MatrixView 根据 source 分发到不同业务回调。

/** 从侧边栏拖入实体（新增出场） */
export interface SidebarDragData {
  source: 'sidebar'
  entityType: MatrixEntityKind
  entityId: string
  name: string
  color: string
}

/** 拖动跨度端点（conflict/faction/foreshadow 调整起止章节） */
export interface EndpointDragData {
  source: 'endpoint'
  entityType: MatrixEntityKind
  entityId: string
  /** 'start' = 起点（firstChapter / 埋设点），'end' = 终点（lastChapter / 回收点） */
  end: 'start' | 'end'
  origChapter: number
  /** conflict/faction 多段跨度中的段索引（foreshadow 单段恒为 0） */
  spanIndex: number
}

/** 拖动整段跨度（conflict/faction/item 保持时长平移） */
export interface SpanDragData {
  source: 'span'
  entityType: 'conflict' | 'faction' | 'item'
  entityId: string
  spanIndex: number
  startChapter: number
  endChapter: number
}

/** 拖动已出场单元格（character/location 移动到新章节） */
export interface CellDragData {
  source: 'cell'
  entityType: MatrixEntityKind
  entityId: string
  chapter: number
}

export type MatrixDragData = SidebarDragData | EndpointDragData | SpanDragData | CellDragData

// ── 分组元数据 ──

export interface GroupMeta {
  id: MatrixEntityKind
  name: string
  /** hex 颜色（CSS color） */
  color: string
  /** "r,g,b" 形式，用于 rgba() 表达式 */
  colorRgb: string
  /** 分组图标符号（demo 用单字符） */
  icon: string
}

export const GROUP_META: Record<MatrixEntityKind, GroupMeta> = {
  character: { id: 'character', name: '角色', color: '#3b82f6', colorRgb: '59,130,246', icon: '●' },
  conflict: { id: 'conflict', name: '冲突', color: '#e8463a', colorRgb: '232,70,58', icon: '▲' },
  clue: { id: 'clue', name: '线索', color: '#22c55e', colorRgb: '34,197,94', icon: '◇' },
  foreshadow: { id: 'foreshadow', name: '伏笔', color: '#f59e0b', colorRgb: '245,158,11', icon: '◐' },
  faction: { id: 'faction', name: '势力', color: '#a855f7', colorRgb: '168,85,247', icon: '◆' },
  location: { id: 'location', name: '地点', color: '#06b6d4', colorRgb: '6,182,212', icon: '◇' },
  world_element: { id: 'world_element', name: '世界要素', color: '#4b3fe3', colorRgb: '75,63,227', icon: '■' },
  info_layer: { id: 'info_layer', name: '信息差', color: '#14b8a6', colorRgb: '20,184,166', icon: '◈' },
  item: { id: 'item', name: '物品', color: '#d97706', colorRgb: '217,119,6', icon: '✦' },
  narrative: { id: 'narrative', name: '剧情', color: '#0f766e', colorRgb: '15,118,110', icon: '≋' },
}

/** 分组顺序（角色→剧情→冲突→线索→伏笔→势力→地点→世界要素→信息差→物品） */
export const GROUP_ORDER: MatrixEntityKind[] = [
  'character', 'narrative', 'conflict', 'clue', 'foreshadow', 'faction', 'location', 'world_element', 'info_layer', 'item',
]

// ── 甘特图网格层级 ──

/** 判断章节列是否为主分隔线位置（每 10 章） */
export function isMajorGridline(ch: number): boolean {
  return ch % 10 === 0
}

/** 判断章节列是否为次分隔线位置（每 5 章，排除主分隔线） */
export function isMinorGridline(ch: number): boolean {
  return ch % 5 === 0 && !isMajorGridline(ch)
}

// ── 实体（矩阵行）──

export interface MatrixEntity {
  /** 唯一 ID（用于 React key，与原实体 ID 一致） */
  id: string
  /** 分组类型 */
  kind: MatrixEntityKind
  /** 显示名称 */
  name: string
  /** 联动右侧详情面板：实体 ID */
  entityId: string
  /** 联动右侧详情面板：实体类型 */
  entityType: SelectableEntityType
  /** 主角标记（角色专用，影响圆点大小） */
  isProtagonist?: boolean
  /** 子标签（如"主要冲突"/"次要冲突"/"已回收"/"待回收"） */
  subLabel?: string
  /** 批注（来自 type='clip-note' 的 marker，按 entityId 匹配） */
  note?: string

  // ── 角色出场：按连续跨度分组 ──
  /** 角色出场章节跨度（相邻章节合并为一段） */
  characterSpans?: Array<{ start: number; end: number }>

  // ── 冲突/势力跨度（多段）──
  /** 多段章节跨度（如 [[1,3],[10,12]]），空数组表示未放置 */
  chapterSpans?: Array<[number, number]>
  /** 整体跨度起始章节（含）= chapterSpans[0][0]，空数组时为 null */
  spanStart?: number | null
  /** 整体跨度结束章节（含）= chapterSpans[last][1]，空数组时为 null */
  spanEnd?: number | null

  /**
   * 伏笔跨度终点的语义：这个终点是**事实**还是**意图**。
   *
   * `spanEnd = payoffChapter ?? recoverByChapter` 把两件事压成了同一个数：
   *   - `payoff`：已经回收到第 N 章（事实，来自 beats）
   *   - `planned`：计划在第 N 章前回收，目前还欠着（意图，来自 recoverByChapter）
   *
   * 此前同一根虚线同时表示这两种含义，看不出「已还」还是「欠着」；
   * 而拖动跨度终点在后者情况下改的是**计划**，不是事实。
   * 渲染层据此区分线型与端点，拖拽提示也据此说明改的是什么。
   */
  spanEndKind?: 'payoff' | 'planned' | null

  // ── 冲突高潮标记 ──
  /** 冲突预计爆发章节（高潮目标章节，矩阵中显示火焰标记） */
  climaxChapter?: number | null

  // ── 伏笔埋设/回收 ──
  /** 伏笔埋设章节 */
  plantChapter?: number | null
  /** 伏笔回收章节（null 表示待回收） */
  payoffChapter?: number | null
  /** 伏笔实际发生的离散事件节点 */
  foreshadowBeats?: NonNullable<NovelForeshadow['beats']>

  // ── 地点出场 ──
  /** 地点出场章节列表 */
  appearChapters?: number[]

  // ── 世界要素常驻（默认全程） ──
  /** 世界要素起始章节（默认 1） */
  alwaysStart?: number
  /** 世界要素结束章节（默认 maxChapter） */
  alwaysEnd?: number

  // ── 信息差隐藏期 / 揭示点 ──
  /** 信息差在矩阵中可见的隐藏期起点（当前模型无创建章节时为第 1 章） */
  infoStart?: number
  /** 信息差隐藏期终点（未揭示时延续到最后一章） */
  infoEnd?: number
  /** 信息差揭示章节（null 表示尚未揭示） */
  revealChapter?: number | null

  // ── 子甘特图轨道数据（复合片段展开用，从原实体透传）──
  /** 冲突：强度曲线点 */
  intensityPoints?: Array<{ chapter: number; value: number }>
  /** 冲突：参与方按章节范围关联 */
  participantSpans?: Array<{ characterId: string; startCh: number; endCh: number }>
  /** 冲突：关键转折点 */
  turningPoints?: Array<{ chapter: number; label: string }>
  /** 冲突：解决进度曲线 */
  resolutionProgress?: Array<{ chapter: number; percent: number }>
  /** 冲突：关联线索 ID 列表 */
  linkedClues?: string[]
  /** 伏笔：回收进度点 */
  resolutionPoints?: Array<{ chapter: number; label: string }>
  /** 伏笔埋设/回收手法（沿用后端字段） */
  plantMethod?: string
  recoverMethod?: string

  /**
   * 非账本实体字段的子轨道保底投影。
   * 与账本同 key 的轨道由 matrix-model 合并时自动让位给 ChangeRecord。
   */
  subtrackSnapshots?: MatrixSubtrackSnapshot[]

  /**
   * 未上线：实体已创建但还没被放到任何章节。
   *
   * 这类实体此前会被 buildGroups 直接跳过，在矩阵里完全不可见。
   * 现在照常占一行（跨度为空 → 整行空单元格），双击任一章即就地上线。
   */
  pending?: boolean
}

// ── 分组 ──

export interface MatrixGroup {
  id: MatrixEntityKind
  name: string
  color: string
  colorRgb: string
  icon: string
  entities: MatrixEntity[]
}

export interface MatrixData {
  groups: MatrixGroup[]
  maxChapter: number
}

// ── 纯函数 ──

/**
 * 将章节号数组按连续相邻分组为 [start,end] 跨度
 * （从 timeline-logic 迁移，timeline 目录删除后矩阵视图复用）
 */
export function groupContiguousSpans(chapters: number[]): Array<{ start: number; end: number }> {
  if (chapters.length === 0) return []
  const sorted = Array.from(new Set(chapters)).sort((a, b) => a - b)
  const spans: Array<{ start: number; end: number }> = []
  let cur = { start: sorted[0], end: sorted[0] }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === cur.end + 1) cur.end = sorted[i]
    else { spans.push(cur); cur = { start: sorted[i], end: sorted[i] } }
  }
  spans.push(cur)
  return spans
}

/**
 * 计算角色出场章节跨度（从 characterHistory 提取 chapterNumber）
 */
export function computeCharacterSpans(
  history: Array<{ chapterNumber: number | null }>,
): Array<{ start: number; end: number }> {
  const chapters = history
    .map((h) => h.chapterNumber)
    .filter((n): n is number => n != null)
  return groupContiguousSpans(chapters)
}

/**
 * 计算跨度实体的整体起止章节（冲突/势力）
 * spanStart = spans[0][0]，spanEnd = spans[last][1]
 * @returns { start, end } 或 null（spans 为空）
 */
export function computeSpanRange(
  spans: Array<[number, number]>,
): { start: number; end: number } | null {
  if (spans.length === 0) return null
  return { start: spans[0][0], end: spans[spans.length - 1][1] }
}

/**
 * 按章节偏移平移一段跨度，并把结果限制在矩阵边界内。
 * 时间轴整体拖动保持跨度时长不变，端点裁剪仍由 EndpointDragData 负责。
 */
export function shiftChapterSpan(
  span: readonly [number, number],
  deltaChapters: number,
  maxChapter: number,
): [number, number] {
  const duration = Math.max(0, span[1] - span[0])
  const maxStart = Math.max(1, maxChapter - duration)
  const start = Math.min(maxStart, Math.max(1, span[0] + deltaChapters))
  return [start, start + duration]
}

/**
 * 在多段跨度中查找包含指定章节的那一段
 * @returns [start, end] 或 null（不在任何一段中）
 */
export function findSpanAt(
  spans: Array<[number, number]>,
  chapter: number,
): [number, number] | null {
  for (const span of spans) {
    if (chapter >= span[0] && chapter <= span[1]) return span
  }
  return null
}

/**
 * 把新区间合并进现有跨度列表：
 * - 与新区间相交（含相邻）的段合并为一个段 [min, max]
 * - 不相交的段保留
 * - 结果按 start 升序排序
 *
 * 用于拖入标记出场（conflict/faction/item/clue 共用，P2-2a 去重）与
 * EntitySpanDialog 提交：对话框编辑单段，需保留其他段不被覆盖。
 *
 * 注：双侧相邻（[1,2],[4,5] 插 3）会正确合并为 [1,5]——此前 conflict/faction/item
 * 的三份内联实现只扩展其中一侧，留下本应相连的两段。
 */
export function mergeSpanIntoList(
  existing: Array<[number, number]>,
  newSpan: [number, number],
): Array<[number, number]> {
  const [ns, ne] = newSpan
  let mergedStart = ns
  let mergedEnd = ne
  const kept: Array<[number, number]> = []
  for (const [s, e] of existing) {
    // 相交或相邻（区间 [s,e] 与 [mergedStart,mergedEnd] 有重叠或首尾相连）
    const overlaps = s <= mergedEnd + 1 && e >= mergedStart - 1
    if (overlaps) {
      mergedStart = Math.min(mergedStart, s)
      mergedEnd = Math.max(mergedEnd, e)
    } else {
      kept.push([s, e])
    }
  }
  const result: Array<[number, number]> = [...kept, [mergedStart, mergedEnd]]
  result.sort((a, b) => a[0] - b[0])
  return result
}

/**
 * 计算伏笔的埋设→回收连线
 * @param first 埋设章节
 * @param recover 回收章节（null 表示未回收）
 * 未回收时不再延伸到末章，避免把所有后续章节误解为关联章节。
 */
export function computeForeshadowLine(
  first: number | null,
  recover: number | null,
  _maxChapter: number,
): { start: number; end: number; recovered: boolean } | null {
  if (first == null) return null
  if (recover == null) {
    return { start: first, end: first, recovered: false }
  }
  return { start: first, end: recover, recovered: true }
}

/**
 * 伏笔空单元格的左键快捷语义。
 *
 * - 尚无埋设点，或点击位于现有埋设点之前：设置/前移埋设点
 * - 埋设与回收之间：快速新增“强化”节点
 * - 已有节点、回收点及其后方：不执行隐式修改，交给右键菜单精确处理
 */
export function resolveForeshadowLeftClickBeat(
  beats: NonNullable<NovelForeshadow['beats']>,
  chapter: number,
): ForeshadowBeatType | null {
  if (beats.some((beat) => beat.chapter === chapter)) return null

  const plant = beats.find((beat) => beat.type === 'plant')
  if (!plant || chapter < plant.chapter) return 'plant'

  const payoff = beats.find((beat) => beat.type === 'payoff')
  if (payoff && chapter >= payoff.chapter) return null

  return 'reinforce'
}

/** 新增或修改同章伏笔节点；修改类型时保留该章已有的具体内容。 */
export function upsertForeshadowBeat(
  beats: NonNullable<NovelForeshadow['beats']>,
  chapter: number,
  type: ForeshadowBeatType,
): NonNullable<NovelForeshadow['beats']> {
  const current = beats.find((beat) => beat.chapter === chapter)
  const withoutChapter = beats.filter((beat) => beat.chapter !== chapter)
  const base = type === 'plant' || type === 'payoff'
    ? withoutChapter.filter((beat) => beat.type !== type)
    : withoutChapter
  return [
    ...base,
    {
      chapter,
      type,
      ...(current?.note ? { note: current.note } : {}),
    },
  ].sort((a, b) => a.chapter - b.chapter)
}

/** 更新一个既有伏笔节点的具体内容；空白内容表示清除 note 字段。 */
export function setForeshadowBeatNote(
  beats: NonNullable<NovelForeshadow['beats']>,
  chapter: number,
  note: string,
): NonNullable<NovelForeshadow['beats']> {
  const trimmed = note.trim()
  return beats.map((beat) => {
    if (beat.chapter !== chapter) return beat
    return trimmed
      ? { ...beat, note: trimmed }
      : { chapter: beat.chapter, type: beat.type }
  })
}

/** 拖动埋设/回收端点时移动完整节点，避免丢失节点内容。 */
export function moveForeshadowEndpointBeat(
  beats: NonNullable<NovelForeshadow['beats']>,
  type: Extract<ForeshadowBeatType, 'plant' | 'payoff'>,
  chapter: number,
): NonNullable<NovelForeshadow['beats']> {
  const current = beats.find((beat) => beat.type === type)
  if (!current) return beats
  return [
    ...beats.filter((beat) => beat.type !== type && beat.chapter !== chapter),
    { ...current, chapter },
  ].sort((a, b) => a.chapter - b.chapter)
}

/**
 * 计算最大章节号（至少 20，保证矩阵有足够宽度）
 */
export function computeMaxChapter(chapters: NovelChapter[]): number {
  if (chapters.length === 0) return 20
  const numbers = chapters.map((c) => c.chapterNumber)
  const valid = numbers.filter((n) => typeof n === 'number' && !Number.isNaN(n))
  if (valid.length === 0) return 20
  return Math.max(...valid, 20)
}

/** buildPool 的返回值：尚未放置到任何章节的实体 */
export interface MatrixPool {
  poolCharacters: NovelCharacter[]
  poolConflicts: NovelConflict[]
  poolClues: NovelClue[]
  poolForeshadows: NovelForeshadow[]
  poolFactions: NovelFaction[]
  poolLocations: NovelLocation[]
  poolItems: NovelItem[]
}

/**
 * 构建元素池：未在矩阵中出现的实体（拖入候选）
 */
export function buildPool(params: {
  characters: NovelCharacter[]
  conflicts: NovelConflict[]
  clues: NovelClue[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  items: NovelItem[]
  characterHistory: NovelCharacterHistory[]
}): MatrixPool {
  const { characters, conflicts, clues, foreshadows, factions, locations, items, characterHistory } = params
  const poolCharacters: NovelCharacter[] = []
  for (const c of characters) {
    const history = characterHistory.filter((h) => h.characterId === c.id)
    if (history.length === 0) {
      poolCharacters.push(c)
      continue
    }
    const chapters = history.map((h) => h.chapterNumber).filter((n): n is number => n != null)
    if (chapters.length === 0) poolCharacters.push(c)
  }
  return {
    poolCharacters,
    poolConflicts: conflicts.filter((c) => c.chapterSpans.length === 0),
    poolClues: clues.filter((c) => !c.chapterSpans || c.chapterSpans.length === 0),
    poolForeshadows: foreshadows.filter((f) => f.firstChapter == null),
    poolFactions: factions.filter((f) => f.chapterSpans.length === 0),
    poolLocations: locations.filter((l) => !l.appearChapters || l.appearChapters.length === 0),
    poolItems: items.filter((it) => !it.chapterSpans || it.chapterSpans.length === 0),
  }
}

/**
 * 把「未上线」实体补进各自的分组。
 *
 * 背景：新建的实体只要还没被放到任何章节，`buildGroups` 就会 `continue` 跳过它，
 * 于是它在矩阵里完全不存在。此前 `buildPool` 的产物只有一个消费点 ——
 * 工具栏「补全历史」按钮上的角标数字，点下去把所有无历史角色批量塞到第 1 章
 * （`matrix-workspace.tsx` 硬编码 `chapterNumber: 1`）。写作者既看不到这些实体，
 * 也没有「把它放到第 N 章」的入口，只有一个「全部塞进第 1 章」的粗暴操作。
 *
 * 这里不新开一个「未上线」分组，而是把它们挂到**自己那一类**的分组末尾，
 * 标记 `pending: true`。原因是 `MatrixGroup.id` 的类型就是 `MatrixEntityKind`，
 * 新增一个合成分组 id 需要拓宽这个联合类型，而它被五处平行 switch 消费
 * （`GROUP_META` / `computeCellSymbol` / `emptyCellHint|presentCellHint` /
 * `markLabel|removeLabel|markTooltip|removeTooltip`），改动面远超本项收益 ——
 * 那是 `ENTITY_INTERACTION_SPEC` 统一交互语义时该一起做的事。
 * 保持 kind 不变则五处 switch 全部照常工作，行也复用现有的 EntityRow：
 * 跨度为空 → 整行空单元格 → 双击任一章即就地上线。
 */
export function appendPendingEntities(groups: MatrixGroup[], pool: MatrixPool): MatrixGroup[] {
  const pendingByKind: Partial<Record<MatrixEntityKind, Array<{ id: string; name: string }>>> = {
    character: pool.poolCharacters.map((c) => ({ id: c.id, name: c.name })),
    conflict: pool.poolConflicts.map((c) => ({ id: c.id, name: c.description })),
    clue: pool.poolClues.map((c) => ({ id: c.id, name: c.description })),
    foreshadow: pool.poolForeshadows.map((f) => ({ id: f.id, name: f.description })),
    faction: pool.poolFactions.map((f) => ({ id: f.id, name: f.name })),
    location: pool.poolLocations.map((l) => ({ id: l.id, name: l.name })),
    item: pool.poolItems.map((it) => ({ id: it.id, name: it.name })),
  }

  return groups.map((group) => {
    const pending = pendingByKind[group.id]
    if (!pending || pending.length === 0) return group
    // 已在矩阵中的实体优先；未上线的沉到组末尾，避免打散既有阅读顺序
    const existingIds = new Set(group.entities.map((e) => e.entityId))
    const extra = pending
      .filter((p) => !existingIds.has(p.id))
      .map<MatrixEntity>((p) => ({
        id: p.id,
        kind: group.id,
        name: p.name || '未命名',
        entityId: p.id,
        entityType: group.id,
        subLabel: '未上线',
        pending: true,
      }))
    if (extra.length === 0) return group
    return { ...group, entities: [...group.entities, ...extra] }
  })
}

// ── 单元格符号计算（渲染层使用）──

export type CellSymbol =
  | { type: 'empty' }
  | { type: 'present'; protagonist: boolean }
  | { type: 'span-start' }
  | { type: 'span-end' }
  | { type: 'span-middle' }
  | { type: 'conflict-climax' }
  | { type: 'clue-progress' }
  | { type: 'foreshadow-plant' }
  | { type: 'foreshadow-reinforce' }
  | { type: 'foreshadow-reveal' }
  | { type: 'foreshadow-payoff' }
  | { type: 'location' }
  | { type: 'world-element' }
  | { type: 'info-layer' }

/**
 * 计算实体在某章的单元格符号
 */
export function computeCellSymbol(
  entity: MatrixEntity,
  chapterNumber: number,
): CellSymbol {
  switch (entity.kind) {
    case 'character': {
      const spans = entity.characterSpans ?? []
      const inSpan = spans.some((s) => chapterNumber >= s.start && chapterNumber <= s.end)
      if (inSpan) return { type: 'present', protagonist: entity.isProtagonist ?? false }
      return { type: 'empty' }
    }
    case 'conflict':
    case 'faction':
    case 'item':
    case 'narrative': {
      // 冲突高潮章节优先于跨度符号（火焰标记更醒目）
      if (entity.kind === 'conflict' && entity.climaxChapter != null && entity.climaxChapter === chapterNumber) {
        return { type: 'conflict-climax' }
      }
      const spans = entity.chapterSpans ?? []
      const span = findSpanAt(spans, chapterNumber)
      if (span == null) return { type: 'empty' }
      if (chapterNumber === span[0]) return { type: 'span-start' }
      if (chapterNumber === span[1]) return { type: 'span-end' }
      return { type: 'span-middle' }
    }
    case 'foreshadow': {
      // 新数据使用离散事件链；旧数据仍从 plantChapter/payoffChapter 显示端点。
      const beat = entity.foreshadowBeats?.find((item) => item.chapter === chapterNumber)
      if (beat?.type === 'plant') return { type: 'foreshadow-plant' }
      if (beat?.type === 'reinforce') return { type: 'foreshadow-reinforce' }
      if (beat?.type === 'reveal') return { type: 'foreshadow-reveal' }
      if (beat?.type === 'payoff') return { type: 'foreshadow-payoff' }
      if (entity.plantChapter === chapterNumber) return { type: 'foreshadow-plant' }
      if (entity.payoffChapter === chapterNumber) return { type: 'foreshadow-payoff' }
      return { type: 'empty' }
    }
    case 'clue': {
      const span = findSpanAt(entity.chapterSpans ?? [], chapterNumber)
      return span == null ? { type: 'empty' } : { type: 'clue-progress' }
    }
    case 'location': {
      const appears = entity.appearChapters ?? []
      if (appears.includes(chapterNumber)) return { type: 'location' }
      return { type: 'empty' }
    }
    case 'world_element': {
      const start = entity.alwaysStart ?? 1
      const end = entity.alwaysEnd ?? 1
      if (chapterNumber >= start && chapterNumber <= end) return { type: 'world-element' }
      return { type: 'empty' }
    }
    case 'info_layer': {
      const start = entity.infoStart ?? 1
      const end = entity.infoEnd ?? start
      return chapterNumber >= start && chapterNumber <= end
        ? { type: 'info-layer' }
        : { type: 'empty' }
    }
  }
}

// ── TensionLevel 色阶（借鉴 PlotPilot TensionLevel 10 级非线性标度）──
// 1-2 LOW      → bg-amber-100
// 3-4 RISING   → bg-amber-200
// 5-6 ELEVATED → bg-amber-300
// 7   HIGH     → bg-amber-500
// 8   HIGH+    → bg-red-400
// 9   INTENSE  → bg-red-500
// 10  EXTREME  → bg-red-600

const TENSION_BG_MAP: Record<number, string> = {
  1: 'bg-amber-100',
  2: 'bg-amber-100',
  3: 'bg-amber-200',
  4: 'bg-amber-200',
  5: 'bg-amber-300',
  6: 'bg-amber-300',
  7: 'bg-amber-500',
  8: 'bg-red-400',
  9: 'bg-red-500',
  10: 'bg-red-600',
}

const TENSION_LABEL_MAP: Record<number, string> = {
  1: 'LOW',
  2: 'LOW',
  3: 'RISING',
  4: 'RISING',
  5: 'ELEVATED',
  6: 'ELEVATED',
  7: 'HIGH',
  8: 'HIGH',
  9: 'INTENSE',
  10: 'EXTREME',
}

export function tensionToBgClass(tension: number | null | undefined): string {
  if (tension == null) return ''
  return TENSION_BG_MAP[tension] ?? ''
}

export function tensionToLabel(tension: number | null | undefined): string {
  if (tension == null) return ''
  return TENSION_LABEL_MAP[tension] ?? ''
}
