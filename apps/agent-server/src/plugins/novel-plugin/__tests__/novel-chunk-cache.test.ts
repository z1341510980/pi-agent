/**
 * P4 前置：跨章 Chunk 缓存测试（§5.6）。
 *
 * 守护：
 * 1. computeChunkVersionKey 确定性：同输入同 key；任一分量变化 → key 变化（失效语义）；
 * 2. ChunkCache get/put/hit 统计；
 * 3. buildWithChunkCache 复用循环：首次全 miss 并缓存，二次同 versionKey 全命中；
 *    输入变化（如 Memory applyChanges 后 projectUpdatedAt 变）→ 全 miss（§5.6 失效入口）；
 * 4. clearProject 只清该项目。
 */
import { describe, expect, it } from 'vitest'
import {
  buildChunkVersionSource,
  buildWithChunkCache,
  buildWithChunkCacheLazy,
  ChunkCache,
  computeChunkVersionKey,
  type ChunkVersionSource,
  type ChunkVersionSourceProvider,
} from '../core/prompting/chunk-cache.js'

const baseSource: ChunkVersionSource = {
  projectUpdatedAt: 1000,
  entityRevisionIds: [['c1', 500], ['c2', 400]],
  latestMemoryEventId: 'evt-1',
  styleProfileVersion: 'v3',
  chapterVersion: 1000,
  contextAnchorVersion: 1000,
}

describe('computeChunkVersionKey（§5.6）', () => {
  it('确定性：同输入同 key；分量顺序无关', () => {
    expect(computeChunkVersionKey(baseSource)).toBe(computeChunkVersionKey(baseSource))
    expect(computeChunkVersionKey(baseSource)).toBe(computeChunkVersionKey({
      ...baseSource,
      entityRevisionIds: [['c2', 400], ['c1', 500]], // 顺序打乱
    }))
  })

  it('任一分量变化 → key 变化（失效语义）', () => {
    const base = computeChunkVersionKey(baseSource)
    expect(computeChunkVersionKey({ ...baseSource, projectUpdatedAt: 1001 })).not.toBe(base)
    expect(computeChunkVersionKey({ ...baseSource, latestMemoryEventId: 'evt-2' })).not.toBe(base)
    expect(computeChunkVersionKey({ ...baseSource, styleProfileVersion: 'v4' })).not.toBe(base)
    expect(computeChunkVersionKey({ ...baseSource, entityRevisionIds: [['c1', 600], ['c2', 400]] })).not.toBe(base)
  })
})

describe('ChunkCache', () => {
  it('get 命中/未命中统计', () => {
    const cache = new ChunkCache()
    const entry = {
      projectId: 'p1', chunkId: 'story-ledger', versionKey: 'k1', content: 'x', contentHash: 'h', updatedAt: 0,
    }
    cache.put(entry)
    expect(cache.get('p1', 'story-ledger', 'k1', 'h')?.content).toBe('x')
    expect(cache.get('p1', 'story-ledger', 'k2', 'h')?.content).toBeUndefined()
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, entries: 1, evictions: 0 })
  })

  it('clearProject 只清该项目', () => {
    const cache = new ChunkCache()
    cache.put({ projectId: 'p1', chunkId: 'a', versionKey: 'k', content: '1', contentHash: 'h', updatedAt: 0 })
    cache.put({ projectId: 'p2', chunkId: 'a', versionKey: 'k', content: '2', contentHash: 'h', updatedAt: 0 })
    cache.clearProject('p1')
    expect(cache.stats().entries).toBe(1)
    expect(cache.get('p2', 'a', 'k', 'h')).toBeDefined()
  })

  it('容量上限：超限淘汰最旧条目，防长跑进程内存单调增长', () => {
    const cache = new ChunkCache(3)
    for (let i = 0; i < 5; i++) {
      cache.put({ projectId: 'p1', chunkId: 'a', versionKey: `v${i}`, content: String(i), contentHash: `h${i}`, updatedAt: i })
    }
    const stats = cache.stats()
    expect(stats.entries).toBe(3)
    expect(stats.evictions).toBe(2)
    // 最旧两条（v0/v1）已淘汰，最新三条保留
    expect(cache.get('p1', 'a', 'v0', 'h0')).toBeUndefined()
    expect(cache.get('p1', 'a', 'v4', 'h4')?.content).toBe('4')
  })
})

