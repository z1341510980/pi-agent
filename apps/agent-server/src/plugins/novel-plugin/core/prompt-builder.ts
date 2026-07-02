/**
 * NovelPromptBuilder：缓存优化的提示词构建器
 *
 * 核心设计原则（缓存命中率是小说创作的关键成本指标）：
 *
 * 1. 静态在前，动态在后
 *    LLM 提供商（Anthropic/OpenAI）的 prompt cache 基于前缀匹配。
 *    前缀越稳定，缓存命中率越高。
 *
 * 2. 系统提示词只包含静态数据（不含角色定义）
 *    世界规则、风格指南放在系统提示词中。这些数据跨章节不变，缓存命中率最高。
 *    ⚠️ 角色定义不放在系统提示词：角色数量可能很大（200+），全部塞会导致上下文爆炸。
 *    本章出场角色的完整定义放在章节上下文（SEMI 层），通过 arrangedEntities 注入。
 *
 * 3. 章节上下文放在首条用户消息中
 *    当前故事状态、叙事任务、约束、本章出场角色完整定义等半静态数据放在首条用户消息中。
 *    这些数据单章内不变，跨章失效。
 *
 * 4. 工具调用结果只追加到对话末尾
 *    工具返回的状态查询结果追加到对话消息中，不修改系统提示词。
 *    前缀（系统提示词 + 早期消息）保持不变 → 缓存命中。
 *
 * 5. 状态更新发生在章节完成后
 *    工具更新角色状态/伏笔/冲突等，只影响下一章的提示词，不影响当前章。
 *
 * ── 缓存层级结构 ──
 *
 * [系统提示词] (STATIC - 跨章节缓存命中)
 * ├── Layer 1: 世界规则（项目级，极少变）
 * ├── Layer 2: 风格指南（项目级，极少变）
 * └── Layer 0: Agent 身份（Agent 专属，同 Agent 跨章不变）
 *
 * [首条用户消息] (SEMI - 单章内缓存命中)
 * ├── 章节信息（卷/章/叙事任务/约束）
 * ├── 本章出场角色完整定义（arrangedEntities，仅本章角色）
 * ├── 当前故事状态（所有角色的 name+动态状态，让 LLM 知道存在）
 * ├── 信息差（谁知道什么）
 * ├── 最近章节摘要
 * └── 创作指令
 *
 * [对话消息] (DYNAMIC - 不缓存)
 * ├── 工具调用 + 结果（追加到末尾，不破坏前缀缓存）
 * ├── 生成内容
 * └── 用户引导
 *
 * ── 角色定义注入策略（精准注入方案）──
 *
 * 问题：角色数量可能很大（200+），全部塞系统提示词会导致上下文爆炸。
 *
 * 解决：
 * 1. 系统提示词不含任何角色定义 → 跨章缓存命中最好
 * 2. 章节上下文注入 arrangedEntities 中角色的完整静态+动态定义 → 单章内缓存命中
 * 3. 其他角色通过 formatStoryState 输出 name+动态状态 → LLM 知道存在
 * 4. 需要其他角色详情时调用 query_state 工具 → DYNAMIC 层，不破坏前缀缓存
 *
 * ── 工具调用缓存问题解决方案 ──
 *
 * 问题：工具调用后上下文变化，导致缓存失效。
 *
 * 解决：
 * 1. 系统提示词不包含动态状态 → 工具更新状态不影响系统提示词
 * 2. 工具结果追加到对话末尾 → 前缀（系统提示词 + 早期消息）不变
 * 3. 状态更新只影响下一章 → 当前章的系统提示词在整个生成过程中不变
 * 4. systemPromptOverride 函数只读取静态数据 → 每次调用返回相同结果
 */

import { createHash } from 'node:crypto'
import type { PromptManager } from './prompt-manager.js'
import type {
  NovelProject,
  NovelCharacter,
  NovelWorldRule,
  NovelStyleGuide,
  NovelChapter,
  NovelConflict,
  NovelForeshadow,
  NovelClue,
  NovelInformationLayer,
  NovelConstraint,
  NovelRelationship,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
  NovelEdge,
  StoryState,
  NarrativeTask,
  ChapterConstraints,
  ArrangedEntity,
} from './types.js'

/**
 * Store 接口：NovelPromptBuilder 只需要读取数据，不关心存储实现
 */
