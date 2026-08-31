/**
 * style-measurement：文风形态共享测量器
 *
 * 统一"测别人的小说"（参考分析 → 专家蒸馏）与"测自己写的章节"
 * （文风指纹 chunk）两套历史平行实现。管线见 docs/dev/novel-style-system-v2.md。
 *
 * 设计约束：
 * - 纯函数，无 db / LLM 依赖
 * - 输出结构向后兼容 prompt-builder 文风指纹的展示字段
 * - 同一文本在此模块与 reference-analysis 的对应指标必须一致（有对拍测试）
 */

export interface StyleDistribution {
  count: number
  min: number
  max: number
  average: number
  median: number
  p90: number
}

export interface StyleMetricsSnapshot {
  /** 总字符数（去空白）与段落数，供可信度判断 */
  characterCount: number
  paragraphCount: number
  sentenceCount: number
  /** 句长分布（去空白字符） */
  sentenceLength: StyleDistribution & {
    buckets: Record<'1-10' | '11-20' | '21-40' | '41+', number>
  }
  /** 段落长度分布（去空白字符） */
  paragraphLength: StyleDistribution
  /** 对话占比：字符级与段落级 */
  dialogue: { charRatio: number; paragraphRatio: number }
  /** 比喻标记词密度（处/千字） */
  metaphorDensity: number
  /** 六通道感官词计数 */
  sensoryMix: {
    visual: number
    auditory: number
    olfactory: number
    tactile: number
    taste: number
    bodily: number
  }
  /** 人称信号词计数 */
  personSignal: { first: number; third: number }
  /** 叙事人称推断（沿用指纹的 2 倍阈值规则） */
  narrativePerson: 'first' | 'third' | 'mixed'
  /** 情感温度 0-10（每千字冷热词差归一，与指纹算法一致） */
  emotionalTemperature: number
  /** 短句（<15 字）与长句（>40 字）占比，百分比整数（指纹口径） */
  shortSentenceRatio: number
  longSentenceRatio: number
  /** 指标可信度：样本量达到 FINGERPRINT_TRUST 门槛且对话非恒零 */
  trustworthy: boolean
}

/** 引号匹配必须用转义码点：弯引号直接写进源文件曾被编码转换吃成 ASCII，对话占比恒为 0。 */
const DIALOGUE_QUOTE = /[\u201C\u300C\u300E"][^\u201D\u300D\u300F"\n]+[\u201D\u300D\u300F"]/u

const SENSORY_TERMS = {
  visual: ['看', '望', '瞥', '亮', '暗', '颜色', '光', '影'],
  auditory: ['听', '响', '声', '鸣', '吼', '低语', '耳边'],
  olfactory: ['闻', '气味', '香', '臭', '腥', '焦味'],
  tactile: ['冷', '热', '触', '摸', '粗糙', '柔软', '刺痛'],
  taste: ['甜', '苦', '酸', '咸', '辣', '味道'],
  bodily: ['呼吸', '心跳', '掌心', '喉咙', '胸口', '颤', '疼', '汗'],
} as const

const METAPHOR_WORDS = /犹如|宛若|仿佛|恍若|好似|有如|好像|像是/g
const HOT_WORDS = /怒|吼|咆哮|狂|爆|燃|热血|激昂|疯狂/g
const COLD_WORDS = /冷|静|默|沉|淡|克制|漠然/g

export const STYLE_MEASUREMENT_VERSION = 'style-measurement-v1'

/** 与 prompt-budget 的 FINGERPRINT_TRUST 保持同一语义；此处独立声明避免反向依赖 */
export const STYLE_TRUST_THRESHOLD = {
  minParagraphChars: 3000,
  minParagraphCount: 20,
} as const

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])/u)
    .map((value) => value.trim())
    .filter(Boolean)
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
}

function distribution(values: number[]): StyleDistribution {
  if (values.length === 0) return { count: 0, min: 0, max: 0, average: 0, median: 0, p90: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: values.length,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    average: Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2)),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
  }
}

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

