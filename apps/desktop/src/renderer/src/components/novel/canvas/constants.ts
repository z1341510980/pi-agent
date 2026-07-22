import type { NovelEdgeType } from '@/api/novel-client'

// ── 布局常量 ──

export const CHAR_X = -380
export const CONFLICT_X_OFFSET = 200
export const FORESHADOW_Y = 280
export const FORESHADOW_X_START = -380
export const FACTION_X = 380
export const FACTION_Y_START = -280
export const LOCATION_Y = 560
export const LOCATION_X_START = -380
export const WORLD_ELEMENT_Y = 820
export const WORLD_ELEMENT_X_START = -380
export const NODE_SPACING_Y = 110
export const NODE_SPACING_X = 240

/** 节点数超过此阈值时切换紧凑渲染 */
export const COMPACT_THRESHOLD = 50
/** 节点数超过此阈值时显示性能警告 */
export const WARNING_THRESHOLD = 100

/** 位置持久化防抖时间 */
export const POSITION_SYNC_DEBOUNCE_MS = 1000

// ── 边类型标签（过滤下拉用）──

export const EDGE_TYPE_LABELS: Record<NovelEdgeType, string> = {
  appearance: '出场',
  relationship: '关系',
  involvement: '参与',
  foreshadow: '伏笔',
  base: '场景',
  member: '成员',
  hierarchy: '层级',
  association: '关联',
  mentor: '师徒',
  kinship: '亲属',
  rivalry: '敌对',
  alliance: '同盟',
  subordinate: '隶属',
  trigger: '触发',
  causality: '因果',
  related: '关联',
}
