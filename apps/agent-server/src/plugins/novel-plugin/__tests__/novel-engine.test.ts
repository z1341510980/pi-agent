import { describe, expect, it } from 'vitest'
import { NovelEngine } from '../core/novel-engine.js'

function createStore(targetWords: number) {
  return {
    listConstraints: () => [],
    listForeshadowing: () => [],
    listCharacters: () => [],
    getProject: () => ({ targetWords }),
  } as any
}

describe('NovelEngine chapter word budget', () => {
  it('does not compound climax and high-pressure multipliers', () => {
    const engine = new NovelEngine(createStore(3000))

    const constraints = engine.buildChapterConstraints(
      'project-1',
      undefined,
      { rhythm: 'climax' } as any,
      'high_pressure',
    )

    expect(constraints.wordBudget).toEqual({
      min: 3315,
      max: 4485,
      target: 3900,
    })
  })

  it('uses rhythm as the fallback when positioning is not specified', () => {
    const engine = new NovelEngine(createStore(3000))

    const constraints = engine.buildChapterConstraints(
      'project-1',
      undefined,
      { rhythm: 'climax' } as any,
    )

    expect(constraints.wordBudget).toBeNull()
  })
})
