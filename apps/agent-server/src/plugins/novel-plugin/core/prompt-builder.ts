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
 * [系统提示词] (STATIC - 跨章节、跨 Agent 缓存命中)
 * ├── Layer 1: 世界规则（项目级，极少变）
 * ├── Layer 2: 风格指南（项目级，极少变）
 * └── 不含 Agent 身份，保证不同 Agent 的公共前缀完全一致
 *
 * [前缀用户消息] (SEMI - 单章内缓存命中)
 * ├── 章节信息（卷/章/叙事任务/约束）
 * ├── 本章出场角色完整定义（arrangedEntities，仅本章角色）
 * ├── 当前故事状态（所有角色的 name+动态状态，让 LLM 知道存在）
 * ├── 信息差（谁知道什么）
 * ├── 最近章节摘要
 * ├── Agent 身份（独立缓存断点）
 * └── Agent 专属后缀（Director 方案、Rubric 等，最易变化）
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
import { compileWritingStylePrompt, type WritingStylePromptTarget } from './writing-style-prompt-factory.js'
import type {
  NovelProject,
  NovelCharacter,
  NovelWorldRule,
  NovelStyleGuide,
  NovelWritingStyleProfile,
  NovelChapter,
  NovelConflict,
  NovelForeshadow,
  NovelHook,
  NovelClue,
  NovelInformationLayer,
  NovelConstraint,
  NovelRelationship,
  NovelFaction,
  NovelLocation,
  NovelWorldElement,
  NovelEdge,
  NovelVolume,
  StoryState,
  NarrativeTask,
  ChapterConstraints,
  ArrangedEntity,
  ChapterRhythm,
  NovelAgentLog,
} from './types.js'
import type { MemoryEvent, MemoryEventType, MemorySnapshot } from './novel-memory-store.js'

/**
 * Store 接口：NovelPromptBuilder 只需要读取数据，不关心存储实现
 */
export interface NovelPromptStores {
  getProject(projectId: string): NovelProject | undefined
  listWorldRules(projectId: string): NovelWorldRule[]
  listStyleGuide(projectId: string): NovelStyleGuide[]
  getWritingStyleProfile?(projectId: string): NovelWritingStyleProfile | undefined
  listCharacters(projectId: string): NovelCharacter[]
  listRelationships(projectId: string): NovelRelationship[]
  listConflicts(projectId: string): NovelConflict[]
  listForeshadowing(projectId: string): NovelForeshadow[]
  listClues(projectId: string): NovelClue[]
  listInformationLayers(projectId: string): NovelInformationLayer[]
  /** 按 ID 查询单个信息差（P3-2：供伏笔反向展示承载的信息差） */
  getInformationLayer(infoLayerId: string): NovelInformationLayer | undefined
  listConstraints(projectId: string): NovelConstraint[]
  listRecentChapters(projectId: string, limit: number): NovelChapter[]
  /** 查询指定章节之前抛出且未兑现的钩子（v0.2：供 Writer 承接） */
  listUnfulfilledHooksBefore(projectId: string, beforeChapter: number): NovelHook[]
  /** 查询指定章节抛出的钩子（v0.2：供 Writer 知道本章要抛出什么） */
  listHooksByChapter(projectId: string, chapterNumber: number): NovelHook[]
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
  /** 按 ID 查询势力（供 arrangedEntities 注入时使用） */
  getFaction(factionId: string): NovelFaction | undefined
  /** 按 ID 查询地点（供 arrangedEntities 注入时使用） */
  getLocation(locationId: string): NovelLocation | undefined
  /** 查询项目的所有卷（供注入卷纲） */
  listVolumes(projectId: string): NovelVolume[]
  /** 查询项目级 Agent 调用日志（供 Reviewer 反馈回流 Director） */
  listAgentLogsByProject?(projectId: string, limit: number): NovelAgentLog[]
}

export class NovelPromptBuilder {
  constructor(
    private promptManager: PromptManager,
    private stores: NovelPromptStores,
    /**
     * 长期记忆存储（可选）。
     *
     * 提供时：buildChapterContext 会注入"近期因果链"摘要到 SEMI 层，
     * 让 Director/Writer/Reviewer 理解最近章节关键事件的因果联系。
     *
     * 不提供时（如 novel-session 的手动对话流）：跳过该部分，不影响其他 section。
     */
    private memoryStore?: {
      listEvents(projectId: string, options?: { minSignificance?: number; limit?: number }): MemoryEvent[]
      getCausalChain(eventId: string): { causes: MemoryEvent[]; effects: MemoryEvent[] }
      getSnapshot?(projectId: string, chapterNumber: number, options?: { snapshotType?: 'full' }): MemorySnapshot | undefined
    },
  ) {}

  /** 按 Agent 职责编译当前项目的文风档案，供预览和日志审计复用。 */
  buildWritingStylePrompt(
    projectId: string,
    target: WritingStylePromptTarget,
  ): ReturnType<typeof compileWritingStylePrompt> | undefined {
    const profile = this.stores.getWritingStyleProfile?.(projectId)
    return profile ? compileWritingStylePrompt(profile, target) : undefined
  }

  /**
   * 计算单章目标字数
   *
   * 估算逻辑：小于等于 10000 的值按章节目标字数处理；更大的值按项目总字数 / 1000
   * 估算单章字数，最终限制在 [2000, 5000] 区间。
   * 不再用 / 30（假设全书 30 章）——300 万字小说实际有 1000+ 章，
   * / 30 会导致单章要求 10 万字，远超 LLM 单次输出能力和合理章节长度。
   *
   * - 300 万字 → 3000 字/章（典型网文）
   * - 100 万字 → 2000 字/章（保底）
   * - 500 万字 → 5000 字/章（上限）
   * - 未设置   → 3000 字/章（默认）
   *
   * 节奏联动：breather/setup 偏短（×0.8），climax 偏长（×1.3），其余不变
   */
  /**
   * 计算章节目标字数（应用节奏系数）
   *
   * public 暴露：PostWriteGuard 字数检测需复用同一逻辑，避免与 Writer 提示词目标不一致。
   */
  computeChapterTargetWords(project: NovelProject | undefined, rhythm?: ChapterRhythm): number {
    let base: number
    if (!project || project.targetWords <= 0) base = 3000
    else base = Math.round(project.targetWords / 1000)
    base = Math.min(5000, Math.max(2500, base))
    // 节奏联动调整
    if (rhythm === 'climax') base = Math.round(base * 1.3)
    else if (rhythm === 'breather' || rhythm === 'setup') base = Math.round(base * 0.85)
    return Math.min(6000, Math.max(2000, base))
  }

  // ═══════════════════════════════════════════════════════════════
  // 系统提示词（STATIC 层 - 跨章节缓存命中）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建系统提示词
   *
   * ⚠️ 此方法只读取静态数据，不读取动态状态，也不读取角色定义。
   * 系统提示词在整个项目生命周期内保持不变（除非世界规则/风格/势力/地点被修改）。
   * 这确保 LLM 提供商的 prompt cache 能跨章节命中。
   *
   * 角色定义不放在系统提示词的原因：
   * - 角色数量可能很大（200+），全部塞系统提示词会导致上下文爆炸
   * - 本章出场角色已通过 arrangedEntities 编排好，只需注入这些角色的完整定义
   * - 其他角色 LLM 通过 formatStoryState 知道存在（name+动态状态），需要详情时调 query_state 工具
   *
   * 势力 / 地点 / 世界要素 上提到系统提示词的原因：
   * - 数量有限（通常几十个），不会导致上下文爆炸
   * - 静态档案跨章稳定（name / description / type 等极少变）
   * - 上提后 system prompt 长度提升到缓存阈值之上，提升缓存命中率
   *
   * 构建顺序（从最稳定到最不稳定）：
   * 1. 世界规则（项目级，极少变）              ← 高命中率
   * 2. 风格指南（项目级，极少变）              ← 高命中率
   * 3. 势力/地点/世界要素静态档案（项目级）     ← 高命中率
   * 4. Agent 身份（Agent 专属）                ← 同 Agent 跨章不变
   */
  buildSystemPrompt(projectId: string, agentType: string): string {
    void agentType
    const parts: string[] = []

    // ── 共享前缀（跨 Agent 相同，跨章不变，最大化 prompt cache 命中）──
    // 顺序：全书大纲 → 卷纲 → 世界规则 → 风格指南 → Agent 身份
    // 共享部分在前，Agent 专属部分在后，确保不同 Agent 的前缀相同可共享缓存。

    // ── Layer -1: 全书大纲 + 当前卷纲（项目级，跨 Agent 共享，跨章不变）──
    // 全书大纲让 Director 规划时不偏离主线走向，Writer 创作时知道故事全局方向。
    // 卷纲让 Director 和 Writer 明确当前卷的起承转合和核心冲突。
    const project = this.stores.getProject(projectId)
    if (project) {
      if (project.synopsis?.trim()) {
        parts.push(`## 故事简介\n\n${project.synopsis.trim()}`)
      }
      if (project.outline?.trim()) {
        parts.push(`## 全书大纲（Director 规划必须服务于此，Writer 创作必须知晓此方向）\n\n${project.outline.trim()}`)
      }
      // 注入当前卷纲 + 相邻卷纲摘要
      const volumes = this.stores.listVolumes(projectId)
      const currentVolNum = project.currentVolume
      const currentVol = volumes.find(v => v.volumeNumber === currentVolNum)
      const prevVol = volumes.find(v => v.volumeNumber === currentVolNum - 1)
      const nextVol = volumes.find(v => v.volumeNumber === currentVolNum + 1)

      // 前卷纲要回顾：让 Director/Writer 知道上一卷的收束情况，避免断裂
      if (prevVol?.outline?.trim()) {
        parts.push(`## 前卷回顾（第${prevVol.volumeNumber}卷《${prevVol.title}》的卷纲，供衔接参考）\n\n${prevVol.outline.trim()}`)
      }
      // 当前卷纲：Director 规划必须服务于此
      if (currentVol?.outline?.trim()) {
        parts.push(`## 当前卷纲（第${currentVol.volumeNumber}卷《${currentVol.title}》的叙事规划）\n\n${currentVol.outline.trim()}`)
      }
      // 下卷预告：让 Director 在卷末规划时能提前衔接下一卷方向
      if (nextVol?.outline?.trim()) {
        parts.push(`## 下卷预告（第${nextVol.volumeNumber}卷《${nextVol.title}》的卷纲，供卷末衔接参考）\n\n${nextVol.outline.trim()}`)
      }
    }

    // ── Layer 1: 世界规则（项目级，跨 Agent 共享，跨章不变）──
    // 双键排序：category 业务分组 + id 稳定次序键。
    // 仅按 category 排序在相同 category 多行时仍可能不稳定（依赖上游 SQL 顺序），
    // 加 id 作为次序键确保完全确定性，最大化 prompt cache 命中率。
    const worldRules = this.stores.listWorldRules(projectId)
    if (worldRules.length > 0) {
      const sorted = [...worldRules].sort((a, b) =>
        a.category.localeCompare(b.category) || a.id.localeCompare(b.id),
      )
      parts.push(this.formatWorldRules(sorted))
    }

    // ── Layer 2: 风格指南（项目级，跨 Agent 共享，跨章不变）──
    // 双键排序：category + id（同上）
    const styleGuide = this.stores.listStyleGuide(projectId)
    if (styleGuide.length > 0) {
      const sorted = [...styleGuide].sort((a, b) =>
        a.category.localeCompare(b.category) || a.id.localeCompare(b.id),
      )
      parts.push(this.formatStyleGuide(sorted))
    }

    // ── Layer 3: 势力/地点/世界要素静态档案（项目级，跨 Agent 共享，跨章稳定）──
    // 上提到 STATIC 层以增加 system prompt 长度（突破缓存阈值）并跨章复用。
    // 仅输出静态字段（name/description/type 等），动态字段（status/appearChapters/
    // firstChapter/lastChapter）仍由 SEMI 层的 formatStoryState 输出。
    //
    // ⚠️ 不可移除：Writer 创作时角色可能引用未在本章编排的势力/地点/世界要素，
    // 需要完整定义才能保证描写与设定一致。方案 6 实验性移除后发现大项目（20+ 章）
    // 中 Writer 描写未登场实体时偏离设定，已回退。
    const entityArchive = this.formatEntityArchive(projectId)
    if (entityArchive) parts.push(entityArchive)

    // ⚠️ 缓存关键：Agent 身份段（system-base.md + agent_type + agent_role）已从此处移除，
    // 改为在 DYNAMIC 层 userMessage 开头注入（见 buildAgentIdentity）。
    //
    // 原设计把身份段放在 systemPrompt 末尾，假设"前面的共享部分可跨 Agent 缓存命中"。
    // 但 provider 端的 cache_control breakpoint 打在 system 末尾，整个 system 是一个缓存块，
    // 只要末尾的 agent_type 不同，整个 system 块就 cache miss——4 个 Agent 的 system
    // 各不相同，跨 Agent 缓存全部失效。
    //
    // 移除身份段后，4 个 Agent 的 systemPrompt 完全相同（故事简介+大纲+卷纲+世界规则+
    // 风格指南+实体档案），provider 端能跨 Agent 命中 system 缓存，大幅提升命中率。

    return parts.join('\n\n---\n\n')
  }

