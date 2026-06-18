/**
 * FactStore：结构化记忆存储
 *
 * 使用 JSON 文件存储事实，内存中维护 LRU 缓存。
 * 文件路径：${dataDir}/agent/facts.json
 *
 * 搜索能力：
 * - 标签交集匹配
 * - 文本关键词匹配（大小写不敏感）
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteSync } from '@repo/shared/utils'

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

export class FactStore {
  private readonly filePath: string
  private readonly config: FactStoreConfig
  /** 所有事实的存储 */
  private facts: Map<string, Fact> = new Map()
  /** LRU 缓存：最近访问的事实，键为 ID，值为事实 */
  private lruCache: Map<string, Fact> = new Map()
  private loaded = false

  constructor(dataDir: string, config?: Partial<FactStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.filePath = join(dataDir, 'agent', 'facts.json')
  }

  /** 延迟加载：首次访问时从文件读取 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (existsSync(this.filePath)) {
      try {
        const content = readFileSync(this.filePath, 'utf-8')
        const data = JSON.parse(content) as Fact[]
        for (const f of data) {
          if (f && typeof f.id === 'string') {
            this.facts.set(f.id, f)
          }
        }
      } catch (err) {
        console.error(`[FactStore] 加载 ${this.filePath} 失败，历史数据可能丢失:`, err)
      }
    }
  }

  /** 持久化到文件（静默失败，保留 dirty 标记以便重试） */
  private dirty = false

  private persist(): void {
    try {
      const data = Array.from(this.facts.values())
      atomicWriteSync(this.filePath, JSON.stringify(data, null, 2))
      this.dirty = false
    } catch (err) {
      console.error(`[FactStore] persist 失败，数据仅存在于内存中:`, err)
      // 保留 dirty 标记，下次操作时重试
    }
  }

  /** 持久化到文件（失败时抛出异常，用于 close 场景） */
  private persistOrThrow(): void {
    try {
      const data = Array.from(this.facts.values())
      atomicWriteSync(this.filePath, JSON.stringify(data, null, 2))
      this.dirty = false
    } catch (err) {
      console.error(`[FactStore] close 时 persist 失败，数据可能丢失:`, err)
      throw err
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
      }
    }
  }

  /** 添加事实，返回 ID */
  async addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessedAt'>): Promise<string> {
    this.ensureLoaded()
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
    this.dirty = true
    this.persist()
    return id
  }

  /** 获取事实 */
  async getFact(id: string): Promise<Fact | null> {
    this.ensureLoaded()
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
    this.ensureLoaded()
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
    this.ensureLoaded()
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
    this.ensureLoaded()
    const fact = this.facts.get(id)
    if (!fact) return
    if (updates.content !== undefined) fact.content = updates.content
    if (updates.tags !== undefined) fact.tags = updates.tags
    if (updates.confidence !== undefined) fact.confidence = updates.confidence
    fact.updatedAt = Date.now()
    this.touchLru(fact)
    this.dirty = true
    this.persist()
  }

  /** 删除事实 */
  async deleteFact(id: string): Promise<void> {
    this.ensureLoaded()
    this.facts.delete(id)
    this.lruCache.delete(id)
    this.dirty = true
    this.persist()
  }

  /** 获取所有事实（分页） */
  async listFacts(options?: { limit?: number; offset?: number; tag?: string }): Promise<{ facts: Fact[]; total: number }> {
    this.ensureLoaded()
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

  /** 关闭存储，持久化脏数据。持久化失败时抛出异常让调用方感知 */
  async close(): Promise<void> {
    if (this.dirty) {
      this.persistOrThrow()
    }
  }
}
