/**
 * 把 novel 项目的落库状态序列化成稳定快照文本。
 *
 * 用途：`generateAndArrange` 结构重构（抽 EntityArrangeStrategy）时的护栏。
 * 编排会写 7 类实体的章节维度字段 + 角色历史 + 事件账本，散落在十几张表里，
 * 只靠逐条 expect 无法覆盖；用整体快照才能发现"改了一类实体、漏了另一类"。
 *
 * 稳定化处理（否则快照每次都变）：
 * - 新建实体的 randomUUID → `«new-1»`、`«new-2»`（按确定顺序首次出现时分配）
 * - fixture 里的固定 ID → `«fx:名字»`，让 diff 可读
 * - createdAt / updatedAt 一律剔除
 */
import type { NovelStore } from '../../core/novel-store.js'
import type { NovelMemoryStore } from '../../core/novel-memory-store.js'

const VOLATILE_KEYS = new Set(['createdAt', 'updatedAt'])

/** UUID 或 fixture 风格的长 ID */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class IdRegistry {
  private readonly known = new Map<string, string>()
  private nextIndex = 1

  constructor(fixtureIds: Record<string, string>) {
    for (const [name, id] of Object.entries(fixtureIds)) {
      this.known.set(id, `«fx:${name}»`)
    }
  }

  resolve(value: string): string {
    const existing = this.known.get(value)
    if (existing) return existing
    if (!ID_PATTERN.test(value)) return value
    const placeholder = `«new-${this.nextIndex}»`
    this.nextIndex += 1
    this.known.set(value, placeholder)
    return placeholder
  }

  /** 递归替换对象里所有出现过的 ID（含嵌在 JSON 字符串字段里的） */
  normalize(input: unknown): unknown {
    if (typeof input === 'string') {
      const direct = this.resolve(input)
      if (direct !== input) return direct
      // participants 这类字段是 JSON 字符串，里面也埋着 ID
      let replaced = input
      for (const [id, placeholder] of this.known) {
        if (replaced.includes(id)) replaced = replaced.split(id).join(placeholder)
      }
      return replaced
    }
    if (Array.isArray(input)) return input.map((item) => this.normalize(item))
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        if (VOLATILE_KEYS.has(key)) continue
        out[key] = this.normalize((input as Record<string, unknown>)[key])
      }
      return out
    }
    return input
  }
}

/**
 * 单独归一化任意结构里的 ID（用于 ArrangedEntity 这类返回值快照）。
 *
 * 新建实体的 ID 是 randomUUID，直接进快照会导致每次运行都 diff。
 */
export function normalizeForSnapshot(value: unknown, fixtureIds: Record<string, string>): unknown {
  return new IdRegistry(fixtureIds).normalize(value)
}

export interface DumpOptions {
  /** fixture 的固定 ID 表，用于生成可读占位符 */
  fixtureIds: Record<string, string>
  /** 只 dump 这些章节的账本记录（避免把无关历史带进快照） */
  ledgerChapters?: number[]
}

/**
 * 生成确定性状态快照。
 *
 * 排序策略：先按"稳定业务键"排（名字 / 描述前 60 字 / 章节号），
 * 不用 ID 排——ID 是随机的，用它排会让快照顺序随机。
 */
