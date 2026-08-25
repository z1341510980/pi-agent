import { and, asc, eq } from 'drizzle-orm'
import type { NovelDrizzleDb } from '../client.js'
import {
  novelConstraints, novelStyleGuides, novelStyleExperts, novelStyleExpertVersions, novelWorldElements, novelWorldRules, novelWritingStyleProfiles,
  type NovelConstraintsInsert, type NovelConstraintsRow, type NovelStyleGuidesInsert, type NovelStyleGuidesRow,
  type NovelWorldElementsInsert, type NovelWorldElementsRow, type NovelWorldRulesInsert, type NovelWorldRulesRow,
   type NovelWritingStyleProfilesInsert, type NovelWritingStyleProfilesRow, type NovelStyleExpertsInsert, type NovelStyleExpertsRow,
} from '../schema/novel-world.js'
import type { ConstraintRow, StyleGuideRow, StyleExpertRow, WorldElementRow, WorldRuleRow, WritingStyleProfileRow } from '../../../core/stores/row-types.js'

export class WorldRepository {
  constructor(private readonly db: NovelDrizzleDb) {}

  listWorldRules(projectId: string): WorldRuleRow[] { return this.db.select().from(novelWorldRules).where(eq(novelWorldRules.projectId, projectId)).orderBy(asc(novelWorldRules.category), asc(novelWorldRules.id)).all().map(toWorldRuleRow) }
  getWorldRule(id: string): WorldRuleRow | undefined { const row = this.db.select().from(novelWorldRules).where(eq(novelWorldRules.id, id)).get(); return row ? toWorldRuleRow(row) : undefined }
  insertWorldRule(row: WorldRuleRow): void { this.db.insert(novelWorldRules).values(toWorldRuleInsert(row)).run() }
  updateWorldRule(id: string, row: WorldRuleRow): boolean { return this.db.update(novelWorldRules).set({ category: row.category, rule: row.rule, cost: row.cost, isFixed: row.is_fixed, updatedAt: row.updated_at }).where(eq(novelWorldRules.id, id)).run().changes > 0 }
  deleteWorldRule(id: string): boolean { return this.db.delete(novelWorldRules).where(eq(novelWorldRules.id, id)).run().changes > 0 }

  listStyleGuides(projectId: string): StyleGuideRow[] { return this.db.select().from(novelStyleGuides).where(eq(novelStyleGuides.projectId, projectId)).orderBy(asc(novelStyleGuides.category), asc(novelStyleGuides.id)).all().map(toStyleGuideRow) }
  getStyleGuide(id: string): StyleGuideRow | undefined { const row = this.db.select().from(novelStyleGuides).where(eq(novelStyleGuides.id, id)).get(); return row ? toStyleGuideRow(row) : undefined }
  insertStyleGuide(row: StyleGuideRow): void { this.db.insert(novelStyleGuides).values(toStyleGuideInsert(row)).run() }
  updateStyleGuide(id: string, row: StyleGuideRow): boolean { return this.db.update(novelStyleGuides).set({ category: row.category, rule: row.rule, example: row.example, updatedAt: row.updated_at }).where(eq(novelStyleGuides.id, id)).run().changes > 0 }
  deleteStyleGuide(id: string): boolean { return this.db.delete(novelStyleGuides).where(eq(novelStyleGuides.id, id)).run().changes > 0 }

  getWritingStyleProfile(projectId: string): WritingStyleProfileRow | undefined { const row = this.db.select().from(novelWritingStyleProfiles).where(eq(novelWritingStyleProfiles.projectId, projectId)).get(); return row ? toWritingStyleRow(row) : undefined }
  upsertWritingStyleProfile(row: WritingStyleProfileRow): void {
    this.db.insert(novelWritingStyleProfiles).values(toWritingStyleInsert(row)).onConflictDoUpdate({
      target: novelWritingStyleProfiles.projectId,
       set: { name: row.name, preset: row.preset, narrativePerson: row.narrative_person, narrativeDistance: row.narrative_distance, sentenceRhythm: row.sentence_rhythm, dialogueRatio: row.dialogue_ratio, emotionalTemperature: row.emotional_temperature, imageryDensity: row.imagery_density, vocabularyRegister: row.vocabulary_register, hardRules: row.hard_rules, softRules: row.soft_rules, positiveExamples: row.positive_examples, negativeExamples: row.negative_examples, notes: row.notes, styleExperts: row.style_experts, version: row.version, updatedAt: row.updated_at },
    }).run()
  }

