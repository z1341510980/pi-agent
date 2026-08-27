/**
 * 实体查询工具：novel_query_factions / locations / items。
 * 从 novel-tools.ts 拆出（阶段 1 整理）。
 */

// 导入头：从原 novel-tools.ts 拆出时带入
import { Type } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { NovelStore } from '../novel-store.js'

const QueryFactionsParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
})

const QueryLocationsParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
})

const QueryItemsParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  /** 可选：按持有者过滤，传角色 ID 返回该角色拥有的所有物品 */
  ownerId: Type.Optional(Type.String({ description: '按持有者角色 ID 过滤；不传则返回项目所有物品' })),
})

export function createNovelQueryFactionsTool(store: NovelStore): ToolDefinition<typeof QueryFactionsParams> {
  return defineTool({
    name: 'novel_query_factions',
    label: '查询势力',
    description:
      '查询小说项目下的所有势力（组织/门派/王国/家族/公会/邪教）。' +
      '包含势力的类型、首领、理念、实力、盟友/敌人列表和当前状态。此工具只读不写。',
    promptSnippet: '查询势力列表',
    parameters: QueryFactionsParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const factions = store.listFactions(params.projectId)
      return {
        content: [{ type: 'text', text: JSON.stringify(factions, null, 2) }],
        details: undefined,
      }
    },
  })
}

/** 创建势力 */

export function createNovelQueryLocationsTool(store: NovelStore): ToolDefinition<typeof QueryLocationsParams> {
  return defineTool({
    name: 'novel_query_locations',
    label: '查询地点',
    description:
      '查询小说项目下的所有地点（大陆/国家/城市/建筑/地下城/区域/荒野）。' +
      '包含地点的类型、父级地点、归属势力、重要程度和状态。此工具只读不写。',
    promptSnippet: '查询地点列表',
    parameters: QueryLocationsParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const locations = store.listLocations(params.projectId)
      return {
        content: [{ type: 'text', text: JSON.stringify(locations, null, 2) }],
        details: undefined,
      }
    },
  })
}

/** 创建地点 */

export function createNovelQueryItemsTool(store: NovelStore): ToolDefinition<typeof QueryItemsParams> {
  return defineTool({
    name: 'novel_query_items',
    label: '查询物品',
    description:
      '查询小说项目下的所有物品（武器/防具/法宝/消耗品/关键道具/材料/情报物品/杂物）。' +
      '包含物品的类型、持有者、状态、能力、来源和首次出现章节。传 ownerId 可按持有者过滤。此工具只读不写。',
    promptSnippet: '查询物品列表',
    parameters: QueryItemsParams,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const items = params.ownerId
        ? store.listItemsByOwner(params.ownerId)
        : store.listItems(params.projectId)
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        details: undefined,
      }
    },
  })
}

/** 创建物品 */
