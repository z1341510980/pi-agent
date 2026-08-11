/**
 * MigrationAcceptance：结构迁移验收报告（PRD §6.2 / 统一方案 §9）。
 *
 * 每个迁移任务（双写/对账/切读/停旧写/观察/删除）执行后，必须产出
 * 一份 MigrationAcceptance，其中 mismatchRows / orphanRows / duplicateRows
 * 验收要求 = 0，rollbackVerified 验收要求 = true。只读对账不能自行宣称已演练回滚。
 */

export interface MigrationAcceptance {
  /** 源表/源字段行数 */
  sourceRows: number
  /** 目标表/目标字段行数 */
  targetRows: number
  /** 对账不一致行数（验收要求 = 0） */
  mismatchRows: number
  /** 孤儿行数（验收要求 = 0） */
  orphanRows: number
  /** 重复行数（验收要求 = 0） */
  duplicateRows: number
  /** 已演练回滚（验收要求 = true；必须由实际演练结果提供） */
  rollbackVerified: boolean
}

export interface VersionChainReconcileReport extends MigrationAcceptance {
  /** 参与对账的章节数（新旧任一侧有版本数据的章节） */
  checkedChapters: number
  /** current_content_revision_id 指向正文与 novel_chapters.content 不一致的章节 */
  mismatchedChapters: Array<{ chapterId: string; oldHash: string; newHash: string }>
}

export interface SceneCastReconcileReport extends MigrationAcceptance {
  /** 参与对账的场景版本数 */
  checkedSceneRevisions: number
  /** 按角色区分的对账不一致数量（focus/present/functional） */
  mismatchByRole: Record<'focus' | 'present' | 'functional', number>
}

/**
 * 实体出场关系对账报告（P2 novel_entity_appearances）。
 *
 * 口径与 scripts/novel-migration-tools/reconcile-entity-appearances.mjs 一致：
 * 源 = 7 类实体表 chapter_spans / appear_chapters 展开且章节已落库的 (实体,章节) 对；
 * 目标 = appearance 表记录。只读对账 rollbackVerified 恒为 false（回滚需另行演练）。
 */
export interface AppearanceReconcileReport extends MigrationAcceptance {
  /** 参与对账的实体行数（spans 展开非空的实体） */
  checkedEntities: number
  /** spans 引用了尚未落库章节的条数（规划超前，不算 mismatch） */
  unpersistedRefs: number
  /** 实体级差异明细（最多 100 条） */
  details: Array<{
    entityType: string
    entityId: string
    /** 源有目标无（缺写）的章节号 */
    missingChapters: number[]
    /** 目标有源无（多余）的章节号 */
    extraChapters: number[]
  }>
}

/**
 * 判定验收是否通过：三项计数 = 0 且回滚已验证。
 */
export function isMigrationAccepted(report: MigrationAcceptance): boolean {
  return (
    report.mismatchRows === 0 &&
    report.orphanRows === 0 &&
    report.duplicateRows === 0 &&
    report.rollbackVerified === true
  )
}

/**
 * 生成一份可用于 CLI/日志打印的人类可读验收摘要。
 */
export function formatMigrationAcceptance(report: MigrationAcceptance): string {
  const lines = [
    `MigrationAcceptance{source=${report.sourceRows}, target=${report.targetRows}, mismatch=${report.mismatchRows}, orphan=${report.orphanRows}, duplicate=${report.duplicateRows}, rollbackVerified=${report.rollbackVerified}}`,
    `acceptance=${isMigrationAccepted(report) ? 'PASS' : 'FAIL'}`,
  ]
  return lines.join('\n')
}
