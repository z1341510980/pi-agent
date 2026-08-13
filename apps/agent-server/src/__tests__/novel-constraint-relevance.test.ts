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
      getProject: () => ({ targetWords: 3000, flags: {} }),
      listConstraints: () => [],
      listChapterAppearanceIds: () => [],
      listCharacters: () => [],
      listConflicts: () => [],
      listInformationLayers: () => [],
      listEdgesByEntity: () => [],
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
      getProject: () => ({ targetWords: 3000, flags: {} }),
      listConstraints: () => [],
      listChapterAppearanceIds: () => [],
      listCharacters: () => [],
      listInformationLayers: () => [],
      listEdgesByEntity: () => [],
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

  it('历史章节约束只使用传入的章前状态，不读取活库未来状态', () => {
    const store = {
      getProject: () => ({ targetWords: 3000, flags: {} }),
      listConstraints: () => [],
      listChapterAppearanceIds: ({ entityType }: { entityType: string }) => (
        entityType === 'conflict' ? ['conflict-1'] : ['foreshadow-1']
      ),
      listCharacters: () => [{
        id: 'character-1', name: '沈舟', arcStage: 'resolution',
      }],
      listConflicts: () => [{
        id: 'conflict-1', description: '码头追捕', type: 'external', stage: 'erupting',
        intensity: 9, chapterSpans: [], climaxChapter: null,
      }],
      listForeshadowing: () => [foreshadow({
        id: 'foreshadow-1', description: '未来章已经回收', status: 'recovered',
        beats: [{ chapter: 2, type: 'payoff' }],
      })],
      listInformationLayers: () => [{
        id: 'info-1', isRevealed: true, revealChapter: 2, characterKnowledge: '{}',
      }],
      listEdgesByEntity: () => [],
    }
    const engine = new NovelEngine(store as never)
    const chapterState = {
      characters: [{
        id: 'character-1', name: '沈舟', arcStage: 'resistance',
      }],
      conflicts: [{
        id: 'conflict-1', description: '码头追捕', type: 'external', stage: 'emerging',
        intensity: 4, chapterSpans: [], climaxChapter: null,
      }],
      foreshadowing: [foreshadow({
        id: 'foreshadow-1', description: '章前尚未回收', status: 'planted',
        beats: [{ chapter: 2, type: 'reinforce' }],
      })],
      informationLayers: [],
      edges: [],
    }

    const result = engine.buildChapterConstraints(
      'project-1',
      2,
      undefined,
      null,
      undefined,
      chapterState as never,
    )

    expect(result.characterArcs[0].character.arcStage).toBe('resistance')
    expect(result.conflictTargets[0]).toMatchObject({
      conflict: { stage: 'emerging', intensity: 4 },
      targetStage: 'escalating',
    })
    expect(result.narrativeDebts.map((item) => item.description)).toEqual(['章前尚未回收'])
    expect(result.suspenseHooks).toEqual([
      expect.objectContaining({ description: '章前尚未回收', status: 'sustaining' }),
    ])
    expect(JSON.stringify(result)).not.toContain('未来章已经回收')
  })
})
