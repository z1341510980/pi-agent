import type {
  ChapterRhythm,
  RhythmModel,
  RhythmSuggestion,
  RhythmHistoryEntry,
  RhythmSequenceEntry,
  StoryStage,
  ClimaxIntensity,
  ClimaxType,
  NovelConflict,
  NovelForeshadow,
  ChapterPositioning,
} from './types.js'

/**
 * RhythmController：章节节奏控制
 *
 * 基于故事阶段（StoryStage）和最近章节节奏历史，
 * 建议下一章的理想节奏类型。
 *
 * 节奏模型参考三幕剧结构 + 网文节奏理论：
 * - 第一幕（setup）：铺垫 → 上升 → 小高潮
 * - 第二幕（rising）：上升 → 舒缓 → 上升 → 高潮 → 舒缓 → 上升 → 大高潮
 * - 第三幕（climax→resolution）：下降 → 收束
 *
 * v2 增强：
 * - 节奏序列支持高潮强度标注（minor/medium/major）和高潮类型建议
 * - suggestRhythm 接收活跃冲突和待回收伏笔，感知故事状态
 * - 冲突 erupting 阶段自动建议 climax 节奏
 * - 待回收伏笔数量多时建议 release_info 节奏
 */
export class RhythmController {
  /** 默认节奏模型（标准三幕剧） */
  static readonly DEFAULT_MODEL: RhythmModel = {
    id: 'standard-three-act',
    name: '标准三幕剧',
    description: '三幕剧结构，适合中长篇小说',
    sequence: [
      { rhythm: 'setup' },                              // 1
      { rhythm: 'setup' },                              // 2
      { rhythm: 'rising' },                             // 3
      { rhythm: 'breather' },                           // 4
      { rhythm: 'rising' },                             // 5
      { rhythm: 'climax', climaxIntensity: 'minor' },   // 6 小高潮
      { rhythm: 'falling' },                            // 7
      { rhythm: 'rising' },                             // 8
      { rhythm: 'breather' },                           // 9
      { rhythm: 'rising' },                             // 10
      { rhythm: 'rising' },                             // 11
      { rhythm: 'climax', climaxIntensity: 'major', climaxType: 'composite' }, // 12 大高潮
      { rhythm: 'falling' },                            // 13
      { rhythm: 'resolution' },                         // 14
    ],
  }

  /** 网文节奏模型（更快节奏，频繁高潮） */
  static readonly WEBNOVEL_MODEL: RhythmModel = {
    id: 'webnovel-fast',
    name: '网文快节奏',
    description: '每3-4章一个小高潮，适合网文连载',
    sequence: [
      { rhythm: 'setup' },                                              // 1
      { rhythm: 'rising' },                                             // 2
      { rhythm: 'climax', climaxIntensity: 'minor', climaxType: 'combat' },     // 3 小高潮
      { rhythm: 'breather' },                                           // 4
      { rhythm: 'rising' },                                             // 5
      { rhythm: 'climax', climaxIntensity: 'minor', climaxType: 'emotional' },  // 6 小高潮
      { rhythm: 'breather' },                                           // 7
      { rhythm: 'twist' },                                              // 8 转折
      { rhythm: 'rising' },                                             // 9
      { rhythm: 'climax', climaxIntensity: 'medium', climaxType: 'fate' },     // 10 中高潮
      { rhythm: 'falling' },                                            // 11
      { rhythm: 'rising' },                                             // 12
      { rhythm: 'climax', climaxIntensity: 'major', climaxType: 'composite' }, // 13 大高潮
      { rhythm: 'resolution' },                                         // 14
    ],
  }

  /** 所有可用节奏模型 */
  static readonly MODELS: RhythmModel[] = [
    RhythmController.DEFAULT_MODEL,
    RhythmController.WEBNOVEL_MODEL,
  ]

  // ═══════════════════════════════════════════════════════════════
  // 章节定位六型 → 节奏规则映射（借鉴 oh-story-claudecode）
  // 不同定位有不同的钩子密度、爽点频率和节奏要求
  // ═══════════════════════════════════════════════════════════════

