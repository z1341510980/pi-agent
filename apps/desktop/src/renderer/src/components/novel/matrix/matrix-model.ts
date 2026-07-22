/**
 * matrix-model：矩阵重设计的纯数据模型层
 *
 * 职责：
 * 1. 子轨道数据结构（SubtrackDef 等）与账本投影（NovelChangeRecord[] → SubtrackDef[]）
 *    —— 从 inline-subtracks.tsx / subtrack-builders.ts 收敛而来，全矩阵唯一数据源
 * 2. 行模型（RowSpec）：分组行 / 实体行 / 子轨道块 的统一高度与偏移计算，
 *    供垂直虚拟化与关系叠加层共用（消除 entityRowY 硬编码行高导致的 Y 偏移）
 * 3. 布局常量：全矩阵唯一的行高/标尺高定义（消除散落的魔法数）
 *
 * 渲染层（matrix-view / matrix-subtracks）只消费本模块的输出，不再各自聚合数据。
 */

import type { NovelChangeRecord } from '@/api/novel-client'
import type { MatrixEntity, MatrixEntityKind, MatrixGroup } from './matrix-logic'
import { GROUP_META } from './matrix-logic'

// ────────────────────────────────────────────────────────────
// 布局常量（全矩阵唯一）
// ────────────────────────────────────────────────────────────

export const MATRIX_LAYOUT = {
  /** 章节标尺行高 */
  rulerHeight: 40,
  /** 章尾钩子轨道行高 */
  hookRowHeight: 26,
  /** 分组头行高 */
  groupHeight: 26,
  /** 实体行高 */
  entityHeight: 32,
  /** 单条子轨道行高 */
  subtrackHeight: 26,
  /** 左侧 sticky 列默认宽度 */
  sidebarWidth: 240,
  /** 单元格宽度缩放范围 */
  minCellWidth: 24,
  maxCellWidth: 80,
  defaultCellWidth: 56,
} as const

// ────────────────────────────────────────────────────────────
// 子轨道数据结构
// ────────────────────────────────────────────────────────────

export interface SubtrackBand {
  startCh: number
  endCh: number
  label?: string
  fill: string
  border: string
  /** enum/level 维度的值标识，用于颜色映射 */
  valueKey?: string
}

export interface SubtrackCurvePoint {
  ch: number
  /** 0-1 归一化值 */
  value: number
}

export interface SubtrackNode {
  ch: number
  label: string
  color: string
  /** set 类型的徽标数字 */
  badge?: number
  /** hover 卡：变化前值（已格式化） */
  before?: string
  /** hover 卡：补充描述（reason 等） */
  desc?: string
}

export interface SubtrackDef {
  key: string
  label: string
  color: string
  colorRgb: string
  bands: SubtrackBand[]
  curve?: SubtrackCurvePoint[]
  nodes?: SubtrackNode[]
  /** enum/level 维度的图例：值 → 颜色 */
  legend?: { label: string; fill: string }[]
  emptyHint?: string
}

/** 所有实际出现在矩阵中的实体都可展开子轨道（info_layer 走侧边栏管理） */
export function isSubtrackSupported(kind: MatrixEntityKind): boolean {
  return kind !== 'info_layer'
}

// ────────────────────────────────────────────────────────────
// dimension → 友好标签
// ────────────────────────────────────────────────────────────

