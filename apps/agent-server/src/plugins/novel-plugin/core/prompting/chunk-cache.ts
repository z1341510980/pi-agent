/**
 * chunk-cache：跨章 Chunk 复用（P4 前置，方案 §5.6）
 *
 * 不做 Markdown 全文 diff，改做 Chunk 版本哈希：
 * - ContextChunkCacheEntry：chunkId + versionKey + content + contentHash；
 * - computeChunkVersionKey：hash({ projectUpdatedAt, entityRevisionIds,
 *   latestMemoryEventId, styleProfileVersion })——输入为 ChunkVersionSource 接口，
 *   数据源实现（各表更新时间聚合）在生成路径接入时注入；
 * - ChunkCache：进程级内存缓存（get/put/hit 统计）；eager key 使用 contentHash，
 *   lazy key 使用 scopeKey（内容指纹仍单独保留）；
 * - 生成路径使用 lazy 复用循环：先查缓存，命中不执行 build，未命中才构建并 put。
 *
 * 失效入口（§5.6）：Memory applyChanges / syncChapterDimensions / 手工编辑实体 /
 * 文风档案变更 / 正文或计划版本切换——统一表现为 versionKey 输入变化 → 缓存 miss。
 */
import { createHash } from 'node:crypto'

/** §5.6 Chunk 缓存条目 */
export interface ContextChunkCacheEntry {
  projectId: string
  chunkId: string
  versionKey: string
  content: string
  /** 内容真实性指纹：始终是 content 的 SHA-256 摘要，不承载查找 scope。 */
  contentHash: string
  /**
   * 惰性缓存查找维度。存在时 Map key 使用 scopeKey；旧 eager 路径未提供时
   * 继续使用 contentHash，保持原 API 与已有缓存测试兼容。
   */
  scopeKey?: string
  updatedAt: number
}

/** versionKey 计算输入（数据源由生成路径提供，缺失字段用 null 占位） */
export interface ChunkVersionSource {
  projectUpdatedAt: number | null
  /** 实体修订时间戳（按 id 排序的 {id: ts} 或紧凑字符串），变化 → 相关 chunk 失效 */
  entityRevisionIds: ReadonlyArray<[string, number]>
  /** 账本最新事件 id + 时间（无事件为 null） */
  latestMemoryEventId: string | null
  /** 文风档案版本号（无档案为 null） */
  styleProfileVersion: string | null
  /** 正文/章纲/计划版本（无章节为 null） */
  chapterVersion?: number | null
  /** hooks + 信息层等锚点状态的最新版本（无记录为 null） */
  contextAnchorVersion?: number | null
}