  /**
   * 构建 Agent 身份段（原 STATIC 层末尾的 system-base.md 渲染）。
   *
   * 已从 buildSystemPrompt 移到 DYNAMIC 层 userMessage 开头注入，
   * 避免 agent_type 差异导致整个 system 缓存块失效。
   * 调用方：NovelOrchestrator.runAgent 在拼接 inputText 时调用。
   *
   * @param discussion 是否为群聊共创模式。true 时优先加载 `role-{agentType}-discussion`
   *   模板（如 role-director-discussion.md 含场景拆分格式、role-writer-discussion.md
   *   含剧本编织约束、role-character-actor.md 含剧本演出格式）。
   *   群聊模式必须传 true，否则 Agent 不知道自己的群聊职责，会出现 Director 直接写正文等问题。
   */
  buildAgentIdentity(projectId: string, agentType: string, discussion = false): string {
    const identity = this.promptManager.render('system-base', {
      agent_type: agentType,
      agent_role: this.getAgentRoleDescription(agentType, projectId, discussion),
    }, projectId)
    if (agentType !== 'writer' && agentType !== 'reviser' && agentType !== 'reviewer') {
      return identity
    }
    const compiledStyle = this.buildWritingStylePrompt(projectId, agentType)
    return compiledStyle ? `${identity}\n\n---\n\n${compiledStyle.content}` : identity
  }

  // ═══════════════════════════════════════════════════════════════
  // 章节上下文（SEMI 层 - 单章内缓存命中）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建章节上下文 - 共享前缀部分（SEMI 层 shared，跨 Agent 完全相同）
   *
   * 此部分包含所有 Agent 都需要的、跨 Agent 完全一致的章节上下文。
   * 通过 prefixUserMessage 数组的第一条注入，打 cache_control breakpoint 后
   * 能跨 Agent 命中 prompt cache（Director 写入 → Writer/Reviewer/Reviser/Memory 命中）。
   *
   * ⚠️ 缓存关键：此方法的输出必须对所有 Agent 完全一致（不依赖 agentType）。
   * 任何 Agent 专属内容都应放入 buildChapterContextSuffix。
   *
   * 包含：
   * 1. 章节信息（卷/章号/叙事任务/约束）
   * 2. 创作约束
   * 3. 本章已编排实体约束
   * 4. 当前故事状态（角色/冲突/伏笔/线索/势力/地点，含编排实体去重）
   * 5. 实体关联（画布连线）
   * 6. 信息差
   * 7. 最近章节摘要（覆盖最近 3 章）
   * 8. 近期因果链
   */
  buildChapterContextShared(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
  ): string {
    void constraints // constraints 已在 formatConstraints 中使用，此处 void 避免未使用警告
    const parts: string[] = []
    const relevantEntityIds = this.collectRelevantEntityIds(arrangedEntities)

    // ── 章节信息 ──
    parts.push(this.formatChapterInfo(projectId, chapterNumber, narrativeTask))

    // ── 创作约束 ──
    parts.push(this.formatConstraints(constraints))

    // ── 本章已编排实体约束（手动编排 / AI 编排产出，注入 SEMI 层）──
    const hasArranged = this.hasArrangedEntities(arrangedEntities)
    if (hasArranged && arrangedEntities) {
      parts.push(this.formatArrangedEntities(projectId, chapterNumber, arrangedEntities))
    }

    // ── 当前故事状态（所有 Agent 共享，含编排实体去重）──
    // 历史问题：Writer+arranged 曾跳过 formatStoryState 以"节省 token"，但这破坏了
    // 跨 Agent 缓存一致性（Writer 的 shared 与其他 Agent 不同 → 全部 miss）。
    // 现在统一注入：formatStoryState 内部已对 arranged 实体去重，不与
    // formatArrangedEntities 冗余；且这部分 token 走 cache read（廉价）。
    const state = this.getStoryState(projectId, chapterNumber)
    parts.push(this.formatStoryState(state, arrangedEntities))

    // ── 实体关联（画布手动 + 自动连线，作为故事状态的补充）──
    const edges = this.filterRelevantEdges(this.stores.listEdges(projectId), relevantEntityIds)
    if (edges.length > 0) {
      const edgeSection = this.formatEdges(projectId, edges)
      if (edgeSection) parts.push(edgeSection)
    }

    // ── 信息差 ──
    const infoLayers = this.filterRelevantInfoLayers(this.stores.listInformationLayers(projectId), arrangedEntities)
    if (infoLayers.length > 0) {
      parts.push(this.formatInfoLayers(projectId, infoLayers))
    }

    // ── 最近章节摘要（覆盖当前章前 3 章，让 Writer/Reviewer 理解前后文因果）──
    // ⚠️ 必须按当前章 chapterNumber 为基准向前取，不能用 listRecentChapters：
    // listRecentChapters 的 SQL 是 ORDER BY chapter_number DESC LIMIT 3，返回的是
    // 全局章节号最大的 3 章，与"当前生成第几章"无关。当重新生成中间章节（如第7章）
    // 而后续章节（第8、9章）已有内容时，listRecentChapters 会返回 [9,8,7]，过滤当前章
    // 后变成 [8,9]——formatPreviousChapterEnding 会把第9章结尾当"上一章结尾"，
    // formatSoundAnchor 会把第8、9章开头当"叙事声音锚点"，剧情全面错乱。
    // 正确做法：按 chapterNumber 精确取前 3 章，排除当前章及之后所有章节。
    const prevChapters: NovelChapter[] = []
    for (let n = chapterNumber - 1; n >= 1 && prevChapters.length < 3; n--) {
      const ch = this.stores.getChapter(projectId, n)
      if (ch && ch.content && ch.content.trim().length > 0) {
        prevChapters.push(ch)
      }
    }
    prevChapters.reverse() // 升序（旧→新），供 formatRecentSummaries/formatPreviousChapterEnding/formatSoundAnchor 使用
    if (prevChapters.length > 0) {
      parts.push(this.formatRecentSummaries(prevChapters))
    }

    // ── 近期因果链（最近章节的关键事件及其因果联系）──
    // 注入历史因果可让 Director/Writer/Reviewer 理解"为什么会变成现在这样"，
    // 避免脱离前因后果地规划/创作。当前章事件尚未生成，所以查询的是历史章节。
    if (this.memoryStore) {
      const causalSummary = this.formatRecentCausalChain(projectId, chapterNumber)
      if (causalSummary) parts.push(causalSummary)
    }

    // ── 上一章结尾 + 叙事声音锚点（向后看：本章开头承接此处钩子）──
    // 从 suffix 移到 shared：Writer/Reviser/Reviewer 都需要这两段，跨 Agent 完全一致，
    // 放 shared 层能让 director→writer→reviewer→reviser 之间多命中这部分缓存。
    // Director 不需要，但多注入走 cache read 廉价（且 Director 是首个调用者会写入缓存）。
    if (prevChapters.length > 0) {
      const prevEnding = this.formatPreviousChapterEnding(prevChapters)
      if (prevEnding) parts.push(prevEnding)
      const soundAnchor = this.formatSoundAnchor(prevChapters)
      if (soundAnchor) parts.push(soundAnchor)
    }

    // ── 下一章开头 + 前情提要（向前看：本章结尾必须过渡到此处场景）──
    // 重新生成中间章节时，后续章节可能已有内容。若不注入下一章信息，Writer 生成的
    // 本章结尾可能与已存在的下一章开头对不上，导致剧情断裂。注入下一章开头 + recap
    // 让 Writer 知道本章结尾钩子要自然过渡到什么场景。
    // 仅当下一章有实际内容时注入（正常顺序生成时下一章不存在，跳过此段）。
    const nextChapter = this.stores.getChapter(projectId, chapterNumber + 1)
    const nextAnchor = this.formatNextChapterAnchor(nextChapter)
    if (nextAnchor) parts.push(nextAnchor)

    // ── 未兑现钩子（Writer 必须承接上一章抛出的悬念）──
    // v0.2 核心改动：Writer 现在能看到上一章抛出但尚未兑现的钩子，
    // 必须在本章正文中承接。这是解决"前后章衔接对不上"的数据基础。
    const unfulfilledHooks = this.stores.listUnfulfilledHooksBefore(projectId, chapterNumber)
    if (unfulfilledHooks.length > 0) {
      // 上一章钩子必须完整承接；更早的遗留项只保留最近 2 条作为债务提醒，
      // 避免每一章都重复累积整本书的钩子历史。
      const previousChapterHooks = unfulfilledHooks
        .filter((hook) => hook.chapterNumber === chapterNumber - 1)
        // 同一章重跑 Director 可能留下多条 thrown 记录。优先保留最新结果，
        // 同类型同描述去重，并限制为最多 3 个主钩子。
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
        .filter((hook, index, hooks) =>
          hooks.findIndex((candidate) =>
            candidate.hookType === hook.hookType
            && candidate.description.trim() === hook.description.trim(),
          ) === index,
        )
        .slice(0, 3)
      const olderBacklog = unfulfilledHooks
        .filter((hook) => hook.chapterNumber < chapterNumber - 1)
        .slice(0, 2)
      parts.push(this.formatUnfulfilledHooks([...previousChapterHooks, ...olderBacklog]))
    }

    // ── 本章规划钩子（Writer 必须在章末抛出）──
    // Director 在检查点1 后已创建本章钩子实体，Writer 需要知道要抛出什么
    const currentHooks = this.stores.listHooksByChapter(projectId, chapterNumber)
    if (currentHooks.length > 0) {
      parts.push(this.formatCurrentChapterHooks(currentHooks))
    }

    // ── 文风指纹（从前几章提取的文风基准，抗 compaction）──
    // 注入文风特征快照，让 Writer/Reviewer 在 context compaction 后仍能保持文风一致
    if (prevChapters.length > 0) {
      const fingerprint = this.formatStyleFingerprint(prevChapters)
      if (fingerprint) parts.push(fingerprint)
    }

    // ── 待回收伏笔预警（超过 N 章未回收的伏笔标记为急需回收）──
    const urgentForeshadows = this.formatUrgentForeshadows(projectId, chapterNumber)
    if (urgentForeshadows) parts.push(urgentForeshadows)

    return this.stripEmDash(parts.join('\n\n---\n\n'))
  }

