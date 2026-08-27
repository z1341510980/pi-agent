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

import type {
  NovelChangeRecord,
  NovelChapter,
  NovelCharacter,
  NovelConflict,
  NovelClue,
  NovelForeshadow,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
  NovelInformationLayer,
  NovelItem,
  NovelCharacterHistory,
  NovelNarrative,
  ConflictTier,
} from '@/api/novel-client'
import type {
  MatrixEntity,
  MatrixEntityKind,
  MatrixGroup,
  MatrixData,
  MatrixSubtrackSnapshot,
} from './matrix-logic'
import {
  GROUP_META,
  computeMaxChapter,
  computeCharacterSpans,
  computeSpanRange,
} from './matrix-logic'

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

const CHARACTER_PLOT_ROLE_LABELS: Record<string, string> = {
  protagonist: '主角',
  main_opponent: '主要对手',
  supporting: '配角',
  function: '功能角色',
  background: '背景角色',
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

/** 矩阵九类实体均使用同一套子轨道投影。 */
export function isSubtrackSupported(kind: MatrixEntityKind): boolean {
  return GROUP_META[kind] != null
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
  'conflict.current_step': '当前进展',
  'conflict.next_step': '下一步',
  'conflict.participants': '参与角色',
  'conflict.related_clues': '关联线索',
  'conflict.created': '建立',
  // foreshadow
  'foreshadow.beat': '事件链节点',
  'foreshadow.payoff_chapter': '回收章节',
  'foreshadow.plant_method': '埋设手法',
  'foreshadow.recover_method': '回收手法',
  'foreshadow.status': '伏笔状态',
  'foreshadow.category': '伏笔类别',
  'foreshadow.created': '埋设',
  // clue
  'clue.progress': '推进进度',
  'clue.step': '发现步骤',
  'clue.points_to': '指向',
  'clue.misleading': '误导性',
  'clue.current_step': '当前步骤',
  'clue.next_step': '下一步',
  'clue.created': '发现',
  // faction
  'faction.status': '势力状态',
  'faction.activity': '活动区间',
  'faction.strength': '实力消长',
  'faction.leader': '首领',
  'faction.resources': '资源',
  'faction.allies': '盟友',
  'faction.enemies': '敌对势力',
  'faction.created': '成立',
  // location
  'location.status': '场景状态',
  'location.appear': '场景出现',
  'location.significance': '剧情权重',
  'location.parent': '上级地点',
  'location.faction': '归属势力',
  'location.created': '首次出现',
  // world element
  'world_element.presence': '常驻',
  'world_element.category': '要素类别',
  'world_element.attributes': '属性',
  'world_element.created': '建立',
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
  'info_layer.reveal_stage': '揭示阶段',
  'info_layer.created': '建立',
  // item
  'item.holder': '持有者',
  'item.status': '物品状态',
  'item.function': '功能定位',
  'item.appear': '出现记录',
  'item.abilities': '能力/效果',
  'item.origin': '来源',
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
// 枚举值 → 中文友好标签（解决英文 enum 不可读问题）
// ────────────────────────────────────────────────────────────

const ENUM_VALUE_LABELS: Record<string, string> = {
  // character.arc_stage（角色弧光阶段）
  'ordinary_world': '平凡世界',
  'call_to_adventure': '冒险召唤',
  'refusal_of_call': '拒绝召唤',
  'meeting_mentor': '遇见导师',
  'crossing_threshold': '跨越门槛',
  'tests_allies_enemies': '考验与盟友',
  'approach_inmost_cave': '逼近核心',
  'ordeal': '严峻考验',
  'reward': '获得奖赏',
  'the_road_back': '回归之路',
  'resurrection': '复活/蜕变',
  'return_with_elixir': '携万灵药归来',
  'rising_action': '上升期',
  'climax': '高潮',
  'falling_action': '下降期',
  'resolution': '解决',
  'denouement': '结局',
  'setup': '铺垫',
  'confrontation': '对抗',
  'crisis': '危机',
  'transformation': '蜕变',
  'epiphany': '顿悟',
  'descent': '沉沦',
  'rock_bottom': '谷底',
  'redemption': '救赎',
  'awakening': '觉醒',
  'trial': '试炼',
  'revelation': '启示',
  'sacrifice': '牺牲',
  'atonement': '赎罪',
  'apotheosis': '神化',
  'freedom': '自由',
  // character.pressure（压力等级）
  'low': '低',
  'medium': '中',
  'high': '高',
  'extreme': '极高',
  'overwhelming': '崩溃边缘',
  'manageable': '可控',
  'intense': '强烈',
  'moderate': '中等',
  'minimal': '极低',
  'critical': '临界',
  // conflict.stage（冲突阶段）
  'introduction': '引入',
  'escalation': '升级',
  'peak': '顶峰',
  'de_escalation': '缓和',
  'aftermath': '余波',
  'dormant': '潜伏',
  'active': '活跃',
  'resolved': '已解决',
  'stalemate': '僵持',
  // foreshadow.status（伏笔状态）
  'planted': '已埋设',
  'reinforced': '已强化',
  'revealed': '已揭示',
  'recovered': '已回收',
  'abandoned': '已放弃',
  'pending': '待处理',
  'forgotten': '被遗忘',
  // faction.strength（势力强度）
  'weak': '弱小',
  'growing': '成长中',
  'stable': '稳定',
  'declining': '衰退中',
  'dominant': '主导',
  'emerging': '新兴',
  'powerful': '强大',
  'crumbling': '瓦解中',
  // relationship.stage（关系阶段）
  'strangers': '陌生',
  'acquaintance': '相识',
  'alliance': '结盟',
  'friendship': '友谊',
  'rivalry': '竞争',
  'hostility': '敌对',
  'betrayal': '背叛',
  'reconciliation': '和解',
  'partnership': '伙伴',
  'mentorship': '师徒',
  // location.significance（剧情权重）
  'minor': '次要',
  'major': '重要',
  'pivotal': '关键',
  'background': '背景',
  // item.status（物品状态）
  'lost': '丢失',
  'destroyed': '损毁',
  'transformed': '变化',
  'sealed': '封印',
  'transferred': '转手',
  // info_layer 相关
  'known': '已知',
  'unknown': '未知',
  'hidden': '隐藏',
  'partial': '部分揭示',
  'full': '完全揭示',
  // 通用
  'none': '无',
  'other': '其他',
  'unknown_value': '未知',
  'true': '是',
  'false': '否',
}

/** 将英文枚举值翻译为中文（无匹配则原样返回） */
export function translateEnumValue(value: string): string {
  if (!value) return value
  // 先尝试精确匹配（小写）
  const lower = value.toLowerCase().replace(/[\s-]+/g, '_')
  if (ENUM_VALUE_LABELS[lower]) return ENUM_VALUE_LABELS[lower]
  // 尝试原值
  if (ENUM_VALUE_LABELS[value]) return ENUM_VALUE_LABELS[value]
  // 如果已经是中文或含中文，直接返回
  if (/[\u4e00-\u9fff]/.test(value)) return value
  // 将 snake_case / kebab-case 转为可读形式（首字母大写）
  if (/^[a-z_]+$/.test(value)) {
    return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return value
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
          const key = translateEnumValue(formatChangeValue(c.afterValue))
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
          label: translateEnumValue(formatChangeValue(c.afterValue)),
          color,
          before: translateEnumValue(formatChangeValue(c.beforeValue)),
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

  return tracks.filter(hasSubtrackData)
}

/** 从全量聚合中按实体过滤并构建子轨道（视图层 useMemo 调用）。
 *  数据源 = aggregation changes（账本变化记录）+ 实体自身透传的按章节数据。
 *  同 dimension key 优先用 changes（含 before/after 变化信息），实体字段补缺。 */
export function buildSubtracksForEntity(
  allChanges: NovelChangeRecord[],
  entity: MatrixEntity,
): SubtrackDef[] {
  const filtered = allChanges.filter(
    (c) => c.subjectId === entity.entityId
      && (c.subjectType === entity.kind || c.dimension.startsWith(`${entity.kind}.`)),
  )
  const changeTracks = buildSubtracksFromChanges(filtered, entity.kind)
  const entityTracks = buildSubtracksFromEntity(entity)
  return mergeSubtrackDefs(changeTracks, entityTracks)
}

// ────────────────────────────────────────────────────────────
// 实体自身字段 → 子轨道（fallback / 补充，不依赖 aggregation changes）
// ────────────────────────────────────────────────────────────

/** 伏笔 beat 类型 → 节点颜色 */
/**
 * 伏笔 beat 的类型配色。
 *
 * ⚠️ 只在**子轨道展开态**生效。折叠态（matrix-row.ForeshadowEncoding）统一用
 * GROUP_META.foreshadow.color 描边、靠填充区分类型 —— 同一语义两套视觉。
 * 图例（legend-spec.ts）显式标注了这一点，改动这里需同步那边的说明。
 */
export const FORESHADOW_BEAT_COLORS: Record<string, string> = {
  plant: '#f59e0b',
  reinforce: '#f97316',
  reveal: '#06b6d4',
  payoff: '#22c55e',
}
const FORESHADOW_BEAT_LABELS: Record<string, string> = {
  plant: '埋设',
  reinforce: '强化',
  reveal: '揭示',
  payoff: '回收',
}

/** 从 MatrixEntity 自身透传字段构建子轨道（不依赖后端 aggregation） */
function buildSubtracksFromEntity(entity: MatrixEntity): SubtrackDef[] {
  const meta = GROUP_META[entity.kind]
  const { color, colorRgb } = meta
  const tracks: SubtrackDef[] = []

  switch (entity.kind) {
    case 'conflict': {
      // 张力强度（number sparkline）
      if (entity.intensityPoints && entity.intensityPoints.length > 0) {
        const curve = entity.intensityPoints
          .map((p) => ({ ch: p.chapter, value: normalizeNumber(p.value) }))
          .filter((p): p is SubtrackCurvePoint => p.value != null)
        const nodes = entity.intensityPoints.map((p) => ({
          ch: p.chapter,
          label: String(p.value),
          color,
        }))
        tracks.push({
          key: 'conflict.intensity',
          label: resolveDimensionLabel('conflict.intensity'),
          color, colorRgb,
          bands: [],
          curve: curve.length > 1 ? curve : undefined,
          nodes: curve.length > 1 ? undefined : nodes,
        })
      }
      // 关键转折点（reference 圆点）
      if (entity.turningPoints && entity.turningPoints.length > 0) {
        tracks.push({
          key: 'conflict.turning_point',
          label: '关键转折',
          color, colorRgb,
          bands: [],
          nodes: entity.turningPoints.map((tp) => ({
            ch: tp.chapter,
            label: tp.label,
            color: '#e8463a',
            desc: tp.label,
          })),
        })
      }
      // 解决进度（number sparkline）
      if (entity.resolutionProgress && entity.resolutionProgress.length > 0) {
        const curve = entity.resolutionProgress
          .map((p) => ({ ch: p.chapter, value: normalizeNumber(p.percent) }))
          .filter((p): p is SubtrackCurvePoint => p.value != null)
        tracks.push({
          key: 'conflict.resolution',
          label: '解决进度',
          color, colorRgb,
          bands: [],
          curve: curve.length > 1 ? curve : undefined,
          nodes: curve.length > 1 ? undefined : entity.resolutionProgress.map((p) => ({
            ch: p.chapter, label: `${p.percent}%`, color,
          })),
        })
      }
      break
    }
    case 'foreshadow': {
      // 事件链节点（plant/reinforce/reveal/payoff 四态着色）
      if (entity.foreshadowBeats && entity.foreshadowBeats.length > 0) {
        tracks.push({
          key: 'foreshadow.beat',
          label: resolveDimensionLabel('foreshadow.beat'),
          color, colorRgb,
          bands: [],
          nodes: entity.foreshadowBeats.map((beat) => ({
            ch: beat.chapter,
            label: FORESHADOW_BEAT_LABELS[beat.type] ?? beat.type,
            color: FORESHADOW_BEAT_COLORS[beat.type] ?? color,
            desc: beat.note || undefined,
          })),
        })
      }
      // 回收进度点
      if (entity.resolutionPoints && entity.resolutionPoints.length > 0) {
        tracks.push({
          key: 'foreshadow.resolution',
          label: '回收进度',
          color, colorRgb,
          bands: [],
          nodes: entity.resolutionPoints.map((rp) => ({
            ch: rp.chapter, label: rp.label, color: '#22c55e', desc: rp.label,
          })),
        })
      }
      break
    }
    case 'clue': {
      // 发现步骤（每段跨度 = 一个阶段色块）
      if (entity.chapterSpans && entity.chapterSpans.length > 0) {
        tracks.push(buildSpansTrack('clue.step', '发现步骤', entity.chapterSpans, color, colorRgb))
      }
      break
    }
    case 'faction': {
      if (entity.chapterSpans && entity.chapterSpans.length > 0) {
        tracks.push(buildSpansTrack('faction.activity', '活动区间', entity.chapterSpans, color, colorRgb))
      }
      break
    }
    case 'item': {
      if (entity.chapterSpans && entity.chapterSpans.length > 0) {
        tracks.push(buildSpansTrack('item.appear', '出现区间', entity.chapterSpans, color, colorRgb))
      }
      break
    }
    case 'location': {
      // 出场记录（reference 圆点）
      if (entity.appearChapters && entity.appearChapters.length > 0) {
        tracks.push({
          key: 'location.appear',
          label: resolveDimensionLabel('location.appear'),
          color, colorRgb,
          bands: [],
          nodes: entity.appearChapters.map((ch) => ({ ch, label: `第 ${ch} 章`, color })),
        })
      }
      break
    }
    case 'world_element': {
      // 全程常驻色带
      const start = entity.alwaysStart ?? 1
      const end = entity.alwaysEnd ?? 1
      if (end >= start) {
        tracks.push({
          key: 'world_element.presence',
          label: '常驻',
          color, colorRgb,
          bands: [{
            startCh: start, endCh: end,
            fill: `rgba(${colorRgb}, 0.22)`,
            border: `rgba(${colorRgb}, 0.45)`,
            label: '常驻',
          }],
        })
      }
      break
    }
    case 'info_layer': {
      const start = entity.infoStart ?? 1
      const end = entity.infoEnd ?? start
      if (end >= start) {
        tracks.push({
          key: 'info_layer.hidden_period',
          label: '隐藏期',
          color,
          colorRgb,
          bands: [{
            startCh: start,
            endCh: end,
            fill: `rgba(${colorRgb}, 0.22)`,
            border: `rgba(${colorRgb}, 0.45)`,
            label: '信息未完全揭示',
            valueKey: '信息未完全揭示',
          }],
        })
      }
      break
    }
    case 'character': {
      // 角色出场跨度色带（characterSpans 已在折叠态主编码使用，此处补充为子轨道）
      if (entity.characterSpans && entity.characterSpans.length > 0) {
        tracks.push({
          key: 'character.presence',
          label: '出场区间',
          color, colorRgb,
          bands: entity.characterSpans.map((s) => ({
            startCh: s.start, endCh: s.end,
            fill: `rgba(${colorRgb}, 0.22)`,
            border: `rgba(${colorRgb}, 0.45)`,
            label: `第 ${s.start}–${s.end} 章`,
          })),
        })
      }
      break
    }
  }

  return mergeSubtrackDefs(tracks, buildSubtracksFromSnapshots(entity.subtrackSnapshots, color, colorRgb))
}

/** 把 chapterSpans（多段跨度）转为 enum 色块子轨道 */
function buildSpansTrack(
  key: string, label: string,
  spans: Array<[number, number]>,
  color: string, colorRgb: string,
): SubtrackDef {
  return {
    key, label, color, colorRgb,
    bands: spans.map(([s, e], i) => ({
      startCh: s, endCh: e,
      fill: `rgba(${colorRgb}, ${0.3 + (i % 3) * 0.3})`,
      border: `rgba(${colorRgb}, 0.45)`,
      label: `段 ${i + 1}`,
      valueKey: `段 ${i + 1}`,
    })),
  }
}

/** 合并同一实体的轨道，前者优先（账本 > 专项字段 > 静态快照）。 */
function mergeSubtrackDefs(
  primary: SubtrackDef[],
  fallback: SubtrackDef[],
): SubtrackDef[] {
  const merged = primary.filter(hasSubtrackData)
  const seen = new Set(merged.map((track) => track.key))
  for (const track of fallback) {
    if (seen.has(track.key) || !hasSubtrackData(track)) continue
    seen.add(track.key)
    merged.push(track)
  }
  return merged
}

function hasSubtrackData(track: SubtrackDef): boolean {
  return track.bands.length > 0
    || (track.curve?.length ?? 0) > 0
    || (track.nodes?.length ?? 0) > 0
}

/**
 * 将实体当前字段转换为子轨道保底数据。
 *
 * 快照不伪造逐章变更：number / text / reference / set 仅在锚点章显示，
 * enum / level 只在实体明确存在的章节片段内显示色带。真正的账本记录会按 key 覆盖它。
 */
function buildSubtracksFromSnapshots(
  snapshots: MatrixSubtrackSnapshot[] | undefined,
  color: string,
  colorRgb: string,
): SubtrackDef[] {
  if (!snapshots || snapshots.length === 0) return []

  const tracks: SubtrackDef[] = []
  for (const snapshot of snapshots) {
    if (!hasSnapshotValue(snapshot.value)) continue

    const label = snapshot.label || resolveDimensionLabel(snapshot.key)
    const displayValue = snapshot.displayValue ?? formatChangeValue(snapshot.value)
    const desc = snapshot.desc ?? '当前实体快照；暂无逐章变化记录'
    const base: Omit<SubtrackDef, 'bands'> = {
      key: snapshot.key,
      label,
      color,
      colorRgb,
    }

    switch (snapshot.valueType) {
      case 'enum':
      case 'level': {
        const spans = (snapshot.spans ?? []).filter(([start, end]) => end >= start)
        if (spans.length > 0) {
          tracks.push({
            ...base,
            bands: spans.map(([start, end]) => ({
              startCh: start,
              endCh: end,
              label: displayValue,
              valueKey: displayValue,
              fill: `rgba(${colorRgb}, 0.60)`,
              border: `rgba(${colorRgb}, 0.45)`,
            })),
            legend: [{ label: displayValue, fill: `rgba(${colorRgb}, 0.60)` }],
          })
        } else {
          tracks.push({
            ...base,
            bands: [],
            nodes: [{ ch: snapshot.chapter, label: displayValue, color, desc }],
          })
        }
        break
      }
      case 'number': {
        if (normalizeNumber(snapshot.value) == null) break
        tracks.push({
          ...base,
          bands: [],
          nodes: [{ ch: snapshot.chapter, label: displayValue, color, desc }],
        })
        break
      }
      case 'set': {
        const badge = countSetItems(snapshot.value)
        if (badge === 0) break
        tracks.push({
          ...base,
          bands: [],
          nodes: [{ ch: snapshot.chapter, label: displayValue, color, badge, desc }],
        })
        break
      }
      case 'reference':
      case 'text': {
        tracks.push({
          ...base,
          bands: [],
          nodes: [{ ch: snapshot.chapter, label: displayValue, color, desc }],
        })
        break
      }
    }
  }
  return tracks
}

function hasSnapshotValue(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return true
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
  const key = translateEnumValue(formatChangeValue(seg.value))
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
    if (value.length === 0) return ''
    // UUID 数组（关联 ID）：显示数量而非原始 ID，避免 UUID 污染
    if (value.every((v) => typeof v === 'string' && isUuidLike(v))) {
      return `${value.length} 项关联`
    }
    // 名称数组：用顿号连接，超过 5 项截断
    const names = value.map((v) => formatChangeValue(v)).filter(Boolean)
    if (names.length <= 5) return names.join('、')
    return `${names.slice(0, 5).join('、')} 等 ${names.length} 项`
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

function snapshot(
  key: string,
  valueType: MatrixSubtrackSnapshot['valueType'],
  value: unknown,
  chapter: number,
  options: Pick<MatrixSubtrackSnapshot, 'displayValue' | 'spans' | 'desc'> = {},
): MatrixSubtrackSnapshot {
  return {
    key,
    label: resolveDimensionLabel(key),
    valueType,
    value,
    chapter,
    ...options,
  }
}

function parseStringList(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  } catch {
    return [value]
  }
}

function parseKnowledgeCharacterIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    if (!parsed || typeof parsed !== 'object') return []
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, state]) => {
        if (state === true) return true
        if (!state || typeof state !== 'object') return false
        const entry = state as Record<string, unknown>
        return entry.knows === true || entry.suspects === true || entry.misunderstands === true
      })
      .map(([characterId]) => characterId)
  } catch {
    return []
  }
}

