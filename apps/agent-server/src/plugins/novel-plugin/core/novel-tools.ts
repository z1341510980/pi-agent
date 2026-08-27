/**
 * 小说创作系统工具定义
 *
 * ── 缓存命中策略（核心设计）──
 *
 * 问题：工具调用后上下文变化，导致 LLM 提供商的 prompt cache 失效。

/**
 * 小说工具桶文件（阶段 1 整理）：实现已按领域拆分到 ./tools/*，
 * 本文件只负责统一导出与组合，保持既有导入路径不变。
 */

import type { NovelStore } from './novel-store.js'
import type { NovelMemoryStore } from './novel-memory-store.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
// 桶文件本地引用（export * 不会把名字带入本文件作用域）
import {
  createNovelAskStoryTool,
  createNovelQueryStateTool,
  type ChapterBoundaryProvider,
} from './tools/story-query.js'
import {
  createNovelQueryFactionsTool,
  createNovelQueryLocationsTool,
  createNovelQueryItemsTool,
} from './tools/entity-query.js'
import {
  createNovelUpdateCharacterTool,
  createNovelUpdateForeshadowTool,
  createNovelUpdateConflictTool,
  createNovelUpdateClueTool,
  createNovelUpdateRelationshipTool,
  createNovelCreateCharacterTool,
  createNovelCreateForeshadowTool,
  createNovelCreateConflictTool,
  createNovelCreateClueTool,
  createNovelCreateRelationshipTool,
  createNovelDeleteRelationshipTool,
  createNovelCreateFactionTool,
  createNovelUpdateFactionTool,
  createNovelCreateLocationTool,
  createNovelUpdateLocationTool,
  createNovelCreateItemTool,
  createNovelUpdateItemTool,
  createNovelDeleteItemTool,
  createNovelCreateWorldElementTool,
  createNovelUpdateWorldElementTool,
} from './tools/entity-write.js'

export * from './tools/story-query.js'
export * from './tools/entity-query.js'
export * from './tools/entity-write.js'
export * from './tools/submit.js'

export function createNovelTools(
  store: NovelStore,
  memoryStore?: NovelMemoryStore,
  boundaryProvider?: ChapterBoundaryProvider,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    // A+B：语义化查询工具，优先放在列表前面便于 prompt cache 稳定
    createNovelAskStoryTool(store, memoryStore, boundaryProvider),
    createNovelQueryStateTool(store, boundaryProvider),
    createNovelUpdateCharacterTool(store),
    createNovelUpdateForeshadowTool(store),
    createNovelUpdateConflictTool(store),
    createNovelUpdateClueTool(store),
    createNovelUpdateRelationshipTool(store),
    // 创建类工具
    createNovelCreateCharacterTool(store),
    createNovelCreateForeshadowTool(store),
    createNovelCreateConflictTool(store),
    createNovelCreateClueTool(store),
    createNovelCreateRelationshipTool(store),
    // 删除类工具
    createNovelDeleteRelationshipTool(store),
    // 势力/地点/世界观要素工具
    createNovelQueryFactionsTool(store),
    createNovelCreateFactionTool(store),
    createNovelUpdateFactionTool(store),
    createNovelQueryLocationsTool(store),
    createNovelCreateLocationTool(store),
    createNovelUpdateLocationTool(store),
    // 物品工具
    createNovelQueryItemsTool(store),
    createNovelCreateItemTool(store),
    createNovelUpdateItemTool(store),
    createNovelDeleteItemTool(store),
    createNovelCreateWorldElementTool(store),
    createNovelUpdateWorldElementTool(store),
  ]
  // 按工具名排序，确保 tools schema 顺序稳定，最大化 prompt cache 命中率
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}
