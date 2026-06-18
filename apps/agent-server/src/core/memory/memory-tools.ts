/**
 * memory_search 工具：记忆搜索
 *
 * 提供对 FactStore 的搜索能力，支持关键词和标签组合查询。
 */

import { z } from 'zod'
import type { FactStore } from './fact-store.js'

export const memorySearchSchema = z.object({
  query: z.string().describe('搜索查询'),
  tags: z.array(z.string()).optional().describe('按标签过滤'),
  limit: z.number().min(1).max(50).default(10).describe('返回数量限制'),
})

export type MemorySearchInput = z.infer<typeof memorySearchSchema>

export interface MemorySearchResult {
  facts: Array<{
    id: string
    content: string
    tags: string[]
    confidence: number
    source: string
  }>
  total: number
}

/** 执行记忆搜索 */
export async function executeMemorySearch(
  input: MemorySearchInput,
  factStore: FactStore,
): Promise<MemorySearchResult> {
  // 如果有标签过滤，先按标签搜索
  let facts
  if (input.tags && input.tags.length > 0) {
    facts = await factStore.searchByTags(input.tags)
  } else {
    // 无标签过滤，获取所有事实
    const all = await factStore.listFacts()
    facts = all.facts
  }

  // 如果有关键词，再按文本过滤
  if (input.query) {
    const keywords = input.query.toLowerCase().split(/\s+/).filter((k) => k.length > 0)
    if (keywords.length > 0) {
      facts = facts.filter((f) => {
        const lowerContent = f.content.toLowerCase()
        return keywords.some((kw) => lowerContent.includes(kw))
      })
    }
  }

  const total = facts.length
  const limited = facts.slice(0, input.limit)

  return {
    facts: limited.map((f) => ({
      id: f.id,
      content: f.content,
      tags: f.tags,
      confidence: f.confidence,
      source: f.source,
    })),
    total,
  }
}
