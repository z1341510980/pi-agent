/**
 * 质量门统一仲裁（S5）。
 *
 * ## 问题
 *
 * 正文生成后有五套质量门，此前互不知晓、各自发号施令：
 *
 * | 门 | 性质 | 动作 | 位置 |
 * | --- | --- | --- | --- |
 * | 项目文风档案 | 用户声明的目标 | 注入 Writer identity | writing-style-prompt-factory |
 * | 文风指纹 | 从前文自动量化的**观测值** | 注入 Writer/Reviewer | prompt-builder.formatStyleFingerprint |
 * | PostWriteGuard | 确定性检测 | 整章重写 / advisory | novel-orchestrator.runPostWriteGuard |
 * | prose-quality | 段落形态统计 | error → 强制 Reviser | prose-quality-evaluator |
 * | cliche-scanner | 句式模式匹配 | 部分 → 自动 revise | cliche-scanner |
 *
 * 冲突时没有仲裁，只能由 LLM 自己猜哪条优先。实测出的真实冲突：
 *
 * 1. **字数**：创作指令说"宁可写得更短也不要用空转描写凑字数"，
 *    Guard 却在 <75% 时整章重写 —— 同一件事一边鼓励一边惩罚。
 * 2. **段落形态**：把连续单句段、短段比例和比喻密度的精确阈值全部塞给 Writer，
 *    会让生成过程变成按指标交作业；这些可确定判断应留在写后质量门。
 * 3. **点名 vs 反流水账**：Guard 要求矩阵角色姓名逐字出现否则整章重写，
 *    prompt 同时要求"不能靠点名交差""叙事任务不是写作顺序"。
 * 4. **档案 vs 指纹**：档案说对话占比 45%、情感温度 5/10，
 *    指纹给出的观测值可能完全相反且带 ⚠️ 强制一致。
 *
 * ## 本模块做什么
 *
 * - 把五个门登记在一张表里，写清各自的性质与可采取的动作（GATE_REGISTRY）。
 * - 定义唯一的动作优先级与仲裁函数（arbitrateQuality），替代散落的 early-return。
 * - 把上面四条冲突登记为显式的仲裁规则（CONFLICT_RULES），并由单测守住阈值一致性
 *   （QUALITY_POLICY_INVARIANTS），避免下次调阈值时又调出矛盾。
 *
 * 本模块只做仲裁，不做检测：检测仍在各自的模块里。
 */

/** 质量门可以采取的动作，按强度递增 */
export const QUALITY_ACTIONS = ['none', 'reference', 'advisory', 'revise', 'rewrite'] as const
export type QualityAction = typeof QUALITY_ACTIONS[number]

/** 动作强度：仲裁时取最强者 */
const ACTION_RANK: Record<QualityAction, number> = {
  none: 0,
  /** 仅作参考，不进硬约束（如样本量不足的文风指纹） */
  reference: 1,
  /** 交 Reviewer 结合语义判断 */
  advisory: 2,
  /** 交 Reviser 局部修订 */
  revise: 3,
  /** 整章重写 */
  rewrite: 4,
}

export function strongerAction(a: QualityAction, b: QualityAction): QualityAction {
  return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b
}

/** 检测方式：决定这个门的判断有多可信 */
export type GateKind =
  /** 确定性检测：字符串/数值判定，结论可靠 */
  | 'deterministic'
  /** 统计观测：从既有文本量化，样本不足时会失真 */
  | 'observational'
  /** 用户声明的目标：不是检测，是意图 */
  | 'declared-intent'
  /** LLM 判断：语义层，可能误判 */
  | 'llm-judgement'

export interface QualityGate {
  id: string
  name: string
  kind: GateKind
  /** 该门最强可采取的动作 */
  maxAction: QualityAction
  /** 实现位置，便于从表定位代码 */
  source: string
  /** 该门对应的 prompt 侧指令（若有），用于检查两侧是否一致 */
  promptCounterpart?: string
}