/** 计算 chunk 版本 key（§5.6）：确定性哈希，输入变化 → key 变化 → 缓存失效 */
export function computeChunkVersionKey(source: ChunkVersionSource): string {
  const parts = [
    `p:${source.projectUpdatedAt ?? 0}`,
    `e:${source.entityRevisionIds
      .slice()
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, ts]) => `${id}:${ts}`)
      .join(',')}`,
    `m:${source.latestMemoryEventId ?? ''}`,
    `s:${source.styleProfileVersion ?? ''}`,
    `c:${source.chapterVersion ?? 0}`,
    `a:${source.contextAnchorVersion ?? 0}`,
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

/**
 * versionKey 数据源的最小依赖接口（P4 接入第 1 步）。
 * 用 duck typing 避免与 NovelStore 强耦合，NovelStore / NovelMemoryStore 天然满足。
 */
export interface ChunkVersionSourceProvider {
  getProject(id: string): { updatedAt?: number } | undefined
  listCharacters(id: string): Array<{ updatedAt: number }>
  listConflicts(id: string): Array<{ updatedAt: number }>
  listForeshadowing(id: string): Array<{ updatedAt: number }>
  listClues(id: string): Array<{ updatedAt: number }>
  listFactions(id: string): Array<{ updatedAt: number }>
  listLocations(id: string): Array<{ updatedAt: number }>
  listItems(id: string): Array<{ updatedAt: number }>
  listWorldElements(id: string): Array<{ updatedAt: number }>
  listRelationships(id: string): Array<{ updatedAt: number }>
  getWritingStyleProfile(id: string): { updatedAt?: number } | undefined
  /**
   * 账本最新事件 id（可选，由 memoryStore 提供）。
   * 用 getLatestStoryEventId（单条 SQL）而非 listStoryEvents，避免每次
   * 构建 versionKey 都全量映射事件对象。
   */
  getLatestStoryEventId?(id: string): string | undefined
  /** 章节正文/章纲/计划版本的最新更新时间（正文或计划变化 → miss）。 */
  /** 章节列表（用于正文/章纲版本指纹；可选，旧 provider 兼容）。 */
  listChapters?(id: string): Array<{ updatedAt: number }>
  /** hooks / 信息层变更指纹（锚点与信息差 chunk 的失效维度）。 */
  getContextAnchorVersion?(id: string): number | null
}

/**
 * 聚合 versionKey 数据源（P4 接入第 1 步）。
 *
 * entityRevisionIds 采用**表级 max(updatedAt) 指纹**（如 [['characters', 1738123456], ...]），
 * 比逐实体 id 更紧凑且满足 §5.6 语义（任一实体修订 → 对应表指纹变化 → key 变化）。
 * 失效入口（Memory applyChanges / 手工编辑实体 / 文风变更 / 版本切换）统一表现为
 * 某一分量变化 → 缓存 miss。
 *
 * @param eventSource 账本来源（memoryStore）。分开传是因为 NovelStore 不持有事件表，
 *   latestMemoryEventId 必须来自 NovelMemoryStore；省略时该分量为 null（chunk 仍会
 *   因 projectUpdatedAt / 实体指纹变化而失效，只是账本写入不单独触发失效）。
 */
export function buildChunkVersionSource(
  provider: ChunkVersionSourceProvider,
  projectId: string,
  eventSource?: { getLatestStoryEventId(id: string): string | undefined },
): ChunkVersionSource {
  const maxTs = (list: Array<{ updatedAt: number }>): number =>
    list.length > 0 ? Math.max(...list.map((e) => e.updatedAt)) : 0

  const allTables: Array<[string, number]> = [
    ['characters', maxTs(provider.listCharacters(projectId))],
    ['conflicts', maxTs(provider.listConflicts(projectId))],
    ['foreshadows', maxTs(provider.listForeshadowing(projectId))],
    ['clues', maxTs(provider.listClues(projectId))],
    ['factions', maxTs(provider.listFactions(projectId))],
    ['locations', maxTs(provider.listLocations(projectId))],
    ['items', maxTs(provider.listItems(projectId))],
    ['world-elements', maxTs(provider.listWorldElements(projectId))],
    ['relationships', maxTs(provider.listRelationships(projectId))],
  ]
  const entityRevisionIds = allTables.filter((pair) => pair[1] > 0)

  const styleProfile = provider.getWritingStyleProfile(projectId)
  const latestEventId =
    eventSource?.getLatestStoryEventId(projectId)
    ?? provider.getLatestStoryEventId?.(projectId)
    ?? null

  const chapters = provider.listChapters?.(projectId) ?? []
  const chapterVersion = chapters.length > 0 ? Math.max(...chapters.map((c) => c.updatedAt)) : null
  const contextAnchorVersion = provider.getContextAnchorVersion?.(projectId) ?? null

  return {
    projectUpdatedAt: provider.getProject(projectId)?.updatedAt ?? null,
    entityRevisionIds,
    latestMemoryEventId: latestEventId,
    styleProfileVersion: styleProfile?.updatedAt != null ? String(styleProfile.updatedAt) : null,
    chapterVersion,
    contextAnchorVersion,
  }
}


export interface ChunkCacheStats {
  hits: number
  misses: number
  entries: number
  /** 因容量上限被淘汰的条目数（用于判断上限是否过小） */
  evictions: number
}

/**
 * 进程级 Chunk 缓存（内存 Map）。
 * eager key = projectId:chunkId:versionKey:contentHash；
 * lazy key = projectId:chunkId:versionKey:scopeKey。
 * scopeKey 必须覆盖章节、角色、任务、约束、编排和摘要模式；contentHash 始终保留
 * 为内容真实性指纹。
 *
 * 容量上限（maxEntries）是必需的：key 含 versionKey + contentHash，
 * 每次实体修订或章节推进都会产生**新 key 而非覆盖旧 key**，长跑进程下
 * 无上限 Map 会单调增长。超限时按插入顺序淘汰最旧条目（Map 保序，近似 FIFO/LRU）。
 */
export class ChunkCache {
  private readonly map = new Map<string, ContextChunkCacheEntry>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(private readonly maxEntries = 2000) {}

  get(projectId: string, chunkId: string, versionKey: string, contentHash: string): ContextChunkCacheEntry | undefined {
    const entry = this.map.get(`${projectId}:${chunkId}:${versionKey}:${contentHash}`)
    if (entry) this.hits++
    else this.misses++
    return entry
  }

  put(entry: ContextChunkCacheEntry): void {
    const slot = entry.scopeKey ?? entry.contentHash
    this.map.set(`${entry.projectId}:${entry.chunkId}:${entry.versionKey}:${slot}`, entry)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
      this.evictions++
    }
  }

  /** 清空某项目缓存（项目删除/重置时调用） */
  clearProject(projectId: string): void {
    for (const key of this.map.keys()) {
      if (key.startsWith(`${projectId}:`)) this.map.delete(key)
    }
  }

  stats(): ChunkCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.map.size, evictions: this.evictions }
  }
}

