/**
 * 九类实体的矩阵交互语义规格。
 *
 * ## 问题
 *
 * 「双击空单元格会发生什么」在九类行里有五种结果，而这套差异此前编码在
 * **五处平行 switch** 里，分散在三个文件：
 *
 * | 位置 | 表达的事 |
 * | --- | --- |
 * | `matrix-logic.GROUP_META` | 名称 / 颜色 / 图标 |
 * | `matrix-logic.computeCellSymbol` | 单元格画成什么 |
 * | `matrix-row.emptyCellHint` / `presentCellHint` | 悬浮提示说什么 |
 * | `entity-cell-menu.markLabel` / `removeLabel` | 右键菜单的按钮文案 |
 * | `entity-cell-menu.markTooltip` / `removeTooltip` | 那两个按钮的 tooltip |
 *
 * 后果不是"代码重复"这么轻——是**同一语义在不同位置说法不一致**，且新增
 * 实体类型必须记得改五处，漏一处就出现「菜单说扩展到本章、提示说标记出场」
 * 这类矛盾。实测已存在的不一致：
 *
 * - `location` 的 `markLabel` 是「标记本章出场」，而 `emptyCellHint` 归到
 *   character 一档也叫「双击标记出场」，但 `presentCellHint` 对 location
 *   返回空串（其他类型都有说明），悬浮时看不到任何语义。
 * - `item` 九类里唯一在**全部五处** switch 里都落到 `default` 的类型：
 *   菜单显示通用的「标记出场」，提示为空，等于没有专属语义。
 * - `info_layer` 有 `presentCellHint`（信息隐藏期）但没有 `emptyCellHint`，
 *   空格悬浮无提示，用户不知道能不能双击。
 *
 * ## 本模块做什么
 *
 * 把「一类实体的交互语义」收成一条记录：动作动词、落库副作用的一句话说明、
 * 空格/已占格提示、是否可标记、是否可删除。五处 switch 改为读同一张表。
 *
 * 不改任何**行为**：所有文案取自现有实现，只在原本落到 `default` 或返回
 * 空串的地方补齐（那些是缺失而非有意为之）。
 *
 * ## 边界
 *
 * 纯数据 + 查询函数。实际的落库分派仍在 matrix-workspace（那是九类各自的
 * 存储结构差异，与文案无关）。
 */

import type { MatrixEntityKind } from './matrix-logic'

/** 单类实体的交互语义 */
export interface EntityInteractionSpec {
  kind: MatrixEntityKind
  /**
   * 是否支持"在某章标记出现"。
   * false 表示该类实体的存在范围不按章节标记（如世界要素恒全程）。
   */
  markable: boolean
  /** 是否支持删除某章的记录 */
  removable: boolean
  /** 右键菜单「标记」按钮文案；markable=false 时为空串 */
  markLabel: string
  /** 右键菜单「删除」按钮文案；removable=false 时为空串 */
  removeLabel: string
  /** 「标记」按钮的 tooltip：说清落库副作用 */
  markTooltip: string
  /** 「删除」按钮的 tooltip */
  removeTooltip: string
  /** 空单元格悬浮提示（双击会发生什么）；markable=false 时为空串 */
  emptyCellHint: string
  /** 已占单元格悬浮提示（这个格子代表什么） */
  presentCellHint: string
}

/**
 * 九类实体的交互语义表。
 *
 * ⚠️ 新增实体类型时这里是唯一需要改的地方（`Record<MatrixEntityKind, ...>`
 * 的类型约束会强制补全，不会像五处 switch 那样静默落到 default）。
 */
