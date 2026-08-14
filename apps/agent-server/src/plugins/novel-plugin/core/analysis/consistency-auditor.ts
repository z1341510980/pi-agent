/**
 * 跨章节一致性审计
 *
 * 填补当前系统"无程序化全书扫描"的空白：
 * - Reviewer 只做单章审稿（10 维评分），不扫描全书
 * - runFullCalibration 每 10 章触发一次，但只看最近 5 章，且是 LLM 语义判断
 * - recordMemoryEvents 只做单章前后状态对比，不检测跨章矛盾
 *
 * 本模块提供 4 项程序化检查（确定性，无 LLM 调用）：
 * 1. 伏笔回收率：统计状态分布，标记急需回收（gap≥20）和即将过期（gap≥50）
 * 2. 钩子悬挂：找 thrown 但未 fulfilled 且未 abandoned 的钩子
 * 3. 孤儿实体：编排矩阵里有但正文未出现名字的角色/势力/地点
 * 4. 时间线矛盾：chapter.timeOffset 不单调递增
 *
 * 不做的检查（明确排除）：
 * - 角色名字漂移：需要 NLP/字符串相似度，成本高收益不确定
 * - 伏笔状态机合法性：Memory Agent 已有推断逻辑，重复检查无价值
 * - 信息差一致性：readerKnows/isRevealed 已由 recordMemoryEvents 监控
 */

import type { NovelStore } from '../novel-store.js'
import type {
  NovelChapter,
  ForeshadowStatus,
  ConsistencyReport,
  ForeshadowAudit,
  HookAudit,
  OrphanEntityAudit,
  TimelineAudit,
} from '@repo/shared/novel'

// 一致性审计 5 件套类型（ConsistencyReport/ForeshadowAudit/HookAudit/
// OrphanEntityAudit/TimelineAudit）已迁入 @repo/shared/novel 共享包，
// 此处 re-export 供本插件内部模块沿用相对路径引入。
export type {
  ConsistencyReport,
  ForeshadowAudit,
  HookAudit,
  OrphanEntityAudit,
  TimelineAudit,
} from '@repo/shared/novel'

/** 伏笔状态空模板 */
function emptyStatusCount(): Record<ForeshadowStatus, number> {
  return {
    planned: 0,
    planted: 0,
    reinforced: 0,
    partially_revealed: 0,
    recovering: 0,
    recovered: 0,
    abandoned: 0,
  }
}

/**
 * 跨章节一致性审计器
 *
 * 使用方式：
 * ```ts
 * const auditor = new ConsistencyAuditor(store)
 * const report = auditor.audit(projectId)
 * ```
 */
export class ConsistencyAuditor {
  /** 伏笔急需回收阈值：gap ≥ 20 章 */
  static readonly FORESHADOW_URGENT_GAP = 20
  /** 伏笔即将过期阈值：gap ≥ 50 章 */
  static readonly FORESHADOW_EXPIRED_GAP = 50
  /** 钩子悬挂阈值：gap ≥ 3 章未兑现 */
  static readonly HOOK_HANGING_GAP = 3

  constructor(private readonly store: NovelStore) {}