export const GATE_REGISTRY: QualityGate[] = [
  {
    id: 'model-degradation',
    name: '模型退化（复读/截断/拒绝/工程词泄漏/未输出正文）',
    kind: 'deterministic',
    maxAction: 'rewrite',
    source: 'novel-orchestrator.runPostWriteGuard + cliche-scanner',
  },
  {
    id: 'word-count',
    name: '字数偏离（仅截断兜底重写；其余降为 advisory 交 Reviewer 判断事件密度）',
    kind: 'deterministic',
    maxAction: 'rewrite',
    source: 'novel-orchestrator.runPostWriteGuard',
    promptCounterpart: 'chapter-instruction.md 的「字数要求」',
  },
  {
    id: 'contract-coverage',
    name: '叙事任务提及的角色未在正文出现（契约兑现度的确定性代理）',
    kind: 'deterministic',
    // Director 任务里提到的角色可能本就不出场（背景提及/对比对象），
    // 字符层缺失不足以重写，交 Reviewer 结合任务完成度做语义验收
    maxAction: 'advisory',
    source: 'novel-orchestrator.runPostWriteGuard',
    promptCounterpart: 'role-writer.md 的「矩阵实体必须真正参与事件」',
  },
  {
    id: 'matrix-characters',
    name: '矩阵角色姓名缺失',
    kind: 'deterministic',
    maxAction: 'rewrite',
    source: 'novel-orchestrator.runPostWriteGuard',
    promptCounterpart: 'role-writer.md 的「矩阵实体必须真正参与事件」',
  },
  {
    id: 'matrix-semantic-entities',
    name: '矩阵势力/地点全名缺失',
    kind: 'deterministic',
    // 势力/地点常用简称或场景描述指代，字符串缺失不足以判定失败
    maxAction: 'advisory',
    source: 'novel-orchestrator.runPostWriteGuard',
  },
  {
    id: 'prose-shape',
    name: '段落形态（单句段占比 / 连续单句段 / 短段密度）',
    kind: 'deterministic',
    maxAction: 'revise',
    source: 'prose-quality-evaluator',
  },
  {
    id: 'cliche-patterns',
    name: 'AI 腔句式（总结收尾 / 解释腔 / 上帝视角安排 / 碎句 / 过度压缩）',
    kind: 'deterministic',
    maxAction: 'revise',
    source: 'cliche-scanner',
    promptCounterpart: 'system-base-rules.md 的「少用万能连接词和现成句壳」',
  },
  {
    id: 'character-voice',
    name: '角色声音趋同（台词长度一致 / 全完整句 / 无反问回避）',
    kind: 'deterministic',
    // 正式汇报、审讯类场景本身对白工整，字符层判定不足以推翻整章
    maxAction: 'revise',
    source: 'character-voice.detectVoiceCollapse',
    promptCounterpart: 'role-writer.md 的「角色声音（硬约束）」+ 声音对照表',
  },

  {
    id: 'style-profile',
    name: '项目文风档案',
    kind: 'declared-intent',
    // 档案是目标而非检测，永远不直接触发重写
    maxAction: 'reference',
    source: 'writing-style-prompt-factory',
  },
  {
    id: 'style-fingerprint',
    name: '文风指纹（从前文量化的观测值）',
    kind: 'observational',
    // 观测值最多作为参考基准：样本不足或指标失真时不能当硬约束
    maxAction: 'reference',
    source: 'prompt-builder.formatStyleFingerprint',
  },
  {
    id: 'reviewer-verdict',
    name: 'Reviewer 语义验收',
    kind: 'llm-judgement',
    maxAction: 'revise',
    source: 'novel-orchestrator（novel_submit_review 工具）',
  },
]

/**
 * 显式登记的冲突及其仲裁规则。
 *
 * 登记的意义在于：这些冲突是**设计上的取舍**，不是待修的 bug；
 * 写下来才不会在下次调阈值时被无意破坏。
 */
