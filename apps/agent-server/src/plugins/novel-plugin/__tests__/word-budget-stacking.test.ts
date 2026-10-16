import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelEngine } from '../core/novel-engine.js'
import { NovelStore } from '../core/novel-store.js'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'
import { novelMigrations } from '../novel-migrations.js'
import type { RhythmSuggestion, ChapterPositioning } from '../core/types.js'

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
    listRecentChapters: (id: string, n: number) => store.listRecentChapters(id, n),
    getChapter: (pid: string, n: number) => store.getChapter(pid, n),
    listEdges: (id: string) => store.listEdges(id),
    listEdgesByEntity: (id: string, opts?: any) => store.listEdgesByEntity(id, opts),
    listFactions: (id: string) => store.listFactions(id),
    listLocations: (id: string) => store.listLocations(id),
    listItems: (id: string) => store.listItems(id),
    listWorldElements: (id: string) => store.listWorldElements(id),
    listUnfulfilledHooksBefore: (id: string, n: number) => store.listUnfulfilledHooksBefore(id, n),
    listHooksByChapter: (id: string, n: number) => store.listHooksByChapter(id, n),
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
  description: '测试任务',
  type: 'advance_mainline' as const,
  targetEntity: null,
  priority: 'medium' as const,
}

function setupProject(store: NovelStore, targetWords: number): string {
  const projectId = randomUUID()
  store.createProject({
    id: projectId, title: 'test', genre: 'test', synopsis: '', outline: '',
    targetWords, currentVolume: 1, currentChapter: 1,
    currentStage: 'rising', status: 'active',
  })
  return projectId
}

const CLIMAX_RHYTHM: RhythmSuggestion = {
  rhythm: 'climax',
  arcPosition: 0.5,
  reason: 'test',
  description: 'test',
  climaxIntensity: 'major',
  climaxType: 'composite',
}

describe('字数预算单链（WordBudgetResolver 唯一解析，2026-08-12 逻辑统一）', () => {
  it('定位 high_pressure + 节奏 climax：3000（定位默认 0%、节奏不参与，绝不叠加）', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      'high_pressure' as ChapterPositioning,
    )

    // 旧 bug：3000 * 1.3 * 1.3 = 5070；V1 修复：3900；V2 单链：3000
    expect(constraints.wordBudget).not.toBeNull()
    expect(constraints.wordBudget!.target).toBe(3000)
    expect(constraints.wordBudget!.min).toBe(2550)
    expect(constraints.wordBudget!.max).toBe(3450)
    expect(constraints.wordBudget!.target).not.toBe(5070)
    expect(constraints.wordBudget!.target).not.toBe(3900)
  })

  it('无定位时 wordBudget 为 null，Writer 回退也走 resolver（3000）', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      null,
    )
    expect(constraints.wordBudget).toBeNull()

    const promptManager = {
      render: (_name: string, variables: Record<string, string>) => {
        return `目标字数：${variables.target_words} 字。`
      },
      getTemplate: () => '',
    } as any
    const builder = new NovelPromptBuilder(promptManager, createStoresMock(store) as any)
    const suffix = builder.buildChapterContextSuffix(
      projectId, 1, TASK, constraints, undefined, 'writer',
    )
    // 无定位：回退走 resolver → 3000（节奏 climax 不再 ×1.3 → 3900）
    expect(suffix).toContain('3000')
    expect(suffix).not.toContain('3900')
  })

  it('定位 low_pressure：3000（定位默认 0%，不因定位压低）', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      'low_pressure' as ChapterPositioning,
    )

    // V1：3000 * 0.85 = 2550；V2 单链：定位默认 0% → 3000
    expect(constraints.wordBudget!.target).toBe(3000)
  })

  it('Writer suffix 注入的目标字数与 wordBudget.target 一致（3000）', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      'high_pressure' as ChapterPositioning,
    )

    const promptManager = {
      render: (_name: string, variables: Record<string, string>) => {
        return `目标字数：${variables.target_words} 字。`
      },
      getTemplate: () => '',
    } as any

    const builder = new NovelPromptBuilder(
      promptManager,
      createStoresMock(store) as any,
    )

    const suffix = builder.buildChapterContextSuffix(
      projectId, 1, TASK, constraints, undefined, 'writer',
    )

    // suffix 应包含 3000，不应包含 5070 / 3900
    expect(suffix).toContain('3000')
    expect(suffix).not.toContain('5070')
    expect(suffix).not.toContain('3900')
  })
})
