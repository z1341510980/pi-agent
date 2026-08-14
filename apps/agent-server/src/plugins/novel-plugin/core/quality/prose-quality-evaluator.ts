import { PROSE_SHAPE_LIMITS } from './quality-policy.js'
import { detectVoiceCollapse, type VoiceCollapseReport } from '../entities/character-voice.js'

export interface ProseQualityMetrics {
  characterCount: number
  paragraphCount: number
  sentenceCount: number
  singleSentenceParagraphs: number
  shortParagraphs: number
  maxConsecutiveSingleSentenceParagraphs: number
  dialogueRatio: number
  patternCounts: {
    binaryContrast: number
    explanatoryTone: number
    genericSimile: number
    genericSuspense: number
    metaWriting: number
    /** 作者直接命名情绪（"说不出心里是什么感觉"） */
    emotionNaming: number
    /** 同一判断在相邻段落里重复复述 */
    redundantRestatement: number
  }
  voice: VoiceCollapseReport
}

export interface ProseQualityIssue {
  code:
    | 'fragmented_paragraphs'
    | 'short_paragraph_density'
    | 'binary_contrast'
    | 'explanatory_tone'
    | 'generic_simile'
    | 'generic_suspense'
    | 'meta_writing'
    | 'emotion_naming'
    | 'redundant_restatement'
    | 'voice_uniform_length'
    | 'voice_all_complete'
    | 'voice_no_friction'
  severity: 'warning' | 'error'
  message: string
  /**
   * 命中处的原文摘录（最多 3 条，每条 ≤ 40 字）。
   *
   * 只报"出现 14 次"时 Reviser 无法定位，只能凭印象找，改出来的东西往往
   * 不是被检测到的那处。摘录让 `novel_apply_revision` 的 from 字段有据可依。
   */
  excerpts?: string[]
}

