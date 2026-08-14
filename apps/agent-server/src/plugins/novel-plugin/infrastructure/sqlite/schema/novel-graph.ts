import { integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

/** 画布节点坐标持久化映射。 */
export const novelNodePositions = sqliteTable('novel_node_positions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  nodeType: text('node_type').notNull(),
  entityId: text('entity_id').notNull(),
  posX: real('pos_x').notNull(),
  posY: real('pos_y').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  projectNodeEntityUnique: unique('novel_node_positions_project_node_entity').on(
    table.projectId, table.nodeType, table.entityId,
  ),
}))

/** 时间轴标记/片段批注持久化映射。 */
export const novelMarkers = sqliteTable('novel_markers', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  chapter: integer('chapter').notNull(),
  title: text('title').notNull(),
  note: text('note').notNull(),
  type: text('type').notNull(),
  color: text('color').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** 关系图边持久化映射。 */
export const novelEdges = sqliteTable('novel_edges', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  sourceId: text('source_id').notNull(),
  sourceType: text('source_type').notNull(),
  targetId: text('target_id').notNull(),
  targetType: text('target_type').notNull(),
  edgeType: text('edge_type').notNull(),
  label: text('label').notNull(),
  auto: integer('auto').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type NovelNodePositionsRow = typeof novelNodePositions.$inferSelect
export type NovelNodePositionsInsert = typeof novelNodePositions.$inferInsert
export type NovelMarkersRow = typeof novelMarkers.$inferSelect
export type NovelMarkersInsert = typeof novelMarkers.$inferInsert
export type NovelEdgesRow = typeof novelEdges.$inferSelect
export type NovelEdgesInsert = typeof novelEdges.$inferInsert