  /**
   * 章节定位规则：每种定位对应的节奏偏好和创作指导
   */
  static readonly POSITIONING_RULES: Record<ChapterPositioning, {
    preferredRhythm: ChapterRhythm[]
    hookDensity: 'dense' | 'normal' | 'sparse'
    pacing: 'fast' | 'medium' | 'slow'
    wordBudgetMultiplier: number
    guidance: string
  }> = {
    high_pressure: {
      preferredRhythm: ['climax', 'twist', 'suspense'],
      hookDensity: 'dense',
      pacing: 'fast',
      wordBudgetMultiplier: 1.3,
      guidance: '高压章：冲突爆发/高潮/生死搏斗。节奏快，每段都要有张力。钩子密集，章尾必留强钩。对话短促，动作密集。',
    },
    advancement: {
      preferredRhythm: ['rising', 'climax'],
      hookDensity: 'normal',
      pacing: 'medium',
      wordBudgetMultiplier: 1.0,
      guidance: '推进章：主线推进/信息释放。节奏中等，爽点明确。每 500 字至少一个信息增量或爽点。章尾留钩推动下一章。',
    },
    cultivation: {
      preferredRhythm: ['setup', 'rising', 'breather'],
      hookDensity: 'normal',
      pacing: 'slow',
      wordBudgetMultiplier: 0.9,
      guidance: '修炼试错章：升级/试错/领悟。节奏偏慢，成长感强。侧重过程描写（修炼细节、失败反思），结尾给出突破或新方向。',
    },
    relationship: {
      preferredRhythm: ['breather', 'rising', 'falling'],
      hookDensity: 'normal',
      pacing: 'medium',
      wordBudgetMultiplier: 0.95,
      guidance: '关系回收章：角色互动/关系变化。节奏中等，情感线为主。对话占比偏高（55-65%），通过互动承载关系变化。',
    },
    low_pressure: {
      preferredRhythm: ['breather', 'setup', 'resolution'],
      hookDensity: 'sparse',
      pacing: 'slow',
      wordBudgetMultiplier: 0.85,
      guidance: '低压生活章：日常/过渡/铺垫。节奏慢，世界观展示。可写生活细节、角色日常，但必须有至少一个信息增量或伏笔，不能纯水。',
    },
    information: {
      preferredRhythm: ['setup', 'suspense', 'rising'],
      hookDensity: 'normal',
      pacing: 'slow',
      wordBudgetMultiplier: 0.9,
      guidance: '信息整理章：线索整理/布局/计划。节奏慢，信息密度高。角色梳理线索、制定计划，但必须通过场景和对话承载，不能变成清单。',
    },
  }

  /**
   * 根据章节定位获取节奏规则
   */
  getPositioningRules(positioning: ChapterPositioning) {
    return RhythmController.POSITIONING_RULES[positioning]
  }

  /**
   * 建议下一章的节奏
   *
   * @param currentChapter 当前章号
   * @param storyStage 故事阶段
   * @param history 节奏历史
   * @param model 节奏模型
   * @param options 可选的故事状态感知参数（活跃冲突、待回收伏笔）
   */
  suggestRhythm(
    currentChapter: number,
    storyStage: StoryStage,
    history: RhythmHistoryEntry[],
    model: RhythmModel = RhythmController.DEFAULT_MODEL,
    options?: {
      activeConflicts?: NovelConflict[]
      pendingForeshadows?: NovelForeshadow[]
    },
  ): RhythmSuggestion {
    // 1. 从节奏模型中获取建议
    const modelIndex = (currentChapter - 1) % model.sequence.length
    const modelEntry = model.sequence[modelIndex]
    let modelRhythm = modelEntry.rhythm
    let climaxIntensity = modelEntry.climaxIntensity
    let climaxType = modelEntry.climaxType

    // 2. 计算弧位置（0-1）
    const arcPosition = Math.min(currentChapter / model.sequence.length, 1)

    // 3. 检查最近是否有连续高潮（需要插入舒缓）
    const recentRhythms = history.slice(-3).map(h => h.rhythm)
    const consecutiveClimaxes = recentRhythms.filter(r => r === 'climax' || r === 'twist').length
    if (consecutiveClimaxes >= 2 && modelRhythm !== 'breather') {
      modelRhythm = 'breather'
      climaxIntensity = undefined
      climaxType = undefined
    }

    // 4. 故事状态感知修正（v2 增强）
    // 4a. 如果有 erupting 阶段的冲突，强制建议 climax（冲突爆发应对应高潮）
    if (options?.activeConflicts) {
      const eruptingConflicts = options.activeConflicts.filter(c => c.stage === 'erupting')
      if (eruptingConflicts.length > 0 && modelRhythm !== 'breather') {
        modelRhythm = 'climax'
        // 如果冲突有 climaxType，使用之
        const conflictClimaxType = eruptingConflicts[0].climaxType ?? undefined
        if (conflictClimaxType) climaxType = conflictClimaxType
        // erupting 冲突强度 >= 8 视为大高潮
        const maxIntensity = Math.max(...eruptingConflicts.map(c => c.intensity))
        if (maxIntensity >= 8) {
          climaxIntensity = 'major'
        } else if (maxIntensity >= 6 && !climaxIntensity) {
          climaxIntensity = 'medium'
        }
      }

      // 4b. 如果有 reversing 阶段的冲突，建议 twist（突转）
      const reversingConflicts = options.activeConflicts.filter(c => c.stage === 'reversing')
      if (reversingConflicts.length > 0 && modelRhythm !== 'breather') {
        modelRhythm = 'twist'
        climaxIntensity = undefined
        climaxType = undefined
      }

      // 4c. 如果冲突强度总和很高但未爆发，建议 rising（蓄势）
      const totalIntensity = options.activeConflicts.reduce((sum, c) => sum + c.intensity, 0)
      if (totalIntensity > 20 && (modelRhythm === 'setup' || modelRhythm === 'breather')) {
        modelRhythm = 'rising'
      }
    }

    // 4d. 如果待回收伏笔数量多且接近 recoverByChapter，建议 climax 或 release_info 相关节奏
    if (options?.pendingForeshadows) {
      const urgentForeshadows = options.pendingForeshadows.filter(
        f => f.recoverByChapter != null && f.recoverByChapter <= currentChapter + 1
      )
      if (urgentForeshadows.length >= 2 && modelRhythm === 'breather') {
        // 伏笔紧迫，不宜舒缓
        modelRhythm = 'rising'
      }
    }

    // 5. 生成原因描述
    const reason = this.generateReason(
      modelRhythm,
      storyStage,
      consecutiveClimaxes,
      arcPosition,
      options,
    )

    return {
      rhythm: modelRhythm,
      arcPosition,
      reason,
      description: this.getRhythmDescription(modelRhythm, climaxIntensity),
      climaxIntensity,
      climaxType,
    }
  }

