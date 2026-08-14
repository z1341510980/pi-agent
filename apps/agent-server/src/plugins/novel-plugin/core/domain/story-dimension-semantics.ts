import type { PromptDimensionContext } from '@repo/shared/novel'

interface DimensionGuide {
  labels: Array<{ max: number; label: string }>
  guides: Record<string, string>
  allowed?: Record<string, string[]>
  forbidden?: Record<string, string[]>
}

const LEVELS = [
  { max: 19, label: '无明显表现' },
  { max: 39, label: '轻微' },
  { max: 59, label: '明显' },
  { max: 79, label: '强烈' },
  { max: 100, label: '主导行为' },
]

const GUIDES: Record<string, DimensionGuide> = {
  'relationship.suspicion': {
    labels: LEVELS,
    guides: {
      '无明显表现': '默认采信对方解释，不主动调查。',
      '轻微': '注意到异常，偶尔试探，但不改变主要行动。',
      '明显': '保留证据并寻找旁证，不再完全采信表面解释。',
      '强烈': '主动验证并防备对方，但证据不足时不直接定罪。',
      '主导行为': '怀疑支配主要行动选择，会公开质问或采取限制措施。',
    },
    allowed: {
      '轻微': ['观察异常', '保留疑问'],
      '明显': ['旁敲侧击', '寻找旁证', '重新评估计划'],
      '强烈': ['秘密调查', '设置试探', '限制信息共享'],
      '主导行为': ['公开质问', '采取防备措施', '推动对抗'],
    },
    forbidden: {
      '明显': ['无证据直接定罪'],
      '强烈': ['无铺垫直接决裂'],
    },
  },
  'relationship.trust': {
    labels: LEVELS,
    guides: {
      '无明显表现': '关系尚未形成稳定托付。',
      '轻微': '只分享低风险信息，遇到压力会优先保护自己。',
      '明显': '愿意合作和分享部分信息，但仍保留底线。',
      '强烈': '愿意托付重要信息，并在证据不足时维护对方。',
      '主导行为': '高度信任影响重大选择，可能承担明显风险。',
    },
  },
  'relationship.hostility': {
    labels: LEVELS,
    guides: {
      '无明显表现': '没有直接敌对行动。',
      '轻微': '存在摩擦或言语对抗。',
      '明显': '会主动阻碍对方目标。',
      '强烈': '会策划针对对方的行动或伤害。',
      '主导行为': '敌对目标支配行动，可能升级为正面冲突。',
    },
  },
  'conflict.intensity': {
    labels: LEVELS,
    guides: {
      '无明显表现': '冲突只作为背景，不改变本章主要行动。',
      '轻微': '出现局部阻力，但角色仍有替代路径。',
      '明显': '冲突影响场景选择，需要付出代价。',
      '强烈': '冲突支配主要行动，角色必须作出取舍。',
      '主导行为': '冲突压倒其他目标，结果会重塑后续剧情。',
    },
  },
  'character.pressure': {
    labels: LEVELS,
    guides: {
      '无明显表现': '角色能稳定思考和行动。',
      '轻微': '角色有压力，但不明显影响判断。',
      '明显': '角色耐心和判断受到影响。',
      '强烈': '角色容易冒险、失误或做出防御性选择。',
      '主导行为': '压力支配行为，角色可能失控或被迫改变目标。',
    },
  },
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

function getGuide(dimension: string): DimensionGuide {
  return GUIDES[dimension] ?? { labels: LEVELS, guides: {} }
}

function levelFor(value: number, guide: DimensionGuide): string {
  return guide.labels.find((band) => value <= band.max)?.label ?? '主导行为'
}

export function buildPromptDimensionContext(
  dimension: string,
  value: unknown,
  previousValue: unknown,
  changeReason: string,
): PromptDimensionContext | null {
  const current = numericValue(value)
  if (current == null) return null

  const previous = numericValue(previousValue)
  const guide = getGuide(dimension)
  const levelLabel = levelFor(current, guide)
  const trend: PromptDimensionContext['trend'] = previous == null || current === previous
    ? 'stable'
    : current > previous ? 'rising' : 'falling'

  return {
    dimension,
    numericValue: current,
    levelLabel,
    behaviorGuide: guide.guides[levelLabel] ?? '该数值表示本维度当前状态的相对强度。',
    trend,
    previousValue,
    changeReason,
    allowedThisChapter: guide.allowed?.[levelLabel] ?? [],
    forbiddenThisChapter: guide.forbidden?.[levelLabel] ?? [],
  }
}
