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
import type { ConsistencyAuditor, ConsistencyReport } from './consistency-auditor.js'
import type { RelationshipGraph, GraphEdge } from './novel-relationship-graph.js'
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
  NovelItem,
  NovelWorldElement,
  NovelEdge,
  NovelVolume,
  StoryState,
  NarrativeTask,
  ChapterConstraints,
  ArrangedEntity,
  ChapterRhythm,
  NovelAgentLog,
  ChapterStoryContext,
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
  /** 按 ID 查询线索（供 arrangedEntities 注入时使用） */
  getClue(clueId: string): NovelClue | undefined
  listInformationLayers(projectId: string): NovelInformationLayer[]
  /** 按 ID 查询单个信息差（P3-2：供伏笔反向展示承载的信息差） */
  getInformationLayer(infoLayerId: string): NovelInformationLayer | undefined
  listConstraints(projectId: string): NovelConstraint[]
  listRecentChapters(projectId: string, limit: number): NovelChapter[]
  /** 查询指定章节之前抛出且未兑现的钩子（v0.2：供 Writer 承接） */
  listUnfulfilledHooksBefore(projectId: string, beforeChapter: number): NovelHook[]
  getChapter(projectId: string, chapterNumber: number): NovelChapter | undefined
  listEdges(projectId: string): NovelEdge[]
  /** 按实体 ID 查询关联边（双向，供关联关系迁移后反向查询） */
  listEdgesByEntity(entityId: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }): NovelEdge[]
  listFactions(projectId: string): NovelFaction[]
  listLocations(projectId: string): NovelLocation[]
  /** 列出项目内所有物品（供 StoryState 和 arrangedEntities 注入） */
  listItems(projectId: string): NovelItem[]
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
  /** 按 ID 查询物品（供 arrangedEntities 注入时使用） */
  getItem(itemId: string): NovelItem | undefined
  /** 查询指定角色拥有的所有物品（供提示词注入"主角拥有什么"） */
  listItemsByOwner?(ownerId: string): NovelItem[]
  /** 查询项目的所有卷（供注入卷纲） */
  listVolumes(projectId: string): NovelVolume[]
  /** 查询项目级 Agent 调用日志（供 Reviewer 反馈回流 Director） */
  listAgentLogsByProject?(projectId: string, limit: number): NovelAgentLog[]
}

