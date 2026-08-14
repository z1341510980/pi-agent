/**
 * WorldStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 WorldRule / StyleGuide / WritingStyleProfile /
 * Constraint / WorldElement 相关的 CRUD。
 * deleteWorldElement 调用上层传入的 deleteEdgesByEntity 完成边的级联清理。
 */

import { randomUUID } from 'node:crypto'
import type {
  NovelWorldRule, NovelStyleGuide, NovelWritingStyleProfile,
  NovelWritingStyleProfileInput, NovelConstraint, NovelWorldElement,
} from '../types.js'
import type {
  WorldRuleRow, StyleGuideRow, WritingStyleProfileRow, ConstraintRow, WorldElementRow,
} from './row-types.js'
import {
  now, parseJSON,
  normalizeWritingStyleProfileEnums, parseStringArray,
} from './store-utils.js'
import { createNovelDrizzleDb } from '../../infrastructure/sqlite/client.js'
import { WorldRepository } from '../../infrastructure/sqlite/repositories/world-repository.js'

export class WorldStore {
  private readonly repository: WorldRepository

  constructor(
    db: import('better-sqlite3').Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.repository = new WorldRepository(createNovelDrizzleDb(db))
  }

  listWorldRules(projectId: string): NovelWorldRule[] {
    return this.repository.listWorldRules(projectId).map((r) => this.rowToWorldRule(r))
  }

