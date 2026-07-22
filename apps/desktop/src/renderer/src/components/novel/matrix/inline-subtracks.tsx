/**
 * InlineSubtracks：实体行下方内联展开的子轨道组
 *
 * 设计文档第 7 节"统一渲染引擎"：替代 EntityGanttFocus 全屏替换，
 * 在原行下方插入子轨道组，其他实体行仍可见（复合轨道隐喻）。
 *
 * - 数据源：getMatrixAggregation（矩阵级聚合接口，第 3 步新增）
 * - 渲染：CSS Grid（行 = 子轨道）+ SVG（band/curve/node），与 MatrixView 折叠态同源
 * - 每个 dimension 一条子轨道，类型按 valueType 决定：
 *   - enum / level：band（色带）+ node（关键节点）
 *   - number：curve（曲线）
 *   - set：band（多段色带）
 *   - reference / text：node（离散节点）
 * - 每条子轨道高度 28px，标签在左侧 sticky 列
 */

import { useMemo, type CSSProperties, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getMatrixAggregation, type NovelChangeRecord } from '@/api/novel-client'
import { cn } from '@/lib/utils'
import { GROUP_META, type MatrixEntity, type MatrixEntityKind } from './matrix-logic'
import type {
  SubtrackDef,
  SubtrackBand,
  SubtrackCurvePoint,
  SubtrackNode,
} from './subtrack-builders'

export interface InlineSubtracksProps {
  projectId: string
  entity: MatrixEntity
  visibleChapterColumns: number[]
  visibleRange: { start: number; end: number }
  maxChapter: number
  cellWidth: number
  sidebarWidth: number
  playheadChapter: number
}

// ── dimension → 友好标签映射 ──

const DIMENSION_LABELS: Record<string, string> = {
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
  'info_layer.created': '建立',
  // item
  'item.holder': '持有者',
  'item.status': '物品状态',
  'item.function': '功能定位',
  'item.appear': '出现记录',
  'item.created': '首次出现',
}

// 子轨道默认高度
const SUBTRACK_HEIGHT = 28

// 实体类型 → 主色 / RGB（与 GROUP_META 对齐）
function getEntityColors(kind: MatrixEntityKind): { color: string; colorRgb: string } {
  const meta = GROUP_META[kind]
  return { color: meta.color, colorRgb: meta.colorRgb }
}

// 把 dimension 字符串解析为 (prefix, key) 两段，用于友好标签回退
function parseDimension(dim: string): { prefix: string; key: string } | null {
  const idx = dim.indexOf('.')
  if (idx <= 0) return null
  return { prefix: dim.slice(0, idx), key: dim.slice(idx + 1) }
}

// ── 子轨道构建：从 ChangeRecord[] → SubtrackDef[] ──

/**
 * 把当前实体的 changes 按 dimension 分组，每组构建一条子轨道。
 * 根据 valueType 决定渲染类型：
 * - enum / level：band（同值连续段合并）+ node（每个变化点）
 * - number：curve（按章节排序连接）+ node（每个数据点）
 * - set：band（每个变化单段）+ node（每个变化点）
 * - reference / text：node（离散节点）
 */
