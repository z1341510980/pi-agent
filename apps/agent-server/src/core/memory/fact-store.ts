/**
 * FactStore：结构化记忆存储
 *
 * 使用 SQLite 存储事实（facts 表），内存中维护 LRU 缓存。
 * 写操作同步落库以保证一致性，读操作走内存 Map 缓存。
 *
 * 搜索能力：
 * - 标签交集匹配
 * - 文本关键词匹配（大小写不敏感）
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface Fact {
  /** UUID */
  id: string
  /** 事实内容 */
  content: string
  /** 标签（如 'preference', 'decision', 'context'） */
  tags: string[]
  /** 来源（sessionId:turnIndex） */
  source: string
  /** 置信度 0-1 */
  confidence: number
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
  /** 访问次数 */
  accessCount: number
  /** 最后访问时间 */
  lastAccessedAt: number
}

export interface FactStoreConfig {
  /** 最大事实数量，默认 1000 */
  maxFacts: number
  /** LRU 缓存大小，默认 100 */
  lruSize: number
}

const DEFAULT_CONFIG: FactStoreConfig = {
  maxFacts: 1000,
  lruSize: 100,
}

/** facts 表行结构 */
interface FactRow {
  id: string
  content: string
  tags: string
  source: string | null
  confidence: number
  created_at: number
  updated_at: number
  access_count: number
  last_accessed_at: number
}

export class FactStore {
  private readonly config: FactStoreConfig
  /** 所有事实的存储 */
  private facts: Map<string, Fact> = new Map()
  /** LRU 缓存：最近访问的事实，键为 ID，值为事实 */
  private lruCache: Map<string, Fact> = new Map()

  /** 预编译 SQL，提升反复执行性能 */
  private readonly stmtUpsert: Database.Statement
  private readonly stmtDelete: Database.Statement
  private readonly stmtGetAll: Database.Statement

  constructor(db: Database.Database, config?: Partial<FactStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    // 预编译语句
    this.stmtUpsert = db.prepare(`
      INSERT INTO facts (id, content, tags, source, confidence, created_at, updated_at, access_count, last_accessed_at)
      VALUES (@id, @content, @tags, @source, @confidence, @created_at, @updated_at, @access_count, @last_accessed_at)
      ON CONFLICT(id) DO UPDATE SET
        content         = excluded.content,
        tags            = excluded.tags,
        source          = excluded.source,
        confidence      = excluded.confidence,
        created_at      = excluded.created_at,
        updated_at      = excluded.updated_at,
        access_count    = excluded.access_count,
        last_accessed_at = excluded.last_accessed_at
    `)
    this.stmtDelete = db.prepare('DELETE FROM facts WHERE id = ?')
    this.stmtGetAll = db.prepare('SELECT * FROM facts')

    // 启动时把所有事实加载到内存 Map 作为读缓存
    try {
      const rows = this.stmtGetAll.all() as FactRow[]
      for (const row of rows) {
        const fact = this.rowToFact(row)
        this.facts.set(fact.id, fact)
      }
    } catch (err) {
      console.error('[FactStore] 从 SQLite 加载失败，历史数据可能丢失:', err)
    }
  }

  /** 将数据库行转换为 Fact */
  private rowToFact(row: FactRow): Fact {
    let tags: string[] = []
    try {
      const parsed = JSON.parse(row.tags)
      if (Array.isArray(parsed)) tags = parsed
    } catch {
      // tags 字段损坏时回退为空数组
    }
    return {
      id: row.id,
      content: row.content,
      tags,
      source: row.source ?? '',
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
    }
  }

  /** 持久化单条事实到 SQLite（UPSERT，静默失败） */
  private persist(fact: Fact): void {
    try {
      this.stmtUpsert.run({
        id: fact.id,
        content: fact.content,
        tags: JSON.stringify(fact.tags),
        source: fact.source,
        confidence: fact.confidence,
        created_at: fact.createdAt,
        updated_at: fact.updatedAt,
        access_count: fact.accessCount,
        last_accessed_at: fact.lastAccessedAt,
      })
    } catch (err) {
      console.error('[FactStore] persist 失败，数据仅存在于内存中:', err)
    }
  }

