import { describe, it, expect } from 'vitest'
import {
  validateChapterScenePlan,
  type ChapterScenePlan,
  type ChapterScenePlanScene,
} from '../core/chapters/chapter-scene-plan.js'

function basePlan(scenes: ChapterScenePlanScene[]): ChapterScenePlan {
  return {
    planRevisionId: 'plan-1',
    chapterId: 'ch-1',
    baseContentRevisionId: null,
    positioning: 'advancement',
    rhythm: 'rising',
    budget: { baseTarget: 3000, adjustmentPct: 0, resolvedTarget: 3000, min: 2550, max: 3450 },
    scenes,
  }
}

function scene(overrides: Partial<ChapterScenePlanScene> = {}): ChapterScenePlanScene {
  return {
    sceneKey: 's1',
    order: 1,
    title: '场景一',
    goal: '推进目标',
    locationText: '测试地点',
    timeText: '当日',
    povMode: 'single',
    povCharacterId: 'c1',
    focusCharacterIds: ['c1'],
    presentCharacterIds: ['c1', 'c2'],
    functionalCast: [{ characterId: 'c3', function: '传递情报', prominence: 'brief' }],
    targetWords: 3000,
    progresses: [{ storylineId: 'sl1', primary: true, type: 'advance', expectedChange: '局势变化' }],
    ...overrides,
  }
}

describe('validateChapterScenePlan 场景计划校验', () => {
  it('合法样例返回空数组', () => {
    expect(validateChapterScenePlan(basePlan([scene()]))).toEqual([])
  })

  it('sceneKey 重复 → duplicate_scene_key', () => {
    const plan = basePlan([scene(), scene({ sceneKey: 's1', order: 2 })])
    const codes = validateChapterScenePlan(plan).map((i) => i.code)
    expect(codes).toContain('duplicate_scene_key')
  })

  it('order 重复 → duplicate_scene_order', () => {
    const plan = basePlan([scene(), scene({ sceneKey: 's2', order: 1 })])
    const codes = validateChapterScenePlan(plan).map((i) => i.code)
    expect(codes).toContain('duplicate_scene_order')
  })

  it('场景字数之和与 resolvedTarget 差 > 1 → scene_budget_mismatch', () => {
    const plan = basePlan([scene({ targetWords: 2000 })])
    const codes = validateChapterScenePlan(plan).map((i) => i.code)
    expect(codes).toContain('scene_budget_mismatch')
  })

  it('场景字数之和 ±1 容差内不报错', () => {
    expect(validateChapterScenePlan(basePlan([scene({ targetWords: 2999 })])).map((i) => i.code))
      .not.toContain('scene_budget_mismatch')
    expect(validateChapterScenePlan(basePlan([scene({ targetWords: 3001 })])).map((i) => i.code))
      .not.toContain('scene_budget_mismatch')
  })

  it('focus 超过 5 个 → too_many_focus', () => {
    const plan = basePlan([
      scene({ focusCharacterIds: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ])
    const codes = validateChapterScenePlan(plan).map((i) => i.code)
    expect(codes).toContain('too_many_focus')
  })

  it('functional cast 缺 function → functional_cast_missing_function', () => {
    const plan = basePlan([
      scene({ functionalCast: [{ characterId: 'c9', function: '', prominence: 'brief' }] }),
    ])
    const codes = validateChapterScenePlan(plan).map((i) => i.code)
    expect(codes).toContain('functional_cast_missing_function')
  })

  it('single 模式缺 POV → pov_count_mismatch', () => {
    const plan = basePlan([scene({ povMode: 'single', povCharacterId: null })])
    const codes = validateChapterScenePlan(plan).map((i) => i.code)
    expect(codes).toContain('pov_count_mismatch')
  })

  it('omniscient 模式带 POV → pov_count_mismatch', () => {
    const plan = basePlan([scene({ povMode: 'omniscient', povCharacterId: 'c1' })])
    const codes = validateChapterScenePlan(plan).map((i) => i.code)
    expect(codes).toContain('pov_count_mismatch')
  })

  it('omniscient 模式允许 focus/present（无 POV 时通过）', () => {
    const plan = basePlan([
      scene({
        povMode: 'omniscient',
        povCharacterId: null,
        focusCharacterIds: ['c1', 'c2'],
        presentCharacterIds: ['c1', 'c2', 'c3'],
      }),
    ])
    expect(validateChapterScenePlan(plan)).toEqual([])
  })

  it('none 模式带 POV → pov_count_mismatch', () => {
    const plan = basePlan([scene({ povMode: 'none', povCharacterId: 'c1' })])
    const codes = validateChapterScenePlan(plan).map((i) => i.code)
    expect(codes).toContain('pov_count_mismatch')
  })

  it('空场景列表 → empty_scenes', () => {
    const codes = validateChapterScenePlan(basePlan([])).map((i) => i.code)
    expect(codes).toContain('empty_scenes')
  })
})
