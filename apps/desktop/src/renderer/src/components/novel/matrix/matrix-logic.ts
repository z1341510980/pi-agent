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
  NovelWorldElement,
  NovelItem,
  NovelCharacterHistory,
  ConflictTier,
  ForeshadowBeatType,
} from '@/api/novel-client'

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

/** 联动右侧详情面板时使用的实体类型 */
export type SelectableEntityType = MatrixEntityKind

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
}

/** 分组顺序（角色→冲突→线索→伏笔→势力→地点→世界要素→信息差→物品） */
export const GROUP_ORDER: MatrixEntityKind[] = [
  'character', 'conflict', 'clue', 'foreshadow', 'faction', 'location', 'world_element', 'info_layer', 'item',
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
 * 构建矩阵分组数据
 * 输入：store 中的小说数据
 * 输出：MatrixData { groups, maxChapter }
 */
export function buildGroups(params: {
  chapters: NovelChapter[]
  characters: NovelCharacter[]
  conflicts: NovelConflict[]
  clues: NovelClue[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  worldElements: NovelWorldElement[]
  items: NovelItem[]
  characterHistory: NovelCharacterHistory[]
  /** 标记列表（用于填充 entity.note） */
  markers?: Array<{ type: string; entityId: string | null; note: string }>
}): MatrixData {
  const {
    chapters, characters, conflicts, clues, foreshadows, factions, locations, worldElements,
    items, characterHistory, markers,
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
      // 子甘特图轨道数据透传
      intensityPoints: conflict.intensityPoints,
      participantSpans: conflict.participantSpans,
      turningPoints: conflict.turningPoints,
      resolutionProgress: conflict.resolutionProgress,
      linkedClues: conflict.linkedClues,
    })
  }
  groups.push(conflictGroup)

  // ── 线索分组（只渲染实际发现/推进节点）──
  const clueGroup: MatrixGroup = {
    ...GROUP_META.clue,
    entities: [],
  }
  for (const clue of clues) {
    const spans = clue.chapterSpans ?? []
    const range = computeSpanRange(spans)
    if (range == null) continue
    clueGroup.entities.push({
      id: clue.id,
      kind: 'clue',
      name: clue.description,
      entityId: clue.id,
      entityType: 'clue',
      subLabel: `${clue.progress}% · ${clue.isMisleading ? '误导线索' : '真实线索'}`,
      chapterSpans: spans,
      spanStart: range.start,
      spanEnd: range.end,
      note: noteMap.get(clue.id),
    })
  }
  groups.push(clueGroup)

  // ── 伏笔分组 ──
  const foreshadowGroup: MatrixGroup = {
    ...GROUP_META.foreshadow,
    entities: [],
  }
  for (const f of foreshadows) {
    // 伏笔以 firstChapter（埋设点）作为入矩阵条件；无埋设点 → 元素池。
    // 仅实际事件节点占用章节格，虚线只表达节点之间的先后关系。
    if (f.firstChapter == null) continue
    const beats = f.beats && f.beats.length > 0
      ? [...f.beats].sort((a, b) => a.chapter - b.chapter)
      : [
          { chapter: f.firstChapter, type: 'plant' as const },
          ...(f.recoverByChapter != null ? [{ chapter: f.recoverByChapter, type: 'payoff' as const }] : []),
        ]
    const isRecovered = beats.some((beat) => beat.type === 'payoff')
    foreshadowGroup.entities.push({
      id: f.id,
      kind: 'foreshadow',
      name: f.description,
      entityId: f.id,
      entityType: 'foreshadow',
      subLabel: `${beats.length} 个节点 · ${isRecovered ? '已回收' : '待回收'}`,
      plantChapter: f.firstChapter,
      payoffChapter: f.recoverByChapter,
      foreshadowBeats: beats,
      spanStart: f.firstChapter,
      spanEnd: f.recoverByChapter ?? null,
      note: noteMap.get(f.id),
      // 子甘特图轨道数据透传
      resolutionPoints: f.resolutionPoints,
      plantMethod: f.plantMethod,
      recoverMethod: f.recoverMethod,
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

  // 信息差暂时只在侧边栏管理，但保留空分组以使轨道顺序、筛选项和折叠状态一致。
  groups.push({
    ...GROUP_META.info_layer,
    entities: [],
  })

  // ── 物品分组（按 chapterSpans 渲染跨度，类似势力）──
  const itemGroup: MatrixGroup = {
    ...GROUP_META.item,
    entities: [],
  }
  const itemStatusLabels: Record<string, string> = {
    active: '持有',
    lost: '丢失',
    destroyed: '损毁',
    transformed: '变化',
    sealed: '封印',
    transferred: '转手',
  }
  for (const it of items) {
    const spans = it.chapterSpans ?? []
    const range = computeSpanRange(spans)
    if (range == null) continue // 未放置 → 元素池
    itemGroup.entities.push({
      id: it.id,
      kind: 'item',
      name: it.name,
      entityId: it.id,
      entityType: 'item',
      subLabel: itemStatusLabels[it.status] ?? it.status,
      chapterSpans: spans,
      spanStart: range.start,
      spanEnd: range.end,
      note: noteMap.get(it.id),
    })
  }
  groups.push(itemGroup)

  return { groups, maxChapter }
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
}): {
  poolCharacters: NovelCharacter[]
  poolConflicts: NovelConflict[]
  poolClues: NovelClue[]
  poolForeshadows: NovelForeshadow[]
  poolFactions: NovelFaction[]
  poolLocations: NovelLocation[]
  poolItems: NovelItem[]
} {
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
    case 'item': {
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