export function dumpNovelState(
  store: NovelStore,
  memoryStore: NovelMemoryStore,
  projectId: string,
  options: DumpOptions,
): string {
  const registry = new IdRegistry(options.fixtureIds)
  const byName = <T extends { name: string }>(list: T[]): T[] =>
    [...list].sort((a, b) => a.name.localeCompare(b.name))
  const byDescription = <T extends { description: string }>(list: T[]): T[] =>
    [...list].sort((a, b) => a.description.localeCompare(b.description))

  const characters = byName(store.listCharacters(projectId))
  const conflicts = byDescription(store.listConflicts(projectId))
  const foreshadows = byDescription(store.listForeshadowing(projectId))
  const clues = byDescription(store.listClues(projectId))
  const factions = byName(store.listFactions(projectId))
  const locations = byName(store.listLocations(projectId))
  const items = byName(store.listItems(projectId))

  // 先按业务顺序过一遍角色/实体，让 «new-N» 的编号稳定
  const history = store.listCharacterHistory(projectId)
    .map((entry) => ({
      characterId: entry.characterId,
      chapterNumber: entry.chapterNumber,
      fieldName: entry.fieldName,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      reason: entry.reason,
    }))
    .sort((a, b) =>
      (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0)
      || (a.newValue ?? '').localeCompare(b.newValue ?? '')
      || (a.reason ?? '').localeCompare(b.reason ?? ''))

  const ledgerChapters = options.ledgerChapters ?? []
  const storyEvents = ledgerChapters
    .flatMap((chapterNumber) => memoryStore.listStoryEvents(projectId, { chapterNumber }))
    .map((event) => ({
      chapterNumber: event.chapterNumber,
      type: event.type,
      title: event.title,
      summary: event.summary,
      outcome: event.outcome,
      status: event.status,
      source: event.source,
    }))
    .sort((a, b) => a.chapterNumber - b.chapterNumber || a.title.localeCompare(b.title))

  const changeRecords = ledgerChapters
    .flatMap((chapterNumber) => memoryStore.listChangeRecords(projectId, { chapterNumber }))
    .map((change) => ({
      chapterNumber: change.chapterNumber,
      subjectType: change.subjectType,
      subjectId: change.subjectId,
      dimension: change.dimension,
      valueType: change.valueType,
      beforeValue: change.beforeValue,
      afterValue: change.afterValue,
      reason: change.reason,
      significance: change.significance,
      source: change.source,
    }))
    .sort((a, b) =>
      a.chapterNumber - b.chapterNumber
      || a.dimension.localeCompare(b.dimension)
      || a.reason.localeCompare(b.reason))

  const payload = {
    characters: characters.map((c) => ({
      name: c.name,
      description: c.description,
      currentState: c.currentState,
      currentGoal: c.currentGoal,
      currentPressure: c.currentPressure,
      arcStage: c.arcStage,
      arcHistory: c.arcHistory,
      plotRole: c.plotRole,
      isProtagonist: c.isProtagonist,
      longTermDesire: c.longTermDesire,
    })),
    conflicts: conflicts.map((c) => ({
      description: c.description,
      stage: c.stage,
      intensity: c.intensity,
      tier: c.tier,
      chapterSpans: c.chapterSpans,
      participants: c.participants,
      currentStep: c.currentStep,
      nextStep: c.nextStep,
    })),
    foreshadows: foreshadows.map((f) => ({
      description: f.description,
      status: f.status,
      firstChapter: f.firstChapter,
      lastChapter: f.lastChapter,
      recoverByChapter: f.recoverByChapter,
      chapterSpans: f.chapterSpans,
      beats: f.beats,
    })),
    clues: clues.map((c) => ({
      description: c.description,
      progress: c.progress,
      currentStep: c.currentStep,
      nextStep: c.nextStep,
      chapterSpans: c.chapterSpans,
    })),
    factions: factions.map((f) => ({
      name: f.name,
      status: f.status,
      strength: f.strength,
      chapterSpans: f.chapterSpans,
    })),
    locations: locations.map((l) => ({
      name: l.name,
      status: l.status,
      firstChapter: l.firstChapter,
      appearChapters: l.appearChapters,
    })),
    items: items.map((it) => ({
      name: it.name,
      status: it.status,
      ownerId: it.ownerId,
      abilities: it.abilities,
      firstChapter: it.firstChapter,
      chapterSpans: it.chapterSpans,
    })),
    characterHistory: history,
    storyEvents,
    changeRecords,
  }

  return JSON.stringify(registry.normalize(payload), null, 2)
}