export class NovelPromptBuilder {
  /**
   * 审计报告缓存（per-project，60s TTL）
   *
   * 同一章 4 个 Agent（Director/Writer/Reviewer/Memory）会分别调用 buildChapterContextShared，
   * 每次都跑 ConsistencyAuditor.audit 会浪费几十 ms（要遍历所有章节和角色历史）。
   * 缓存让同章内复用结果，60s TTL 覆盖单章生成周期，重生成场景自然失效。
   */
  private auditCache: Map<string, { timestamp: number; report: ConsistencyReport }> = new Map()
  private static readonly AUDIT_CACHE_TTL_MS = 60_000

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
      getChapterStoryContext?(projectId: string, chapterNumber: number): ChapterStoryContext
    },
    /**
     * 统一关系图查询层（可选，C3 prompt 增强）。
     *
     * 提供时：formatEdges 会调用 getAllGraphEdges 拿到派生边（冲突参与/势力敌对/盟友
     * /地点归属/世界要素层级等 7 类），让 LLM 显式看到这些关系，无需从 description 推断。
     *
     * 不提供时（如测试代码、novel-session 的手动对话流）：降级到 stores.listEdges，
     * 只看用户手动连线，无派生边。
     */
    private relationshipGraph?: RelationshipGraph,
    /**
     * 跨章节一致性审计器（可选，C3 prompt 增强）。
     *
     * 提供时：buildChapterContextShared 会注入"跨章一致性"section（孤儿实体/悬挂钩子
     * /时间线矛盾/伏笔状态），并复用 audit.foreshadow 替代 formatUrgentForeshadows 的本地
     * 重复计算。让 Writer/Reviewer 看到具体审计结果，引导在本章修复或回避。
     *
     * 不提供时（如测试代码）：走原 formatUrgentForeshadows 本地逻辑，无审计 section。
     */
    private consistencyAuditor?: ConsistencyAuditor,
  ) {}

  /**
   * 按 Agent 职责编译当前项目的文风档案，供预览和日志审计复用。
   *
   * 诊断行为：当 profile 不存在或样本为空时打 console.warn，让用户能从日志看到
   * 文风档案未生效的根因（用户经常以为档案已配置实际未保存，或样本被前端
   * < 20 字符过滤规则静默丢弃）。不打断创作流程，仅告警。
   */
  buildWritingStylePrompt(
    projectId: string,
    target: WritingStylePromptTarget,
  ): ReturnType<typeof compileWritingStylePrompt> | undefined {
    const profile = this.stores.getWritingStyleProfile?.(projectId)
    if (!profile) {
      console.warn(
        `[Novel] 文风档案未生效：projectId=${projectId} 未配置 writingStyleProfile。`
        + `writer/reviser/reviewer 将不带文风约束，请前往项目设置配置档案。`,
      )
      return undefined
    }
    if (
      (profile.positiveExamples?.length ?? 0) === 0
      && (profile.negativeExamples?.length ?? 0) === 0
    ) {
      console.warn(
        `[Novel] 文风档案样本为空：projectId=${projectId} positiveExamples 和 negativeExamples 均为空。`
        + `常见原因：前端编辑器过滤了长度 < 20 字符的样本（见 writing-style-profile-editor.tsx:392-397）。`
        + `档案已注入但缺乏正反样本引导，LLM 可能不严格遵循。`,
      )
    }
    return compileWritingStylePrompt(profile, target)
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
    const compact = (value: string, maxLength: number): string => {
      const normalized = value.trim()
      if (normalized.length <= maxLength) return normalized
      const headLength = Math.round(maxLength * 0.72)
      const tailLength = maxLength - headLength
      return `${normalized.slice(0, headLength)}\n\n[中段已压缩，按本章矩阵实体按需查询]\n\n${normalized.slice(-tailLength)}`
    }

    // ── 共享前缀（跨 Agent 相同，跨章不变，最大化 prompt cache 命中）──
    // 顺序：全书大纲 → 卷纲 → 世界规则 → 风格指南 → Agent 身份
    // 共享部分在前，Agent 专属部分在后，确保不同 Agent 的前缀相同可共享缓存。

    // ── Layer -1: 全书大纲 + 当前卷纲（项目级，跨 Agent 共享，跨章不变）──
    // 全书大纲让 Director 规划时不偏离主线走向，Writer 创作时知道故事全局方向。
    // 卷纲让 Director 和 Writer 明确当前卷的起承转合和核心冲突。
    const project = this.stores.getProject(projectId)
    if (project) {
      if (project.synopsis?.trim()) {
        parts.push(`## 故事简介\n\n${compact(project.synopsis, 2400)}`)
      }
      if (project.outline?.trim()) {
        parts.push(`## 全书大纲\n\n${compact(project.outline, 4000)}`)
      }
      // 注入当前卷纲 + 相邻卷纲摘要
      const volumes = this.stores.listVolumes(projectId)
      const currentVolNum = project.currentVolume
      const currentVol = volumes.find(v => v.volumeNumber === currentVolNum)
      const prevVol = volumes.find(v => v.volumeNumber === currentVolNum - 1)
      const nextVol = volumes.find(v => v.volumeNumber === currentVolNum + 1)

      // 前卷纲要回顾：让 Director/Writer 知道上一卷的收束情况，避免断裂
      if (prevVol?.outline?.trim()) {
        parts.push(`## 前卷回顾（第${prevVol.volumeNumber}卷《${prevVol.title}》）\n\n${compact(prevVol.outline, 1200)}`)
      }
      // 当前卷纲：Director 规划必须服务于此
      if (currentVol?.outline?.trim()) {
        parts.push(`## 当前卷纲（第${currentVol.volumeNumber}卷《${currentVol.title}》）\n\n${compact(currentVol.outline, 2400)}`)
      }
      // 下卷预告：让 Director 在卷末规划时能提前衔接下一卷方向
      if (nextVol?.outline?.trim()) {
        parts.push(`## 下卷方向（第${nextVol.volumeNumber}卷《${nextVol.title}》）\n\n${compact(nextVol.outline, 800)}`)
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
      ).slice(0, 40)
      parts.push(this.formatWorldRules(sorted))
    }

    // ── Layer 2: 风格指南（项目级，跨 Agent 共享，跨章不变）──
    // 双键排序：category + id（同上）
    const styleGuide = this.stores.listStyleGuide(projectId)
    if (styleGuide.length > 0) {
      const sorted = [...styleGuide].sort((a, b) =>
        a.category.localeCompare(b.category) || a.id.localeCompare(b.id),
      ).slice(0, 20)
      parts.push(this.formatStyleGuide(sorted))
    }

    // 势力、地点、世界要素不再整库塞入 STATIC 层。本章需要的实体由矩阵在
    // buildChapterContextShared 中注入；未编排实体可通过只读工具按需查询。

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
    // 写作铁律只注入给需要创作正文的 Agent（writer/reviser/reviewer/prose_editor）。
    // Director 只做规划不写正文，注入铁律浪费 token 且破坏缓存稳定性。
    // 修复（2026-07-18）：铁律从 system-base.md 拆分到 system-base-rules.md，
    // 按需注入，避免 Director/Memory 被铁律示范破折号污染。
    const needsWritingRules = agentType === 'writer'
      || agentType === 'reviser'
      || agentType === 'reviewer'
    let result = identity
    if (needsWritingRules) {
      const rules = this.promptManager.getTemplate('system-base-rules', projectId)
      if (rules) result = `${result}\n\n---\n\n${rules}`
    }
    if (agentType !== 'writer' && agentType !== 'reviser' && agentType !== 'reviewer') {
      return result
    }
    const compiledStyle = this.buildWritingStylePrompt(projectId, agentType)
    return compiledStyle ? `${result}\n\n---\n\n${compiledStyle.content}` : result
  }

  /** 盲审文字编辑身份：不携带章节规划，只保留文字职责和项目文风档案。 */
  buildProseEditorIdentity(projectId: string): string {
    const identity = this.promptManager.render('system-base', {
      agent_type: 'prose_editor',
      agent_role: this.promptManager.getTemplate('role-prose-editor', projectId),
    }, projectId)
    // prose_editor 也需要铁律
    const rules = this.promptManager.getTemplate('system-base-rules', projectId)
    const withRules = rules ? `${identity}\n\n---\n\n${rules}` : identity
    const compiledStyle = this.buildWritingStylePrompt(projectId, 'reviewer')
    return compiledStyle ? `${withRules}\n\n---\n\n${compiledStyle.content}` : withRules
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

    // ── 事件账本时间切片 ──
    // 生成中间章节时不能读取未来章节已经写入实体快照的结果。事件账本按当前章
    // 之前的最后一条原子变化重建章前状态，同时显式提供本章计划和未来承诺。
    if (this.memoryStore?.getChapterStoryContext) {
      const ledgerContext = this.memoryStore.getChapterStoryContext(projectId, chapterNumber)
      const ledgerSection = this.formatStoryLedgerContext(ledgerContext)
      if (ledgerSection) parts.push(ledgerSection)
    }

    // ── 实体关联（画布手动 + 派生自动边，作为故事状态的补充）──
    // C3 增强：通过 RelationshipGraph 拿到派生边（冲突参与/势力敌对/盟友/地点归属等 7 类），
    // 让 LLM 显式看到这些关系，无需从实体 description 自行推断。
    // 未注入 relationshipGraph 时降级到 stores.listEdges（仅手动边），保持向后兼容。
    const edges = arrangedEntities && relevantEntityIds.size === 0
      ? []
      : this.collectRelevantEdges(projectId, relevantEntityIds)
    if (edges.length > 0) {
      const edgeSection = this.formatEdges(projectId, edges)
      if (edgeSection) parts.push(edgeSection)
    }

    // ── 信息差 ──
    const infoLayers = this.filterRelevantInfoLayers(this.stores.listInformationLayers(projectId), arrangedEntities)
    if (infoLayers.length > 0) {
      parts.push(this.formatInfoLayers(projectId, infoLayers, arrangedEntities))
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
      // 有人工文风档案时不再从既有 AI 正文递归学习声音；旧项目未配置档案时
      // 才保留最近正文锚点作为兼容回退。
      if (!this.stores.getWritingStyleProfile?.(projectId)) {
        const soundAnchor = this.formatSoundAnchor(prevChapters.slice(-1))
        if (soundAnchor) parts.push(soundAnchor)
      }
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

    // ── 文风指纹（从前几章提取的文风基准，抗 compaction）──
    // 注入文风特征快照，让 Writer/Reviewer 在 context compaction 后仍能保持文风一致
    if (prevChapters.length > 0 && !this.stores.getWritingStyleProfile?.(projectId)) {
      const fingerprint = this.formatStyleFingerprint(prevChapters)
      if (fingerprint) parts.push(fingerprint)
    }

    // ── 待回收伏笔预警（超过 N 章未回收的伏笔标记为急需回收）──
    // C3 增强：若注入了 consistencyAuditor，formatUrgentForeshadows 会复用 audit 报告
    // 的 urgent/expired 字段，避免与 consistency-auditor.ts 的 auditForeshadow 重复计算
    const urgentForeshadows = this.formatUrgentForeshadows(projectId, chapterNumber, arrangedEntities)
    if (urgentForeshadows) parts.push(urgentForeshadows)

    // ── 跨章一致性审计摘要（C3 增强）──
    // 让 Writer/Reviewer 看到孤儿实体、悬挂钩子、时间线矛盾，引导在本章修复或回避。
    // 审计报告走 60s TTL 缓存（与 formatUrgentForeshadows 共享同一份 audit 结果）
    if (this.consistencyAuditor) {
      const report = this.getCachedAudit(projectId)
      if (report) {
        const auditSection = this.formatConsistencyAudit(report, arrangedEntities, chapterNumber)
        if (auditSection) parts.push(auditSection)
      }
    }

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
      const reviewerFeedback = this.formatReviewerFeedback(projectId, chapterNumber)
      if (reviewerFeedback) parts.push(reviewerFeedback)
    }

    // ── 平台 Rubric（仅 Reviewer 注入，按目标平台调整评分权重）──
    if (agentType === 'reviewer') {
      const platformRubric = this.formatPlatformRubric(projectId)
      if (platformRubric) parts.push(platformRubric)
      if (narrativeTask.description.trim()) {
        parts.push(`## 已批准的本章叙事任务\n\n${narrativeTask.description.trim()}`)
      }
      // 矩阵执行验收：Reviewer 专属，从共享层 formatArrangedEntities 移至此处。
      // 对 Director/Writer/Memory 注入"Reviewer 必须逐项核对"无意义且破坏缓存稳定性。
      // 修复（2026-07-18）。
      if (this.hasArrangedEntities(arrangedEntities)) {
        parts.push(
          '## 矩阵执行验收（Reviewer 专属）\n\n' +
          '正文必须让上述编排实体实际参与本章事件，不得只在叙述中点名；' +
          '角色必须完成其本章功能位，冲突/伏笔必须按标注的推进节点执行。' +
          '你必须逐项核对矩阵实体是否全部兑现，未兑现项必须在审稿报告中明确指出。',
        )
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
    const chapter = this.stores.getChapter(projectId, chapterNumber)
    // 占位符检测：narrativeTask.description 默认值为"待补充"，是章节创建时的占位符，
    // Director 应该在规划时通过 novel_submit_narrative_task 工具覆盖它。
    // 注入占位符会让 LLM 误以为任务类型真的未定，导致规划混乱。
    const isPlaceholderTask = (desc: string | undefined): boolean =>
      !desc || desc.trim() === '' || desc.trim() === '待补充' || desc.trim() === '待定'
    const taskTypeLine = isPlaceholderTask(task.description)
      ? '- 任务类型：待 Director 规划（见下方叙事任务）'
      : `- 任务类型：${task.description}`
    const lines = [
      `## 当前章节`,
      ``,
      `- 卷：第${volume}卷`,
      `- 章：第${chapterNumber}章`,
      taskTypeLine,
      `- 优先级：${task.priority}`,
    ]
    // 注入用户编写的章纲（outline）作为创作统一起点
    // 如果 outline 为空，回退使用 narrativeTask（保持向后兼容）
    const outline = chapter?.outline?.trim()
    if (outline) {
      lines.push(``, `### 章纲（用户编写 - 创作统一起点，必须严格遵循）`, ``, outline)
    } else if (!isPlaceholderTask(task.description)) {
      lines.push(``, `### 章纲`, ``, task.description!)
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
      // 已知弧光终态集合（来自 ARC_STAGE_MODELS 的各类型最后阶段 + 通用终态）
      // 仅当 arcStage 确实是终态时才显示"已完成弧光"，避免 allowedNextStage=null 时的误判
      const ARC_FINAL_STAGES = new Set([
        'transformation', 'point_of_no_return', 'redemption', 'new_framework',
        'resolution',
      ])
      for (const arc of constraints.characterArcs) {
        const stage = arc.character.arcStage
        const isFinalStage = ARC_FINAL_STAGES.has(stage)
        const next = arc.allowedNextStage
          ? `→ 下一步可达：${arc.allowedNextStage}`
          : isFinalStage
            ? '→ 已完成弧光'
            : '→ 阶段推进待定（无明确下一步，Director 可按剧情需要规划）'
        parts.push(`- ${arc.character.name}：当前阶段「${stage}」${next}`)
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
        // ── 071：推进粒度（让 Writer 知道冲突已推进到哪一步，本章应承接而非重头验证）──
        if (c.currentStep?.trim()) {
          segs.push(`当前进展：${c.currentStep.trim()}`)
        }
        if (c.nextStep?.trim()) {
          segs.push(`⚡ 本章应推进：${c.nextStep.trim()}`)
        }
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
          // ── 071：推进粒度（让 Writer 知道冲突已经推进到哪一步，避免反复验证同一个粗状态）──
          // 关键修复：原本只输出 stage（emerging/escalating/...），Writer 看不到"已出现图案"
          // 这类细粒度进展，导致每章都从头验证穴位是否存在。
          if (c.currentStep?.trim()) {
            parts.push(`当前进展：${c.currentStep.trim()}`)
          }
          if (c.nextStep?.trim()) {
            parts.push(`⚡ 本章下一步：${c.nextStep.trim()}`)
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
          // 关联关系已迁移至 novel_edges 表（foreshadow ↔ info_layer）
          const linkedInfoLayerIds = this.stores.listEdgesByEntity(f.id, { edgeType: 'related' })
            .filter(e => (e.sourceId === f.id && e.targetType === 'info_layer') || (e.targetId === f.id && e.sourceType === 'info_layer'))
            .map(e => e.sourceId === f.id ? e.targetId : e.sourceId)
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
    // ── 本章登场物品（含拥有者、状态、能力，让 Writer 知道谁能用什么、什么已损坏/封印）──
    if ((arranged.itemIds ?? []).length > 0) {
      const itemTypeLabel: Record<string, string> = {
        weapon: '武器',
        armor: '防具',
        artifact: '法宝',
        consumable: '消耗品',
        key: '关键道具',
        material: '材料',
        info: '情报物品',
        misc: '杂物',
      }
      const itemStatusLabel: Record<string, string> = {
        active: '可用',
        lost: '遗失',
        destroyed: '损毁',
        transformed: '已转化',
        sealed: '封印',
        transferred: '已易主',
      }
      const items = (arranged.itemIds ?? [])
        .map((id) => this.stores.getItem(id))
        .filter((it): it is NonNullable<typeof it> => it != null)
      if (items.length > 0) {
        // 用于把 ownerId 解析为角色名
        const allChars = this.stores.listCharacters(projectId)
        const charNameMap = new Map(allChars.map((c) => [c.id, c.name]))
        lines.push('本章登场物品（写作时必须遵守物品归属与状态约束）：')
        for (const it of items) {
          const parts = [`  - ${it.name}`]
          parts.push(`类型：${itemTypeLabel[it.type] ?? it.type}`)
          if (it.description) parts.push(it.description)
          if (it.ownerId) {
            const ownerName = charNameMap.get(it.ownerId) ?? it.ownerId
            parts.push(`持有者：${ownerName}`)
          } else {
            parts.push('持有者：无主')
          }
          parts.push(`状态：${itemStatusLabel[it.status] ?? it.status}`)
          if (it.abilities) parts.push(`能力/效果：${it.abilities}`)
          if (it.origin) parts.push(`来历：${it.origin}`)
          if (it.firstChapter != null) parts.push(`首次出现：第 ${it.firstChapter} 章`)
          lines.push(parts.join('；'))
        }
      }
    }
    if ((arranged.clueIds ?? []).length > 0) {
      const clues = (arranged.clueIds ?? [])
        .map((id) => this.stores.getClue(id))
        .filter((clue): clue is NonNullable<typeof clue> => clue != null)
      if (clues.length > 0) {
        lines.push('本章线索：')
        for (const clue of clues) {
          const parts = [`  - ${clue.description}`]
          if (clue.pointsTo) parts.push(`指向：${clue.pointsTo}`)
          parts.push(`进度：${clue.progress}%`)
          if (clue.currentStep) parts.push(`当前步骤：${clue.currentStep}`)
          if (clue.nextStep) parts.push(`⚡ 本章推进：${clue.nextStep}`)
          if (clue.isMisleading) parts.push('性质：误导线索，不得写成已证实事实')
          lines.push(parts.join('；'))
        }
      }
    }
    // 矩阵执行验收已移至 Reviewer 专属 suffix（2026-07-18），
    // 不再在共享层注入"Reviewer 必须逐项核对"以避免对 Director/Writer/Memory 的无效指令。
    return lines.join('\n')
  }

  private hasArrangedEntities(arranged?: ArrangedEntity): boolean {
    return !!arranged && (
      arranged.characterIds.length > 0
      || arranged.conflictIds.length > 0
      || arranged.foreshadowIds.length > 0
      || (arranged.clueIds ?? []).length > 0
      || arranged.factionIds.length > 0
      || arranged.locationIds.length > 0
      || (arranged.itemIds ?? []).length > 0
    )
  }

  private collectRelevantEntityIds(arranged?: ArrangedEntity): Set<string> {
    const ids = new Set<string>()
    if (!arranged) return ids
    for (const id of arranged.characterIds) ids.add(id)
    for (const id of arranged.conflictIds) ids.add(id)
    for (const id of arranged.foreshadowIds) ids.add(id)
    for (const id of arranged.clueIds ?? []) ids.add(id)
    for (const id of arranged.factionIds) ids.add(id)
    for (const id of arranged.locationIds) ids.add(id)
    for (const id of arranged.itemIds ?? []) ids.add(id)
    return ids
  }

  /**
   * 收集本章相关的边（含派生边，C3 增强）
   *
   * 数据源优先级：
   * 1. relationshipGraph 提供：调用 getAllGraphEdges，包含派生边（冲突参与/势力敌对
   *    /盟友/地点归属/世界要素层级等 7 类），让 LLM 显式看到这些关系
   * 2. 未提供：降级到 stores.listEdges（仅手动边），保持向后兼容
   *
   * 过滤策略：按 relevantEntityIds 筛选与本章编排实体相关的边，避免上下文爆炸
   */
  private collectRelevantEdges(projectId: string, relevantEntityIds: Set<string>): GraphEdge[] {
    const allEdges: GraphEdge[] = this.relationshipGraph
      ? this.relationshipGraph.getAllGraphEdges(projectId)
      : this.stores.listEdges(projectId).map((e) => ({
          id: e.id,
          sourceId: e.sourceId,
          sourceType: e.sourceType,
          targetId: e.targetId,
          targetType: e.targetType,
          edgeType: e.edgeType,
          label: e.label,
          auto: e.auto,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        }))
    return this.filterRelevantEdges(allEdges, relevantEntityIds)
  }

  private filterRelevantEdges<T extends { sourceId: string; targetId: string }>(
    edges: T[],
    relevantEntityIds: Set<string>,
  ): T[] {
    if (edges.length === 0) return []
    if (relevantEntityIds.size === 0) return edges.slice(0, 20)
    return edges
      .filter((e) => relevantEntityIds.has(e.sourceId) && relevantEntityIds.has(e.targetId))
      .slice(0, 20)
  }

  private filterRelevantInfoLayers(
    layers: NovelInformationLayer[],
    arranged?: ArrangedEntity,
  ): NovelInformationLayer[] {
    if (layers.length === 0) return []
    if (!arranged) {
      return layers
        .filter((layer) => !layer.isRevealed)
        .slice(0, 8)
    }

    const relevantForeshadowIds = new Set(arranged.foreshadowIds)
    const relevantCharacterIds = new Set(arranged.characterIds)
    const relevantInfoLayerIds = new Set<string>()
    for (const foreshadowId of relevantForeshadowIds) {
      const foreshadow = this.stores.getForeshadow(foreshadowId)
      if (!foreshadow) continue
      // 关联关系已迁移至 novel_edges 表
      const infoLayerIds = this.stores.listEdgesByEntity(foreshadow.id, { edgeType: 'related' })
        .filter(e => (e.sourceId === foreshadow.id && e.targetType === 'info_layer') || (e.targetId === foreshadow.id && e.sourceType === 'info_layer'))
        .map(e => e.sourceId === foreshadow.id ? e.targetId : e.sourceId)
      for (const infoLayerId of infoLayerIds) {
        relevantInfoLayerIds.add(infoLayerId)
      }
    }

    const relevant = layers.filter((layer) => {
      if (relevantInfoLayerIds.has(layer.id)) return true
      // 关联关系已迁移至 novel_edges 表
      const linked = this.stores.listEdgesByEntity(layer.id, { edgeType: 'related' })
        .filter(e => (e.sourceId === layer.id && e.targetType === 'foreshadow') || (e.targetId === layer.id && e.sourceType === 'foreshadow'))
        .map(e => e.sourceId === layer.id ? e.targetId : e.sourceId)
      if (linked.some((id) => relevantForeshadowIds.has(id))) return true
      if (relevantCharacterIds.size === 0 || !layer.characterKnowledge) return false
      try {
        const knowledge = JSON.parse(layer.characterKnowledge) as Record<string, unknown>
        return [...relevantCharacterIds].some((id) => Object.hasOwn(knowledge, id))
      } catch {
        return false
      }
    })
    return relevant.slice(0, 8)
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
    const hasArranged = arrangedEntities !== undefined
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

    // 编排角色拥有的物品（含丢失/封印，让 Writer 知道这角色"曾经有什么、现在能用什么"）
    // 设计意图：用户特别强调"主角 配角拥有的物品"是写作的核心约束。
    // 物品完整定义已在 formatArrangedEntities 的"本章登场物品"段输出（仅编排的 itemIds），
    // 这里补充输出"编排角色拥有、但本章未被编排出场"的物品状态，避免 Writer 让角色使用
    // 已丢失/已封印的物品，或凭空变出未交代的物品。
    const arrangedCharIdSet = arrangedEntities!.characterIds
    if (arrangedCharIdSet.length > 0 && state.items.length > 0) {
      const charIdToName = new Map(
        state.characters.filter((c) => arrangedCharIdSet.includes(c.id)).map((c) => [c.id, c.name]),
      )
      const ownerToItems = new Map<string, typeof state.items>()
      for (const it of state.items) {
        if (!it.ownerId || !charIdToName.has(it.ownerId)) continue
        const list = ownerToItems.get(it.ownerId) ?? []
        list.push(it)
        ownerToItems.set(it.ownerId, list)
      }
      if (ownerToItems.size > 0) {
        const itemStatusLabel: Record<string, string> = {
          active: '可用',
          lost: '遗失',
          destroyed: '损毁',
          transformed: '已转化',
          sealed: '封印',
          transferred: '已易主',
        }
        parts.push('\n### 编排角色拥有物品')
        for (const [ownerId, items] of ownerToItems) {
          const ownerName = charIdToName.get(ownerId) ?? ownerId
          const itemDescs = items
            .slice(0, 8)
            .map((it) => `${it.name}（${itemStatusLabel[it.status] ?? it.status}${it.type ? `·${it.type}` : ''}）`)
          parts.push(`- **${ownerName}**：${itemDescs.join('、')}`)
        }
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

    // 物品归属（按持有者分组，让 Writer 知道每个角色拥有什么）
    const realItems = state.items.filter((i) => !isPlaceholder(i.name)).slice(0, 16)
    if (realItems.length > 0) {
      const charNameMap = new Map(state.characters.map((c) => [c.id, c.name]))
      const itemStatusLabel: Record<string, string> = {
        active: '可用',
        lost: '遗失',
        destroyed: '损毁',
        transformed: '已转化',
        sealed: '封印',
        transferred: '已易主',
      }
      const ownerToItems = new Map<string, typeof realItems>()
      const orphanItems: typeof realItems = []
      for (const it of realItems) {
        if (it.ownerId) {
          const list = ownerToItems.get(it.ownerId) ?? []
          list.push(it)
          ownerToItems.set(it.ownerId, list)
        } else {
          orphanItems.push(it)
        }
      }
      parts.push('\n### 物品归属')
      for (const [ownerId, items] of ownerToItems) {
        const ownerName = charNameMap.get(ownerId) ?? ownerId
        const itemDescs = items
          .map((it) => `${it.name}（${itemStatusLabel[it.status] ?? it.status}${it.type ? `·${it.type}` : ''}）`)
        parts.push(`- **${ownerName}**：${itemDescs.join('、')}`)
      }
      if (orphanItems.length > 0) {
        const orphanDescs = orphanItems
          .map((it) => `${it.name}（${itemStatusLabel[it.status] ?? it.status}）`)
        parts.push(`- **无主**：${orphanDescs.join('、')}`)
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
  private formatInfoLayers(
    projectId: string,
    layers: NovelInformationLayer[],
    arranged?: ArrangedEntity,
  ): string {
    const parts: string[] = ['## 信息差']
    const allowedCharacterIds = arranged ? new Set(arranged.characterIds) : null
    const allowedForeshadowIds = arranged ? new Set(arranged.foreshadowIds) : null
    for (const layer of layers) {
      const readerStatus = layer.readerKnows ? '读者已知' : '读者未知'
      const revealStatus = layer.isRevealed ? '已揭露' : `计划揭露：${layer.revealStage ?? '未定'}`
      const head = `- ${layer.infoDescription}（${readerStatus}，${revealStatus}）`
      const details: string[] = []
      if (layer.characterKnowledge) {
        try {
          const knowledge = JSON.parse(layer.characterKnowledge) as Record<string, unknown>
          for (const [characterId, raw] of Object.entries(knowledge)) {
            if (allowedCharacterIds && !allowedCharacterIds.has(characterId)) continue
            const character = this.stores.getCharacter(characterId)
            if (!character || typeof raw !== 'object' || raw === null) continue
            const item = raw as { knows?: boolean; suspects?: boolean; misunderstands?: string }
            const states: string[] = []
            if (item.knows) states.push('知道')
            else if (item.suspects) states.push('怀疑')
            else states.push('不知道')
            if (item.misunderstands) states.push(`误解：${item.misunderstands}`)
            details.push(`  - ${character.name}：${states.join('；')}`)
          }
        } catch {
          // 兼容旧数据：非法 JSON 不阻断提示词构建。
        }
      }
      // ── P3-2：解析 linkedForeshadows 反向展示关联伏笔 ──
      // 让 Agent 知道本信息差由哪些伏笔承载，写作时协同回收时机
      // 关联关系已迁移至 novel_edges 表（info_layer ↔ foreshadow）
      const linkedIds = this.stores.listEdgesByEntity(layer.id, { edgeType: 'related' })
        .filter(e => (e.sourceId === layer.id && e.targetType === 'foreshadow') || (e.targetId === layer.id && e.sourceType === 'foreshadow'))
        .map(e => e.sourceId === layer.id ? e.targetId : e.sourceId)
        .filter((id) => !allowedForeshadowIds || allowedForeshadowIds.has(id))
      if (linkedIds.length > 0) {
        const linkedDescs: string[] = []
        for (const fid of linkedIds) {
          const f = this.stores.getForeshadow(fid)
          if (f) {
            linkedDescs.push(`${f.description}（${f.status}）`)
          }
        }
        if (linkedDescs.length > 0) {
          parts.push([head, ...details, `  - 承载伏笔：${linkedDescs.join('；')}`].join('\n'))
          continue
        }
      }
      parts.push([head, ...details].join('\n'))
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
   * 格式化实体关联（画布手动 + 派生自动边）
   *
   * 将画布上的手动 + 自动边格式化为可读文本，让 Agent 能感知
   * 用户在画布上建立的角色出场、势力归属、地点场景等关联关系，
   * 以及从实体 JSON 字段派生的冲突参与、势力敌对/盟友、地点层级等关系。
   *
   * C3 增强：edges 类型从 NovelEdge 改为 GraphEdge，以兼容派生边
   * （派生边的 fromRelationship/relationship 字段在 formatEdges 中不访问）
   */
  private formatEdges(projectId: string, edges: GraphEdge[]): string {
    const nameMap = this.buildEntityNameMap(projectId)
    // 过滤 involvement 派生边：冲突参与方信息已在 formatArrangedEntities 的"本章冲突"
    // "参与方"字段中体现，重复注入会浪费 token 且无新信息。
    // 仅过滤自动派生边（auto=true），保留手动边（用户明确标注的 involvement）。
    // 修复（2026-07-18）。
    const filteredEdges = edges.filter(
      (e) => !(e.auto && e.edgeType === 'involvement'),
    )
    if (filteredEdges.length === 0) return ''
    const lines = filteredEdges.map((e) => {
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
   * 格式化 Reviewer 反馈摘要：最近 3 章已审稿章节的 Reviewer 结论和关键问题。
   *
   * 设计意图：
   * - 如果 Reviewer 连续多章发现同类问题，Director 应该知道并改进规划
   * - 提取 Reviewer 日志中的结论（accept/revise/reject）和问题摘要
   *
   * 修复（2026-07-18）：
   * - 原实现按 created_at DESC 返回最近 20 条 reviewer 日志，未按 chapterNumber 过滤，
   *   导致 Director 规划第 10 章时可能拿到第 10 章本身的重试日志（status=success 但
   *   result 解析失败 → 显示"第10章审稿结论：unknown × 3"）。
   * - 修复：只取 chapterNumber < currentChapterNumber 的日志，按章节号去重（同章节
   *   多次重试只保留最新一条），按章节号降序取最近 3 章。
   * - 正则解析增强：兼容 JSON 格式（reviewerV2/PostWriteGuard 输出的结构化结果）。
   *
   * @param projectId 项目 ID
   * @param currentChapterNumber 当前正在创作的章节号（仅展示此章之前的已审稿章节）
   */
  private formatReviewerFeedback(projectId: string, currentChapterNumber: number): string {
    if (!this.stores.listAgentLogsByProject) return ''
    const logs = this.stores.listAgentLogsByProject(projectId, 50)
    // 筛选 Reviewer 日志：只看当前章之前的已审稿章节，避免拿到当前章的重试日志
    const reviewerLogs = logs
      .filter(l => l.agentType === 'reviewer'
        && l.status === 'success'
        && l.chapterNumber < currentChapterNumber,
      )
      // 同章节多次重试只保留最新一条（按 createdAt 降序后去重）
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .filter((log, index, arr) =>
        arr.findIndex((x) => x.chapterNumber === log.chapterNumber) === index,
      )
      .sort((a, b) => b.chapterNumber - a.chapterNumber)
      .slice(0, 3)
    if (reviewerLogs.length === 0) return ''

    const lines = ['## 最近审稿反馈（改进规划参考）', '']
    for (const log of reviewerLogs) {
      const verdict = this.extractReviewerVerdict(log.result)
      const issues = this.extractReviewerIssues(log.result)
      lines.push(`- 第${log.chapterNumber}章审稿结论：${verdict}`)
      if (issues.length > 0) {
        lines.push(`  关键反馈：${issues.join('；')}`)
      }
    }
    return lines.join('\n')
  }

  /**
   * 从 Reviewer 日志 result 字段提取审稿结论。
   *
   * 兼容多种格式：
   * - 自然语言：包含"结论：accept"/"审稿结论: revise"等
   * - JSON 结构化：reviewerV2/PostWriteGuard 输出的 {"verdict": "accept", ...}
   * - 包含中文结论词：通过/需修订/拒绝
   */
  private extractReviewerVerdict(result: string | null | undefined): string {
    if (!result) return 'unknown'
    const text = result.slice(0, 500)
    // 1. 英文关键词（accept/revise/reject）
    const enMatch = text.match(/(?:结论|verdict|conclusion)[:：]\s*(accept|revise|reject)/i)
    if (enMatch) return enMatch[1].toLowerCase()
    // 2. JSON 结构化字段
    const jsonMatch = text.match(/"verdict"\s*:\s*"(accept|revise|reject)"/i)
    if (jsonMatch) return jsonMatch[1].toLowerCase()
    // 3. 中文关键词
    if (/通过|accept/i.test(text)) return 'accept'
    if (/需?修订|需?修改|revise/i.test(text)) return 'revise'
    if (/拒绝|驳回|reject/i.test(text)) return 'reject'
    return 'unknown'
  }

  /**
   * 从 Reviewer 日志 result 字段提取关键问题/建议。
   *
   * 匹配包含"问题""建议""扣分"等关键词的行，最多 3 条。
   */
  private extractReviewerIssues(result: string | null | undefined): string[] {
    if (!result) return []
    const text = result.slice(0, 800)
    return text
      .split('\n')
      .filter(l => /问题|建议|扣分|不足|缺陷|漏洞/.test(l))
      .map(l => l.trim().replace(/^[-•*]\s*/, ''))
      .filter(l => l.length > 0 && l.length < 200)
      .slice(0, 3)
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
   * 把事件账本的时间切片转换成 Writer/Director 可执行的约束。
   * 数值维度同时输出行为语义，避免模型只看到没有文学含义的裸分数。
   */
  private formatStoryLedgerContext(context: ChapterStoryContext): string {
    const displayValue = (value: unknown): string => {
      if (typeof value === 'string') return value || '（空）'
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }

    const sections: string[] = [`## 第${context.chapterNumber}章事件账本（章前时间切片）`]

    if (context.stateBeforeChapter.length > 0) {
      const stateLines = context.stateBeforeChapter.slice(0, 80).map((state) => {
        const target = state.targetId ? ` → ${state.targetType}:${state.targetId}` : ''
        return `- 第${state.effectiveChapter}章生效 · ${state.subjectType}:${state.subjectId}${target} · ${state.dimension} = ${displayValue(state.value)}（${state.reason || '无原因说明'}）`
      })
      sections.push(`### 章前已成立状态\n${stateLines.join('\n')}`)
    }

    if (context.activeThreads.length > 0) {
      sections.push(`### 跨章节复合事件\n${context.activeThreads
        .slice(0, 20)
        .map((event) => `- ${event.title}：${event.summary || '持续推进中'}`)
        .join('\n')}`)
    }

    if (context.plannedEvents.length > 0 || context.plannedChanges.length > 0) {
      const eventLines = context.plannedEvents.map((event) => `- ${event.title}：${event.summary || event.outcome || '待完成'}`)
      const changeLines = context.plannedChanges.slice(0, 50).map((change) => {
        const base = `- 计划变化 · ${change.subjectType}:${change.subjectId} · ${change.dimension}：${displayValue(change.beforeValue)} → ${displayValue(change.afterValue)}（${change.reason || '待补充原因'}）`
        // 文风挂接（设计文档第 8 节）：变化级 styleNote 优先，无则 fallback 到维度模板（behaviorGuide）
        return change.styleNote ? `${base} ｜ 文风：${change.styleNote}` : base
      })
      sections.push(`### 本章计划\n${[...eventLines, ...changeLines].join('\n')}`)
    }

    if (context.futureCommitments.length > 0) {
      sections.push(`### 后续承诺与禁止提前发生的结果\n${context.futureCommitments
        .slice(0, 20)
        .map(({ event, changes }) => {
          const changeText = changes.length > 0
            ? `；变化：${changes.slice(0, 3).map((change) => `${change.dimension} → ${displayValue(change.afterValue)}`).join('、')}`
            : ''
          return `- 第${event.chapterNumber}章计划：${event.title}${changeText}`
        })
        .join('\n')}`)
    }

    if (context.promptDimensions.length > 0) {
      sections.push(`### 数值状态的行为语义\n${context.promptDimensions
        .map((dimension) => {
          const allowed = dimension.allowedThisChapter.length > 0 ? `；允许：${dimension.allowedThisChapter.join('、')}` : ''
          const forbidden = dimension.forbiddenThisChapter.length > 0 ? `；禁止：${dimension.forbiddenThisChapter.join('、')}` : ''
          return `- ${dimension.dimension}：${dimension.numericValue}/100（${dimension.levelLabel}，${dimension.trend}）${dimension.behaviorGuide} 原因：${dimension.changeReason || '未说明'}${allowed}${forbidden}`
        })
        .join('\n')}`)
    }

    const promptAnnotations = context.annotations.filter((annotation) => annotation.includeInPrompt)
    if (promptAnnotations.length > 0) {
      sections.push(`### 作者明确提供给本章的批注\n${promptAnnotations
        .slice(0, 30)
        .map((annotation) => `- [${annotation.kind}] ${annotation.content}`)
        .join('\n')}`)
    }

    if (context.unresolvedDebts.length > 0) {
      sections.push(`### 未解决的变化债务\n${context.unresolvedDebts
        .slice(0, 30)
        .map((change) => {
          const base = `- ${change.subjectType}:${change.subjectId} · ${change.dimension}：${displayValue(change.afterValue)}`
          return change.styleNote ? `${base} ｜ 文风：${change.styleNote}` : base
        })
        .join('\n')}`)
    }

    if (context.continuityWarnings.length > 0) {
      sections.push(`### 连续性警告\n${context.continuityWarnings.map((warning) => `- ${warning}`).join('\n')}`)
    }

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
      clue_change: '线索变更',
      faction_change: '势力变更',
      location_change: '地点变更',
      relationship_change: '关系变更',
      info_layer_change: '信息差变更',
      item_change: '物品变更',
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
            items?: NovelItem[]
          }
          const conflicts = data.conflicts ?? []
          const foreshadowing = data.foreshadowing ?? []
          const factions = data.factions ?? []
          const locations = data.locations ?? []
          const items = data.items ?? []
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
            // 物品：旧快照缺少 items 时保持空数组，绝不倒灌未来物品。
            items: items.filter(i => i.status !== 'destroyed'),
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
      items: this.stores.listItems(projectId).filter((i) => i.status !== 'destroyed'),
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
   *
   * C3 增强：若注入了 consistencyAuditor，优先复用 audit 报告的 urgent/expired 字段，
   * 避免与 consistency-auditor.ts 的 auditForeshadow 重复计算（相同阈值在两处独立维护）。
   * 未注入时走原本地计算逻辑，保持向后兼容（测试代码不注入 auditor）。
   */
  private formatUrgentForeshadows(
    projectId: string,
    chapterNumber: number,
    arranged?: ArrangedEntity,
  ): string {
    const selectedIds = arranged ? new Set(arranged.foreshadowIds) : null

    // ── C3 优先路径：复用 ConsistencyAuditor.audit() 的 urgent/expired ──
    if (this.consistencyAuditor) {
      const report = this.getCachedAudit(projectId)
      if (report) {
        const toRender = (u: { id: string; description: string; gap: number; firstChapter: number | null }, level: string) => ({
          id: u.id,
          desc: u.description,
          plantedAt: u.firstChapter ?? 0,
          gap: u.gap,
          level,
        })
        const expired = report.foreshadow.expired
          .filter((u) => !selectedIds || selectedIds.has(u.id))
          .slice(0, 10)
          .map((u) => toRender(u, '即将过期'))
        const urgent = report.foreshadow.urgent
          .filter((u) => !selectedIds || selectedIds.has(u.id))
          .slice(0, 10)
          .map((u) => toRender(u, '急需回收'))
        if (expired.length === 0 && urgent.length === 0) return ''
        return this.renderUrgentForeshadows(urgent, expired)
      }
    }

    // ── 降级路径：未注入 auditor 时走原本地计算（保持测试兼容）──
    const foreshadows = this.stores.listForeshadowing(projectId)
      .filter((foreshadow) => !selectedIds || selectedIds.has(foreshadow.id))
    const pending = foreshadows.filter(f => f.status !== 'recovered' && f.status !== 'abandoned')

    if (pending.length === 0) return ''

    const urgent: Array<{ id: string; desc: string; plantedAt: number; gap: number; level: string }> = []
    const expired: Array<{ id: string; desc: string; plantedAt: number; gap: number; level: string }> = []
    for (const f of pending) {
      // 获取伏笔埋设章号
      const plantedAt = f.firstChapter || 0
      if (plantedAt <= 0) continue
      const gap = chapterNumber - plantedAt
      if (gap >= 50) {
        expired.push({ id: f.id, desc: f.description, plantedAt, gap, level: '即将过期' })
      } else if (gap >= 20) {
        urgent.push({ id: f.id, desc: f.description, plantedAt, gap, level: '急需回收' })
      }
    }

    if (urgent.length === 0 && expired.length === 0) return ''
    return this.renderUrgentForeshadows(urgent, expired)
  }

  /**
   * 渲染伏笔预警文本（被 formatUrgentForeshadows 的两个分支复用）
   *
   * expired 排在 urgent 之前，更严重的问题优先呈现给 LLM
   */
  private renderUrgentForeshadows(
    urgent: Array<{ id: string; desc: string; plantedAt: number; gap: number; level: string }>,
    expired: Array<{ id: string; desc: string; plantedAt: number; gap: number; level: string }>,
  ): string {
    const lines: string[] = [
      '## 待回收伏笔预警',
      '',
      '以下伏笔已埋设较久，需考虑在本章或近几章回收：',
      '',
    ]
    for (const u of expired) {
      lines.push(`- **[${u.level}]** ${u.desc}（第${u.plantedAt}章埋设，已隔 ${u.gap} 章）`)
    }
    for (const u of urgent) {
      lines.push(`- **[${u.level}]** ${u.desc}（第${u.plantedAt}章埋设，已隔 ${u.gap} 章）`)
    }
    lines.push('')
    lines.push('⚠️ 超过 50 章未回收的伏笔读者可能已遗忘，需评估是否废弃或重新强化提醒。')

    return lines.join('\n')
  }

  /**
   * 获取审计报告（带 60s TTL 缓存，C3 增强）
   *
   * 同一章 4 个 Agent（Director/Writer/Reviewer/Memory）会分别调用 buildChapterContextShared，
   * 每次都跑 ConsistencyAuditor.audit 会浪费几十 ms（要遍历所有章节和角色历史）。
   * 缓存让同章内复用结果，60s TTL 覆盖单章生成周期，重生成场景自然失效。
   *
   * 失效条件：
   * - 60s TTL 过期（覆盖单章 4 agent 调用周期）
   * - 项目切换（不同 projectId 自然走不同缓存项）
   */
  private getCachedAudit(projectId: string): ConsistencyReport | null {
    if (!this.consistencyAuditor) return null
    const cached = this.auditCache.get(projectId)
    const now = Date.now()
    if (cached && now - cached.timestamp < NovelPromptBuilder.AUDIT_CACHE_TTL_MS) {
      return cached.report
    }
    const report = this.consistencyAuditor.audit(projectId)
    this.auditCache.set(projectId, { timestamp: now, report })
    return report
  }

  /**
   * 格式化跨章一致性审计摘要（C3 增强）
   *
   * 让 Writer/Reviewer 看到孤儿实体、悬挂钩子、时间线矛盾，引导在本章修复或回避。
   * 输出刻意精简（每类最多 5 条），避免上下文膨胀；详细审计报告走前端审计面板查看。
   *
   * 修复（2026-07-18）：孤儿实体按本章 arrangedEntities 交叉过滤。
   * - 原实现输出全部历史孤儿，对"本章已编排"的实体也提示"必须在正文中显式出现其名字"，
   *   这是多余的（本章已编排，Writer 自然会用到）。
   * - 修复：若 arrangedEntities 存在且本章编排了该实体（如角色 ID 在 characterIds 中），
   *   仍保留展示（提醒 Writer 在正文显式点名），但不再追加"若本章编排了上述实体..."的全局警告；
   *   对未在本章编排的历史孤儿才追加"若本章编排了..."的提醒。
   * - 同时按 chapterNumber 过滤：只展示缺失章节号 < 当前章号的孤儿（当前章及之后的
   *   缺失对未来章节才有意义）。
   */
  private formatConsistencyAudit(
    report: ConsistencyReport,
    arrangedEntities?: ArrangedEntity,
    currentChapterNumber?: number,
  ): string {
    const parts: string[] = [`## 跨章一致性审计（健康度 ${report.healthScore}/100）`]

    // 构建本章编排实体的名称集合（用于过滤"本章已编排"的孤儿）
    const arrangedCharIds = new Set(arrangedEntities?.characterIds ?? [])
    const arrangedFactionIds = new Set(arrangedEntities?.factionIds ?? [])
    const arrangedLocationIds = new Set(arrangedEntities?.locationIds ?? [])

    // 孤儿实体：编排了但正文未出现名字
    // 过滤逻辑：只展示历史孤儿（missingChapters 全部 < currentChapterNumber），
    // 对"本章已编排"的实体单独标记"本章已编排，须在正文点名"
    const filterMissingChapters = (missing: number[]): number[] => {
      if (currentChapterNumber === undefined) return missing
      return missing.filter((ch) => ch < currentChapterNumber)
    }

    const orphanChars = report.orphanEntities.characters
      .map((c) => ({ ...c, missingChapters: filterMissingChapters(c.missingChapters) }))
      .filter((c) => c.missingChapters.length > 0)
    const orphanFactions = report.orphanEntities.factions
      .map((f) => ({ ...f, missingChapters: filterMissingChapters(f.missingChapters) }))
      .filter((f) => f.missingChapters.length > 0)
    const orphanLocations = report.orphanEntities.locations
      .map((l) => ({ ...l, missingChapters: filterMissingChapters(l.missingChapters) }))
      .filter((l) => l.missingChapters.length > 0)
    const orphanCount = orphanChars.length + orphanFactions.length + orphanLocations.length

    if (orphanCount > 0) {
      parts.push('')
      parts.push(`### 孤儿实体（编排了但正文未出现名字，共 ${orphanCount} 个）`)
      const charList = orphanChars.slice(0, 5)
      if (charList.length > 0) {
        for (const c of charList) {
          const missing = c.missingChapters.slice(0, 3).join(', ')
          const more = c.missingChapters.length > 3 ? `等 ${c.missingChapters.length} 章` : ''
          const arrangedHere = arrangedCharIds.has(c.id) ? '【本章已编排，须在正文点名】' : ''
          parts.push(`- 角色 ${c.name}：缺章 ${missing}${more}${arrangedHere}`)
        }
      }
      const factionList = orphanFactions.slice(0, 3)
      if (factionList.length > 0) {
        const labels = factionList.map((f) => {
          const arrangedHere = arrangedFactionIds.has(f.id) ? '【本章已编排，须在正文点名】' : ''
          return `${f.name}${arrangedHere}`
        })
        parts.push('- 势力：' + labels.join('、'))
      }
      const locList = orphanLocations.slice(0, 3)
      if (locList.length > 0) {
        const labels = locList.map((l) => {
          const arrangedHere = arrangedLocationIds.has(l.id) ? '【本章已编排，须在正文点名】' : ''
          return `${l.name}${arrangedHere}`
        })
        parts.push('- 地点：' + labels.join('、'))
      }
      // 仅对"本章未编排但历史缺失"的孤儿追加全局提醒（本章已编排的已单独标记）
      const hasUnarrangedOrphans = orphanChars.some((c) => !arrangedCharIds.has(c.id))
        || orphanFactions.some((f) => !arrangedFactionIds.has(f.id))
        || orphanLocations.some((l) => !arrangedLocationIds.has(l.id))
      if (hasUnarrangedOrphans) {
        parts.push('⚠️ 若本章编排了上述未标记的实体，必须在正文中显式出现其名字。')
      }
    }

    // 悬挂钩子
    if (report.hooks.hanging.length > 0) {
      parts.push('')
      parts.push(`### 悬挂钩子（已抛出但跨章未兑现，共 ${report.hooks.hanging.length} 个）`)
      for (const h of report.hooks.hanging.slice(0, 5)) {
        parts.push(`- [${h.hookType}] ${h.description}（第${h.thrownAt}章抛出，已隔 ${h.gap} 章）`)
      }
      if (report.hooks.hanging.length > 5) {
        parts.push(`- ... 另有 ${report.hooks.hanging.length - 5} 个悬挂钩子`)
      }
    }

    // 时间线矛盾
    if (!report.timeline.monotonic) {
      parts.push('')
      parts.push(`### 时间线矛盾（共 ${report.timeline.violations.length} 处非单调递增）`)
      for (const v of report.timeline.violations.slice(0, 3)) {
        parts.push(`- 第${v.previousChapter}章 offset=${v.previousOffset} → 第${v.chapter}章 offset=${v.timeOffset}（应递增）`)
      }
      // 引导 Director 修正本章 timelineOffset
      if (currentChapterNumber !== undefined) {
        const relevantViolation = report.timeline.violations.find((v) => v.chapter === currentChapterNumber)
        if (relevantViolation) {
          parts.push(`⚠️ 当前第 ${currentChapterNumber} 章时间线与第 ${relevantViolation.previousChapter} 章矛盾。`)
          parts.push(`   Director 应将本章 timelineOffset.days 设为 ≥ ${relevantViolation.previousOffset + 1}，修复非单调递增。`)
        }
      }
    }

    // 健康度低时给出总体提示
    if (report.healthScore < 60) {
      parts.push('')
      parts.push(`⚠️ 项目一致性健康度偏低（${report.healthScore}/100），本章创作时优先考虑修复上述问题。`)
    }

    return parts.length > 1 ? parts.join('\n') : ''
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
