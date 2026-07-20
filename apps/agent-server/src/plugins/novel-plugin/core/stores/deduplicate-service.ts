/**
 * DeduplicateService：实体去重与相似度合并服务
 *
 * 从原 novel-store.ts 抽取（PR-5b 重构），负责：
 * - deduplicateEntities：按 name/description 完全相同扫描并合并重复实体
 * - mergeWithPlan：按 LLM 给出的相似度合并方案执行字段级合并
 *
 * 设计要点：
 * - 构造函数接收 StoreBundle，包含所有需要访问的 Store CRUD 方法引用
 * - 避免循环依赖，保持与各子 Store 解耦
 * - 所有写操作在事务中执行，保证原子性
 */

import type Database from 'better-sqlite3'
import type {
  NovelCharacter, NovelConflict, NovelForeshadow,
  NovelFaction, NovelLocation, NovelWorldElement,
  DeduplicateEntityKind, DeduplicateGroup, DeduplicateReport, SimilarityGroup,
} from '../types.js'
import { parseIdListSafe } from './store-utils.js'

/**
 * DeduplicateService 依赖的 Store 方法集合。
 * 由 NovelStore 在构造时注入，避免循环依赖。
 */
export interface StoreBundle {
  db: Database.Database
  deleteEdgesByEntity: (entityId: string) => number
  // 读方法
  getCharacter: (id: string) => NovelCharacter | undefined
  getConflict: (id: string) => NovelConflict | undefined
  getForeshadow: (id: string) => NovelForeshadow | undefined
  getFaction: (id: string) => NovelFaction | undefined
  getLocation: (id: string) => NovelLocation | undefined
  getWorldElement: (id: string) => NovelWorldElement | undefined
  listCharacters: (projectId: string) => NovelCharacter[]
  listConflicts: (projectId: string) => NovelConflict[]
  listForeshadowing: (projectId: string) => NovelForeshadow[]
  listFactions: (projectId: string) => NovelFaction[]
  listLocations: (projectId: string) => NovelLocation[]
  // 写方法
  updateCharacter: (id: string, patch: Partial<NovelCharacter>) => unknown
  updateConflict: (id: string, patch: Partial<NovelConflict>) => unknown
  updateForeshadow: (id: string, patch: Partial<NovelForeshadow>) => unknown
  updateFaction: (id: string, patch: Partial<NovelFaction>) => unknown
  updateLocation: (id: string, patch: Partial<NovelLocation>) => unknown
  updateWorldElement: (id: string, patch: Partial<NovelWorldElement>) => unknown
  deleteCharacter: (id: string) => boolean
  deleteConflict: (id: string) => boolean
  deleteForeshadow: (id: string) => boolean
  deleteFaction: (id: string) => boolean
  deleteLocation: (id: string) => boolean
  deleteWorldElement: (id: string) => boolean
  deleteCharacterHistoryByCharacter: (characterId: string) => number
}

export class DeduplicateService {
  constructor(private bundle: StoreBundle) {}

  /**
   * 扫描并合并重复实体。
   */
  deduplicateEntities(projectId: string, options?: { dryRun?: boolean }): DeduplicateReport {
    const dryRun = options?.dryRun ?? false
    const groups: DeduplicateGroup[] = []

    groups.push(...this.findDuplicateGroups(projectId, 'character'))
    groups.push(...this.findDuplicateGroups(projectId, 'conflict'))
    groups.push(...this.findDuplicateGroups(projectId, 'foreshadow'))
    groups.push(...this.findDuplicateGroups(projectId, 'faction'))
    groups.push(...this.findDuplicateGroups(projectId, 'location'))

    if (dryRun || groups.length === 0) {
      return { groups, totalRemoved: groups.reduce((s, g) => s + g.removed.length, 0) }
    }

    this.bundle.db.transaction(() => {
      for (const g of groups) {
        this.mergeDuplicateGroup(g)
      }
    })()

    return { groups, totalRemoved: groups.reduce((s, g) => s + g.removed.length, 0) }
  }

