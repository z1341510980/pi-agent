/**
 * 矩阵图例：从实现派生，而不是手写。
 *
 * ## 问题
 *
 * 原 `matrix-legend.tsx` 的 12 条图例是手写常量，与实际渲染严重不符。逐条核对：
 *
 * | 图例声称 | 实际渲染 |
 * | --- | --- |
 * | `★` 角色出场 | **非主角角色的格子什么都不画**；主角是 5px 白色圆点 + 1px 描边 |
 * | `▲` 冲突起始 / `▼` 冲突结束 | 端点是 `EndpointHandle` 拖拽把手 + 跨度色带，没有三角 |
 * | `◆` 地点出场 | 6px 实心**圆点**（`rounded-full`），不是菱形 |
 * | `●` 伏笔埋设 / `○` 伏笔回收 | 折叠态统一 `2px solid` 圆形描边，靠**填充**区分：回收=实心、埋设=底色、其余=45% 透明 |
 * | `▌` 常驻要素 | 世界要素行渲染为贯通色带，不是竖条字符 |
 *
 * 这四个符号（`★▲▼◆`）在实现里**根本不存在**。用户按图例找符号会找不到，
 * 反过来看到的圆点/色带在图例里查不到含义。
 *
 * 另一处矛盾：伏笔 beat 的四色（plant 琥珀 / reinforce 橙 / reveal 青 / payoff 绿，
 * 见 `matrix-model.FORESHADOW_BEAT_COLORS`）只在**子轨道展开**时使用；
 * 折叠态则统一用 `GROUP_META.foreshadow.color` 描边、靠填充区分类型。
 * 同一语义两套视觉，而图例只描述了其中一套（且描述得也不对）。
 *
 * ## 本模块做什么
 *
 * 把图例项定义为「视觉形态 + 语义 + 出现在哪个视图层」的结构化数据，
 * 形态取自实现常量（`GROUP_META` / `FORESHADOW_BEAT_COLORS`），
 * 并显式标注该形态属于折叠态还是子轨道展开态 —— 让"同一语义两套视觉"
 * 至少变成**可见且被解释**的，而不是让用户自己猜。
 *
 * 不改任何渲染代码：这是让图例追上实现，不是改实现去迁就图例。
 */

import { GROUP_META, type MatrixEntityKind } from './matrix-logic'
import { FORESHADOW_BEAT_COLORS } from './matrix-model'

/** 图例项的视觉形态。与实现中真实使用的绘制方式一一对应。 */
export type LegendShape =
  /** 实心圆点（location 的 6px、子轨道节点） */
  | 'dot'
  /** 空心圆点：白/底色填充 + 描边（主角、伏笔埋设点） */
  | 'ring'
  /** 横向色带（冲突/势力/世界要素的跨度） */
  | 'band'
  /** 虚线（伏笔未回收的连线） */
  | 'dashed-line'
  /** 实线（伏笔已回收的连线） */
  | 'solid-line'
  /** 竖线（播放头列高亮） */
  | 'vertical-line'
  /** 斜纹填充（信息差隐藏期） */
  | 'hatch'
  /** 什么都不画 —— 需要显式说明，否则用户以为是渲染 bug */
  | 'none'

/** 该形态出现在哪个视图层 */
export type LegendLayer =
  /** 折叠态（默认视图，每类实体一行） */
  | 'collapsed'
  /** 子轨道展开态（点击实体行的展开箭头后） */
  | 'subtrack'
  /** 两者都有 */
  | 'both'

export interface LegendEntry {
  /** 稳定 key */
  id: string
  shape: LegendShape
  color: string
  /** 语义说明 */
  label: string
  layer: LegendLayer
  /** 补充说明：形态本身不足以自解释时给出（如 shape='none'） */
  note?: string
  /** 所属实体类型；跨类型的通用项（如播放头）为 undefined */
  kind?: MatrixEntityKind
}

/**
 * 图例项。顺序与 GROUP_ORDER 一致，末尾放跨类型的通用项。
 *
 * 每条都对应实现里真实存在的绘制，注释标出出处。
 */