/** 构建请求：chunk 列表 + 当前 versionKey 输入 */
export interface ChunkRegistryRequest {
  projectId: string
  versionSource: ChunkVersionSource
  chunks: Array<{ chunkId: string; content: string }>
}

/** 惰性构建请求：构建器列表 + 当前 versionKey 输入（§5.6 先查后建） */
export interface LazyChunkRegistryRequest {
  projectId: string
  versionSource: ChunkVersionSource
  builders: Array<LazyChunkBuilder>
}

/** 单个 chunk 的惰性构建器 */
export interface LazyChunkBuilder {
  chunkId: string
  /**
   * 构建参数指纹：必须包含所有不在 versionKey 中、但会影响该 chunk 内容的输入，
   * 例如 chapterNumber / agentType / narrativeTask / constraints / arrangedEntities /
   * summaryMode / askStoryEnabled。调用方负责确定性生成。
   */
  scope: string
  /** 实际构建函数（仅在缓存未命中时调用）；null 表示本次不产出该可选 chunk。 */
  build: () => string | null
}

export interface RegistryBuildResult {
  /** 使用的 chunk（命中缓存取缓存 content，未命中用新构建 content） */
  chunks: Array<{ chunkId: string; content: string; fromCache: boolean }>
  hits: number
  misses: number
}

/**
 * §5.6 复用循环：build 时逐 chunk 查缓存，命中直接用缓存（省构建 + 省注入），
 * 未命中重建并 put（供下一次请求复用）。
 */
export function buildWithChunkCache(
  cache: ChunkCache,
  request: ChunkRegistryRequest,
  now = Date.now(),
): RegistryBuildResult {
  const versionKey = computeChunkVersionKey(request.versionSource)
  const result: RegistryBuildResult = { chunks: [], hits: 0, misses: 0 }
  for (const chunk of request.chunks) {
    const contentHash = createHash('sha256').update(chunk.content).digest('hex').slice(0, 16)
    const cached = cache.get(request.projectId, chunk.chunkId, versionKey, contentHash)
    if (cached) {
      result.chunks.push({ chunkId: chunk.chunkId, content: cached.content, fromCache: true })
      result.hits++
    } else {
      const entry: ContextChunkCacheEntry = {
        projectId: request.projectId,
        chunkId: chunk.chunkId,
        versionKey,
        content: chunk.content,
        contentHash,
        updatedAt: now,
      }
      cache.put(entry)
      result.chunks.push({ chunkId: chunk.chunkId, content: chunk.content, fromCache: false })
      result.misses++
    }
  }
  return result
}

/**
 * §5.6 先查后建（lazy）复用循环：
 *
 * buildWithChunkCache 的结构性缺陷是"先全量构建 chunks、再查缓存"——命中时
 * 构建早已发生，所谓"省构建"名不副实；且 key 含 contentHash（需先有 content），
 * 逻辑上不可能先查。
 *
 * 本函数改为惰性构建：
 * - key = projectId:chunkId:versionKey:scope（scope 承载 chapter/role/task/constraints/
 *   arranged/summaryMode/askStory 等非 versionKey 构建变体）。
 * - contentHash 始终是实际内容摘要，只做完整性诊断，不再承担惰性查找键职责。
 * - 命中：直接返回缓存 content，**不调用 build()**。
 * - 未命中：调用 build()，把结果连同 contentHash/scopeKey put 进缓存。
 * - build() 返回 null：以空字符串哨兵缓存，避免可选 chunk 在每次请求反复构建；
 *   组装结果不包含该 chunk。
 *
 * 注意：cache.get 内部会把未命中计为 miss；lazy 路径同样沿用，统计语义一致。
 */
export function buildWithChunkCacheLazy(
  cache: ChunkCache,
  request: LazyChunkRegistryRequest,
  now = Date.now(),
): RegistryBuildResult {
  const versionKey = computeChunkVersionKey(request.versionSource)
  const result: RegistryBuildResult = { chunks: [], hits: 0, misses: 0 }
  for (const builder of request.builders) {
    const cached = cache.get(request.projectId, builder.chunkId, versionKey, builder.scope)
    if (cached) {
      if (cached.content !== '') {
        result.chunks.push({ chunkId: builder.chunkId, content: cached.content, fromCache: true })
      }
      result.hits++
      continue
    }
    const built = builder.build()
    const content = built ?? ''
    cache.put({
      projectId: request.projectId,
      chunkId: builder.chunkId,
      versionKey,
      content,
      contentHash: createHash('sha256').update(content).digest('hex').slice(0, 16),
      scopeKey: builder.scope,
      updatedAt: now,
    })
    if (built !== null) {
      result.chunks.push({ chunkId: builder.chunkId, content, fromCache: false })
    }
    result.misses++
  }
  return result
}