export interface NovelPromptStores {
  getProject(projectId: string): NovelProject | undefined
  listWorldRules(projectId: string): NovelWorldRule[]
  listStyleGuide(projectId: string): NovelStyleGuide[]
  listCharacters(projectId: string): NovelCharacter[]
  listRelationships(projectId: string): NovelRelationship[]
  listConflicts(projectId: string): NovelConflict[]
  listForeshadowing(projectId: string): NovelForeshadow[]
  listClues(projectId: string): NovelClue[]
  listInformationLayers(projectId: string): NovelInformationLayer[]
  listConstraints(projectId: string): NovelConstraint[]
  listRecentChapters(projectId: string, limit: number): NovelChapter[]
  getChapter(projectId: string, chapterNumber: number): NovelChapter | undefined
  listEdges(projectId: string): NovelEdge[]
  listFactions(projectId: string): NovelFaction[]
  listLocations(projectId: string): NovelLocation[]
  listWorldElements(projectId: string): NovelWorldElement[]
  /** 按 ID 查询角色（供 arrangedEntities 注入时使用） */
  getCharacter(characterId: string): NovelCharacter | undefined
  /** 按 ID 查询冲突（供 arrangedEntities 注入时使用） */
  getConflict(conflictId: string): NovelConflict | undefined
  /** 按 ID 查询伏笔（供 arrangedEntities 注入时使用） */
  getForeshadow(foreshadowId: string): NovelForeshadow | undefined
}

export class NovelPromptBuilder {
  constructor(
    private promptManager: PromptManager,
    private stores: NovelPromptStores,
  ) {}

  /**
   * 计算单章目标字数
   *
   * 估算逻辑：项目总字数 / 1000（估计章节数），限制在 [2000, 5000] 区间。
   * 不再用 / 30（假设全书 30 章）——300 万字小说实际有 1000+ 章，
   * / 30 会导致单章要求 10 万字，远超 LLM 单次输出能力和合理章节长度。
   *
   * - 300 万字 → 3000 字/章（典型网文）
   * - 100 万字 → 2000 字/章（保底）
   * - 500 万字 → 5000 字/章（上限）
   * - 未设置   → 3000 字/章（默认）
   */
  private computeChapterTargetWords(project: NovelProject | undefined): number {
    if (!project || project.targetWords <= 0) return 3000
    return Math.min(5000, Math.max(2000, Math.round(project.targetWords / 1000)))
  }

  // ═══════════════════════════════════════════════════════════════
  // 系统提示词（STATIC 层 - 跨章节缓存命中）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建系统提示词
   *
   * ⚠️ 此方法只读取静态数据，不读取动态状态，也不读取角色定义。
   * 系统提示词在整个项目生命周期内保持不变（除非世界规则/风格被修改）。
   * 这确保 LLM 提供商的 prompt cache 能跨章节命中。
   *
   * 角色定义不放在系统提示词的原因：
   * - 角色数量可能很大（200+），全部塞系统提示词会导致上下文爆炸
   * - 本章出场角色已通过 arrangedEntities 编排好，只需注入这些角色的完整定义
   * - 其他角色 LLM 通过 formatStoryState 知道存在（name+动态状态），需要详情时调 query_state 工具
   *
   * 构建顺序（从最稳定到最不稳定）：
   * 1. 世界规则（项目级，极少变）    ← 高命中率
   * 2. 风格指南（项目级，极少变）    ← 高命中率
   * 3. Agent 身份（Agent 专属）      ← 同 Agent 跨章不变
   */
  buildSystemPrompt(projectId: string, agentType: string): string {
    const parts: string[] = []

    // ── 共享前缀（跨 Agent 相同，跨章不变，最大化 prompt cache 命中）──
    // 顺序：世界规则 → 风格指南 → Agent 身份
    // 共享部分在前，Agent 专属部分在后，确保不同 Agent 的前缀相同可共享缓存。

    // ── Layer 1: 世界规则（项目级，跨 Agent 共享，跨章不变）──
    // 按 category 排序，确保顺序稳定，最大化 prompt cache 命中率
    const worldRules = this.stores.listWorldRules(projectId)
    if (worldRules.length > 0) {
      const sorted = [...worldRules].sort((a, b) => a.category.localeCompare(b.category))
      parts.push(this.formatWorldRules(sorted))
    }

    // ── Layer 2: 风格指南（项目级，跨 Agent 共享，跨章不变）──
    // 按 category 排序，确保顺序稳定，最大化 prompt cache 命中率
    const styleGuide = this.stores.listStyleGuide(projectId)
    if (styleGuide.length > 0) {
      const sorted = [...styleGuide].sort((a, b) => a.category.localeCompare(b.category))
      parts.push(this.formatStyleGuide(sorted))
    }

    // ── Layer 0: Agent 身份（Agent 专属，同 Agent 跨章不变）──
    // 放在最后，确保前面的共享部分（worldRules + styleGuide）
    // 可以跨 Agent 缓存命中。Agent 身份变化只影响尾部，不影响前缀缓存。
    const identityPrompt = this.promptManager.render('system-base', {
      agent_type: agentType,
      agent_role: this.getAgentRoleDescription(agentType, projectId),
    }, projectId)
    parts.push(identityPrompt)

    return parts.join('\n\n---\n\n')
  }