export const LEGEND_ENTRIES: LegendEntry[] = [
  // ── 角色 ──
  {
    // matrix-row.DraggablePresentCell：isProtagonist 时画 5px 白点 + 1px 描边
    id: 'character-protagonist',
    shape: 'ring',
    color: GROUP_META.character.color,
    label: '主角出场',
    layer: 'collapsed',
    kind: 'character',
  },
  {
    // ⚠️ 同一函数里非主角分支没有任何视觉输出。这条必须列出来，
    // 否则用户会以为"格子是空的"等于"该章没出场"。
    id: 'character-supporting',
    shape: 'none',
    color: GROUP_META.character.color,
    label: '配角出场',
    layer: 'collapsed',
    note: '格子本身不画标记，靠行内色带与悬浮提示识别',
    kind: 'character',
  },

  // ── 冲突 ──
  {
    // matrix-row.SpanBand：linear-gradient 色带
    id: 'conflict-span',
    shape: 'band',
    color: GROUP_META.conflict.color,
    label: '冲突跨度',
    layer: 'collapsed',
    kind: 'conflict',
  },
  {
    // matrix-row.EndpointHandle：可拖拽的端点把手（不是三角符号）
    id: 'conflict-endpoint',
    shape: 'ring',
    color: GROUP_META.conflict.color,
    label: '冲突起止端点（可拖动）',
    layer: 'collapsed',
    kind: 'conflict',
  },
  {
    // computeCellSymbol 的 'conflict-climax'
    id: 'conflict-climax',
    shape: 'dot',
    color: '#f59e0b',
    label: '冲突高潮',
    layer: 'collapsed',
    kind: 'conflict',
  },

  // ── 线索 ──
  {
    id: 'clue-progress',
    shape: 'dot',
    color: GROUP_META.clue.color,
    label: '线索推进',
    layer: 'collapsed',
    kind: 'clue',
  },

  // ── 伏笔：折叠态靠填充区分，子轨道展开态才用四色 ──
  {
    // matrix-row.ForeshadowEncoding：payoff 实心填充
    id: 'foreshadow-payoff-collapsed',
    shape: 'dot',
    color: GROUP_META.foreshadow.color,
    label: '伏笔回收点',
    layer: 'collapsed',
    note: '折叠态：实心填充',
    kind: 'foreshadow',
  },
  {
    // 同函数：plant 用 var(--color-surface-1) 填充 → 视觉上空心
    id: 'foreshadow-plant-collapsed',
    shape: 'ring',
    color: GROUP_META.foreshadow.color,
    label: '伏笔埋设点',
    layer: 'collapsed',
    note: '折叠态：空心',
    kind: 'foreshadow',
  },
  {
    // 同函数：recovered ? solid : dashed
    id: 'foreshadow-line-open',
    shape: 'dashed-line',
    color: GROUP_META.foreshadow.color,
    label: '伏笔未回收（虚线）',
    layer: 'collapsed',
    kind: 'foreshadow',
  },
  {
    id: 'foreshadow-line-closed',
    shape: 'solid-line',
    color: GROUP_META.foreshadow.color,
    label: '伏笔已回收（实线）',
    layer: 'collapsed',
    kind: 'foreshadow',
  },
  // 子轨道展开后改用四色区分 beat 类型 —— 与折叠态是两套视觉，必须说明
  {
    id: 'foreshadow-beat-plant',
    shape: 'dot',
    color: FORESHADOW_BEAT_COLORS.plant,
    label: '埋设',
    layer: 'subtrack',
    note: '展开子轨道后按类型着色',
    kind: 'foreshadow',
  },
  {
    id: 'foreshadow-beat-reinforce',
    shape: 'dot',
    color: FORESHADOW_BEAT_COLORS.reinforce,
    label: '强化',
    layer: 'subtrack',
    kind: 'foreshadow',
  },
  {
    id: 'foreshadow-beat-reveal',
    shape: 'dot',
    color: FORESHADOW_BEAT_COLORS.reveal,
    label: '揭示',
    layer: 'subtrack',
    kind: 'foreshadow',
  },
  {
    id: 'foreshadow-beat-payoff',
    shape: 'dot',
    color: FORESHADOW_BEAT_COLORS.payoff,
    label: '回收',
    layer: 'subtrack',
    kind: 'foreshadow',
  },

  // ── 势力 ──
  {
    id: 'faction-span',
    shape: 'band',
    color: GROUP_META.faction.color,
    label: '势力活动跨度',
    layer: 'collapsed',
    kind: 'faction',
  },

  // ── 地点 ──
  {
    // matrix-row.DraggablePresentCell：location 画 6px 实心圆点
    id: 'location-present',
    shape: 'dot',
    color: GROUP_META.location.color,
    label: '地点出现',
    layer: 'collapsed',
    kind: 'location',
  },

  // ── 世界要素 ──
  {
    id: 'world-element-always',
    shape: 'band',
    color: GROUP_META.world_element.color,
    label: '常驻要素（全程）',
    layer: 'collapsed',
    kind: 'world_element',
  },

  // ── 信息差 ──
  {
    // matrix-row：repeating-linear-gradient 斜纹
    id: 'info-layer-hidden',
    shape: 'hatch',
    color: GROUP_META.info_layer.color,
    label: '信息隐藏期',
    layer: 'collapsed',
    kind: 'info_layer',
  },

  // ── 物品 ──
  {
    id: 'item-span',
    shape: 'band',
    color: GROUP_META.item.color,
    label: '物品在场跨度',
    layer: 'collapsed',
    kind: 'item',
  },

  // ── 剧情（narrative 轨道）──
  {
    // matrix-row.SpanBand：与冲突同模式的跨度色带
    id: 'narrative-span',
    shape: 'band',
    color: GROUP_META.narrative.color,
    label: '剧情跨度',
    layer: 'collapsed',
    kind: 'narrative',
  },

  // ── 跨类型 ──
  {
    id: 'playhead',
    shape: 'vertical-line',
    color: '#f59e0b',
    label: '当前章节（播放头）',
    layer: 'both',
  },
]

/** 按视图层筛选。子轨道项在未展开任何实体时对用户没有意义。 */
export function selectLegendEntries(layer: 'collapsed' | 'subtrack'): LegendEntry[] {
  return LEGEND_ENTRIES.filter((e) => e.layer === layer || e.layer === 'both')
}