function countTerms(text: string, terms: readonly string[]): number {
  return terms.reduce((sum, term) => sum + (text.split(term).length - 1), 0)
}

export function measureStyleMetrics(rawText: string): StyleMetricsSnapshot {
  const sentences = splitSentences(rawText)
  const paragraphs = splitParagraphs(rawText)
  const sentenceLengths = sentences.map((s) => s.replace(/\s/g, '').length)
  const paragraphLengths = paragraphs.map((p) => p.replace(/\s/g, '').length)
  const totalChars = paragraphLengths.reduce((sum, len) => sum + len, 0)

  const dialogueParagraphs = paragraphs.filter((p) => DIALOGUE_QUOTE.test(p))
  const dialogueChars = dialogueParagraphs.reduce((sum, p) => sum + p.replace(/\s/g, '').length, 0)
  const charRatio = totalChars === 0 ? 0 : Number((dialogueChars / totalChars).toFixed(4))
  const paragraphRatio =
    paragraphs.length === 0 ? 0 : Number((dialogueParagraphs.length / paragraphs.length).toFixed(4))

  const metaphorCount = countOccurrences(rawText, METAPHOR_WORDS)
  const metaphorDensity = totalChars === 0 ? 0 : Number(((metaphorCount / totalChars) * 1000).toFixed(1))

  const firstPerson = countOccurrences(rawText, /我(?!们|国|方|军|辈)/g)
  const thirdPerson = countOccurrences(rawText, /他|她|它/g)
  const narrativePerson: 'first' | 'third' | 'mixed' =
    firstPerson > thirdPerson * 2 ? 'first' : thirdPerson > firstPerson * 2 ? 'third' : 'mixed'

  const per1k = (count: number): number => (totalChars > 0 ? (count / totalChars) * 1000 : 0)
  const hot = countOccurrences(rawText, HOT_WORDS)
  const cold = countOccurrences(rawText, COLD_WORDS)
  const emotionalTemperature = Math.min(
    10,
    Math.max(0, Math.round(5 + (per1k(hot) - per1k(cold)) * 0.6)),
  )

  const trustworthy =
    totalChars >= STYLE_TRUST_THRESHOLD.minParagraphChars &&
    paragraphs.length >= STYLE_TRUST_THRESHOLD.minParagraphCount &&
    charRatio > 0 &&
    emotionalTemperature > 0

  return {
    characterCount: totalChars,
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    shortSentenceRatio:
      sentenceLengths.length === 0
        ? 0
        : Math.round((sentenceLengths.filter((v) => v < 15).length / sentenceLengths.length) * 100),
    longSentenceRatio:
      sentenceLengths.length === 0
        ? 0
        : Math.round((sentenceLengths.filter((v) => v > 40).length / sentenceLengths.length) * 100),
    sentenceLength: {
      ...distribution(sentenceLengths),
      buckets: {
        '1-10': sentenceLengths.filter((v) => v <= 10).length,
        '11-20': sentenceLengths.filter((v) => v >= 11 && v <= 20).length,
        '21-40': sentenceLengths.filter((v) => v >= 21 && v <= 40).length,
        '41+': sentenceLengths.filter((v) => v >= 41).length,
      },
    },
    paragraphLength: distribution(paragraphLengths),
    dialogue: { charRatio, paragraphRatio },
    metaphorDensity,
    sensoryMix: {
      visual: countTerms(rawText, SENSORY_TERMS.visual),
      auditory: countTerms(rawText, SENSORY_TERMS.auditory),
      olfactory: countTerms(rawText, SENSORY_TERMS.olfactory),
      tactile: countTerms(rawText, SENSORY_TERMS.tactile),
      taste: countTerms(rawText, SENSORY_TERMS.taste),
      bodily: countTerms(rawText, SENSORY_TERMS.bodily),
    },
    personSignal: { first: firstPerson, third: thirdPerson },
    narrativePerson,
    emotionalTemperature,
    trustworthy,
  }
}

