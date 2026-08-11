import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelEngine } from '../core/novel-engine.js'
import { NovelStore } from '../core/novel-store.js'
import { NovelPromptBuilder } from '../core/prompt-builder.js'
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
const CONSTRAINTS_EMPTY = {
  facts: [], cognitive: [], stage: [], narrativeDebts: [],
  characterArcs: [], conflictTargets: [], suspenseHooks: [],
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

describe('字数预算不叠加节奏和定位倍率', () => {
  it('定位为 high_pressure 且节奏为 climax 时，目标字数不叠加两个 1.3', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      'high_pressure' as ChapterPositioning,
    )

    // 旧 bug：3000 * 1.3(节奏) * 1.3(定位) = 5070
    // 修复后：只应用定位倍率 = 3000 * 1.3 = 3900
    expect(constraints.wordBudget).not.toBeNull()
    expect(constraints.wordBudget!.target).toBe(3900)
    expect(constraints.wordBudget!.target).not.toBe(5070)
  })

  it('无定位时，节奏倍率仍通过 computeChapterTargetWords 生效', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      null,
    )

    // 无定位 → wordBudget 为 null → Writer 使用 computeChapterTargetWords 回退
    expect(constraints.wordBudget).toBeNull()

    const builder = new NovelPromptBuilder(
      { render: () => '', getTemplate: () => '' } as any,
      createStoresMock(store) as any,
    )
    const fallback = builder.computeChapterTargetWords(
      store.getProject(projectId),
      constraints.rhythmConstraint?.rhythm,
    )
    // 节奏 climax → 3000 * 1.3 = 3900，不再叠加定位
    expect(fallback).toBe(3900)
  })

  it('定位为 low_pressure 且节奏为 climax 时，不因节奏抬高字数', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      'low_pressure' as ChapterPositioning,
    )

    // 修复后：只应用 low_pressure 倍率 = 3000 * 0.85 = 2550
    // 旧 bug 会先应用 climax 1.3 再应用 low_pressure 0.85 = 3000 * 1.3 * 0.85 = 3315
    expect(constraints.wordBudget!.target).toBe(2550)
  })

  it('Writer suffix 注入的目标字数与 wordBudget.target 一致', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      'high_pressure' as ChapterPositioning,
    )

    // 用真实模板渲染：render 返回包含 {{target_words}} 的模板内容
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

    // suffix 中应该包含 3900，不应该包含 5070
    expect(suffix).toContain('3900')
    expect(suffix).not.toContain('5070')
  })

  it('V2 flag 开启：3000 + climax + high_pressure → 3000（不叠加、定位默认不调整、节奏不参与）', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)
    store.updateProject(projectId, { flags: { scenePlanV2Write: true } })

    const constraints = engine.buildChapterConstraints(
      projectId,
      1,
      CLIMAX_RHYTHM,
      'high_pressure' as ChapterPositioning,
    )

    // V2 语义：targetWords 硬目标，定位默认 0%，Rhythm 永不调整 → 3000
    expect(constraints.wordBudget).not.toBeNull()
    expect(constraints.wordBudget!.target).toBe(3000)
    expect(constraints.wordBudget!.min).toBe(2550)
    expect(constraints.wordBudget!.max).toBe(3450)
  })

  it('V2 flag 开启：无定位时回退也走 resolver，节奏不再抬字数', () => {
    const store = new NovelStore(createDb())
    const engine = new NovelEngine(store)
    const projectId = setupProject(store, 3000)
    store.updateProject(projectId, { flags: { scenePlanV2Write: true } })

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
    // V1 回退会注入 3900（climax ×1.3）；V2 必须注入 3000
    expect(suffix).toContain('3000')
    expect(suffix).not.toContain('3900')
  })
})