export const CONFLICT_RULES: Array<{
  gates: [string, string]
  conflict: string
  resolution: string
}> = [
  {
    gates: ['word-count', 'prose-shape'],
    conflict: '创作指令鼓励"宁可更短"，字数门却在低于 75% 时整章重写',
    resolution:
      'P0-2 起偏短不再惩罚：<75% 与 85% 以下同样降为 advisory，由 Reviewer 结合事件密度判断。'
      + '保留两条硬线：截断兜底（<50% 且 <800 字）防残稿；超长天花板（>130%）触发定向压缩'
      + '（writer-rewrite-plan 的 targeted 策略，保留情节删空转），不是整章推倒。'
      + 'prompt 侧同步改为事件密度导向，不承诺字数惩罚。',
  },
  {
    gates: ['prose-shape', 'cliche-patterns'],
    conflict: 'Writer 同时背诵段落比例、连续短段和比喻密度阈值，会优先满足指标而牺牲场景自然度',
    resolution: 'Writer 只接收自然段落与现场修辞原则；精确阈值由 PROSE_SHAPE_LIMITS 在写后统一检测并交 Reviser 局部处理。',
  },
  {
    gates: ['matrix-characters', 'cliche-patterns'],
    conflict: '角色姓名必须逐字出现（否则重写）会诱导点名式叙述，与反流水账要求相反',
    resolution:
      '姓名检查只保证"出现过"，不保证"参与事件"；后者交 Reviewer 语义验收。'
      + 'prompt 侧必须明说"出现不等于交差"，把两条要求的边界讲清。',
  },
  {
    gates: ['style-profile', 'style-fingerprint'],
    conflict: '档案是用户声明的目标，指纹是前文观测值，两者可能直接矛盾',
    resolution:
      '档案优先：指纹的 maxAction 是 reference。指纹只有在样本量与指标均可信时才升级为硬约束，'
      + '且措辞必须说明"以文风档案为准"。',
  },
]

/**
 * 段落形态的**单一阈值来源**。
 *
 * 这些数字只属于写后 prose-quality-evaluator，不注入 Writer 实时提示。
 * Writer 只接收自然段落原则，避免模型在生成时围绕指标排版。
 */
export const PROSE_SHAPE_LIMITS = {
  /**
   * 允许的最长连续单句段数；超过即视为提纲式碎片节奏。
   *
   * 从 5 收到 3：实测两章正文里"三秒。五秒。一把电钻……"这类连续短段是默认格式
   * 而不是高潮处理，5 段的容忍度让它全程合法通过。
   */
  maxConsecutiveSingleSentenceParagraphs: 3,
  /** 单句段占比警告线（按人工网文样本试运行门槛：40%） */
  singleSentenceRatioWarning: 0.40,
  /** 单句段占比错误线（触发强制修订） */
  singleSentenceRatioError: 0.55,
  /** 18 字以内短段占比警告线 */
  shortParagraphRatioWarning: 0.25,
  /** 短段占比错误线 */
  shortParagraphRatioError: 0.35,
  /** 低于此段落数不做形态判定（样本太少，比例没有意义） */
  minParagraphsForShapeCheck: 20,
  /** 泛化"像……"比喻的每千字警告密度 */
  genericSimilePerThousandWarning: 2,
  /** 泛化比喻每千字错误密度 */
  genericSimilePerThousandError: 3.5,
} as const


/** 字数门的分级阈值（相对目标字数的比例） */
export const WORD_COUNT_LIMITS = {
  /**
   * 截断兜底线：低于目标此比例视为「未完成输出」（截断/半途而废），触发重写。
   *
   * 这是防残稿的确定性兜底，不是字数审美——正常偏短的完整章节不在此列，
   * 一律降为 advisory 交 Reviewer 结合事件密度判断（P0-2：删除 75% 重写线）。
   */
  truncationFloorRatio: 0.5,
  /** 截断兜底的绝对下限（字）：目标字数很小的短章也至少要写满这么多 */
  minTruncationFloorWords: 800,
  /** 低于此比例交 Reviewer（advisory） */
  advisoryBelow: 0.85,
  /** 高于此比例交 Reviewer（advisory） */
  advisoryAbove: 1.15,
  /**
   * 超长天花板：高于此比例触发「定向压缩重写」（不是整章推倒）。
   *
   * P0-2 首版把超长也完全放行，实测 Writer 会写到目标的约 2 倍——
   * "不为凑数注水"的软约束拦不住惯性膨胀。恢复硬上限，但走
   * writer-rewrite-plan 的定向压缩策略（保留情节节点，删空转描写），
   * 与旧的整章重写不同。
   */
  bloatCeilingRatio: 1.3,
} as const

export interface QualitySignal {
  gateId: string
  action: QualityAction
  reason: string
  details?: string
}

export interface QualityDecision {
  action: QualityAction
  /** 决定动作的那个信号 */
  decidedBy: QualitySignal | null
  /** 强度低于最终动作、但仍需转达给下游的信号 */
  carried: QualitySignal[]
}

