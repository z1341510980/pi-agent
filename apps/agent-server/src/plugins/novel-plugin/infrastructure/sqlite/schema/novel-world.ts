import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const novelWorldRules = sqliteTable('novel_world_rules', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), category: text('category').notNull(),
  rule: text('rule').notNull(), cost: text('cost'), isFixed: integer('is_fixed').notNull(),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export const novelStyleGuides = sqliteTable('novel_style_guides', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), category: text('category').notNull(),
  rule: text('rule').notNull(), example: text('example'), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export const novelWritingStyleProfiles = sqliteTable('novel_writing_style_profiles', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull().unique(), name: text('name').notNull(), preset: text('preset').notNull(),
  narrativePerson: text('narrative_person').notNull(), narrativeDistance: text('narrative_distance').notNull(), sentenceRhythm: text('sentence_rhythm').notNull(),
  dialogueRatio: real('dialogue_ratio').notNull(), emotionalTemperature: real('emotional_temperature').notNull(), imageryDensity: real('imagery_density').notNull(),
  vocabularyRegister: text('vocabulary_register').notNull(), hardRules: text('hard_rules').notNull(), softRules: text('soft_rules').notNull(), styleExperts: text('style_experts').notNull().default('[]'),
  positiveExamples: text('positive_examples').notNull(), negativeExamples: text('negative_examples').notNull(), notes: text('notes').notNull(),
  version: integer('version').notNull(), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export const novelStyleExperts = sqliteTable('novel_style_experts', {
  id: text('id').notNull(), projectId: text('project_id').notNull(), name: text('name').notNull(),
  sourceTitle: text('source_title').notNull(), sourceAuthor: text('source_author'), description: text('description').notNull(),
  distilledPrompt: text('distilled_prompt').notNull(), metricsJson: text('metrics_json'), techniquesJson: text('techniques_json'), exclusionsJson: text('exclusions_json'), exemplarsJson: text('exemplars_json'), customPrompt: text('custom_prompt'), enabled: integer('enabled').notNull().default(1),
  // 迁移 118（蒸馏契约 v2）：语言指纹、内在张力、反模式与诚实边界
  expressionDnaJson: text('expression_dna_json'), tensionsJson: text('tensions_json'),
  antiPatternsJson: text('anti_patterns_json'), boundariesJson: text('boundaries_json'),
  sortOrder: integer('sort_order').notNull().default(0), distillMeta: text('distill_meta'), version: integer('version').notNull().default(1),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export const novelStyleExpertVersions = sqliteTable('novel_style_expert_versions', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), expertId: text('expert_id').notNull(), version: integer('version').notNull(),
  name: text('name').notNull(), sourceTitle: text('source_title'), sourceAuthor: text('source_author'), description: text('description').notNull(),
  customPrompt: text('custom_prompt'), enabled: integer('enabled').notNull(), sortOrder: integer('sort_order'), createdAt: integer('created_at').notNull(),
})

export const novelConstraints = sqliteTable('novel_constraints', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), type: text('type').notNull(), scope: text('scope').notNull(),
  rule: text('rule').notNull(), isActive: integer('is_active').notNull(), relatedEntityId: text('related_entity_id'),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export const novelWorldElements = sqliteTable('novel_world_elements', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), category: text('category').notNull(), name: text('name').notNull(),
  description: text('description').notNull(), parentId: text('parent_id'), attributes: text('attributes').notNull(),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
})

export type NovelWorldRulesRow = typeof novelWorldRules.$inferSelect
export type NovelWorldRulesInsert = typeof novelWorldRules.$inferInsert
export type NovelStyleGuidesRow = typeof novelStyleGuides.$inferSelect
export type NovelStyleGuidesInsert = typeof novelStyleGuides.$inferInsert
export type NovelWritingStyleProfilesRow = typeof novelWritingStyleProfiles.$inferSelect
export type NovelWritingStyleProfilesInsert = typeof novelWritingStyleProfiles.$inferInsert
export type NovelStyleExpertsRow = typeof novelStyleExperts.$inferSelect
export type NovelStyleExpertsInsert = typeof novelStyleExperts.$inferInsert
export type NovelConstraintsRow = typeof novelConstraints.$inferSelect
export type NovelConstraintsInsert = typeof novelConstraints.$inferInsert
export type NovelWorldElementsRow = typeof novelWorldElements.$inferSelect
export type NovelWorldElementsInsert = typeof novelWorldElements.$inferInsert