export function buildInlineSubtracks(
  changes: NovelChangeRecord[],
  kind: MatrixEntityKind,
): SubtrackDef[] {
  const { color, colorRgb } = getEntityColors(kind)
  if (changes.length === 0) return []

  // 按 dimension 分组（保持首次出现顺序，便于稳定渲染）
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
    // enum/level 图例：值 → 颜色档位
    let legend: { label: string; fill: string }[] | undefined

    switch (valueType) {
      case 'enum':
      case 'level': {
        // 颜色映射：收集所有值，按首次出现顺序映射到 3 档透明度
        const valueOrder = new Map<string, number>()
        for (const c of sorted) {
          const key = formatValueLabel(c.afterValue)
          if (!valueOrder.has(key)) valueOrder.set(key, valueOrder.size)
        }
        const OPACITY_LEVELS = [0.3, 0.6, 0.9]
        const valueToFill = (key: string): string =>
          `rgba(${colorRgb}, ${OPACITY_LEVELS[valueOrder.get(key)! % OPACITY_LEVELS.length]})`
        // band：同值连续段合并（无文字标签）
        bands = buildEnumBands(sorted, colorRgb, valueToFill)
        // 图例
        legend = Array.from(valueOrder.entries()).slice(0, 4).map(([key]) => ({
          label: key,
          fill: valueToFill(key),
        }))
        // node：每个值变化点（无文字，仅 hover）
        nodes = sorted.map((c) => ({
          ch: c.chapterNumber,
          label: formatValueLabel(c.afterValue),
          color,
          shape: 'circle' as const,
          title: formatValueLabel(c.afterValue),
        }))
        break
      }
      case 'number': {
        // curve：按章节排序连接（sparkline，无文字）
        const points = sorted
          .map((c) => ({ ch: c.chapterNumber, value: normalizeNumber(c.afterValue) }))
          .filter((p): p is SubtrackCurvePoint => p.value != null)
        curve = points.length > 1 ? points : undefined
        // 数据点小圆点（无文字）
        nodes = sorted.map((c) => ({
          ch: c.chapterNumber,
          label: formatValueLabel(c.afterValue),
          color,
          shape: 'circle' as const,
          size: 4,
          title: formatValueLabel(c.afterValue),
        }))
        break
      }
      case 'set': {
        // 数字徽标：afterValue 通常是 { field: [...ids] }，提取数量
        nodes = sorted.map((c) => {
          const count = countSetItems(c.afterValue)
          return {
            ch: c.chapterNumber,
            label: formatValueLabel(c.afterValue),
            color,
            shape: 'circle' as const,
            badge: count,
            title: formatValueLabel(c.afterValue),
          }
        }).filter((n) => (n.badge ?? 0) > 0)
        break
      }
      case 'reference':
      case 'text': {
        // 小圆点（无文字，仅 hover）
        nodes = sorted.map((c) => ({
          ch: c.chapterNumber,
          label: formatValueLabel(c.afterValue),
          color,
          shape: 'circle' as const,
          size: 3,
          title: formatValueLabel(c.afterValue),
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
      interactive: true,
      emptyHint: '暂无变化记录',
    })
  }

  return tracks
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
  const key = formatValueLabel(seg.value)
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

function formatValueLabel(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) {
    // UUID 数组（关联 ID）：显示数量而非原始 ID，避免大量 UUID 污染轨道
    if (value.length > 0 && value.every((v) => typeof v === 'string' && isUuidLike(v))) {
      return `${value.length} 项关联`
    }
    return value.map((v) => formatValueLabel(v)).join(', ')
  }
  if (typeof value === 'object') {
    // 对象（如 { participatingConflicts: [...ids] } / { name: '角色名' }）：
    // 提取内部值而非 JSON.stringify，避免显示 {"field":"value"} 格式
    const vals = Object.values(value as Record<string, unknown>).filter((v) => v != null && v !== '')
    if (vals.length === 0) return ''
    // 优先处理 UUID 数组字段（关联关系变更）
    for (const v of vals) {
      if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && isUuidLike(x))) {
        return `${v.length} 项关联`
      }
    }
    // 否则取第一个非空值递归格式化
    return formatValueLabel(vals[0])
  }
  return String(value)
}

/** 检测字符串是否类似 UUID（足够长的十六进制/连字符串），用于识别关联 ID 数组 */
function isUuidLike(s: string): boolean {
  return s.length >= 8 && /^[0-9a-f-]+$/i.test(s)
}

/** 计算 set 类型 afterValue 的元素数量（用于数字徽标） */
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

// 把任意数值归一化到 0-1，用于 curve 纵向定位
function normalizeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value >= 0 && value <= 1) return value
  if (value >= 0 && value <= 10) return value / 10
  if (value >= 0 && value <= 100) return value / 100
  // 超出常见区间：clamp 到 0-1
  return Math.min(1, Math.max(0, value))
}

