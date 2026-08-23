import { createHash } from 'node:crypto'
import type {
  ChapterPositioning,
  NarrativeTaskType,
  NovelWritingStyleProfile,
} from '../types.js'

export type WritingStylePromptTarget = 'writer' | 'reviser' | 'reviewer'

export interface CompiledWritingStylePrompt {
  profileId: string
  profileVersion: number
  profileHash: string
  target: WritingStylePromptTarget
  content: string
}

const PERSON_LABELS: Record<NovelWritingStyleProfile['narrativePerson'], string> = {
  first: '第一人称',
  third: '第三人称',
  mixed: '允许混合人称，但场景内必须稳定',
}

const DISTANCE_LABELS: Record<NovelWritingStyleProfile['narrativeDistance'], string> = {
  intimate: '贴身视角，感知紧贴 POV 角色',
  limited: '限制视角，只写当前 POV 能感知或推断的信息',
  omniscient: '全知视角，但避免作者替读者总结',
}

const RHYTHM_LABELS: Record<NovelWritingStyleProfile['sentenceRhythm'], string> = {
  short: '短句为主，动作直接，停顿清楚',
  balanced: '长短句交替，按场景压力变化',
  long: '中长句为主，允许细节展开，但避免句法拖沓',
}

const REGISTER_LABELS: Record<NovelWritingStyleProfile['vocabularyRegister'], string> = {
  colloquial: '自然口语，避免书面讲义腔',
  plain: '平实准确，少用炫技词汇',
  literary: '有文学质感，但修辞必须服务场景',
  classical: '适度古雅，避免生硬堆砌文言词',
}

function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/[\u2013\u2014\u2015]+/g, '。')
    .trim()
    .slice(0, maxLength)
}

/**
 * 文风样本常见于用户从别处粘贴的正文，会夹带防爬虫水印乱码
 * （例如 `*如.闻_枉_ ^冕￠废.越^读+`、`+丸′ ! \鰰?占+`）。
 * 这类字符会被模型当成正文特征学习，必须在进 prompt 前清掉。
 */
const SAMPLE_NOISE_RUN = /[\\^~`_|+*/<>=@#$%&\u00a0\u00b4\u00a8\uffe5]{1,}/g
const SAMPLE_RARE_CJK = /[\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2ffff}]/gu

function stripSampleNoise(value: string): string {
  return value
    .replace(SAMPLE_RARE_CJK, '')
    .replace(SAMPLE_NOISE_RUN, '')
    // 乱码清掉后常留下孤立的标点串
    .replace(/[，、。；：]{2,}/g, (run) => run[0])
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 按段落/句子边界截断，避免样本停在半句话上（旧实现直接 slice，
 * 结果样本末尾是孤零零一个左引号，模型学到的是"断句"而不是文风）。
 */
function truncateAtBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const paragraphs = value.split(/\n+/)
  const kept: string[] = []
  let used = 0
  for (const paragraph of paragraphs) {
    const next = used + paragraph.length + 1
    if (next > maxLength) break
    kept.push(paragraph)
    used = next
  }
  if (kept.length > 0) return kept.join('\n\n').trim()
  // 单段超长：退到句末边界
  const head = value.slice(0, maxLength)
  const lastStop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'))
  return (lastStop > maxLength * 0.4 ? head.slice(0, lastStop + 1) : head).trim()
}

function cleanSample(value: string, maxLength: number): string {
  const cleaned = stripSampleNoise(cleanText(value, maxLength * 3))
  return truncateAtBoundary(cleaned, maxLength)
}

/**
 * 正向样本给足体积才能承载"句式 + 观察距离 + 节奏"。
 * 700 字太短：中文样本必然断在句中，模型学到的是断句而不是文风。
 * P1-2 扩容到 2400 字：单样本足以覆盖一次完整的场景起伏；
 * 静态身份只保留 1 条锚定样本，其余按章节场景类型分桶注入（见 buildSceneSampleSection）。
 * 反向样本只需识别出要避开的句壳，维持较小预算。
 */
const POSITIVE_SAMPLE_MAX_LENGTH = 2400
const NEGATIVE_SAMPLE_MAX_LENGTH = 500
/**
 * P1-2 扩容：7199 → 11999。
 * 文风档案属于 STATIC 身份层（跨章缓存），扩容只增加一次性缓存写入，
 * 命中后不再产生输入计费差；上限仍受 joinPromptSectionsWithinBudget 强制。
 */
const WRITING_STYLE_PROMPT_MAX_LENGTH = 11999
const PROFILE_HASH_LENGTH = 16
const PROFILE_MARKER_PREFIX = '\n\n文风档案标识：'

function listSection(title: string, values: string[], limit: number, itemMaxLength = 180): string {
  const lines = values
    .map(value => cleanText(value, itemMaxLength))
    .filter(Boolean)
    .slice(0, limit)
  if (lines.length === 0) return ''
  return [`### ${title}`, ...lines.map(line => `- ${line}`)].join('\n')
}

