import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { executeMemorySearch } from '../core/memory/memory-tools.js'
import { FactStore } from '../core/memory/fact-store.js'
import type { MemorySearchInput } from '../core/memory/memory-tools.js'
import { runMigrations } from '../core/db/migrations.js'

let db: Database.Database
let factStore: FactStore

beforeEach(async () => {
  db = new Database(':memory:')
  runMigrations(db)
  factStore = new FactStore(db)

  // 预置测试数据
  await factStore.addFact({
    content: '用户偏好暗色主题',
    tags: ['preference', 'ui'],
    source: 'session-1:0',
    confidence: 0.9,
  })
  await factStore.addFact({
    content: '项目使用 TypeScript 和 React',
    tags: ['decision', 'tech'],
    source: 'session-1:1',
    confidence: 0.8,
  })
  await factStore.addFact({
    content: '部署环境为 AWS',
    tags: ['decision', 'infra'],
    source: 'session-2:0',
    confidence: 0.7,
  })
})

afterEach(() => {
  db.close()
})

describe('executeMemorySearch', () => {
  it('按关键词搜索', async () => {
    const input: MemorySearchInput = { query: '暗色', limit: 10 }
    const result = await executeMemorySearch(input, factStore)
    expect(result.facts).toHaveLength(1)
    expect(result.facts[0].content).toContain('暗色')
    expect(result.total).toBe(1)
  })

  it('按标签过滤', async () => {
    const input: MemorySearchInput = { query: '', tags: ['decision'], limit: 10 }
    const result = await executeMemorySearch(input, factStore)
    expect(result.facts).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it('关键词 + 标签组合搜索', async () => {
    const input: MemorySearchInput = { query: 'TypeScript', tags: ['decision'], limit: 10 }
    const result = await executeMemorySearch(input, factStore)
    expect(result.facts).toHaveLength(1)
    expect(result.facts[0].content).toContain('TypeScript')
  })

  it('限制返回数量', async () => {
    const input: MemorySearchInput = { query: '', tags: ['decision'], limit: 1 }
    const result = await executeMemorySearch(input, factStore)
    expect(result.facts).toHaveLength(1)
    expect(result.total).toBe(2)
  })

  it('搜索结果格式正确', async () => {
    const input: MemorySearchInput = { query: '暗色', limit: 10 }
    const result = await executeMemorySearch(input, factStore)
    const fact = result.facts[0]
    expect(fact).toHaveProperty('id')
    expect(fact).toHaveProperty('content')
    expect(fact).toHaveProperty('tags')
    expect(fact).toHaveProperty('confidence')
    expect(fact).toHaveProperty('source')
    // 不应包含内部字段
    expect(fact).not.toHaveProperty('accessCount')
    expect(fact).not.toHaveProperty('lastAccessedAt')
  })

  it('无匹配结果返回空', async () => {
    const input: MemorySearchInput = { query: 'nonexistent', limit: 10 }
    const result = await executeMemorySearch(input, factStore)
    expect(result.facts).toHaveLength(0)
    expect(result.total).toBe(0)
  })
})