function resolveDimensionLabel(dimension: string): string {
  if (DIMENSION_LABELS[dimension]) return DIMENSION_LABELS[dimension]
  const parsed = parseDimension(dimension)
  return parsed ? parsed.key : dimension
}

// ── 渲染层 ──

export function InlineSubtracks({
  projectId,
  entity,
  visibleChapterColumns,
  visibleRange,
  maxChapter,
  cellWidth,
  sidebarWidth,
  playheadChapter,
}: InlineSubtracksProps): ReactElement {
  // 从矩阵级聚合接口取数据：queryKey 含 projectId + entityType + entityId
  const { data } = useQuery({
    queryKey: ['novel', 'matrix-aggregation', projectId, entity.kind, entity.entityId],
    queryFn: () => getMatrixAggregation(projectId, {
      chapterStart: 1,
      chapterEnd: maxChapter,
    }),
    enabled: !!projectId,
    staleTime: 30_000,
  })

  const tracks = useMemo(() => {
    const all = data?.changes ?? []
    const filtered = all.filter(
      (c) => c.subjectType === entity.kind && c.subjectId === entity.entityId,
    )
    return buildInlineSubtracks(filtered, entity.kind)
  }, [data?.changes, entity.kind, entity.entityId])

  if (tracks.length === 0) {
    return (
      <SubtrackEmptyRow
        visibleChapterColumns={visibleChapterColumns}
        visibleRange={visibleRange}
        maxChapter={maxChapter}
        cellWidth={cellWidth}
        sidebarWidth={sidebarWidth}
        playheadChapter={playheadChapter}
      />
    )
  }

  return (
    <div className="bg-primary/[0.04]">
      {tracks.map((track) => (
        <SubtrackRow
          key={track.key}
          track={track}
          visibleChapterColumns={visibleChapterColumns}
          visibleRange={visibleRange}
          maxChapter={maxChapter}
          cellWidth={cellWidth}
          sidebarWidth={sidebarWidth}
          playheadChapter={playheadChapter}
        />
      ))}
    </div>
  )
}

// ── 空数据占位行 ──
// 与 SubtrackRow 同构：sticky 左侧标签 + 章节列占位，保持横向滚动同步

interface SubtrackEmptyRowProps {
  visibleChapterColumns: number[]
  visibleRange: { start: number; end: number }
  maxChapter: number
  cellWidth: number
  sidebarWidth: number
  playheadChapter: number
}

function SubtrackEmptyRow({
  visibleChapterColumns, visibleRange, maxChapter, cellWidth, sidebarWidth, playheadChapter,
}: SubtrackEmptyRowProps): ReactElement {
  return (
    <div
      className="relative flex border-b border-border/10 bg-primary/[0.04]"
      style={{ height: `${SUBTRACK_HEIGHT}px` }}
    >
      <div
        className="sticky left-0 z-30 flex items-center gap-1.5 px-2 border-r border-border/40 shrink-0 bg-surface-1"
        style={{ width: `${sidebarWidth}px` }}
      >
        <span className="text-[10px] text-muted-foreground/70 truncate">子轨道</span>
      </div>
      <div className="relative flex">
        {visibleRange.start > 1 && (
          <div aria-hidden="true" style={{ width: `${(visibleRange.start - 1) * cellWidth}px` }} />
        )}
        {visibleChapterColumns.map((ch) => (
          <div
            key={ch}
            className={cn(
              'shrink-0 border-r border-border/20',
              ch === playheadChapter && 'bg-amber-500/[0.09]',
            )}
            style={{ width: `${cellWidth}px` }}
          />
        ))}
        {visibleRange.end < maxChapter && (
          <div aria-hidden="true" style={{ width: `${(maxChapter - visibleRange.end) * cellWidth}px` }} />
        )}
        <div
          className="absolute left-0 top-0 flex items-center text-[11px] text-muted-foreground px-2 pointer-events-none"
          style={{ height: `${SUBTRACK_HEIGHT}px` }}
        >
          暂无变化记录
        </div>
      </div>
    </div>
  )
}

