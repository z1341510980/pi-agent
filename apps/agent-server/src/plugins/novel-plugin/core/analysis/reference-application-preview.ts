/**
 * ReferenceApplicationPreview：P6 应用预览（方案 §9）。
 *
 * 纯确定性计算，不调用 LLM、不写库：
 * - 编译生效规则并按 Agent 分组估算注入字符（Writer 3500 / Director 2000 /
 *   Reviser 2000 / Reviewer 2000 预算，超限产出 warnings/blockers）；
 * - 对比项目文风档案产出候选 fieldChanges（只是候选，绝不覆盖）与规则冲突；
 * - 用档案安全报告核对规则文本中的参考专名/直接引用残留；
 * - 阻断条件：存在直接引用残留、或 hard 规则字符数超 Writer 预算（§16 第 3 项
 *   保守默认：Prompt 超限对 hard 规则阻断，soft 超限仅告警）。
 */
import { createHash } from 'node:crypto'
import type { NovelStore } from '../novel-store.js'
import type { ReferenceProfile } from './reference-profile-store.js'
import { AGENT_PROMPT_BUDGETS, compileRules, type CompiledRule } from './reference-template-store.js'

export interface ReferenceApplicationPreview {
  profileId: string
  profileHash: string
  compiledRules: {
    spirit: CompiledRule[]
    technique: CompiledRule[]
    power: CompiledRule[]
    pacing: CompiledRule[]
  }
  fieldChanges: Array<{ field: string; currentValue: string; candidateValue: string; basis: string }>
  agentPromptDiffs: Array<{
    agent: string
    addedCharacters: number
    budget: number
    withinBudget: boolean
    ruleCount: number
  }>
  promptCharacters: Record<string, number>
  estimatedTokens: Record<string, number>
  projectRuleConflicts: Array<{ projectRule: string; templateRuleKey: string; reason: string }>
  emergentStyleConflicts: Array<{ expertName: string; reason: string }>
  sourceSpecificMatches: Array<{ kind: string; match: string; ruleKey: string }>
  safetyBlockers: string[]
  warnings: string[]
  blocking: boolean
  previewHash: string
  generatedAt: number
}

/** 单条规则的 Prompt 注入字符估算（编号 + 分类标签 + 强度 + 规则文本 + 范围）。 */
function rulePromptChars(rule: CompiledRule): number {
  const scopeSuffix = rule.chapterScope.length > 0 ? `（限 ${rule.chapterScope.join('/')}）` : ''
  return `[${rule.findingKey}|${rule.strength}] ${rule.rule}${scopeSuffix}`.length
}