  // ═══════════════════════════════════════════════════════════════
  // 章节上下文（SEMI 层 - 单章内缓存命中）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建章节上下文（作为首条用户消息）
   *
   * 此方法在章节生成开始时调用一次，生成的内容在整个章节生成过程中不变。
   * LLM 提供商的 prompt cache 在单章内的后续 LLM 调用中能命中此前缀。
   *
   * 包含：
   * 1. 章节信息（卷/章号/叙事任务/约束）
   * 2. 当前故事状态（角色动态状态/冲突/伏笔/线索）
   * 3. 实体关联（画布连线，作为故事状态补充）
   * 4. 信息差（谁知道什么）
   * 5. 最近章节摘要
   * 6. 创作指令
   */
  buildChapterContext(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    agentType?: string,
  ): string {
    const parts: string[] = []

    // ── 章节信息 ──
    parts.push(this.formatChapterInfo(projectId, chapterNumber, narrativeTask))

    // ── 创作约束 ──
    parts.push(this.formatConstraints(constraints))

    // ── 本章已编排实体约束（手动编排 / AI 编排产出，注入 SEMI 层）──
    if (arrangedEntities && (arrangedEntities.characterIds.length > 0 || arrangedEntities.conflictIds.length > 0 || arrangedEntities.foreshadowIds.length > 0)) {
      parts.push(this.formatArrangedEntities(projectId, arrangedEntities))
    }

    // ── 当前故事状态（动态部分）──
    const state = this.getStoryState(projectId)
    parts.push(this.formatStoryState(state))

    // ── 实体关联（画布手动 + 自动连线，作为故事状态的补充）──
    const edges = this.stores.listEdges(projectId)
    if (edges.length > 0) {
      const edgeSection = this.formatEdges(projectId, edges)
      if (edgeSection) parts.push(edgeSection)
    }

    // ── 信息差 ──
    const infoLayers = this.stores.listInformationLayers(projectId)
    if (infoLayers.length > 0) {
      parts.push(this.formatInfoLayers(infoLayers))
    }

    // ── 最近章节摘要 ──
    const recentChapters = this.stores.listRecentChapters(projectId, 3)
    if (recentChapters.length > 0) {
      parts.push(this.formatRecentSummaries(recentChapters))
    }

    // ── 创作指令（仅 Writer 注入，其他 Agent 看到会越权写作）──
    // chapter-instruction 模板包含"直接输出章节正文"等 Writer 专属指令，
    // 对 Director/Reviewer/Memory 注入会导致它们越权创作正文。
    if (agentType === 'writer') {
      const project = this.stores.getProject(projectId)
      const targetWords = this.computeChapterTargetWords(project)
      const instruction = this.promptManager.render('chapter-instruction', {
        chapter_number: String(chapterNumber),
        narrative_task: narrativeTask.description,
        task_type: narrativeTask.type,
        target_words: String(targetWords),
      }, projectId)
      parts.push(instruction)
    }

    return parts.join('\n\n---\n\n')
  }

  // ═══════════════════════════════════════════════════════════════
  // 格式化方法
  // ═══════════════════════════════════════════════════════════════

  /** 格式化世界规则 */
  private formatWorldRules(rules: NovelWorldRule[]): string {
    const lines = rules.map((r) => {
      const cost = r.cost ? `（代价：${r.cost}）` : ''
      const fixed = r.isFixed ? '[固定]' : '[阶段]'
      return `- ${fixed} [${r.category}] ${r.rule}${cost}`
    })
    return `## 世界规则\n\n${lines.join('\n')}`
  }