describe('buildWithChunkCache（§5.6 复用循环）', () => {
  it('首次全 miss 并缓存；二次同 versionKey 全命中', () => {
    const cache = new ChunkCache()
    const chunks = [
      { chunkId: 'chapter-info', content: '章节信息内容' },
      { chunkId: 'story-ledger', content: '账本承接内容' },
    ]
    const first = buildWithChunkCache(cache, { projectId: 'p1', versionSource: baseSource, chunks })
    expect(first.misses).toBe(2)
    expect(first.hits).toBe(0)
    expect(first.chunks.every((c) => !c.fromCache)).toBe(true)

    const second = buildWithChunkCache(cache, { projectId: 'p1', versionSource: baseSource, chunks })
    expect(second.hits).toBe(2)
    expect(second.misses).toBe(0)
    expect(second.chunks.every((c) => c.fromCache)).toBe(true)
    // 缓存内容与原始一致
    expect(second.chunks[0].content).toBe('章节信息内容')
  })

  it('输入变化（如 Memory applyChanges）→ 全 miss（§5.6 失效入口）', () => {
    const cache = new ChunkCache()
    const chunks = [{ chunkId: 'story-ledger', content: 'v1' }]
    buildWithChunkCache(cache, { projectId: 'p1', versionSource: baseSource, chunks })
    // Memory applyChanges 后 projectUpdatedAt 变化
    const afterChange = buildWithChunkCache(cache, {
      projectId: 'p1',
      versionSource: { ...baseSource, projectUpdatedAt: 2000 },
      chunks,
    })
    expect(afterChange.misses).toBe(1)
    expect(afterChange.hits).toBe(0)
  })

  it('相同 versionKey 但 chunk 内容变化时不得复用旧内容', () => {
    const cache = new ChunkCache()
    const first = buildWithChunkCache(cache, {
      projectId: 'p1', versionSource: baseSource,
      chunks: [{ chunkId: 'chapter-info', content: '第一章' }],
    })
    const second = buildWithChunkCache(cache, {
      projectId: 'p1', versionSource: baseSource,
      chunks: [{ chunkId: 'chapter-info', content: '第二章' }],
    })
    expect(first.chunks[0].content).toBe('第一章')
    expect(second.misses).toBe(1)
    expect(second.hits).toBe(0)
    expect(second.chunks[0].content).toBe('第二章')
  })
})

describe('buildWithChunkCacheLazy（§5.6 先查后建）', () => {
  it('二次命中时不调用 build()，真正省构建', () => {
    const cache = new ChunkCache()
    let buildCount = 0
    const request = {
      projectId: 'p1',
      versionSource: baseSource,
      builders: [{
        chunkId: 'chapter-info',
        scope: 'ch1-writer',
        build: () => { buildCount++; return '章节信息' },
      }],
    }
    const first = buildWithChunkCacheLazy(cache, request)
    expect(first.misses).toBe(1)
    expect(buildCount).toBe(1)
    const second = buildWithChunkCacheLazy(cache, request)
    expect(second.hits).toBe(1)
    expect(buildCount).toBe(1) // 核心守门：命中未再次 build
    expect(second.chunks[0]).toMatchObject({ content: '章节信息', fromCache: true })
  })

  it('scope 变化即 miss，防章节/角色/任务变体串用', () => {
    const cache = new ChunkCache()
    let buildCount = 0
    const make = (scope: string, content: string) => ({
      projectId: 'p1', versionSource: baseSource,
      builders: [{ chunkId: 'chapter-info', scope, build: () => { buildCount++; return content } }],
    })
    buildWithChunkCacheLazy(cache, make('ch1-writer', '第一章'))
    const changed = buildWithChunkCacheLazy(cache, make('ch2-writer', '第二章'))
    expect(changed.misses).toBe(1)
    expect(changed.chunks[0].content).toBe('第二章')
    expect(buildCount).toBe(2)
  })

  it('可选 chunk 返回 null 时缓存空哨兵，二次不 build 且不参与组装', () => {
    const cache = new ChunkCache()
    let buildCount = 0
    const request = {
      projectId: 'p1', versionSource: baseSource,
      builders: [{
        chunkId: 'hooks', scope: 'ch1',
        build: () => { buildCount++; return null },
      }],
    }
    const first = buildWithChunkCacheLazy(cache, request)
    expect(first.chunks).toHaveLength(0)
    expect(first.misses).toBe(1)
    const second = buildWithChunkCacheLazy(cache, request)
    expect(second.chunks).toHaveLength(0)
    expect(second.hits).toBe(1)
    expect(buildCount).toBe(1)
  })

  it('缓存条目保留真实 contentHash，scopeKey 单独存储', () => {
    const cache = new ChunkCache()
    buildWithChunkCacheLazy(cache, {
      projectId: 'p1', versionSource: baseSource,
      builders: [{ chunkId: 'story-state', scope: 'summary', build: () => '摘要内容' }],
    })
    const versionKey = computeChunkVersionKey(baseSource)
    const entry = cache.get('p1', 'story-state', versionKey, 'summary')
    expect(entry?.scopeKey).toBe('summary')
    expect(entry?.contentHash).not.toBe('summary')
    expect(entry?.contentHash).toHaveLength(16)
  })
})

