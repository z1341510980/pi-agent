import { randomUUID } from 'node:crypto'
import type { NovelCharacter } from '../types.js'
import {
  auditOp,
  ensureString,
  fieldsAfter,
  fieldsBefore,
  type MemoryApplyContext
} from './memory-change-support.js'

export interface CharacterUpdateInput {
  name?: string
  currentState?: string
  currentGoal?: string
  currentPressure?: string
  secret?: string
  arcStage?: string
  longTermDesire?: string
  removalImpact?: string
}

export interface CharacterCreateInput {
  name?: string
  description?: string
  identity?: string
  personality?: string
  appearance?: string
  currentState?: string
  currentGoal?: string
  currentPressure?: string
  secret?: string
  arcStage?: string
  speechStyle?: string
  longTermDesire?: string
  plotRole?: string
  removalImpact?: string
}

export interface CharacterArcChangeInput {
  characterName?: string
  characterId?: string
  arcType?: 'growth' | 'fall' | 'redemption' | 'shift'
  newStage?: string
  triggerEvent?: string
  description?: string
}

export interface CharacterEntityMemoryChanges {
  characterUpdates?: CharacterUpdateInput[]
  characterCreates?: CharacterCreateInput[]
}

export interface CharacterArcMemoryChanges {
  arcStageChanges?: CharacterArcChangeInput[]
}

export interface CharacterEntityMemoryApplyStats {
  characterUpdatesApplied: number
  characterCreatesApplied: number
  characterCreatesDeduped: number
}

export interface CharacterArcMemoryApplyStats {
  arcStageChangesApplied: number
}

export function applyCharacterMemoryChanges(
  context: MemoryApplyContext,
  changes: CharacterEntityMemoryChanges
): CharacterEntityMemoryApplyStats {
  const stats: CharacterEntityMemoryApplyStats = {
    characterUpdatesApplied: 0,
    characterCreatesApplied: 0,
    characterCreatesDeduped: 0
  }

  for (const item of changes.characterUpdates ?? []) {
    const character = findCharacterByName(context, item.name)
    if (!character) {
      context.logger.warn(
        { name: item.name, projectId: context.projectId },
        '记忆 Agent：未找到要更新的角色，跳过'
      )
      continue
    }
    const patch: Partial<NovelCharacter> = {}
    if (item.currentState !== undefined)
      patch.currentState = ensureString(item.currentState, character.currentState)
    if (item.currentGoal !== undefined)
      patch.currentGoal = ensureString(item.currentGoal, character.currentGoal)
    if (item.currentPressure !== undefined)
      patch.currentPressure = ensureString(item.currentPressure, character.currentPressure)
    if (item.secret !== undefined) patch.secret = ensureString(item.secret, character.secret)
    if (item.arcStage !== undefined)
      patch.arcStage = ensureString(item.arcStage, character.arcStage)
    if (item.longTermDesire !== undefined)
      patch.longTermDesire = ensureString(item.longTermDesire, character.longTermDesire)
    if (item.removalImpact !== undefined)
      patch.removalImpact = ensureString(item.removalImpact, character.removalImpact)
    if (Object.keys(patch).length === 0) continue

    const updated = context.store.updateCharacter(character.id, patch)
    stats.characterUpdatesApplied++
    context.audit?.push(
      auditOp().update(
        'character',
        character.id,
        fieldsBefore(character, patch),
        fieldsAfter(updated, patch),
        'memory-generator.applyChanges'
      )
    )
  }

  for (const item of changes.characterCreates ?? []) {
    if (!item.name) continue
    const incomingName = ensureString(item.name, '').trim()
    const existing = incomingName
      ? context.store
          .listCharacters(context.projectId)
          .find((character) => character.name.trim() === incomingName)
      : undefined
    if (existing) {
      mergeExistingCharacter(context, existing, item)
      stats.characterCreatesDeduped++
      continue
    }

    const validPlotRoles = ['protagonist', 'main_opponent', 'supporting', 'function', 'background']
    const created = context.store.createCharacter({
      id: randomUUID(),
      projectId: context.projectId,
      name: ensureString(item.name, ''),
      description: ensureString(item.description, ''),
      identity: ensureString(item.identity, ''),
      personality: ensureString(item.personality, ''),
      appearance: ensureString(item.appearance, ''),
      currentState: ensureString(item.currentState, ''),
      currentGoal: ensureString(item.currentGoal, ''),
      currentPressure: ensureString(item.currentPressure, ''),
      secret: ensureString(item.secret, ''),
      arcStage: ensureString(item.arcStage, 'introduction'),
      arcHistory: '[]',
      speechStyle: ensureString(item.speechStyle, ''),
      isProtagonist: false,
      longTermDesire: ensureString(item.longTermDesire, ''),
      plotRole: (validPlotRoles.includes(item.plotRole ?? '')
        ? item.plotRole
        : 'supporting') as NovelCharacter['plotRole'],
      removalImpact: ensureString(item.removalImpact, '暂无关键影响')
    })
    stats.characterCreatesApplied++
    context.audit?.push(
      auditOp().create('character', created.id, created, 'memory-generator.applyChanges')
    )
  }

  return stats
}

