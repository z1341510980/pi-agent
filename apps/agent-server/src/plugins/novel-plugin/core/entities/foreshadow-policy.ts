/**
 * 伏笔准入规则。
 *
 * 伏笔不是“以后可能发生的任何事”，而是作者有意埋下、未来必须兑现的高价值信息种子。
 * 新伏笔必须服务暗线真相或重大揭示，并同时说明隐藏问题与计划回收方式。
 */

export type ForeshadowImportance = 'major' | 'critical'
export type ForeshadowNarrativeRole = 'dark_line' | 'major_reveal'

export interface ForeshadowAdmissionFields {
  importance?: unknown
  narrativeRole?: unknown
  hiddenQuestion?: unknown
  plannedPayoff?: unknown
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 4
}

/** 程序侧硬门槛：提示词失守时，也不让普通事实或即时风险落成新伏笔。 */
export function isAdmissibleNewForeshadow(candidate: ForeshadowAdmissionFields): boolean {
  return (candidate.importance === 'major' || candidate.importance === 'critical')
    && (candidate.narrativeRole === 'dark_line' || candidate.narrativeRole === 'major_reveal')
    && hasText(candidate.hiddenQuestion)
    && hasText(candidate.plannedPayoff)
}

/**
 * 单章默认最多新增一条伏笔。已有伏笔的强化/揭示/回收不受此限制。
 * 多个普通未知点应进入线索系统，而不是批量制造叙事债务。
 */
export function selectAdmissibleNewForeshadows<T extends ForeshadowAdmissionFields>(
  candidates: T[],
  maxNewPerChapter = 1,
): T[] {
  return candidates.filter(isAdmissibleNewForeshadow).slice(0, maxNewPerChapter)
}

/** chapterAction 归一化表：LLM 常写中文或夹带说明文字，按包含关系映射到四值枚举 */
const CHAPTER_ACTION_ALIASES: Array<{ type: 'plant' | 'reinforce' | 'reveal' | 'payoff'; words: string[] }> = [
  { type: 'payoff', words: ['payoff', '回收', '兑现', '揭晓答案'] },
  { type: 'reveal', words: ['reveal', '揭示', '揭露', '揭晓', '部分揭示', '曝光'] },
  { type: 'reinforce', words: ['reinforce', '强化', '加深', '推进', '重提', '强调'] },
  { type: 'plant', words: ['plant', '埋设', '埋下', '铺垫', '种下'] },
]

/**
 * 把 LLM 输出的 chapterAction 归一化为 plant/reinforce/reveal/payoff。
 * 顺序按 payoff > reveal > reinforce > plant：像"部分揭示后回收"这类复合描述
 * 取更强的动作。无法识别返回 null，由调用方决定兜底。
 */
export function normalizeForeshadowChapterAction(value: unknown): 'plant' | 'reinforce' | 'reveal' | 'payoff' | null {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return null
  for (const alias of CHAPTER_ACTION_ALIASES) {
    if (alias.words.some((word) => text.includes(word.toLowerCase()))) return alias.type
  }
  return null
}

/** 注入 LLM 的统一领域定义，供编排、反推与记忆沉淀复用。 */
export const FORESHADOW_ADMISSION_PROMPT = `【伏笔准入规则（严格）】
- 明线：角色公开追求的目标及读者当前看得见的主要因果链，例如主角为父报仇。
- 暗线：隐藏在明线之下、将在后文逐步揭开的关键真相或深层因果，例如父亲真正的死因。
- 伏笔：作者有意埋下、未来必须兑现的高价值信息种子。它必须服务暗线真相或一次重大揭示，并能明确回答“隐藏的问题是什么、未来如何回收”。
- 线索：角色当前获得、用于调查或拼接真相的证据与信息碎片。普通异常、怀疑、痕迹优先归线索，不自动升级为伏笔。
- 钩子：章末驱动读者继续阅读的悬念，只属于单章节奏，不自动成为伏笔。
- 世界事实、能力说明、已经发生的结果、即时风险、普通承诺、日常动作、章末一句悬念，都不是伏笔。
- 默认不新增伏笔。只有重要性为 major/critical 且 narrativeRole 为 dark_line/major_reveal，并能填写 hiddenQuestion 与 plannedPayoff 时才允许新增；单章最多新增 1 条。
- 已有伏笔只有在本章真实埋设、强化、部分揭示或回收时才选入；仅被提及或仍未回收，不代表本章涉及。`