export interface ProseQualityReport {
  score: number
  metrics: ProseQualityMetrics
  issues: ProseQualityIssue[]
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

/** 取命中处的上下文摘录，供 Reviser 精确定位 */
function collectExcerpts(text: string, pattern: RegExp, limit = 3): string[] {
  const excerpts: string[] = []
  for (const match of text.matchAll(pattern)) {
    if (excerpts.length >= limit) break
    const start = Math.max(0, (match.index ?? 0) - 8)
    const excerpt = text.slice(start, (match.index ?? 0) + (match[0]?.length ?? 0) + 16)
      .replace(/\s+/g, ' ')
      .trim()
    if (excerpt) excerpts.push(excerpt)
  }
  return excerpts
}


/**
 * 作者替角色命名情绪。
 *
 * "他说不出心里是什么感觉""不知道是激动还是虚弱""一种茫然的、不太真实的庆幸"——
 * 这类句子把身体反应换成了情绪标签。人物越重要越不该替他解释，
 * 保留身体反应、错误动作或说不出口的话即可。
 */
const EMOTION_NAMING_PATTERN =
  /(?:说不(?:出|清)[^。！？\n]{0,8}(?:是什么)?(?:感觉|滋味|情绪)|不知道是[^。！？\n]{1,12}还是[^。！？\n]{1,12}|一(?:种|股)[^。！？\n]{0,14}的(?:感觉|情绪|滋味|庆幸|恐惧|安心)|心里(?:五味杂陈|说不出|涌起|翻涌))/g

/** 泛化"像……"比喻（排除"像样""好像是"这类非比喻用法） */
const GENERIC_SIMILE_PATTERN = /像(?:是|有|一|某|什么|被|在)?[^，。！？\n]{1,24}/g

/**
 * 相邻段落复述同一判断。
 *
 * 实测形态：对话先说明结论，紧接着叙述再用"他当然知道""这意味着"解释一遍，
 * 或把同一个词（"不存在"）连续三段复述。检测方式是找相邻段落间的高重合短语。
 */
function countRedundantRestatement(paragraphs: string[]): { count: number; excerpts: string[] } {
  const excerpts: string[] = []
  let count = 0
  for (let index = 1; index < paragraphs.length; index += 1) {
    const previous = paragraphs[index - 1].replace(/[\s"“”「」『』]/g, '')
    const current = paragraphs[index].replace(/[\s"“”「」『』]/g, '')
    if (previous.length < 6 || current.length < 6) continue
    // 取当前段的 4 字滑窗，看有多少落在上一段里
    let overlap = 0
    let windows = 0
    for (let offset = 0; offset + 4 <= current.length; offset += 2) {
      windows += 1
      if (previous.includes(current.slice(offset, offset + 4))) overlap += 1
    }
    if (windows >= 3 && overlap / windows >= 0.5) {
      count += 1
      if (excerpts.length < 3) excerpts.push(paragraphs[index].slice(0, 40))
    }
  }
  return { count, excerpts }
}

/** 找出最长的一段连续单句段，原样交给 Reviser 做段落合成 */
function collectLongestSingleRun(paragraphs: string[], sentenceCounts: number[]): string[] {
  let bestStart = -1
  let bestLength = 0
  let currentStart = -1
  let currentLength = 0
  for (let index = 0; index < sentenceCounts.length; index += 1) {
    if (sentenceCounts[index] === 1) {
      if (currentLength === 0) currentStart = index
      currentLength += 1
      if (currentLength > bestLength) {
        bestLength = currentLength
        bestStart = currentStart
      }
    } else {
      currentLength = 0
    }
  }
  if (bestStart < 0 || bestLength < 2) return []
  return paragraphs.slice(bestStart, bestStart + Math.min(bestLength, 5))
}

function splitParagraphs(content: string): string[] {

  return content
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
}

/**
 * 统计段落里的句子数。
 *
 * ⚠️ 旧实现是 `/[。！？!?]+(?=[”"」』）)]|\s|$)/g`：句末标点必须紧跟收尾引号、空白或段末
 * 才算一句。中文段落里句子是连写的（"他推开门。门外站着一个人。"），第一个句号后面
 * 直接是汉字，于是**段内所有非末尾的句子都数不到**，任何段落都只算 1 句。
 *
 * 后果：singleSentenceParagraphs ≈ paragraphCount，单句段占比恒在 80%-99%，
 * `fragmented_paragraphs` 在真实项目的 11 章里 **11 章全部命中 error**，
 * 每章都强制走一次 Reviser —— 一个永远为真的检查不携带任何信息。
 *
 * 现在改为匹配"句末标点 + 可选的收尾引号"，段内连写的句子也能数到。
 */
function countSentences(paragraph: string): number {
  const count = countMatches(paragraph, /[。！？!?]+["”』」）)]*/g)
  return Math.max(1, count)
}

function computeDialogueRatio(content: string, characterCount: number): number {
  if (characterCount === 0) return 0
  const dialogueCharacters = [...content.matchAll(/[“「『"]([^”」』"\n]{1,500})[”」』"]/g)]
    .reduce((sum, match) => sum + (match[1]?.replace(/\s/g, '').length ?? 0), 0)
  return Math.round((dialogueCharacters / characterCount) * 1000) / 10
}

/**
 * 只测量可确定的正文形态，不判断剧情好坏。
 *
 * 阈值刻意保守：报告用于 Reviewer 复核，不直接触发整章重写，避免把风格偏好
 * 误判为致命错误。项目文风档案仍是最终判断依据。
 */
export function evaluateProseQuality(content: string): ProseQualityReport {
  const paragraphs = splitParagraphs(content)
  const characterCount = content.replace(/\s/g, '').length
  const sentenceCounts = paragraphs.map(countSentences)
  const singleSentenceParagraphs = sentenceCounts.filter(count => count === 1).length
  const shortParagraphs = paragraphs.filter(paragraph => paragraph.replace(/\s/g, '').length <= 18).length
  let maxConsecutiveSingleSentenceParagraphs = 0
  let currentConsecutive = 0
  for (const count of sentenceCounts) {
    currentConsecutive = count === 1 ? currentConsecutive + 1 : 0
    maxConsecutiveSingleSentenceParagraphs = Math.max(maxConsecutiveSingleSentenceParagraphs, currentConsecutive)
  }

  const restatement = countRedundantRestatement(paragraphs)
  const patternCounts = {
    binaryContrast: countMatches(content, /(?:不是|并非|不在于)[^。！？\n]{1,60}(?:而是|而在于)|与其说[^。！？\n]{1,50}不如说/g),
    explanatoryTone: countMatches(content, /(?:这意味着|换句话说|也就是说|由此可见|显而易见|他明白了|她明白了|逻辑(?:很)?清楚)/g),
    genericSimile: countMatches(content, GENERIC_SIMILE_PATTERN),
    genericSuspense: countMatches(content, /(?:黑暗里.*睁开|命运的齿轮|冥冥之中|真正的.*才刚刚开始|一切才刚开始|没有(?:任何)?人(?:发现|注意到)|似乎有(?:什么|某种)东西)/g),
    metaWriting: countMatches(content.slice(0, 600), /(?:先核对|按(?:章纲|导演方案)|下面(?:开始|是).*正文|创作第\s*\d+\s*章|输出完整正文|修订完成|修改说明)/g),
    emotionNaming: countMatches(content, EMOTION_NAMING_PATTERN),
    redundantRestatement: restatement.count,
  }

  const metrics: ProseQualityMetrics = {
    characterCount,
    paragraphCount: paragraphs.length,
    sentenceCount: sentenceCounts.reduce((sum, count) => sum + count, 0),
    singleSentenceParagraphs,
    shortParagraphs,
    maxConsecutiveSingleSentenceParagraphs,
    dialogueRatio: computeDialogueRatio(content, characterCount),
    patternCounts,
    voice: detectVoiceCollapse(content),
  }

  const issues: ProseQualityIssue[] = []
  const singleRatio = paragraphs.length > 0 ? singleSentenceParagraphs / paragraphs.length : 0
  const shortRatio = paragraphs.length > 0 ? shortParagraphs / paragraphs.length : 0
  const perThousand = Math.max(1, characterCount / 1000)

  // 阈值统一来自 quality-policy 的 PROSE_SHAPE_LIMITS：
  // prompt 侧（role-writer.md）与这里的检查必须用同一组数字。
  // 历史上 prompt 写"连续三段以上"、检查却是"连续 6 段"，Writer 被多约束了一截，
  // 而那个更严的要求没有任何一方校验（S5 登记的冲突之一）。
  if (
    paragraphs.length >= PROSE_SHAPE_LIMITS.minParagraphsForShapeCheck
    && (
      singleRatio >= PROSE_SHAPE_LIMITS.singleSentenceRatioWarning
      || maxConsecutiveSingleSentenceParagraphs > PROSE_SHAPE_LIMITS.maxConsecutiveSingleSentenceParagraphs
    )
  ) {
    issues.push({
      code: 'fragmented_paragraphs',
      severity: singleRatio >= PROSE_SHAPE_LIMITS.singleSentenceRatioError ? 'error' : 'warning',
      message: `单句段 ${singleSentenceParagraphs}/${paragraphs.length}（${Math.round(singleRatio * 1000) / 10}%），最长连续 ${maxConsecutiveSingleSentenceParagraphs} 段，正文呈提纲式碎片节奏`,
      excerpts: collectLongestSingleRun(paragraphs, sentenceCounts),
    })
  }
  if (
    paragraphs.length >= PROSE_SHAPE_LIMITS.minParagraphsForShapeCheck
    && shortRatio >= PROSE_SHAPE_LIMITS.shortParagraphRatioWarning
  ) {
    issues.push({
      code: 'short_paragraph_density',
      severity: shortRatio >= PROSE_SHAPE_LIMITS.shortParagraphRatioError ? 'error' : 'warning',
      message: `18 字以内短段 ${shortParagraphs}/${paragraphs.length}（${Math.round(shortRatio * 1000) / 10}%），短段应只留给真正改变局势的动作或台词`,
      excerpts: paragraphs.filter((paragraph) => paragraph.replace(/\s/g, '').length <= 18).slice(0, 3),
    })
  }

  if (patternCounts.binaryContrast >= 3) {
    issues.push({
      code: 'binary_contrast',
      severity: 'warning',
      message: `检测到 ${patternCounts.binaryContrast} 处“不是 A 而是 B”式对称解释`,
      excerpts: collectExcerpts(content, /(?:不是|并非|不在于)[^。！？\n]{1,60}(?:而是|而在于)/g),
    })
  }
  if (patternCounts.explanatoryTone >= 3) {
    issues.push({
      code: 'explanatory_tone',
      // 解释腔是 AI 痕迹里最难自查的一类：3 处以上说明它已成为默认叙述方式
      severity: patternCounts.explanatoryTone >= 6 ? 'error' : 'warning',
      message: `检测到 ${patternCounts.explanatoryTone} 处替读者归纳的解释句`,
      excerpts: collectExcerpts(content, /(?:这意味着|换句话说|也就是说|由此可见|显而易见|他明白了|她明白了)[^。！？\n]{0,24}/g),
    })
  }
  const similePerThousand = patternCounts.genericSimile / perThousand
  if (similePerThousand >= PROSE_SHAPE_LIMITS.genericSimilePerThousandWarning) {
    issues.push({
      code: 'generic_simile',
      severity: similePerThousand >= PROSE_SHAPE_LIMITS.genericSimilePerThousandError ? 'error' : 'warning',
      message: `泛化“像……”比喻 ${patternCounts.genericSimile} 处（每千字 ${Math.round(similePerThousand * 10) / 10} 处），密度偏高`,
      excerpts: collectExcerpts(content, GENERIC_SIMILE_PATTERN),
    })
  }
  if (patternCounts.genericSuspense > 0) {
    issues.push({
      code: 'generic_suspense',
      severity: 'warning',
      message: `检测到 ${patternCounts.genericSuspense} 处模板化悬念句（旁白宣布危险，而不是让异常产生可验证后果）`,
      excerpts: collectExcerpts(content, /(?:没有(?:任何)?人(?:发现|注意到)|似乎有(?:什么|某种)东西|命运的齿轮|冥冥之中)[^。！？\n]{0,20}/g),
    })
  }
  if (patternCounts.emotionNaming >= 2) {
    issues.push({
      code: 'emotion_naming',
      severity: patternCounts.emotionNaming >= 4 ? 'error' : 'warning',
      message: `检测到 ${patternCounts.emotionNaming} 处作者替角色命名情绪，应改为身体反应、错误动作或说不出口的话`,
      excerpts: collectExcerpts(content, EMOTION_NAMING_PATTERN),
    })
  }
  if (patternCounts.redundantRestatement >= 3) {
    issues.push({
      code: 'redundant_restatement',
      severity: patternCounts.redundantRestatement >= 5 ? 'error' : 'warning',
      message: `检测到 ${patternCounts.redundantRestatement} 处相邻段落复述同一判断，对白、动作、心理三者只应有一个负责传递该信息`,
      excerpts: restatement.excerpts,
    })
  }
  if (patternCounts.metaWriting > 0) {
    issues.push({ code: 'meta_writing', severity: 'error', message: '正文开头包含核对、创作或修订说明' })
  }
  // 角色声音趋同：三项各自独立，命中即报，交由仲裁决定动作
  for (const voiceIssue of metrics.voice.issues) {
    issues.push({
      code: voiceIssue.code,
      // "全完整句"和"无摩擦"直接对应用户反馈的"所有角色像同一个人"，按 error 处理
      severity: voiceIssue.code === 'voice_uniform_length' ? 'warning' : 'error',
      message: voiceIssue.message,
    })
  }


  const score = Math.max(0, issues.reduce((current, issue) => (
    current - (issue.severity === 'error' ? 18 : 8)
  ), 100))
  return { score, metrics, issues }
}

export function formatProseQualityReport(report: ProseQualityReport): string {
  const { metrics } = report
  const lines = [
    '## 正文形态扫描（确定性指标，需结合文风档案复核）',
    `- 形态分：${report.score}/100`,
    `- 段落：${metrics.paragraphCount}；单句段：${metrics.singleSentenceParagraphs}；18 字内短段：${metrics.shortParagraphs}；最长连续单句段：${metrics.maxConsecutiveSingleSentenceParagraphs}`,
    `- 估算对话占比：${metrics.dialogueRatio}%`,
  ]
  if (metrics.voice.dialogueCount >= 8) {
    lines.push(
      `- 台词：${metrics.voice.dialogueCount} 条；均长 ${metrics.voice.averageLength} 字（标准差 ${metrics.voice.lengthDeviation}）；`
      + `完整句收尾 ${metrics.voice.completeSentenceRatio}%；反问/回避/未答 ${metrics.voice.evasiveRatio}%`,
    )
  }
  if (report.issues.length === 0) {
    lines.push('- 未命中高置信度形态问题；这不等于文学质量自动通过。')
  } else {
    for (const issue of report.issues) {
      lines.push(`- [${issue.severity === 'error' ? '严重' : '提示'}] ${issue.message}`)
      // 摘录直接给 Reviser 定位用：报告里只有次数时它只能凭印象找，改的往往不是命中处
      for (const excerpt of issue.excerpts ?? []) {
        lines.push(`  · 原文：${excerpt}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * 区分「局部替换」与「结构性文字重整」。
 *
 * Reviser 被限制为最小改动（novel_apply_revision 的 from/to 精确替换），
 * 这对"换掉一个比喻"够用，但对**整章段落同构**无效：单句段占比 66% 不是某几句的
 * 问题，是全章默认格式。硬让 Reviser 用 from/to 去改，它只会替换掉三五处，
 * 扫描仍然不过。
 *
 * 这里把命中项分成两类，供 orchestrator 决定给 Reviser 哪种模式的指令。
 */
const STRUCTURAL_ISSUE_CODES = new Set<ProseQualityIssue['code']>([
  'fragmented_paragraphs',
  'short_paragraph_density',
  'redundant_restatement',
  'voice_all_complete',
  'voice_no_friction',
  'voice_uniform_length',
])

export interface ProseRevisionPlan {
  /** 需要整章文字重整（段落重新聚合 / 对白重组），不能只做 from/to 替换 */
  needsStructuralRework: boolean
  structural: ProseQualityIssue[]
  local: ProseQualityIssue[]
  /** 注入 Reviser 的可执行指令 */
  instruction: string
}

/** 每类结构性问题对应的具体修法：只说"有问题"会让 Reviser 原地打转 */
const STRUCTURAL_FIX_HINTS: Partial<Record<ProseQualityIssue['code'], string>> = {
  fragmented_paragraphs:
    '把连续单句段按"动作、感知、反应"合并成完整段落。单句成段只保留给真正改变局势的动作或台词，'
    + `全章连续单句段不得超过 ${PROSE_SHAPE_LIMITS.maxConsecutiveSingleSentenceParagraphs} 段。`,
  short_paragraph_density:
    '短段不是节奏，空行不产生停顿。把相邻的短段并入它所属的动作单元，让段落长度由场景压力决定。',
  redundant_restatement:
    '同一条信息只留一个承担者：对白说过的，叙述不再解释；心理已经暗示的，不再补一句结论。删除复述，不要改写成同义句。',
  voice_all_complete:
    '让至少三分之一的台词不完整：被打断、只说一半、答非所问、用动作代替回答。删掉"他说"后面的解释性补语。',
  voice_no_friction:
    '给对话加入权限限制、信息保留、打断、误解和未回答的问题。不同角色的回答方式必须不同，不能都完整准确地依次作答。',
  voice_uniform_length:
    '按角色声音对照表拉开台词长度差：短句角色的台词压到 12 字以内，长句角色允许带条件和补充说明。',
}

export function buildProseRevisionPlan(report: ProseQualityReport): ProseRevisionPlan {
  const structural = report.issues.filter((issue) => STRUCTURAL_ISSUE_CODES.has(issue.code))
  const local = report.issues.filter((issue) => !STRUCTURAL_ISSUE_CODES.has(issue.code))
  // 只有严重级结构问题才值得开放整章重整权限；warning 级仍走局部替换
  const needsStructuralRework = structural.some((issue) => issue.severity === 'error')

  const lines: string[] = []
  if (needsStructuralRework) {
    lines.push(
      '## 修订模式：结构性文字重整',
      '',
      '本章命中的是**整章段落与对白同构**，不是个别句子的问题。允许你重新切分段落、合并短段、'
      + '重组对白顺序，但必须保持情节事件、人物动作顺序、已埋伏笔和信息边界完全不变。',
      '',
      '必须处理：',
    )
    for (const issue of structural) {
      lines.push(`- ${issue.message}`)
      const hint = STRUCTURAL_FIX_HINTS[issue.code]
      if (hint) lines.push(`  修法：${hint}`)
      for (const excerpt of issue.excerpts ?? []) lines.push(`  原文：${excerpt}`)
    }
  } else if (structural.length > 0) {
    lines.push('## 形态提示（局部处理即可）', '')
    for (const issue of structural) lines.push(`- ${issue.message}`)
  }
  if (local.length > 0) {
    lines.push('', '## 局部替换项（逐处修改，不要重写周边段落）', '')
    for (const issue of local) {
      lines.push(`- ${issue.message}`)
      for (const excerpt of issue.excerpts ?? []) lines.push(`  原文：${excerpt}`)
    }
  }
  return { needsStructuralRework, structural, local, instruction: lines.join('\n').trim() }
}