  /** 获取节奏描述（供 LLM 参考） */
  private getRhythmDescription(rhythm: ChapterRhythm, climaxIntensity?: ClimaxIntensity): string {
    const descriptions: Record<ChapterRhythm, string> = {
      setup: '本章为铺垫章节。重点介绍背景、人物设定、世界观。节奏舒缓，信息密度适中，为后续冲突埋下伏笔。',
      rising: '本章为上升章节。推进冲突，加剧紧张感。角色面临挑战，局势逐渐升级。',
      climax: climaxIntensity === 'major'
        ? '本章为大高潮章节。冲突全面爆发，情节达到转折点。情感强度最高（9-10），关键真相揭露或决战发生。需要充分的前置蓄势，高潮时将各种线索收拢到主线。'
        : climaxIntensity === 'medium'
          ? '本章为中高潮章节。卷末或弧线高潮，冲突爆发，情感强度较高（7-8）。关键阶段性事件发生。'
          : climaxIntensity === 'minor'
            ? '本章为小高潮章节。单卷内的阶段性爆发，情感强度 5-6。如打败小 BOSS、升级、揭穿小阴谋。保持读者阅读快感。'
            : '本章为高潮章节。冲突爆发，情节达到转折点。情感强度最高，关键真相揭露或决战发生。',
      falling: '本章为下降章节。处理高潮后的后果，角色消化事件，关系调整。让读者从高潮的紧张中平复。',
      resolution: '本章为收束章节。解决悬而未决的线索，回到新的平衡。为下一弧线做铺垫。',
      twist: '本章为转折章节。意料之外的走向，颠覆读者预期。保持紧张感但方向突变。突转必须有前置误导线索和伏笔支撑，不能凭空发生。',
      breather: '本章为舒缓章节。紧张之间的缓冲，角色互动、日常场景，为下一个上升积蓄力量。',
      suspense: '本章为悬念章节。信息差累积，读者期待感拉满。通过信息不对称制造紧张感，但冲突尚未爆发。',
    }
    return descriptions[rhythm]
  }

  /** 生成建议原因 */
  private generateReason(
    rhythm: ChapterRhythm,
    stage: StoryStage,
    consecutiveClimaxes: number,
    arcPosition: number,
    options?: {
      activeConflicts?: NovelConflict[]
      pendingForeshadows?: NovelForeshadow[]
    },
  ): string {
    if (consecutiveClimaxes >= 2 && rhythm === 'breather') {
      return `最近已有 ${consecutiveClimaxes} 个连续高潮/转折章节，建议插入舒缓章节以避免读者疲劳`
    }

    // 故事状态感知的原因
    if (options?.activeConflicts) {
      const erupting = options.activeConflicts.filter(c => c.stage === 'erupting')
      if (erupting.length > 0 && rhythm === 'climax') {
        return `检测到 ${erupting.length} 个冲突处于爆发阶段（erupting），建议高潮章节释放冲突张力`
      }
      const reversing = options.activeConflicts.filter(c => c.stage === 'reversing')
      if (reversing.length > 0 && rhythm === 'twist') {
        return `检测到 ${reversing.length} 个冲突处于逆转阶段（reversing），建议转折章节制造突转`
      }
    }

    if (arcPosition < 0.2) {
      return `故事处于开篇阶段（弧位置 ${Math.round(arcPosition * 100)}%），建议 ${rhythm} 节奏建立基础`
    }
    if (arcPosition > 0.8) {
      return `故事接近尾声（弧位置 ${Math.round(arcPosition * 100)}%），建议 ${rhythm} 节奏收束故事`
    }
    return `故事处于 ${stage} 阶段（弧位置 ${Math.round(arcPosition * 100)}%），建议 ${rhythm} 节奏推进情节`
  }
}