  listStyleExperts(projectId: string): StyleExpertRow[] { return this.db.select().from(novelStyleExperts).where(eq(novelStyleExperts.projectId, projectId)).orderBy(asc(novelStyleExperts.sortOrder), asc(novelStyleExperts.id)).all().map(toStyleExpertRow) }
  getStyleExpert(projectId: string, id: string): StyleExpertRow | undefined { const row = this.db.select().from(novelStyleExperts).where(and(eq(novelStyleExperts.projectId, projectId), eq(novelStyleExperts.id, id))).get(); return row ? toStyleExpertRow(row) : undefined }
  insertStyleExpert(row: StyleExpertRow): void { this.db.insert(novelStyleExperts).values(toStyleExpertInsert(row)).run() }
  updateStyleExpert(projectId: string, id: string, row: StyleExpertRow): boolean { return this.db.update(novelStyleExperts).set({ name: row.name, sourceTitle: row.source_title, sourceAuthor: row.source_author, description: row.description, customPrompt: row.custom_prompt, enabled: row.enabled, sortOrder: row.sort_order, updatedAt: row.updated_at, version: row.version, metricsJson: row.metrics_json, techniquesJson: row.techniques_json, exclusionsJson: row.exclusions_json, exemplarsJson: row.exemplars_json, expressionDnaJson: row.expression_dna_json, tensionsJson: row.tensions_json, antiPatternsJson: row.anti_patterns_json, boundariesJson: row.boundaries_json }).where(and(eq(novelStyleExperts.projectId, projectId), eq(novelStyleExperts.id, id))).run().changes > 0 }
  deleteStyleExpert(projectId: string, id: string): boolean { return this.db.delete(novelStyleExperts).where(and(eq(novelStyleExperts.projectId, projectId), eq(novelStyleExperts.id, id))).run().changes > 0 }
  listStyleExpertVersions(projectId: string, expertId: string): any[] { return this.db.select().from(novelStyleExpertVersions).where(and(eq(novelStyleExpertVersions.projectId, projectId), eq(novelStyleExpertVersions.expertId, expertId))).orderBy(asc(novelStyleExpertVersions.version)).all() }
  insertStyleExpertVersion(row: any): void { this.db.insert(novelStyleExpertVersions).values(row).run() }

  listConstraints(projectId: string): ConstraintRow[] { return this.db.select().from(novelConstraints).where(and(eq(novelConstraints.projectId, projectId), eq(novelConstraints.isActive, 1))).orderBy(asc(novelConstraints.createdAt)).all().map(toConstraintRow) }
  getConstraint(id: string): ConstraintRow | undefined { const row = this.db.select().from(novelConstraints).where(eq(novelConstraints.id, id)).get(); return row ? toConstraintRow(row) : undefined }
  insertConstraint(row: ConstraintRow): void { this.db.insert(novelConstraints).values(toConstraintInsert(row)).run() }
  updateConstraint(id: string, row: ConstraintRow): boolean { return this.db.update(novelConstraints).set({ type: row.type, scope: row.scope, rule: row.rule, isActive: row.is_active, relatedEntityId: row.related_entity_id, updatedAt: row.updated_at }).where(eq(novelConstraints.id, id)).run().changes > 0 }
  deleteConstraint(id: string): boolean { return this.db.delete(novelConstraints).where(eq(novelConstraints.id, id)).run().changes > 0 }

  listWorldElements(projectId: string): WorldElementRow[] { return this.db.select().from(novelWorldElements).where(eq(novelWorldElements.projectId, projectId)).orderBy(asc(novelWorldElements.createdAt)).all().map(toWorldElementRow) }
  getWorldElement(id: string): WorldElementRow | undefined { const row = this.db.select().from(novelWorldElements).where(eq(novelWorldElements.id, id)).get(); return row ? toWorldElementRow(row) : undefined }
  insertWorldElement(row: WorldElementRow): void { this.db.insert(novelWorldElements).values(toWorldElementInsert(row)).run() }
  updateWorldElement(id: string, row: WorldElementRow): boolean { return this.db.update(novelWorldElements).set({ category: row.category, name: row.name, description: row.description, parentId: row.parent_id, attributes: row.attributes, updatedAt: row.updated_at }).where(eq(novelWorldElements.id, id)).run().changes > 0 }
  deleteWorldElement(id: string): boolean { return this.db.delete(novelWorldElements).where(eq(novelWorldElements.id, id)).run().changes > 0 }
}