  mergeWithPlan(projectId: string, groups: SimilarityGroup[]): { totalMerged: number } {
    if (groups.length === 0) return { totalMerged: 0 }

    this.bundle.db.transaction(() => {
      for (const g of groups) {
        this.assertSimilarityGroupBelongsToProject(projectId, g)
        this.mergeSimilarityGroup(g)
      }
    })()

    return { totalMerged: groups.reduce((s, g) => s + g.removed.length, 0) }
  }

  private assertSimilarityGroupBelongsToProject(projectId: string, group: SimilarityGroup): void {
    const { kind, keptId, removed, fieldMerges } = group
    const ids = new Set<string>([keptId, ...removed.map((r) => r.id)])
    for (const fm of fieldMerges ?? []) {
      ids.add(fm.fromId)
    }
    for (const id of ids) {
      const entityProjectId = this.getEntityProjectId(kind, id)
      if (entityProjectId !== projectId) {
        throw new Error(`相似实体合并包含非当前项目实体：${kind}/${id}`)
      }
    }
  }

  private getEntityProjectId(kind: SimilarityGroup['kind'], id: string): string | undefined {
    switch (kind) {
      case 'character':
        return this.bundle.getCharacter(id)?.projectId
      case 'conflict':
        return this.bundle.getConflict(id)?.projectId
      case 'foreshadow':
        return this.bundle.getForeshadow(id)?.projectId
      case 'faction':
        return this.bundle.getFaction(id)?.projectId
      case 'location':
        return this.bundle.getLocation(id)?.projectId
      case 'world_element':
        return this.bundle.getWorldElement(id)?.projectId
    }
  }

  private mergeSimilarityGroup(group: SimilarityGroup): void {
    const { kind, keptId, removed, fieldMerges } = group
    const removedIds = removed.map((r) => r.id)

    if (fieldMerges && fieldMerges.length > 0) {
      this.applyFieldMerges(kind, keptId, fieldMerges)
    }

    this.retargetEdges(keptId, removedIds)

    switch (kind) {
      case 'character':
        this.mergeCharacterAssociations(keptId, removedIds)
        break
      case 'conflict':
        this.mergeConflictAssociations(keptId, removedIds)
        break
      case 'foreshadow':
        this.mergeForeshadowAssociations(keptId, removedIds)
        break
      case 'faction':
        this.mergeFactionAssociations(keptId, removedIds)
        break
      case 'location':
        this.mergeLocationAssociations(keptId, removedIds)
        break
      case 'world_element':
        break
    }

    for (const id of removedIds) {
      switch (kind) {
        case 'character':
          this.bundle.deleteCharacterHistoryByCharacter(id)
          this.bundle.deleteCharacter(id)
          break
        case 'conflict':
          this.bundle.deleteConflict(id)
          break
        case 'foreshadow':
          this.bundle.deleteForeshadow(id)
          break
        case 'faction':
          this.bundle.deleteFaction(id)
          break
        case 'location':
          this.bundle.deleteLocation(id)
          break
        case 'world_element':
          this.bundle.deleteWorldElement(id)
          break
      }
    }
  }

  private applyFieldMerges(
    kind: SimilarityGroup['kind'],
    keptId: string,
    fieldMerges: NonNullable<SimilarityGroup['fieldMerges']>,
  ): void {
    const byFromId = new Map<string, string[]>()
    for (const fm of fieldMerges) {
      const arr = byFromId.get(fm.fromId) ?? []
      arr.push(fm.field)
      byFromId.set(fm.fromId, arr)
    }

    for (const [fromId, fields] of byFromId) {
      switch (kind) {
        case 'character': {
          const patch = this.pickFields(this.bundle.getCharacter(fromId), fields)
          if (Object.keys(patch).length > 0) this.bundle.updateCharacter(keptId, patch)
          break
        }
        case 'conflict': {
          const patch = this.pickFields(this.bundle.getConflict(fromId), fields)
          if (Object.keys(patch).length > 0) this.bundle.updateConflict(keptId, patch)
          break
        }
        case 'foreshadow': {
          const patch = this.pickFields(this.bundle.getForeshadow(fromId), fields)
          if (Object.keys(patch).length > 0) this.bundle.updateForeshadow(keptId, patch)
          break
        }
        case 'faction': {
          const patch = this.pickFields(this.bundle.getFaction(fromId), fields)
          if (Object.keys(patch).length > 0) this.bundle.updateFaction(keptId, patch)
          break
        }
        case 'location': {
          const patch = this.pickFields(this.bundle.getLocation(fromId), fields)
          if (Object.keys(patch).length > 0) this.bundle.updateLocation(keptId, patch)
          break
        }
        case 'world_element': {
          const patch = this.pickFields(this.bundle.getWorldElement(fromId), fields)
          if (Object.keys(patch).length > 0) this.bundle.updateWorldElement(keptId, patch)
          break
        }
      }
    }
  }