export const DIMENSION_LABELS: Record<string, string> = {
  // character
  'character.arc_stage': '弧光阶段',
  'character.goal': '当前目标',
  'character.pressure': '当前压力',
  'character.state': '当前状态',
  'character.cognition': '认知转变',
  'character.conflict_link': '关联冲突',
  'character.created': '登场',
  // conflict
  'conflict.stage': '冲突阶段',
  'conflict.intensity': '张力强度',
  'conflict.plot_function': '剧情功能',
  'conflict.progression_mode': '推进模式',
  'conflict.created': '建立',
  // foreshadow
  'foreshadow.beat': '事件链节点',
  'foreshadow.payoff_chapter': '回收章节',
  'foreshadow.plant_method': '埋设手法',
  'foreshadow.recover_method': '回收手法',
  'foreshadow.created': '埋设',
  // clue
  'clue.progress': '推进进度',
  'clue.step': '发现步骤',
  'clue.points_to': '指向',
  'clue.misleading': '误导性',
  'clue.created': '发现',
  // faction
  'faction.status': '势力状态',
  'faction.activity': '活动区间',
  'faction.strength': '实力消长',
  'faction.created': '成立',
  // location
  'location.status': '场景状态',
  'location.appear': '场景出现',
  'location.created': '首次出现',
  // relationship
  'relationship.stage': '关系阶段',
  'relationship.role': '角色定位',
  'relationship.alignment': '阵营归属',
  'relationship.trend': '关系走向',
  'relationship.hint': '关系提示',
  'relationship.updated': '关系更新',
  'relationship.created': '建立',
  // info_layer
  'info_layer.reader_knows': '读者已知',
  'info_layer.revealed': '揭示状态',
  'info_layer.links': '关联线索',
  'info_layer.reveal_chapter': '揭示章节',
  'info_layer.knowledge_spread': '知情角色',
  'info_layer.created': '建立',
  // item
  'item.holder': '持有者',
  'item.status': '物品状态',
  'item.function': '功能定位',
  'item.appear': '出现记录',
  'item.created': '首次出现',
}

function parseDimension(dim: string): { prefix: string; key: string } | null {
  const idx = dim.indexOf('.')
  if (idx <= 0) return null
  return { prefix: dim.slice(0, idx), key: dim.slice(idx + 1) }
}

export function resolveDimensionLabel(dimension: string): string {
  if (DIMENSION_LABELS[dimension]) return DIMENSION_LABELS[dimension]
  const parsed = parseDimension(dimension)
  return parsed ? parsed.key : dimension
}

// ────────────────────────────────────────────────────────────
// 账本投影：NovelChangeRecord[] → SubtrackDef[]
// ────────────────────────────────────────────────────────────

/**
 * 把某实体的 changes 按 dimension 分组，每组构建一条子轨道。
 * 渲染编码（紧凑视觉，无文字标签，详情走 hover 卡）：
 * - enum / level：同值连续段合并色块 + 每值透明度档位 + 变化点
 * - number：sparkline 曲线 + 数据点
 * - set：数字徽标
 * - reference / text：离散小圆点
 */
export function buildSubtracksFromChanges(
  changes: NovelChangeRecord[],
  kind: MatrixEntityKind,
): SubtrackDef[] {
  const meta = GROUP_META[kind]
  const { color, colorRgb } = meta
  if (changes.length === 0) return []

  // 按 dimension 分组（保持首次出现顺序，渲染稳定）
  const groups = new Map<string, NovelChangeRecord[]>()
  for (const c of changes) {
    if (!c.dimension) continue
    const arr = groups.get(c.dimension) ?? []
    arr.push(c)
    groups.set(c.dimension, arr)
  }
  if (groups.size === 0) return []

  const tracks: SubtrackDef[] = []
  for (const [dimension, groupChanges] of groups) {
    const sorted = [...groupChanges].sort((a, b) => a.chapterNumber - b.chapterNumber)
    const valueType = sorted[0]?.valueType
    const label = resolveDimensionLabel(dimension)

    let bands: SubtrackBand[] = []
    let curve: SubtrackCurvePoint[] | undefined
    let nodes: SubtrackNode[] | undefined
    let legend: { label: string; fill: string }[] | undefined

    switch (valueType) {
      case 'enum':
      case 'level': {
        // 值 → 透明度档位（首现顺序，3 档循环）
        const valueOrder = new Map<string, number>()
        for (const c of sorted) {
          const key = formatChangeValue(c.afterValue)
          if (!valueOrder.has(key)) valueOrder.set(key, valueOrder.size)
        }
        const OPACITY_LEVELS = [0.3, 0.6, 0.9]
        const valueToFill = (key: string): string =>
          `rgba(${colorRgb}, ${OPACITY_LEVELS[valueOrder.get(key)! % OPACITY_LEVELS.length]})`
        bands = buildEnumBands(sorted, colorRgb, valueToFill)
        legend = Array.from(valueOrder.entries()).slice(0, 4).map(([key]) => ({
          label: key,
          fill: valueToFill(key),
        }))
        nodes = sorted.map((c) => ({
          ch: c.chapterNumber,
          label: formatChangeValue(c.afterValue),
          color,
          before: formatChangeValue(c.beforeValue),
          desc: c.reason || undefined,
        }))
        break
      }
      case 'number': {
        const points = sorted
          .map((c) => ({ ch: c.chapterNumber, value: normalizeNumber(c.afterValue) }))
          .filter((p): p is SubtrackCurvePoint => p.value != null)
        curve = points.length > 1 ? points : undefined
        nodes = sorted.map((c) => ({
          ch: c.chapterNumber,
          label: formatChangeValue(c.afterValue),
          color,
          before: formatChangeValue(c.beforeValue),
          desc: c.reason || undefined,
        }))
        break
      }
      case 'set': {
        nodes = sorted.map((c) => ({
          ch: c.chapterNumber,
          label: formatChangeValue(c.afterValue),
          color,
          badge: countSetItems(c.afterValue),
          before: formatChangeValue(c.beforeValue),
          desc: c.reason || undefined,
        })).filter((n) => (n.badge ?? 0) > 0)
        break
      }
      case 'reference':
      case 'text': {
        nodes = sorted.map((c) => ({
          ch: c.chapterNumber,
          label: formatChangeValue(c.afterValue),
          color,
          before: formatChangeValue(c.beforeValue),
          desc: c.reason || undefined,
        }))
        break
      }
    }

    tracks.push({
      key: dimension,
      label,
      color,
      colorRgb,
      bands,
      curve,
      nodes,
      legend,
      emptyHint: '暂无变化记录',
    })
  }

  return tracks
}