export function applyCharacterArcChanges(
  context: MemoryApplyContext,
  changes: CharacterArcMemoryChanges
): CharacterArcMemoryApplyStats {
  const stats: CharacterArcMemoryApplyStats = { arcStageChangesApplied: 0 }
  for (const item of changes.arcStageChanges ?? []) {
    const characterId =
      item.characterId ??
      (item.characterName
        ? context.store
            .listCharacters(context.projectId)
            .find((character) => character.name === item.characterName)?.id
        : undefined)
    if (!characterId) continue

    const character = context.store.getCharacter(characterId)
    if (!character || character.projectId !== context.projectId) {
      context.logger.warn(
        { projectId: context.projectId, characterId },
        'Memory 角色弧变更引用了当前项目之外的角色，已跳过'
      )
      continue
    }

    const arc = context.store.getCharacterArcByCharacter(context.projectId, characterId)
    if (!arc && item.arcType && item.newStage) {
      const created = context.store.createCharacterArc({
        id: randomUUID(),
        projectId: context.projectId,
        characterId,
        arcType: item.arcType,
        currentStage: item.newStage,
        stageHistory: [
          {
            stage: item.newStage,
            triggerEvent: item.triggerEvent ?? '',
            description: item.description ?? '',
            chapterNumber: context.chapterNumber ?? 0,
            changedAt: Date.now()
          }
        ],
        description: null
      })
      context.audit?.push(
        auditOp().create(
          'character_arc',
          created.id,
          { characterId: created.characterId, currentStage: created.currentStage },
          'memory-generator.applyChanges'
        )
      )
      if (character.arcStage !== created.currentStage) {
        const characterPatch = { arcStage: created.currentStage }
        const updatedCharacter = context.store.getCharacter(characterId)
        context.audit?.push(
          auditOp().update(
            'character',
            characterId,
            { arcStage: character.arcStage },
            fieldsAfter(updatedCharacter, characterPatch),
            'memory-generator.applyChanges.characterArcMirror'
          )
        )
      }
      stats.arcStageChangesApplied++
      continue
    }
    if (!arc || !item.newStage || arc.currentStage === item.newStage) continue

    const arcPatch = {
      currentStage: item.newStage,
      stageHistory: [
        ...arc.stageHistory,
        {
          stage: item.newStage,
          triggerEvent: item.triggerEvent ?? '',
          description: item.description ?? '',
          chapterNumber: context.chapterNumber ?? 0,
          changedAt: Date.now()
        }
      ]
    }
    const updatedArc = context.store.updateCharacterArc(arc.id, arcPatch)
    context.audit?.push(
      auditOp().update(
        'character_arc',
        arc.id,
        fieldsBefore(arc, arcPatch),
        fieldsAfter(updatedArc, arcPatch),
        'memory-generator.applyChanges'
      )
    )

    const characterPatch = { arcStage: item.newStage }
    const updatedCharacter = context.store.getCharacter(characterId)
    context.audit?.push(
      auditOp().update(
        'character',
        characterId,
        { arcStage: character.arcStage },
        fieldsAfter(updatedCharacter, characterPatch),
        'memory-generator.applyChanges.characterArcMirror'
      )
    )
    stats.arcStageChangesApplied++
  }

  return stats
}

function mergeExistingCharacter(
  context: MemoryApplyContext,
  existing: NovelCharacter,
  item: CharacterCreateInput
): void {
  const merge = (incoming: string | undefined, current: string): string =>
    incoming === undefined || incoming.trim() === '' ? current : ensureString(incoming, current)
  const patch: Partial<NovelCharacter> = {}
  if (item.description !== undefined)
    patch.description = merge(item.description, existing.description)
  if (item.identity !== undefined) patch.identity = merge(item.identity, existing.identity)
  if (item.personality !== undefined)
    patch.personality = merge(item.personality, existing.personality)
  if (item.appearance !== undefined) patch.appearance = merge(item.appearance, existing.appearance)
  if (item.currentState !== undefined)
    patch.currentState = merge(item.currentState, existing.currentState)
  if (item.currentGoal !== undefined)
    patch.currentGoal = merge(item.currentGoal, existing.currentGoal)
  if (item.currentPressure !== undefined)
    patch.currentPressure = merge(item.currentPressure, existing.currentPressure)
  if (item.secret !== undefined) patch.secret = merge(item.secret, existing.secret)
  if (item.arcStage !== undefined) patch.arcStage = merge(item.arcStage, existing.arcStage)
  if (item.speechStyle !== undefined)
    patch.speechStyle = merge(item.speechStyle, existing.speechStyle)
  if (item.longTermDesire !== undefined)
    patch.longTermDesire = merge(item.longTermDesire, existing.longTermDesire)
  if (item.removalImpact !== undefined)
    patch.removalImpact = merge(item.removalImpact, existing.removalImpact)
  if (Object.keys(patch).length > 0) {
    const updated = context.store.updateCharacter(existing.id, patch)
    context.audit?.push(
      auditOp().update(
        'character',
        existing.id,
        fieldsBefore(existing, patch),
        fieldsAfter(updated, patch),
        'memory-generator.applyChanges.characterCreateDedup'
      )
    )
  }
  context.logger.info(
    { name: existing.name, characterId: existing.id, projectId: context.projectId },
    '记忆 Agent：characterCreates 命中同名既有角色，已合并为更新（防重复）'
  )
}

function findCharacterByName(
  context: Pick<MemoryApplyContext, 'projectId' | 'store'>,
  name?: string
): NovelCharacter | undefined {
  if (!name) return undefined
  const characters = context.store.listCharacters(context.projectId)
  return (
    characters.find((character) => character.name === name) ??
    characters.find((character) => character.name.includes(name) || name.includes(character.name))
  )
}