// ── 单条子轨道行 ──

interface SubtrackRowProps {
  track: SubtrackDef
  visibleChapterColumns: number[]
  visibleRange: { start: number; end: number }
  maxChapter: number
  cellWidth: number
  sidebarWidth: number
  playheadChapter: number
}

function SubtrackRow({
  track, visibleChapterColumns, visibleRange, maxChapter, cellWidth, sidebarWidth, playheadChapter,
}: SubtrackRowProps): ReactElement | null {
  // 空数据折叠：无 bands/curve/nodes 时不渲染该行
  const hasData = track.bands.length > 0
    || (track.curve && track.curve.length >= 2)
    || (track.nodes && track.nodes.length > 0)
  if (!hasData) return null

  return (
    <div
      className="relative flex border-b border-border/10 last:border-b-0"
      style={{ height: `${SUBTRACK_HEIGHT}px` }}
    >
      {/* 左侧 sticky 列：子轨道标签 + enum 图例 */}
      <div
        className="sticky left-0 z-30 flex items-center gap-1.5 px-2 border-r border-border/40 shrink-0 bg-surface-1"
        style={{ width: `${sidebarWidth}px` }}
      >
        <span className="w-1 h-1 rounded-full shrink-0" style={{ background: track.color }} />
        <span className="text-[11px] text-muted-foreground truncate" title={track.label}>
          {track.label}
        </span>
        {/* enum/level 图例：3-4 个小色块 + 短标签 */}
        {track.legend && track.legend.length > 0 && (
          <div className="flex items-center gap-1 ml-auto shrink-0">
            {track.legend.map((item, i) => (
              <div key={i} className="flex items-center gap-0.5">
                <span
                  className="w-2 h-2 rounded-sm"
                  style={{ background: item.fill }}
                />
                <span className="text-[9px] text-muted-foreground/70 truncate max-w-[40px]">
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右侧子轨道主体：与 MatrixRow 折叠态同构 */}
      <div className="relative flex">
        {visibleRange.start > 1 && (
          <div aria-hidden="true" style={{ width: `${(visibleRange.start - 1) * cellWidth}px` }} />
        )}
        {visibleChapterColumns.map((ch) => (
          <div
            key={ch}
            className={cn(
              'shrink-0 border-r border-border/20',
              ch === playheadChapter && 'bg-amber-500/[0.09]',
            )}
            style={{ width: `${cellWidth}px` }}
          />
        ))}
        {visibleRange.end < maxChapter && (
          <div aria-hidden="true" style={{ width: `${(maxChapter - visibleRange.end) * cellWidth}px` }} />
        )}

        {/* SVG 叠加层：band + curve + node（无文字，hover 用 HTML 气泡） */}
        <SubtrackOverlay
          track={track}
          cellWidth={cellWidth}
          trackHeight={SUBTRACK_HEIGHT}
        />
      </div>
    </div>
  )
}

// ── SVG 叠加层：把 bands / curve / nodes 画在章节轴上 ──
// 紧凑视觉编码：默认无文字标签，hover 显示 HTML 气泡卡片
// - enum/level：连续色块 + 变化处竖线刻度
// - number：sparkline 折线 + 数据点小圆点
// - set：数字徽标（circle + 白色数字）
// - text/reference：小圆点

interface SubtrackOverlayProps {
  track: SubtrackDef
  cellWidth: number
  trackHeight: number
  maxChapter?: number
}

function SubtrackOverlay({
  track, cellWidth, trackHeight,
}: SubtrackOverlayProps): ReactElement | null {
  const padding = 4
  const bandTop = padding
  const bandHeight = trackHeight - padding * 2

  const hasBands = track.bands.length > 0
  const hasCurve = !!(track.curve && track.curve.length >= 2)
  const hasNodes = !!(track.nodes && track.nodes.length > 0)
  if (!hasBands && !hasCurve && !hasNodes) return null

  const maxCh = Math.max(
    track.bands.reduce((m, b) => Math.max(m, b.endCh), 0),
    track.curve?.reduce((m, p) => Math.max(m, p.ch), 0) ?? 0,
    track.nodes?.reduce((m, n) => Math.max(m, n.ch), 0) ?? 0,
    0,
  )
  if (maxCh === 0) return null
  const svgWidth = maxCh * cellWidth

  const xCenter = (ch: number): number => (ch - 1) * cellWidth + cellWidth / 2
  const xLeft = (ch: number): number => (ch - 1) * cellWidth

  const svgStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    pointerEvents: 'none',
    overflow: 'visible',
  }

  // 判断是否为 set 类型（有 badge 字段的节点）
  const isSetType = track.nodes?.some((n) => n.badge != null) ?? false
  // 判断是否为 text/reference 类型（小圆点，size <= 3 且无 badge，无 bands/curve）
  const isTextType = !isSetType
    && (!hasBands && !hasCurve)
    && (track.nodes?.some((n) => (n.size ?? 7) <= 4 && n.badge == null) ?? false)

  return (
    <div className="absolute inset-0" style={{ pointerEvents: 'none' }}>
      <svg width={svgWidth} height={trackHeight} style={svgStyle} aria-hidden="true">
        {/* bands（enum/level：连续色块，无文字） */}
        {track.bands.map((band, idx) => {
          const x = xLeft(band.startCh)
          const width = (band.endCh - band.startCh + 1) * cellWidth
          return (
            <g key={`band-${idx}`}>
              <rect
                x={x}
                y={bandTop}
                width={width}
                height={bandHeight}
                fill={band.fill}
                stroke={band.border}
                strokeWidth={1}
                rx={3}
                ry={3}
              />
              {/* 变化交界处竖线刻度（非首段） */}
              {idx > 0 && (
                <line
                  x1={x}
                  y1={bandTop}
                  x2={x}
                  y2={bandTop + bandHeight}
                  stroke="rgba(255,255,255,0.4)"
                  strokeWidth={2}
                />
              )}
            </g>
          )
        })}

        {/* curve（number：sparkline，无文字） */}
        {hasCurve && track.curve && (() => {
          const points = track.curve.map((p) => ({
            x: xCenter(p.ch),
            y: bandTop + (1 - p.value) * bandHeight,
          }))
          const path = points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
            .join(' ')
          return (
            <g>
              <path
                d={path}
                fill="none"
                stroke={track.color}
                strokeWidth={1.5}
                opacity={0.8}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={2} fill={track.color} />
              ))}
            </g>
          )
        })()}

        {/* nodes */}
        {track.nodes?.map((node, idx) => {
          const x = xCenter(node.ch)
          const y = trackHeight / 2

          // set 类型：数字徽标（circle r=8 + 白色数字）
          if (node.badge != null) {
            return (
              <g key={`node-${idx}`}>
                <circle cx={x} cy={y} r={8} fill={node.color} />
                <text
                  x={x}
                  y={y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9}
                  fontWeight={700}
                  fill="#fff"
                  style={{ pointerEvents: 'none' }}
                >
                  {node.badge > 99 ? '99+' : node.badge}
                </text>
              </g>
            )
          }

          // text/reference 类型：小圆点 r=3
          if (isTextType) {
            return (
              <circle
                key={`node-${idx}`}
                cx={x}
                cy={y}
                r={3}
                fill={node.color}
              />
            )
          }

          // enum/level 变化点：小圆点 r=3（在 band 上叠加）
          // number 数据点：小圆点 r=2（已在 curve 中渲染，这里不重复）
          if (hasCurve) return null
          return (
            <circle
              key={`node-${idx}`}
              cx={x}
              cy={y}
              r={3}
              fill={node.color}
            />
          )
        })}
      </svg>

      {/* HTML hover 触发层：透明矩形覆盖每个有数据的章节列，hover 显示气泡 */}
      <SubtrackBubbleLayer
        track={track}
        cellWidth={cellWidth}
        trackHeight={trackHeight}
        xCenter={xCenter}
        xLeft={xLeft}
      />
    </div>
  )
}

