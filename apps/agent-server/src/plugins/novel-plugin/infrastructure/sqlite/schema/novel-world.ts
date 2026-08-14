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
  vocabularyRegister: text('vocabulary_register').notNull(), hardRules: text('hard_rules').notNull(), softRules: text('soft_rules').notNull(),
  positiveExamples: text('positive_examples').notNull(), negativeExamples: text('negative_examples').notNull(), notes: text('notes').notNull(),
  version: integer('version').notNull(), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
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
export type NovelConstraintsRow = typeof novelConstraints.$inferSelect
export type NovelConstraintsInsert = typeof novelConstraints.$inferInsert
export type NovelWorldElementsRow = typeof novelWorldElements.$inferSelect
export type NovelWorldElementsInsert = typeof novelWorldElements.$inferInsert
