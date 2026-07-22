/**
 * 子甘特图轨道数据构建器
 *
 * 按 MatrixEntity.kind 分发，构建该实体在"复合片段"展开时的子轨道数据。
 * 每类实体返回 4-6 条子轨道，每条包含：标签、色带、曲线、节点。
 *
 * 样板阶段：冲突 + 伏笔。其余实体类型返回空数组（待办）。
 *
 * 数据来源：
 * - 有字段的子轨道：直接从 MatrixEntity 的 chapterSpans/climaxChapter 等读取
 * - 缺字段的子轨道：从 NovelConflict/NovelForeshadow 新增的子轨道字段读取（intensityPoints 等）
 *   字段缺失时返回空 bands，子轨道渲染为"待补全"状态
 */

import type { MatrixEntity, MatrixEntityKind } from './matrix-logic'

// ── 子轨道数据结构 ──

export interface SubtrackBand {
  startCh: number
  endCh: number
  label?: string
  fill: string
  border: string
  dashed?: boolean
  pattern?: string
  emphasis?: string
  /** enum/level 维度的值标识，用于颜色映射 */
  valueKey?: string
}

export interface SubtrackCurvePoint {
  ch: number
  value: number // 0-1 归一化值
}

export interface SubtrackNode {
  ch: number
  label: string
  color: string
  shape: 'circle' | 'diamond' | 'triangle' | 'star' | 'flag'
  size?: number
  valueLabel?: string
  title?: string
  /** set 类型的徽标数字 */
  badge?: number
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
  /** 该子轨道是否可交互（有数据字段支撑） */
  interactive: boolean
  /** 该子轨道色带是否可拖拽写回（仅 stage 轨道，复用主矩阵 onMoveSpan/onMoveEndpoint） */
  draggable?: boolean
  /** 缺数据时显示的提示文案 */
  emptyHint?: string
  pattern?: string
  emphasis?: string
}

export function computeCurvePointDrag(
  point: { chapter: number; value: number },
  movementX: number,
  movementY: number,
  cellWidth: number,
  rowHeight: number,
): { chapter: number; value: number } {
  const chapter = Math.max(1, point.chapter + Math.round(movementX / cellWidth))
  const valueRange = Math.max(1, rowHeight - 8)
  const value = Math.max(0, Math.min(1, point.value - movementY / valueRange))
  return { chapter, value }
}

export function computeSubtrackNodeChapter(chapter: number, movementX: number, cellWidth: number): number {
  return Math.max(1, chapter + Math.round(movementX / cellWidth))
}

// ── 冲突子轨道构建（6 条）──

function buildConflictSubtracks(entity: MatrixEntity, _color: string, _colorRgb: string): SubtrackDef[] {
  const spans = entity.chapterSpans ?? []

  // 子轨道1：冲突阶段（来自 chapterSpans，可交互）
  const stageBands: SubtrackBand[] = spans.map((span, idx) => ({
    startCh: span[0],
    endCh: span[1],
    label: `阶段${idx + 1}`,
    fill: 'rgba(232,70,58,0.16)', border: 'rgba(232,70,58,0.30)',
  }))

  // 子轨道2：强度曲线（来自 intensityPoints，缺数据为空）
  // 注：intensityPoints 存在原 NovelConflict 上，MatrixEntity 不直接携带
  // 这里通过 entity 的扩展字段读取（buildGroups 时需透传）
  const intensityPoints = (entity as MatrixEntity & { intensityPoints?: Array<{ chapter: number; value: number }> }).intensityPoints
  const intensityCurve: SubtrackCurvePoint[] | undefined = intensityPoints?.length
    ? intensityPoints.map((p) => ({ ch: p.chapter, value: p.value / 10 }))
    : undefined

  // 子轨道3：参与方（来自 participantSpans，缺数据为空）
  const participantSpans = (entity as MatrixEntity & { participantSpans?: Array<{ characterId: string; startCh: number; endCh: number }> }).participantSpans
  const participantBands: SubtrackBand[] = (participantSpans ?? []).map((p) => ({
    startCh: p.startCh,
    endCh: p.endCh,
    fill: 'rgba(47,116,255,0.12)', border: 'rgba(47,116,255,0.25)',
    dashed: true,
  }))

  // 子轨道4：关键转折（来自 turningPoints，缺数据为空）
  const turningPoints = (entity as MatrixEntity & { turningPoints?: Array<{ chapter: number; label: string }> }).turningPoints
  const turningNodes: SubtrackNode[] | undefined = turningPoints?.length
    ? turningPoints.map((t) => ({ ch: t.chapter, label: t.label, color: '#9570ff', shape: 'diamond' as const }))
    : undefined

  // 子轨道5：解决进度（来自 resolutionProgress，缺数据为空）
  const resolutionProgress = (entity as MatrixEntity & { resolutionProgress?: Array<{ chapter: number; percent: number }> }).resolutionProgress
  const resolutionCurve: SubtrackCurvePoint[] | undefined = resolutionProgress?.length
    ? resolutionProgress.map((p) => ({ ch: p.chapter, value: p.percent / 100 }))
    : undefined

  return [
    {
      key: 'stage',
      label: '冲突阶段',
      color: '#e8463a', colorRgb: '232,70,58',
      bands: stageBands,
      interactive: true,
      draggable: true,
      emptyHint: '未设置冲突跨度',
    },
    {
      key: 'intensity',
      label: '张力强度',
      color: '#f97316', colorRgb: '249,115,22',
      emphasis: '峰值',
      bands: [],
      curve: intensityCurve,
      interactive: true,
      emptyHint: '点击编辑强度曲线',
    },
    {
      key: 'participants',
      label: '参与方博弈', color: '#2f74ff', colorRgb: '47,116,255',
      bands: participantBands,
      interactive: true,
      emptyHint: '双击添加参与方',
    },
    {
      key: 'stakes', label: '赌注/代价', color: '#991b1b', colorRgb: '153,27,27',
      bands: [],
      nodes: undefined,
      interactive: true,
      emptyHint: '双击添加赌注节点',
    },
    {
      key: 'turning-points', label: '突转潜力', color: '#9570ff', colorRgb: '149,112,255',
      bands: [],
      nodes: turningNodes,
      interactive: true,
      emptyHint: '双击添加突转标记',
    },
    {
      key: 'resolution', label: '推进节点', color: '#747e94', colorRgb: '116,126,148',
      bands: [],
      curve: resolutionCurve,
      interactive: true,
      emptyHint: '点击编辑推进节点',
    },
  ]
}

