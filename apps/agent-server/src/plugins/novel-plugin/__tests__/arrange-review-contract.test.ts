import { describe, expect, it, vi } from 'vitest'
import { buildArrangeReviewDetails } from '../routes/arrange-review-contract.js'

describe('buildArrangeReviewDetails', () => {
  it('把编排实体 ID 映射成审核可读摘要，并保留本章功能约束', () => {
    const store = {
      getCharacter: vi.fn(() => ({
        id: 'c1',
        name: '沈砚',
        description: '被迫交出密钥的主角',
        currentState: '受伤',
        currentGoal: '进入城门'
      })),
      getConflict: vi.fn(() => ({
        id: 'x1',
        description: '守卫要求验明身份',
        type: 'interest',
        intensity: 7,
        stage: 'escalating',
        tier: 'main',
        stakes: '暴露身份',
        plotFunction: 'amplify_conflict',
        progressionMode: 'linear',
        climaxChapter: 8,
        climaxType: 'action'
      })),
      getForeshadow: vi.fn(() => ({
        id: 'f1',
        description: '旧钥匙刻着陌生家徽',
        category: 'item',
        status: 'planted',
        recoverByChapter: 12,
        plantMethod: 'implicit',
        recoverMethod: 'reverse',
        beats: [{ chapter: 3, type: 'reinforce', note: '让家徽再次出现' }]
      })),
      getClue: vi.fn(() => undefined),
      getFaction: vi.fn(() => undefined),
      getLocation: vi.fn(() => undefined),
      getItem: vi.fn(() => undefined),
      getNarrative: vi.fn(() => undefined)
    } as any

    const result = buildArrangeReviewDetails(
      store,
      {
        characterIds: ['c1'],
        conflictIds: ['x1'],
        foreshadowIds: ['f1'],
        clueIds: [],
        factionIds: [],
        locationIds: [],
        itemIds: [],
        narrativeIds: [],
        characterFunctions: [
          {
            characterId: 'c1',
            function: 'create_obstacle',
            note: '本章必须做出错误选择'
          }
        ]
      },
      3
    )

    expect(result.characters[0]).toMatchObject({
      id: 'c1',
      name: '沈砚',
      plotFunction: 'create_obstacle',
      functionNote: '本章必须做出错误选择',
      currentState: '受伤'
    })
    expect(result.conflicts[0]).toMatchObject({
      description: '守卫要求验明身份',
      intensity: 7,
      stakes: '暴露身份',
      climaxChapter: 8
    })
    expect(result.foreshadows[0]).toMatchObject({
      description: '旧钥匙刻着陌生家徽',
      chapterAction: 'reinforce',
      beatNote: '让家徽再次出现'
    })
  })

  it('精简 Store 缺少实体读取方法时安全返回空摘要', () => {
    const result = buildArrangeReviewDetails(
      {} as any,
      {
        characterIds: ['c1'],
        conflictIds: [],
        foreshadowIds: [],
        factionIds: [],
        locationIds: [],
        itemIds: []
      },
      1
    )

    expect(result.characters).toEqual([])
    expect(result.conflicts).toEqual([])
  })
})
