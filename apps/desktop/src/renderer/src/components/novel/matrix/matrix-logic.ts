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
  NovelForeshadow,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
  NovelCharacterHistory,
  ConflictTier,
} from '@/api/novel-client'

// ── 实体类型（分组）──

export type MatrixEntityKind =
  | 'character'
  | 'conflict'
  | 'foreshadow'
  | 'faction'
  | 'location'
  | 'world_element'
  | 'info_layer'

/** 联动右侧详情面板时使用的实体类型 */
export type SelectableEntityType = MatrixEntityKind

// ── 拖拽数据载荷（@dnd-kit useDraggable.data）──
// 三种拖源统一用 source 字段区分，放置时由 MatrixView 根据 source 分发到不同业务回调。

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

/** 拖动已出场单元格（character/location 移动到新章节） */
export interface CellDragData {
  source: 'cell'
  entityType: MatrixEntityKind
  entityId: string
  chapter: number
}

export type MatrixDragData = SidebarDragData | EndpointDragData | CellDragData

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
  conflict: { id: 'conflict', name: '冲突', color: '#ef4444', colorRgb: '239,68,68', icon: '▲' },
  foreshadow: { id: 'foreshadow', name: '伏笔', color: '#f59e0b', colorRgb: '245,158,11', icon: '◐' },
  faction: { id: 'faction', name: '势力', color: '#a855f7', colorRgb: '168,85,247', icon: '◆' },
  location: { id: 'location', name: '地点', color: '#06b6d4', colorRgb: '6,182,212', icon: '◇' },
  world_element: { id: 'world_element', name: '世界要素', color: '#6366f1', colorRgb: '99,102,241', icon: '■' },
  info_layer: { id: 'info_layer', name: '信息差', color: '#14b8a6', colorRgb: '20,184,166', icon: '◈' },
}

/** 分组顺序（角色→冲突→伏笔→势力→地点→世界要素→信息差） */
export const GROUP_ORDER: MatrixEntityKind[] = [
  'character', 'conflict', 'foreshadow', 'faction', 'location', 'world_element', 'info_layer',
]

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

  // ── 冲突高潮标记 ──
  /** 冲突预计爆发章节（高潮目标章节，矩阵中显示火焰标记） */
  climaxChapter?: number | null

  // ── 伏笔埋设/回收 ──
  /** 伏笔埋设章节 */
  plantChapter?: number | null
  /** 伏笔回收章节（null 表示待回收） */
  payoffChapter?: number | null

  // ── 地点出场 ──
  /** 地点出场章节列表 */
  appearChapters?: number[]

  // ── 世界要素常驻（默认全程） ──
  /** 世界要素起始章节（默认 1） */
  alwaysStart?: number
  /** 世界要素结束章节（默认 maxChapter） */
  alwaysEnd?: number
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
 * 计算伏笔的埋设→回收连线
 * @param first 埋设章节
 * @param recover 回收章节（null 表示未回收）
 * @param maxChapter 最大章节号（未回收时连线延伸到末章）
 */
export function computeForeshadowLine(
  first: number | null,
  recover: number | null,
  maxChapter: number,
): { start: number; end: number; recovered: boolean } | null {
  if (first == null) return null
  if (recover == null) {
    return { start: first, end: maxChapter, recovered: false }
  }
  return { start: first, end: recover, recovered: true }
}

/**
 * 构建矩阵分组数据
 * 输入：store 中的小说数据
 * 输出：MatrixData { groups, maxChapter }
 */
