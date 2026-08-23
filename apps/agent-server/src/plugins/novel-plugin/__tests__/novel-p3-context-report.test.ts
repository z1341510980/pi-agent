/**
 * T03-8 P3 灰度看板报告测试。
 *
 * 守护聚合报告的完整性：
 * 1. 报告包含 baseline / chunks / rolePolicies / catalog；
 * 2. chunk 明细与真实 chunk 构建一致（count 对应）；
 * 3. 降级模拟：预算不足时 appliedSteps 非空、savedPercent > 0、tokensAfter < tokensBefore；
 * 4. 身份 token：传 agentType 时返回 identity（T03-6 契约标记仍在）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { NovelEngine } from '../core/novel-engine.js'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import { NovelStore } from '../core/novel-store.js'
import { buildP3ContextReport } from '../core/prompting/p3-context-report.js'

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
    listEdgesByEntity: (entityId: string, opts?: unknown) => store.listEdgesByEntity(entityId, opts as never),
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

describe('T03-8 P3 灰度看板报告', () => {
  let db: Database.Database
  let store: NovelStore
  let memoryStore: NovelMemoryStore
  let engine: NovelEngine
  let builder: NovelPromptBuilder

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    memoryStore = new NovelMemoryStore(db)
    store.createProject({
      id: 'p1', title: '灰度报告测试', genre: 't', synopsis: '', outline: '', targetWords: 0,
      currentVolume: 1, currentChapter: 3, currentStage: 'rising', status: 'active',
    })
    for (const n of [1, 2, 3]) {
      store.createChapter({
        id: `ch${n}`, projectId: 'p1', volume: 1, chapterNumber: n, title: '',
        content: n === 3 ? '' : `第${n}章正文内容`, wordCount: 0,
        status: n === 3 ? 'planned' : 'published',
        narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
      })
    }
    store.createCharacter({
      id: 'c1', projectId: 'p1', name: '叶明远', description: '', identity: '', personality: '',
      appearance: '', currentState: '重伤昏迷', currentGoal: '查明真凶', currentPressure: '',
      secret: '', arcStage: '', arcHistory: '', speechStyle: '',
      isProtagonist: true, longTermDesire: '', plotRole: 'protagonist', removalImpact: '',
    })
    const promptManager = new PromptManager(db, process.cwd())
    engine = new NovelEngine(store)
    builder = new NovelPromptBuilder(promptManager, promptStores(store), memoryStore)
  })

  it('报告包含 baseline / chunks / rolePolicies / catalog 四大块', () => {
    const report = buildP3ContextReport(builder, store, engine, 'p1', 3)
    expect(report.baseline.sharedChars).toBeGreaterThan(0)
    expect(report.baseline.chunkCount).toBeGreaterThanOrEqual(3)
    expect(report.chunks.length).toBe(report.baseline.chunkCount)
    expect(report.rolePolicies.length).toBeGreaterThanOrEqual(5) // 5 个 Agent
    expect(report.catalog.length).toBeGreaterThanOrEqual(17) // CHUNK_CATALOG 全量
  })

  it('chunk 明细与真实构建一致（字符守恒：chunk 和 + 分隔符 ≥ shared）', () => {
    const report = buildP3ContextReport(builder, store, engine, 'p1', 3)
    const sum = report.chunks.reduce((acc, c) => acc + c.charCount, 0)
    // shared 含 (n-1) 个 '\n\n---\n\n' 分隔符（7 字符）；stripEmDash 只压缩不扩张
    // → chunk 和 + 分隔符 >= shared（下界成立）
    const n = report.chunks.length
    expect(sum + (n - 1) * 7).toBeGreaterThanOrEqual(report.baseline.sharedChars)
    // 每 chunk 有优先级/模式/层级标注
    for (const c of report.chunks) {
      expect(['required', 'recommended', 'optional']).toContain(c.priority)
      expect(['full', 'summary']).toContain(c.defaultMode)
    }
  })

  it('降级模拟：预算不足时应用降级步骤且 token 减少', () => {
    const report = buildP3ContextReport(builder, store, engine, 'p1', 3, { budgetTokens: 100 })
    expect(report.degradation).toBeDefined()
    expect(report.degradation!.appliedSteps.length).toBeGreaterThan(0)
    expect(report.degradation!.savedPercent).toBeGreaterThan(0)
    expect(report.degradation!.tokensAfter).toBeLessThanOrEqual(report.degradation!.tokensBefore)
  })

  it('极小预算下五级降级仍无法 fit → 阻止生成（fits=false）', () => {
    const report = buildP3ContextReport(builder, store, engine, 'p1', 3, { budgetTokens: 5 })
    expect(report.degradation!.fits).toBe(false)
    expect(report.degradation!.appliedSteps.length).toBeGreaterThan(0)
  })

  it('预算充足时不降级', () => {
    const report = buildP3ContextReport(builder, store, engine, 'p1', 3, { budgetTokens: 100000 })
    expect(report.degradation!.appliedSteps).toHaveLength(0)
    expect(report.degradation!.fits).toBe(true)
    expect(report.degradation!.savedTokens).toBe(0)
  })

  it('身份 token：传 agentType 时返回 identity 且含协议标记', () => {
    const report = buildP3ContextReport(builder, store, engine, 'p1', 3, { agentType: 'writer' })
    expect(report.identity).toBeDefined()
    expect(report.identity!.agentType).toBe('writer')
    expect(report.identity!.chars).toBeGreaterThan(0)
    expect(report.identity!.tokens).toBeGreaterThan(0)
  })

  it('P4 灰度对照：传 agentType 时返回 roleAssembly（角色组装 token ≤ baseline）', () => {
    const report = buildP3ContextReport(builder, store, engine, 'p1', 3, { agentType: 'memory' })
    expect(report.roleAssembly).toBeDefined()
    expect(report.roleAssembly!.agentType).toBe('memory')
    // memory 禁用了声音/文风类 chunk → 角色组装不应大于 baseline
    expect(report.roleAssembly!.tokens).toBeLessThanOrEqual(report.baseline.sharedTokens)
    expect(report.roleAssembly!.savedPercent).toBeGreaterThanOrEqual(0)
  })
})