/** 从全量聚合中按实体过滤并构建子轨道（视图层 useMemo 调用） */
export function buildSubtracksForEntity(
  allChanges: NovelChangeRecord[],
  entity: MatrixEntity,
): SubtrackDef[] {
  const filtered = allChanges.filter(
    (c) => c.subjectType === entity.kind && c.subjectId === entity.entityId,
  )
  return buildSubtracksFromChanges(filtered, entity.kind)
}

// 同值连续段合并为色带
function buildEnumBands(
  changes: NovelChangeRecord[],
  colorRgb: string,
  valueToFill?: (key: string) => string,
): SubtrackBand[] {
  const bands: SubtrackBand[] = []
  let cur: { value: unknown; start: number; end: number } | null = null
  for (const c of changes) {
    if (cur && isEqualValue(cur.value, c.afterValue)) {
      cur.end = c.chapterNumber
    } else {
      if (cur) bands.push(toBand(cur, colorRgb, valueToFill))
      cur = { value: c.afterValue, start: c.chapterNumber, end: c.chapterNumber }
    }
  }
  if (cur) bands.push(toBand(cur, colorRgb, valueToFill))
  return bands
}

function toBand(
  seg: { value: unknown; start: number; end: number },
  colorRgb: string,
  valueToFill?: (key: string) => string,
): SubtrackBand {
  const key = formatChangeValue(seg.value)
  return {
    startCh: seg.start,
    endCh: seg.end,
    label: key,
    fill: valueToFill ? valueToFill(key) : `rgba(${colorRgb}, 0.16)`,
    border: `rgba(${colorRgb}, 0.30)`,
    valueKey: key,
  }
}

function isEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((x, i) => x === b[i])
  }
  return false
}

/** 格式化 ChangeRecord 的 before/after 值为可读文本（hover 卡用） */
export function formatChangeValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) {
    // UUID 数组（关联 ID）：显示数量而非原始 ID，避免 UUID 污染
    if (value.length > 0 && value.every((v) => typeof v === 'string' && isUuidLike(v))) {
      return `${value.length} 项关联`
    }
    return value.map((v) => formatChangeValue(v)).join(', ')
  }
  if (typeof value === 'object') {
    const vals = Object.values(value as Record<string, unknown>).filter((v) => v != null && v !== '')
    if (vals.length === 0) return ''
    for (const v of vals) {
      if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && isUuidLike(x))) {
        return `${v.length} 项关联`
      }
    }
    return formatChangeValue(vals[0])
  }
  return String(value)
}

/** 检测字符串是否类似 UUID（足够长的十六进制/连字符串） */
function isUuidLike(s: string): boolean {
  return s.length >= 8 && /^[0-9a-f-]+$/i.test(s)
}

/** 计算 set 类型 afterValue 的元素数量（数字徽标用） */
function countSetItems(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') {
    const vals = Object.values(value as Record<string, unknown>)
    for (const v of vals) {
      if (Array.isArray(v)) return v.length
    }
  }
  return 0
}