  /** 格式化风格指南 */
  private formatStyleGuide(styles: NovelStyleGuide[]): string {
    const lines = styles.map((s) => {
      const example = s.example ? `\n  示例：${s.example}` : ''
      return `- [${s.category}] ${s.rule}${example}`
    })
    return `## 风格指南\n\n${lines.join('\n')}`
  }

  /** 格式化章节信息 */
  private formatChapterInfo(projectId: string, chapterNumber: number, task: NarrativeTask): string {
    const project = this.stores.getProject(projectId)
    const volume = project?.currentVolume ?? 1
    const targetWords = this.computeChapterTargetWords(project)
    return [
      `## 当前章节`,
      ``,
      `- 卷：第${volume}卷`,
      `- 章：第${chapterNumber}章`,
      `- 叙事任务：${task.description}（类型：${task.type}）`,
      `- 优先级：${task.priority}`,
      `- 目标字数：${targetWords} 字`,
    ].join('\n')
  }

  /** 格式化创作约束 */
  private formatConstraints(constraints: ChapterConstraints): string {
    const parts: string[] = ['## 创作约束']

    if (constraints.facts.length > 0) {
      parts.push('\n### 事实约束（不能违反）')
      for (const c of constraints.facts) {
        parts.push(`- ${c.rule}`)
      }
    }

    if (constraints.cognitive.length > 0) {
      parts.push('\n### 认知约束（角色不能知道不该知道的事）')
      for (const c of constraints.cognitive) {
        parts.push(`- ${c.rule}`)
      }
    }

    if (constraints.stage.length > 0) {
      parts.push('\n### 阶段约束（当前阶段允许/禁止的事）')
      for (const c of constraints.stage) {
        parts.push(`- ${c.rule}`)
      }
    }

    if (constraints.narrativeDebts.length > 0) {
      parts.push('\n### 叙事债务（待回收的伏笔）')
      for (const f of constraints.narrativeDebts) {
        const status = f.status === 'planted' ? '已埋下' :
          f.status === 'reinforced' ? '已强化' :
          f.status === 'partially_revealed' ? '部分揭露' : '待回收'
        parts.push(`- [${status}] ${f.description}（首次：第${f.firstChapter}章）`)
      }
    }

    if (constraints.characterArcs.length > 0) {
      parts.push('\n### 角色弧光约束')
      for (const arc of constraints.characterArcs) {
        const next = arc.allowedNextStage ? `→ 下一步可达：${arc.allowedNextStage}` : '→ 已完成弧光'
        parts.push(`- ${arc.character.name}：当前阶段「${arc.character.arcStage}」${next}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * 格式化本章已编排的实体约束（手动编排 / AI 编排产出）
   *
   * 与 `formatConstraints` 的区别：
   * - `formatConstraints` 输出的是「规则文本约束」（事实/认知/阶段/伏笔债务/角色弧光）
   * - `formatArrangedEntities` 输出的是「本章必须出现的具体实体」的完整定义，
   *   让 Writer 在 SEMI 层就能感知到编排约束和角色详情，无需通过工具查询。
   *
   * ⚠️ 角色定义放在这里（SEMI 层）而不是系统提示词（STATIC 层）的原因：
   * - 角色数量可能很大（200+），全部塞系统提示词会导致上下文爆炸
   * - 本章出场角色已通过 arrangedEntities 编排好，只需注入这些角色的完整定义
   * - 系统提示词不含角色定义 → 跨章缓存命中最好
   * - 章节上下文含本章角色完整定义 → 单章内缓存命中
   * - 其他角色 LLM 通过 formatStoryState 知道存在（name+动态状态），需要详情时调 query_state 工具
   */
  private formatArrangedEntities(projectId: string, arranged: ArrangedEntity): string {
    const lines: string[] = ['【本章必须出现的实体（已编排约束，Writer 必须遵守）】']
    if (arranged.characterIds.length > 0) {
      const chars = arranged.characterIds
        .map((id) => this.stores.getCharacter(id))
        .filter((c): c is NonNullable<typeof c> => c != null)
      if (chars.length > 0) {
        lines.push('出场角色（完整定义）：')
        for (const c of chars) {
          // 输出完整静态设定 + 动态状态，让 Writer 无需工具查询即可创作
          const charLines = [`  ### ${c.name}`]
          if (c.identity) charLines.push(`  - 身份：${c.identity}`)
          if (c.personality) charLines.push(`  - 性格：${c.personality}`)
          if (c.appearance) charLines.push(`  - 外貌：${c.appearance}`)
          if (c.speechStyle) charLines.push(`  - 说话风格：${c.speechStyle}`)
          if (c.currentState) charLines.push(`  - 当前状态：${c.currentState}`)
          if (c.currentGoal) charLines.push(`  - 当前目标：${c.currentGoal}`)
          if (c.currentPressure) charLines.push(`  - 当前压力：${c.currentPressure}`)
          if (c.description && !c.currentState) charLines.push(`  - 简介：${c.description}`)
          lines.push(charLines.join('\n'))
        }
      }
    }
    if (arranged.conflictIds.length > 0) {
      const confl = arranged.conflictIds
        .map((id) => this.stores.getConflict(id))
        .filter((c): c is NonNullable<typeof c> => c != null)
      if (confl.length > 0) {
        lines.push('本章冲突：')
        for (const c of confl) {
          lines.push(`  - ${c.description}（${c.stage}，强度${c.intensity}）`)
        }
      }
    }
    if (arranged.foreshadowIds.length > 0) {
      const fores = arranged.foreshadowIds
        .map((id) => this.stores.getForeshadow(id))
        .filter((f): f is NonNullable<typeof f> => f != null)
      if (fores.length > 0) {
        lines.push('本章伏笔：')
        for (const f of fores) {
          lines.push(`  - ${f.description}（${f.status}）`)
        }
      }
    }
    return lines.join('\n')
  }

