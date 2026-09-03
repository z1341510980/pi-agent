import type { NovelConflict } from '../types.js'

export interface ClueAdmissionFields {
  description?: unknown
  pointsTo?: unknown
  nextStep?: unknown
}

export interface ConflictAdmissionFields {
  description?: unknown
  type?: unknown
}

export interface NarrativeAdmissionFields {
  description?: unknown
  type?: unknown
}

const EVIDENCE_MARKER = /编号|印记|符号|文字|照片|录音|录像|文件|档案|记录|书信|纸条|地图|血迹|指纹|脚印|弹痕|证词|口供|信号|密码|坐标|样本|监控|交易|日志|数据|痕迹|图案|标签|遗物/

function hasText(value: unknown, minLength: number): value is string {
  return typeof value === 'string' && value.trim().length >= minLength
}

/**
 * 线索是可复验的证据，不是角色尚未弄清的环境、身份或身体状态。
 * 证据、指向与验证动作缺一不可；默认每章至多新增一条。
 */
export function isAdmissibleNewClue(candidate: ClueAdmissionFields): boolean {
  return hasText(candidate.description, 4)
    && EVIDENCE_MARKER.test(candidate.description)
    && hasText(candidate.pointsTo, 6)
    && hasText(candidate.nextStep, 4)
}

export function selectAdmissibleNewClues<T extends ClueAdmissionFields>(
  candidates: T[],
  maxNewPerChapter = 1,
): T[] {
  return candidates.filter(isAdmissibleNewClue).slice(0, maxNewPerChapter)
}

function isActiveInChapter(conflict: Pick<NovelConflict, 'chapterSpans'>, chapterNumber: number | undefined): boolean {
  if (chapterNumber == null) return true
  return conflict.chapterSpans.some(([start, end]) => start <= chapterNumber && chapterNumber <= end)
}

function toBigrams(value: string): Set<string> {
  const compact = value.toLowerCase().replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
  const bigrams = new Set<string>()
  for (let index = 0; index < compact.length - 1; index++) {
    bigrams.add(compact.slice(index, index + 2))
  }
  return bigrams
}

/**
 * 同章同类型冲突若复用了足够多的叙事锚点，应当更新已有冲突而不是新建平行副本。
 * 中文改写很少保留完整长句，因此使用二元词覆盖率而不是描述全文的精确/包含匹配。
 */
export function findCoveredConflict<T extends Pick<NovelConflict, 'id' | 'description' | 'type' | 'chapterSpans'>>(
  existing: T[],
  candidate: ConflictAdmissionFields,
  chapterNumber?: number,
): T | undefined {
  if (!hasText(candidate.description, 4)) return undefined
  const candidateType = typeof candidate.type === 'string' ? candidate.type : ''
  const candidateBigrams = toBigrams(candidate.description)
  if (candidateBigrams.size === 0) return undefined

  return existing.find((conflict) => {
    if (candidateType && conflict.type !== candidateType) return false
    if (!isActiveInChapter(conflict, chapterNumber)) return false

    const existingBigrams = toBigrams(conflict.description)
    if (existingBigrams.size === 0) return false
    let common = 0
    for (const bigram of candidateBigrams) {
      if (existingBigrams.has(bigram)) common++
    }
    return common >= 5 && common / Math.min(candidateBigrams.size, existingBigrams.size) >= 0.1
  })
}

/**
 * 归一化剧情描述，用于拦截 LLM 对同一事件的标点、空格和体貌词改写。
 * 不做同义词替换，避免把两个真正不同的事件误合并。
 */
export function normalizeNarrativeDescription(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}\u3000]/gu, '')
    .replace(/了/g, '')
}

function narrativeBigrams(value: string): Set<string> {
  const normalized = normalizeNarrativeDescription(value)
  const result = new Set<string>()
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2))
  }
  return result
}

/**
 * 剧情轨道的保守去重：精确归一化优先；改写只在至少 4 个二元锚点、且覆盖最长描述 60%
 * 时视为同一事件。已收束/放弃的旧剧情允许未来重新开启新的叙事周期。
 */
export function findCoveredNarrative<T extends { id: string; description: string; status?: unknown }>(
  existing: T[],
  candidate: NarrativeAdmissionFields,
): T | undefined {
  if (typeof candidate.description !== 'string' || candidate.description.trim().length < 4) return undefined
  const candidateNormalized = normalizeNarrativeDescription(candidate.description)
  const candidateBigrams = narrativeBigrams(candidate.description)
  if (!candidateNormalized || candidateBigrams.size === 0) return undefined

  return existing.find((narrative) => {
    const status = typeof narrative.status === 'string' ? narrative.status.trim().toLowerCase() : 'active'
    if (status === 'resolved' || status === 'dropped') return false
    const normalized = normalizeNarrativeDescription(narrative.description)
    if (!normalized) return false
    if (normalized === candidateNormalized) return true

    const existingBigrams = narrativeBigrams(narrative.description)
    if (existingBigrams.size === 0) return false
    let common = 0
    for (const bigram of candidateBigrams) {
      if (existingBigrams.has(bigram)) common += 1
    }
    return common >= 4 && common / Math.max(candidateBigrams.size, existingBigrams.size) >= 0.6
  })
}

/** 同一批抽取结果内的剧情候选去重，保留首次出现的描述。 */
export function deduplicateNarrativeCandidates<T extends NarrativeAdmissionFields>(candidates: T[]): T[] {
  const kept: T[] = []
  for (const candidate of candidates) {
    if (typeof candidate.description !== 'string' || candidate.description.trim().length < 4) continue
    const previous = kept.map((item, index) => ({
      id: String(index),
      description: String(item.description),
      status: 'active',
    }))
    if (findCoveredNarrative(previous, candidate)) continue
    kept.push(candidate)
  }
  return kept
}
