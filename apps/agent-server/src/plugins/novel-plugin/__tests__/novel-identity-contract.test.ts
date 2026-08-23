/**
 * T03-6 薄身份契约测试。
 *
 * 守护：5 个 Agent 的构建身份包含其职责协议标记（输出协议/工具权限锚点），
 * 且大小在受控上界内——模板改版丢失职责边界（如 Director 开始写正文）即红。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { novelMigrations } from '../novel-migrations.js'
import { NovelMemoryStore } from '../core/novel-memory-store.js'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { PromptManager } from '../core/prompting/prompt-manager.js'
import { NovelStore } from '../core/novel-store.js'
import { AGENT_IDENTITY_MARKERS, IDENTITY_CHAR_LIMIT, validateAgentIdentity } from '../core/domain/identity-contract.js'

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

describe('T03-6 薄身份契约', () => {
  let db: Database.Database
  let store: NovelStore
  let builder: NovelPromptBuilder

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of novelMigrations) db.exec(migration.sql)
    store = new NovelStore(db)
    store.createProject({
      id: 'p1', title: '身份契约测试', genre: 't', synopsis: '', outline: '', targetWords: 0,
      currentVolume: 1, currentChapter: 1, currentStage: 'setup', status: 'active',
    })
    const memoryStore = new NovelMemoryStore(db)
    // 真实 PromptManager（从 src/prompts 加载 role-*.md / system-base*.md 模板）
    const promptManager = new PromptManager(db, process.cwd())
    builder = new NovelPromptBuilder(promptManager, promptStores(store), memoryStore)
  })

  it('5 个 Agent 身份均包含职责协议标记且大小受控', () => {
    for (const agentType of ['director', 'writer', 'reviewer', 'reviser', 'memory']) {
      const identity = builder.buildAgentIdentity('p1', agentType)
      const report = validateAgentIdentity(agentType, identity)
      expect(report.ok, `${agentType} 身份缺失标记: ${report.missingMarkers.join(', ') || '超长'}`).toBe(true)
      expect(report.totalChars).toBeLessThanOrEqual(IDENTITY_CHAR_LIMIT)
    }
  })

  it('标记表覆盖全部 NovelAgentType（防新增 Agent 漏契约）', () => {
    for (const agentType of Object.keys(AGENT_IDENTITY_MARKERS)) {
      expect(['director', 'writer', 'reviewer', 'reviser', 'memory']).toContain(agentType)
    }
  })

  it('校验函数能发现缺失标记（契约有效性自检）', () => {
    const report = validateAgentIdentity('director', '你是导演，只做规划。')
    expect(report.ok).toBe(false)
    expect(report.missingMarkers).toContain('novel_submit_narrative_task')
  })

  it('buildAgentIdentity 守卫：缺失标记时通过 identityLogger 留痕（不阻塞生成）', () => {
    const warnings: Array<{ msg: string; ctx?: unknown }> = []
    builder.setIdentityLogger({ warn: (msg: string, ctx?: unknown) => warnings.push({ msg, ctx }) })
    // 构造一个会缺失标记的 agentType（director 但模板被替换为空 role）
    // 用真实模板的正常 director 不会触发，这里 mock promptManager 返回空 role
    const originalGetTemplate = (builder as any).promptManager.getTemplate.bind((builder as any).promptManager)
    ;(builder as any).promptManager.getTemplate = (name: string, pid: string) => {
      if (name === 'role-director') return '你是导演。'  // 缺 'novel_submit_narrative_task' 与 '绝不创作章节正文'
      return originalGetTemplate(name, pid)
    }
    const identity = builder.buildAgentIdentity('p1', 'director')
    // 生成不阻塞
    expect(identity).toBeDefined()
    expect(identity.length).toBeGreaterThan(0)
    // 守卫留痕
    expect(warnings.length).toBe(1)
    expect(warnings[0].ctx).toMatchObject({ agentType: 'director' })
    const ctx = warnings[0].ctx as { missingMarkers: string[]; totalChars: number }
    expect(ctx.missingMarkers).toContain('novel_submit_narrative_task')
    // 恢复
    ;(builder as any).promptManager.getTemplate = originalGetTemplate
  })
})
