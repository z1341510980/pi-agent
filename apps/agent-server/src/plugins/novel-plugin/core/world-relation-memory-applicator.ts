import { randomUUID } from 'node:crypto'
import type {
  NovelCharacter,
  NovelFaction,
  NovelItem,
  NovelLocation,
  NovelRelationship,
  RelationChange
} from './types.js'
import {
  auditOp,
  ensureString,
  fieldsAfter,
  fieldsBefore,
  type MemoryApplyContext
} from './memory-change-support.js'

export interface FactionUpdateInput {
  name?: string
  status?: string
  strength?: string
}

export interface LocationUpdateInput {
  name?: string
  status?: string
}

export interface ItemUpdateInput {
  name?: string
  ownerName?: string
  status?: string
  abilities?: string
  description?: string
}

export interface ItemCreateInput {
  name?: string
  description?: string
  type?: string
  ownerName?: string
  status?: string
  abilities?: string
  origin?: string
}

export interface RelationshipUpdateInput {
  characterA?: string
  characterB?: string
  currentStage?: string
  dynamicRole?: string
  alignment?: string
  trend?: string
  chapterHint?: string
  changeReason?: string
}

export interface RelationshipCreateInput {
  characterA?: string
  characterB?: string
  relationType?: string
  currentStage?: string
  dynamicRole?: string
  alignment?: string
  trend?: string
  chapterHint?: string
}

export interface WorldRelationMemoryChanges {
  factionUpdates?: FactionUpdateInput[]
  locationUpdates?: LocationUpdateInput[]
  itemUpdates?: ItemUpdateInput[]
  itemCreates?: ItemCreateInput[]
  relationshipUpdates?: RelationshipUpdateInput[]
  relationshipCreates?: RelationshipCreateInput[]
}

export interface WorldRelationMemoryApplyStats {
  factionUpdatesApplied: number
  locationUpdatesApplied: number
  itemUpdatesApplied: number
  itemCreatesApplied: number
  relationshipUpdatesApplied: number
  relationshipCreatesApplied: number
}

const validItemStatuses = ['active', 'lost', 'destroyed', 'transformed', 'sealed', 'transferred']
const validItemTypes = [
  'weapon',
  'armor',
  'artifact',
  'consumable',
  'key',
  'material',
  'info',
  'misc'
]
const validAlignments = [
  'ally',
  'temporary_ally',
  'opponent',
  'temporary_opponent',
  'neutral',
  'pending_shift'
]
const validTrends = ['stable', 'warming', 'cooling', 'breaking', 'reconciling']

export function applyWorldRelationMemoryChanges(
  context: MemoryApplyContext,
  changes: WorldRelationMemoryChanges
): WorldRelationMemoryApplyStats {
  const stats: WorldRelationMemoryApplyStats = {
    factionUpdatesApplied: 0,
    locationUpdatesApplied: 0,
    itemUpdatesApplied: 0,
    itemCreatesApplied: 0,
    relationshipUpdatesApplied: 0,
    relationshipCreatesApplied: 0
  }

  applyFactionUpdates(context, changes.factionUpdates ?? [], stats)
  applyLocationUpdates(context, changes.locationUpdates ?? [], stats)
  applyItemUpdates(context, changes.itemUpdates ?? [], stats)
  applyItemCreates(context, changes.itemCreates ?? [], stats)
  applyRelationshipUpdates(context, changes.relationshipUpdates ?? [], stats)
  applyRelationshipCreates(context, changes.relationshipCreates ?? [], stats)
  return stats
}

function applyFactionUpdates(
  context: MemoryApplyContext,
  changes: FactionUpdateInput[],
  stats: WorldRelationMemoryApplyStats
): void {
  for (const item of changes) {
    const faction = findByName(context.store.listFactions(context.projectId), item.name)
    if (!faction) {
      context.logger.warn(
        { name: item.name, projectId: context.projectId },
        '记忆 Agent：未找到要更新的势力，跳过'
      )
      continue
    }
    const patch: Partial<NovelFaction> = {}
    if (item.status !== undefined)
      patch.status = ensureString(item.status, faction.status) as NovelFaction['status']
    if (item.strength !== undefined)
      patch.strength = ensureString(item.strength, faction.strength) as NovelFaction['strength']
    if (Object.keys(patch).length === 0) continue

    const updated = context.store.updateFaction(faction.id, patch)
    stats.factionUpdatesApplied++
    context.audit?.push(
      auditOp().update(
        'faction',
        faction.id,
        fieldsBefore(faction, patch),
        fieldsAfter(updated, patch),
        'memory-generator.applyChanges'
      )
    )
  }
}

