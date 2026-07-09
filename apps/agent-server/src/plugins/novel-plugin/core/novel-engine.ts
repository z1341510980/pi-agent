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
  ConflictTarget,
  RhythmConstraint,
  SuspenseHook,
  RhythmSuggestion,
  NovelConflict,
  ConflictStage,
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
   * 当传入 chapterNumber 时，额外构建冲突推进目标、节奏约束、悬念钩子三类约束，
   * 让 Writer 知道本章"必须推进哪些冲突、遵循什么节奏、维持或释放哪些悬念"。
   *
   * - conflictTargets：本章跨度内或爆发章节的活跃冲突，含目标阶段和强度变化
   * - rhythmConstraint：来自 RhythmController 的节奏建议（仅在传入 rhythmSuggestion 时构建）
   * - suspenseHooks：待回收伏笔 + 未揭示信息差，标注 planting/sustaining/releasing
   */
  buildChapterConstraints(
    projectId: string,
    chapterNumber?: number,
    rhythmSuggestion?: RhythmSuggestion,
  ): ChapterConstraints {
    const constraints = this.store.listConstraints(projectId)
    const foreshadowing = this.store.listForeshadowing(projectId)
    const characters = this.store.listCharacters(projectId)

    // ── 冲突推进目标 ──
    // 筛选本章需推进的活跃冲突：章节在跨度内 / 空跨度（未放置）/ 本章为爆发章节
    const conflictTargets: ConflictTarget[] = []
    if (chapterNumber !== undefined) {
      const activeConflicts = this.store.listConflicts(projectId).filter(
        (c) => c.stage !== 'resolved' && c.stage !== 'transformed',
      )
      for (const conflict of activeConflicts) {
        const inSpan = conflict.chapterSpans.some(
          (span) => chapterNumber >= span[0] && chapterNumber <= span[1],
        )
        const isClimaxChapter = conflict.climaxChapter === chapterNumber
        const noSpans = conflict.chapterSpans.length === 0
        if (!inSpan && !isClimaxChapter && !noSpans) continue

        conflictTargets.push({
          conflict,
          targetStage: this.computeConflictTargetStage(conflict, chapterNumber),
          intensityDelta: this.computeIntensityDelta(
            isClimaxChapter, rhythmSuggestion,
          ),
          isClimax: isClimaxChapter,
        })
      }
      // 按强度降序，限制最多 5 个目标，避免 Writer 过载
      conflictTargets.sort((a, b) => b.conflict.intensity - a.conflict.intensity)
      if (conflictTargets.length > 5) conflictTargets.length = 5
    }

    // ── 节奏约束（仅当有节奏建议时构建）──
    let rhythmConstraint: RhythmConstraint | undefined
    if (rhythmSuggestion) {
      rhythmConstraint = {
        rhythm: rhythmSuggestion.rhythm,
        climaxIntensity: rhythmSuggestion.climaxIntensity,
        climaxType: rhythmSuggestion.climaxType,
        description: rhythmSuggestion.description,
        reason: rhythmSuggestion.reason,
      }
    }

    // ── 悬念钩子 ──
    // 来源：待回收伏笔（planting/sustaining/releasing）+ 未揭示信息差（sustaining/releasing）
    const suspenseHooks: SuspenseHook[] = []
    if (chapterNumber !== undefined) {
      const pendingForeshadows = foreshadowing.filter(
        (f) => f.status !== 'recovered' && f.status !== 'abandoned',
      )
      for (const f of pendingForeshadows) {
        const firstChapter = f.firstChapter ?? chapterNumber
        let status: SuspenseHook['status']
        if (firstChapter >= chapterNumber) {
          status = 'planting'
        } else if (f.recoverByChapter !== null && f.recoverByChapter <= chapterNumber) {
          status = 'releasing'
        } else {
          status = 'sustaining'
        }
        suspenseHooks.push({
          infoLayerId: null,
          description: f.description,
          status,
          sustainedChapters: Math.max(0, chapterNumber - firstChapter),
          releaseByChapter: f.recoverByChapter,
        })
      }

      const infoLayers = this.store.listInformationLayers(projectId)
      for (const layer of infoLayers) {
        if (layer.isRevealed) continue
        const revealChapter = layer.revealChapter
        const status: SuspenseHook['status'] =
          revealChapter !== null && revealChapter <= chapterNumber
            ? 'releasing'
            : 'sustaining'
        suspenseHooks.push({
          infoLayerId: layer.id,
          description: layer.infoDescription,
          status,
          sustainedChapters: 0,
          releaseByChapter: revealChapter,
        })
      }
    }

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
      conflictTargets,
      rhythmConstraint,
      suspenseHooks,
    }
  }

  /**
   * 计算冲突本章目标阶段（支持非线性推进）
   *
   * 推进模式（progressionMode，默认 'linear'）：
   *
   * - linear（线性推进，向后兼容旧逻辑）：
   *   本章是爆发章节 → erupting
   *   已 erupting → reversing（高潮后转向）
   *   已 reversing → resolved（突转后收束）
   *   其他 → 推进一阶（latent→emerging→escalating→erupting）
   *
   * - mutation（突变跳跃，跳过多阶）：
   *   latent → erupting（直接爆发，适合突袭型冲突）
   *   emerging → erupting
   *   escalating → reversing（升级后立即反转）
   *   erupting → reversing
   *   reversing → resolved
   *   resolved/transformed → 保持（已收束）
   *
   * - stagnation（停滞，保持当前阶段，仅强度变化）：
   *   始终返回 conflict.stage（适合潜伏长冲突，避免每章都推进）
   *   但 climaxChapter 仍能强行推进到 erupting
   *
   * - regression（降级，回退一阶）：
   *   erupting → escalating（外部干预，紧张度下降）
   *   escalating → emerging
   *   emerging → latent
   *   latent/reversing/resolved/transformed → 保持（无法继续降级）
   *
   * - reversal（反复，旧仇重燃）：
   *   resolved → emerging（重新点燃）
   *   transformed → emerging（变形后再次启动）
   *   其他 → 走 linear 路径（保持推进逻辑）
   *
   * 设计权衡：climaxChapter 是硬约束（爆发章节必须 erupting），
   * 即使 stagnation 模式也会被 climaxChapter 强行推进到 erupting，
   * 否则冲突网会因伏笔未爆发而断裂。
   */
  private computeConflictTargetStage(
    conflict: NovelConflict,
    chapterNumber: number,
  ): ConflictStage {
    // 爆发章节硬约束：所有模式都必须达到 erupting（保证冲突网兑现伏笔）
    if (conflict.climaxChapter === chapterNumber) return 'erupting'

    const progression: ConflictStage[] = [
      'latent', 'emerging', 'escalating', 'erupting', 'reversing', 'resolved',
    ]
    const idx = progression.indexOf(conflict.stage)
    if (idx === -1) {
      // transformed 等非主线阶段：保持不变
      return conflict.stage
    }

    const mode = conflict.progressionMode ?? 'linear'

    switch (mode) {
      case 'linear':
        // 旧逻辑：线性推进一阶，erupting/reversing 各自转向
        if (conflict.stage === 'erupting') return 'reversing'
        if (conflict.stage === 'reversing') return 'resolved'
        return progression[idx + 1] ?? conflict.stage

      case 'mutation': {
        // 突变跳跃：根据当前阶段跳到更靠后的阶段
        const mutationMap: Partial<Record<ConflictStage, ConflictStage>> = {
          latent: 'erupting',
          emerging: 'erupting',
          escalating: 'reversing',
          erupting: 'reversing',
          reversing: 'resolved',
        }
        return mutationMap[conflict.stage] ?? conflict.stage
      }

      case 'stagnation':
        // 停滞：保持当前阶段，仅靠 intensity 变化体现张力
        return conflict.stage

      case 'regression': {
        // 降级：回退一阶（但不能越过 latent）
        const regressionMap: Partial<Record<ConflictStage, ConflictStage>> = {
          erupting: 'escalating',
          escalating: 'emerging',
          emerging: 'latent',
        }
        return regressionMap[conflict.stage] ?? conflict.stage
      }

      case 'reversal': {
        // 反复：resolved/transformed 重新 emerging；其他走 linear 路径
        const reversalMap: Partial<Record<ConflictStage, ConflictStage>> = {
          resolved: 'emerging',
          transformed: 'emerging',
        }
        if (reversalMap[conflict.stage]) return reversalMap[conflict.stage]!
        // 非 resolved/transformed：走 linear 推进
        if (conflict.stage === 'erupting') return 'reversing'
        if (conflict.stage === 'reversing') return 'resolved'
        return progression[idx + 1] ?? conflict.stage
      }

      default:
        return conflict.stage
    }
  }

  /**
   * 计算本章预期强度变化
   *
   * - 爆发章节 → +3（重大升级）
   * - climax 节奏 → +2
   * - rising 节奏 → +1
   * - falling/resolution 节奏 → -1
   * - 其他 → 0
   */
  private computeIntensityDelta(
    isClimax: boolean,
    rhythmSuggestion?: RhythmSuggestion,
  ): number {
    if (isClimax) return 3
    const rhythm = rhythmSuggestion?.rhythm
    if (rhythm === 'climax') return 2
    if (rhythm === 'rising') return 1
    if (rhythm === 'falling' || rhythm === 'resolution') return -1
    return 0
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
    volumeId?: string | null,
  ): Promise<NovelChapter> {
    const project = this.store.getProject(projectId)
    if (!project) throw new Error(`项目不存在: ${projectId}`)

    // 1. 构建约束（用于后续写作流程；此处仅创建章节记录，不直接使用）
    const constraints = this.buildChapterConstraints(projectId, chapterNumber)

    // 2. 创建章节记录（planned 状态）
    //    volumeId 优先使用调用方传入值（来自 outline-tree 的卷内新建章），
    //    未传则回退到 project.currentVolume 对应的卷 id（向后兼容）。
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
      volumeId: volumeId ?? null,
    })

    // 3. 触发约束构建以保持副作用一致（部分约束会写入 store）
    const config = {
      projectId,
      agentType: 'writer',
      chapterNumber,
      narrativeTask,
      constraints,
    }
    this.sessionFactory.buildSystemPrompt(config)
    this.sessionFactory.buildChapterContext(config)

    return chapter
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