// ── HTML hover 气泡触发层 ──
// 在 SVG 之上叠加一层透明 div 触发区，hover 时显示 HTML 气泡卡片。
// 用 HTML 而非 SVG 实现气泡，便于文本换行和样式控制。

interface SubtrackBubbleLayerProps {
  track: SubtrackDef
  cellWidth: number
  trackHeight: number
  xCenter: (ch: number) => number
  xLeft: (ch: number) => number
}

function SubtrackBubbleLayer({
  track, cellWidth, trackHeight, xLeft,
}: SubtrackBubbleLayerProps): ReactElement | null {
  // 收集所有需要 hover 触发的章节位置
  // 对 set/text/enum 变化点，hover 节点位置；对 band，hover 整个 band
  const triggers: { ch: number; x: number; width: number; title: string; desc?: string }[] = []

  // 节点触发的章节（set/text/enum 变化点）
  if (track.nodes) {
    for (const node of track.nodes) {
      triggers.push({
        ch: node.ch,
        x: xLeft(node.ch),
        width: cellWidth,
        title: node.title ?? node.label,
        desc: node.label,
      })
    }
  }

  // band 触发的章节（enum/level 连续段，hover 任意位置显示该段信息）
  // 避免与 node 重复，band 触发只覆盖非节点章节
  const nodeChs = new Set(track.nodes?.map((n) => n.ch) ?? [])
  for (const band of track.bands) {
    for (let ch = band.startCh; ch <= band.endCh; ch++) {
      if (nodeChs.has(ch)) continue
      triggers.push({
        ch,
        x: xLeft(ch),
        width: cellWidth,
        title: band.label ?? '',
        desc: band.valueKey,
      })
    }
  }

  if (triggers.length === 0) return null

  return (
    <>
      {triggers.map((t, i) => (
        <SubtrackBubble
          key={`trigger-${i}`}
          x={t.x}
          width={t.width}
          trackHeight={trackHeight}
          dimensionLabel={track.label}
          chapter={t.ch}
          title={t.title}
          desc={t.desc}
          color={track.color}
        />
      ))}
    </>
  )
}

