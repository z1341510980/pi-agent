import { describe, expect, it } from 'vitest'
import { buildCharacterVisibleContext } from '../plugins/novel-plugin/core/novel-character-discussion-context.js'

function makeStore(lastSceneCharacterIds: string[] | null) {
  return {
    getChapter: (_projectId: string, chapterNumber: number) => chapterNumber === 1
      ? { id: 'chapter-1', content: '门后的人说出了只有凶手知道的名字。' }
      : { id: 'chapter-2', outline: '调查新的线索', positioning: null },
    getCurrentPlan: () => lastSceneCharacterIds === null ? undefined : { id: 'plan-1' },
    listSceneRevisionsByPlan: () => [{ id: 'scene-1', order: 1 }],
    getSceneRevisionCast: () => ({
      focus: lastSceneCharacterIds ?? [], present: [], functions: [],
    }),
    listInformationLayers: () => [],
  } as any
}

const character = { id: 'character-a', name: '林晚' } as any

describe('buildCharacterVisibleContext previous chapter visibility', () => {
  it('includes the previous ending only when Scene Cast confirms the character was present', () => {
    const context = buildCharacterVisibleContext({
      store: makeStore(['character-a']), projectId: 'project-1', chapterNumber: 2, character,
    })

    expect(context).toContain('上一章结尾（你的亲历场景）')
    expect(context).toContain('只有凶手知道的名字')
  })

  it('does not leak the previous ending to an absent or unmodelled character', () => {
    for (const cast of [['another-character'], null] as const) {
      const context = buildCharacterVisibleContext({
        store: makeStore(cast ? [...cast] : null), projectId: 'project-1', chapterNumber: 2, character,
      })

      expect(context).not.toContain('只有凶手知道的名字')
      expect(context).toContain('不得根据上一章结尾原文行动')
    }
  })

  it('does not expose the previous ending to an ephemeral character without an identity record', () => {
    const context = buildCharacterVisibleContext({
      store: makeStore(['character-a']), projectId: 'project-1', chapterNumber: 2,
    })

    expect(context).not.toContain('只有凶手知道的名字')
  })
})