describe('buildChunkVersionSource（P4 接入第 1 步）', () => {
  function makeProvider(overrides: Partial<ChunkVersionSourceProvider> = {}): ChunkVersionSourceProvider {
    return {
      getProject: () => ({ updatedAt: 1000 }),
      listCharacters: () => [],
      listConflicts: () => [],
      listForeshadowing: () => [],
      listClues: () => [],
      listFactions: () => [],
      listLocations: () => [],
      listItems: () => [],
      listWorldElements: () => [],
      listRelationships: () => [],
      getWritingStyleProfile: () => undefined,
      ...overrides,
    }
  }

  it('聚合各表 max updatedAt；空表不产生指纹项', () => {
    const source = buildChunkVersionSource(makeProvider(), 'p1')
    expect(source.projectUpdatedAt).toBe(1000)
    expect(source.entityRevisionIds).toHaveLength(0) // 全部空表
    expect(source.latestMemoryEventId).toBeNull()
    expect(source.styleProfileVersion).toBeNull()
  })

  it('实体修订 → 对应表指纹变化 → versionKey 变化（失效语义）', () => {
    const provider = makeProvider({ listCharacters: () => [{ updatedAt: 500 }] })
    const source1 = buildChunkVersionSource(provider, 'p1')
    const key1 = computeChunkVersionKey(source1)
    // 角色被编辑（updatedAt 变 600）
    const source2 = buildChunkVersionSource(
      makeProvider({ listCharacters: () => [{ updatedAt: 600 }] }),
      'p1',
    )
    expect(computeChunkVersionKey(source2)).not.toBe(key1)
    // 角色未被编辑时 key 稳定
    const source3 = buildChunkVersionSource(
      makeProvider({ listCharacters: () => [{ updatedAt: 500 }] }),
      'p1',
    )
    expect(computeChunkVersionKey(source3)).toBe(key1)
  })

  it('账本事件 / 文风档案变化 → versionKey 变化', () => {
    // provider 自带 getLatestStoryEventId 时生效
    const base = makeProvider({ getLatestStoryEventId: () => 'evt-1' })
    const key1 = computeChunkVersionKey(buildChunkVersionSource(base, 'p1'))
    const key2 = computeChunkVersionKey(buildChunkVersionSource(
      makeProvider({ getLatestStoryEventId: () => 'evt-2' }),
      'p1',
    ))
    expect(key2).not.toBe(key1)
    const key3 = computeChunkVersionKey(buildChunkVersionSource(
      makeProvider({ getWritingStyleProfile: () => ({ updatedAt: 999 }) }),
      'p1',
    ))
    expect(key3).not.toBe(key1)
  })

  it('章节与锚点版本变化 → versionKey 变化', () => {
    const provider = makeProvider({
      listChapters: () => [{ updatedAt: 100 }, { updatedAt: 200 }],
      getContextAnchorVersion: () => 300,
    })
    const key1 = computeChunkVersionKey(buildChunkVersionSource(provider, 'p1'))
    const chapterChanged = makeProvider({
      listChapters: () => [{ updatedAt: 100 }, { updatedAt: 201 }],
      getContextAnchorVersion: () => 300,
    })
    const anchorChanged = makeProvider({
      listChapters: () => [{ updatedAt: 100 }, { updatedAt: 200 }],
      getContextAnchorVersion: () => 301,
    })
    expect(computeChunkVersionKey(buildChunkVersionSource(chapterChanged, 'p1'))).not.toBe(key1)
    expect(computeChunkVersionKey(buildChunkVersionSource(anchorChanged, 'p1'))).not.toBe(key1)
  })

  it('缺少新增可选版本源时保持兼容（新维度按 0 处理）', () => {
    const source = buildChunkVersionSource(makeProvider(), 'p1')
    expect(source.chapterVersion).toBeNull()
    expect(source.contextAnchorVersion).toBeNull()
  })

  it('eventSource 参数（memoryStore）单独提供账本 id 且优先于 provider', () => {
    const plain = makeProvider()
    // 只由 eventSource 提供
    const withEvent = computeChunkVersionKey(
      buildChunkVersionSource(plain, 'p1', { getLatestStoryEventId: () => 'evt-9' }),
    )
    expect(withEvent).not.toBe(computeChunkVersionKey(buildChunkVersionSource(plain, 'p1')))
    // eventSource 优先于 provider 自带实现
    const conflicting = makeProvider({ getLatestStoryEventId: () => 'evt-provider' })
    expect(
      computeChunkVersionKey(buildChunkVersionSource(conflicting, 'p1', { getLatestStoryEventId: () => 'evt-9' })),
    ).toBe(withEvent)
    // 账本为空（无事件）时不影响其他分量
    expect(
      computeChunkVersionKey(buildChunkVersionSource(plain, 'p1', { getLatestStoryEventId: () => undefined })),
    ).toBe(computeChunkVersionKey(buildChunkVersionSource(plain, 'p1')))
  })
})
