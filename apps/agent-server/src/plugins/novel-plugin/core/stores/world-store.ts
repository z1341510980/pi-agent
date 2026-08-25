/**
 * WorldStore - PR-5b 重构
 *
 * 从原 novel-store.ts 抽取 WorldRule / StyleGuide / WritingStyleProfile /
 * Constraint / WorldElement 相关的 CRUD。
 * deleteWorldElement 调用上层传入的 deleteEdgesByEntity 完成边的级联清理。
 */

import { randomUUID } from 'node:crypto'
import { type NovelStyleExpert } from '@repo/shared/novel'
import type {
  NovelWorldRule, NovelStyleGuide, NovelWritingStyleProfile,
  NovelWritingStyleProfileInput, NovelConstraint, NovelWorldElement,
} from '../types.js'
import type {
  WorldRuleRow, StyleGuideRow, StyleExpertRow, WritingStyleProfileRow, ConstraintRow, WorldElementRow,
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
    private readonly db: import('better-sqlite3').Database,
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
    if (!row) return undefined
    const profile = this.rowToWritingStyleProfile(row)
    // 独立专家表是唯一生效源；无行时给空列表，不再回退到占位默认专家。
    profile.styleExperts = this.listStyleExperts(projectId)
    return profile
  }

  upsertWritingStyleProfile(projectId: string, input: NovelWritingStyleProfileInput): NovelWritingStyleProfile {
    const existing = this.getWritingStyleProfile(projectId)
    const ts = now()
    const full: NovelWritingStyleProfile = {
      id: existing?.id ?? randomUUID(),
      projectId,
      ...input,
      styleExperts: input.styleExperts !== undefined
        ? input.styleExperts
        : existing?.styleExperts ?? [],
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
      style_experts: JSON.stringify(full.styleExperts),
      version: full.version,
      created_at: full.createdAt,
      updated_at: full.updatedAt,
    })
    // Profile 编辑器可能会回传独立专家的可编辑字段。独立专家表仍是运行时生效源，
    // 因此只同步已存在的真实行，不把虚拟默认专家写入数据库，也不覆盖蒸馏原文。
    for (const requested of input.styleExperts ?? []) {
      const row = this.repository.getStyleExpert(projectId, requested.id)
      if (!row) continue
      const current = this.rowToStyleExpert(row)
      const patch: Partial<Pick<NovelStyleExpert, 'name' | 'sourceTitle' | 'sourceAuthor' | 'description' | 'customPrompt' | 'enabled' | 'sortOrder'>> = {}
      if (requested.name !== current.name) patch.name = requested.name
      if (requested.sourceTitle !== current.sourceTitle) patch.sourceTitle = requested.sourceTitle
      if ((requested.sourceAuthor ?? undefined) !== (current.sourceAuthor ?? undefined)) patch.sourceAuthor = requested.sourceAuthor
      if (requested.description !== current.description) patch.description = requested.description
      if ((requested.customPrompt ?? undefined) !== (current.customPrompt ?? undefined)) patch.customPrompt = requested.customPrompt
      if (requested.enabled !== current.enabled) patch.enabled = requested.enabled
      if (requested.sortOrder !== current.sortOrder) patch.sortOrder = requested.sortOrder
      if (Object.keys(patch).length > 0) this.updateStyleExpert(projectId, requested.id, patch)
    }
    return full
  }

  listStyleExperts(projectId: string): NovelStyleExpert[] {
    // 只返回真实蒸馏出的专家。
    //
    // 此前无专家时回退到 DEFAULT_NOVEL_STYLE_EXPERTS（四条"项目样本蒸馏 01-04"占位），
    // 它们没有手法、证据、张力和边界，却因 enabled=true 被直接编译进 Writer 提示词——
    // 等于用四段泛泛而谈的空话冒充文风引导。空列表是诚实状态：前端据此提示用户去蒸馏。
    return this.repository.listStyleExperts(projectId).map((row) => this.rowToStyleExpert(row))
  }

  createStyleExpert(input: Omit<NovelStyleExpert, 'createdAt' | 'updatedAt'>): NovelStyleExpert {
    const ts = now()
    const expert = { ...input, createdAt: ts, updatedAt: ts }
    this.db.transaction(() => {
      this.repository.insertStyleExpert(this.toStyleExpertRow(expert))
      this.repository.insertStyleExpertVersion(this.toStyleExpertVersionRow(expert))
    })()
    return expert
  }

  updateStyleExpert(projectId: string, id: string, patch: Partial<Pick<NovelStyleExpert, 'name' | 'sourceTitle' | 'sourceAuthor' | 'description' | 'customPrompt' | 'enabled' | 'sortOrder'>>): NovelStyleExpert | undefined {
    const row = this.repository.getStyleExpert(projectId, id)
    if (!row) return undefined
    const current = this.rowToStyleExpert(row)
    if (Object.keys(patch).length === 0) return current
    const expert = { ...current, ...patch, version: current.version + 1, updatedAt: now() }
    this.db.transaction(() => {
      this.repository.updateStyleExpert(projectId, id, this.toStyleExpertRow(expert))
      this.repository.insertStyleExpertVersion(this.toStyleExpertVersionRow(expert))
    })()
    return expert
  }

  listStyleExpertVersions(projectId: string, id: string) { return this.repository.listStyleExpertVersions(projectId, id) }

  rollbackStyleExpert(projectId: string, id: string, version: number): NovelStyleExpert | undefined {
    const snapshot = this.listStyleExpertVersions(projectId, id).find((item) => item.version === version)
    if (!snapshot) return undefined
    const patch: Partial<Pick<NovelStyleExpert, 'name' | 'sourceTitle' | 'sourceAuthor' | 'description' | 'customPrompt' | 'enabled' | 'sortOrder'>> = {
      name: snapshot.name,
      description: snapshot.description,
      customPrompt: snapshot.customPrompt ?? undefined,
      enabled: snapshot.enabled === 1,
    }
    // 110 之前的历史版本没有来源和排序列；此时保留当前主表字段。
    if (snapshot.sourceTitle != null) {
      patch.sourceTitle = snapshot.sourceTitle
      patch.sourceAuthor = snapshot.sourceAuthor ?? undefined
    }
    if (snapshot.sortOrder != null) patch.sortOrder = snapshot.sortOrder
    return this.updateStyleExpert(projectId, id, patch)
  }

  deleteStyleExpert(projectId: string, id: string): boolean { return this.repository.deleteStyleExpert(projectId, id) }

  private toStyleExpertRow(expert: NovelStyleExpert): StyleExpertRow {
    return { id: expert.id, project_id: expert.projectId, name: expert.name, source_title: expert.sourceTitle, source_author: expert.sourceAuthor ?? null, description: expert.description, distilled_prompt: expert.distilledPrompt, custom_prompt: expert.customPrompt ?? null, metrics_json: expert.metrics ? JSON.stringify(expert.metrics) : null, techniques_json: expert.techniques ? JSON.stringify(expert.techniques) : null, exclusions_json: expert.exclusions ? JSON.stringify(expert.exclusions) : null, exemplars_json: expert.exemplarPassages ? JSON.stringify(expert.exemplarPassages) : null, expression_dna_json: expert.expressionDna ? JSON.stringify(expert.expressionDna) : null, tensions_json: expert.tensions ? JSON.stringify(expert.tensions) : null, anti_patterns_json: expert.antiPatterns ? JSON.stringify(expert.antiPatterns) : null, boundaries_json: expert.boundaries ? JSON.stringify(expert.boundaries) : null, enabled: expert.enabled ? 1 : 0, sort_order: expert.sortOrder, distill_meta: expert.distillMeta ? JSON.stringify(expert.distillMeta) : null, version: expert.version, created_at: expert.createdAt, updated_at: expert.updatedAt }
  }

  private toStyleExpertVersionRow(expert: NovelStyleExpert) {
    return {
      id: randomUUID(),
      projectId: expert.projectId,
      expertId: expert.id,
      version: expert.version,
      name: expert.name,
      sourceTitle: expert.sourceTitle,
      sourceAuthor: expert.sourceAuthor ?? null,
      description: expert.description,
      customPrompt: expert.customPrompt ?? null,
      enabled: expert.enabled ? 1 : 0,
      sortOrder: expert.sortOrder,
      createdAt: expert.updatedAt,
    }
  }

  private rowToStyleExpert(row: StyleExpertRow | NovelStyleExpert): NovelStyleExpert {
    if ('project_id' in row) {
    return { id: row.id, projectId: row.project_id, name: row.name, sourceTitle: row.source_title, sourceAuthor: row.source_author ?? undefined, description: row.description, distilledPrompt: row.distilled_prompt, metrics: row.metrics_json ? JSON.parse(row.metrics_json) : undefined, techniques: row.techniques_json ? JSON.parse(row.techniques_json) : undefined, exclusions: row.exclusions_json ? JSON.parse(row.exclusions_json) : undefined, exemplarPassages: row.exemplars_json ? JSON.parse(row.exemplars_json) : undefined, expressionDna: row.expression_dna_json ? JSON.parse(row.expression_dna_json) : undefined, tensions: row.tensions_json ? JSON.parse(row.tensions_json) : undefined, antiPatterns: row.anti_patterns_json ? JSON.parse(row.anti_patterns_json) : undefined, boundaries: row.boundaries_json ? JSON.parse(row.boundaries_json) : undefined, customPrompt: row.custom_prompt ?? undefined, enabled: row.enabled === 1, sortOrder: row.sort_order, distillMeta: row.distill_meta ? JSON.parse(row.distill_meta) : undefined, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }
    }
    return row
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
      // 旧 JSON 列已不是生效源（getWritingStyleProfile 用专家表覆盖），
      // 缺省给空数组而不是占位默认专家。
      styleExperts: parseJSON(row.style_experts, [] as NovelStyleExpert[]),
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