  /** 格式化故事状态 */
  private formatStoryState(state: StoryState): string {
    const parts: string[] = ['## 当前故事状态']

    // 角色动态状态
    parts.push('\n### 角色当前状态')
    for (const c of state.characters) {
      const lines = [`- **${c.name}**`]
      if (c.currentState) lines.push(`  状态：${c.currentState}`)
      if (c.currentGoal) lines.push(`  目标：${c.currentGoal}`)
      if (c.currentPressure) lines.push(`  压力：${c.currentPressure}`)
      parts.push(lines.join('\n'))
    }

    // 关系状态
    if (state.relationships.length > 0) {
      parts.push('\n### 关系当前状态')
      for (const r of state.relationships) {
        parts.push(`- ${r.characterA} ↔ ${r.characterB}：${r.relationType}（${r.currentStage}）`)
      }
    }

    // 活跃冲突
    if (state.activeConflicts.length > 0) {
      parts.push('\n### 活跃冲突')
      for (const c of state.activeConflicts) {
        parts.push(`- [${c.type}] ${c.description}（强度：${c.intensity}/10，阶段：${c.stage}）`)
      }
    }

    // 待回收伏笔
    if (state.pendingForeshadowing.length > 0) {
      parts.push('\n### 伏笔状态')
      for (const f of state.pendingForeshadowing) {
        parts.push(`- [${f.status}] ${f.description}`)
      }
    }

    // 活跃线索
    if (state.activeClues.length > 0) {
      parts.push('\n### 线索进度')
      for (const c of state.activeClues) {
        parts.push(`- ${c.description}（${c.progress}%，下一步：${c.nextStep}）`)
      }
    }

    return parts.join('\n')
  }

  /** 格式化信息差 */
  private formatInfoLayers(layers: NovelInformationLayer[]): string {
    const parts: string[] = ['## 信息差']
    for (const layer of layers) {
      const readerStatus = layer.readerKnows ? '读者已知' : '读者未知'
      const revealStatus = layer.isRevealed ? '已揭露' : `计划揭露：${layer.revealStage ?? '未定'}`
      parts.push(`- ${layer.infoDescription}（${readerStatus}，${revealStatus}）`)
    }
    return parts.join('\n')
  }

  /**
   * 格式化实体关联（画布连线）
   *
   * 将画布上的手动 + 自动边格式化为可读文本，让 Agent 能感知
   * 用户在画布上建立的角色出场、势力归属、地点场景等关联关系。
   */
  private formatEdges(projectId: string, edges: NovelEdge[]): string {
    const nameMap = this.buildEntityNameMap(projectId)
    const lines = edges.map((e) => {
      const sourceName = nameMap.get(e.sourceId) ?? e.sourceId
      const targetName = nameMap.get(e.targetId) ?? e.targetId
      const label = e.label ? `：${e.label}` : ''
      const origin = e.auto ? '（自动）' : '（手动）'
      return `- ${sourceName}(${e.sourceType}) --[${e.edgeType}]--> ${targetName}(${e.targetType})${label}${origin}`
    })
    return `## 实体关联\n\n${lines.join('\n')}`
  }