/**
 * 将快照渲染为 prompt-builder 文风指纹的既有文本格式（向后兼容）。
 * label 用于标题中的提取范围说明。
 *
 * 短/长句口径沿用指纹原实现（<15 字 / >40 字），在快照桶之外单独计算，
 * 由 measureStyleMetrics 附带在内部计算结果上。
 */
export function formatStyleMetricsAsFingerprint(
  snapshot: StyleMetricsSnapshot & {
    shortSentenceRatio: number
    longSentenceRatio: number
  },
  label: string,
): string {
  const s = snapshot
  const lines: string[] = [
    `## 文风指纹（${label}，最近样本统计）`,
    '',
    `- 平均句长：${Math.round(s.sentenceLength.average)} 字`,
    `- 短句占比（<15字）：${s.shortSentenceRatio}%`,
    `- 长句占比（>40字）：${s.longSentenceRatio}%`,
    `- 对话占比：${Math.round(s.dialogue.charRatio * 100)}%`,
    `- 比喻密度：${s.metaphorDensity}/千字`,
    `- 段落平均长度：${Math.round(s.paragraphLength.average)} 字`,
    `- 叙事人称：${s.narrativePerson === 'first' ? '第一人称' : s.narrativePerson === 'third' ? '第三人称' : '混合人称'}`,
    `- 情感温度：${s.emotionalTemperature}/10（0=冷峻克制，10=热烈奔放）`,
  ]
  lines.push('')
  lines.push(
    s.trustworthy
      ? '说明：样本量足够，以上可作为最近正文的稳定倾向，但不是本章配额。当前场景、人物关系和叙事压力优先，允许在合理范围内偏离；不得为了贴近均值复制前章的句式、开场或段落节拍。'
      : '说明：以上仅为前文自动量化的观测值，样本量或指标可信度不足，仅作参考，不作为硬约束；本章文风以「项目文风档案」为准。',
  )
  return lines.join('\n')
}

/**
 * 与档案对照的"偏离型"指纹：项目配置了文风档案时用它替代全量数字版。
 *
 * 旧做法把最近章节的统计均值（平均句长/对话占比/情感温度…）整块注入，
 * 与档案里的同一组数字形成两套口径，把不同情绪的章节一齐拉向跨章均值。
 * 这里只报告**可信偏离**（人称相反 / 温度差 ≥2 / 对话占比差 ≥15 个百分点），
 * 让 Writer 知道"前文实际走向与档案目标的差距"；一致时明确说明无额外基线。
 */
