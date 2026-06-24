import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { FactStore } from '../core/memory/fact-store.js'
import { runMigrations } from '../core/db/migrations.js'

let tempDir: string
let db: Database.Database

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pi-fact-test-'))
  db = new Database(join(tempDir, 'test.db'))
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('FactStore CRUD', () => {
  it('addFact 添加事实并返回 ID', async () => {
    const store = new FactStore(db)
    const id = await store.addFact({
      content: '用户偏好暗色主题',
      tags: ['preference'],
      source: 'session-1:0',
      confidence: 0.9,
    })
    expect(id).toBeTruthy()

    const fact = await store.getFact(id)
    expect(fact).not.toBeNull()
    expect(fact!.content).toBe('用户偏好暗色主题')
    expect(fact!.tags).toEqual(['preference'])
    expect(fact!.confidence).toBe(0.9)
    expect(fact!.accessCount).toBe(1) // getFact 会增加访问计数
    expect(fact!.createdAt).toBeGreaterThan(0)
  })

  it('getFact 不存在时返回 null', async () => {
    const store = new FactStore(db)
    const result = await store.getFact('nonexistent')
    expect(result).toBeNull()
  })

  it('updateFact 更新事实内容', async () => {
    const store = new FactStore(db)
    const id = await store.addFact({
      content: '旧内容',
      tags: ['test'],
      source: 's1:0',
      confidence: 0.5,
    })

    await store.updateFact(id, { content: '新内容', confidence: 0.8 })

    const fact = await store.getFact(id)
    expect(fact!.content).toBe('新内容')
    expect(fact!.confidence).toBe(0.8)
    expect(fact!.updatedAt).toBeGreaterThanOrEqual(fact!.createdAt)
  })

  it('updateFact 不存在的 ID 不报错', async () => {
    const store = new FactStore(db)
    await expect(store.updateFact('nonexistent', { content: 'x' })).resolves.toBeUndefined()
  })

  it('deleteFact 删除事实', async () => {
    const store = new FactStore(db)
    const id = await store.addFact({
      content: '待删除',
      tags: [],
      source: 's1:0',
      confidence: 0.5,
    })

    await store.deleteFact(id)
    const result = await store.getFact(id)
    expect(result).toBeNull()
  })

  it('deleteFact 不存在的 ID 不报错', async () => {
    const store = new FactStore(db)
    await expect(store.deleteFact('nonexistent')).resolves.toBeUndefined()
  })
})

describe('FactStore 标签搜索', () => {
  it('searchByTags 返回包含所有指定标签的事实', async () => {
    const store = new FactStore(db)
    await store.addFact({
      content: '事实1',
      tags: ['preference', 'ui'],
      source: 's1:0',
      confidence: 0.9,
    })
    await store.addFact({
      content: '事实2',
      tags: ['preference', 'language'],
      source: 's1:1',
      confidence: 0.8,
    })
    await store.addFact({
      content: '事实3',
      tags: ['decision'],
      source: 's1:2',
      confidence: 0.7,
    })

    const results = await store.searchByTags(['preference'])
    expect(results).toHaveLength(2)
  })

  it('searchByTags 多标签交集匹配', async () => {
    const store = new FactStore(db)
    await store.addFact({
      content: '事实1',
      tags: ['preference', 'ui'],
      source: 's1:0',
      confidence: 0.9,
    })
    await store.addFact({
      content: '事实2',
      tags: ['preference', 'language'],
      source: 's1:1',
      confidence: 0.8,
    })

    const results = await store.searchByTags(['preference', 'ui'])
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('事实1')
  })

  it('searchByTags 无匹配返回空数组', async () => {
    const store = new FactStore(db)
    const results = await store.searchByTags(['nonexistent'])
    expect(results).toEqual([])
  })
})

describe('FactStore 文本搜索', () => {
  it('searchByText 关键词匹配（大小写不敏感）', async () => {
    const store = new FactStore(db)
    await store.addFact({
      content: '用户偏好 Dark Theme',
      tags: [],
      source: 's1:0',
      confidence: 0.9,
    })
    await store.addFact({
      content: '项目使用 TypeScript',
      tags: [],
      source: 's1:1',
      confidence: 0.8,
    })

    const results = await store.searchByText('dark')
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('Dark')
  })

  it('searchByText 多关键词匹配（任一匹配）', async () => {
    const store = new FactStore(db)
    await store.addFact({
      content: '使用 React 框架',
      tags: [],
      source: 's1:0',
      confidence: 0.9,
    })
    await store.addFact({
      content: '使用 Vue 框架',
      tags: [],
      source: 's1:1',
      confidence: 0.8,
    })

    const results = await store.searchByText('React Vue')
    expect(results).toHaveLength(2)
  })

  it('searchByText 无匹配返回空数组', async () => {
    const store = new FactStore(db)
    const results = await store.searchByText('nonexistent')
    expect(results).toEqual([])
  })
})

