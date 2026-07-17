import { createHash } from 'node:crypto'
import type { NovelWritingStyleProfile } from './types.js'

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
      `- 对话目标占比：约 ${Math.round(profile.dialogueRatio)}%（随场景需要浮动，不为比例硬凑）`,
      `- 情感温度：${profile.emotionalTemperature}/10`,
      `- 意象与比喻密度：${profile.imageryDensity}/10`,
    ].join('\n'),
    // 文风档案属于 Agent identity，必须有明确体积预算。优先保留靠前规则，
    // 避免用户粘贴大量说明后让每次 Writer/Reviewer 调用膨胀数千字符。
    listSection('硬约束', profile.hardRules, 8),
    listSection('软偏好', profile.softRules, 6),
  ].filter(Boolean)

  const notes = cleanText(profile.notes, 400)
  if (notes) sections.push(`### 补充说明\n${notes}`)

  const examples = profile.positiveExamples
    .map(example => cleanText(example, 700))
    .filter(Boolean)
    .slice(0, 2)
  if (examples.length > 0) {
    sections.push([
      '### 正向文风样本',
      '只学习样本的句式、观察距离、用词和节奏，不复用人物、情节或专有名词。',
      ...examples.map((example, index) => `\n【样本 ${index + 1}】\n${example}`),
    ].join('\n'))
  }
  const negativeExamples = profile.negativeExamples
    .map(example => cleanText(example, 500))
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

export function compileWritingStylePrompt(
  profile: NovelWritingStyleProfile,
  target: WritingStylePromptTarget,
): CompiledWritingStylePrompt {
  const sections = buildBaseSections(profile)
  if (target === 'writer') {
    sections.push('### 执行方式\n文风档案是最终正文的声音基准。剧情事实和角色约束优先，风格通过具体句子实现，不要在正文中解释这些规则。')
  } else if (target === 'reviser') {
    sections.push('### 修订方式\n你输出的每一段"修改后"文字都必须符合本档案的叙事声音：人称、距离、句式节奏、语域、情感温度全部对齐。只修复审稿指出的问题，同时把替换后的句子拉回本档案的声音基准。不得把整章改成另一种文风，也不得在修订中偏离档案定义的叙事参数。')
  } else {
    sections.push('### 文风验收方式\n逐项检查叙事人称、距离、句式、语域、对话、情感温度和样本声音。必须引用具体段落说明偏差，不能只写“文风不一致”。')
  }

  const content = sections.join('\n\n')
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
    content: `${content}\n\n文风档案标识：${profileHash}`,
  }
}
