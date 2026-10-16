/**
 * 上一章结尾锚点：续写语感测试。
 *
 * 背景（用户反馈"生成效果不理想"+ 实测缓存命中仅 28-40%）：
 *   Writer 每次创作都是全新会话，能接触到的自己前文只有 prev-ending 这段
 *   逐字原文。旧预算 400 字只够看到钩子，看不到场景切换的节奏与句子呼吸，
 *   语感每章断层一次。
 *
 * 新行为（本测试守护）：
 * 1. 锚点预算提升到 previousEnding=2400，长章取尾部完整片段；
 * 2. 措辞从"承接钩子"升级为"你在续写一部已有的长篇"（续写心智）；
 * 3. 明确禁止复述/改写/重复这段原文；
 * 4. 短章（低于预算）整章注入，不加省略号前缀。
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'
import { CHAPTER_ANCHOR_BUDGET } from '../core/prompting/prompt-budget.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of novelMigrations) db.exec(migration.sql)
  return db
}

function createStoresMock(store: NovelStore) {
  return {
    getProject: (id: string) => store.getProject(id),
    listWorldRules: (id: string) => store.listWorldRules(id),
    listStyleGuide: (id: string) => store.listStyleGuide(id),
    listCharacters: (id: string) => store.listCharacters(id),
    listRelationships: (id: string) => store.listRelationships(id),
    listConflicts: (id: string) => store.listConflicts(id),
    listForeshadowing: (id: string) => store.listForeshadowing(id),
    listClues: (id: string) => store.listClues(id),
    listInformationLayers: (id: string) => store.listInformationLayers(id),
    listConstraints: (id: string) => store.listConstraints(id),
    listRecentChapters: (id: string, count: number) => store.listRecentChapters(id, count),
    getChapter: (projectId: string, chapter: number) => store.getChapter(projectId, chapter),
    listEdges: (id: string) => store.listEdges(id),
    listEdgesByEntity: (id: string, options?: any) => store.listEdgesByEntity(id, options),
    listFactions: (id: string) => store.listFactions(id),
    listLocations: (id: string) => store.listLocations(id),
    listItems: (id: string) => store.listItems(id),
    listWorldElements: (id: string) => store.listWorldElements(id),
    listUnfulfilledHooksBefore: (id: string, before: number) => store.listUnfulfilledHooksBefore(id, before),
    listHooksByChapter: (id: string, chapter: number) => store.listHooksByChapter(id, chapter),
    getCharacter: (id: string) => store.getCharacter(id),
    getConflict: (id: string) => store.getConflict(id),
    getForeshadow: (id: string) => store.getForeshadow(id),
    getClue: (id: string) => store.getClue(id),
    getFaction: (id: string) => store.getFaction(id),
    getLocation: (id: string) => store.getLocation(id),
    getInformationLayer: (id: string) => store.getInformationLayer(id),
  }
}

const TASK = {
  description: '推进主线',
  type: 'advance_mainline' as const,
  targetEntity: null,
  priority: 'medium' as const,
}
const CONSTRAINTS = {
  facts: [], cognitive: [], stage: [], narrativeDebts: [],
  characterArcs: [], conflictTargets: [], suspenseHooks: [],
}

function setup(projectId: string): { store: NovelStore; builder: NovelPromptBuilder } {
  const store = new NovelStore(createDb())
  store.createProject({
    id: projectId,
    title: '续写锚点测试',
    genre: '测试',
    synopsis: '',
    outline: '',
    targetWords: 3000,
    currentVolume: 1,
    currentChapter: 2,
    currentStage: 'rising',
    status: 'active',
  })
  const manager = { render: () => '', getTemplate: () => '' } as any
  return { store, builder: new NovelPromptBuilder(manager, createStoresMock(store) as any) }
}

function addChapter(store: NovelStore, projectId: string, chapterNumber: number, content: string): void {
  store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber,
    title: `第${chapterNumber}章`, content, wordCount: content.length,
    status: 'published', narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
  })
}

describe('上一章结尾锚点（续写语感）', () => {
  it('长章注入尾部完整片段（不低于一个完整场景体量），并带续写心智措辞', () => {
    const projectId = randomUUID()
    const { store, builder } = setup(projectId)
    // 生成 6000 字正文：远超 2400 预算
    const longContent = Array.from({ length: 60 }, (_, i) =>
      `第${i}段。他把灯芯捻低，影子在墙上晃了一下，又稳住。院里的狗没有叫，说明来的还是熟人。`
    ).join('\n\n')
    addChapter(store, projectId, 1, longContent)

    const context = builder.buildChapterContextShared(projectId, 2, TASK, CONSTRAINTS)

    // 续写心智措辞
    expect(context).toContain('你在续写一部已有的长篇')
    expect(context).toContain('不复述、不改写、不重复')
    // 尾部截断生效：包含最末段，省略前缀存在
    expect(context).toContain('第59段。他把灯芯捻低')
    expect(context).toContain('...')
    // 注入量达到新预算（从标题行到原文尾部覆盖 ≥1200 字正文字符）
    const injected = context.slice(context.indexOf('上一章结尾原文'))
    const proseChars = [...injected].filter((ch) => /[\u4e00-\u9fff]/.test(ch)).length
    expect(proseChars).toBeGreaterThanOrEqual(1200)
    // 预算常量本身被守护
    expect(CHAPTER_ANCHOR_BUDGET.previousEnding).toBe(2400)
  })

  it('短章整章注入，无省略号前缀', () => {
    const projectId = randomUUID()
    const { store, builder } = setup(projectId)
    // 高于 100 字准入门槛、低于 2400 预算：应整章注入
    const shortContent = Array.from({ length: 6 }, (_, i) =>
      `第${i}段。他推门进去，把湿外套挂在钉子上。炉子还有余温，水壶盖被顶得轻轻响，屋里一股潮气。`
    ).join('\n\n')
    addChapter(store, projectId, 1, shortContent)

    const context = builder.buildChapterContextShared(projectId, 2, TASK, CONSTRAINTS)

    expect(context).toContain(shortContent)
    const anchorStart = context.indexOf('上一章结尾原文')
    expect(anchorStart).toBeGreaterThanOrEqual(0)
    const injected = context.slice(anchorStart, anchorStart + 400)
    expect(injected.startsWith('...')).toBe(false)
    expect(context).not.toContain(`...${shortContent}`)
  })
})
