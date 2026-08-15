import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

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
  description: '承接前文并推进调查',
  type: 'advance_mainline' as const,
  targetEntity: null,
  priority: 'medium' as const,
}
const CONSTRAINTS = {
  facts: [], cognitive: [], stage: [], narrativeDebts: [],
  characterArcs: [], conflictTargets: [], suspenseHooks: [],
}

function createProject(store: NovelStore): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId,
    title: '测试',
    genre: '测试',
    synopsis: '',
    outline: '',
    targetWords: 3000,
    currentVolume: 1,
    currentChapter: 3,
    currentStage: 'rising',
    status: 'active',
  })
  return projectId
}

function addChapter(store: NovelStore, projectId: string, chapterNumber: number, content: string): void {
  store.createChapter({
    id: randomUUID(), projectId, volume: 1, chapterNumber,
    title: `第${chapterNumber}章`, content, wordCount: content.length,
    status: 'published', narrativeTask: '', outline: '', volumeId: null, acceptanceResult: null,
  })
}

function builder(store: NovelStore): NovelPromptBuilder {
  const manager = { render: () => '', getTemplate: () => '' } as any
  return new NovelPromptBuilder(manager, createStoresMock(store) as any)
}

describe('声音锚点质量门', () => {
  it('严重碎片化章节不会被当作下一章文风样本', () => {
    const store = new NovelStore(createDb())
    const projectId = createProject(store)
    const fragmented = Array.from({ length: 35 }, (_, index) => `停。${index}`).join('\n\n')
    addChapter(store, projectId, 1, fragmented)
    const context = builder(store).buildChapterContextShared(projectId, 2, TASK, CONSTRAINTS)
    expect(context).toContain('上一章结尾')
    expect(context).not.toContain('叙事声音锚点（只参考自然观察和句子呼吸）')
  })

  it('形态合格章节可以作为声音锚点', () => {
    const store = new NovelStore(createDb())
    const projectId = createProject(store)
    const paragraphs = [
      '他把记录压在灯下，纸角翘着。窗外有人推车经过，轮子在石缝里磕了一下。',
      '桌边的水已经凉了。他抿了一口，把浮在碗里的灰吹到另一边。',
      '走廊传来两声咳嗽，随后安静下来。门缝下的光被鞋尖挡住一瞬。',
      '铅笔滚到桌沿，他用小指拦住。纸上那串数字比刚才多了一位。',
      '风把窗纸顶起一个鼓包，又慢慢缩回去。他听见院门的门闩响了一声。',
      '袖口沾着一块黑油，洗不掉。他把袖子卷高，露出腕上的旧伤。',
      '火苗往左偏了偏。门还关着，屋里却多了一股潮湿的土味。',
      '他翻过最后一页，背面有一道压痕。那不是今天留下的。',
    ]
    const clean = Array.from({ length: 24 }, (_, index) => paragraphs[index % paragraphs.length]).join('\n\n')
    addChapter(store, projectId, 1, clean)
    const context = builder(store).buildChapterContextShared(projectId, 2, TASK, CONSTRAINTS)
    expect(context).toContain('叙事声音锚点（只参考自然观察和句子呼吸）')
    expect(context).toContain('不复用具体句式、比喻或开头结构')
    expect(context).toContain('第1章代表片段')
    expect(context).not.toContain('第1章开头：')
  })
})
