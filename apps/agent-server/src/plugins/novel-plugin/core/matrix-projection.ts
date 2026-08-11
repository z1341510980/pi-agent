/**
 * 矩阵投影对账（S4-1）。
 *
 * ## 背景
 *
 * "本章有哪些实体出场"这件事目前有**两个事实源**：
 *
 *   A. 实体的章节维度字段 —— 角色的 character_history、冲突/线索/势力/物品的 chapterSpans、
 *      伏笔的 beats、地点的 appearChapters。前端矩阵和 create-flow 的 arrangedEntities
 *      都从这里派生。
 *   B. 事件账本 —— novel_story_events + 其 entity refs + change records（带 dimension 的
 *      novel_memory_events）。账本视图、matrix-aggregation 从这里读。
 *
 * 两套靠约定同步，没有任何机制保证一致。已知的漂移来源包括：
 *   - ai-arrange 早期完全不写账本（已修）
 *   - 伏笔复用不落 beat（已修）
 *   - 手工编辑实体字段不产生账本记录（未修，属结构问题）
 *
 * S4 的目标是让账本成为唯一写入面、矩阵从账本派生。切换前必须先量化差异：
 * 这个模块把两套投影都算出来并逐条对账，供脚本和测试复用。
 *
 * ## 不做的事
 *
 * 只读、不修数据、不做"谁对谁错"的裁决。差异分两类输出，由人判断该补账本还是补投影。
 */
import type { ArrangedEntity } from './types.js'
import type { NovelStore } from './novel-store.js'
import type { NovelMemoryStore } from './novel-memory-store.js'
import {
  PROJECTION_ENTITY_TYPES,
  PROJECTION_TYPE_SET,
  chaptersOfClue,
  chaptersOfConflict,
  chaptersOfFaction,
  chaptersOfForeshadow,
  chaptersOfItem,
  chaptersOfLocation,
  chaptersOfNarrative,
  type ProjectionEntityType,
} from './chapter-projection-fields.js'

export { PROJECTION_ENTITY_TYPES, type ProjectionEntityType }

/** 一条"某实体在某章出场"的投影记录 */
export interface ChapterPresence {
  chapterNumber: number
  entityType: ProjectionEntityType
  entityId: string
  /** 人类可读名（对账报告用，避免只看 UUID） */
  entityName: string
  /** 该记录的来源说明（哪个字段 / 哪个 dimension） */
  source: string
  /** 实体是否仍存在于实体表（两侧都可能指向已删除实体） */
  entityExists: boolean
  /** 这条记录来自哪一侧 */
  side: 'entity-fields' | 'ledger'
}

export interface ProjectionSet {
  /** key = `${entityType}:${entityId}:${chapterNumber}` */
  keys: Set<string>
  byKey: Map<string, ChapterPresence>
}

export interface ReconcileReport {
  projectId: string
  projectTitle: string
  /** 项目章节范围（无章节时为 null） */
  chapterRange: [number, number] | null
  /** 两侧都有 */
  matchedCount: number
  /** 只在实体字段里有 → 账本缺这条记录 */
  missingInLedger: ChapterPresence[]
  /** 只在账本里有、且实体仍存在 → 实体的章节维度字段缺这条投影 */
  missingInEntityFields: ChapterPresence[]
  /**
   * 悬空引用：记录指向已不存在的实体（两侧都可能出现）。
   *
   * 与另外两类差异分开统计：它不能靠"补账本"或"补投影"解决（实体已删），
   * 修法是清理引用或恢复实体，属于数据治理而非同步问题。
   * 典型来源：删除实体时没有级联清理 character_history / change_records。
   */
  danglingRefs: ChapterPresence[]
  /** 按实体类型汇总，便于定位是哪一类实体在漏 */
  byEntityType: Record<ProjectionEntityType, {
    matched: number
    missingInLedger: number
    missingInEntityFields: number
    danglingRefs: number
  }>
}

function presenceKey(entityType: string, entityId: string, chapterNumber: number): string {
  return `${entityType}:${entityId}:${chapterNumber}`
}

function emptySet(): ProjectionSet {
  return { keys: new Set(), byKey: new Map() }
}

function add(
  set: ProjectionSet,
  entityType: ProjectionEntityType,
  entityId: string,
  entityName: string,
  chapterNumber: number,
  source: string,
  side: ChapterPresence['side'],
  entityExists = true,
): void {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return
  const key = presenceKey(entityType, entityId, chapterNumber)
  if (set.keys.has(key)) return
  set.keys.add(key)
  set.byKey.set(key, { chapterNumber, entityType, entityId, entityName, source, entityExists, side })
}

