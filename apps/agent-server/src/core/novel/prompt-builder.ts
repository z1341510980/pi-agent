/**
 * NovelPromptBuilder：缓存优化的提示词构建器
 *
 * 核心设计原则（缓存命中率是小说创作的关键成本指标）：
 *
 * 1. 静态在前，动态在后
 *    LLM 提供商（Anthropic/OpenAI）的 prompt cache 基于前缀匹配。
 *    前缀越稳定，缓存命中率越高。
 *
 * 2. 系统提示词只包含静态数据
 *    世界规则、风格指南、角色定义（静态部分）放在系统提示词中。
 *    这些数据跨章节不变，缓存命中率最高。
 *
 * 3. 章节上下文放在首条用户消息中
 *    当前故事状态、叙事任务、约束等半静态数据放在首条用户消息中。
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
 * ├── Layer 0: Agent 身份（永不变）
 * ├── Layer 1: 世界规则（项目级，极少变）
 * ├── Layer 2: 风格指南（项目级，极少变）
 * └── Layer 3: 角色定义（仅静态部分：身份/性格/外貌/说话风格）
 *
 * [首条用户消息] (SEMI - 单章内缓存命中)
 * ├── 章节信息（卷/章/叙事任务/约束）
 * ├── 当前故事状态（角色当前状态/冲突/伏笔/线索）
 * ├── 信息差（谁知道什么）
 * ├── 最近章节摘要
 * └── 创作指令
 *
 * [对话消息] (DYNAMIC - 不缓存)
 * ├── 工具调用 + 结果（追加到末尾，不破坏前缀缓存）
 * ├── 生成内容
 * └── 用户引导
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
  StoryState,
  NarrativeTask,
  ChapterConstraints,
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
}

export class NovelPromptBuilder {
  constructor(
    private promptManager: PromptManager,
    private stores: NovelPromptStores,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // 系统提示词（STATIC 层 - 跨章节缓存命中）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建系统提示词
   *
   * ⚠️ 此方法只读取静态数据，不读取动态状态。
   * 系统提示词在整个项目生命周期内保持不变（除非世界规则/风格/角色定义被修改）。
   * 这确保 LLM 提供商的 prompt cache 能跨章节命中。
   *
   * 构建顺序（从最稳定到最不稳定）：
   * 1. Agent 身份（永不变）         ← 缓存命中率最高
   * 2. 世界规则（项目级，极少变）    ← 高命中率
   * 3. 风格指南（项目级，极少变）    ← 高命中率
   * 4. 角色定义（偶尔变）            ← 中等命中率
   */
  buildSystemPrompt(projectId: string, agentType: string): string {
    const parts: string[] = []

    // ── Layer 0: Agent 身份（永不变）──
    // 从模板文件读取，支持运行时覆盖
    const identityPrompt = this.promptManager.render('system-base', {
      agent_type: agentType,
      agent_role: this.getAgentRoleDescription(agentType, projectId),
    }, projectId)
    parts.push(identityPrompt)

    // ── Layer 1: 世界规则（项目级，极少变）──
    const worldRules = this.stores.listWorldRules(projectId)
    if (worldRules.length > 0) {
      parts.push(this.formatWorldRules(worldRules))
    }

    // ── Layer 2: 风格指南（项目级，极少变）──
    const styleGuide = this.stores.listStyleGuide(projectId)
    if (styleGuide.length > 0) {
      parts.push(this.formatStyleGuide(styleGuide))
    }

    // ── Layer 3: 角色定义（仅静态部分）──
    // ⚠️ 只包含角色的静态设定（身份/性格/外貌/说话风格）
    // 不包含动态状态（当前情绪/目标/压力）—— 那些放在章节上下文中
    const characters = this.stores.listCharacters(projectId)
    if (characters.length > 0) {
      parts.push(this.formatCharacterDefinitions(characters))
    }

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
   * 3. 信息差（谁知道什么）
   * 4. 最近章节摘要
   * 5. 创作指令
   */
  buildChapterContext(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
  ): string {
    const parts: string[] = []

    // ── 章节信息 ──
    parts.push(this.formatChapterInfo(projectId, chapterNumber, narrativeTask))

    // ── 创作约束 ──
    parts.push(this.formatConstraints(constraints))

    // ── 当前故事状态（动态部分）──
    const state = this.getStoryState(projectId)
    parts.push(this.formatStoryState(state))

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

    // ── 创作指令 ──
    const instruction = this.promptManager.render('chapter-instruction', {
      chapter_number: String(chapterNumber),
      narrative_task: narrativeTask.description,
      task_type: narrativeTask.type,
    }, projectId)
    parts.push(instruction)

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

  /**
   * 格式化角色定义（仅静态部分）
   *
   * ⚠️ 不包含动态状态（currentState/currentGoal/currentPressure/secret/arcStage）
   * 这些动态数据放在章节上下文中，避免系统提示词频繁变化导致缓存失效
   */
  private formatCharacterDefinitions(characters: NovelCharacter[]): string {
    const blocks = characters.map((c) => {
      const lines = [
        `### ${c.name}`,
        `- 身份：${c.identity}`,
        `- 性格：${c.personality}`,
        `- 外貌：${c.appearance}`,
      ]
      if (c.speechStyle) {
        lines.push(`- 说话风格：${c.speechStyle}`)
      }
      return lines.join('\n')
    })
    return `## 角色定义\n\n${blocks.join('\n\n')}`
  }

  /** 格式化章节信息 */
  private formatChapterInfo(projectId: string, chapterNumber: number, task: NarrativeTask): string {
    const project = this.stores.getProject(projectId)
    const volume = project?.currentVolume ?? 1
    return [
      `## 当前章节`,
      ``,
      `- 卷：第${volume}卷`,
      `- 章：第${chapterNumber}章`,
      `- 叙事任务：${task.description}（类型：${task.type}）`,
      `- 优先级：${task.priority}`,
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

  /** 格式化最近章节摘要 */
  private formatRecentSummaries(chapters: NovelChapter[]): string {
    const parts: string[] = ['## 最近章节摘要']
    for (const ch of chapters) {
      const summary = ch.content.slice(0, 200) + (ch.content.length > 200 ? '...' : '')
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
}
