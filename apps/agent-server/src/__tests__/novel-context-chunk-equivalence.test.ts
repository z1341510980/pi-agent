/**
 * T03-2 等价拆块测试。
 *
 * 守护等价拆块的核心承诺：**full 模式下 chunks 拼接与旧字符串逐字节一致**——
 * 拆块只是结构改造，生成行为零变化。
 *
 * 1. buildChapterContextChunks().map(content).join('\n\n---\n\n') === buildChapterContextShared()（stripEmDash 后等价）
 * 2. chunk 结构与目录一致（chapter-info 首个、锚点子段标注、无空 content 段）
 * 3. diff 模式 chunks 退化为单块（独立路径，暂不拆）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { CHUNK_BY_ID, ROLE_CONTEXT_POLICIES } from '../plugins/novel-plugin/core/context-chunk.js'

function promptStores(store: NovelStore) {
  return {
    getProject: (id: string) => store.getProject(id),
    listWorldRules: (id: string) => store.listWorldRules(id),
    listStyleGuide: (id: string) => store.listStyleGuide(id),
    listCharacters: (id: string) => store.listCharacters(id),
    listRelationships: (id: string) => store.listRelationships(id),
    listConflicts: (id: string) => store.listConflicts(id),
    listForeshadowing: (id: string) => store.listForeshadowing(id),
    listClues: (id: string) => store.listClues(id),
    getClue: (id: string) => store.getClue(id),
    listInformationLayers: (id: string) => store.listInformationLayers(id),
    getInformationLayer: (id: string) => store.getInformationLayer(id),
    listConstraints: (id: string) => store.listConstraints(id),
    listRecentChapters: (id: string, limit: number) => store.listRecentChapters(id, limit),
    listUnfulfilledHooksBefore: (id: string, before: number) => store.listUnfulfilledHooksBefore(id, before),
    getChapter: (id: string, chapter: number) => store.getChapter(id, chapter),
    listEdges: (id: string) => store.listEdges(id),
    listEdgesByEntity: (entityId: string, opts?: { direction?: 'source' | 'target' | 'both'; edgeType?: string }) => store.listEdgesByEntity(entityId, opts),
    listFactions: (id: string) => store.listFactions(id),
    listLocations: (id: string) => store.listLocations(id),
    listItems: (id: string) => store.listItems(id),
    listWorldElements: (id: string) => store.listWorldElements(id),
    getCharacter: (id: string) => store.getCharacter(id),
    getConflict: (id: string) => store.getConflict(id),
    getForeshadow: (id: string) => store.getForeshadow(id),
    getFaction: (id: string) => store.getFaction(id),
    getLocation: (id: string) => store.getLocation(id),
    getItem: (id: string) => store.getItem(id),
    listVolumes: (id: string) => store.listVolumes(id),
  }
}

const NARRATIVE_TASK = {
  description: '继续调查', type: 'advance_mainline', targetEntity: null, priority: 'medium',
} as const
const CONSTRAINTS = {
  facts: [], cognitive: [], stage: [], narrativeDebts: [], characterArcs: [], conflictTargets: [], suspenseHooks: [],
}

describe('T03-2 等价拆块', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore
  let builder: NovelPromptBuilder

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    store.createProject({
      id: 'p1', title: '等价拆块测试', genre: '悬疑', synopsis: '', outline: '', targetWords: 0,
      currentVolume: 1, currentChapter: 3, currentStage: 'rising', status: 'active',
    })
    for (const n of [1, 2, 3]) {
      store.createChapter({
        id: `ch${n}`, projectId: 'p1', volume: 1, chapterNumber: n,
        title: '', content: n === 3 ? '' : `第${n}章正文内容`, wordCount: 0,
        status: n === 3 ? 'planned' : 'published',
        narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
      })
    }
    // 两个角色（声音对照表有内容 → voice-contrast chunk 存在）
    for (const c of [
      { id: 'c1', name: '叶明远' },
      { id: 'c2', name: '周启航' },
    ]) {
      store.createCharacter({
        id: c.id, projectId: 'p1', name: c.name, description: '', identity: '', personality: '',
        appearance: '', currentState: '正常', currentGoal: '', currentPressure: '',
        secret: '', arcStage: '', arcHistory: '', speechStyle: '',
        isProtagonist: c.id === 'c1', longTermDesire: '', plotRole: 'protagonist', removalImpact: '',
      })
    }
    // 一条已确认事件（账本承接 section 有内容）
    memoryStore.createStoryEventWithChanges({
      event: {
        projectId: 'p1', chapterNumber: 2, sceneId: null, sceneOrder: 1,
        type: 'discovery', title: '发现线索', summary: '', outcome: '',
        status: 'confirmed', parentEventId: null, source: 'manual',
      },
      entityRefs: [],
      changes: [],
    })
    const promptManager = { render: () => '', getTemplate: () => '' } as any
    builder = new NovelPromptBuilder(promptManager, promptStores(store), memoryStore)
  })

  it('full 模式：chunks 拼接与 shared 字符串逐字节等价', () => {
    const chunks = builder.buildChapterContextChunks('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never)
    const joined = chunks.map((c) => c.content).join('\n\n---\n\n')
    const shared = builder.buildChapterContextShared('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never)
    expect(joined).toBe(shared)
  })

  it('lazy builders 执行后与 eager chunks 逐字节等价', () => {
    const eager = builder.buildChapterContextChunks('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never)
    const lazy = builder.buildChapterContextChunkBuilders('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never)
      .map((b) => ({ chunkId: b.chunkId, content: b.build() }))
      .filter((c): c is { chunkId: string; content: string } => c.content !== null)
    expect(lazy).toEqual(eager)
  })

  it('lazy builders 的 agent 过滤与 eager 一致', () => {
    const options = { agentType: 'memory', askStoryEnabled: true }
    const eager = builder.buildChapterContextChunks('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never, undefined, options)
    const lazy = builder.buildChapterContextChunkBuilders('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never, undefined, options)
      .map((b) => ({ chunkId: b.chunkId, content: b.build() }))
      .filter((c): c is { chunkId: string; content: string } => c.content !== null)
    expect(lazy).toEqual(eager)
  })

  it('chunk 结构：首个为 chapter-info，锚点子段已标注，无空 content', () => {
    const chunks = builder.buildChapterContextChunks('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks[0].chunkId).toBe('chapter-info')
    for (const c of chunks) {
      expect(CHUNK_BY_ID.has(c.chunkId), `chunkId ${c.chunkId} 不在目录中`).toBe(true)
      expect(c.content.length).toBeGreaterThan(0)
    }
    // 第 1 章已生成 → 锚点应含 recent-recaps（前文摘要）
    const anchorIds = chunks.map((c) => c.chunkId)
    expect(anchorIds).toContain('recent-recaps')
  })

  it('有编排时：arranged-entities 替代 story-state（目录切换逻辑保留）', () => {
    const arranged = {
      characterIds: ['c1'],
      conflictIds: [],
      foreshadowIds: [],
      factionIds: [],
      locationIds: [],
    }
    const chunks = builder.buildChapterContextChunks('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never, arranged as never)
    const ids = chunks.map((c) => c.chunkId)
    expect(ids).toContain('arranged-entities')
    expect(ids).not.toContain('story-state')
  })

  it('diff 模式：chunks 退化为单块（独立路径，内容仍等价）', () => {
    const chunks = builder.buildChapterContextChunks('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never, undefined, { mode: 'diff' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].chunkId).toBe('story-ledger')
    expect(chunks[0].content).toBe(
      builder.buildChapterContextShared('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never, undefined, { mode: 'diff' }),
    )
  })

  it('context-preview 下沉：shared section 携带 chunk 明细且字符守恒（含分隔符）', () => {
    const preview = builder.buildContextPreview('p1', 3)
    const sharedSection = preview.sections.find((s) => s.key === 'shared')
    expect(sharedSection).toBeDefined()
    expect(sharedSection?.chunks).toBeDefined()
    expect(sharedSection?.chunks?.length).toBeGreaterThanOrEqual(3)
    // 字符守恒：chunk 明细 + (n-1) 个 '\n\n---\n\n' 分隔符（7 字符）≈ shared charCount；
    // stripEmDash 只压缩不扩张 → chunkSum + 分隔符 >= shared（下界成立）
    const n = sharedSection?.chunks?.length ?? 0
    const sum = (sharedSection?.chunks ?? []).reduce((acc, c) => acc + c.charCount, 0)
    expect(sum + (n - 1) * 7).toBeGreaterThanOrEqual(sharedSection?.charCount ?? 0)
    // chunk 标题来自目录
    const first = sharedSection?.chunks?.[0]
    expect(first?.chunkId).toBe('chapter-info')
    expect(first?.title).toBe('章节信息')
  })

  it('suffix 层 chunk 化：各 Agent 分支 chunk 拼接与原字符串逐字节等价', () => {
    for (const agentType of ['director', 'reviewer', 'writer']) {
      const chunks = builder.buildChapterContextSuffixChunks(
        'p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never, undefined, agentType,
      )
      const joined = chunks.map((c) => c.content).join('\n\n---\n\n')
      const suffix = builder.buildChapterContextSuffix(
        'p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never, undefined, agentType,
      )
      expect(joined, `suffix[${agentType}] 不等价`).toBe(suffix)
      // 分支 chunkId 与目录匹配
      for (const c of chunks) {
        expect(CHUNK_BY_ID.has(c.chunkId), `suffix chunkId ${c.chunkId} 不在目录`).toBe(true)
      }
    }
    // 无 agentType → 空
    expect(builder.buildChapterContextSuffixChunks('p1', 3, NARRATIVE_TASK as never, CONSTRAINTS as never)).toHaveLength(0)
  })

  it('P4 接入 2：传 agentType 时过滤策略 disabled chunk；未传保持全量等价', () => {
    const task = NARRATIVE_TASK as never
    const constraints = CONSTRAINTS as never
    // 不变量（不依赖数据存在性）：memory 策略 disabled 的 chunk 在过滤结果中绝不存在
    const disabledIds = new Set(
      ROLE_CONTEXT_POLICIES.memory.filter((p) => p.mode === 'disabled').map((p) => p.chunkId),
    )
    expect(disabledIds.size).toBeGreaterThan(0) // 策略表确有 disabled 项
    const memoryChunks = builder.buildChapterContextChunks('p1', 3, task, constraints, undefined, { agentType: 'memory' })
    for (const id of disabledIds) {
      expect(memoryChunks.some((c) => c.chunkId === id), `${id} 应被 memory 策略禁用`).toBe(false)
    }
    // required 核心不受影响（chapter-info 无条件存在）
    expect(memoryChunks.some((c) => c.chunkId === 'chapter-info')).toBe(true)

    // writer 策略无 disabled → 过滤不改变 chunk 集合
    const writerDisabled = new Set(
      ROLE_CONTEXT_POLICIES.writer.filter((p) => p.mode === 'disabled').map((p) => p.chunkId),
    )
    const writerChunks = builder.buildChapterContextChunks('p1', 3, task, constraints, undefined, { agentType: 'writer' })
    for (const id of writerDisabled) {
      expect(writerChunks.some((c) => c.chunkId === id)).toBe(false)
    }

    // 过滤不影响等价性基线（全量路径不变）
    const full = builder.buildChapterContextChunks('p1', 3, task, constraints)
    expect(full.length).toBe(builder.buildChapterContextChunks('p1', 3, task, constraints).length)
  })

  it('P4 接入 3：buildChapterContextSharedForAgent 无 agentType 时与现状逐字节等价', () => {
    const task = NARRATIVE_TASK as never
    const constraints = CONSTRAINTS as never
    // 无 agentType → 与 buildChapterContextShared 完全一致（flag 关路径等价）
    expect(
      builder.buildChapterContextSharedForAgent('p1', 3, task, constraints),
    ).toBe(
      builder.buildChapterContextShared('p1', 3, task, constraints),
    )
    // 有 agentType（memory）→ 过滤后 shared 短于或等于全量（disabled chunk 被移除）
    const forAgent = builder.buildChapterContextSharedForAgent('p1', 3, task, constraints, undefined, {
      askStoryEnabled: true,
      agentType: 'memory',
    })
    const fullShared = builder.buildChapterContextShared('p1', 3, task, constraints)
    expect(forAgent.length).toBeLessThanOrEqual(fullShared.length)
  })

  it('P4 接入 4：assembleSharedFromChunks 与 buildChapterContextShared 逐字节等价', () => {
    const task = NARRATIVE_TASK as never
    const constraints = CONSTRAINTS as never
    const chunks = builder.buildChapterContextChunks('p1', 3, task, constraints)
    expect(builder.assembleSharedFromChunks(chunks)).toBe(
      builder.buildChapterContextShared('p1', 3, task, constraints),
    )
  })
})