  /** 从 SQLite 删除单条事实（静默失败） */
  private deleteFromDb(id: string): void {
    try {
      this.stmtDelete.run(id)
    } catch (err) {
      console.error('[FactStore] deleteFromDb 失败:', err)
    }
  }

  /** 更新 LRU 缓存：将事实移到末尾 */
  private touchLru(fact: Fact): void {
    this.lruCache.delete(fact.id)
    this.lruCache.set(fact.id, fact)
    // 淘汰超出大小的旧条目
    while (this.lruCache.size > this.config.lruSize) {
      const firstKey = this.lruCache.keys().next().value
      if (firstKey !== undefined) {
        this.lruCache.delete(firstKey)
      }
    }
  }

  /** 淘汰超出 maxFacts 的最久未访问事实 */
  private evictIfNeeded(): void {
    while (this.facts.size > this.config.maxFacts) {
      // 找到最久未访问的事实（lastAccessedAt 最小，若都为 0 则取 createdAt 最小）
      let oldestId: string | null = null
      let oldestTime = Infinity
      for (const [id, fact] of this.facts) {
        const time = fact.lastAccessedAt || fact.createdAt
        if (time < oldestTime) {
          oldestTime = time
          oldestId = id
        }
      }
      if (oldestId) {
        this.facts.delete(oldestId)
        this.lruCache.delete(oldestId)
        this.deleteFromDb(oldestId)
      }
    }
  }

  /** 添加事实，返回 ID */
  async addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessedAt'>): Promise<string> {
    const now = Date.now()
    const id = randomUUID()
    const full: Fact = {
      ...fact,
      id,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessedAt: now,
    }
    this.facts.set(id, full)
    this.touchLru(full)
    this.evictIfNeeded()
    this.persist(full)
    return id
  }

  /** 获取事实 */
  async getFact(id: string): Promise<Fact | null> {
    const fact = this.facts.get(id)
    if (!fact) return null
    // 更新访问计数和时间
    fact.accessCount++
    fact.lastAccessedAt = Date.now()
    this.touchLru(fact)
    return fact
  }

  /** 按标签搜索（交集匹配） */
  async searchByTags(tags: string[]): Promise<Fact[]> {
    if (tags.length === 0) return Array.from(this.facts.values())
    const results: Fact[] = []
    for (const fact of this.facts.values()) {
      if (tags.every((tag) => fact.tags.includes(tag))) {
        results.push(fact)
      }
    }
    return results
  }

  /** 全文搜索（简单关键词匹配，大小写不敏感） */
  async searchByText(query: string): Promise<Fact[]> {
    const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length > 0)
    if (keywords.length === 0) return Array.from(this.facts.values())
    const results: Fact[] = []
    for (const fact of this.facts.values()) {
      const lowerContent = fact.content.toLowerCase()
      if (keywords.some((kw) => lowerContent.includes(kw))) {
        results.push(fact)
      }
    }
    return results
  }

  /** 更新事实 */
  async updateFact(id: string, updates: Partial<Pick<Fact, 'content' | 'tags' | 'confidence'>>): Promise<void> {
    const fact = this.facts.get(id)
    if (!fact) return
    if (updates.content !== undefined) fact.content = updates.content
    if (updates.tags !== undefined) fact.tags = updates.tags
    if (updates.confidence !== undefined) fact.confidence = updates.confidence
    fact.updatedAt = Date.now()
    this.touchLru(fact)
    this.persist(fact)
  }

  /** 删除事实 */
  async deleteFact(id: string): Promise<void> {
    this.facts.delete(id)
    this.lruCache.delete(id)
    this.deleteFromDb(id)
  }

  /** 获取所有事实（分页） */
  async listFacts(options?: { limit?: number; offset?: number; tag?: string }): Promise<{ facts: Fact[]; total: number }> {
    let filtered = Array.from(this.facts.values())
    if (options?.tag) {
      filtered = filtered.filter((f) => f.tags.includes(options.tag!))
    }
    const total = filtered.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? total
    const facts = filtered.slice(offset, offset + limit)
    return { facts, total }
  }

  /** 关闭存储。写操作已即时落库，无需额外持久化 */
  async close(): Promise<void> {
    // 数据已在每次写操作时同步写入 SQLite，此处无需额外处理
  }
}