function buildBaseSections(profile: NovelWritingStyleProfile): string[] {
  const sections = [
    `## 项目文风档案：${cleanText(profile.name, 80)}`,
    `档案版本：v${profile.version}`,
    [
      '### 叙事声音',
      `- 叙事人称：${PERSON_LABELS[profile.narrativePerson]}`,
      `- 叙事距离：${DISTANCE_LABELS[profile.narrativeDistance]}`,
      `- 句式节奏：${RHYTHM_LABELS[profile.sentenceRhythm]}`,
      `- 语言语域：${REGISTER_LABELS[profile.vocabularyRegister]}`,
      `- 对话参考中心：约 ${Math.round(profile.dialogueRatio)}%（这是跨场景倾向，不是逐章配额）`,
      `- 情感温度：${profile.emotionalTemperature}/10`,
      `- 意象与比喻密度：${profile.imageryDensity}/10`,
    ].join('\n'),
    // 文风档案属于 Agent identity，必须有明确体积预算。优先保留靠前规则，
    // 避免用户粘贴大量说明后让每次 Writer/Reviewer 调用膨胀数千字符。
    listSection('硬约束', profile.hardRules, 8),
    listSection('软偏好', profile.softRules, 6),
    [
      '### 变化预算',
      '- 文风档案描述稳定声音，不规定固定句式、固定段落长度或固定开场方式。',
      '- 场景任务、人物关系、信息压力和 POV 感知优先；对话比例、句长、情感温度与意象密度可以随场景自然波动。',
      '- 相邻章节不得为了贴近档案而重复相同的开场、转折、动作节拍、比喻骨架或收束方式。',
    ].join('\n'),
  ].filter(Boolean)

  const notes = cleanText(profile.notes, 400)
  if (notes) sections.push(`### 补充说明\n${notes}`)

  const experts = (profile.styleExperts ?? []).filter((expert) => expert.enabled).slice(0, 8)
  if (experts.length > 0) {
    const perExpertBudget = Math.max(180, Math.min(1200, Math.floor(2000 / experts.length)))
    sections.push([
      '### 本次召集的独立文风能力',
      '以下能力来自参考小说样本的写作机制蒸馏。它们不是内容模板，不改变本章任务、人物行动、事实和 POV。只迁移已审核的手法，不复制原作内容。',
      ...experts.map((expert) => cleanText([
        `- **${cleanText(expert.name, 20)}**（${cleanText(expert.sourceTitle, 35)}）`,
        cleanText(expert.description, 60),
        `迁移提示：${cleanText(expert.customPrompt ?? expert.distilledPrompt, 240)}`,
        ...(expert.techniques ?? []).filter((technique) => technique.kept && technique.confidence === 'verified').slice(0, 2).map((technique) => {
          const evidence = technique.evidence[0]?.quote
          return `  - [${technique.dimension}] ${cleanText(technique.name, 30)}：${cleanText(technique.mechanism, 70)}；${cleanText(technique.transfer, 70)}${evidence ? `；证据方向：${cleanText(evidence, 30)}` : ''}`
        }),
        ...(expert.exemplarPassages ?? []).slice(0, 2).map((passage) => `  - 手法样本（只学机制）：${cleanText(passage.text, 180)}`),
        ...(expert.exclusions ?? []).slice(0, 4).map((item) => `  - 不得迁移：${cleanText(item, 60)}`),
      ].join('\n  '), perExpertBudget)),
    ].join('\n'))
  }

  const examples = profile.positiveExamples
    .map(example => cleanSample(example, POSITIVE_SAMPLE_MAX_LENGTH))
    .filter(Boolean)
    // P1-2：静态身份只保留 1 条锚定样本；其余样本按章节场景类型
    // 由 buildSceneSampleSection 分桶注入（per-chapter，不破坏静态缓存）
    .slice(0, 1)
  if (examples.length > 0) {
    sections.push([
      '### 正向文风样本',
      '样本优先示范自然句法、观察距离、段落呼吸、信息留白和用词来源。只学习这些写法，不复用人物、情节或专有名词。',
      '样本不是句式模板，也不是逐句改写对象。不要复制其显眼词组，不要为了模仿而堆修辞；先写本章正在发生的事，再让句子自然靠近样本的节奏。',
      '样本里的单句段、对话比例和特殊句式只说明当时的场景压力，不是全书统一配方。',
      ...examples.map((example, index) => `\n【样本 ${index + 1}】\n${example}`),
    ].join('\n'))
  }
  const negativeExamples = profile.negativeExamples
    .map(example => cleanSample(example, NEGATIVE_SAMPLE_MAX_LENGTH))
    .filter(Boolean)
    .slice(0, 2)
  if (negativeExamples.length > 0) {
    sections.push([
      '### 反向文风样本',
      '以下样本只用于识别并避开其句式、解释方式和段落节奏，不得复述或模仿。',
      ...negativeExamples.map((example, index) => `\n【反例 ${index + 1}】\n${example}`),
    ].join('\n'))
  }
  return sections
}

function truncatePromptAtBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const head = value.slice(0, maxLength)
  const boundary = Math.max(
    head.lastIndexOf('\n\n'),
    head.lastIndexOf('\n'),
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
  )
  return head.slice(0, boundary > maxLength * 0.75 ? boundary + 1 : maxLength).trimEnd()
}

/**
 * 极端档案优先裁掉可选尾部，始终保留最后一段 Agent 职责说明。
 * 哈希标识在预算之外单独预留，确保最终返回值也严格低于上限。
 */
function joinPromptSectionsWithinBudget(sections: string[]): string {
  const maxContentLength = WRITING_STYLE_PROMPT_MAX_LENGTH
    - PROFILE_MARKER_PREFIX.length
    - PROFILE_HASH_LENGTH
  const requiredSection = sections.at(-1) ?? ''
  const optionalContent = sections.slice(0, -1).join('\n\n')
  if (!optionalContent) return truncatePromptAtBoundary(requiredSection, maxContentLength)

  const separator = '\n\n'
  const optionalBudget = Math.max(0, maxContentLength - separator.length - requiredSection.length)
  const boundedOptionalContent = truncatePromptAtBoundary(optionalContent, optionalBudget)
  return `${boundedOptionalContent}${separator}${requiredSection}`
}

export function selectStyleExperts(
  profile: NovelWritingStyleProfile,
  selectedIds?: string[],
): NovelWritingStyleProfile {
  if (selectedIds === undefined) return profile
  return {
    ...profile,
    styleExperts: (profile.styleExperts ?? []).filter((expert) => selectedIds.includes(expert.id)),
  }
}

