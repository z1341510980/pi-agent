import { describe, expect, it } from 'vitest'
import { NovelEngine } from '../plugins/novel-plugin/core/novel-engine.js'

function foreshadow(overrides: Record<string, unknown>) {
  return {
    id: 'f-default',
    projectId: 'project-1',
    description: '默认伏笔',
    category: 'item',
    status: 'planted',
    firstChapter: 1,
    lastChapter: 1,
    recoverByChapter: null,
    linkedCharacters: '[]',
    linkedClues: '[]',
    linkedInfoLayers: '[]',
    chapterSpans: [],
    beats: [{ chapter: 1, type: 'plant' }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('NovelEngine chapter constraint relevance', () => {
  it('只把本章有 beat 或已到回收期的伏笔注入硬约束', () => {
    const store = {
      listConstraints: () => [],
      listCharacters: () => [],
      listConflicts: () => [],
      listInformationLayers: () => [],
      listForeshadowing: () => [
        foreshadow({ id: 'old', description: '多年后才处理', firstChapter: 1 }),
        foreshadow({
          id: 'current',
          description: '本章强化',
          beats: [
            { chapter: 2, type: 'plant' },
            { chapter: 10, type: 'reinforce', note: '再次露出' },
          ],
        }),
        foreshadow({
          id: 'due',
          description: '本章到期',
          firstChapter: 3,
          recoverByChapter: 10,
          beats: [
            { chapter: 3, type: 'plant' },
            { chapter: 10, type: 'payoff' },
          ],
        }),
        foreshadow({
          id: 'planned',
          description: '尚未排期',
          status: 'planned',
          firstChapter: null,
          beats: [],
        }),
      ],
    }
    const engine = new NovelEngine(store as never)

    const result = engine.buildChapterConstraints('project-1', 10)

    expect(result.narrativeDebts.map((item) => item.id)).toEqual(['due', 'current'])
    expect(result.suspenseHooks.map((item) => item.description)).toEqual([
      '本章到期',
      '本章强化',
    ])
    expect(result.suspenseHooks.map((item) => item.status)).toEqual([
      'releasing',
      'sustaining',
    ])
  })

  it('传入矩阵时只构建选中冲突和伏笔的硬约束', () => {
    const store = {
      listConstraints: () => [],
      listCharacters: () => [],
      listInformationLayers: () => [],
      listForeshadowing: () => [
        foreshadow({ id: 'selected-foreshadow', description: '选中伏笔', beats: [{ chapter: 10, type: 'reinforce' }] }),
        foreshadow({ id: 'ignored-foreshadow', description: '未选伏笔', beats: [{ chapter: 10, type: 'payoff' }] }),
      ],
      listConflicts: () => [
        { id: 'selected-conflict', stage: 'rising', chapterSpans: [], climaxChapter: null, intensity: 5 },
        { id: 'ignored-conflict', stage: 'rising', chapterSpans: [], climaxChapter: null, intensity: 9 },
      ],
    }
    const engine = new NovelEngine(store as never)

    const result = engine.buildChapterConstraints(
      'project-1', 10, undefined, null,
      { characterIds: [], conflictIds: ['selected-conflict'], foreshadowIds: ['selected-foreshadow'], clueIds: [], factionIds: [], locationIds: [] },
    )

    expect(result.narrativeDebts.map((item) => item.id)).toEqual(['selected-foreshadow'])
    expect(result.conflictTargets.map((item) => item.conflict.id)).toEqual(['selected-conflict'])
    expect(result.suspenseHooks.map((item) => item.description)).toEqual(['选中伏笔'])
  })
})