export function buildGroups(params: {
  chapters: NovelChapter[]
  characters: NovelCharacter[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  worldElements: NovelWorldElement[]
  characterHistory: NovelCharacterHistory[]
  /** 标记列表（用于填充 entity.note） */
  markers?: Array<{ type: string; entityId: string | null; note: string }>
}): MatrixData {
  const {
    chapters, characters, conflicts, foreshadows, factions, locations, worldElements,
    characterHistory, markers,
  } = params

  const maxChapter = computeMaxChapter(chapters)

  // 批注映射：entityId -> note
  const noteMap = new Map<string, string>()
  if (markers && markers.length > 0) {
    for (const m of markers) {
      if (m.type === 'clip-note' && m.entityId) {
        noteMap.set(m.entityId, m.note || '')
      }
    }
  }

  const groups: MatrixGroup[] = []

  // ── 角色分组（有历史的角色；无历史的进元素池由调用方处理）──
  const characterGroup: MatrixGroup = {
    ...GROUP_META.character,
    entities: [],
  }
  for (const character of characters) {
    const history = characterHistory.filter((h) => h.characterId === character.id)
    const spans = computeCharacterSpans(history)
    if (spans.length === 0) continue // 无历史 → 进元素池（调用方处理）
    characterGroup.entities.push({
      id: character.id,
      kind: 'character',
      name: character.name,
      entityId: character.id,
      entityType: 'character',
      isProtagonist: character.isProtagonist,
      subLabel: character.isProtagonist ? '主角' : '配角',
      characterSpans: spans,
      note: noteMap.get(character.id),
    })
  }
  groups.push(characterGroup)

  // ── 冲突分组（按 tier 分组：主要/次要/主角目的）──
  const conflictGroup: MatrixGroup = {
    ...GROUP_META.conflict,
    entities: [],
  }
  const tierLabels: Record<ConflictTier, string> = {
    main: '主要冲突',
    secondary: '次要冲突',
    goal: '主角目的',
  }
  for (const conflict of conflicts) {
    const range = computeSpanRange(conflict.chapterSpans)
    if (range == null) continue // 未放置 → 元素池
    conflictGroup.entities.push({
      id: conflict.id,
      kind: 'conflict',
      name: conflict.description,
      entityId: conflict.id,
      entityType: 'conflict',
      subLabel: tierLabels[conflict.tier ?? 'secondary'],
      chapterSpans: conflict.chapterSpans,
      spanStart: range.start,
      spanEnd: range.end,
      climaxChapter: conflict.climaxChapter ?? null,
      note: noteMap.get(conflict.id),
    })
  }
  groups.push(conflictGroup)

  // ── 伏笔分组 ──
  const foreshadowGroup: MatrixGroup = {
    ...GROUP_META.foreshadow,
    entities: [],
  }
  for (const f of foreshadows) {
    // 迁移 055：伏笔改为多段跨度（参照 conflict），保留 plant/payoff 端点语义标记
    // - chapterSpans 描述伏笔"活跃"区间，矩阵按色带样式渲染
    // - plantChapter = firstChapter（埋设点），payoffChapter = recoverByChapter（回收点）
    const range = computeSpanRange(f.chapterSpans ?? [])
    if (range == null) continue // 未放置 → 元素池
    foreshadowGroup.entities.push({
      id: f.id,
      kind: 'foreshadow',
      name: f.description,
      entityId: f.id,
      entityType: 'foreshadow',
      subLabel: f.recoverByChapter != null ? '已回收' : '待回收',
      plantChapter: f.firstChapter,
      payoffChapter: f.recoverByChapter,
      chapterSpans: f.chapterSpans ?? [],
      spanStart: range.start,
      spanEnd: range.end,
      note: noteMap.get(f.id),
    })
  }
  groups.push(foreshadowGroup)

  // ── 势力分组 ──
  const factionGroup: MatrixGroup = {
    ...GROUP_META.faction,
    entities: [],
  }
  for (const faction of factions) {
    const range = computeSpanRange(faction.chapterSpans)
    if (range == null) continue
    factionGroup.entities.push({
      id: faction.id,
      kind: 'faction',
      name: faction.name,
      entityId: faction.id,
      entityType: 'faction',
      chapterSpans: faction.chapterSpans,
      spanStart: range.start,
      spanEnd: range.end,
      note: noteMap.get(faction.id),
    })
  }
  groups.push(factionGroup)

  // ── 地点分组 ──
  const locationGroup: MatrixGroup = {
    ...GROUP_META.location,
    entities: [],
  }
  for (const location of locations) {
    const appears = (location.appearChapters ?? []).slice().sort((a, b) => a - b)
    if (appears.length === 0) continue
    locationGroup.entities.push({
      id: location.id,
      kind: 'location',
      name: location.name,
      entityId: location.id,
      entityType: 'location',
      appearChapters: appears,
      note: noteMap.get(location.id),
    })
  }
  groups.push(locationGroup)

  // ── 世界要素分组（默认全程 1..maxChapter）──
  const worldGroup: MatrixGroup = {
    ...GROUP_META.world_element,
    entities: [],
  }
  for (const w of worldElements) {
    worldGroup.entities.push({
      id: w.id,
      kind: 'world_element',
      name: w.name,
      entityId: w.id,
      entityType: 'world_element',
      alwaysStart: 1,
      alwaysEnd: maxChapter,
      note: noteMap.get(w.id),
    })
  }
  groups.push(worldGroup)

  return { groups, maxChapter }
}

/**
 * 计算最大章节号（至少 20，保证矩阵有足够宽度）
 */
export function computeMaxChapter(chapters: NovelChapter[]): number {
  if (chapters.length === 0) return 20
  return Math.max(...chapters.map((c) => c.chapterNumber), 20)
}

/**
 * 构建元素池：未在矩阵中出现的实体（拖入候选）
 */
export function buildPool(params: {
  characters: NovelCharacter[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  characterHistory: NovelCharacterHistory[]
}): {
  poolCharacters: NovelCharacter[]
  poolConflicts: NovelConflict[]
  poolForeshadows: NovelForeshadow[]
  poolFactions: NovelFaction[]
  poolLocations: NovelLocation[]
} {
  const { characters, conflicts, foreshadows, factions, locations, characterHistory } = params
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
    poolForeshadows: foreshadows.filter((f) => f.firstChapter == null),
    poolFactions: factions.filter((f) => f.chapterSpans.length === 0),
    poolLocations: locations.filter((l) => !l.appearChapters || l.appearChapters.length === 0),
  }
}

// ── 单元格符号计算（渲染层使用）──

export type CellSymbol =
  | { type: 'empty' }
  | { type: 'present'; protagonist: boolean }
  | { type: 'span-start' }
  | { type: 'span-end' }
  | { type: 'span-middle' }
  | { type: 'conflict-climax' }
  | { type: 'foreshadow-plant' }
  | { type: 'foreshadow-payoff' }
  | { type: 'foreshadow-span'; recovered: boolean }
  | { type: 'location' }
  | { type: 'world-element' }

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
    case 'faction': {
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
      // 迁移 055：伏笔改为多段跨度后，单元格符号按多段跨度判定
      // - 在跨度区间内的章节显示 foreshadow-span（中段）
      // - plant 章节显示 foreshadow-plant（埋设点语义标记，优先级高于 span-start）
      // - payoff 章节显示 foreshadow-payoff（回收点语义标记，优先级高于 span-end）
      // - 不在任何跨度内的章节显示 empty
      const plant = entity.plantChapter
      const payoff = entity.payoffChapter
      // plant/payoff 端点优先（语义标记更醒目）
      if (plant != null && chapterNumber === plant) return { type: 'foreshadow-plant' }
      if (payoff != null && chapterNumber === payoff) return { type: 'foreshadow-payoff' }
      // 在多段跨度内显示 span（中段），用 recovered 标记是否已回收
      const spans = entity.chapterSpans ?? []
      const inSpan = spans.some(([s, e]) => chapterNumber >= s && chapterNumber <= e)
      if (inSpan) {
        return { type: 'foreshadow-span', recovered: payoff != null }
      }
      return { type: 'empty' }
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
    case 'info_layer':
      // 信息差暂不在矩阵视图中渲染单元格符号（侧边栏管理）
      return { type: 'empty' }
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