function lastChapterOf(spans: Array<[number, number]>, fallback = 1): number {
  return computeSpanRange(spans)?.end ?? fallback
}

// ────────────────────────────────────────────────────────────
// 矩阵分组构建（从 matrix-logic 迁移而来）
// ────────────────────────────────────────────────────────────

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
  /** 信息差在矩阵中显示隐藏期与知情范围；省略时兼容旧调用方。 */
  infoLayers?: NovelInformationLayer[]
  items: NovelItem[]
  characterHistory: NovelCharacterHistory[]
  /** 标记列表（用于填充 entity.note） */
  markers?: Array<{ type: string; entityId: string | null; note: string }>
  /** 剧情条目（narrative 轨道，与冲突同跨度模式；省略时兼容旧调用方） */
  narratives?: NovelNarrative[]
}): MatrixData {
  const {
    chapters, characters, conflicts, clues, foreshadows, factions, locations, worldElements,
    infoLayers = [], items, characterHistory, markers, narratives = [],
  } = params

  const maxChapter = computeMaxChapter(chapters)
  const characterNameById = new Map(characters.map((character) => [character.id, character.name]))
  const factionNameById = new Map(factions.map((faction) => [faction.id, faction.name]))
  const locationNameById = new Map(locations.map((location) => [location.id, location.name]))

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
    const isProtagonist = character.isProtagonist || character.plotRole === 'protagonist'
    const plotRole = isProtagonist ? 'protagonist' : character.plotRole
    // stale 出场：所在章内容被重写、待时间线重建确认。恢复显示并单独收集，
    // 渲染层画成空心点提示「待重建」，而不是把数据藏到用户以为丢失。
    const staleChapters = history
      .filter((h) => h.status === 'stale' && h.chapterNumber != null)
      .map((h) => h.chapterNumber as number)
    characterGroup.entities.push({
      id: character.id,
      kind: 'character',
      name: character.name,
      entityId: character.id,
      entityType: 'character',
      isProtagonist,
      subLabel:
        (CHARACTER_PLOT_ROLE_LABELS[plotRole] ?? '配角') +
        (staleChapters.length > 0 ? ` · ${staleChapters.length} 章待重建` : ''),
      characterSpans: spans,
      staleChapters: staleChapters.length > 0 ? staleChapters : undefined,
      note: noteMap.get(character.id),
    })
  }
  groups.push(characterGroup)

  // ── 剧情分组（narrative 轨道：推进/转折/悬念/收束/铺垫/揭示，与冲突同跨度模式）──
  // 顺序：角色 → 剧情 → 冲突 → ...（与 GROUP_ORDER 一致）
  const narrativeGroup: MatrixGroup = {
    ...GROUP_META.narrative,
    entities: [],
  }
  const narrativeTypeLabels: Record<string, string> = {
    advance: '剧情推进',
    turn: '转折',
    reversal: '反转',
    suspense: '悬念',
    resolve: '收束',
    setup: '铺垫',
    reveal: '揭示',
    misc: '剧情事件',
  }
  for (const narrative of narratives) {
    const spans = narrative.chapterSpans ?? []
    const range = computeSpanRange(spans)
    if (range == null) continue // 未放置 → 元素池
    narrativeGroup.entities.push({
      id: narrative.id,
      kind: 'narrative',
      name: narrative.description,
      entityId: narrative.id,
      entityType: 'narrative',
      subLabel: narrativeTypeLabels[narrative.type] ?? narrative.type,
      chapterSpans: spans,
      spanStart: range.start,
      spanEnd: range.end,
      note: noteMap.get(narrative.id),
    })
  }
  groups.push(narrativeGroup)

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
    const anchorChapter = lastChapterOf(conflict.chapterSpans, range.end)
    const participants = parseStringList(conflict.participants)
      .map((characterId) => characterNameById.get(characterId) ?? characterId)
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
      subtrackSnapshots: [
        snapshot('conflict.stage', 'enum', conflict.stage, range.start, { spans: conflict.chapterSpans }),
        snapshot('conflict.intensity', 'number', conflict.intensity, anchorChapter),
        snapshot('conflict.plot_function', 'enum', conflict.plotFunction, anchorChapter),
        snapshot('conflict.progression_mode', 'enum', conflict.progressionMode, anchorChapter),
        snapshot('conflict.current_step', 'text', conflict.currentStep, anchorChapter),
        snapshot('conflict.next_step', 'text', conflict.nextStep, anchorChapter),
        snapshot('conflict.participants', 'set', participants, anchorChapter),
        snapshot('conflict.related_clues', 'set', conflict.linkedClues ?? [], anchorChapter),
      ],
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
    const anchorChapter = lastChapterOf(spans, range.end)
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
      subtrackSnapshots: [
        snapshot('clue.progress', 'number', clue.progress, anchorChapter, { displayValue: `${clue.progress}%` }),
        snapshot('clue.current_step', 'text', clue.currentStep, anchorChapter),
        snapshot('clue.next_step', 'text', clue.nextStep, anchorChapter),
        snapshot('clue.points_to', 'reference', clue.pointsTo, anchorChapter),
        snapshot(
          'clue.misleading',
          'enum',
          clue.isMisleading ? '误导线索' : '真实线索',
          range.start,
          { spans },
        ),
      ],
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
    // ⚠️ beats 是"已发生节点"的事实源；recoverByChapter 是"计划回收章"（意图）。
    // 旧实现在 beats 为空时用 recoverByChapter 合成一个 payoff 节点，等于把"计划"
    // 画成"已回收"，还让 subLabel 显示"已回收"。矩阵只画事实，计划由跨度虚线表达。
    const beats = f.beats && f.beats.length > 0
      ? [...f.beats].sort((a, b) => a.chapter - b.chapter)
      : [{ chapter: f.firstChapter, type: 'plant' as const }]
    const payoffChapter = beats.find((beat) => beat.type === 'payoff')?.chapter ?? null
    const isRecovered = payoffChapter != null
    foreshadowGroup.entities.push({
      id: f.id,
      kind: 'foreshadow',
      name: f.description,
      entityId: f.id,
      entityType: 'foreshadow',
      subLabel: `${beats.length} 个节点 · ${isRecovered ? '已回收' : '待回收'}`,
      plantChapter: f.firstChapter,
      payoffChapter,
      foreshadowBeats: beats,
      spanStart: f.firstChapter,
      // 跨度终点优先用真实回收点；没回收就用计划回收章，让矩阵能画出"还欠着到第几章"。
      spanEnd: payoffChapter ?? f.recoverByChapter ?? null,
      // ⚠️ 同时标出这个终点是事实还是意图：两者压成同一个数会让"已还"和"欠着"
      // 长得一样，也让用户以为拖动终点改的是事实（实际改的是计划）。
      spanEndKind: payoffChapter != null
        ? 'payoff'
        : f.recoverByChapter != null
          ? 'planned'
          : null,
      note: noteMap.get(f.id),
      // 子甘特图轨道数据透传
      resolutionPoints: f.resolutionPoints,
      plantMethod: f.plantMethod,
      recoverMethod: f.recoverMethod,
      subtrackSnapshots: [
        snapshot('foreshadow.status', 'enum', f.status, f.firstChapter),
        snapshot('foreshadow.category', 'enum', f.category, f.firstChapter),
        snapshot('foreshadow.plant_method', 'text', f.plantMethod, f.firstChapter),
        snapshot('foreshadow.recover_method', 'text', f.recoverMethod, payoffChapter ?? f.firstChapter),
      ],
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
    const anchorChapter = lastChapterOf(faction.chapterSpans, range.end)
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
      subtrackSnapshots: [
        snapshot('faction.strength', 'level', faction.strength, range.start, { spans: faction.chapterSpans }),
        snapshot('faction.status', 'enum', faction.status, range.start, { spans: faction.chapterSpans }),
        snapshot(
          'faction.leader',
          'reference',
          faction.leaderId ? characterNameById.get(faction.leaderId) ?? faction.leaderId : null,
          anchorChapter,
        ),
        snapshot('faction.resources', 'set', faction.resources, anchorChapter),
        snapshot(
          'faction.allies',
          'set',
          faction.allies.map((factionId) => factionNameById.get(factionId) ?? factionId),
          anchorChapter,
        ),
        snapshot(
          'faction.enemies',
          'set',
          faction.enemies.map((factionId) => factionNameById.get(factionId) ?? factionId),
          anchorChapter,
        ),
      ],
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
    const anchorChapter = appears[appears.length - 1]
    locationGroup.entities.push({
      id: location.id,
      kind: 'location',
      name: location.name,
      entityId: location.id,
      entityType: 'location',
      appearChapters: appears,
      note: noteMap.get(location.id),
      subtrackSnapshots: [
        snapshot('location.status', 'enum', location.status, appears[0], {
          spans: appears.map((chapter) => [chapter, chapter]),
        }),
        snapshot('location.significance', 'enum', location.significance, anchorChapter),
        snapshot(
          'location.parent',
          'reference',
          location.parentId ? locationNameById.get(location.parentId) ?? location.parentId : null,
          anchorChapter,
        ),
        snapshot(
          'location.faction',
          'reference',
          location.factionId ? factionNameById.get(location.factionId) ?? location.factionId : null,
          anchorChapter,
        ),
      ],
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
      subtrackSnapshots: [
        snapshot('world_element.category', 'enum', w.category, 1),
        snapshot('world_element.attributes', 'set', Object.keys(w.attributes ?? {}), 1),
      ],
    })
  }
  groups.push(worldGroup)

  // ── 信息差分组：隐藏期色带 + 揭示节点，子轨道呈现知情范围 ──
  const infoLayerGroup: MatrixGroup = {
    ...GROUP_META.info_layer,
    entities: [],
  }
  for (const layer of infoLayers) {
    const revealChapter = layer.revealChapter == null
      ? null
      : Math.min(maxChapter, Math.max(1, layer.revealChapter))
    const infoEnd = revealChapter == null ? maxChapter : revealChapter - 1
    const anchorChapter = revealChapter ?? maxChapter
    const knownCharacters = parseKnowledgeCharacterIds(layer.characterKnowledge)
      .map((characterId) => characterNameById.get(characterId) ?? characterId)

    infoLayerGroup.entities.push({
      id: layer.id,
      kind: 'info_layer',
      name: layer.infoDescription,
      entityId: layer.id,
      entityType: 'info_layer',
      subLabel: layer.isRevealed ? '已揭示' : '未揭示',
      infoStart: 1,
      infoEnd,
      revealChapter,
      note: noteMap.get(layer.id),
      subtrackSnapshots: [
        snapshot(
          'info_layer.reader_knows',
          'enum',
          layer.readerKnows ? '已知' : '未知',
          anchorChapter,
          {
            spans: layer.readerKnows && revealChapter != null ? [[revealChapter, maxChapter]] : undefined,
          },
        ),
        snapshot(
          'info_layer.revealed',
          'enum',
          layer.isRevealed ? '已揭示' : '未揭示',
          anchorChapter,
          {
            spans: layer.isRevealed && revealChapter != null ? [[revealChapter, maxChapter]] : undefined,
          },
        ),
        snapshot(
          'info_layer.knowledge_spread',
          'set',
          knownCharacters,
          anchorChapter,
          { displayValue: knownCharacters.join('、') },
        ),
        snapshot('info_layer.reveal_stage', 'text', layer.revealStage, anchorChapter),
        snapshot(
          'info_layer.reveal_chapter',
          'number',
          revealChapter,
          anchorChapter,
          { displayValue: revealChapter == null ? '' : `第 ${revealChapter} 章` },
        ),
      ],
    })
  }
  groups.push(infoLayerGroup)

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
    const anchorChapter = lastChapterOf(spans, range.end)
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
      subtrackSnapshots: [
        snapshot('item.status', 'enum', it.status, range.start, { spans }),
        snapshot(
          'item.holder',
          'reference',
          it.ownerId ? characterNameById.get(it.ownerId) ?? it.ownerId : null,
          anchorChapter,
        ),
        snapshot('item.abilities', 'text', it.abilities, anchorChapter),
        snapshot('item.origin', 'text', it.origin, anchorChapter),
      ],
    })
  }
  groups.push(itemGroup)

  return { groups, maxChapter }
}