interface SubtrackBubbleProps {
  x: number
  width: number
  trackHeight: number
  dimensionLabel: string
  chapter: number
  title: string
  desc?: string
  color: string
}

function SubtrackBubble({
  x, width, trackHeight, dimensionLabel, chapter, title, desc, color,
}: SubtrackBubbleProps): ReactElement {
  return (
    <div
      className="absolute group"
      style={{
        left: `${x}px`,
        top: 0,
        width: `${width}px`,
        height: `${trackHeight}px`,
        pointerEvents: 'auto',
        cursor: 'pointer',
      }}
    >
      {/* 气泡卡片：hover 显示 */}
      <div
        className="invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity duration-150 absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none"
        style={{
          minWidth: '180px',
          maxWidth: '280px',
        }}
      >
        <div className="bg-surface-2 border border-border/60 rounded-md px-2.5 py-2 shadow-lg">
          <div className="text-[11px] font-semibold mb-0.5" style={{ color }}>
            {dimensionLabel}
          </div>
          <div className="text-[10px] text-muted-foreground mb-1">第 {chapter} 章</div>
          {title && (
            <div className="text-[11px] text-foreground/90 break-words leading-relaxed">
              {title}
            </div>
          )}
          {desc && desc !== title && (
            <div className="text-[10px] text-muted-foreground/80 mt-1 break-words">
              {desc}
            </div>
          )}
        </div>
        {/* 箭头 */}
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent"
          style={{ borderTopColor: 'var(--color-surface-2, #1f2033)' }}
        />
      </div>
    </div>
  )
}