  /**
   * 构建章节上下文 - Agent 专属后缀部分（SEMI 层 suffix，各 Agent 不同）
   *
   * 此部分包含各 Agent 专属的上下文，跨 Agent 不同。通过 prefixUserMessage
   * 数组的第二条注入，打 cache_control breakpoint 后仅同 Agent 重试命中。
   *
   * 各 Agent suffix 内容：
   * - Director：宏观节奏分布 + Reviewer 反馈回流
   * - Writer：创作指令（chapter-instruction）
   * - Reviser：空（上一章结尾+叙事声音锚点已在 shared 层）
   * - Reviewer：平台 Rubric + 已批准的 Director 方案
   * - Memory：空（无专属后缀）
   */
  buildChapterContextSuffix(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
    arrangedEntities?: ArrangedEntity,
    agentType?: string,
  ): string {
    void arrangedEntities
    if (!agentType) return ''

    const parts: string[] = []

    // ── 宏观节奏分布 + Reviewer 反馈回流（Director 注入）──
    if (agentType === 'director') {
      const macroRhythm = this.formatMacroRhythm(projectId, chapterNumber)
      if (macroRhythm) parts.push(macroRhythm)
      const reviewerFeedback = this.formatReviewerFeedback(projectId)
      if (reviewerFeedback) parts.push(reviewerFeedback)
    }

    // ── 平台 Rubric（仅 Reviewer 注入，按目标平台调整评分权重）──
    if (agentType === 'reviewer') {
      const platformRubric = this.formatPlatformRubric(projectId)
      if (platformRubric) parts.push(platformRubric)
      if (narrativeTask.description.trim()) {
        parts.push(`## 已批准的本章叙事任务\n\n${narrativeTask.description.trim()}`)
      }
    }

    // ── 创作指令（仅 Writer 注入，其他 Agent 看到会越权写作）──
    // chapter-instruction 模板包含"直接输出章节正文"等 Writer 专属指令，
    // 对 Director/Reviewer/Memory 注入会导致它们越权创作正文。
    if (agentType === 'writer') {
      const project = this.stores.getProject(projectId)
      const rhythm = constraints.rhythmConstraint?.rhythm
      const targetWords = constraints.wordBudget?.target
        ?? this.computeChapterTargetWords(project, rhythm)
      // 条件注入写法理论：根据任务类型/节奏只注入相关理论片段
      const writingTheory = this.buildWritingTheory(narrativeTask.type, rhythm, constraints.conflictTargets.some(t => t.isClimax))
      const positioningGuidance: Record<string, string> = {
        high_pressure: '高压章：快节奏、高张力、动作密集，章尾留强钩。',
        advancement: '推进章：节奏适中，每个场景都要产生信息或局势增量。',
        cultivation: '修炼试错章：写清过程、代价和成长，结尾给出突破或新方向。',
        relationship: '关系回收章：以互动和对话承载关系变化。',
        low_pressure: '低压生活章：允许放缓，但至少推进一项信息或关系；不得为了避免空转临时制造伏笔。',
        information: '信息整理章：用场景和对话承载信息，避免写成清单。',
      }
      const instruction = this.promptManager.render('chapter-instruction', {
        chapter_number: String(chapterNumber),
        narrative_task: narrativeTask.description,
        task_type: narrativeTask.type,
        target_words: String(targetWords),
        positioning_guidance: constraints.positioning
          ? positioningGuidance[constraints.positioning]
          : '未单独指定定位，按已批准的叙事任务和节奏约束执行。',
        writing_theory: writingTheory,
      }, projectId)
      parts.push(instruction)
    }

    if (parts.length === 0) return ''
    return this.stripEmDash(parts.join('\n\n---\n\n'))
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
   * 平台 Rubric：按目标平台注入差异化评分权重
   *
   * 仅在项目设置了 targetPlatform 且非 general 时注入。
   * null 或 general 时返回空字符串（不注入）。
   */
  private formatPlatformRubric(projectId: string): string {
    const project = this.stores.getProject(projectId)
    const platform = project?.targetPlatform
    if (!platform || platform === 'general') return ''

    const rubrics: Record<Exclude<NonNullable<typeof platform>, 'general'>, string> = {
      fanqie: `## 平台 Rubric（番茄·免费阅读平台）

本章按番茄平台的读者偏好调整评分权重：

- **核心权重**：节奏快、爽感强、每章必有小高潮
- **扣分项**：节奏拖沓（< 6 分直接 revise）、铺垫过长、无爽点
- **加分项**：反转密集、打脸爽快、金手指清晰

⚠️ 番茄读者属于浅阅读，节奏和爽感是生命线。若本章无爽点或节奏过慢，即使文笔再好也应降分。`,
      qidian: `## 平台 Rubric（起点·付费订阅平台）

本章按起点平台的读者偏好调整评分权重：

- **核心权重**：世界观完整、人物刻画深、伏笔系统性强
- **扣分项**：设定漏洞、人物扁平、逻辑不自洽
- **加分项**：体系清晰、配角有记忆点、伏笔回收惊艳

⚠️ 起点读者付费阅读，对设定一致性和逻辑严密性要求高。设定漏洞和人物扁平比节奏问题更严重。`,
      zhihu_yanyan: `## 平台 Rubric（知乎盐言·短篇故事平台）

本章按知乎盐言平台的读者偏好调整评分权重：

- **核心权重**：开篇抓人、反转精巧、篇幅精炼
- **扣分项**：开头拖沓、反转生硬、注水
- **加分项**：第一句就入戏、结尾有余味、情绪密度高

⚠️ 知乎盐言是短篇平台，每一段都必须有信息增量。注水和拖沓是致命伤。`,
    }

    return rubrics[platform] ?? ''
  }

  /**
   * 格式化势力/地点/世界要素的静态档案（STATIC 层）
   *
   * 与 formatStoryState 的区别：
   * - formatStoryState 输出动态字段（status / appearChapters 等），随章节变化 → SEMI 层
   * - formatEntityArchive 只输出静态字段（name / description / type / ideology 等）→ STATIC 层
   *
   * 上提到 STATIC 层的好处：
   * 1. 增加 system prompt 长度，突破 LLM provider 缓存阈值（如 1024 token）
   * 2. 跨章节稳定，缓存命中率高
   * 3. 跨 Agent 共享（4 个 Agent 都能感知势力/地点/世界要素的基础信息）
   *
   * 排序：按 name 排序，确保顺序稳定（最大化缓存命中）。
   */
  private formatEntityArchive(projectId: string): string {
    const sections: string[] = []

    // 势力静态档案（不含 status / firstChapter / lastChapter / allies / enemies 等动态字段）
    const factions = this.stores.listFactions(projectId)
    if (factions.length > 0) {
      const sorted = [...factions].sort((a, b) => a.name.localeCompare(b.name))
      const lines = sorted.map((f) => {
        const parts = [`- **${f.name}**`]
        if (f.type) parts.push(`类型：${f.type}`)
        if (f.description) parts.push(f.description)
        if (f.ideology) parts.push(`理念：${f.ideology}`)
        if (f.strength) parts.push(`实力：${f.strength}`)
        return parts.join('；')
      })
      sections.push(`### 势力档案\n${lines.join('\n')}`)
    }

    // 地点静态档案（不含 status / firstChapter / appearChapters 等动态字段）
    const locations = this.stores.listLocations(projectId)
    if (locations.length > 0) {
      const sorted = [...locations].sort((a, b) => a.name.localeCompare(b.name))
      const lines = sorted.map((l) => {
        const parts = [`- **${l.name}**`]
        if (l.type) parts.push(`类型：${l.type}`)
        if (l.description) parts.push(l.description)
        if (l.significance) parts.push(`重要性：${l.significance}`)
        return parts.join('；')
      })
      sections.push(`### 地点档案\n${lines.join('\n')}`)
    }

    // 世界要素静态档案
    const worldElements = this.stores.listWorldElements(projectId)
    if (worldElements.length > 0) {
      const sorted = [...worldElements].sort((a, b) =>
        a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
      )
      const lines = sorted.map((w) => {
        const parts = [`- [${w.category}] **${w.name}**`]
        if (w.description) parts.push(w.description)
        return parts.join('；')
      })
      sections.push(`### 世界要素档案\n${lines.join('\n')}`)
    }

    if (sections.length === 0) return ''
    return `## 项目实体档案（静态）\n\n${sections.join('\n\n')}`
  }

  /**
   * 格式化章节信息
   *
   * ⚠️ 缓存关键：所有 Agent（Director/Writer/Reviewer/Memory）必须输出完全相同的
   * 章节信息，确保 SEMI 层前缀跨 Agent 一致，让 LLM provider 端能命中 prompt cache。
   *
   * Writer 的完整叙事任务（Director 实时输出）由 chapter-instruction 模板在
   * SEMI 层末尾渲染，此处只输出数据库章纲描述（跨 Agent 一致）。
   * 类型/优先级等信息也由 chapter-instruction 模板输出，此处不重复。
   *
   * ⚠️ outline 字段：用户在前端 DebouncedOutlineField 填写的章纲内容，
   * 是创作的统一起点。这里优先注入 outline，narrativeTask 仅作为任务类型标签保留。
   * 历史问题：b4f720b 之前只注入 narrativeTask（如"推进主线剧情"6 字标签），
   * 导致 LLM 看不到用户写的章纲，Director 只能自由发挥，正文偏离用户设定。
   */
  private formatChapterInfo(
    projectId: string,
    chapterNumber: number,
    task: NarrativeTask,
    agentType?: string,
  ): string {
    void agentType // 不再区分 agentType，保留参数仅为向后兼容
    const project = this.stores.getProject(projectId)
    const volume = project?.currentVolume ?? 1
    const targetWords = this.computeChapterTargetWords(project)
    const chapter = this.stores.getChapter(projectId, chapterNumber)
    const lines = [
      `## 当前章节`,
      ``,
      `- 卷：第${volume}卷`,
      `- 章：第${chapterNumber}章`,
      `- 任务类型：${task.description}`,
      `- 优先级：${task.priority}`,
      `- 目标字数：${targetWords} 字`,
    ]
    // 注入用户编写的章纲（outline）作为创作统一起点
    // 如果 outline 为空，回退使用 narrativeTask（保持向后兼容）
    const outline = chapter?.outline?.trim()
    if (outline) {
      lines.push(``, `### 章纲（用户编写 - 创作统一起点，必须严格遵循）`, ``, outline)
    } else if (task.description) {
      lines.push(``, `### 章纲`, ``, task.description)
    }
    return lines.join('\n')
  }

  /**
   * 将文本中的关键数字（百分比、次数、年份、频率等）加粗标注。
   *
   * 设计意图：LLM 在长上下文中容易"记错"具体数字（如把"三次脉冲"写成"七次"）。
   * 用 **加粗** 突出关键数字，利用 LLM 对 markdown 强调的注意力偏好，
   * 降低数字篡改概率。
   */
  private boldKeyNumbers(text: string): string {
    return text
      // 百分比：73% → **73%**
      .replace(/(\d+(?:\.\d+)?%)/g, '**$1**')
      // 次数/量词：七次、3次、27年 → **七次**、**3次**、**27年**
      .replace(/(\d+|[一二三四五六七八九十百千万]+)(次|遍|个|年|月|天|日|时|刻|分|秒|轮|道|条|块|人|名|位)/g, '**$1$2**')
      // 频率/参数：7.83Hz、42摄氏度
      .replace(/(\d+(?:\.\d+)?(?:Hz|赫兹|摄氏度|℃|度|米|公里|公斤|千克|吨))/g, '**$1**')
  }

  private formatConstraints(constraints: ChapterConstraints): string {
    const parts: string[] = ['## 创作约束']

    if (constraints.facts.length > 0) {
      parts.push('\n### 事实约束（不能违反）')
      parts.push('⚠️ 关键数字已加粗标注，正文必须与此一致。')
      for (const c of constraints.facts) {
        parts.push(`- ${this.boldKeyNumbers(c.rule)}`)
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

    // suspenseHooks 已携带同一伏笔的本章动作时，不再以“叙事债务”重复一遍。
    const suspenseDescriptions = new Set(constraints.suspenseHooks.map((hook) => hook.description))
    const standaloneDebts = constraints.narrativeDebts.filter(
      (foreshadow) => !suspenseDescriptions.has(foreshadow.description),
    )
    if (standaloneDebts.length > 0) {
      parts.push('\n### 叙事债务（待回收的伏笔）')
      parts.push('⚠️ 伏笔描述中的关键数字已用 **加粗** 标注，正文必须与此一致，不得篡改。')
      for (const f of standaloneDebts) {
        const status = f.status === 'planted' ? '已埋下' :
          f.status === 'reinforced' ? '已强化' :
          f.status === 'partially_revealed' ? '部分揭露' : '待回收'
        // 关键数字加粗：防止 Writer 在正文中篡改设定数据
        const desc = this.boldKeyNumbers(f.description)
        parts.push(`- [${status}] ${desc}（首次：第${f.firstChapter}章）`)
      }
    }

    if (constraints.characterArcs.length > 0) {
      parts.push('\n### 角色弧光约束')
      for (const arc of constraints.characterArcs) {
        const next = arc.allowedNextStage ? `→ 下一步可达：${arc.allowedNextStage}` : '→ 已完成弧光'
        parts.push(`- ${arc.character.name}：当前阶段「${arc.character.arcStage}」${next}`)
      }
    }

    // 冲突推进目标（本章必须推进的冲突清单）
    if (constraints.conflictTargets.length > 0) {
      parts.push('\n### 冲突推进目标（本章必须推进）')
      for (const target of constraints.conflictTargets) {
        const c = target.conflict
        const segs = [`- [${c.type}] ${c.description}`]
        segs.push(`目标阶段：${target.targetStage}`)
        segs.push(`强度变化：${target.intensityDelta > 0 ? '+' : ''}${target.intensityDelta}`)
        if (target.isClimax) {
          segs.push('【本章推向高潮】')
          if (c.climaxType) segs.push(`高潮类型：${c.climaxType}`)
        }
        parts.push(segs.join('；'))
      }
    }

    // 节奏约束
    if (constraints.rhythmConstraint) {
      const rc = constraints.rhythmConstraint
      parts.push('\n### 节奏约束')
      const segs = [`- 节奏类型：${rc.rhythm}`]
      if (rc.climaxIntensity) segs.push(`高潮强度：${rc.climaxIntensity}`)
      if (rc.climaxType) segs.push(`高潮类型：${rc.climaxType}`)
      segs.push(`说明：${rc.description}`)
      parts.push(segs.join('；'))
    }

    // 悬念钩子
    if (constraints.suspenseHooks.length > 0) {
      parts.push('\n### 悬念钩子（本章需维持或释放的悬念）')
      for (const hook of constraints.suspenseHooks) {
        const segs = [`- ${hook.description}`]
        segs.push(`状态：${hook.status}`)
        if (hook.sustainedChapters > 0) segs.push(`已持续：${hook.sustainedChapters} 章`)
        if (hook.releaseByChapter) segs.push(`计划释放：第 ${hook.releaseByChapter} 章`)
        parts.push(segs.join('；'))
      }
    }

    // POV（视点人物）约束
    if (constraints.povCharacters && constraints.povCharacters.length > 0) {
      parts.push('\n### POV 约束（视点人物）')
      parts.push(`本章必须严格使用以下角色的视角：${constraints.povCharacters.join('、')}`)
      parts.push('不得出现未列在此处的角色的内心独白。如需切换视角，必须用明确的场景分隔。')
    }

    // 场景数（节奏速率引导）
    if (constraints.sceneCount && constraints.sceneCount > 0) {
      parts.push('\n### 场景数（节奏速率引导）')
      if (constraints.sceneCount === 1) {
        parts.push('本章 1 个场景：单场景写透，深入挖掘细节和情感，不赶进度')
      } else if (constraints.sceneCount === 2) {
        parts.push('本章 2 个场景：两个场景各有侧重，中间用场景切换自然过渡')
      } else {
        parts.push(`本章 ${constraints.sceneCount} 个场景：多场景快推，每个场景点到为止，保持节奏明快`)
      }
    }

    // 时间线偏移（引导 Writer 把握时间推进）
    if (constraints.timeOffset != null) {
      parts.push('\n### 时间线（相对第1章的偏移）')
      if (constraints.timeOffset === 0) {
        parts.push('本章与第1章同日发生，时间不推进')
      } else if (constraints.timeOffset > 0) {
        parts.push(`本章时间相对第1章推进 **${constraints.timeOffset} 天**，请在叙述中自然体现时间流逝（如环境、作息、日期感受）`)
      } else {
        parts.push(`本章时间相对第1章倒退 ${Math.abs(constraints.timeOffset)} 天（闪回/倒叙），请在叙述中明确标记这是回忆或往事`)
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
  private formatArrangedEntities(projectId: string, chapterNumber: number, arranged: ArrangedEntity): string {
    const lines: string[] = ['【本章必须出现的实体（已编排约束，Writer 必须遵守）】']
    // 功能位中文映射（让 Writer 直观理解每个角色的本章推动作用）
    const plotFunctionLabel: Record<string, string> = {
      provide_resource: '提供资源',
      create_obstacle: '制造阻碍',
      amplify_conflict: '放大冲突',
      open_phase: '打开新阶段',
      change_judgment: '改变主角判断',
      advance_relationship: '推进感情线',
      reveal_world_rule: '暴露世界规则',
    }
    const plotRoleLabel: Record<string, string> = {
      protagonist: '主角',
      main_opponent: '主要对手',
      supporting: '重要配角',
      function: '功能配角',
      background: '背景人物',
    }
    // ── P2-1：冲突推进模式中文映射 ──
    const progressionModeLabel: Record<string, string> = {
      linear: '线性升级',
      mutation: '突变',
      stagnation: '停滞',
      regression: '降级',
      reversal: '反转',
    }
    // ── P2-2：伏笔 category / plantMethod / recoverMethod 中文映射 ──
    const foreshadowCategoryLabel: Record<string, string> = {
      item: '物品',
      spoken: '言语',
      event: '事件',
      identity: '身份',
      secret: '秘密',
      prophecy: '预言',
      promise: '承诺',
      quote: '台词',
    }
    const plantMethodLabel: Record<string, string> = {
      explicit: '明写',
      implicit: '暗写',
      indirect: '侧写',
    }
    const recoverMethodLabel: Record<string, string> = {
      explicit: '点破',
      implicit: '暗示',
      reverse: '反向',
      progressive: '递进',
    }
    if (arranged.characterIds.length > 0) {
      // 过滤占位角色：名字含"（待定）"/"待补充"等的是 AI 编排未命名的占位角色，
      // 其字段全是"待补充（占位）"模板文本，对 Writer 无意义且浪费上下文
      const isPlaceholderName = (name: string): boolean =>
        /（待定）|待补充|待定$/.test(name)
      const chars = arranged.characterIds
        .map((id) => this.stores.getCharacter(id))
        .filter((c): c is NonNullable<typeof c> => c != null)
        .filter((c) => !isPlaceholderName(c.name))
      if (chars.length > 0) {
        // 按功能位索引，便于角色查到对应功能
        const functionMap = new Map<string, Array<{ function: string; note?: string }>>()
        for (const entry of arranged.characterFunctions ?? []) {
          const entries = functionMap.get(entry.characterId) ?? []
          entries.push({ function: entry.function, note: entry.note })
          functionMap.set(entry.characterId, entries)
        }
        lines.push('出场角色（完整定义）：')
        for (const c of chars) {
          // 输出完整静态设定 + 动态状态 + 四层逻辑字段，让 Writer 无需工具查询即可创作
          const charLines = [`  ### ${c.name}`]
          if (c.identity) charLines.push(`  - 身份：${c.identity}`)
          if (c.personality) charLines.push(`  - 性格：${c.personality}`)
          if (c.appearance) charLines.push(`  - 外貌：${c.appearance}`)
          if (c.speechStyle) charLines.push(`  - 说话风格（写作时对话必须符合此风格）：${c.speechStyle}`)
          if (c.currentState) charLines.push(`  - 当前状态：${c.currentState}`)
          if (c.currentGoal) charLines.push(`  - 当前目标（短期）：${c.currentGoal}`)
          // 四层逻辑①：长期欲望（跨章节稳定的发动机）
          if (c.longTermDesire) charLines.push(`  - 长期欲望：${c.longTermDesire}`)
          if (c.currentPressure) charLines.push(`  - 当前压力：${c.currentPressure}`)
          // 四层逻辑②：角色层级（决定笔墨分配）
          const roleLabel = plotRoleLabel[c.plotRole] ?? c.plotRole
          charLines.push(`  - 角色层级：${roleLabel}`)
          // 四层逻辑③：本章功能位（关键，避免工具人化）
          const functions = functionMap.get(c.id) ?? []
          for (const fn of functions) {
            const fnLabel = plotFunctionLabel[fn.function] ?? fn.function
            charLines.push(`  - ⚡ 本章功能位：${fnLabel}${fn.note ? `（${fn.note}）` : ''}`)
          }
          if (c.secret) charLines.push(`  - 隐藏秘密：${c.secret}`)
          if (c.description && !c.currentState) charLines.push(`  - 简介：${c.description}`)
          // 四层逻辑④：删掉影响（让 Writer 知道这个角色不可替代什么）
          if (c.removalImpact && c.removalImpact !== '暂无关键影响') {
            charLines.push(`  - 删掉影响：${c.removalImpact}`)
          }
          lines.push(charLines.join('\n'))
        }
      }
    }
    // ── 本章角色之间的关系状态（四层逻辑②：动态关系）──
    // 让 Writer 知道本章角色之间的当前关系状态 + 阵营 + 走向 + 本章约束提示
    if (arranged.characterIds.length > 1) {
      const charIdSet = new Set(arranged.characterIds)
      const relations = this.stores.listRelationships(projectId)
        .filter((r) => charIdSet.has(r.characterA) && charIdSet.has(r.characterB))
      if (relations.length > 0) {
        lines.push('')
        lines.push('本章出场角色之间的关系（动态状态 + 阵营 + 走向，影响互动方式）：')
        const charNameMap = new Map(arranged.characterIds
          .map((id) => this.stores.getCharacter(id))
          .filter((c): c is NonNullable<typeof c> => c != null)
          .map((c) => [c.id, c.name]))
        const alignmentLabel: Record<string, string> = {
          ally: '同一边',
          temporary_ally: '暂时同路',
          opponent: '对立',
          temporary_opponent: '暂时对立',
          neutral: '中立',
          pending_shift: '待转变',
        }
        const trendLabel: Record<string, string> = {
          stable: '稳定',
          warming: '升温',
          cooling: '降温',
          breaking: '即将破裂',
          reconciling: '和解中',
        }
        for (const r of relations) {
          const nameA = charNameMap.get(r.characterA) ?? r.characterA
          const nameB = charNameMap.get(r.characterB) ?? r.characterB
          const parts = [`  - ${nameA} ↔ ${nameB}`]
          if (r.relationType) parts.push(`关系：${r.relationType}`)
          if (r.currentStage) parts.push(`当前阶段：${r.currentStage}`)
          // ── 四层逻辑②：动态字段 ──
          if (r.dynamicRole) parts.push(`功能位：${r.dynamicRole}`)
          parts.push(`阵营：${alignmentLabel[r.alignment] ?? r.alignment}`)
          parts.push(`走向：${trendLabel[r.trend] ?? r.trend}`)
          if (r.chapterHint) parts.push(`⚡ 本章约束：${r.chapterHint}`)
          lines.push(parts.join('；'))
        }
      }
    }
    if (arranged.conflictIds.length > 0) {
      const confl = arranged.conflictIds
        .map((id) => this.stores.getConflict(id))
        .filter((c): c is NonNullable<typeof c> => c != null)
      if (confl.length > 0) {
        lines.push('本章冲突：')
        // 用于把 participants（JSON: string[]）解析为角色名
        const allChars = this.stores.listCharacters(projectId)
        const charNameMap = new Map(allChars.map((c) => [c.id, c.name]))
        for (const c of confl) {
          const parts = [`  - [${c.type}] ${c.description}`]
          parts.push(`阶段：${c.stage}`)
          parts.push(`强度：${c.intensity}/10`)
          parts.push(`层级：${c.tier}`)
          // ── P2-1：冲突功能位 + 推进模式（让 Writer 知道这个冲突在本章的推动作用与演变规律）──
          if (c.plotFunction) {
            parts.push(`⚡ 功能位：${plotFunctionLabel[c.plotFunction] ?? c.plotFunction}`)
          }
          if (c.progressionMode) {
            parts.push(`推进模式：${progressionModeLabel[c.progressionMode] ?? c.progressionMode}`)
          }
          // ── 四层逻辑④：participants 双向关联 ──
          // 输出参与方角色名，让 Writer 知道这个冲突涉及谁
          let participantNames: string[] = []
          try {
            const parsed = JSON.parse(c.participants)
            if (Array.isArray(parsed)) {
              participantNames = parsed
                .map((id: unknown) => typeof id === 'string' ? charNameMap.get(id) : undefined)
                .filter((n: unknown): n is string => typeof n === 'string')
            }
          } catch {
            // 旧数据可能不是 JSON，忽略
          }
          if (participantNames.length > 0) {
            parts.push(`参与方：${participantNames.join('、')}`)
          }
          if (c.stakes) parts.push(`赌注：${c.stakes}`)
          if (c.twistPotential != null) parts.push(`突转潜力：${c.twistPotential}/10`)
          lines.push(parts.join('；'))
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
          const parts = [`  - ${f.description}`]
          // ── P2-2：category + plantMethod + recoverMethod 让 Writer 知道如何埋设/回收 ──
          parts.push(`类别：${foreshadowCategoryLabel[f.category] ?? f.category}`)
          parts.push(`状态：${f.status}`)
          if (f.plantMethod) {
            parts.push(`埋设方式：${plantMethodLabel[f.plantMethod] ?? f.plantMethod}`)
          }
          if (f.recoverMethod) {
            parts.push(`回收方式：${recoverMethodLabel[f.recoverMethod] ?? f.recoverMethod}`)
          }
          if (f.recoverByChapter != null) {
            parts.push(`应在第 ${f.recoverByChapter} 章前回收`)
          }
          const currentBeat = f.beats?.find((beat) => beat.chapter === chapterNumber)
          if (currentBeat) {
            const beatLabel = {
              plant: '埋设',
              reinforce: '强化',
              reveal: '部分揭示',
              payoff: '回收',
            }[currentBeat.type]
            parts.push(`本章节点：${beatLabel}`)
            if (currentBeat.note) parts.push(`节点内容：${currentBeat.note}`)
          }
          // ── P3-2：反向展示 linkedInfoLayers（本伏笔承载了哪些信息差）──
          // 让 Writer 在回收伏笔时同步翻转读者认知（避免伏笔回收了但信息差没揭露）
          const linkedInfoLayerIds = this.parseIdListSafe(f.linkedInfoLayers)
          if (linkedInfoLayerIds.length > 0) {
            const linkedInfoDescs: string[] = []
            for (const ilId of linkedInfoLayerIds) {
              const il = this.stores.getInformationLayer(ilId)
              if (il) {
                const ilReader = il.readerKnows ? '读者已知' : '读者未知'
                linkedInfoDescs.push(`${il.infoDescription}（${ilReader}）`)
              }
            }
            if (linkedInfoDescs.length > 0) {
              parts.push(`⚡ 承载信息差：${linkedInfoDescs.join('；')}`)
            }
          }
          lines.push(parts.join('；'))
        }
      }
    }
    if (arranged.factionIds.length > 0) {
      const facs = arranged.factionIds
        .map((id) => this.stores.getFaction(id))
        .filter((f): f is NonNullable<typeof f> => f != null)
      if (facs.length > 0) {
        lines.push('本章登场势力：')
        for (const f of facs) {
          const parts = [`  - ${f.name}`]
          if (f.description) parts.push(f.description)
          if (f.type) parts.push(`类型：${f.type}`)
          if (f.ideology) parts.push(`理念：${f.ideology}`)
          if (f.strength) parts.push(`实力：${f.strength}`)
          if (f.status) parts.push(`状态：${f.status}`)
          if (f.allies && f.allies.length > 0) parts.push(`盟友：${f.allies.join('、')}`)
          if (f.enemies && f.enemies.length > 0) parts.push(`敌对：${f.enemies.join('、')}`)
          lines.push(parts.join('；'))
        }
      }
    }
    if (arranged.locationIds.length > 0) {
      const locs = arranged.locationIds
        .map((id) => this.stores.getLocation(id))
        .filter((l): l is NonNullable<typeof l> => l != null)
      if (locs.length > 0) {
        lines.push('本章场景地点：')
        for (const l of locs) {
          const parts = [`  - ${l.name}`]
          if (l.description) parts.push(l.description)
          if (l.type) parts.push(`类型：${l.type}`)
          if (l.significance) parts.push(`重要性：${l.significance}`)
          if (l.status && l.status !== 'normal') parts.push(`状态：${l.status}`)
          lines.push(parts.join('；'))
        }
      }
    }
    lines.push('')
    lines.push('矩阵执行验收：正文必须让上述实体实际参与本章事件，不得只在叙述中点名；角色必须完成其本章功能位，冲突/伏笔必须按标注的推进节点执行。Reviewer 必须逐项核对。')
    return lines.join('\n')
  }

  private hasArrangedEntities(arranged?: ArrangedEntity): boolean {
    return !!arranged && (
      arranged.characterIds.length > 0
      || arranged.conflictIds.length > 0
      || arranged.foreshadowIds.length > 0
      || arranged.factionIds.length > 0
      || arranged.locationIds.length > 0
    )
  }

  private collectRelevantEntityIds(arranged?: ArrangedEntity): Set<string> {
    const ids = new Set<string>()
    if (!arranged) return ids
    for (const id of arranged.characterIds) ids.add(id)
    for (const id of arranged.conflictIds) ids.add(id)
    for (const id of arranged.foreshadowIds) ids.add(id)
    for (const id of arranged.factionIds) ids.add(id)
    for (const id of arranged.locationIds) ids.add(id)
    return ids
  }

  private filterRelevantEdges(edges: NovelEdge[], relevantEntityIds: Set<string>): NovelEdge[] {
    if (edges.length === 0) return []
    if (relevantEntityIds.size === 0) return edges.slice(0, 20)
    return edges
      .filter((e) => relevantEntityIds.has(e.sourceId) || relevantEntityIds.has(e.targetId))
      .slice(0, 20)
  }

  private filterRelevantInfoLayers(
    layers: NovelInformationLayer[],
    arranged?: ArrangedEntity,
  ): NovelInformationLayer[] {
    if (layers.length === 0) return []
    const relevantForeshadowIds = new Set(arranged?.foreshadowIds ?? [])
    if (relevantForeshadowIds.size === 0) {
      return layers
        .filter((layer) => !layer.isRevealed)
        .slice(0, 8)
    }

    const relevant = layers.filter((layer) => {
      if (!layer.isRevealed) return true
      const linked = this.parseIdListSafe(layer.linkedForeshadows)
      return linked.some((id) => relevantForeshadowIds.has(id))
    })
    if (relevant.length > 0) return relevant.slice(0, 8)

    // 兼容旧数据：linkedForeshadows 可能为空，只回退到未揭露信息差。
    return layers.filter((layer) => !layer.isRevealed).slice(0, 8)
  }

  /**
   * 格式化故事状态（SEMI 层注入，严格按编排筛选）
   *
   * 设计变更（2026-07-16）：原实现注入全量实体的精简状态"让 LLM 知道存在"，
   * 但这会让 Writer 看到用户未编排的冲突/伏笔，可能主动写入本章、绕过编排控制。
   * 现改为严格按 arrangedEntities 筛选：
   * - 有编排时：只注入编排角色之间的关系（编排实体本身的完整定义已在
   *   formatArrangedEntities 中给出，此处不重复）；非编排实体严格隔离
   * - 无编排时（兜底）：保持原全量精简注入，避免空上下文
   *
   * @param state 故事状态
   * @param arrangedEntities 本章已编排实体（严格筛选依据）
   */
  private formatStoryState(state: StoryState, arrangedEntities?: ArrangedEntity): string {
    // 占位实体过滤：名字含"（待定）"/"待补充"/"新的"的是 AI 编排未命名的占位实体，
    // 对 Writer 无意义且污染上下文，跳过输出
    const isPlaceholder = (name: string): boolean =>
      /（待定）|待补充|待定$|^新的$|^测试角色/.test(name)

    // 无编排时兜底：保持原全量精简注入，避免空上下文
    // 触发场景：旧项目无编排、AI 编排失败降级、纯 Reviewer 评估无 arrangedEntities
    const hasArranged = this.hasArrangedEntities(arrangedEntities)
    if (!hasArranged) {
      return this.formatStoryStateFullFallback(state, isPlaceholder)
    }

    // ── 有编排：严格按 arrangedEntities 筛选 ──
    const parts: string[] = ['## 当前故事状态']

    // 编排角色 ID → name 集合（关系字段存的是角色名而非 ID，需按 name 匹配）
    const arrangedCharIds = new Set(arrangedEntities!.characterIds)
    const arrangedCharNameSet = new Set(
      state.characters.filter((c) => arrangedCharIds.has(c.id)).map((c) => c.name),
    )

    // 关系：只注入编排角色之间的关系
    // 设计意图：编排了林寒和沈烬，则注入他俩的关系阶段，让 Writer 知道当前关系状态
    // 非编排角色之间的关系不注入，避免干扰
    const relevantRelationships = state.relationships.filter((r) => {
      const aInArranged = arrangedCharNameSet.has(r.characterA)
      const bInArranged = arrangedCharNameSet.has(r.characterB)
      return aInArranged && bInArranged
    }).slice(0, 12)
    if (relevantRelationships.length > 0) {
      parts.push('\n### 编排角色关系')
      for (const r of relevantRelationships) {
        parts.push(`- ${r.characterA} ↔ ${r.characterB}：${r.relationType}（${r.currentStage}）`)
      }
    }

    // 角色当前状态、活跃冲突、待回收伏笔、活跃线索、活跃势力、已登场地点
    // 均不注入：这些实体的完整定义已在 formatArrangedEntities 中给出，
    // 非编排实体严格隔离，避免 Writer 被未选实体干扰。

    return parts.length > 1 ? parts.join('\n') : ''
  }

  /**
   * 无编排时的兜底：全量精简注入故事状态
   *
   * 触发场景：旧项目无编排、AI 编排失败降级、纯 Reviewer 评估无 arrangedEntities。
   * 保持原 formatStoryState 的全量精简行为，避免空上下文导致 Writer 失去全局感知。
   */
  private formatStoryStateFullFallback(
    state: StoryState,
    isPlaceholder: (name: string) => boolean,
  ): string {
    const parts: string[] = ['## 当前故事状态']

    // 角色动态状态（过滤占位）
    const otherChars = state.characters.filter((c) => !isPlaceholder(c.name)).slice(0, 12)
    if (otherChars.length > 0) {
      parts.push('\n### 角色当前状态')
      for (const c of otherChars) {
        const lines = [`- **${c.name}**`]
        if (c.currentState) lines.push(`  状态：${c.currentState}`)
        if (c.currentGoal) lines.push(`  目标：${c.currentGoal}`)
        parts.push(lines.join('\n'))
      }
    }

    // 关系状态（精简：单行输出）
    const relationships = state.relationships.slice(0, 12)
    if (relationships.length > 0) {
      parts.push('\n### 关系当前状态')
      for (const r of relationships) {
        parts.push(`- ${r.characterA} ↔ ${r.characterB}：${r.relationType}（${r.currentStage}）`)
      }
    }

    // 活跃冲突（过滤占位）
    const otherConflicts = state.activeConflicts.filter(
      (c) => !isPlaceholder(c.description),
    ).slice(0, 10)
    if (otherConflicts.length > 0) {
      parts.push('\n### 活跃冲突')
      for (const c of otherConflicts) {
        parts.push(`- [${c.type}] ${c.description}（${c.stage}，强度 ${c.intensity}/10）`)
      }
    }

    // 待回收伏笔（过滤占位）
    const otherForeshadows = state.pendingForeshadowing.filter(
      (f) => !isPlaceholder(f.description),
    ).slice(0, 12)
    if (otherForeshadows.length > 0) {
      parts.push('\n### 伏笔状态')
      for (const f of otherForeshadows) {
        parts.push(`- [${f.status}] ${f.description}`)
      }
    }

    // 活跃线索
    const activeClues = state.activeClues.slice(0, 8)
    if (activeClues.length > 0) {
      parts.push('\n### 线索进度')
      for (const c of activeClues) {
        parts.push(`- ${c.description}（${c.progress}%，下一步：${c.nextStep}）`)
      }
    }

    // 活跃势力（过滤占位）
    const realFactions = state.activeFactions.filter((f) => !isPlaceholder(f.name)).slice(0, 8)
    if (realFactions.length > 0) {
      parts.push('\n### 活跃势力')
      for (const f of realFactions) {
        const segs = [`- **${f.name}**`]
        if (f.type) segs.push(`类型：${f.type}`)
        if (f.status) segs.push(`状态：${f.status}`)
        parts.push(segs.join('；'))
      }
    }

    // 已登场地点（过滤占位）
    const realLocations = state.activeLocations.filter((l) => !isPlaceholder(l.name)).slice(0, 8)
    if (realLocations.length > 0) {
      parts.push('\n### 已登场地点')
      for (const l of realLocations) {
        const segs = [`- **${l.name}**`]
        if (l.type) segs.push(`类型：${l.type}`)
        parts.push(segs.join('；'))
      }
    }

    return parts.join('\n')
  }

  /**
   * 格式化信息差
   *
   * P3-2：扩展展示关联伏笔描述，让 Writer/Reviewer 意识到"这个信息差由哪些伏笔承载"，
   * 在写作时能协同伏笔回收与信息差揭露的时机，避免伏笔回收时未同步翻转读者认知。
   */
  private formatInfoLayers(projectId: string, layers: NovelInformationLayer[]): string {
    const parts: string[] = ['## 信息差']
    for (const layer of layers) {
      const readerStatus = layer.readerKnows ? '读者已知' : '读者未知'
      const revealStatus = layer.isRevealed ? '已揭露' : `计划揭露：${layer.revealStage ?? '未定'}`
      const head = `- ${layer.infoDescription}（${readerStatus}，${revealStatus}）`
      // ── P3-2：解析 linkedForeshadows 反向展示关联伏笔 ──
      // 让 Agent 知道本信息差由哪些伏笔承载，写作时协同回收时机
      const linkedIds = this.parseIdListSafe(layer.linkedForeshadows)
      if (linkedIds.length > 0) {
        const linkedDescs: string[] = []
        for (const fid of linkedIds) {
          const f = this.stores.getForeshadow(fid)
          if (f) {
            linkedDescs.push(`${f.description}（${f.status}）`)
          }
        }
        if (linkedDescs.length > 0) {
          parts.push(`${head}\n  - 承载伏笔：${linkedDescs.join('；')}`)
          continue
        }
      }
      parts.push(head)
    }
    return parts.join('\n')
  }

  /** 容错解析 JSON 字符串数组（旧数据/非法 JSON 返回空数组） */
  private parseIdListSafe(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      // 旧数据可能不是 JSON，忽略
    }
    return []
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
      // 优先使用 Memory Agent 生成的 recap 字段（50-100 字真实剧情摘要）。
      // recap 是章节完成后由 generateChapterRecap 调用 LLM 提炼的真正剧情梗概，
      // 包含核心事件和关键转折，能让下游 Agent 准确理解前后文因果。
      //
      // 历史问题（2026-07 修复）：
      // - 旧实现用 content.slice(0, 300) 截取正文开头作为"摘要"。
      //   但正文开头往往是场景描写/对话切入，并非剧情概括，导致下游 Agent
      //   看到的"摘要"既不是真正的剧情梗概，又损失了章末关键转折信息。
      // - 用 narrativeTask 作摘要更不可靠——它是章纲标签（如"推进主线"），
      //   不是剧情摘要。
      //
      // 回退链：recap（真实摘要）→ content.slice(0, 300)（正文开头兜底）
      // → narrativeTask（章纲标签兜底）→ (无正文)
      let summary: string
      if (ch.recap && ch.recap.trim().length > 0) {
        // Memory Agent 生成的真实剧情摘要，直接使用
        summary = ch.recap.trim()
      } else if (ch.content && ch.content.trim().length > 50) {
        // recap 缺失（章节刚生成、Memory Agent 尚未生成 recap，或生成失败）：
        // 回退到正文开头 300 字兜底，保证有内容可用
        summary = ch.content.trim().slice(0, 300)
        if (ch.content.length > 300) summary += '...'
      } else if (ch.narrativeTask) {
        summary = ch.narrativeTask
      } else {
        summary = '(无正文)'
      }
      parts.push(`- 第${ch.chapterNumber}章《${ch.title}》：${summary}`)
    }
    return parts.join('\n')
  }

  /**
   * 格式化上一章结尾段落（衔接锚点）。
   *
   * 设计意图：
   * - Writer 必须知道上一章如何收尾，才能让本章开头自然承接上一章的钩子。
   * - 注入上一章结尾 200-400 字，作为衔接的硬性锚点。
   * - 若无上一章（第1章或无内容），返回空字符串。
   */
  private formatPreviousChapterEnding(recentChapters: NovelChapter[]): string {
    // recentChapters 是升序（旧→新），取最后一章有内容的结尾（即第 N-1 章）
    // ⚠️ 顺序修正：listRecentChapters 返回升序（ORDER BY DESC + reverse），
    // 之前注释误写为"倒序"，导致取到最旧的章节而非第 N-1 章。
    for (let i = recentChapters.length - 1; i >= 0; i--) {
      const ch = recentChapters[i]
      if (ch.content && ch.content.trim().length > 100) {
        const content = ch.content.trim()
        // 取结尾 400 字（覆盖一个完整的场景收尾 + 钩子）
        const ending = content.length > 400 ? content.slice(-400) : content
        const prefix = content.length > 400 ? '...' : ''
        return `## 上一章结尾（本章开头必须自然承接此处的悬念钩子）\n\n第${ch.chapterNumber}章《${ch.title}》结尾：\n\n${prefix}${ending}`
      }
    }
    return ''
  }

  /**
   * 格式化叙事声音锚点：最近 2-3 章的开头段落原文。
   *
   * 设计意图：
   * - 风格指南是静态规则（"用短句""避免华丽修辞"），无法捕捉一部小说的整体声音质感
   * - 注入最近章节的原文开头（约 200 字），让 LLM 直接感受叙事腔调
   * - Writer 据此保持声音一致；Reviewer 据此检查声音偏差
   */
  private formatSoundAnchor(recentChapters: NovelChapter[]): string {
    // recentChapters 是升序（旧→新），取最后 2 章有内容的开头
    // ⚠️ 顺序修正：listRecentChapters 返回升序，从末尾向前取最近 2 章。
    const anchors: string[] = []
    for (let i = recentChapters.length - 1; i >= 0; i--) {
      const ch = recentChapters[i]
      if (ch.content && ch.content.trim().length > 50) {
        const opening = ch.content.trim().slice(0, 200)
        anchors.push(`- 第${ch.chapterNumber}章开头：${opening}${ch.content.length > 200 ? '...' : ''}`)
      }
      if (anchors.length >= 2) break
    }
    if (anchors.length === 0) return ''
    return `## 叙事声音锚点（参照前文腔调，保持一致）\n\n${anchors.join('\n')}`
  }

  /**
   * 格式化下一章开头锚点（前向衔接）。
   *
   * 设计意图：
   * - 重新生成中间章节时，后续章节可能已有内容。若不注入下一章信息，Writer 生成的
   *   本章结尾可能与已存在的下一章开头对不上，导致剧情断裂。
   * - 注入下一章开头 200-400 字 + recap（前情提要），让 Writer 知道本章结尾钩子
   *   要自然过渡到什么场景，保持章节间衔接连贯。
   * - 仅当下一章有实际内容时返回，否则返回空字符串（正常顺序生成时下一章不存在）。
   *
   * 与 formatPreviousChapterEnding 成对：前者向后看（本章开头承接上一章钩子），
   * 本方法向前看（本章结尾过渡到下一章场景），形成双向衔接锚定。
   */
  private formatNextChapterAnchor(nextChapter: NovelChapter | undefined): string {
    if (!nextChapter) return ''
    const content = nextChapter.content?.trim() ?? ''
    // 下一章内容过短（如刚创建的 planned 状态空章节）不注入，避免误导 Writer
    if (content.length < 50) return ''
    // 取开头 400 字（覆盖一个完整的场景切入，让 Writer 知道过渡目标）
    const opening = content.slice(0, 400)
    const suffix = content.length > 400 ? '...' : ''
    // recap 是 Memory Agent 为下一章生成的前情提要（50-100 字），比正文开头更能
    // 概括下一章核心事件。若存在则一并注入，让 Writer 双重锚定过渡目标。
    const recap = nextChapter.recap?.trim()
    const recapLine = recap && recap.length > 0
      ? `\n\n第${nextChapter.chapterNumber}章前情提要：${recap}`
      : ''
    return `## 下一章开头（本章结尾必须自然过渡到此处的场景，钩子要对得上）\n\n第${nextChapter.chapterNumber}章《${nextChapter.title}》开头：\n\n${opening}${suffix}${recapLine}`
  }

  /**
   * 格式化未兑现钩子列表（v0.2）。
   *
   * 设计意图：
   * - Writer 必须承接上一章抛出的悬念，否则章节衔接断裂
   * - 注入未兑现钩子的描述，让 Writer 知道本章开头要承接什么
   * - 与 formatPreviousChapterEnding 配合：前者是上一章结尾原文，这里是悬念的结构化描述
   */
  private formatUnfulfilledHooks(hooks: NovelHook[]): string {
    const lines = hooks.map(h =>
      `- 第${h.chapterNumber}章 ${h.hookType}钩子：${h.description}`
    )
    return `## 未兑现钩子（本章开头必须自然承接以下悬念，否则读者会感到断裂）\n\n${lines.join('\n')}`
  }

  /**
   * 格式化本章规划钩子（v0.2）。
   *
   * 设计意图：
   * - Director 已规划本章章末钩子，Writer 必须在正文结尾抛出
   * - 让 Writer 知道要抛出什么类型、什么内容的钩子
   */
  private formatCurrentChapterHooks(hooks: NovelHook[]): string {
    const lines = hooks.map(h =>
      `- ${h.hookType}钩子：${h.description}`
    )
    return `## 本章规划钩子（本章正文结尾必须抛出此悬念，驱动读者看下一章）\n\n${lines.join('\n')}`
  }

  /**
   * 格式化宏观节奏分布：最近 10 章的节奏类型统计。
   *
   * 设计意图：
   * - 让 Director 在规划时看到宏观节奏曲线，避免连续高潮或连续铺垫
   * - 标注连续高潮/转折次数，提醒是否需要 breather 缓冲
   */
  private formatMacroRhythm(projectId: string, currentChapterNumber: number): string {
    // 获取最近 10 章（不含当前章）
    const recent = this.stores.listRecentChapters(projectId, 10)
      .filter(ch => ch.chapterNumber < currentChapterNumber)
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
    if (recent.length === 0) return ''

    const rhythms = recent.map(ch => ch.rhythm ?? 'setup')
    const rhythmCounts = new Map<string, number>()
    for (const r of rhythms) rhythmCounts.set(r, (rhythmCounts.get(r) ?? 0) + 1)

    // 计算连续高潮/转折次数
    let consecutiveClimax = 0
    for (let i = rhythms.length - 1; i >= 0; i--) {
      if (rhythms[i] === 'climax' || rhythms[i] === 'twist') consecutiveClimax++
      else break
    }

    const lines = ['## 最近章节节奏分布（宏观节奏管理参考）', '']
    lines.push(`最近 ${recent.length} 章节奏序列：${rhythms.join(' → ')}`)
    lines.push('')
    lines.push('节奏统计：')
    for (const [rhythm, count] of rhythmCounts) {
      lines.push(`- ${rhythm}：${count} 章`)
    }
    if (consecutiveClimax >= 2) {
      lines.push('')
      lines.push(`⚠️ 已连续 ${consecutiveClimax} 章高潮/转折，本章建议安排 breather 或 setup 缓冲`)
    }
    return lines.join('\n')
  }

  /**
   * 格式化 Reviewer 反馈摘要：最近 3 章 Reviewer 的审稿结论和关键问题。
   *
   * 设计意图：
   * - 如果 Reviewer 连续多章发现同类问题，Director 应该知道并改进规划
   * - 提取 Reviewer 日志中的结论（accept/revise/reject）和问题摘要
   */
  private formatReviewerFeedback(projectId: string): string {
    if (!this.stores.listAgentLogsByProject) return ''
    const logs = this.stores.listAgentLogsByProject(projectId, 20)
    // 筛选 Reviewer 日志，取最近 3 条
    const reviewerLogs = logs
      .filter(l => l.agentType === 'reviewer' && l.status === 'success')
      .slice(0, 3)
    if (reviewerLogs.length === 0) return ''

    const lines = ['## 最近审稿反馈（改进规划参考）', '']
    for (const log of reviewerLogs) {
      // 从 result 中提取结论和关键问题（截取前 300 字避免过长）
      const result = log.result?.slice(0, 300) ?? ''
      const verdict = result.match(/结论[:：]\s*(accept|revise|reject)/i)?.[1] ?? 'unknown'
      const lines_result = result.split('\n').filter(l => l.includes('问题') || l.includes('建议')).slice(0, 3)
      lines.push(`- 第${log.chapterNumber}章审稿结论：${verdict}`)
      if (lines_result.length > 0) {
        lines.push(`  关键反馈：${lines_result.join('；')}`)
      }
    }
    return lines.join('\n')
  }

  /**
   * 构建条件写法理论：根据本章任务类型/节奏只注入相关理论片段。
   *
   * 设计意图：
   * - 原来 Writer 的 role-writer.md 包含 80 行理论，每次全量注入浪费 token 且干扰创作
   * - 现在根据任务类型条件触发，只注入相关理论，省 token + 减少约束
   * - 理论片段从 role-writer.md 原有内容中提取精简版
   */
  private buildWritingTheory(
    taskType: string,
    rhythm?: ChapterRhythm,
    isClimax?: boolean,
  ): string {
    const sections: string[] = []

    // 高潮写法（climax 节奏或冲突标记高潮）
    if (rhythm === 'climax' || isClimax) {
      sections.push(`### 高潮写法

- **蓄势释放**：高潮前先写压抑（主角被压制、陷入困境），释放点干脆利落。蓄势占高潮段落 60% 以上
- **大小区别**：minor 单章解决（强度 5-6），medium 跨 2-3 章铺垫（7-8），major 跨卷铺垫（9-10）
- **类型写法**：emotional 聚焦情感爆发（对话+心理），fate 聚焦命运揭晓（信息递进），character 突出性格魅力，combat 聚焦新奇场面，theme 承载思想重量，composite 多线共振`)
    }

    // 突转写法
    if (taskType === 'create_reversal' || rhythm === 'twist') {
      sections.push(`### 突转写法

- **前置呼应**：突转必须呼应前 1-2 章的误导线索和更早的伏笔
- **角色动机一致**：突转后角色行为符合性格逻辑，不为突转而突转
- **信息差利用**：通过角色不知道的信息制造突转，非凭空降神
- **突转节奏**：铺垫要慢（让读者相信 A 方向），突转要快（一个事件改变一切）`)
    }

    // 悬念写法
    if (taskType === 'create_suspense' || rhythm === 'suspense') {
      sections.push(`### 悬念写法

- **埋设（planting）**：通过角色不知道的信息制造紧张感
- **维持（sustaining）**：每章释放一点信息但不说破
- **释放（releasing）**：真相揭晓，情感与信息同时爆发
- **技巧**：信息不对称、倒计时压力、部分揭露、误导与红鲱鱼`)
    }

    // 冲突推进写法（当有冲突推进目标时）
    if (taskType === 'create_conflict' || taskType === 'escalate_conflict') {
      sections.push(`### 冲突推进写法

- **latent → emerging**：暗示冲突存在，角色尚未察觉
- **emerging → escalating**：冲突显性化，角色开始交锋
- **escalating → erupting**：冲突爆发，强度拉满
- 按类型调整：inner/moral 慢节奏心理描写，relationship/emotional 中节奏对话，faction/world_rule 快节奏群像，survival 快节奏动作`)
    }

    if (sections.length === 0) return '（本章无特殊写法理论需要参考，按创作核心原则自由发挥即可）'
    return sections.join('\n\n')
  }

  /**
   * 格式化近期因果链：最近 2 章的高重要性事件及其因果联系。
   *
   * 设计意图：
   * - "最近章节摘要"展示剧情梗概；本节展示"为什么会这样"的因果脉络
   * - 让 Director 在规划本章时承接前因；让 Writer 在创作时保持动机连贯
   * - 仅取 significance >= 6 的事件，避免噪音；按章节分组，最近 2 章优先
   * - 因果展示策略：每个事件若有 cause，展示"直接原因"一行（不递归根因）
   *
   * @param projectId 项目 ID
   * @param currentChapterNumber 当前正在创作的章节号（仅展示此章之前的事件）
   */
  private formatRecentCausalChain(projectId: string, currentChapterNumber: number): string {
    if (!this.memoryStore) return ''
    // 拉取最近的高重要性事件（significance >= 6，最多 30 条）
    const allEvents = this.memoryStore.listEvents(projectId, { minSignificance: 6, limit: 30 })
    // 仅展示当前章之前的事件（当前章事件尚未生成；未来章不存在）
    const pastEvents = allEvents
      .filter((e) => e.chapterNumber < currentChapterNumber)
      .sort((a, b) => b.chapterNumber - a.chapterNumber || a.createdAt - b.createdAt)
    if (pastEvents.length === 0) return ''

    // 按章节分组，取最近 2 章
    const byChapter = new Map<number, MemoryEvent[]>()
    for (const e of pastEvents) {
      const list = byChapter.get(e.chapterNumber)
      if (list) list.push(e)
      else byChapter.set(e.chapterNumber, [e])
    }
    const chaptersToShow = [...byChapter.keys()].sort((a, b) => b - a).slice(0, 2)
    if (chaptersToShow.length === 0) return ''

    const sections: string[] = []
    for (const ch of chaptersToShow) {
      const events = byChapter.get(ch) ?? []
      const lines: string[] = []
      for (const e of events) {
        const typeLabel = this.translateMemoryEventType(e.eventType)
        let line = `- [${typeLabel}] ${e.description}`
        // 若有 cause，查询并展示"直接原因"（chain.causes 数组最后一个元素）
        // chain.causes 已 reverse，[0]=root cause，[last]=direct cause
        if (e.cause) {
          const chain = this.memoryStore!.getCausalChain(e.id)
          const directCause = chain.causes[chain.causes.length - 1]
          if (directCause) {
            line += `\n  ← 由"${directCause.description}"引发`
          }
        }
        lines.push(line)
      }
      sections.push(`### 第${ch}章\n${lines.join('\n')}`)
    }

    return `## 近期因果链（最近章节关键事件的因果联系）\n\n${sections.join('\n\n')}`
  }

  /** 事件类型 → 中文标签 */
  private translateMemoryEventType(t: MemoryEventType): string {
    const map: Record<MemoryEventType, string> = {
      character_change: '角色变更',
      conflict_change: '冲突变更',
      foreshadow_change: '伏笔变更',
      faction_change: '势力变更',
      location_change: '地点变更',
      relationship_change: '关系变更',
      info_layer_change: '信息差变更',
      plot_event: '剧情事件',
      world_change: '世界变更',
    }
    return map[t] ?? t
  }

  // ═══════════════════════════════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 获取故事状态快照。
   *
   * 重写中间章节时，必须读取第 N-1 章保存的全量快照，不能把全局最新状态
   * 当成本章开篇状态，否则未来章节的人物/冲突结果会倒灌进历史章节。
   */
  private getStoryState(projectId: string, chapterNumber: number): StoryState {
    const project = this.stores.getProject(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)

    // 兼容旧项目 currentChapter 未随正文推进的情况：只要数据库里存在更后面的
    // 已写章节，就应把当前请求视为历史章节重写并读取 N-1 快照。
    const latestWrittenChapter = this.stores.listRecentChapters(projectId, 1).at(-1)?.chapterNumber ?? 0
    const latestKnownChapter = Math.max(project.currentChapter, latestWrittenChapter)
    if (chapterNumber > 1 && latestKnownChapter > chapterNumber) {
      const snapshot = this.memoryStore?.getSnapshot?.(projectId, chapterNumber - 1, { snapshotType: 'full' })
      if (snapshot) {
        try {
          const data = JSON.parse(snapshot.snapshotData) as {
            characters?: NovelCharacter[]
            conflicts?: NovelConflict[]
            foreshadowing?: NovelForeshadow[]
            clues?: NovelClue[]
            factions?: NovelFaction[]
            locations?: NovelLocation[]
            relationships?: NovelRelationship[]
          }
          const conflicts = data.conflicts ?? []
          const foreshadowing = data.foreshadowing ?? []
          const factions = data.factions ?? []
          const locations = data.locations ?? []
          return {
            project: { ...project, currentChapter: chapterNumber - 1 },
            characters: data.characters ?? [],
            relationships: data.relationships ?? [],
            activeConflicts: conflicts.filter(c => c.stage !== 'resolved' && c.stage !== 'transformed'),
            pendingForeshadowing: foreshadowing.filter(f => f.status !== 'recovered' && f.status !== 'abandoned'),
            // 新快照读取当时的线索；旧快照缺少 clues 时保持空数组，绝不倒灌未来线索。
            activeClues: data.clues ?? [],
            activeFactions: factions.filter(f => f.status !== 'destroyed'),
            activeLocations: locations.filter(l => l.appearChapters?.some(ch => ch < chapterNumber)),
            currentStage: project.currentStage,
            currentChapter: chapterNumber - 1,
          }
        } catch {
          // 损坏/旧格式快照降级为当前状态，保持创作流程可用。
        }
      }
    }

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
      activeFactions: this.stores.listFactions(projectId).filter(
        (f) => f.status !== 'destroyed',
      ),
      activeLocations: this.stores.listLocations(projectId).filter(
        (l) => l.appearChapters && l.appearChapters.length > 0,
      ),
      currentStage: project.currentStage,
      currentChapter: project.currentChapter,
    }
  }

  /**
   * 文风指纹：从前几章正文中提取文风特征快照
   *
   * 注入 Writer/Reviewer 的 SEMI 层，让 LLM 在 context compaction 后仍能保持文风一致。
   * 提取指标：平均句长、短句/长句占比、对话占比、比喻密度、段落长度、人称、情感温度
   */
  private formatStyleFingerprint(prevChapters: NovelChapter[]): string {
    if (prevChapters.length === 0) return ''

    // 取最近 2-3 章的正文合并分析
    const sampleText = prevChapters
      .map(ch => ch.content || '')
      .filter(c => c.trim().length > 100)
      .join('\n\n')

    if (sampleText.trim().length < 200) return ''

    // 分句（按句号/问号/感叹号）
    const sentences = sampleText.split(/[。！？\n]+/).filter(s => s.trim().length > 0)
    if (sentences.length === 0) return ''

    const sentenceLengths = sentences.map(s => s.replace(/\s/g, '').length)
    const totalChars = sentenceLengths.reduce((sum, len) => sum + len, 0)
    const avgSentenceLength = Math.round(totalChars / sentences.length)
    const shortSentences = sentenceLengths.filter(len => len < 15).length
    const longSentences = sentenceLengths.filter(len => len > 40).length
    const shortSentenceRatio = Math.round((shortSentences / sentences.length) * 100)
    const longSentenceRatio = Math.round((longSentences / sentences.length) * 100)

    // 对话占比（含引号的段落字数 / 总字数）
    const paragraphs = sampleText.split(/\n+/).filter(p => p.trim().length > 0)
    const totalParaChars = paragraphs.reduce((sum, p) => sum + p.replace(/\s/g, '').length, 0)
    const dialogueChars = paragraphs
      .filter(p => /["「『""']/.test(p))
      .reduce((sum, p) => sum + p.replace(/\s/g, '').length, 0)
    const dialogueRatio = totalParaChars > 0 ? Math.round((dialogueChars / totalParaChars) * 100) : 0

    // 比喻密度（每千字比喻词出现次数）
    const metaphorWords = (sampleText.match(/犹如|宛若|仿佛|恍若|好似|有如/g) || []).length
    const metaphorDensity = totalChars > 0 ? Math.round((metaphorWords / totalChars) * 1000) : 0

    // 段落平均长度
    const avgParagraphLength = paragraphs.length > 0 ? Math.round(totalParaChars / paragraphs.length) : 0

    // 叙事人称检测
    const firstPersonCount = (sampleText.match(/我(?!们|国|方|军|辈)/g) || []).length
    const thirdPersonCount = (sampleText.match(/他|她|它/g) || []).length
    const narrativePerson: 'first' | 'third' | 'mixed' =
      firstPersonCount > thirdPersonCount * 2 ? 'first' :
      thirdPersonCount > firstPersonCount * 2 ? 'third' : 'mixed'

    // 情感温度（通过情感词密度估算，0=冷峻，10=热烈）
    const hotWords = (sampleText.match(/怒|吼|咆哮|狂|爆|燃|热血|激昂|疯狂/g) || []).length
    const coldWords = (sampleText.match(/冷|静|默|沉|淡|克制|漠然/g) || []).length
    const emotionalTemperature = Math.min(10, Math.max(0, Math.round(5 + (hotWords - coldWords) * 0.5)))

    const sampleRange: [number, number] = [prevChapters[0].chapterNumber, prevChapters[prevChapters.length - 1].chapterNumber]

    const lines: string[] = [
      `## 文风指纹（第${sampleRange[0]}-${sampleRange[1]}章提取，文风基准）`,
      '',
      `- 平均句长：${avgSentenceLength} 字`,
      `- 短句占比（<15字）：${shortSentenceRatio}%`,
      `- 长句占比（>40字）：${longSentenceRatio}%`,
      `- 对话占比：${dialogueRatio}%`,
      `- 比喻密度：${metaphorDensity}/千字`,
      `- 段落平均长度：${avgParagraphLength} 字`,
      `- 叙事人称：${narrativePerson === 'first' ? '第一人称' : narrativePerson === 'third' ? '第三人称' : '混合人称'}`,
      `- 情感温度：${emotionalTemperature}/10（0=冷峻克制，10=热烈奔放）`,
      '',
      '⚠️ 本章文风必须与此指纹保持一致。如指纹显示短句占比高+情感温度低，本章不可突然变成长句+煽情。',
    ]

    return lines.join('\n')
  }

  /**
   * 待回收伏笔预警：标注超过 N 章未回收的伏笔为"急需回收"
   *
   * 超过 20 章未回收 → 标记"急需回收"
   * 超过 50 章未回收 → 标记"即将过期"
   */
  private formatUrgentForeshadows(projectId: string, chapterNumber: number): string {
    const foreshadows = this.stores.listForeshadowing(projectId)
    const pending = foreshadows.filter(f => f.status !== 'recovered' && f.status !== 'abandoned')

    if (pending.length === 0) return ''

    const urgent: Array<{ desc: string; plantedAt: number; gap: number; level: string }> = []
    for (const f of pending) {
      // 获取伏笔埋设章号
      const plantedAt = f.firstChapter || 0
      if (plantedAt <= 0) continue
      const gap = chapterNumber - plantedAt
      if (gap >= 50) {
        urgent.push({ desc: f.description, plantedAt, gap, level: '即将过期' })
      } else if (gap >= 20) {
        urgent.push({ desc: f.description, plantedAt, gap, level: '急需回收' })
      }
    }

    if (urgent.length === 0) return ''

    const lines: string[] = [
      '## 待回收伏笔预警',
      '',
      '以下伏笔已埋设较久，需考虑在本章或近几章回收：',
      '',
    ]
    for (const u of urgent) {
      lines.push(`- **[${u.level}]** ${u.desc}（第${u.plantedAt}章埋设，已隔 ${u.gap} 章）`)
    }
    lines.push('')
    lines.push('⚠️ 超过 50 章未回收的伏笔读者可能已遗忘，需评估是否废弃或重新强化提醒。')

    return lines.join('\n')
  }

  /**
   * 清洗文本中的破折号"——"，用于注入 LLM 上下文前切断示范传播链。
   *
   * 设计意图：LLM 会模仿输入上下文中的标点习惯。历史章节正文、Director 输出、
   * 实体描述等字段可能含破折号，直接注入会导致下游 LLM 模仿输出破折号。
   * 在注入点清洗（而非 LLM 输出后处理），从源头切断示范传播。
   *
   * 替换策略：
   * - 句末/标点旁的破折号 → 删除（保留原标点）
   * - 连续破折号列举 → 顿号
   * - 句中破折号 → 逗号
   *
   * 注意：此方法仅用于"注入 LLM 上下文的数据字段"清洗，
   * 不用于 LLM 输出后处理（输出后处理已废弃，依赖 prompt 约束 + Reviewer 检测）。
   * 禁令文本中的"——"（如 system-base.md 的铁律）在 STATIC 层，不经过此方法。
   */
  stripEmDash(text: string | undefined | null): string {
    if (!text) return ''
    return text
      // 0. 话语中断（对话末尾的破折号，表示话语被打断）：替换为省略号
      //    如 "我本来想——" → "我本来想……"
      //    检测：引号内的破折号且后跟引号收束
      .replace(/——(["」』""']\s*[。！？]?)/g, '……$1')
      // 1. 句末标点前的破折号：删除破折号，保留句末标点
      .replace(/——([。！？…])/g, '$1')
      // 2. 标点后的破折号：删除破折号，保留原标点
      .replace(/([。！？，；：])——/g, '$1')
      // 3. 连续破折号列举（3个及以上文字段用——分隔）：替换为顿号
      .replace(/(\S)——(\S)——/g, '$1、$2、')
      // 4. 行首破折号：直接删除
      .replace(/^——/gm, '')
      // 5. 剩余句中破折号（前后均为文字）：智能替换
      //    破折号在中文里有两种常见用法：
      //    a) 补充说明（"他拿起剑——父亲留下的遗物"）→ 逗号承接
      //    b) 语气延展/转折（"他推开门——门外站着一个人"）→ 句号断句，更接近铁律推荐的"用句号分割成独立句"
      //    判据：破折号前一字若是动词/形容词常见字（了/着/的/开/起/住/动/响/亮/白/红 等），
      //    多为语气延展，用句号；否则默认用逗号承接。
      //    这比一律替换为逗号更自然，避免"炸开，"这类生硬停顿。
      .replace(/(\S)——(\S)/g, (match, before: string, after: string) => {
        // 语气延展判定：前字为常见动词/状态词尾
        if (/[了着的起着住动响亮白红透碎开落来去见闻]/.test(before)) {
          return `${before}。${after}`
        }
        return `${before}，${after}`
      })
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

  /**
   * 获取 Agent 角色描述（从模板读取，可配置）
   *
   * @param agentType Agent 类型（如 'director'/'writer'/'character-actor'）
   * @param projectId 项目 ID（用于读取项目级覆盖模板）
   * @param discussion 是否为群聊共创模式。true 时优先读 `role-{agentType}-discussion`，
   *   回退到 `role-{agentType}`，让群聊模式加载场景拆分/剧本格式等群聊专属约束。
   */
  private getAgentRoleDescription(agentType: string, projectId?: string, discussion = false): string {
    try {
      if (discussion) {
        try {
          return this.promptManager.getTemplate(`role-${agentType}-discussion`, projectId)
        } catch {
          // 群聊专用模板不存在，回退到通用模板
        }
      }
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
    agentType?: string,
  ): string {
    // arrangedEntities 参与 hash 输入，确保编排约束变化时 hash 反映出来
    const arrangedKey = arrangedEntities ? JSON.stringify(arrangedEntities) : ''
    const shared = this.buildChapterContextShared(projectId, chapterNumber, narrativeTask, constraints, arrangedEntities)
    const suffix = this.buildChapterContextSuffix(projectId, chapterNumber, narrativeTask, constraints, arrangedEntities, agentType)
    return this.hashContent(shared + '\n\n---\n\n' + suffix + arrangedKey)
  }
}