const POSITIONING_DECISIONS: Record<ChapterPositioning, {
  label: string
  focus: string
  variation: string
}> = {
  high_pressure: {
    label: '高压章',
    focus: '动作、阻力和即时后果优先，只保留人物在压力下真正来得及注意的信息。',
    variation: '句子和段落可以临时收紧；少解释，但不要把全章切成整齐的短句。',
  },
  advancement: {
    label: '推进章',
    focus: '让人物的选择带来可见增量，场景之间由后果衔接，不按任务字段逐项交付。',
    variation: '允许观察、停顿和无效动作，不要求每一段都推进主线。',
  },
  cultivation: {
    label: '修炼试错章',
    focus: '过程、失败、身体反馈和代价优先，让领悟从具体尝试中出现。',
    variation: '可以放慢关键步骤；不要用总结替代试错，也不必固定为成功收尾。',
  },
  relationship: {
    label: '关系章',
    focus: '用选择、回避、误答和未完成的话改变关系，不让人物把感受解释完整。',
    variation: '对话可以明显高于项目均值，停顿和不合时宜的小事可以保留。',
  },
  low_pressure: {
    label: '低压章',
    focus: '让生活动作、感官和人物习惯承载关系或状态变化，不临时制造大冲突。',
    variation: '允许闲笔和较长呼吸，只要细节来自人物当下，不在段尾总结意义。',
  },
  information: {
    label: '信息章',
    focus: '让信息附着在追问、误解、物件和行动后果上，避免集中讲解或列清单。',
    variation: '信息可以分散、延迟或被说错；不要求本章把所有疑问整理干净。',
  },
}

const TASK_DECISIONS: Record<NarrativeTaskType, string> = {
  advance_mainline: '主线变化落到人物选择及其后果，不用旁白宣布“剧情推进”。',
  advance_subline: '支线必须影响当前关系、资源或判断，避免写成与主线隔离的插曲。',
  create_conflict: '冲突从双方都说得通的欲望中发生，不把一方临时写笨。',
  escalate_conflict: '升级来自已有选择的代价，不靠突然加码或旁白提高音量。',
  release_info: '明确谁为何此刻透露、谁只听到一部分，以及信息怎样改变行动。',
  hide_info: '保留人物有理由忽略或误读的痕迹，不用全知旁白替读者遮挡。',
  reinforce_foreshadow: '让既有痕迹改变一次判断或行动，不重复提醒它很重要。',
  recover_foreshadow: '回收要产生新后果，不只解释旧线索的正确答案。',
  change_relationship: '关系变化由一次有代价的选择显影，不由双方达成完整共识。',
  change_cognition: '认知变化保留迟疑和旧习惯的惯性，不让人物瞬间想通一切。',
  create_reversal: '反转改写读者对既有事实的理解，但不撤销已经发生的因果。',
  create_suspense: '悬念留下可验证的异常或限制，不用泛化危险宣告。',
  phase_closure: '收束阶段后果，同时保留人物未能整理干净的余波。',
  introduce_problem: '新问题从当前行动中长出，并立刻给人物造成具体阻力。',
}

/**
 * 把项目级文风压缩成一次性的章节选择，避免 Writer 同时背诵整套统计指标。
 * 精确段落比例和修辞计数由写后质量门处理，这里只决定当前章节的写法重心。
 */
