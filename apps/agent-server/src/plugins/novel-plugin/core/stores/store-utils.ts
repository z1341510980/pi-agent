/**
 * NovelStore 子 Store 共享工具函数
 *
 * 从原 novel-store.ts 抽取，供 9 个子 Store 共用。
 * 仅包含纯函数，无 db / 状态依赖。
 */

import type {
  ChapterSpan,
  ConflictProgressionMode,
  PlotFunction,
  NovelForeshadow,
  NovelForeshadowCategory,
  ForeshadowPlantMethod,
  ForeshadowRecoverMethod,
  NovelWritingStyleProfile,
} from '../types.js'

/** 当前 Unix 时间戳（秒） */
export function now(): number {
  return Math.floor(Date.now() / 1000)
}

/** 防御性：将任意值安全转为 SQLite 可绑定的 string */
export function bindString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v
  if (v == null) return fallback
  if (Array.isArray(v)) return JSON.stringify(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** 安全 JSON 解析，失败时返回 fallback */
export function parseJSON<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** camelCase → snake_case */
export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

/** 解析 chapter_spans JSON 字段为 ChapterSpan[]，容错处理 null/异常/非数组 */
export function parseChapterSpans(raw: string | null | undefined): ChapterSpan[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (s): s is [number, number] =>
          Array.isArray(s) && s.length === 2 && typeof s[0] === 'number' && typeof s[1] === 'number',
      )
      .map(([s, e]) => [s, e] as ChapterSpan)
  } catch {
    return []
  }
}

/** 解析 JSON: string[] 字段，容错处理 null/异常/非数组 */
export function parseIdListSafe(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)
  } catch {
    return []
  }
}

// ── 伏笔规范化 ──

type ForeshadowBeat = NonNullable<NovelForeshadow['beats']>[number]
const FORESHADOW_BEAT_TYPES = new Set(['plant', 'reinforce', 'reveal', 'payoff'])

/** 规范化事件链，并为旧数据从 firstChapter/recoverByChapter 补出端点事件。 */
export function normalizeForeshadowBeats(
  input: unknown,
  firstChapter: number | null,
  recoverByChapter: number | null,
): ForeshadowBeat[] {
  const source = Array.isArray(input) ? input : []
  const byChapter = new Map<number, ForeshadowBeat>()
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Record<string, unknown>
    const chapter = candidate.chapter
    const type = candidate.type
    if (!Number.isInteger(chapter) || (chapter as number) < 1 || typeof type !== 'string' || !FORESHADOW_BEAT_TYPES.has(type)) continue
    byChapter.set(chapter as number, {
      chapter: chapter as number,
      type: type as ForeshadowBeat['type'],
      ...(typeof candidate.note === 'string' && candidate.note.trim() ? { note: candidate.note.trim() } : {}),
    })
  }
  if (![...byChapter.values()].some((beat) => beat.type === 'plant') && firstChapter != null) {
    byChapter.set(firstChapter, { chapter: firstChapter, type: 'plant' })
  }
  if (![...byChapter.values()].some((beat) => beat.type === 'payoff') && recoverByChapter != null) {
    byChapter.set(recoverByChapter, { chapter: recoverByChapter, type: 'payoff' })
  }
  // 埋设与回收各自只能有一个；强化、部分揭示可以在不同章节重复出现。
  const sorted = [...byChapter.values()].sort((a, b) => a.chapter - b.chapter)
  const plant = sorted.find((beat) => beat.type === 'plant')
  if (!plant) return []
  const payoff = sorted.find((beat) => beat.type === 'payoff' && beat.chapter > plant.chapter)
  return sorted.filter((beat) => {
    if (beat.type === 'plant') return beat === plant
    if (beat.chapter <= plant.chapter) return false
    if (beat.type === 'payoff') return beat === payoff
    return payoff == null || beat.chapter < payoff.chapter
  })
}

export function deriveForeshadowStatus(beats: ForeshadowBeat[]): NovelForeshadow['status'] {
  if (beats.some((beat) => beat.type === 'payoff')) return 'recovered'
  if (beats.some((beat) => beat.type === 'reveal')) return 'partially_revealed'
  if (beats.some((beat) => beat.type === 'reinforce')) return 'reinforced'
  return beats.some((beat) => beat.type === 'plant') ? 'planted' : 'planned'
}

// ── 四层逻辑③：枚举值容错转换 ──

