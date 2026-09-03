/**
 * 提示词部件目录（提示词拆解面板的数据源）
 *
 * 每个 core/prompts/*.md 模板在这里登记：分类、用在哪里（装配位置）、效果。
 * 分类统计（字符数/调用次数）由 /prompts 路由在返回时动态计算：
 * - charCount：当前生效内容（含运行时覆盖）长度
 * - usage：novel_agent_logs 按本次 run 使用的模型聚合的调用次数（agents 字段匹配）
 *
 * ⚠️ 新增提示词模板时必须在此登记，否则面板里它会是"未分类"且没有用途说明。
 */

export type PromptPartCategory =
  | '通用底座'
  | '主流程工种'
  | '群聊共创'
  | '规划与编排'
  | '分析与状态'

export interface PromptPartMeta {
  category: PromptPartCategory
  /** 面板展示名（比模板名更可读） */
  title: string
  /** 用在哪里：装配位置（阶段/成员）的人类可读描述 */
  usedBy: string[]
  /**
   * 机器可读的关联 Agent 类型（novel_agent_logs.agent_type 口径），
   * 用于把调用统计映射到该部件。空数组表示暂无调用统计映射。
   */
  agents: string[]
  /** 效果：这段提示词对生成结果的影响 */
  effect: string
}

export const PROMPT_PART_CATALOG: Record<string, PromptPartMeta> = {
  'system-base': {
    category: '通用底座',
    title: '系统底座（工作模式与输出协议）',
    usedBy: ['所有 Agent 的 system prompt 最前层（跨 Agent 共享，命中 prompt cache）'],
    agents: [],
    effect: '声明小说项目的工作模式、输出纪律与跨 Agent 通用约束。位于最前层以保证缓存命中，改动会稀释所有成员的缓存收益，非必要不改。',
  },
  'system-base-rules': {
    category: '通用底座',
    title: '写作铁律',
    usedBy: ['主流程 Writer/Reviser 的 system prompt', '群聊 Writer（identity 层）'],
    agents: ['writer', 'reviser'],
    effect: '正文写作硬规则（第一句不强制动作开头、破折号禁令、文风人工样本优先等）。只注入产正文的成员——规划/审稿成员不注入，避免铁律示范污染结构化输出。',
  },
  'chapter-instruction': {
    category: '通用底座',
    title: '创作指令模板',
    usedBy: ['主流程 Writer 的 userMessage 装配'],
    agents: ['writer'],
    effect: 'Writer 的任务指令骨架：叙事任务、目标字数、矩阵约束、钩子等以 {{变量}} 占位符注入，是"本次要写什么"的权威载体。',
  },
  'scene-instruction': {
    category: '主流程工种',
    title: '单场创作指令模板',
    usedBy: ['主流程 Writer 的逐场调用 suffix'],
    agents: ['writer'],
    effect: '将 Director 提交的单场因果契约、有效预算和上一场承接锚点注入 Writer，确保每次调用只产出一个场景。',
  },
  'novel-creation': {
    category: '通用底座',
    title: '创作入口识别',
    usedBy: ['前端创作命令（/写第N章、继续创作等）'],
    agents: [],
    effect: '识别用户输入属于哪种创作工作模式，生成受约束的创作意图后交给服务端流程执行。',
  },
  'role-director': {
    category: '主流程工种',
    title: '主流程 Director（叙事任务规划）',
    usedBy: ['主流程 directing 阶段'],
    agents: ['director'],
    effect: '依据章纲、故事状态与矩阵实体规划结构化叙事任务（场景动力因果链），经 novel_submit_narrative_task 工具提交。它的产出决定 Writer 写什么、写多长、怎么收尾。',
  },
  'role-writer': {
    category: '主流程工种',
    title: '主流程 Writer（正文执笔）',
    usedBy: ['主流程 writing 阶段'],
    agents: ['writer'],
    effect: '把叙事任务与场景契约写成完整章节正文。承担事实/POV/人物声音硬约束、去 AI 味禁区与文风档案优先级——正文的可读性主要由这份提示词决定。',
  },
  'role-reviewer': {
    category: '主流程工种',
    title: '主流程 Reviewer（验收审稿）',
    usedBy: ['主流程 reviewing 阶段'],
    agents: ['reviewer'],
    effect: '对成稿做十维审查（因果链/重复/体验/硬约束/人物声音/文风），经 novel_submit_review 工具提交结构化验收报告，verdict 决定采纳或进入修订。',
  },
  'role-reviser': {
    category: '主流程工种',
    title: '主流程 Reviser（定向修订）',
    usedBy: ['主流程 revising 阶段', '质量门修订'],
    agents: ['reviser'],
    effect: '按审稿 Findings 以局部补丁（novel_apply_revision）修复明确问题。静默保护检查防止把表达问题改成剧情新增；去 AI 味禁区与 Writer 同一套，防止修订把 AI 腔改回来。',
  },
  'role-memory': {
    category: '主流程工种',
    title: 'Memory（状态提取·工具版）',
    usedBy: ['主流程 memory 阶段'],
    agents: ['memory'],
    effect: '从完成的章节提取状态变更，经 novel_create_*/novel_update_* 工具写入故事状态系统。只提取不创作——它的产出决定下一章能看到什么"上章回顾"。',
  },
  'role-memory-generator': {
    category: '分析与状态',
    title: 'Memory Generator（状态提取·JSON 版）',
    usedBy: ['群聊完成后的状态提取'],
    agents: ['memory'],
    effect: '同一职责的无工具版本：输出纯 JSON 变更对象，由服务端直接写库。群聊链路使用，避免角色会话挂载状态工具。',
  },
  'role-director-discussion': {
    category: '群聊共创',
    title: '群聊 Director（场景规划）',
    usedBy: ['群聊 planning 阶段（引擎直呼，不经主持人）'],
    agents: ['director'],
    effect: '经 novel_submit_scene_plan 工具提交「场景 + 戏剧动作节点图（actionBeats）」。动作节点是角色演出的因果骨架——节点拆得越具体，演出越可控、正文因果越清晰。',
  },
  'role-character-actor': {
    category: '群聊共创',
    title: '群聊角色演员',
    usedBy: ['群聊 acting 阶段（每个角色回合一次调用）'],
    agents: ['character'],
    effect: '按剧本格式演出当前动作单元（2-6 行，公开台词与私有判断分离），可经 mentionNames 主动邀请同场角色接戏。碎片化是刻意设计：演出是素材，连贯性由 Writer 消化。',
  },
  'role-writer-discussion': {
    category: '群聊共创',
    title: '群聊 Writer（全章编织）',
    usedBy: ['群聊 chapter_weaving 阶段（一次性编织全章）'],
    agents: ['writer'],
    effect: '把全部场景演出一次性编织为正文。承担台词留存义务（意图与信息差口径）、演出缺口质量契约、去 AI 味禁区与台词复用率闸门的补织重写。',
  },
  'role-reviewer-discussion': {
    category: '群聊共创',
    title: '群聊台词实时审查',
    usedBy: ['群聊 acting 阶段（reviewCharacterSpeech 开启时；当前默认关闭，由最终 Reviewer 覆盖）'],
    agents: ['reviewer'],
    effect: '对照角色档案与场景信息判断单条发言是否成立，不符合则给出重发要求。默认关闭以避免角色数 × 轮数的调用放大。',
  },
  'role-prose-editor': {
    category: '群聊共创',
    title: '文字编辑（盲审读感）',
    usedBy: ['群聊/主流程 reviewing 的前置盲审'],
    agents: ['reviewer'],
    effect: '只从文字读感盲审正文（不含剧情判断），作为 Reviewer 验收的参照意见。刻意不挂文风档案与去 AI 味禁区，保持独立判断。',
  },
  'role-outline-planner': {
    category: '规划与编排',
    title: '大纲规划',
    usedBy: ['大纲生成/更新'],
    agents: [],
    effect: '依据故事状态与既定走向生成、更新卷级大纲结构，是章纲与节拍的上游输入。',
  },
  'role-beat-planner': {
    category: '规划与编排',
    title: '卷级节拍规划',
    usedBy: ['节拍表生成（一次规划未来数章）'],
    agents: [],
    effect: '依据卷纲、已发布章节与故事状态规划未来数章的节拍表（戏剧功能/情绪债务/爽点/弧光位置），输出 JSON，供单章节拍与章纲参照。',
  },
  'role-chapter-beat-planner': {
    category: '规划与编排',
    title: '单章节拍规划',
    usedBy: ['节拍表生成（单章生成/重生成）'],
    agents: [],
    effect: '依据卷纲、本章章纲与相邻节拍为一章生成节拍，输出 JSON。决定单章的戏剧功能定位。',
  },
  'role-matrix-arranger': {
    category: '规划与编排',
    title: 'AI 编排（登场实体规划）',
    usedBy: ['ai-arrange 阶段'],
    agents: ['arranger'],
    effect: '依据大纲+卷纲+章纲三层上下文规划本章需要登场的实体（角色/势力/地点/物品，复用优先）。编排结果既是白名单也是 Writer 的矩阵硬约束。',
  },
  'role-entity-extractor': {
    category: '分析与状态',
    title: '实体反推',
    usedBy: ['reverse-arrange（从正文反推编排）'],
    agents: ['entity-extractor'],
    effect: '从已完成正文反推本章实际涉及的实体（复用优先），输出 JSON。用于把手写章节纳入矩阵管理。',
  },
  'role-similarity-scanner': {
    category: '分析与状态',
    title: '相似实体扫描',
    usedBy: ['相似实体检测与合并'],
    agents: [],
    effect: '扫描实体库中的重复/相似实体并给出合并建议，维护矩阵的同一性。',
  },
}

/** 未登记模板的兜底元数据 */
export function getPromptPartMeta(name: string): PromptPartMeta {
  return PROMPT_PART_CATALOG[name] ?? {
    category: '通用底座',
    title: name,
    usedBy: ['（未登记：请在此文件的 PROMPT_PART_CATALOG 中补充用途说明）'],
    agents: [],
    effect: '未登记的模板，效果未知。',
  }
}