export function buildStyleDecisionPack(input: {
  positioning?: ChapterPositioning | null
  narrativeTaskType: NarrativeTaskType
  profile?: Pick<
    NovelWritingStyleProfile,
    'narrativePerson' | 'narrativeDistance' | 'vocabularyRegister'
  >
}): string {
  const decision = input.positioning
    ? POSITIONING_DECISIONS[input.positioning]
    : {
        label: '未指定定位',
        focus: '以人物此刻的欲望、阻力和选择决定速度，不预设统一段落形态。',
        variation: '根据场景压力自然改变句长、对话密度和感官重心。',
      }
  const stableVoice = input.profile
    ? `${PERSON_LABELS[input.profile.narrativePerson]}；${DISTANCE_LABELS[input.profile.narrativeDistance]}；${REGISTER_LABELS[input.profile.vocabularyRegister]}。`
    : '沿用现有正文的人称、观察距离和语域，不自行发明固定句式。'

  return [
    `### 本章风格决策：${decision.label}`,
    `- 稳定声音：${stableVoice}`,
    `- 场景重心：${decision.focus}`,
    `- 任务落点：${TASK_DECISIONS[input.narrativeTaskType]}`,
    `- 变化许可：${decision.variation}`,
    '- 自然度：允许有来处的停顿、误解、句法不规则和局部闲笔；不要为了整齐而修平。',
  ].join('\n')
}

export function compileWritingStylePrompt(
  profile: NovelWritingStyleProfile,
  target: WritingStylePromptTarget,
): CompiledWritingStylePrompt {
  const sections = buildBaseSections(profile)
  if (target === 'writer') {
    sections.push('### 执行方式\n文风档案中的人工样本负责告诉你“读起来像什么”，不是一份需要逐项打勾的规则。剧情事实、POV 和角色约束优先；在不冲突时，保留样本体现出的自然观察、留白和节奏，但不要复刻样本或前章的句式路径。先判断当前场景需要怎样的速度、距离和对话压力，再从档案允许的范围内选择写法。风格只能通过正文中的具体选择实现，不要在正文中解释这些规则。')
  } else if (target === 'reviser') {
    sections.push('### 修订方式\n你输出的“修改后”文字必须保持本档案的稳定声音，其中人称、视角信息范围和明确硬约束必须遵守；句式节奏、对话密度、情感温度和意象密度只需落在当前场景合理范围。只修复审稿指出的问题，不要为了风格统一把整章改成同一种句长、语气或段落节拍，也不要抹平人物之间的声音差异。')
  } else {
    sections.push('### 文风验收方式\n先检查叙事人称、视角信息范围和明确硬约束，再检查本次召集的独立文风能力是否体现在具体手法上：场景、人物、对话、动作/打斗、感情引爆和叙事结构按专家提供的手法卡逐项核对。必须引用正文证据说明“已体现/未体现/与当前场景不适用”，不能只写“文风不一致”。当前场景的合理波动优先；不得仅因某一章偏离全书平均值就判定失败。数字指纹只作辅助，不能单独判定失败。')
  }

  const content = joinPromptSectionsWithinBudget(sections)
  const profileHash = createHash('sha256').update(JSON.stringify({
    id: profile.id,
    version: profile.version,
    target,
    content,
  })).digest('hex').slice(0, 16)

  return {
    profileId: profile.id,
    profileVersion: profile.version,
    profileHash,
    target,
    content: `${content}${PROFILE_MARKER_PREFIX}${profileHash}`,
  }
}

// ═══════════════════════════════════════════════════════════════
// P1-2：场景类型分桶 + 自池动态样本
// ═══════════════════════════════════════════════════════════════

export type StyleSceneType = 'dialogue' | 'action' | 'quiet'

const SCENE_TYPE_LABELS: Record<StyleSceneType, string> = {
  dialogue: '对话场',
  action: '动作场',
  quiet: '静场',
}

const SCENE_TYPE_HINTS: Record<StyleSceneType, string> = {
  dialogue: '样本优先示范对话的呼吸：打断、半句、答非所问、潜台词压在动作里。',
  action: '样本优先示范动作场的节奏：短句推进、感官锚点、后果即时可见。',
  quiet: '样本优先示范静场的观察距离：环境细节承载情绪，留白多于解释。',
}

/** 场景类型关键词（命中即归类；顺序为 dialogue > action > quiet 兜底） */
const DIALOGUE_HINT_PATTERN = /对话|谈判|审讯|质问|逼问|争辩|对峙|交谈|盘问|说服|摊牌|密谈/
const ACTION_HINT_PATTERN = /战斗|打斗|追逐|逃|追杀|突袭|爆炸|厮杀|交火|搏|袭击|突围|追捕|行动开始/