// ── 伏笔子轨道构建（5 条）──

function buildForeshadowSubtracks(entity: MatrixEntity, _color: string, colorRgb: string): SubtrackDef[] {
  const firstCh = entity.plantChapter ?? null
  const payoffCh = entity.payoffChapter ?? null
  const beats = entity.foreshadowBeats ?? []

  // 子轨道1：伏笔状态（来自 firstChapter/recoverByChapter/beats）
  const statusBands: SubtrackBand[] = []
  if (firstCh != null && payoffCh != null) {
    statusBands.push({
      startCh: firstCh,
      endCh: payoffCh,
      label: '活跃区间',
      fill: `rgba(${colorRgb}, 0.14)`,
      border: `rgba(${colorRgb}, 0.28)`,
    })
  }
  if (firstCh != null) {
    statusBands.push({
      startCh: firstCh,
      endCh: firstCh,
      label: '埋设',
      fill: `rgba(${colorRgb}, 0.30)`,
      border: `rgba(${colorRgb}, 0.50)`,
    })
  }
  if (payoffCh != null) {
    statusBands.push({
      startCh: payoffCh,
      endCh: payoffCh,
      label: '回收',
      fill: `rgba(${colorRgb}, 0.40)`,
      border: `rgba(${colorRgb}, 0.60)`,
    })
  }

  // 子轨道2：事件链 beats（来自 foreshadowBeats）
  const beatNodes: SubtrackNode[] = beats.map((b) => ({
    ch: b.chapter,
    label: b.note ?? b.type,
    color: b.type === 'plant' ? '#c4b5fd' : b.type === 'payoff' ? '#9570ff' : '#7c3aed',
    shape: b.type === 'plant' ? 'circle' : b.type === 'payoff' ? 'star' : 'diamond',
  }))

  // 子轨道3：回收进度（来自 resolutionPoints，缺数据为空）
  const resolutionPoints = (entity as MatrixEntity & { resolutionPoints?: Array<{ chapter: number; label: string }> }).resolutionPoints
  const resolutionNodes: SubtrackNode[] | undefined = resolutionPoints?.length
    ? resolutionPoints.map((r) => ({ ch: r.chapter, label: r.label, color: '#a78bfa', shape: 'triangle' as const }))
    : undefined

  // 子轨道4：关联实体（关联字段已删除，暂留空）
  const charNodes: SubtrackNode[] | undefined = undefined

  // 子轨道5：信息差承载（关联字段已删除，暂留空）
  const infoNodes: SubtrackNode[] | undefined = undefined

  return [
    {
      key: 'status',
      label: '伏笔状态',
      color: '#f59e0b', colorRgb: '245,158,11',
      bands: statusBands,
      interactive: true,
      emptyHint: '未设置埋设/回收章节',
    },
    {
      key: 'beats',
      label: '事件链 beats', color: '#c4b5fd', colorRgb: '196,181,253',
      bands: [],
      nodes: beatNodes.length > 0 ? beatNodes : undefined,
      interactive: true,
      emptyHint: '双击添加事件节点',
    },
    {
      key: 'resolution',
      label: '埋设/回收手法', color: '#7c3aed', colorRgb: '124,58,237',
      bands: entity.plantMethod || entity.recoverMethod ? [{ startCh: firstCh ?? 1, endCh: payoffCh ?? firstCh ?? 1, label: [entity.plantMethod, entity.recoverMethod].filter(Boolean).join(' → '), fill: 'rgba(124,58,237,0.12)', border: 'rgba(124,58,237,0.3)' }] : [],
      nodes: resolutionNodes,
      interactive: true,
      emptyHint: '双击添加回收进度点',
    },
    {
      key: 'linked-entities', label: '关联实体', color: '#a78bfa', colorRgb: '167,139,250',
      bands: [],
      nodes: charNodes,
      interactive: true,
      emptyHint: '双击关联角色/线索',
    },
    {
      key: 'info-layer', label: '信息差承载', color: '#747e94', colorRgb: '116,126,148',
      bands: [],
      nodes: infoNodes,
      interactive: true,
      emptyHint: '双击关联信息差',
    },
  ]
}