describe('FactStore 分页', () => {
  it('listFacts 默认返回所有事实', async () => {
    const store = new FactStore(db)
    for (let i = 0; i < 5; i++) {
      await store.addFact({
        content: `事实${i}`,
        tags: [],
        source: `s1:${i}`,
        confidence: 0.5,
      })
    }

    const result = await store.listFacts()
    expect(result.facts).toHaveLength(5)
    expect(result.total).toBe(5)
  })

  it('listFacts 支持分页', async () => {
    const store = new FactStore(db)
    for (let i = 0; i < 10; i++) {
      await store.addFact({
        content: `事实${i}`,
        tags: [],
        source: `s1:${i}`,
        confidence: 0.5,
      })
    }

    const page1 = await store.listFacts({ limit: 3, offset: 0 })
    expect(page1.facts).toHaveLength(3)
    expect(page1.total).toBe(10)
  })

  it('listFacts 按标签过滤', async () => {
    const store = new FactStore(db)
    await store.addFact({
      content: '偏好1',
      tags: ['preference'],
      source: 's1:0',
      confidence: 0.9,
    })
    await store.addFact({
      content: '决策1',
      tags: ['decision'],
      source: 's1:1',
      confidence: 0.8,
    })

    const result = await store.listFacts({ tag: 'preference' })
    expect(result.facts).toHaveLength(1)
    expect(result.facts[0].content).toBe('偏好1')
    expect(result.total).toBe(1)
  })
})

describe('FactStore LRU 缓存', () => {
  it('getFact 更新访问计数和时间', async () => {
    const store = new FactStore(db, { lruSize: 100 })
    const id = await store.addFact({
      content: '测试',
      tags: [],
      source: 's1:0',
      confidence: 0.5,
    })

    const first = await store.getFact(id)
    expect(first!.accessCount).toBe(1)

    // 再次访问
    const second = await store.getFact(id)
    expect(second!.accessCount).toBe(2)
    expect(second!.lastAccessedAt).toBeGreaterThanOrEqual(first!.createdAt)
  })

  it('LRU 缓存淘汰旧条目', async () => {
    const store = new FactStore(db, { lruSize: 2 })
    const id1 = await store.addFact({ content: '事实1', tags: [], source: 's1:0', confidence: 0.5 })
    const id2 = await store.addFact({ content: '事实2', tags: [], source: 's1:1', confidence: 0.5 })
    const id3 = await store.addFact({ content: '事实3', tags: [], source: 's1:2', confidence: 0.5 })

    // 缓存大小为 2，添加 3 个事实后，id1 应被淘汰出缓存
    // 但仍然可以从 SQLite 加载
    const fact1 = await store.getFact(id1)
    expect(fact1).not.toBeNull()
    expect(fact1!.content).toBe('事实1')
  })
})

describe('FactStore 持久化', () => {
  it('写操作后数据持久化到 SQLite', async () => {
    const store = new FactStore(db)
    await store.addFact({
      content: '持久化测试',
      tags: ['test'],
      source: 's1:0',
      confidence: 0.9,
    })

    // 直接查询 SQLite 验证数据已落库
    const row = db.prepare('SELECT content, tags FROM facts WHERE content = ?').get('持久化测试') as
      { content: string; tags: string } | undefined
    expect(row).toBeTruthy()
    expect(row!.content).toBe('持久化测试')
    expect(JSON.parse(row!.tags)).toEqual(['test'])
  })

  it('重新加载后数据仍在', async () => {
    const store1 = new FactStore(db)
    const id = await store1.addFact({
      content: '持久化测试',
      tags: ['test'],
      source: 's1:0',
      confidence: 0.9,
    })

    // 新实例读取同一数据库
    const db2 = new Database(join(tempDir, 'test.db'))
    runMigrations(db2) // 幂等
    const store2 = new FactStore(db2)
    const fact = await store2.getFact(id)
    expect(fact).not.toBeNull()
    expect(fact!.content).toBe('持久化测试')
    db2.close()
  })
})

describe('FactStore maxFacts 限制', () => {
  it('超过 maxFacts 时淘汰最久未访问的事实', async () => {
    const store = new FactStore(db, { maxFacts: 2 })
    const id1 = await store.addFact({ content: '事实1', tags: [], source: 's1:0', confidence: 0.5 })
    const id2 = await store.addFact({ content: '事实2', tags: [], source: 's1:1', confidence: 0.5 })

    // 访问 id1，使其成为最近访问
    await store.getFact(id1)

    // 添加第 3 个事实，应淘汰 id2（最久未访问）
    await store.addFact({ content: '事实3', tags: [], source: 's1:2', confidence: 0.5 })

    const fact1 = await store.getFact(id1)
    const fact2 = await store.getFact(id2)
    expect(fact1).not.toBeNull()
    expect(fact2).toBeNull()
  })
})