/**
 * 从叙事任务文本推断本章主导场景类型。
 * 纯启发式：只用于挑选更贴切的文风样本，不改变任何硬约束；
 * 无法判断时归入 quiet（最通用的默认桶）。
 */
export function inferSceneType(text: string): StyleSceneType {
  if (DIALOGUE_HINT_PATTERN.test(text)) return 'dialogue'
  if (ACTION_HINT_PATTERN.test(text)) return 'action'
  return 'quiet'
}

export interface SceneStyleSampleInput {
  /** 文风档案正向样本（静态池） */
  positiveExamples?: string[]
  /**
   * 自池摘段：本书已发布且审稿得分最高章节的结尾片段。
   * 来源标注会让模型知道这是"同一本书的声音"，迁移时不复用情节。
   */
  selfPoolExcerpts?: Array<{
    chapterNumber: number
    score: number | null
    excerpt: string
  }>
  sceneType: StyleSceneType
  maxSamples?: number
  sampleMaxLength?: number
}

/**
 * 按章节主导场景类型挑样本文本；返回可直接注入 Writer 指令的分节字符串。
 * 无可用样本返回空串——宁可不注入，不注入凑数段落。
 *
 * 选择规则：
 * 1. 候选 = 档案正向样本 + 自池摘段，各自按 inferSceneType 分桶
 * 2. 先取同桶样本（最多 maxSamples-1 条），不足时从其他桶按原顺序补足
 * 3. 自池摘段带章节与评分来源标注；档案样本不重复出现在静态身份里的那条
 *    （调用方通过 excludeExampleText 传入静态已用的样本原文）
 */
export function buildSceneSampleSection(input: SceneStyleSampleInput): string {
  const maxSamples = input.maxSamples ?? 2
  const sampleMaxLength = input.sampleMaxLength ?? 1600

  const candidates: Array<{ text: string; sourceLabel: string; type: StyleSceneType }> = []
  for (const example of input.positiveExamples ?? []) {
    const cleaned = cleanSample(example, sampleMaxLength)
    if (!cleaned) continue
    candidates.push({ text: cleaned, sourceLabel: '档案样本', type: inferSceneType(cleaned) })
  }
  for (const item of input.selfPoolExcerpts ?? []) {
    const cleaned = cleanSample(item.excerpt, sampleMaxLength)
    if (!cleaned || cleaned.length < 200) continue
    const scoreLabel = item.score != null ? `，审稿 ${item.score} 分` : ''
    candidates.push({
      text: cleaned,
      sourceLabel: `本书第 ${item.chapterNumber} 章结尾${scoreLabel}`,
      type: inferSceneType(cleaned),
    })
  }
  if (candidates.length === 0) return ''

  const matched = candidates.filter((candidate) => candidate.type === input.sceneType)
  const others = candidates.filter((candidate) => candidate.type !== input.sceneType)
  const selected = [...matched, ...others].slice(0, Math.max(0, maxSamples))
  // 同一候选可能既在 matched 又在 others？不会——两个过滤器互补。去重防御：
  const seen = new Set<string>()
  const unique = selected.filter((candidate) => {
    const key = candidate.text.slice(0, 80)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length === 0) return ''

  return [
    `### 本章场景文风样本（主导场景：${SCENE_TYPE_LABELS[input.sceneType]}）`,
    SCENE_TYPE_HINTS[input.sceneType],
    '只学习这些写法，不复用人物、情节或专有名词；与静态档案冲突时以档案为准。',
    ...unique.map((candidate, index) =>
      `\n【场景样本 ${index + 1}｜来源：${candidate.sourceLabel}】\n${candidate.text}`
    ),
  ].join('\n')
}