function buildGenericSubtracks(entity: MatrixEntity, color: string, colorRgb: string): SubtrackDef[] {
  const genericBand = (startCh: number, endCh: number, label: string): SubtrackBand => ({
    startCh,
    endCh,
    label,
    fill: `rgba(${colorRgb}, 0.16)`,
    border: `rgba(${colorRgb}, 0.38)`,
  })

  switch (entity.kind) {
    case 'character':
      return [{
        key: 'appearances',
        label: '出场片段',
        color,
        colorRgb,
        bands: (entity.characterSpans ?? []).map((span) => genericBand(span.start, span.end, '出场')),
        interactive: true,
        emptyHint: '尚无出场记录',
      }]
    case 'clue':
      return [{
        key: 'progress',
        label: '线索推进',
        color,
        colorRgb,
        bands: (entity.chapterSpans ?? []).map((span) => genericBand(span[0], span[1], entity.subLabel ?? '推进')),
        interactive: true,
        emptyHint: '尚无线索推进记录',
      }]
    case 'faction':
      return [{
        key: 'activity',
        label: '势力活动',
        color,
        colorRgb,
        bands: (entity.chapterSpans ?? []).map((span) => genericBand(span[0], span[1], '活动阶段')),
        interactive: true,
        emptyHint: '尚无势力活动记录',
      }]
    case 'location':
      return [{
        key: 'appearances',
        label: '场景出现',
        color,
        colorRgb,
        bands: [],
        nodes: (entity.appearChapters ?? []).map((chapter) => ({
          ch: chapter,
          label: '出现',
          color,
          shape: 'diamond',
        })),
        interactive: true,
        emptyHint: '尚无场景记录',
      }]
    case 'world_element':
      return [{
        key: 'active-range',
        label: '生效范围',
        color,
        colorRgb,
        bands: entity.alwaysStart != null && entity.alwaysEnd != null
          ? [genericBand(entity.alwaysStart, entity.alwaysEnd, '设定生效')]
          : [],
        interactive: false,
        emptyHint: '尚无生效范围',
      }]
    case 'item':
      return [{
        key: 'status',
        label: '物品状态',
        color,
        colorRgb,
        bands: (entity.chapterSpans ?? []).map((span) => genericBand(span[0], span[1], entity.subLabel ?? '持有')),
        interactive: true,
        emptyHint: '尚无物品状态记录',
      }]
    default:
      return []
  }
}

// ── 主入口：按实体类型分发 ──

/**
 * 为实体构建子轨道数据。
 * 样板阶段：冲突、伏笔。其余类型返回空数组（待办）。
 */
export function buildSubtracksForEntity(entity: MatrixEntity, kind: MatrixEntityKind): SubtrackDef[] {
  // 从 GROUP_META 获取颜色
  const colorMap: Record<string, { color: string; colorRgb: string }> = {
    character: { color: '#3b82f6', colorRgb: '59,130,246' },
    conflict: { color: '#e8463a', colorRgb: '232,70,58' },
    clue: { color: '#22c55e', colorRgb: '34,197,94' },
    foreshadow: { color: '#f59e0b', colorRgb: '245,158,11' },
    faction: { color: '#a855f7', colorRgb: '168,85,247' },
    location: { color: '#06b6d4', colorRgb: '6,182,212' },
    world_element: { color: '#4b3fe3', colorRgb: '75,63,227' },
    info_layer: { color: '#14b8a6', colorRgb: '20,184,166' },
    item: { color: '#d97706', colorRgb: '217,119,6' },
  }
  const meta = colorMap[kind]
  if (!meta) return []

  switch (kind) {
    case 'conflict':
      return buildConflictSubtracks(entity, meta.color, meta.colorRgb)
    case 'foreshadow':
      return buildForeshadowSubtracks(entity, meta.color, meta.colorRgb)
    default:
      return buildGenericSubtracks(entity, meta.color, meta.colorRgb)
  }
}

/** 所有实际出现在矩阵中的实体都可进入聚焦复合轨道。 */
export function isSubtrackSupported(kind: MatrixEntityKind): boolean {
  return kind !== 'info_layer'
}
