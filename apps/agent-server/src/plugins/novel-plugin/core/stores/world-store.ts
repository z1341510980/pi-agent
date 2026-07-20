/**
 * WorldStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 WorldRule / StyleGuide / WritingStyleProfile /
 * Constraint / WorldElement 相关的 CRUD。
 * deleteWorldElement 调用上层传入的 deleteEdgesByEntity 完成边的级联清理。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  NovelWorldRule, NovelStyleGuide, NovelWritingStyleProfile,
  NovelWritingStyleProfileInput, NovelConstraint, NovelWorldElement,
} from '../types.js'
import type {
  WorldRuleRow, StyleGuideRow, WritingStyleProfileRow, ConstraintRow, WorldElementRow,
} from './row-types.js'
import {
  now, camelToSnake, parseJSON,
  normalizeWritingStyleProfileEnums, parseStringArray,
} from './store-utils.js'

export class WorldStore {
  private readonly stmtListWorldRules: Database.Statement
  private readonly stmtListStyleGuides: Database.Statement
  private readonly stmtListConstraints: Database.Statement
  private readonly stmtListWorldElements: Database.Statement

  constructor(
    private db: Database.Database,
    private deleteEdgesByEntity: (entityId: string) => number,
  ) {
    this.stmtListWorldRules = db.prepare('SELECT * FROM novel_world_rules WHERE project_id = ? ORDER BY category ASC, id ASC')
    this.stmtListStyleGuides = db.prepare('SELECT * FROM novel_style_guides WHERE project_id = ? ORDER BY category ASC, id ASC')
    this.stmtListConstraints = db.prepare('SELECT * FROM novel_constraints WHERE project_id = ? AND is_active = 1 ORDER BY created_at ASC')
    this.stmtListWorldElements = db.prepare('SELECT * FROM novel_world_elements WHERE project_id = ? ORDER BY created_at ASC')
  }

  listWorldRules(projectId: string): NovelWorldRule[] {
    return (this.stmtListWorldRules.all(projectId) as WorldRuleRow[]).map((r) => this.rowToWorldRule(r))
  }

  createWorldRule(rule: Omit<NovelWorldRule, 'createdAt' | 'updatedAt'>): NovelWorldRule {
    const ts = now()
    const full: NovelWorldRule = { ...rule, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_world_rules (id, project_id, category, rule, cost, is_fixed, created_at, updated_at)
      VALUES (@id, @project_id, @category, @rule, @cost, @is_fixed, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, category: full.category, rule: full.rule,
      cost: full.cost, is_fixed: full.isFixed ? 1 : 0, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateWorldRule(id: string, updates: Partial<Omit<NovelWorldRule, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelWorldRule | undefined {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = camelToSnake(key)
      fields.push(`${dbKey} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM novel_world_rules WHERE id = ?').get(id) as WorldRuleRow | undefined
      return row ? this.rowToWorldRule(row) : undefined
    }
    fields.push('updated_at = unixepoch()')
    values.push(id)
    this.db.prepare(`UPDATE novel_world_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = this.db.prepare('SELECT * FROM novel_world_rules WHERE id = ?').get(id) as WorldRuleRow | undefined
    return row ? this.rowToWorldRule(row) : undefined
  }

  deleteWorldRule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_world_rules WHERE id = ?').run(id)
    return result.changes > 0
  }

  listStyleGuide(projectId: string): NovelStyleGuide[] {
    return (this.stmtListStyleGuides.all(projectId) as StyleGuideRow[]).map((r) => this.rowToStyleGuide(r))
  }

  createStyleGuide(style: Omit<NovelStyleGuide, 'createdAt' | 'updatedAt'>): NovelStyleGuide {
    const ts = now()
    const full: NovelStyleGuide = { ...style, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_style_guides (id, project_id, category, rule, example, created_at, updated_at)
      VALUES (@id, @project_id, @category, @rule, @example, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, category: full.category, rule: full.rule,
      example: full.example, created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateStyleGuide(id: string, updates: Partial<Omit<NovelStyleGuide, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelStyleGuide | undefined {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = camelToSnake(key)
      fields.push(`${dbKey} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM novel_style_guides WHERE id = ?').get(id) as StyleGuideRow | undefined
      return row ? this.rowToStyleGuide(row) : undefined
    }
    fields.push('updated_at = unixepoch()')
    values.push(id)
    this.db.prepare(`UPDATE novel_style_guides SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = this.db.prepare('SELECT * FROM novel_style_guides WHERE id = ?').get(id) as StyleGuideRow | undefined
    return row ? this.rowToStyleGuide(row) : undefined
  }

  deleteStyleGuide(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_style_guides WHERE id = ?').run(id)
    return result.changes > 0
  }

  getWritingStyleProfile(projectId: string): NovelWritingStyleProfile | undefined {
    const row = this.db.prepare('SELECT * FROM novel_writing_style_profiles WHERE project_id = ?').get(projectId) as WritingStyleProfileRow | undefined
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
    this.db.prepare(`
      INSERT INTO novel_writing_style_profiles (
        id, project_id, name, preset, narrative_person, narrative_distance,
        sentence_rhythm, dialogue_ratio, emotional_temperature, imagery_density,
        vocabulary_register, hard_rules, soft_rules, positive_examples, negative_examples, notes,
        version, created_at, updated_at
      ) VALUES (
        @id, @project_id, @name, @preset, @narrative_person, @narrative_distance,
        @sentence_rhythm, @dialogue_ratio, @emotional_temperature, @imagery_density,
        @vocabulary_register, @hard_rules, @soft_rules, @positive_examples, @negative_examples, @notes,
        @version, @created_at, @updated_at
      )
      ON CONFLICT(project_id) DO UPDATE SET
        name = excluded.name,
        preset = excluded.preset,
        narrative_person = excluded.narrative_person,
        narrative_distance = excluded.narrative_distance,
        sentence_rhythm = excluded.sentence_rhythm,
        dialogue_ratio = excluded.dialogue_ratio,
        emotional_temperature = excluded.emotional_temperature,
        imagery_density = excluded.imagery_density,
        vocabulary_register = excluded.vocabulary_register,
        hard_rules = excluded.hard_rules,
        soft_rules = excluded.soft_rules,
        positive_examples = excluded.positive_examples,
        negative_examples = excluded.negative_examples,
        notes = excluded.notes,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run({
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
    return (this.stmtListConstraints.all(projectId) as ConstraintRow[]).map((r) => this.rowToConstraint(r))
  }

  createConstraint(constraint: Omit<NovelConstraint, 'createdAt' | 'updatedAt'>): NovelConstraint {
    const ts = now()
    const full: NovelConstraint = { ...constraint, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_constraints (id, project_id, type, scope, rule, is_active, related_entity_id, created_at, updated_at)
      VALUES (@id, @project_id, @type, @scope, @rule, @is_active, @related_entity_id, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, type: full.type, scope: full.scope,
      rule: full.rule, is_active: full.isActive ? 1 : 0, related_entity_id: full.relatedEntityId,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateConstraint(id: string, updates: Partial<Omit<NovelConstraint, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>): NovelConstraint | undefined {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = camelToSnake(key)
      fields.push(`${dbKey} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (fields.length === 0) {
      const row = this.db.prepare('SELECT * FROM novel_constraints WHERE id = ?').get(id) as ConstraintRow | undefined
      return row ? this.rowToConstraint(row) : undefined
    }
    fields.push('updated_at = unixepoch()')
    values.push(id)
    this.db.prepare(`UPDATE novel_constraints SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = this.db.prepare('SELECT * FROM novel_constraints WHERE id = ?').get(id) as ConstraintRow | undefined
    return row ? this.rowToConstraint(row) : undefined
  }

  deleteConstraint(id: string): boolean {
    const result = this.db.prepare('DELETE FROM novel_constraints WHERE id = ?').run(id)
    return result.changes > 0
  }

  listWorldElements(projectId: string): NovelWorldElement[] {
    return (this.stmtListWorldElements.all(projectId) as WorldElementRow[]).map((r) => this.rowToWorldElement(r))
  }

  getWorldElement(worldElementId: string): NovelWorldElement | undefined {
    const row = this.db.prepare('SELECT * FROM novel_world_elements WHERE id = ?').get(worldElementId) as WorldElementRow | undefined
    return row ? this.rowToWorldElement(row) : undefined
  }

  createWorldElement(element: Omit<NovelWorldElement, 'createdAt' | 'updatedAt'>): NovelWorldElement {
    const ts = now()
    const full: NovelWorldElement = { ...element, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_world_elements (id, project_id, category, name, description, parent_id, attributes, created_at, updated_at)
      VALUES (@id, @project_id, @category, @name, @description, @parent_id, @attributes, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, category: full.category, name: full.name,
      description: full.description, parent_id: full.parentId,
      attributes: JSON.stringify(full.attributes), created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }

  updateWorldElement(id: string, patch: Partial<NovelWorldElement>): NovelWorldElement | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_world_elements WHERE id = ?').get(id) as WorldElementRow | undefined
    if (!existing) return undefined
    const current = this.rowToWorldElement(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_world_elements SET category=@category, name=@name, description=@description,
      parent_id=@parent_id, attributes=@attributes, updated_at=@updated_at WHERE id=@id
    `).run({
      id, category: updated.category, name: updated.name, description: updated.description,
      parent_id: updated.parentId, attributes: JSON.stringify(updated.attributes),
      updated_at: updated.updatedAt,
    })
    return updated
  }

  deleteWorldElement(id: string): boolean {
    this.deleteEdgesByEntity(id)
    const result = this.db.prepare('DELETE FROM novel_world_elements WHERE id = ?').run(id)
    return result.changes > 0
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