  private pickFields<T extends object>(src: T | undefined, fields: string[]): Partial<T> {
    const patch: Partial<T> = {}
    if (!src) return patch
    const srcRecord = src as Record<string, unknown>
    const patchRecord = patch as Record<string, unknown>
    for (const f of fields) {
      if (f in srcRecord) patchRecord[f] = srcRecord[f]
    }
    return patch
  }

  private findDuplicateGroups(projectId: string, kind: DeduplicateEntityKind): DeduplicateGroup[] {
    type Unified = { id: string; name: string; createdAt: number }
    let entities: Unified[] = []
    switch (kind) {
      case 'character':
        entities = this.bundle.listCharacters(projectId).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt }))
        break
      case 'conflict':
        entities = this.bundle.listConflicts(projectId).map((c) => ({ id: c.id, name: c.description, createdAt: c.createdAt }))
        break
      case 'foreshadow':
        entities = this.bundle.listForeshadowing(projectId).map((f) => ({ id: f.id, name: f.description, createdAt: f.createdAt }))
        break
      case 'faction':
        entities = this.bundle.listFactions(projectId).map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt }))
        break
      case 'location':
        entities = this.bundle.listLocations(projectId).map((l) => ({ id: l.id, name: l.name, createdAt: l.createdAt }))
        break
    }

    const byKey = new Map<string, Unified[]>()
    const isNamedKind = kind === 'character' || kind === 'faction' || kind === 'location'
    for (const e of entities) {
      const raw = e.name?.trim() ?? ''
      if (!raw) continue
      const key = isNamedKind ? raw.toLowerCase() : raw
      const arr = byKey.get(key) ?? []
      arr.push(e)
      byKey.set(key, arr)
    }

    const groups: DeduplicateGroup[] = []
    for (const [, arr] of byKey) {
      if (arr.length < 2) continue
      arr.sort((a, b) => a.createdAt - b.createdAt)
      const kept = arr[0]
      const removed = arr.slice(1)
      groups.push({
        kind,
        key: arr[0].name,
        keptId: kept.id,
        keptName: kept.name,
        removed: removed.map((e) => ({ id: e.id, name: e.name, createdAt: e.createdAt })),
      })
    }
    return groups
  }

  private mergeDuplicateGroup(group: DeduplicateGroup): void {
    const { kind, keptId, removed } = group
    const removedIds = removed.map((r) => r.id)

    this.retargetEdges(keptId, removedIds)

    switch (kind) {
      case 'character':
        this.mergeCharacterAssociations(keptId, removedIds)
        break
      case 'conflict':
        this.mergeConflictAssociations(keptId, removedIds)
        break
      case 'foreshadow':
        this.mergeForeshadowAssociations(keptId, removedIds)
        break
      case 'faction':
        this.mergeFactionAssociations(keptId, removedIds)
        break
      case 'location':
        this.mergeLocationAssociations(keptId, removedIds)
        break
    }

    for (const id of removedIds) {
      switch (kind) {
        case 'character':
          this.bundle.deleteCharacterHistoryByCharacter(id)
          this.bundle.deleteCharacter(id)
          break
        case 'conflict':
          this.bundle.deleteConflict(id)
          break
        case 'foreshadow':
          this.bundle.deleteForeshadow(id)
          break
        case 'faction':
          this.bundle.deleteFaction(id)
          break
        case 'location':
          this.bundle.deleteLocation(id)
          break
      }
    }
  }

  private retargetEdges(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const db = this.bundle.db
    const placeholders = removedIds.map(() => '?').join(',')
    db.prepare(
      `DELETE FROM novel_edges WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`,
    ).run(...removedIds, ...removedIds)
    db.prepare(
      `DELETE FROM novel_edges WHERE (source_id = ? AND target_id IN (${placeholders}))
       OR (source_id IN (${placeholders}) AND target_id = ?)`,
    ).run(keptId, ...removedIds, ...removedIds, keptId)
    db.prepare(
      `UPDATE novel_edges SET source_id = ? WHERE source_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
    db.prepare(
      `UPDATE novel_edges SET target_id = ? WHERE target_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
  }

  private mergeCharacterAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const db = this.bundle.db
    const placeholders = removedIds.map(() => '?').join(',')

    db.prepare(
      `UPDATE novel_character_history SET character_id = ? WHERE character_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)

    db.prepare(
      `DELETE FROM novel_relationships WHERE character_a IN (${placeholders}) AND character_b IN (${placeholders})`,
    ).run(...removedIds, ...removedIds)
    db.prepare(
      `DELETE FROM novel_relationships WHERE (character_a = ? AND character_b IN (${placeholders}))
       OR (character_a IN (${placeholders}) AND character_b = ?)`,
    ).run(keptId, ...removedIds, ...removedIds, keptId)
    db.prepare(
      `UPDATE novel_relationships SET character_a = ? WHERE character_a IN (${placeholders})`,
    ).run(keptId, ...removedIds)
    db.prepare(
      `UPDATE novel_relationships SET character_b = ? WHERE character_b IN (${placeholders})`,
    ).run(keptId, ...removedIds)

    this.retargetJsonArrayField(
      'novel_conflicts', 'participants',
      keptId, removedIds,
    )

    db.prepare(
      `UPDATE novel_factions SET leader_id = ? WHERE leader_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
  }

  private mergeConflictAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    this.retargetJsonArrayField(
      'novel_characters', 'participating_conflicts',
      keptId, removedIds,
    )
  }

  private mergeForeshadowAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const db = this.bundle.db
    const placeholders = removedIds.map(() => '?').join(',')

    db.prepare(
      `UPDATE novel_clues SET linked_foreshadow = ? WHERE linked_foreshadow IN (${placeholders})`,
    ).run(keptId, ...removedIds)

    this.retargetJsonArrayField(
      'novel_information_layers', 'linked_foreshadows',
      keptId, removedIds,
    )
  }

  private mergeFactionAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const db = this.bundle.db
    const placeholders = removedIds.map(() => '?').join(',')
    db.prepare(
      `UPDATE novel_locations SET faction_id = ? WHERE faction_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
  }

  private mergeLocationAssociations(keptId: string, removedIds: string[]): void {
    if (removedIds.length === 0) return
    const db = this.bundle.db
    const placeholders = removedIds.map(() => '?').join(',')
    db.prepare(
      `UPDATE novel_locations SET parent_id = ? WHERE parent_id IN (${placeholders})`,
    ).run(keptId, ...removedIds)
  }

  private retargetJsonArrayField(
    table: string,
    field: string,
    keptId: string,
    removedIds: string[],
  ): void {
    if (removedIds.length === 0) return
    const db = this.bundle.db
    const likeClauses = removedIds.map(() => `${field} LIKE ?`).join(' OR ')
    const likeParams = removedIds.map((id) => `%"${id}"%`)
    const rows = db.prepare(
      `SELECT id, ${field} as arr FROM ${table} WHERE ${likeClauses}`,
    ).all(...likeParams) as Array<{ id: string; arr: string | null }>

    const updateStmt = db.prepare(
      `UPDATE ${table} SET ${field} = ? WHERE id = ?`,
    )
    for (const row of rows) {
      const ids = parseIdListSafe(row.arr)
      const next = ids.filter((id) => !removedIds.includes(id))
      if (ids.some((id) => removedIds.includes(id))) {
        if (!next.includes(keptId)) next.push(keptId)
        updateStmt.run(JSON.stringify(next), row.id)
      }
    }
  }
}