/**
 * 从实体的章节维度字段派生投影。
 *
 * 判据与前端 matrix-model / novel-workspace 的 collectArrangedEntities 保持一致：
 * 只把"实体真的在这一章有事发生"的章节算进来，不把跨度中间的空转章节算成出场。
 */
export function projectFromEntityFields(store: NovelStore, projectId: string): ProjectionSet {
  const set = emptySet()
  const S = 'entity-fields' as const

  // 角色：出场记录在 character_history（离散章节），没有 chapterSpans。
  // history 可能指向已删除角色（删除时未级联清理），这类记入悬空引用而不是正常出场。
  const characterNames = new Map<string, string>()
  for (const c of store.listCharacters(projectId)) characterNames.set(c.id, c.name)
  for (const entry of store.listCharacterHistory(projectId)) {
    if (entry.chapterNumber == null) continue
    const name = characterNames.get(entry.characterId)
    add(set, 'character', entry.characterId, name ?? `(实体已不存在 ${entry.characterId.slice(0, 8)})`,
      entry.chapterNumber, 'character_history.chapter_number', S, name != null)
  }

  for (const conflict of store.listConflicts(projectId)) {
    for (const n of chaptersOfConflict(conflict)) {
      add(set, 'conflict', conflict.id, conflict.description.slice(0, 30), n, 'conflict.chapter_spans', S)
    }
  }

  // 伏笔是离散事件链：只有 beats 里的章节算出场（beats 为空时退到埋设章）
  for (const foreshadow of store.listForeshadowing(projectId)) {
    const beatTypeByChapter = new Map((foreshadow.beats ?? []).map((beat) => [beat.chapter, beat.type]))
    for (const n of chaptersOfForeshadow(foreshadow)) {
      const beatType = beatTypeByChapter.get(n)
      add(set, 'foreshadow', foreshadow.id, foreshadow.description.slice(0, 30), n,
        beatType ? `foreshadow.beats(${beatType})` : 'foreshadow.first_chapter', S)
    }
  }

  for (const clue of store.listClues(projectId)) {
    for (const n of chaptersOfClue(clue)) {
      add(set, 'clue', clue.id, clue.description.slice(0, 30), n, 'clue.chapter_spans', S)
    }
  }

  for (const faction of store.listFactions(projectId)) {
    for (const n of chaptersOfFaction(faction)) {
      add(set, 'faction', faction.id, faction.name, n, 'faction.chapter_spans', S)
    }
  }

  for (const location of store.listLocations(projectId)) {
    for (const n of chaptersOfLocation(location)) {
      add(set, 'location', location.id, location.name, n, 'location.appear_chapters', S)
    }
  }

  for (const item of store.listItems(projectId)) {
    for (const n of chaptersOfItem(item)) {
      add(set, 'item', item.id, item.name, n, 'item.chapter_spans', S)
    }
  }

  for (const narrative of store.listNarratives(projectId)) {
    for (const n of chaptersOfNarrative(narrative)) {
      add(set, 'narrative', narrative.id, narrative.description.slice(0, 30), n, 'narrative.chapter_spans', S)
    }
  }

  return set
}

/**
 * 从事件账本派生投影。
 *
 * 两个来源：
 * - change records（带 dimension 的变化记录）：subject 在该章发生过变化 → 出场
 * - story event 的 entity refs：事件本身声明了参与实体 → 出场
 */
export function projectFromLedger(
  store: NovelStore,
  memoryStore: NovelMemoryStore,
  projectId: string,
): ProjectionSet {
  const set = emptySet()
  const resolve = buildEntityNameResolver(store, projectId)

  for (const change of memoryStore.listChangeRecords(projectId)) {
    if (!PROJECTION_TYPE_SET.has(change.subjectType)) continue
    const { name, exists } = resolve(change.subjectId)
    add(set, change.subjectType as ProjectionEntityType, change.subjectId, name,
      change.chapterNumber, `change_record(${change.dimension})`, 'ledger', exists)
  }

  for (const event of memoryStore.listStoryEvents(projectId)) {
    for (const ref of memoryStore.listStoryEventEntityRefs(event.id)) {
      if (!PROJECTION_TYPE_SET.has(ref.entityType)) continue
      const { name, exists } = resolve(ref.entityId)
      add(set, ref.entityType as ProjectionEntityType, ref.entityId, name,
        event.chapterNumber, `story_event(${event.type}/${ref.role})`, 'ledger', exists)
    }
  }

  return set
}