  /** 格式化最近章节摘要 */
  private formatRecentSummaries(chapters: NovelChapter[]): string {
    const parts: string[] = ['## 最近章节摘要']
    for (const ch of chapters) {
      // 优先使用 narrative_task 作为摘要（比 content 截取更有语义）
      const summary = ch.narrativeTask
        ? ch.narrativeTask
        : ch.content.slice(0, 200) + (ch.content.length > 200 ? '...' : '')
      parts.push(`- 第${ch.chapterNumber}章《${ch.title}》：${summary}`)
    }
    return parts.join('\n')
  }

  // ═══════════════════════════════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════════════════════════════

  /** 获取故事状态快照 */
  private getStoryState(projectId: string): StoryState {
    const project = this.stores.getProject(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)

    return {
      project,
      characters: this.stores.listCharacters(projectId),
      relationships: this.stores.listRelationships(projectId),
      activeConflicts: this.stores.listConflicts(projectId).filter(
        (c) => c.stage !== 'resolved' && c.stage !== 'transformed',
      ),
      pendingForeshadowing: this.stores.listForeshadowing(projectId).filter(
        (f) => f.status !== 'recovered' && f.status !== 'abandoned',
      ),
      activeClues: this.stores.listClues(projectId).filter((c) => c.progress < 100),
      currentStage: project.currentStage,
      currentChapter: project.currentChapter,
    }
  }

  /**
   * 构建实体 ID → 可读名称的映射表（供格式化边数据时查询实体名称）
   * 覆盖画布上所有节点类型：project/character/chapter/conflict/foreshadow/faction/location/world_element
   */
  private buildEntityNameMap(projectId: string): Map<string, string> {
    const map = new Map<string, string>()
    const project = this.stores.getProject(projectId)
    if (project) map.set(project.id, project.title)
    for (const c of this.stores.listCharacters(projectId)) map.set(c.id, c.name)
    for (const ch of this.stores.listRecentChapters(projectId, 9999)) {
      map.set(ch.id, `第${ch.chapterNumber}章《${ch.title}》`)
    }
    for (const c of this.stores.listConflicts(projectId)) map.set(c.id, c.description)
    for (const f of this.stores.listForeshadowing(projectId)) map.set(f.id, f.description)
    for (const f of this.stores.listFactions(projectId)) map.set(f.id, f.name)
    for (const l of this.stores.listLocations(projectId)) map.set(l.id, l.name)
    for (const w of this.stores.listWorldElements(projectId)) map.set(w.id, w.name)
    return map
  }

  /** 根据实体类型和 ID 查询实体名称（找不到时返回 null） */
  private getEntityName(entityType: string, entityId: string, projectId: string): string | null {
    const map = this.buildEntityNameMap(projectId)
    if (map.has(entityId)) return map.get(entityId)!
    // group 节点无持久化实体
    if (entityType === 'group') return null
    return null
  }

  /** 获取 Agent 角色描述（从模板读取，可配置） */
  private getAgentRoleDescription(agentType: string, projectId?: string): string {
    try {
      // 尝试从 role-{agentType} 模板读取
      return this.promptManager.getTemplate(`role-${agentType}`, projectId)
    } catch {
      // 模板不存在时回退到通用描述
      return '小说创作助手'
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 缓存诊断方法
  // ═══════════════════════════════════════════════════════════════

  /** 计算字符串的 SHA-256 哈希（前 16 位，用于诊断） */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /** 计算系统提示词哈希（用于跨章诊断缓存命中） */
  getSystemPromptHash(projectId: string, agentType: string): string {
    const prompt = this.buildSystemPrompt(projectId, agentType)
    return this.hashContent(prompt)
  }

  /** 计算章节上下文哈希（用于单章内诊断缓存命中） */
  getChapterContextHash(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
  ): string {
    // arrangedEntities 参与 hash 输入，确保编排约束变化时 hash 反映出来
    const arrangedKey = arrangedEntities ? JSON.stringify(arrangedEntities) : ''
    const context = this.buildChapterContext(projectId, chapterNumber, narrativeTask, constraints, arrangedEntities)
    return this.hashContent(context + arrangedKey)
  }
}