function applyLocationUpdates(
  context: MemoryApplyContext,
  changes: LocationUpdateInput[],
  stats: WorldRelationMemoryApplyStats
): void {
  for (const item of changes) {
    const location = findByName(context.store.listLocations(context.projectId), item.name)
    if (!location) {
      context.logger.warn(
        { name: item.name, projectId: context.projectId },
        '记忆 Agent：未找到要更新的地点，跳过'
      )
      continue
    }
    const patch: Partial<NovelLocation> = {}
    if (item.status !== undefined)
      patch.status = ensureString(item.status, location.status) as NovelLocation['status']
    if (Object.keys(patch).length === 0) continue

    const updated = context.store.updateLocation(location.id, patch)
    stats.locationUpdatesApplied++
    context.audit?.push(
      auditOp().update(
        'location',
        location.id,
        fieldsBefore(location, patch),
        fieldsAfter(updated, patch),
        'memory-generator.applyChanges'
      )
    )
  }
}

function applyItemUpdates(
  context: MemoryApplyContext,
  changes: ItemUpdateInput[],
  stats: WorldRelationMemoryApplyStats
): void {
  for (const item of changes) {
    const existing = findByName(context.store.listItems(context.projectId), item.name)
    if (!existing) {
      context.logger.warn(
        { name: item.name, projectId: context.projectId },
        '记忆 Agent：未找到要更新的物品，跳过'
      )
      continue
    }
    const patch: Partial<NovelItem> = {}
    if (item.ownerName !== undefined) {
      const ownerName = item.ownerName.trim()
      if (ownerName === '') {
        patch.ownerId = null
      } else {
        const owner = findCharacterByName(context, ownerName)
        if (owner) {
          patch.ownerId = owner.id
        } else {
          context.logger.warn(
            { name: item.name, ownerName, projectId: context.projectId },
            '记忆 Agent：物品转手但未找到新持有者角色，跳过 owner 变更'
          )
        }
      }
    }
    if (item.status !== undefined) {
      const status = ensureString(item.status, existing.status)
      patch.status = (
        validItemStatuses.includes(status) ? status : existing.status
      ) as NovelItem['status']
    }
    if (item.abilities !== undefined)
      patch.abilities = ensureString(item.abilities, existing.abilities)
    if (item.description !== undefined)
      patch.description = ensureString(item.description, existing.description)
    if (
      context.chapterNumber !== undefined &&
      !existing.chapterSpans.some(
        ([start, end]) => context.chapterNumber! >= start && context.chapterNumber! <= end
      )
    ) {
      patch.chapterSpans = [
        ...existing.chapterSpans,
        [context.chapterNumber, context.chapterNumber] as [number, number]
      ].sort((left, right) => left[0] - right[0])
    }
    if (Object.keys(patch).length === 0) continue

    const updated = context.store.updateItem(existing.id, patch)
    stats.itemUpdatesApplied++
    context.audit?.push(
      auditOp().update(
        'item',
        existing.id,
        fieldsBefore(existing, patch),
        fieldsAfter(updated, patch),
        'memory-generator.applyChanges'
      )
    )
  }
}

function applyItemCreates(
  context: MemoryApplyContext,
  changes: ItemCreateInput[],
  stats: WorldRelationMemoryApplyStats
): void {
  for (const item of changes) {
    if (!item.name?.trim()) continue
    if (findByName(context.store.listItems(context.projectId), item.name)) {
      context.logger.warn(
        { name: item.name, projectId: context.projectId },
        '记忆 Agent：物品已存在，跳过创建（如需更新请用 itemUpdates）'
      )
      continue
    }

    let ownerId: string | null = null
    const ownerName = (item.ownerName ?? '').trim()
    if (ownerName !== '') {
      const owner = findCharacterByName(context, ownerName)
      if (owner) {
        ownerId = owner.id
      } else {
        context.logger.warn(
          { name: item.name, ownerName, projectId: context.projectId },
          '记忆 Agent：新建物品但未找到持有者角色，物品按无主入库'
        )
      }
    }
    const itemType = ensureString(item.type, 'misc')
    const itemStatus = ensureString(item.status, 'active')
    const created = context.store.createItem({
      id: randomUUID(),
      projectId: context.projectId,
      name: item.name.trim(),
      description: ensureString(item.description, ''),
      type: (validItemTypes.includes(itemType) ? itemType : 'misc') as NovelItem['type'],
      ownerId,
      status: (validItemStatuses.includes(itemStatus)
        ? itemStatus
        : 'active') as NovelItem['status'],
      abilities: ensureString(item.abilities, ''),
      origin: ensureString(item.origin, ''),
      firstChapter: context.chapterNumber ?? null,
      chapterSpans:
        context.chapterNumber !== undefined ? [[context.chapterNumber, context.chapterNumber]] : []
    })
    stats.itemCreatesApplied++
    context.audit?.push(
      auditOp().create(
        'item',
        created.id,
        { name: created.name, type: created.type },
        'memory-generator.applyChanges'
      )
    )
  }
}