function buildEntityNameResolver(
  store: NovelStore,
  projectId: string,
): (entityId: string) => { name: string; exists: boolean } {
  const names = new Map<string, string>()
  for (const c of store.listCharacters(projectId)) names.set(c.id, c.name)
  for (const c of store.listConflicts(projectId)) names.set(c.id, c.description.slice(0, 30))
  for (const f of store.listForeshadowing(projectId)) names.set(f.id, f.description.slice(0, 30))
  for (const c of store.listClues(projectId)) names.set(c.id, c.description.slice(0, 30))
  for (const f of store.listFactions(projectId)) names.set(f.id, f.name)
  for (const l of store.listLocations(projectId)) names.set(l.id, l.name)
  for (const i of store.listItems(projectId)) names.set(i.id, i.name)
  return (entityId) => {
    const name = names.get(entityId)
    return name != null
      ? { name, exists: true }
      : { name: `(实体已不存在 ${entityId.slice(0, 8)})`, exists: false }
  }
}

/** 逐条对账两套投影 */
export function reconcileMatrixProjection(
  store: NovelStore,
  memoryStore: NovelMemoryStore,
  projectId: string,
): ReconcileReport {
  const project = store.getProject(projectId)
  const chapters = store.listChapters(projectId).map((c) => c.chapterNumber).filter((n) => Number.isInteger(n))
  const chapterRange: [number, number] | null = chapters.length > 0
    ? [Math.min(...chapters), Math.max(...chapters)]
    : null

  const fromFields = projectFromEntityFields(store, projectId)
  const fromLedger = projectFromLedger(store, memoryStore, projectId)

  const byEntityType = Object.fromEntries(
    PROJECTION_ENTITY_TYPES.map((type) => [type, {
      matched: 0, missingInLedger: 0, missingInEntityFields: 0, danglingRefs: 0,
    }]),
  ) as ReconcileReport['byEntityType']

  const missingInLedger: ChapterPresence[] = []
  const missingInEntityFields: ChapterPresence[] = []
  const danglingRefs: ChapterPresence[] = []
  let matchedCount = 0

  // 悬空引用优先归类：实体已删除时，"两侧是否一致"没有意义。
  for (const [key, presence] of fromFields.byKey) {
    if (!presence.entityExists) {
      danglingRefs.push(presence)
      byEntityType[presence.entityType].danglingRefs += 1
    } else if (fromLedger.keys.has(key)) {
      matchedCount += 1
      byEntityType[presence.entityType].matched += 1
    } else {
      missingInLedger.push(presence)
      byEntityType[presence.entityType].missingInLedger += 1
    }
  }
  for (const [key, presence] of fromLedger.byKey) {
    if (!presence.entityExists) {
      // 同一条悬空引用可能两侧都有，只记一次
      if (!fromFields.keys.has(key)) {
        danglingRefs.push(presence)
        byEntityType[presence.entityType].danglingRefs += 1
      }
      continue
    }
    if (fromFields.keys.has(key)) continue
    missingInEntityFields.push(presence)
    byEntityType[presence.entityType].missingInEntityFields += 1
  }

  const byChapterThenType = (a: ChapterPresence, b: ChapterPresence): number =>
    a.chapterNumber - b.chapterNumber
    || a.entityType.localeCompare(b.entityType)
    || a.entityName.localeCompare(b.entityName)
  missingInLedger.sort(byChapterThenType)
  missingInEntityFields.sort(byChapterThenType)
  danglingRefs.sort(byChapterThenType)

  return {
    projectId,
    projectTitle: project?.title ?? '(项目不存在或已删除)',
    chapterRange,
    matchedCount,
    missingInLedger,
    missingInEntityFields,
    danglingRefs,
    byEntityType,
  }
}