function toWorldRuleInsert(row: WorldRuleRow): NovelWorldRulesInsert { return { id: row.id, projectId: row.project_id, category: row.category, rule: row.rule, cost: row.cost, isFixed: row.is_fixed, createdAt: row.created_at, updatedAt: row.updated_at } }
function toWorldRuleRow(row: NovelWorldRulesRow): WorldRuleRow { return { id: row.id, project_id: row.projectId, category: row.category, rule: row.rule, cost: row.cost, is_fixed: row.isFixed, created_at: row.createdAt, updated_at: row.updatedAt } }
function toStyleGuideInsert(row: StyleGuideRow): NovelStyleGuidesInsert { return { id: row.id, projectId: row.project_id, category: row.category, rule: row.rule, example: row.example, createdAt: row.created_at, updatedAt: row.updated_at } }
function toStyleGuideRow(row: NovelStyleGuidesRow): StyleGuideRow { return { id: row.id, project_id: row.projectId, category: row.category, rule: row.rule, example: row.example, created_at: row.createdAt, updated_at: row.updatedAt } }
function toWritingStyleInsert(row: WritingStyleProfileRow): NovelWritingStyleProfilesInsert { return { id: row.id, projectId: row.project_id, name: row.name, preset: row.preset, narrativePerson: row.narrative_person, narrativeDistance: row.narrative_distance, sentenceRhythm: row.sentence_rhythm, dialogueRatio: row.dialogue_ratio, emotionalTemperature: row.emotional_temperature, imageryDensity: row.imagery_density, vocabularyRegister: row.vocabulary_register, hardRules: row.hard_rules, softRules: row.soft_rules, positiveExamples: row.positive_examples, negativeExamples: row.negative_examples, notes: row.notes, styleExperts: row.style_experts, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } }
function toWritingStyleRow(row: NovelWritingStyleProfilesRow): WritingStyleProfileRow { return { id: row.id, project_id: row.projectId, name: row.name, preset: row.preset, narrative_person: row.narrativePerson, narrative_distance: row.narrativeDistance, sentence_rhythm: row.sentenceRhythm, dialogue_ratio: row.dialogueRatio, emotional_temperature: row.emotionalTemperature, imagery_density: row.imageryDensity, vocabulary_register: row.vocabularyRegister, hard_rules: row.hardRules, soft_rules: row.softRules, positive_examples: row.positiveExamples, negative_examples: row.negativeExamples, notes: row.notes, style_experts: row.styleExperts ?? '[]', version: row.version, created_at: row.createdAt, updated_at: row.updatedAt } }
function toStyleExpertInsert(row: StyleExpertRow): NovelStyleExpertsInsert { return { id: row.id, projectId: row.project_id, name: row.name, sourceTitle: row.source_title, sourceAuthor: row.source_author, description: row.description, distilledPrompt: row.distilled_prompt, customPrompt: row.custom_prompt, metricsJson: row.metrics_json, techniquesJson: row.techniques_json, exclusionsJson: row.exclusions_json, exemplarsJson: row.exemplars_json, expressionDnaJson: row.expression_dna_json, tensionsJson: row.tensions_json, antiPatternsJson: row.anti_patterns_json, boundariesJson: row.boundaries_json, enabled: row.enabled, sortOrder: row.sort_order, distillMeta: row.distill_meta, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } }
function toStyleExpertRow(row: NovelStyleExpertsRow): StyleExpertRow { return { id: row.id, project_id: row.projectId, name: row.name, source_title: row.sourceTitle, source_author: row.sourceAuthor, description: row.description, distilled_prompt: row.distilledPrompt, custom_prompt: row.customPrompt, metrics_json: row.metricsJson, techniques_json: row.techniquesJson, exclusions_json: row.exclusionsJson, exemplars_json: row.exemplarsJson, expression_dna_json: row.expressionDnaJson, tensions_json: row.tensionsJson, anti_patterns_json: row.antiPatternsJson, boundaries_json: row.boundariesJson, enabled: row.enabled, sort_order: row.sortOrder, distill_meta: row.distillMeta, version: row.version, created_at: row.createdAt, updated_at: row.updatedAt } }
function toConstraintInsert(row: ConstraintRow): NovelConstraintsInsert { return { id: row.id, projectId: row.project_id, type: row.type, scope: row.scope, rule: row.rule, isActive: row.is_active, relatedEntityId: row.related_entity_id, createdAt: row.created_at, updatedAt: row.updated_at } }
function toConstraintRow(row: NovelConstraintsRow): ConstraintRow { return { id: row.id, project_id: row.projectId, type: row.type, scope: row.scope, rule: row.rule, is_active: row.isActive, related_entity_id: row.relatedEntityId, created_at: row.createdAt, updated_at: row.updatedAt } }
function toWorldElementInsert(row: WorldElementRow): NovelWorldElementsInsert { return { id: row.id, projectId: row.project_id, category: row.category, name: row.name, description: row.description, parentId: row.parent_id, attributes: row.attributes, createdAt: row.created_at, updatedAt: row.updated_at } }
function toWorldElementRow(row: NovelWorldElementsRow): WorldElementRow { return { id: row.id, project_id: row.projectId, category: row.category, name: row.name, description: row.description, parent_id: row.parentId, attributes: row.attributes, created_at: row.createdAt, updated_at: row.updatedAt } }