function applyRelationshipUpdates(
  context: MemoryApplyContext,
  changes: RelationshipUpdateInput[],
  stats: WorldRelationMemoryApplyStats
): void {
  for (const item of changes) {
    const characterA = findCharacterByName(context, item.characterA)
    const characterB = findCharacterByName(context, item.characterB)
    if (!characterA || !characterB) {
      context.logger.warn(
        { a: item.characterA, b: item.characterB, projectId: context.projectId },
        '记忆 Agent：未找到关系两端角色，跳过关系更新'
      )
      continue
    }
    const relationship = findRelationship(context, characterA.id, characterB.id)
    if (!relationship) {
      context.logger.warn(
        { a: characterA.name, b: characterB.name, projectId: context.projectId },
        '记忆 Agent：未找到匹配的关系记录，跳过（如需新建请用 relationshipCreates）'
      )
      continue
    }

    const patch: Partial<NovelRelationship> = {}
    if (item.currentStage !== undefined)
      patch.currentStage = ensureString(item.currentStage, relationship.currentStage)
    if (item.dynamicRole !== undefined)
      patch.dynamicRole = ensureString(item.dynamicRole, relationship.dynamicRole)
    if (item.alignment !== undefined) {
      const alignment = ensureString(item.alignment, relationship.alignment)
      patch.alignment = (
        validAlignments.includes(alignment) ? alignment : 'neutral'
      ) as NovelRelationship['alignment']
    }
    if (item.trend !== undefined) {
      const trend = ensureString(item.trend, relationship.trend)
      patch.trend = (validTrends.includes(trend) ? trend : 'stable') as NovelRelationship['trend']
    }
    if (item.chapterHint !== undefined)
      patch.chapterHint = ensureString(item.chapterHint, relationship.chapterHint)
    if (
      context.chapterNumber !== undefined &&
      item.currentStage !== undefined &&
      item.currentStage !== relationship.currentStage
    ) {
      const history = parseRelationHistory(relationship.stageHistory)
      history.push({
        chapter: context.chapterNumber,
        fromStage: relationship.currentStage,
        toStage: item.currentStage,
        reason: ensureString(item.changeReason, ''),
        timestamp: Date.now()
      })
      patch.stageHistory = JSON.stringify(history)
      patch.lastUpdatedChapter = context.chapterNumber
    }
    if (Object.keys(patch).length === 0) continue

    const updated = context.store.updateRelationship(relationship.id, patch)
    stats.relationshipUpdatesApplied++
    context.audit?.push(
      auditOp().update(
        'relationship',
        relationship.id,
        fieldsBefore(relationship, patch),
        fieldsAfter(updated, patch),
        'memory-generator.applyChanges'
      )
    )
  }
}

function applyRelationshipCreates(
  context: MemoryApplyContext,
  changes: RelationshipCreateInput[],
  stats: WorldRelationMemoryApplyStats
): void {
  for (const item of changes) {
    const characterA = findCharacterByName(context, item.characterA)
    const characterB = findCharacterByName(context, item.characterB)
    if (!characterA || !characterB) {
      context.logger.warn(
        { a: item.characterA, b: item.characterB, projectId: context.projectId },
        '记忆 Agent：未找到关系两端角色，跳过关系创建'
      )
      continue
    }
    if (findRelationship(context, characterA.id, characterB.id)) {
      context.logger.warn(
        { a: characterA.name, b: characterB.name, projectId: context.projectId },
        '记忆 Agent：关系已存在，跳过创建（如需更新请用 relationshipUpdates）'
      )
      continue
    }

    const alignment = ensureString(item.alignment, 'neutral')
    const trend = ensureString(item.trend, 'stable')
    const relationship = context.store.createRelationship({
      id: randomUUID(),
      projectId: context.projectId,
      characterA: characterA.id,
      characterB: characterB.id,
      relationType: ensureString(item.relationType, '其他'),
      currentStage: ensureString(item.currentStage, ''),
      stageHistory: '[]',
      dynamicRole: ensureString(item.dynamicRole, ''),
      alignment: (validAlignments.includes(alignment)
        ? alignment
        : 'neutral') as NovelRelationship['alignment'],
      trend: (validTrends.includes(trend) ? trend : 'stable') as NovelRelationship['trend'],
      chapterHint: ensureString(item.chapterHint, ''),
      lastUpdatedChapter: context.chapterNumber ?? null
    })
    stats.relationshipCreatesApplied++
    context.audit?.push(
      auditOp().create(
        'relationship',
        relationship.id,
        { characterA: relationship.characterA, characterB: relationship.characterB },
        'memory-generator.applyChanges'
      )
    )
  }
}

function findCharacterByName(
  context: MemoryApplyContext,
  name?: string
): NovelCharacter | undefined {
  return findByName(context.store.listCharacters(context.projectId), name)
}

function findRelationship(
  context: MemoryApplyContext,
  characterA: string,
  characterB: string
): NovelRelationship | undefined {
  return context.store
    .listRelationships(context.projectId)
    .find(
      (relationship) =>
        (relationship.characterA === characterA && relationship.characterB === characterB) ||
        (relationship.characterA === characterB && relationship.characterB === characterA)
    )
}

function findByName<T extends { name: string }>(entities: T[], name?: string): T | undefined {
  if (!name) return undefined
  return (
    entities.find((entity) => entity.name === name) ??
    entities.find((entity) => entity.name.includes(name) || name.includes(entity.name))
  )
}

function parseRelationHistory(value: string): RelationChange[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
