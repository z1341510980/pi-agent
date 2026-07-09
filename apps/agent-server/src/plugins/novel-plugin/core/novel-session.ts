/**
 * 小说创作 Session 集成
 *
 * 将 NovelPromptBuilder + NovelStore + novel-tools 与 Pi SDK 集成。
 *
 * ── 缓存优化的 Session 创建流程 ──
 *
 * 1. 创建 Session（systemPromptOverride 只调用一次）
 *    └── systemPromptOverride → NovelPromptBuilder.buildSystemPrompt()
 *        └── 返回 STATIC 层：世界规则 + 风格 + Agent 身份（不含角色定义）
 *        └── 此结果在整个 Session 生命周期内不变 → 跨章节缓存命中
 *
 * 2. 发送章节上下文作为首条 user 消息
 *    └── NovelPromptBuilder.buildChapterContextShared() + buildChapterContextSuffix()
 *        └── 返回 SEMI 层：shared（跨 Agent 一致）+ suffix（Agent 专属）
 *        └── shared 在单章生成期间不变 → 跨 Agent 缓存命中
 *
 * 3. 注入 novel-tools（customTools）
 *    └── 读工具：查询 DB 最新状态，结果追加到对话末尾（DYNAMIC）
 *    └── 写工具：更新 DB，确认信息追加到对话末尾（DYNAMIC）
 *    └── 工具调用不修改系统提示词和章节上下文 → 前缀缓存命中
 *
 * 4. LLM 生成章节内容
 *    └── 生成过程中可能调用工具查询/更新状态
 *    └── 每次 LLM 调用，前缀（系统提示词 + 章节上下文）命中缓存
 *    └── 只有 DYNAMIC 部分（工具调用 + 生成内容）需要重新计算
 *
 * 5. 章节完成后
 *    └── 保存章节内容到 DB
 *    └── 状态更新已在工具调用中完成
 *    └── 下一章创建新 Session → 新系统提示词（含最新静态数据）+ 新章节上下文
 */

import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { NovelStore } from './novel-store.js'
import { PromptManager } from './prompt-manager.js'
import { NovelPromptBuilder } from './prompt-builder.js'
import { createNovelTools } from './novel-tools.js'
import type { NarrativeTask, ChapterConstraints } from './types.js'

export interface NovelSessionConfig {
  projectId: string
  agentType: string // writer / director / reviewer / ...
  chapterNumber: number
  narrativeTask: NarrativeTask
  constraints: ChapterConstraints
}

/**
 * 创建小说创作所需的依赖
 *
 * 在插件初始化时调用一次，创建共享的 Store/PromptManager/PromptBuilder 实例。
 */
export class NovelSessionFactory {
  readonly store: NovelStore
  readonly promptManager: PromptManager
  readonly promptBuilder: NovelPromptBuilder
  private readonly novelTools: ToolDefinition[]

  /**
   * 构造函数接收外部传入的 store 和 promptManager，避免重复实例化。
   *
   * ⚠️ 必须传入与 novel.plugin.ts 中创建的相同实例，
   * 否则会导致内存缓存不一致。
   */
  constructor(store: NovelStore, promptManager: PromptManager) {
    this.store = store
    this.promptManager = promptManager
    this.promptBuilder = new NovelPromptBuilder(promptManager, store)
    this.novelTools = createNovelTools(store)
  }

  /**
   * 构建系统提示词（供 Pi SDK 的 systemPromptOverride 使用）
   *
   * ⚠️ 此方法只读取静态数据，在 Session 生命周期内返回相同结果。
   * 这确保 LLM 提供商的 prompt cache 能跨章节命中。
   */
  buildSystemPrompt(config: NovelSessionConfig): string {
    return this.promptBuilder.buildSystemPrompt(config.projectId, config.agentType)
  }

  /**
   * 构建章节上下文（shared + suffix 拼接，用于 engine.ts 约束构建副作用预触发）
   *
   * ⚠️ 此方法在章节生成开始时调用一次，生成的内容在单章内不变。
   * 这确保单章内的后续 LLM 调用能命中此前缀缓存。
   */
  buildChapterContext(config: NovelSessionConfig): string {
    const shared = this.promptBuilder.buildChapterContextShared(
      config.projectId,
      config.chapterNumber,
      config.narrativeTask,
      config.constraints,
      undefined,
    )
    const suffix = this.promptBuilder.buildChapterContextSuffix(
      config.projectId,
      config.chapterNumber,
      config.narrativeTask,
      config.constraints,
      undefined,
      config.agentType,
    )
    return suffix ? `${shared}\n\n---\n\n${suffix}` : shared
  }

  /**
   * 获取小说工具列表（供 Pi SDK 的 customTools 使用）
   *
   * 工具结果追加到对话末尾，不破坏前缀缓存。
   */
  getNovelTools(): ToolDefinition[] {
    return this.novelTools
  }

  /**
   * 计算并记录系统提示词哈希（用于诊断缓存命中）
   *
   * 在 Session 创建时调用，对比跨章节的哈希值可判断系统提示词是否稳定
   * （稳定 → LLM 提供商的 prompt cache 能跨章节命中）。
   */
  logSystemPromptHash(projectId: string, agentType: string): string {
    const hash = this.promptBuilder.getSystemPromptHash(projectId, agentType)
    console.log(`[Novel] SystemPrompt hash for ${agentType}: ${hash} (projectId=${projectId})`)
    return hash
  }

  /**
   * 计算并记录章节上下文哈希（用于诊断缓存命中）
   *
   * 在章节生成开始时调用，对比单章内多次 LLM 调用的哈希值可判断章节上下文是否稳定
   * （稳定 → 单章内 prompt cache 命中）。
   */
  logChapterContextHash(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
    constraints: ChapterConstraints,
  ): string {
    const hash = this.promptBuilder.getChapterContextHash(
      projectId,
      chapterNumber,
      narrativeTask,
      constraints,
    )
    console.log(`[Novel] ChapterContext hash: ${hash} (chapter=${chapterNumber})`)
    return hash
  }
}