export function buildApplicationPreview(
  novelStore: NovelStore,
  profile: ReferenceProfile,
  options: { findingKeys?: string[]; ownerProjectId?: string } = {},
): ReferenceApplicationPreview {
  const compiledRules = compileRules(profile, options.findingKeys)
  const allRules = [...compiledRules.spirit, ...compiledRules.technique, ...compiledRules.power, ...compiledRules.pacing]

  // ── Agent Prompt 字符预算 ──
  const perAgentChars = new Map<string, number>()
  const perAgentCount = new Map<string, number>()
  console.log('[buildApplicationPreview] allRules count:', allRules.length);
  for (const rule of allRules) {
    const chars = rulePromptChars(rule)
    console.log('[buildApplicationPreview] rule:', rule.findingKey, 'agentScopes:', rule.agentScopes, 'chars:', chars);
    for (const agent of rule.agentScopes) {
      perAgentChars.set(agent, (perAgentChars.get(agent) ?? 0) + chars)
      perAgentCount.set(agent, (perAgentCount.get(agent) ?? 0) + 1)
    }
  }
  console.log('[buildApplicationPreview] perAgentChars:', Object.fromEntries(perAgentChars));
  const agents = [...new Set([...Object.keys(AGENT_PROMPT_BUDGETS), ...perAgentChars.keys()])]
  console.log('[buildApplicationPreview] agents:', agents);
  const agentPromptDiffs = agents.map((agent) => {
    const addedCharacters = perAgentChars.get(agent) ?? 0
    const budget = AGENT_PROMPT_BUDGETS[agent] ?? 2000
    return { agent, addedCharacters, budget, withinBudget: addedCharacters <= budget, ruleCount: perAgentCount.get(agent) ?? 0 }
  })
  console.log('[buildApplicationPreview] agentPromptDiffs:', agentPromptDiffs)
  const promptCharacters: Record<string, number> = Object.fromEntries(agentPromptDiffs.map((item) => [item.agent, item.addedCharacters]))
  const estimatedTokens: Record<string, number> = Object.fromEntries(
    agentPromptDiffs.map((item) => [item.agent, Math.ceil(item.addedCharacters * 1.05)]),
  )

  // ── 项目文风档案候选变化（只是候选）与规则冲突 ──
  const styleProfile = options.ownerProjectId ? novelStore.getWritingStyleProfile(options.ownerProjectId) : undefined
  const fieldChanges: ReferenceApplicationPreview['fieldChanges'] = []
  const projectRuleConflicts: ReferenceApplicationPreview['projectRuleConflicts'] = []
  const emergentStyleConflicts: ReferenceApplicationPreview['emergentStyleConflicts'] = []

  if (styleProfile) {
    // 节奏类 finding 建议候选 sentenceRhythm 微调（只列 diff，不写回）
    const pacingRules = compiledRules.pacing
    if (pacingRules.length > 0 && styleProfile.sentenceRhythm) {
      fieldChanges.push({
        field: 'sentenceRhythm',
        currentValue: styleProfile.sentenceRhythm,
        candidateValue: pacingRules[0]!.rule.slice(0, 80),
        basis: `来自 pacing finding ${pacingRules[0]!.findingKey}（候选，需人工确认后才可修改档案）`,
      })
    }
    // 项目 hard/soft 规则与模板规则文本显著相似 → 冲突提示
    for (const projectRule of [...styleProfile.hardRules, ...styleProfile.softRules]) {
      for (const rule of allRules) {
        if (rule.strength === 'hard' && projectRule.length >= 6 && rule.rule.includes(projectRule.slice(0, 6))) {
          projectRuleConflicts.push({
            projectRule,
            templateRuleKey: rule.findingKey,
            reason: '模板 hard 规则包含项目现有规则片段，同时注入可能重复约束',
          })
        }
      }
    }
    // 文风专家提示词关键词与模板规则重叠 → 涌现风格冲突
    for (const expert of styleProfile.styleExperts ?? []) {
      const prompt = expert.customPrompt || expert.distilledPrompt || ''
      if (!prompt) continue
      for (const rule of allRules) {
        const keywords = extractKeywords(prompt)
        const ruleKeywords = extractKeywords(rule.rule)
        const overlap = ruleKeywords.filter((keyword) => keywords.includes(keyword))
        if (overlap.length >= 3) {
          emergentStyleConflicts.push({
            expertName: expert.name,
            reason: `模板规则 ${rule.findingKey} 与专家「${expert.name}」在 ${overlap.slice(0, 3).join('、')} 上重叠`,
          })
          break
        }
      }
    }
  }

  // ── 参考特异性残留（专名 / 直接引用前缀出现在规则文本中） ──
  const sourceSpecificMatches: ReferenceApplicationPreview['sourceSpecificMatches'] = []
  const rulesBlob = allRules.map((rule) => `${rule.findingKey}\n${rule.rule}`).join('\n')
  for (const quote of profile.safetyReport.directQuotes) {
    const head = quote.prefix.slice(0, 10)
    if (quote.length >= 12 && head.length >= 6 && rulesBlob.includes(head)) {
      sourceSpecificMatches.push({ kind: 'direct_quote', match: head, ruleKey: locateRuleKey(allRules, head) })
    }
  }
  for (const noun of profile.safetyReport.properNouns) {
    if (noun.length >= 2 && rulesBlob.includes(noun)) {
      sourceSpecificMatches.push({ kind: 'proper_noun', match: noun, ruleKey: locateRuleKey(allRules, noun) })
    }
  }
  for (const sequence of profile.safetyReport.plotSequences) {
    const head = sequence.slice(0, 8)
    if (sequence.length >= 8 && rulesBlob.includes(head)) {
      sourceSpecificMatches.push({ kind: 'plot_sequence', match: head, ruleKey: locateRuleKey(allRules, head) })
    }
  }
  for (const scene of profile.safetyReport.uniqueScenes) {
    const head = scene.slice(0, 8)
    if (scene.length >= 8 && rulesBlob.includes(head)) {
      sourceSpecificMatches.push({ kind: 'unique_scene', match: head, ruleKey: locateRuleKey(allRules, head) })
    }
  }

  // ── 阻断与告警 ──
  const safetyBlockers: string[] = []
  const warnings: string[] = []
  if (sourceSpecificMatches.length > 0) {
    safetyBlockers.push(`规则文本中存在 ${sourceSpecificMatches.length} 处参考特异性残留（直接引用/专名/剧情序列），必须改写后才能创建模板`)
  }
  if (profile.safetyReport.blockers.length > 0) {
    safetyBlockers.push(`来源档案安全报告仍有阻断项：${profile.safetyReport.blockers[0]}`)
  }
  for (const diff of agentPromptDiffs) {
    if (!diff.withinBudget) {
      const hardChars = allRules
        .filter((rule) => rule.strength === 'hard' && rule.agentScopes.includes(diff.agent))
        .reduce((sum, rule) => sum + rulePromptChars(rule), 0)
      if (hardChars > diff.budget) {
        safetyBlockers.push(`${diff.agent} 的 hard 规则注入 ${hardChars} 字符，超出预算 ${diff.budget}`)
      } else {
        warnings.push(`${diff.agent} 注入 ${diff.addedCharacters} 字符超出预算 ${diff.budget}（hard 部分 ${hardChars} 在预算内，仅告警）`)
      }
    }
  }
  if (allRules.length === 0) {
    warnings.push('没有可生效的规则（全部被拒绝或未启用 Prompt 注入），模板将为空')
  }

  const previewBase = {
    profileId: profile.id,
    compiledRules,
    promptCharacters,
    sourceSpecificMatches,
    safetyBlockers,
  }
  return {
    profileId: profile.id,
    profileHash: profile.profileHash,
    compiledRules,
    fieldChanges,
    agentPromptDiffs,
    promptCharacters,
    estimatedTokens,
    projectRuleConflicts,
    emergentStyleConflicts,
    sourceSpecificMatches,
    safetyBlockers,
    warnings,
    blocking: safetyBlockers.length > 0,
    previewHash: createHash('sha256').update(JSON.stringify(previewBase)).digest('hex'),
    generatedAt: Date.now(),
  }
}

function locateRuleKey(rules: CompiledRule[], fragment: string): string {
  const hit = rules.find((rule) => rule.rule.includes(fragment))
  return hit?.findingKey ?? 'unknown'
}

/** 提取中文关键词（≥2 字的连续汉字段）用于重叠判断。 */
function extractKeywords(text: string): string[] {
  return (text.match(/[\u4e00-\u9fff]{2,6}/g) ?? []).slice(0, 200)
}