/**
 * 仲裁：在一组信号里选出唯一动作。
 *
 * 规则：
 * 1. 取最强动作；同强度时按 GATE_REGISTRY 的登记顺序（确定性门在前）决胜。
 * 2. 超出该门 maxAction 的信号被降级 —— 门的权限写在注册表里，调用方不能越权。
 * 3. 未被选中的信号不丢弃，作为 carried 传给下游（Reviewer / Reviser）。
 */
export function arbitrateQuality(signals: QualitySignal[]): QualityDecision {
  const gateOrder = new Map(GATE_REGISTRY.map((gate, index) => [gate.id, index]))
  const gateById = new Map(GATE_REGISTRY.map((gate) => [gate.id, gate]))

  const clamped = signals.map((signal) => {
    const gate = gateById.get(signal.gateId)
    if (!gate) return signal
    return ACTION_RANK[signal.action] > ACTION_RANK[gate.maxAction]
      ? { ...signal, action: gate.maxAction }
      : signal
  }).filter((signal) => signal.action !== 'none')

  if (clamped.length === 0) return { action: 'none', decidedBy: null, carried: [] }

  const sorted = [...clamped].sort((a, b) =>
    ACTION_RANK[b.action] - ACTION_RANK[a.action]
    || (gateOrder.get(a.gateId) ?? 999) - (gateOrder.get(b.gateId) ?? 999))

  const decidedBy = sorted[0]
  return {
    action: decidedBy.action,
    decidedBy,
    carried: sorted.slice(1),
  }
}

/** 结构性约束：由单测强制，防止调阈值时调出上面登记过的矛盾 */
export const QUALITY_POLICY_INVARIANTS: Array<{ name: string; check: () => boolean }> = [
  {
    name: '观测型与声明型门不得直接触发重写或修订',
    check: () => GATE_REGISTRY
      .filter((gate) => gate.kind === 'observational' || gate.kind === 'declared-intent')
      .every((gate) => ACTION_RANK[gate.maxAction] <= ACTION_RANK.reference),
  },
  {
    name: '只有确定性门可以整章重写（LLM 判断不足以推翻整章）',
    check: () => GATE_REGISTRY
      .filter((gate) => gate.maxAction === 'rewrite')
      .every((gate) => gate.kind === 'deterministic'),
  },
  {
    name: '截断兜底线必须严格低于 advisory 下线（兜底只拦残稿，不拦偏短章节）',
    check: () =>
      WORD_COUNT_LIMITS.truncationFloorRatio < WORD_COUNT_LIMITS.advisoryBelow
      && WORD_COUNT_LIMITS.minTruncationFloorWords > 0,
  },
  {
    name: '超长天花板必须严格高于 advisory 上线（只拦惯性膨胀，不拦正常波动）',
    check: () =>
      WORD_COUNT_LIMITS.bloatCeilingRatio > WORD_COUNT_LIMITS.advisoryAbove,
  },
  {
    name: 'contract-coverage 门不得触发重写（提及≠必须出场，语义兑现交 Reviewer）',
    check: () => {
      const gate = GATE_REGISTRY.find((g) => g.id === 'contract-coverage')
      return !!gate && ACTION_RANK[gate.maxAction] <= ACTION_RANK.advisory
    },
  },
  {
    name: '段落形态的错误线必须高于警告线',
    check: () =>
      PROSE_SHAPE_LIMITS.singleSentenceRatioError > PROSE_SHAPE_LIMITS.singleSentenceRatioWarning
      && PROSE_SHAPE_LIMITS.shortParagraphRatioError > PROSE_SHAPE_LIMITS.shortParagraphRatioWarning
      && PROSE_SHAPE_LIMITS.genericSimilePerThousandError > PROSE_SHAPE_LIMITS.genericSimilePerThousandWarning,
  },

  {
    name: '每条登记的冲突都必须涉及两个已注册的门',
    check: () => {
      const ids = new Set(GATE_REGISTRY.map((gate) => gate.id))
      return CONFLICT_RULES.every((rule) => rule.gates.every((id) => ids.has(id)))
    },
  },
  {
    name: '带 promptCounterpart 的门必须是确定性门（否则 prompt 无法与之对齐）',
    check: () => GATE_REGISTRY
      .filter((gate) => gate.promptCounterpart)
      .every((gate) => gate.kind === 'deterministic'),
  },
]