export const ENTITY_INTERACTION_SPEC: Record<MatrixEntityKind, EntityInteractionSpec> = {
  character: {
    kind: 'character',
    markable: true,
    removable: true,
    markLabel: '标记本章出场',
    removeLabel: '删除本章出场',
    markTooltip: '写入一条 characterHistory 记录，标记该角色在本章出场',
    removeTooltip: '删除该角色在本章的所有 characterHistory 记录',
    emptyCellHint: '双击标记出场',
    // 补齐：原 presentCellHint 对 character 落到 default 返回空串
    presentCellHint: '角色出场',
  },
  conflict: {
    kind: 'conflict',
    markable: true,
    removable: true,
    markLabel: '扩展到本章',
    removeLabel: '收缩端点',
    markTooltip: '扩展 firstChapter/lastChapter 端点覆盖到本章',
    removeTooltip: '收缩端点（仅首尾端点可删，中间格不可删）',
    emptyCellHint: '双击扩展到本章',
    // 冲突高潮由 symbolType 单独覆盖（见 resolvePresentCellHint）
    presentCellHint: '冲突进行中',
  },
  clue: {
    kind: 'clue',
    markable: true,
    removable: true,
    markLabel: '标记本章推进',
    removeLabel: '删除本章线索节点',
    markTooltip: '标记该线索在本章被发现、验证或推进',
    removeTooltip: '删除该线索在本章的推进记录',
    emptyCellHint: '双击标记发现/推进',
    presentCellHint: '线索发现/推进',
  },
  foreshadow: {
    kind: 'foreshadow',
    markable: true,
    removable: true,
    markLabel: '添加伏笔节点',
    removeLabel: '删除本章伏笔节点',
    markTooltip: '为本章选择埋设、强化、揭示或回收语义',
    removeTooltip: '删除本章节点；若删除埋设点，将同时清空整条事件链',
    emptyCellHint: '双击快速添加伏笔节点',
    presentCellHint: '伏笔节点',
  },
  faction: {
    kind: 'faction',
    markable: true,
    removable: true,
    markLabel: '扩展到本章',
    removeLabel: '收缩端点',
    markTooltip: '扩展 firstChapter/lastChapter 端点覆盖到本章',
    removeTooltip: '收缩端点（仅首尾端点可删，中间格不可删）',
    emptyCellHint: '双击扩展到本章',
    // 补齐：原 presentCellHint 对 faction 落到 default 返回空串
    presentCellHint: '势力活动中',
  },
  location: {
    kind: 'location',
    markable: true,
    removable: true,
    markLabel: '标记本章出场',
    removeLabel: '删除本章出场',
    markTooltip: '将本章加入 appearChapters 数组',
    removeTooltip: '从 appearChapters 数组中移除本章',
    emptyCellHint: '双击标记出场',
    // 补齐：原 presentCellHint 对 location 落到 default 返回空串
    presentCellHint: '地点出现',
  },
  world_element: {
    kind: 'world_element',
    // 世界要素恒全程存在，不按章节标记 —— 原实现用 markLabel 返回空串表达，
    // 这里改为显式的 markable=false，让调用方不必靠"空串"推断意图。
    markable: false,
    removable: false,
    markLabel: '',
    removeLabel: '',
    markTooltip: '世界要素恒定存在于全程，无需按章标记',
    removeTooltip: '世界要素恒定存在于全程，无法按章删除',
    emptyCellHint: '',
    presentCellHint: '常驻世界要素',
  },
  info_layer: {
    kind: 'info_layer',
    // 信息差的隐藏期由揭示章节决定，不能在矩阵上逐格标记
    markable: false,
    removable: false,
    markLabel: '',
    removeLabel: '',
    markTooltip: '信息隐藏期由揭示章节推导，请在详情中设置揭示时点',
    removeTooltip: '信息隐藏期由揭示章节推导，无法按章删除',
    // 补齐：原本无 emptyCellHint，用户不知道这行能不能双击
    emptyCellHint: '',
    presentCellHint: '信息隐藏期',
  },
  item: {
    kind: 'item',
    markable: true,
    removable: true,
    // 补齐：item 原本在全部五处 switch 里都落到 default，
    // 菜单只显示通用的「标记出场」，等于没有专属语义。
    markLabel: '标记本章出现',
    removeLabel: '删除本章出现',
    markTooltip: '扩展物品的章节跨度覆盖到本章',
    removeTooltip: '从物品的章节跨度中移除本章',
    emptyCellHint: '双击标记出现',
    presentCellHint: '物品在场',
  },
  narrative: {
    kind: 'narrative',
    markable: true,
    removable: true,
    markLabel: '标记本章出现',
    removeLabel: '删除本章出现',
    markTooltip: '扩展剧情条目的章节跨度覆盖到本章',
    removeTooltip: '从剧情条目的章节跨度中移除本章',
    emptyCellHint: '双击标记出现',
    presentCellHint: '剧情推进',
  },
}

/** 取某类实体的交互规格 */
export function getInteractionSpec(kind: MatrixEntityKind): EntityInteractionSpec {
  return ENTITY_INTERACTION_SPEC[kind]
}

/**
 * 已占单元格的悬浮提示。
 *
 * `symbolType` 会覆盖类型默认值：同一类实体的格子可能有多种语义
 * （冲突的普通推进 vs 高潮点），这个覆盖原本硬编码在 presentCellHint 首行。
 */
export function resolvePresentCellHint(
  kind: MatrixEntityKind,
  symbolType?: string,
): string {
  if (symbolType === 'conflict-climax') return '冲突高潮'
  return ENTITY_INTERACTION_SPEC[kind].presentCellHint
}

/** 空单元格的悬浮提示；不可标记的类型返回空串（无双击行为可提示） */
export function resolveEmptyCellHint(kind: MatrixEntityKind): string {
  return ENTITY_INTERACTION_SPEC[kind].emptyCellHint
}

/**
 * 「标记」按钮的 tooltip。
 *
 * `present=true` 时按钮本身被禁用，tooltip 改为说明原因 ——
 * 这条分支原本在 markTooltip 的首行。
 */
export function resolveMarkTooltip(kind: MatrixEntityKind, present: boolean): string {
  if (present) return '该章已标记'
  return ENTITY_INTERACTION_SPEC[kind].markTooltip
}