/** 把任意数值归一化到 0-1（curve 纵向定位） */
function normalizeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value >= 0 && value <= 1) return value
  if (value >= 0 && value <= 10) return value / 10
  if (value >= 0 && value <= 100) return value / 100
  return Math.min(1, Math.max(0, value))
}

// ────────────────────────────────────────────────────────────
// 行模型（垂直虚拟化 + 关系叠加层共用）
// ────────────────────────────────────────────────────────────

export type MatrixRowSpec =
  | { type: 'group'; key: string; group: MatrixGroup; height: number }
  | { type: 'entity'; key: string; entity: MatrixEntity; height: number }
  | { type: 'subtracks'; key: string; entity: MatrixEntity; height: number }

export interface BuildRowSpecsParams {
  groups: MatrixGroup[]
  collapsedGroups: Set<MatrixEntityKind>
  activeFilter: MatrixEntityKind | null
  /** 已展开实体的子轨道条数（entityId → trackCount；0 表示空态单行） */
  expandedTrackCounts: Map<string, number>
}

/**
 * 按当前可见状态展开为扁平行列表（含每行高度）。
 * 顺序 = 分组顺序 × 组内实体顺序；折叠分组只保留分组头。
 */
export function buildRowSpecs({
  groups, collapsedGroups, activeFilter, expandedTrackCounts,
}: BuildRowSpecsParams): MatrixRowSpec[] {
  const rows: MatrixRowSpec[] = []
  for (const group of groups) {
    if (activeFilter != null && group.id !== activeFilter) continue
    rows.push({
      type: 'group',
      key: `group:${group.id}`,
      group,
      height: MATRIX_LAYOUT.groupHeight,
    })
    if (collapsedGroups.has(group.id)) continue
    for (const entity of group.entities) {
      rows.push({
        type: 'entity',
        key: `entity:${entity.id}`,
        entity,
        height: MATRIX_LAYOUT.entityHeight,
      })
      const trackCount = expandedTrackCounts.get(entity.entityId)
      if (trackCount != null) {
        rows.push({
          type: 'subtracks',
          key: `subtracks:${entity.id}`,
          entity,
          height: Math.max(1, trackCount) * MATRIX_LAYOUT.subtrackHeight,
        })
      }
    }
  }
  return rows
}

/** 前缀和：每行的顶部偏移（累计高度） */
export function computeRowOffsets(rows: MatrixRowSpec[]): number[] {
  const offsets: number[] = new Array(rows.length)
  let y = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = y
    y += rows[i].height
  }
  return offsets
}

/**
 * 行内网格竖线背景（CSS backgroundImage 值）：
 * 每章 1px 细线（0.06 透明），每 5 章加深（0.16）。
 * 实体行 / 子轨道行 / 标尺共用，保证全矩阵网格对齐。
 */
export function gridlineBackgroundImage(cellWidth: number): string {
  return [
    `repeating-linear-gradient(90deg, rgba(115,115,115,0.16) 0, rgba(115,115,115,0.16) 1px, transparent 1px, transparent ${cellWidth * 5}px)`,
    `repeating-linear-gradient(90deg, rgba(115,115,115,0.06) 0, rgba(115,115,115,0.06) 1px, transparent 1px, transparent ${cellWidth}px)`,
  ].join(', ')
}

/** 二分查找：第一个"底部偏移 > scrollTop"的行索引 */
export function findRowIndexAtOffset(offsets: number[], rows: MatrixRowSpec[], scrollTop: number): number {
  let lo = 0
  let hi = rows.length - 1
  let ans = rows.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] + rows[mid].height > scrollTop) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

/** 计算垂直可视窗口：[startIdx, endIdx) + overscan */
export function computeVisibleRowWindow(params: {
  offsets: number[]
  rows: MatrixRowSpec[]
  scrollTop: number
  viewportHeight: number
  overscan?: number
}): { start: number; end: number } {
  const { offsets, rows, scrollTop, viewportHeight, overscan = 5 } = params
  if (rows.length === 0) return { start: 0, end: 0 }
  const first = findRowIndexAtOffset(offsets, rows, scrollTop)
  const last = findRowIndexAtOffset(offsets, rows, scrollTop + viewportHeight)
  const start = Math.max(0, first - overscan)
  const end = Math.min(rows.length, Math.max(last + 1 + overscan, start + 1))
  return { start, end }
}