  createWorldRule(rule: Omit<NovelWorldRule, 'createdAt' | 'updatedAt'>): NovelWorldRule {
    const ts = now()
    const full: NovelWorldRule = { ...rule, createdAt: ts, updatedAt: ts }
    this.repository.insertWorldRule({
      id: full.id, project_id: full.projectId, category: full.category, rule: full.rule,
      cost: full.cost, is_fixed: full.isFixed ? 1 : 0, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateWorldRule(id: string, updates: Partial<Omit<NovelWorldRule, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelWorldRule | undefined {
    const row = this.repository.getWorldRule(id)
    if (!row) return undefined
    if (Object.keys(updates).length === 0) return this.rowToWorldRule(row)
    const current = this.rowToWorldRule(row)
    const updated = { ...current, ...updates, id, updatedAt: now() }
    this.repository.updateWorldRule(id, { id, project_id: current.projectId, category: updated.category, rule: updated.rule, cost: updated.cost, is_fixed: updated.isFixed ? 1 : 0, created_at: current.createdAt, updated_at: updated.updatedAt })
    const result = this.repository.getWorldRule(id)
    return result ? this.rowToWorldRule(result) : undefined
  }

  deleteWorldRule(id: string): boolean {
    return this.repository.deleteWorldRule(id)
  }

  listStyleGuide(projectId: string): NovelStyleGuide[] {
    return this.repository.listStyleGuides(projectId).map((r) => this.rowToStyleGuide(r))
  }

  createStyleGuide(style: Omit<NovelStyleGuide, 'createdAt' | 'updatedAt'>): NovelStyleGuide {
    const ts = now()
    const full: NovelStyleGuide = { ...style, createdAt: ts, updatedAt: ts }
    this.repository.insertStyleGuide({
      id: full.id, project_id: full.projectId, category: full.category, rule: full.rule,
      example: full.example, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateStyleGuide(id: string, updates: Partial<Omit<NovelStyleGuide, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelStyleGuide | undefined {
    const row = this.repository.getStyleGuide(id)
    if (!row) return undefined
    if (Object.keys(updates).length === 0) return this.rowToStyleGuide(row)
    const current = this.rowToStyleGuide(row)
    const updated = { ...current, ...updates, id, updatedAt: now() }
    this.repository.updateStyleGuide(id, { id, project_id: current.projectId, category: updated.category, rule: updated.rule, example: updated.example, created_at: current.createdAt, updated_at: updated.updatedAt })
    const result = this.repository.getStyleGuide(id)
    return result ? this.rowToStyleGuide(result) : undefined
  }

  deleteStyleGuide(id: string): boolean {
    return this.repository.deleteStyleGuide(id)
  }

  getWritingStyleProfile(projectId: string): NovelWritingStyleProfile | undefined {
    const row = this.repository.getWritingStyleProfile(projectId)
    return row ? this.rowToWritingStyleProfile(row) : undefined
  }

  upsertWritingStyleProfile(projectId: string, input: NovelWritingStyleProfileInput): NovelWritingStyleProfile {
    const existing = this.getWritingStyleProfile(projectId)
    const ts = now()
    const full: NovelWritingStyleProfile = {
      id: existing?.id ?? randomUUID(),
      projectId,
      ...input,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    }
    this.repository.upsertWritingStyleProfile({
      id: full.id,
      project_id: full.projectId,
      name: full.name,
      preset: full.preset,
      narrative_person: full.narrativePerson,
      narrative_distance: full.narrativeDistance,
      sentence_rhythm: full.sentenceRhythm,
      dialogue_ratio: full.dialogueRatio,
      emotional_temperature: full.emotionalTemperature,
      imagery_density: full.imageryDensity,
      vocabulary_register: full.vocabularyRegister,
      hard_rules: JSON.stringify(full.hardRules),
      soft_rules: JSON.stringify(full.softRules),
      positive_examples: JSON.stringify(full.positiveExamples),
      negative_examples: JSON.stringify(full.negativeExamples),
      notes: full.notes,
      version: full.version,
      created_at: full.createdAt,
      updated_at: full.updatedAt,
    })
    return full
  }

  listConstraints(projectId: string): NovelConstraint[] {
    return this.repository.listConstraints(projectId).map((r) => this.rowToConstraint(r))
  }

  createConstraint(constraint: Omit<NovelConstraint, 'createdAt' | 'updatedAt'>): NovelConstraint {
    const ts = now()
    const full: NovelConstraint = { ...constraint, createdAt: ts, updatedAt: ts }
    this.repository.insertConstraint({
      id: full.id, project_id: full.projectId, type: full.type, scope: full.scope,
      rule: full.rule, is_active: full.isActive ? 1 : 0, related_entity_id: full.relatedEntityId,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateConstraint(id: string, updates: Partial<Omit<NovelConstraint, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelConstraint | undefined {
    const row = this.repository.getConstraint(id)
    if (!row) return undefined
    if (Object.keys(updates).length === 0) return this.rowToConstraint(row)
    const current = this.rowToConstraint(row)
    const updated = { ...current, ...updates, id, updatedAt: now() }
    this.repository.updateConstraint(id, { id, project_id: current.projectId, type: updated.type, scope: updated.scope, rule: updated.rule, is_active: updated.isActive ? 1 : 0, related_entity_id: updated.relatedEntityId, created_at: current.createdAt, updated_at: updated.updatedAt })
    const result = this.repository.getConstraint(id)
    return result ? this.rowToConstraint(result) : undefined
  }

  deleteConstraint(id: string): boolean {
    return this.repository.deleteConstraint(id)
  }

  listWorldElements(projectId: string): NovelWorldElement[] {
    return this.repository.listWorldElements(projectId).map((r) => this.rowToWorldElement(r))
  }

  getWorldElement(worldElementId: string): NovelWorldElement | undefined {
    const row = this.repository.getWorldElement(worldElementId)
    return row ? this.rowToWorldElement(row) : undefined
  }

  createWorldElement(element: Omit<NovelWorldElement, 'createdAt' | 'updatedAt'>): NovelWorldElement {
    const ts = now()
    const full: NovelWorldElement = { ...element, createdAt: ts, updatedAt: ts }
    this.repository.insertWorldElement({
      id: full.id, project_id: full.projectId, category: full.category, name: full.name,
      description: full.description, parent_id: full.parentId,
      attributes: JSON.stringify(full.attributes), created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateWorldElement(id: string, patch: Partial<NovelWorldElement>): NovelWorldElement | undefined {
    const existing = this.repository.getWorldElement(id)
    if (!existing) return undefined
    const current = this.rowToWorldElement(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.repository.updateWorldElement(id, {
      id, category: updated.category, name: updated.name, description: updated.description,
      parent_id: updated.parentId, attributes: JSON.stringify(updated.attributes),
      project_id: current.projectId, created_at: current.createdAt,
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteWorldElement(id: string): boolean {
    this.deleteEdgesByEntity(id)
    return this.repository.deleteWorldElement(id)
  }

  private rowToWorldRule(row: WorldRuleRow): NovelWorldRule {
    return {
      id: row.id, projectId: row.project_id, category: row.category, rule: row.rule,
      cost: row.cost, isFixed: row.is_fixed === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToStyleGuide(row: StyleGuideRow): NovelStyleGuide {
    return {
      id: row.id, projectId: row.project_id, category: row.category, rule: row.rule,
      example: row.example, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToWritingStyleProfile(row: WritingStyleProfileRow): NovelWritingStyleProfile {
    const enums = normalizeWritingStyleProfileEnums(row)
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      preset: row.preset,
      ...enums,
      dialogueRatio: Math.min(90, Math.max(10, Number(row.dialogue_ratio) || 45)),
      emotionalTemperature: Math.min(10, Math.max(0, Number(row.emotional_temperature) || 5)),
      imageryDensity: Math.min(10, Math.max(0, Number(row.imagery_density) || 3)),
      hardRules: parseStringArray(row.hard_rules),
      softRules: parseStringArray(row.soft_rules),
      positiveExamples: parseStringArray(row.positive_examples),
      negativeExamples: parseStringArray(row.negative_examples),
      notes: row.notes ?? '',
      version: Math.max(1, Number(row.version) || 1),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private rowToConstraint(row: ConstraintRow): NovelConstraint {
    return {
      id: row.id, projectId: row.project_id, type: row.type as NovelConstraint['type'],
      scope: row.scope as NovelConstraint['scope'], rule: row.rule,
      isActive: row.is_active === 1, relatedEntityId: row.related_entity_id,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private rowToWorldElement(row: WorldElementRow): NovelWorldElement {
    return {
      id: row.id, projectId: row.project_id, category: row.category as NovelWorldElement['category'],
      name: row.name, description: row.description, parentId: row.parent_id,
      attributes: parseJSON<Record<string, unknown>>(row.attributes, {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
