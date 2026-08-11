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
import { isNovelFeatureEnabled } from './novel-feature-flags.js'
import { baseTargetOf, resolveWordBudget } from './word-budget-resolver.js'
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
  ChapterPositioning,
  WordBudget,
  ArrangedEntity
} from './types.js'

export interface ChapterCreationResult {
  chapter: NovelChapter
  review: NovelChapterReview | null
  status: 'published' | 'rejected' | 'needs_revision'
}

export class NovelEngine {
  constructor(private store: NovelStore) {}

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
    positioning?: ChapterPositioning | null,
    arrangedEntities?: ArrangedEntity
  ): ChapterConstraints {
    const constraints = this.store.listConstraints(projectId)
    const foreshadowing = this.store.listForeshadowing(projectId)
    const selectedCharacterIds = arrangedEntities ? new Set(arrangedEntities.characterIds) : null
    const selectedConflictIds = arrangedEntities ? new Set(arrangedEntities.conflictIds) : null
    const selectedForeshadowIds = arrangedEntities ? new Set(arrangedEntities.foreshadowIds) : null
    const characters = this.store
      .listCharacters(projectId)
      .filter((character) => !selectedCharacterIds || selectedCharacterIds.has(character.id))
    const pendingForeshadows = foreshadowing.filter(
      (f) =>
        f.status !== 'recovered' &&
        f.status !== 'abandoned' &&
        (!selectedForeshadowIds || selectedForeshadowIds.has(f.id))
    )

    // 只把本章需要动作的伏笔放进“硬约束”。长期未回收伏笔仍会以紧凑的
    // story-state 快照出现，但不能每章都被误写成“本章必须维持/释放”。
    // beats 是伏笔真正发生的离散章节；旧数据会由 NovelStore 用首章/回收章
    // 补出端点 beat，因此这里同时兼容新旧数据。
    const relevantForeshadows =
      chapterNumber === undefined
        ? pendingForeshadows.slice(0, 8)
        : pendingForeshadows
            .filter(
              (f) =>
                f.beats?.some((beat) => beat.chapter === chapterNumber) ||
                f.firstChapter === chapterNumber ||
                (f.recoverByChapter !== null && f.recoverByChapter <= chapterNumber)
            )
            .sort((a, b) => {
              const aBeat = a.beats?.find((beat) => beat.chapter === chapterNumber)
              const bBeat = b.beats?.find((beat) => beat.chapter === chapterNumber)
              const priority = (type: string | undefined): number =>
                type === 'payoff' ? 0 : type === 'reveal' ? 1 : type === 'reinforce' ? 2 : 3
              return (
                priority(aBeat?.type) - priority(bBeat?.type) ||
                (a.recoverByChapter ?? Number.MAX_SAFE_INTEGER) -
                  (b.recoverByChapter ?? Number.MAX_SAFE_INTEGER) ||
                a.id.localeCompare(b.id)
              )
            })
            .slice(0, 8)

    // ── 冲突推进目标 ──
    // 筛选本章需推进的活跃冲突：章节在跨度内 / 空跨度（未放置）/ 本章为爆发章节
    const conflictTargets: ConflictTarget[] = []
    if (chapterNumber !== undefined) {
      // P2 读切：appearanceV2Read 开启时按 appearance 表判定"本章出场冲突"，
      // 关闭时走原 chapterSpans 过滤（零行为变化）。
      const appearanceConflictIds = this.store.listChapterAppearanceIds({
        projectId, chapterNumber, entityType: 'conflict',
      })
      const activeConflicts = this.store
        .listConflicts(projectId)
        .filter(
          (c) =>
            c.stage !== 'resolved' &&
            c.stage !== 'transformed' &&
            (!selectedConflictIds || selectedConflictIds.has(c.id))
        )
      for (const conflict of activeConflicts) {
        const inSpan = appearanceConflictIds
          ? appearanceConflictIds.includes(conflict.id)
          : conflict.chapterSpans.some(
              (span) => chapterNumber >= span[0] && chapterNumber <= span[1]
            )
        const isClimaxChapter = conflict.climaxChapter === chapterNumber
        const noSpans = conflict.chapterSpans.length === 0
        if (!inSpan && !isClimaxChapter && !noSpans) continue

        const targetStage = this.computeConflictTargetStage(conflict, chapterNumber)
        conflictTargets.push({
          conflict,
          targetStage,
          intensityDelta: this.computeIntensityDelta(
            isClimaxChapter,
            rhythmSuggestion,
            conflict.stage,
            targetStage
          ),
          isClimax: isClimaxChapter
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
        reason: rhythmSuggestion.reason
      }
    }

    // ── 悬念钩子 ──
    // 来源：待回收伏笔（planting/sustaining/releasing）+ 未揭示信息差（sustaining/releasing）
    const suspenseHooks: SuspenseHook[] = []
    if (chapterNumber !== undefined) {
      for (const f of relevantForeshadows) {
        const firstChapter: number = f.firstChapter ?? chapterNumber
        const currentBeat = f.beats?.find((beat) => beat.chapter === chapterNumber)
        let status: SuspenseHook['status']
        if (currentBeat?.type === 'plant' || firstChapter === chapterNumber) {
          status = 'planting'
        } else if (
          currentBeat?.type === 'payoff' ||
          currentBeat?.type === 'reveal' ||
          (f.recoverByChapter !== null && f.recoverByChapter <= chapterNumber)
        ) {
          status = 'releasing'
        } else {
          status = 'sustaining'
        }
        suspenseHooks.push({
          infoLayerId: null,
          description: f.description,
          status,
          sustainedChapters: Math.max(0, chapterNumber - firstChapter),
          releaseByChapter: f.recoverByChapter
        })
      }

      const selectedInfoLayerIds = new Set<string>()
      for (const foreshadow of relevantForeshadows) {
        const parsed = this.store
          .listEdgesByEntity(foreshadow.id, { edgeType: 'related' })
          .filter(
            (e) =>
              e.sourceType === 'foreshadow' &&
              e.targetType === 'info_layer' &&
              e.sourceId === foreshadow.id
          )
          .map((e) => e.targetId)
        for (const id of parsed) selectedInfoLayerIds.add(id)
      }
      const infoLayers = this.store.listInformationLayers(projectId)
      const relevantInfoLayers = infoLayers
        .filter((layer) => !layer.isRevealed)
        .filter((layer) => {
          if (!arrangedEntities) return true
          if (selectedInfoLayerIds.has(layer.id)) return true
          const linked = this.store
            .listEdgesByEntity(layer.id, { edgeType: 'related' })
            .filter(
              (e) =>
                e.sourceType === 'foreshadow' &&
                e.targetType === 'info_layer' &&
                e.targetId === layer.id
            )
            .map((e) => e.sourceId)
          if (linked.some((id) => selectedForeshadowIds?.has(id))) return true
          try {
            const knowledge = JSON.parse(layer.characterKnowledge ?? '{}') as Record<
              string,
              unknown
            >
            return [...(selectedCharacterIds ?? [])].some((id) => Object.hasOwn(knowledge, id))
          } catch {
            return false
          }
        })
        .filter((layer) => layer.revealChapter !== null && layer.revealChapter <= chapterNumber)
        .sort(
          (a, b) =>
            (a.revealChapter ?? Number.MAX_SAFE_INTEGER) -
              (b.revealChapter ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
        )
        .slice(0, Math.max(0, 8 - suspenseHooks.length))
      for (const layer of relevantInfoLayers) {
        const revealChapter = layer.revealChapter
        const status: SuspenseHook['status'] =
          revealChapter !== null && revealChapter <= chapterNumber ? 'releasing' : 'sustaining'
        suspenseHooks.push({
          infoLayerId: layer.id,
          description: layer.infoDescription,
          status,
          sustainedChapters: 0,
          releaseByChapter: revealChapter
        })
      }
    }

    // ── 字数预算（基于章节定位调整）──
    // 若传入了 positioning，按定位调整目标字数；定位是 Director 对本章的最终选择。
    // 节奏建议只在没有明确定位时由 prompt-builder 作为回退使用，不能与定位倍率叠加。
    // V2（scenePlanV2Write）：统一走 WordBudgetResolver，定位默认不调整、上限 ±15%，
    // Rhythm 不参与；V1 保持内联定位倍率不变。
    let wordBudget: WordBudget | null = null
    const project = this.store.getProject(projectId)
    if (positioning) {
      const baseTarget = baseTargetOf(project?.targetWords)
      if (isNovelFeatureEnabled(this.store, projectId, 'scenePlanV2Write')) {
        const resolved = resolveWordBudget({ baseTarget })
        wordBudget = {
          min: resolved.min,
          max: resolved.max,
          target: resolved.resolvedTarget,
        }
      } else {
        // 定位倍率（与 rhythm-controller 的 POSITIONING_RULES 一致）
        const positioningMultipliers: Record<ChapterPositioning, number> = {
          high_pressure: 1.3,
          advancement: 1.0,
          cultivation: 0.9,
          relationship: 0.95,
          low_pressure: 0.85,
          information: 0.9
        }
        const multiplier = positioningMultipliers[positioning]
        const target = Math.round(baseTarget * multiplier)
        wordBudget = {
          min: Math.round(target * 0.85),
          max: Math.round(target * 1.15),
          target
        }
      }
    }

    return {
      facts: constraints.filter((c) => c.type === 'fact'),
      cognitive: constraints.filter((c) => c.type === 'cognitive'),
      stage: constraints.filter((c) => c.type === 'stage'),
      narrativeDebts: relevantForeshadows,
      characterArcs: characters.map((character) => ({
        character,
        allowedNextStage: this.getNextArcStage(character.arcStage)
      })),
      conflictTargets,
      rhythmConstraint,
      suspenseHooks,
      wordBudget,
      positioning: positioning ?? null
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
    chapterNumber: number
  ): ConflictStage {
    // 爆发章节硬约束：所有模式都必须达到 erupting（保证冲突网兑现伏笔）
    if (conflict.climaxChapter === chapterNumber) return 'erupting'

    const progression: ConflictStage[] = [
      'latent',
      'emerging',
      'escalating',
      'erupting',
      'reversing',
      'resolved'
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
          reversing: 'resolved'
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
          emerging: 'latent'
        }
        return regressionMap[conflict.stage] ?? conflict.stage
      }

      case 'reversal': {
        // 反复：resolved/transformed 重新 emerging；其他走 linear 路径
        const reversalMap: Partial<Record<ConflictStage, ConflictStage>> = {
          resolved: 'emerging',
          transformed: 'emerging'
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
    currentStage?: ConflictStage,
    targetStage?: ConflictStage
  ): number {
    // 跨阶段推进必须有强度变化，否则 Director 会看到"目标阶段 erupting 但强度变化 0"的矛盾
    // 修复（2026-07-18）：原实现只按 rhythm 推断，忽略了 stage 跨阶需要强度变化。
    // 若 currentStage !== targetStage，至少 +2（跨阶段推进的最低强度增量）。
    if (currentStage && targetStage && currentStage !== targetStage) {
      const progression: ConflictStage[] = [
        'latent',
        'emerging',
        'escalating',
        'erupting',
        'reversing',
        'resolved'
      ]
      const currentIdx = progression.indexOf(currentStage)
      const targetIdx = progression.indexOf(targetStage)
      if (currentIdx !== -1 && targetIdx !== -1) {
        const stageDelta = targetIdx - currentIdx
        // 前进 N 阶：强度 +N*2（最低 +2，最高 +10）
        if (stageDelta > 0) {
          return Math.min(10, Math.max(2, stageDelta * 2))
        }
        // 后退 N 阶（regression/reversal 模式）：强度 -N*2
        if (stageDelta < 0) {
          return Math.max(-10, stageDelta * 2)
        }
      }
    }

    // 同阶段（stagnation 或未跨阶）：按节奏推断
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
    volumeId?: string | null
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
      positioning: narrativeTask.positioning ?? null
    })

    // 注：原此处调用 sessionFactory.buildSystemPrompt/buildChapterContext 以"触发约束构建副作用"，
    // 但 prompt-builder 实现是纯读取（无 store 写入），属于历史遗留死代码，已删除。

    return chapter
  }

  /**
   * 完成章节
   *
   * 在 LLM 生成章节内容后调用，保存内容并更新状态。
   */
  async completeChapter(chapterId: string, content: string, title?: string): Promise<NovelChapter> {
    const existing = this.store.getChapterById(chapterId)
    if (!existing) throw new Error(`章节不存在: ${chapterId}`)

    const wordCount = content.length // 简单按字符数计算
    const updated = this.store.updateChapter(chapterId, {
      content,
      title: title ?? `第${existing.chapterNumber}章`,
      wordCount,
      status: 'review'
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
        currentChapter: Math.max(project.currentChapter, updated.chapterNumber)
      })
    }

    return updated
  }

  /**
   * 保存章节验收
   */
  async saveReview(
    review: Omit<NovelChapterReview, 'id' | 'createdAt'>
  ): Promise<NovelChapterReview> {
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
