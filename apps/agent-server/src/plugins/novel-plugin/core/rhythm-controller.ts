import type { ChapterRhythm, RhythmModel, RhythmSuggestion, RhythmHistoryEntry, StoryStage } from './types.js'

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
 */
export class RhythmController {
  /** 默认节奏模型（标准三幕剧） */
  static readonly DEFAULT_MODEL: RhythmModel = {
    id: 'standard-three-act',
    name: '标准三幕剧',
    description: '三幕剧结构，适合中长篇小说',
    sequence: [
      'setup',      // 1
      'setup',      // 2
      'rising',     // 3
      'breather',   // 4
      'rising',     // 5
      'climax',     // 6 小高潮
      'falling',    // 7
      'rising',     // 8
      'breather',   // 9
      'rising',     // 10
      'rising',     // 11
      'climax',     // 12 大高潮
      'falling',    // 13
      'resolution', // 14
    ],
  }

  /** 网文节奏模型（更快节奏，频繁高潮） */
  static readonly WEBNOVEL_MODEL: RhythmModel = {
    id: 'webnovel-fast',
    name: '网文快节奏',
    description: '每3-4章一个小高潮，适合网文连载',
    sequence: [
      'setup',      // 1
      'rising',     // 2
      'climax',     // 3 小高潮
      'breather',   // 4
      'rising',     // 5
      'climax',     // 6 小高潮
      'breather',   // 7
      'twist',      // 8 转折
      'rising',     // 9
      'climax',     // 10 中高潮
      'falling',    // 11
      'rising',     // 12
      'climax',     // 13 大高潮
      'resolution', // 14
    ],
  }

  /** 所有可用节奏模型 */
  static readonly MODELS: RhythmModel[] = [
    RhythmController.DEFAULT_MODEL,
    RhythmController.WEBNOVEL_MODEL,
  ]

  /**
   * 建议下一章的节奏
   */
  suggestRhythm(
    currentChapter: number,
    storyStage: StoryStage,
    history: RhythmHistoryEntry[],
    model: RhythmModel = RhythmController.DEFAULT_MODEL,
  ): RhythmSuggestion {
    // 1. 从节奏模型中获取建议
    const modelIndex = (currentChapter - 1) % model.sequence.length
    const modelRhythm = model.sequence[modelIndex]

    // 2. 计算弧位置（0-1）
    const arcPosition = Math.min(currentChapter / model.sequence.length, 1)

    // 3. 检查最近是否有连续高潮（需要插入舒缓）
    const recentRhythms = history.slice(-3).map(h => h.rhythm)
    const consecutiveClimaxes = recentRhythms.filter(r => r === 'climax' || r === 'twist').length
    const finalRhythm = consecutiveClimaxes >= 2 && modelRhythm !== 'breather' ? 'breather' : modelRhythm

    // 4. 生成原因描述
    const reason = this.generateReason(finalRhythm, storyStage, consecutiveClimaxes, arcPosition)

    return {
      rhythm: finalRhythm,
      arcPosition,
      reason,
      description: this.getRhythmDescription(finalRhythm),
    }
  }

  /** 获取节奏描述（供 LLM 参考） */
  private getRhythmDescription(rhythm: ChapterRhythm): string {
    const descriptions: Record<ChapterRhythm, string> = {
      setup: '本章为铺垫章节。重点介绍背景、人物设定、世界观。节奏舒缓，信息密度适中，为后续冲突埋下伏笔。',
      rising: '本章为上升章节。推进冲突，加剧紧张感。角色面临挑战，局势逐渐升级。',
      climax: '本章为高潮章节。冲突爆发，情节达到转折点。情感强度最高，关键真相揭露或决战发生。',
      falling: '本章为下降章节。处理高潮后的后果，角色消化事件，关系调整。',
      resolution: '本章为收束章节。解决悬而未决的线索，回到新的平衡。为下一弧线做铺垫。',
      twist: '本章为转折章节。意料之外的走向，颠覆读者预期。保持紧张感但方向突变。',
      breather: '本章为舒缓章节。紧张之间的缓冲，角色互动、日常场景，为下一个上升积蓄力量。',
    }
    return descriptions[rhythm]
  }

  /** 生成建议原因 */
  private generateReason(
    rhythm: ChapterRhythm,
    stage: StoryStage,
    consecutiveClimaxes: number,
    arcPosition: number,
  ): string {
    if (consecutiveClimaxes >= 2 && rhythm === 'breather') {
      return `最近已有 ${consecutiveClimaxes} 个连续高潮/转折章节，建议插入舒缓章节以避免读者疲劳`
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
