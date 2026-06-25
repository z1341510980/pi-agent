/**
 * NovelEngine：小说创作核心引擎
 *
 * 编排章节创作流程，集成 Pi SDK 进行 LLM 调用。
 *
 * ── 章节创作流程 ──
 *
 * 1. Director：分析故事状态 → 生成叙事任务和约束
 * 2. Writer：根据任务和约束 → 创作章节正文
 * 3. Reviewer：检查章节 → 生成验收报告
 * 4. Reviser（可选）：根据审稿问题 → 重写局部
 * 5. Memory：从章节中提取状态变更 → 更新故事状态系统
 *
 * ── 缓存优化策略 ──
 *
 * 每个 Agent 使用独立的 Session：
 * - 系统提示词（STATIC）在 Session 创建时固定，跨章节缓存命中
 * - 章节上下文（SEMI）作为首条消息发送，单章内缓存命中
 * - 工具调用结果（DYNAMIC）追加到对话末尾，不破坏前缀缓存
 *
 * 同一个 Agent 在同一章节内的多次调用（如 Writer 生成 + Reviser 修订）
 * 可以复用 Session，因为系统提示词和章节上下文不变。
 */

import { randomUUID } from 'node:crypto'
import type { NovelStore } from './novel-store.js'
import type { NovelSessionFactory } from './novel-session.js'
import type {
  NovelProject,
  NovelChapter,
  NarrativeTask,
  ChapterConstraints,
  NovelChapterReview,
} from './types.js'

export interface ChapterCreationResult {
  chapter: NovelChapter
  review: NovelChapterReview | null
  status: 'published' | 'rejected' | 'needs_revision'
}

export class NovelEngine {
  constructor(
    private store: NovelStore,
    private sessionFactory: NovelSessionFactory,
  ) {}

  /**
   * 构建章节约束
   *
   * 从数据库读取当前项目的所有约束，按类型分类。
   */
  buildChapterConstraints(projectId: string): ChapterConstraints {
    const constraints = this.store.listConstraints(projectId)
    const foreshadowing = this.store.listForeshadowing(projectId)
    const characters = this.store.listCharacters(projectId)

    return {
      facts: constraints.filter((c) => c.type === 'fact'),
      cognitive: constraints.filter((c) => c.type === 'cognitive'),
      stage: constraints.filter((c) => c.type === 'stage'),
      narrativeDebts: foreshadowing.filter(
        (f) => f.status !== 'recovered' && f.status !== 'abandoned',
      ),
      characterArcs: characters.map((character) => ({
        character,
        allowedNextStage: this.getNextArcStage(character.arcStage),
      })),
    }
  }

  /**
   * 创建章节
   *
   * 编排完整的章节创作流程。
   *
   * 注意：实际的 LLM 调用由调用方通过 Pi SDK session 完成。
   * 此方法负责状态管理和流程编排，不直接调用 LLM。
   */
  async createChapter(
    projectId: string,
    chapterNumber: number,
    narrativeTask: NarrativeTask,
  ): Promise<{ chapterId: string; context: string; systemPrompt: string }> {
    const project = this.store.getProject(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)

    // 1. 构建约束
    const constraints = this.buildChapterConstraints(projectId)

    // 2. 创建章节记录（planned 状态）
    const chapterId = randomUUID()
    const chapter = this.store.createChapter({
      id: chapterId,
      projectId,
      volume: project.currentVolume,
      chapterNumber,
      title: '',
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: narrativeTask.description,
      acceptanceResult: null,
    })

    // 3. 构建系统提示词和章节上下文
    const config = {
      projectId,
      agentType: 'writer',
      chapterNumber,
      narrativeTask,
      constraints,
    }

    const systemPrompt = this.sessionFactory.buildSystemPrompt(config)
    const context = this.sessionFactory.buildChapterContext(config)

    return { chapterId, context, systemPrompt }
  }

  /**
   * 完成章节
   *
   * 在 LLM 生成章节内容后调用，保存内容并更新状态。
   */
  async completeChapter(
    chapterId: string,
    content: string,
    title?: string,
  ): Promise<NovelChapter> {
    const existing = this.store.getChapterById(chapterId)
    if (!existing) throw new Error(`章节不存在: ${chapterId}`)

    const wordCount = content.length // 简单按字符数计算
    const updated = this.store.updateChapter(chapterId, {
      content,
      title: title ?? `第${existing.chapterNumber}章`,
      wordCount,
      status: 'review',
    })

    if (!updated) throw new Error(`章节更新失败: ${chapterId}`)
    return updated
  }

  /**
   * 发布章节
   *
   * 审稿通过后调用，更新章节状态和项目进度。
   */
  async publishChapter(chapterId: string): Promise<NovelChapter> {
    const updated = this.store.updateChapter(chapterId, { status: 'published' })
    if (!updated) throw new Error(`章节不存在: ${chapterId}`)

    // 更新项目进度
    const project = this.store.getProject(updated.projectId)
    if (project) {
      this.store.updateProject(project.id, {
        currentChapter: Math.max(project.currentChapter, updated.chapterNumber),
      })
    }

    return updated
  }

  /**
   * 保存章节验收
   */
  async saveReview(review: Omit<NovelChapterReview, 'id' | 'createdAt'>): Promise<NovelChapterReview> {
    const full = { ...review, id: randomUUID() }
    return this.store.createChapterReview(full)
  }

  /**
   * 获取角色弧光的下一个可达阶段
   *
   * 简单的线性阶段推进，可被覆盖以实现更复杂的弧光逻辑。
   */
  private getNextArcStage(currentStage: string): string | null {
    const stages = ['introduction', 'development', 'struggle', 'transformation', 'resolution']
    const idx = stages.indexOf(currentStage)
    if (idx === -1 || idx === stages.length - 1) return null
    return stages[idx + 1]
  }
}