const VALID_PLOT_FUNCTIONS: PlotFunction[] = [
  'provide_resource', 'create_obstacle', 'amplify_conflict',
  'open_phase', 'change_judgment', 'advance_relationship', 'reveal_world_rule',
]

const VALID_PROGRESSION_MODES: ConflictProgressionMode[] = [
  'linear', 'mutation', 'stagnation', 'regression', 'reversal',
]

const VALID_FORESHADOW_CATEGORIES: NovelForeshadowCategory[] = [
  'item', 'spoken', 'event', 'identity', 'secret', 'prophecy', 'promise', 'quote',
]

const VALID_PLANT_METHODS: ForeshadowPlantMethod[] = ['explicit', 'implicit', 'indirect']

const VALID_RECOVER_METHODS: ForeshadowRecoverMethod[] = [
  'explicit', 'implicit', 'reverse', 'progressive',
]

const FORESHADOW_CATEGORY_CN_MAP: Record<string, NovelForeshadowCategory> = {
  '物品': 'item', '言语': 'spoken', '事件': 'event', '身份': 'identity',
  '秘密': 'secret', '预言': 'prophecy', '承诺': 'promise', '台词': 'quote',
}

export function normalizeConflictPlotFunction(raw: string | null | undefined): PlotFunction | undefined {
  if (!raw) return undefined
  if (VALID_PLOT_FUNCTIONS.includes(raw as PlotFunction)) return raw as PlotFunction
  return undefined
}

export function normalizeConflictProgressionMode(raw: string | null | undefined): ConflictProgressionMode {
  if (!raw) return 'linear'
  if (VALID_PROGRESSION_MODES.includes(raw as ConflictProgressionMode)) return raw as ConflictProgressionMode
  return 'linear'
}

export function normalizeForeshadowCategory(raw: string | null | undefined): NovelForeshadowCategory {
  if (!raw) return 'item'
  if (VALID_FORESHADOW_CATEGORIES.includes(raw as NovelForeshadowCategory)) {
    return raw as NovelForeshadowCategory
  }
  if (FORESHADOW_CATEGORY_CN_MAP[raw]) return FORESHADOW_CATEGORY_CN_MAP[raw]
  const lower = raw.toLowerCase()
  if (VALID_FORESHADOW_CATEGORIES.includes(lower as NovelForeshadowCategory)) {
    return lower as NovelForeshadowCategory
  }
  return 'item'
}

export function normalizeForeshadowPlantMethod(raw: string | null | undefined): ForeshadowPlantMethod | undefined {
  if (!raw) return undefined
  if (VALID_PLANT_METHODS.includes(raw as ForeshadowPlantMethod)) return raw as ForeshadowPlantMethod
  return undefined
}

export function normalizeForeshadowRecoverMethod(raw: string | null | undefined): ForeshadowRecoverMethod | undefined {
  if (!raw) return undefined
  if (VALID_RECOVER_METHODS.includes(raw as ForeshadowRecoverMethod)) return raw as ForeshadowRecoverMethod
  return undefined
}

/** 解析 WritingStyleProfile 的 JSON 字符串数组字段，容错处理 null/异常/非数组 */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 规范化 WritingStyleProfile 的枚举字段，无效值回退到默认 */
export function normalizeWritingStyleProfileEnums(row: {
  narrative_person: string
  narrative_distance: string
  sentence_rhythm: string
  vocabulary_register: string
}): Pick<NovelWritingStyleProfile, 'narrativePerson' | 'narrativeDistance' | 'sentenceRhythm' | 'vocabularyRegister'> {
  const narrativePerson = ['first', 'third', 'mixed'].includes(row.narrative_person)
    ? (row.narrative_person as NovelWritingStyleProfile['narrativePerson'])
    : 'third'
  const narrativeDistance = ['intimate', 'limited', 'omniscient'].includes(row.narrative_distance)
    ? (row.narrative_distance as NovelWritingStyleProfile['narrativeDistance'])
    : 'limited'
  const sentenceRhythm = ['short', 'balanced', 'long'].includes(row.sentence_rhythm)
    ? (row.sentence_rhythm as NovelWritingStyleProfile['sentenceRhythm'])
    : 'balanced'
  const vocabularyRegister = ['colloquial', 'plain', 'literary', 'classical'].includes(row.vocabulary_register)
    ? (row.vocabulary_register as NovelWritingStyleProfile['vocabularyRegister'])
    : 'plain'
  return { narrativePerson, narrativeDistance, sentenceRhythm, vocabularyRegister }
}