  /**
   * 执行完整审计
   *
   * @param projectId 项目 ID
   */
  audit(projectId: string): ConsistencyReport {
    const chapters = this.store.listChapters(projectId)
    const writtenChapters = chapters.filter((c) => c.content && c.content.trim().length > 0)
    const latestChapterNumber = writtenChapters.reduce((max, c) => Math.max(max, c.chapterNumber), 0)

    const foreshadow = this.auditForeshadow(projectId, latestChapterNumber)
    const hooks = this.auditHooks(projectId, latestChapterNumber)
    const orphanEntities = this.auditOrphanEntities(projectId, writtenChapters)
    const timeline = this.auditTimeline(chapters)

    const summary = this.buildSummary(foreshadow, hooks, orphanEntities, timeline)
    const healthScore = this.computeHealthScore(foreshadow, hooks, orphanEntities, timeline)

    return {
      projectId,
      generatedAt: Math.floor(Date.now() / 1000),
      totalChapters: chapters.length,
      writtenChapters: writtenChapters.length,
      foreshadow,
      hooks,
      orphanEntities,
      timeline,
      healthScore,
      summary,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 检查 1：伏笔回收率
  // ═══════════════════════════════════════════════════════════════

  private auditForeshadow(projectId: string, latestChapterNumber: number): ForeshadowAudit {
    const foreshadows = this.store.listForeshadowing(projectId)
    const byStatus = emptyStatusCount()
    for (const f of foreshadows) {
      byStatus[f.status]++
    }

    const urgent: ForeshadowAudit['urgent'] = []
    const expired: ForeshadowAudit['expired'] = []

    for (const f of foreshadows) {
      // 已回收或已废弃的不算
      if (f.status === 'recovered' || f.status === 'abandoned') continue

      // gap = 当前最新章节 - 首次埋设章节
      const firstChapter = f.firstChapter ?? f.beats?.[0]?.chapter ?? null
      if (firstChapter === null) continue
      const gap = latestChapterNumber - firstChapter

      if (gap >= ConsistencyAuditor.FORESHADOW_EXPIRED_GAP) {
        expired.push({
          id: f.id,
          description: f.description,
          gap,
          status: f.status,
          firstChapter,
        })
      } else if (gap >= ConsistencyAuditor.FORESHADOW_URGENT_GAP) {
        urgent.push({
          id: f.id,
          description: f.description,
          gap,
          status: f.status,
          firstChapter,
        })
      }
    }

    const total = foreshadows.length
    const recoveryRate = total > 0 ? byStatus.recovered / total : 0

    return {
      total,
      byStatus,
      recoveryRate,
      urgent: urgent.sort((a, b) => b.gap - a.gap),
      expired: expired.sort((a, b) => b.gap - a.gap),
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 检查 2：钩子悬挂
  // ═══════════════════════════════════════════════════════════════

  private auditHooks(projectId: string, latestChapterNumber: number): HookAudit {
    const hooks = this.store.listHooks(projectId)
    const fulfilled = hooks.filter((h) => h.status === 'fulfilled').length
    const hanging: HookAudit['hanging'] = []

    for (const h of hooks) {
      if (h.status !== 'thrown') continue
      const gap = latestChapterNumber - h.chapterNumber
      if (gap >= ConsistencyAuditor.HOOK_HANGING_GAP) {
        hanging.push({
          id: h.id,
          description: h.description,
          hookType: h.hookType,
          thrownAt: h.chapterNumber,
          gap,
        })
      }
    }

    return {
      total: hooks.length,
      fulfilledRate: hooks.length > 0 ? fulfilled / hooks.length : 0,
      hanging: hanging.sort((a, b) => b.gap - a.gap),
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 检查 3：孤儿实体（编排了但正文未出现名字）
  // ═══════════════════════════════════════════════════════════════

  private auditOrphanEntities(
    projectId: string,
    writtenChapters: NovelChapter[],
  ): OrphanEntityAudit {
    const characters = this.auditOrphanCharacters(projectId, writtenChapters)
    const factions = this.auditOrphanFactions(projectId, writtenChapters)
    const locations = this.auditOrphanLocations(projectId, writtenChapters)

    return { characters, factions, locations }
  }

  /** 检查角色：编排了（有 chapter_history）但正文未出现名字 */
  private auditOrphanCharacters(
    projectId: string,
    writtenChapters: NovelChapter[],
  ): OrphanEntityAudit['characters'] {
    const characters = this.store.listCharacters(projectId)
    const result: OrphanEntityAudit['characters'] = []

    for (const c of characters) {
      // 从 character_history 反查编排章节
      const history = this.store.listCharacterHistory(projectId, c.id)
      const arrangedChapters = [
        ...new Set(
          history
            .map((h) => h.chapterNumber)
            .filter((n): n is number => n !== null),
        ),
      ].sort((a, b) => a - b)

      if (arrangedChapters.length === 0) continue

      // 检查每个编排章节的正文是否包含角色名
      const missingChapters: number[] = []
      for (const chapterNumber of arrangedChapters) {
        const chapter = writtenChapters.find((ch) => ch.chapterNumber === chapterNumber)
        if (!chapter) continue // 章节未写，跳过
        if (!chapter.content.includes(c.name)) {
          missingChapters.push(chapterNumber)
        }
      }

      if (missingChapters.length > 0) {
        result.push({
          id: c.id,
          name: c.name,
          arrangedChapters,
          missingChapters,
        })
      }
    }

    return result
  }

  /** 检查势力：编排了（chapterSpans 非空）但正文未出现名字 */
  private auditOrphanFactions(
    projectId: string,
    writtenChapters: NovelChapter[],
  ): OrphanEntityAudit['factions'] {
    const factions = this.store.listFactions(projectId)
    const result: OrphanEntityAudit['factions'] = []

    for (const f of factions) {
      const arrangedChapters = this.expandSpans(f.chapterSpans)
      if (arrangedChapters.length === 0) continue

      const missingChapters: number[] = []
      for (const chapterNumber of arrangedChapters) {
        const chapter = writtenChapters.find((ch) => ch.chapterNumber === chapterNumber)
        if (!chapter) continue
        if (!chapter.content.includes(f.name)) {
          missingChapters.push(chapterNumber)
        }
      }

      if (missingChapters.length > 0) {
        result.push({
          id: f.id,
          name: f.name,
          arrangedChapters,
          missingChapters,
        })
      }
    }

    return result
  }

  /** 检查地点：编排了（appearChapters 非空）但正文未出现名字 */
  private auditOrphanLocations(
    projectId: string,
    writtenChapters: NovelChapter[],
  ): OrphanEntityAudit['locations'] {
    const locations = this.store.listLocations(projectId)
    const result: OrphanEntityAudit['locations'] = []

    for (const l of locations) {
      const arrangedChapters = l.appearChapters
      if (arrangedChapters.length === 0) continue

      const missingChapters: number[] = []
      for (const chapterNumber of arrangedChapters) {
        const chapter = writtenChapters.find((ch) => ch.chapterNumber === chapterNumber)
        if (!chapter) continue
        if (!chapter.content.includes(l.name)) {
          missingChapters.push(chapterNumber)
        }
      }

      if (missingChapters.length > 0) {
        result.push({
          id: l.id,
          name: l.name,
          arrangedChapters: [...arrangedChapters].sort((a, b) => a - b),
          missingChapters,
        })
      }
    }

    return result
  }

  // ═══════════════════════════════════════════════════════════════
  // 检查 4：时间线矛盾
  // ═══════════════════════════════════════════════════════════════

  private auditTimeline(chapters: NovelChapter[]): TimelineAudit {
    const sorted = [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber)
    const violations: TimelineAudit['violations'] = []

    let prevChapter: number | null = null
    let prevOffset: number | null = null

    for (const ch of sorted) {
      if (ch.timeOffset === null || ch.timeOffset === undefined) continue

      if (prevOffset !== null && prevChapter !== null && ch.timeOffset < prevOffset) {
        violations.push({
          chapter: ch.chapterNumber,
          timeOffset: ch.timeOffset,
          previousChapter: prevChapter,
          previousOffset: prevOffset,
        })
      }

      prevChapter = ch.chapterNumber
      prevOffset = ch.timeOffset
    }

    return {
      monotonic: violations.length === 0,
      violations,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 健康度评分与摘要
  // ═══════════════════════════════════════════════════════════════

  /**
   * 健康度评分（0-100）
   *
   * 权重分配：
   * - 伏笔回收率 30%
   * - 钩子兑现率 25%
   * - 孤儿实体（反向）25%
   * - 时间线单调性 20%
   */
  private computeHealthScore(
    foreshadow: ForeshadowAudit,
    hooks: HookAudit,
    orphanEntities: OrphanEntityAudit,
    timeline: TimelineAudit,
  ): number {
    // 伏笔：回收率 + 无过期项加分
    const foreshadowScore =
      foreshadow.total === 0
        ? 100 // 无伏笔视为满分
        : Math.round(
            (foreshadow.recoveryRate * 100) -
            (foreshadow.expired.length * 5) -
            (foreshadow.urgent.length * 2),
          )

    // 钩子：兑现率 - 悬挂扣分
    const hookScore =
      hooks.total === 0
        ? 100
        : Math.round(
            (hooks.fulfilledRate * 100) - (hooks.hanging.length * 5),
          )

    // 孤儿实体：每有一个扣 2 分
    const orphanCount =
      orphanEntities.characters.length +
      orphanEntities.factions.length +
      orphanEntities.locations.length
    const orphanScore = Math.max(0, 100 - orphanCount * 2)

    // 时间线：单调即满分，每个违反扣 10 分
    const timelineScore = Math.max(0, 100 - timeline.violations.length * 10)

    const total =
      foreshadowScore * 0.3 +
      hookScore * 0.25 +
      orphanScore * 0.25 +
      timelineScore * 0.2

    // 使用 floor 而非 round：任何扣分都应让分数下降，避免 99.5 舍入回 100 的边界
    return Math.max(0, Math.min(100, Math.floor(total)))
  }

  /** 生成关键问题摘要 */
  private buildSummary(
    foreshadow: ForeshadowAudit,
    hooks: HookAudit,
    orphanEntities: OrphanEntityAudit,
    timeline: TimelineAudit,
  ): string[] {
    const summary: string[] = []

    if (foreshadow.expired.length > 0) {
      summary.push(`⚠️ ${foreshadow.expired.length} 条伏笔已超过 ${ConsistencyAuditor.FORESHADOW_EXPIRED_GAP} 章未回收，即将过期`)
    }
    if (foreshadow.urgent.length > 0) {
      summary.push(`⏰ ${foreshadow.urgent.length} 条伏笔已超过 ${ConsistencyAuditor.FORESHADOW_URGENT_GAP} 章未回收，急需处理`)
    }
    if (foreshadow.total > 0) {
      summary.push(`伏笔回收率：${(foreshadow.recoveryRate * 100).toFixed(1)}% (${foreshadow.byStatus.recovered}/${foreshadow.total})`)
    }

    if (hooks.hanging.length > 0) {
      summary.push(`🪝 ${hooks.hanging.length} 个钩子悬挂超过 ${ConsistencyAuditor.HOOK_HANGING_GAP} 章未兑现`)
    }
    if (hooks.total > 0) {
      summary.push(`钩子兑现率：${(hooks.fulfilledRate * 100).toFixed(1)}%`)
    }

    const orphanCount =
      orphanEntities.characters.length +
      orphanEntities.factions.length +
      orphanEntities.locations.length
    if (orphanCount > 0) {
      summary.push(
        `👻 发现 ${orphanCount} 个孤儿实体（编排了但正文未出现）：` +
          `角色 ${orphanEntities.characters.length} / 势力 ${orphanEntities.factions.length} / 地点 ${orphanEntities.locations.length}`,
      )
    }

    if (!timeline.monotonic) {
      summary.push(`🕒 时间线有 ${timeline.violations.length} 处非单调递增`)
    }

    if (summary.length === 0) {
      summary.push('✅ 一致性检查全部通过')
    }

    return summary
  }

  /** 展开 [[1,3],[5,7]] 为 [1,2,3,5,6,7] */
  private expandSpans(spans: Array<[number, number]>): number[] {
    const result: number[] = []
    for (const [start, end] of spans) {
      for (let i = start; i <= end; i++) result.push(i)
    }
    return result
  }
}