/** 把报告渲染成可读文本（脚本输出用） */
export function formatReconcileReport(report: ReconcileReport, options?: { maxRows?: number }): string {
  const maxRows = options?.maxRows ?? 40
  const total = report.matchedCount
    + report.missingInLedger.length
    + report.missingInEntityFields.length
    + report.danglingRefs.length
  const lines: string[] = []

  lines.push(`## ${report.projectTitle}`)
  lines.push(`项目 ID：${report.projectId}`)
  lines.push(`章节范围：${report.chapterRange ? `第 ${report.chapterRange[0]}-${report.chapterRange[1]} 章` : '（无章节）'}`)
  lines.push('')
  lines.push(`投影记录总数：${total}`)
  lines.push(`  两侧一致：${report.matchedCount}`)
  lines.push(`  账本缺记录（实体字段有、账本无）：${report.missingInLedger.length}`)
  lines.push(`  投影缺记录（账本有、实体字段无）：${report.missingInEntityFields.length}`)
  lines.push(`  悬空引用（记录指向已删除实体）：${report.danglingRefs.length}`)

  const agreement = total > 0 ? Math.round((report.matchedCount / total) * 1000) / 10 : 100
  lines.push(`  一致率：${agreement}%`)
  lines.push('')

  lines.push('| 实体类型 | 一致 | 账本缺 | 投影缺 | 悬空 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const type of PROJECTION_ENTITY_TYPES) {
    const row = report.byEntityType[type]
    const sum = row.matched + row.missingInLedger + row.missingInEntityFields + row.danglingRefs
    if (sum === 0) continue
    lines.push(`| ${type} | ${row.matched} | ${row.missingInLedger} | ${row.missingInEntityFields} | ${row.danglingRefs} |`)
  }

  const section = (title: string, rows: ChapterPresence[]): void => {
    if (rows.length === 0) return
    lines.push('')
    lines.push(`### ${title}（${rows.length} 条）`)
    for (const row of rows.slice(0, maxRows)) {
      lines.push(`- 第 ${row.chapterNumber} 章 · ${row.entityType} · ${row.entityName} ← ${row.source}（${row.side === 'ledger' ? '账本侧' : '实体字段侧'}）`)
    }
    if (rows.length > maxRows) lines.push(`- …其余 ${rows.length - maxRows} 条省略`)
  }
  section('账本缺记录', report.missingInLedger)
  section('投影缺记录', report.missingInEntityFields)
  section('悬空引用', report.danglingRefs)

  return lines.join('\n')
}

// ── S4-2：矩阵投影读路径 ──

/**
 * 章节投影的事实源。
 *
 * - `entity-fields`：从实体的章节维度字段派生（历史行为，默认）
 * - `ledger`：从事件账本派生（S4 目标）
 *
 * 用 flag 而不是直接切换：S4-1 的对账把一致率从 38.6% 提到 91%，
 * 但"账本有、实体字段无"仍有 12 条反向漂移需要人工判断。
 * flag 让切读可以随时回退，也便于在同一次请求里对比两种来源。
 */
export type ProjectionSource = 'entity-fields' | 'ledger'

export const DEFAULT_PROJECTION_SOURCE: ProjectionSource = 'entity-fields'

/**
 * 按指定事实源，构建某一章的 ArrangedEntity。
 *
 * 这是"本章有哪些实体出场"的**唯一服务端实现**。前端此前自己用
 * collectArrangedEntities 又算了一遍（第三份副本），正是 itemIds 长期丢失的同一类问题；
 * S4-2 让前端改为消费本函数的结果。
 *
 * 注意：characterFunctions（本章功能位）不落库，无法从任何事实源派生，
 * 仍由调用方（编排结果缓存）单独提供。
 */
export function buildArrangedEntitiesForChapter(
  store: NovelStore,
  memoryStore: NovelMemoryStore,
  projectId: string,
  chapterNumber: number,
  source: ProjectionSource = DEFAULT_PROJECTION_SOURCE,
): ArrangedEntity {
  const set = source === 'ledger'
    ? projectFromLedger(store, memoryStore, projectId)
    : projectFromEntityFields(store, projectId)

  const buckets: Record<ProjectionEntityType, string[]> = {
    character: [], conflict: [], foreshadow: [], clue: [], faction: [], location: [], item: [], narrative: [],
  }
  for (const presence of set.byKey.values()) {
    if (presence.chapterNumber !== chapterNumber) continue
    // 悬空引用不能进 arrangedEntities：下游会用 ID 反查实体，查不到只会污染 prompt
    if (!presence.entityExists) continue
    buckets[presence.entityType].push(presence.entityId)
  }

  return {
    characterIds: buckets.character,
    conflictIds: buckets.conflict,
    foreshadowIds: buckets.foreshadow,
    clueIds: buckets.clue,
    factionIds: buckets.faction,
    locationIds: buckets.location,
    itemIds: buckets.item,
  }
}