export function formatStyleFingerprintDeviation(
  snapshot: StyleMetricsSnapshot & {
    shortSentenceRatio: number
    longSentenceRatio: number
  },
  profile: {
    narrativePerson: 'first' | 'third' | 'mixed'
    dialogueRatio: number
    emotionalTemperature: number
  },
  label: string,
): string {
  const deviations: string[] = []
  if (
    snapshot.narrativePerson !== 'mixed'
    && profile.narrativePerson !== 'mixed'
    && snapshot.narrativePerson !== profile.narrativePerson
  ) {
    const personLabel = (p: 'first' | 'third') => (p === 'first' ? '第一' : '第三')
    deviations.push(
      `叙事人称：前文以${personLabel(snapshot.narrativePerson)}人称为主，档案声明${personLabel(profile.narrativePerson)}人称；后续章节应向档案靠拢`,
    )
  }
  const tempDelta = snapshot.emotionalTemperature - profile.emotionalTemperature
  if (Math.abs(tempDelta) >= 2) {
    deviations.push(
      `情感温度：前文 ${snapshot.emotionalTemperature}/10，档案目标 ${profile.emotionalTemperature}/10（相差 ${Math.abs(tempDelta)}）`,
    )
  }
  const dialogueDelta =
    Math.round(snapshot.dialogue.charRatio * 100) - Math.round(profile.dialogueRatio)
  if (Math.abs(dialogueDelta) >= 15) {
    deviations.push(
      `对话占比：前文 ${Math.round(snapshot.dialogue.charRatio * 100)}%，档案目标约 ${Math.round(profile.dialogueRatio)}%（相差 ${Math.abs(dialogueDelta)} 个百分点）`,
    )
  }

  const lines: string[] = [`## 文风指纹（${label}，与档案对照）`, '']
  if (deviations.length === 0) {
    lines.push(
      '最近正文的人称、情感温度与对话占比均在档案允许范围内，无额外数值基线。',
      '',
      '说明：本章文风以「项目文风档案」为准，按当前场景的任务、关系和压力自然波动，允许合理偏离均值；不得为了贴近均值复制前章的句式、开场或段落节拍。',
    )
  } else {
    lines.push(
      '最近正文与档案存在以下偏离。写作时不必延续前文状态，向档案方向自然回归即可，不必一步到位：',
      ...deviations.map((deviation) => `- ${deviation}`),
      '',
      '说明：未列出的指标视为与档案一致。以上是观测对照，不是硬约束；当前场景的任务和叙事压力优先。',
    )
  }
  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// P2-3：修订前后 L1 形态指标差异报告
// ═══════════════════════════════════════════════════════════════

/**
 * 对比修订前后的关键 L1 形态指标，产出紧凑差异文本。
 *
 * 目的（风格系统 v2 收尾项）：让每次修订"改了什么"在形态层可验证——
 * Reviser 声称修复碎段/声音趋同时，句长分布与对话占比的位移就是证据；
 * 反过来，若修订把节奏修平（各分布向均值塌缩），差异表也会立刻暴露。
 */
export function buildStyleMetricsDiff(
  before: StyleMetricsSnapshot,
  after: StyleMetricsSnapshot,
): { changed: boolean; text: string } {
  const rows: Array<{ label: string; before: string; after: string }> = [
    {
      label: '平均句长（字）',
      before: String(Math.round(before.sentenceLength.average)),
      after: String(Math.round(after.sentenceLength.average)),
    },
    {
      label: '短句占比（<15字）',
      before: `${before.shortSentenceRatio}%`,
      after: `${after.shortSentenceRatio}%`,
    },
    {
      label: '长句占比（>40字）',
      before: `${before.longSentenceRatio}%`,
      after: `${after.longSentenceRatio}%`,
    },
    {
      label: '对话占比',
      before: `${Math.round(before.dialogue.charRatio * 100)}%`,
      after: `${Math.round(after.dialogue.charRatio * 100)}%`,
    },
    {
      label: '比喻密度（/千字）',
      before: String(Math.round(before.metaphorDensity * 10) / 10),
      after: String(Math.round(after.metaphorDensity * 10) / 10),
    },
    {
      label: '段落中位长度（字）',
      before: String(Math.round(before.paragraphLength.median)),
      after: String(Math.round(after.paragraphLength.median)),
    },
    {
      label: '情感温度',
      before: String(Math.round(before.emotionalTemperature * 10) / 10),
      after: String(Math.round(after.emotionalTemperature * 10) / 10),
    },
    {
      label: '叙事人称',
      before: before.narrativePerson,
      after: after.narrativePerson,
    },
  ]

  const changedRows = rows.filter((row) => row.before !== row.after)
  const text = [
    '## 修订前后形态指标对比（L1）',
    '',
    '| 指标 | 修订前 | 修订后 |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.label} | ${row.before} | ${row.after} |`),
    '',
    changedRows.length === 0
      ? '结论：各形态指标未发生显著变化（修订只动了措辞层）。'
      : `结论：${changedRows.length} 项形态指标发生变化（${changedRows.map((row) => row.label).join('、')}）。`,
  ].join('\n')

  return { changed: changedRows.length > 0, text }
}
