import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

/** 实体出场横切表。实体主表的 chapter_spans 仍由领域层负责兼容与对账。 */
export const novelEntityAppearances = sqliteTable('novel_entity_appearances', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  chapterId: text('chapter_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  appearanceRole: text('appearance_role').notNull(),
  source: text('source').notNull(),
  createdAt: integer('created_at').notNull(),
  status: text('status').notNull(),
}, (table) => ({
  chapterEntityRoleUnique: unique('novel_entity_appearances_chapter_entity_role').on(
    table.chapterId, table.entityType, table.entityId, table.appearanceRole,
  ),
}))

export const novelEntityCandidates = sqliteTable('novel_entity_candidates', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  chapterNumber: integer('chapter_number'),
  contentRevisionId: text('content_revision_id'),
  entityType: text('entity_type').notNull(),
  payload: text('payload').notNull(),
  status: text('status').notNull(),
  reasonCode: text('reason_code'),
  createdAt: integer('created_at').notNull(),
})

export const novelEntityCandidateReviews = sqliteTable('novel_entity_candidate_reviews', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id').notNull(),
  decision: text('decision').notNull(),
  reason: text('reason').notNull(),
  actorId: text('actor_id').notNull(),
  auditContext: text('audit_context').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const novelEntityCandidatePromotions = sqliteTable('novel_entity_candidate_promotions', {
  candidateId: text('candidate_id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const novelProjectionOutbox = sqliteTable('novel_projection_outbox', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  topic: text('topic').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  payload: text('payload').notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull(),
  createdAt: integer('created_at').notNull(),
  deliveredAt: integer('delivered_at'),
}, (table) => ({
  topicAggregateUnique: unique('novel_projection_outbox_topic_aggregate').on(table.topic, table.aggregateId),
}))

export type NovelEntityAppearancesRow = typeof novelEntityAppearances.$inferSelect
export type NovelEntityAppearancesInsert = typeof novelEntityAppearances.$inferInsert
export type NovelEntityCandidatesRow = typeof novelEntityCandidates.$inferSelect
export type NovelEntityCandidatesInsert = typeof novelEntityCandidates.$inferInsert
export type NovelEntityCandidateReviewsRow = typeof novelEntityCandidateReviews.$inferSelect
export type NovelEntityCandidateReviewsInsert = typeof novelEntityCandidateReviews.$inferInsert
export type NovelEntityCandidatePromotionsInsert = typeof novelEntityCandidatePromotions.$inferInsert
export type NovelProjectionOutboxInsert = typeof novelProjectionOutbox.$inferInsert
