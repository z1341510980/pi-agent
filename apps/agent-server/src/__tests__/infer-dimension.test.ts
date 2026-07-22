import { describe, expect, it } from 'vitest'
import { inferDimension } from '../plugins/novel-plugin/core/novel-memory-store.js'

/**
 * inferDimension 纯函数测试。
 *
 * 独立文件，不依赖 better-sqlite3 native binding，
 * 因此在任何环境下都能跑通，用于验证 dimension 推断规则正确性。
 *
 * recordEvent → listChangeRecords 的端到端测试在 novel-memory-store.test.ts 中，
 * 依赖 better-sqlite3 编译。
 */
describe('inferDimension - 边界情况', () => {
  it('newValue 为 null 时返回 null', () => {
    expect(inferDimension('character_change', null)).toEqual({ dimension: null, valueType: null })
  })

  it('newValue 不是 JSON 时返回 null', () => {
    expect(inferDimension('character_change', 'not-json')).toEqual({ dimension: null, valueType: null })
  })

  it('newValue 是数组时返回 null', () => {
    expect(inferDimension('character_change', '[1,2,3]')).toEqual({ dimension: null, valueType: null })
  })

  it('newValue 是空对象时返回 null', () => {
    expect(inferDimension('character_change', '{}')).toEqual({ dimension: null, valueType: null })
  })

  it('item_change / plot_event / world_change 规则为空 → 返回 null', () => {
    expect(inferDimension('item_change', '{"name":"剑"}', null)).toEqual({ dimension: null, valueType: null })
    expect(inferDimension('plot_event', '{"title":"高潮"}', null)).toEqual({ dimension: null, valueType: null })
    expect(inferDimension('world_change', '{"rule":"魔法"}', null)).toEqual({ dimension: null, valueType: null })
  })
})

describe('inferDimension - character_change', () => {
  it('arcStage → character.arc_stage', () => {
    const r = inferDimension('character_change', '{"arcStage":"成长"}', '{"arcStage":"起点"}')
    expect(r).toEqual({ dimension: 'character.arc_stage', valueType: 'enum' })
  })

  it('currentGoal → character.goal', () => {
    const r = inferDimension('character_change', '{"currentGoal":"复仇"}', '{"currentGoal":"生存"}')
    expect(r).toEqual({ dimension: 'character.goal', valueType: 'text' })
  })

  it('currentPressure → character.pressure', () => {
    const r = inferDimension('character_change', '{"currentPressure":8}', '{"currentPressure":5}')
    expect(r).toEqual({ dimension: 'character.pressure', valueType: 'level' })
  })

  it('secret → character.cognition', () => {
    const r = inferDimension('character_change', '{"secret":"真实身份是王子"}', '{"secret":""}')
    expect(r).toEqual({ dimension: 'character.cognition', valueType: 'text' })
  })

  it('longTermDesire → character.cognition', () => {
    const r = inferDimension('character_change', '{"longTermDesire":"称王"}', '{"longTermDesire":"生存"}')
    expect(r).toEqual({ dimension: 'character.cognition', valueType: 'text' })
  })

  it('participatingConflicts → character.conflict_link', () => {
    const r = inferDimension('character_change', '{"participatingConflicts":["c1","c2"]}', '{"participatingConflicts":["c1"]}')
    expect(r).toEqual({ dimension: 'character.conflict_link', valueType: 'set' })
  })

  it('创建事件（含 name）→ character.created', () => {
    const r = inferDimension('character_change', '{"name":"李雷","arcStage":"起点"}', null)
    expect(r).toEqual({ dimension: 'character.created', valueType: 'reference' })
  })
})

describe('inferDimension - conflict_change', () => {
  it('stage → conflict.stage（优先于 intensity）', () => {
    const r = inferDimension('conflict_change', '{"stage":"高潮","intensity":8}', '{"stage":"潜伏","intensity":5}')
    expect(r).toEqual({ dimension: 'conflict.stage', valueType: 'enum' })
  })

  it('intensity（无 stage）→ conflict.intensity', () => {
    const r = inferDimension('conflict_change', '{"intensity":8}', '{"intensity":5}')
    expect(r).toEqual({ dimension: 'conflict.intensity', valueType: 'level' })
  })

  it('plotFunction → conflict.plot_function', () => {
    const r = inferDimension('conflict_change', '{"plotFunction":"主线"}', '{"plotFunction":"支线"}')
    expect(r).toEqual({ dimension: 'conflict.plot_function', valueType: 'enum' })
  })

  it('progressionMode → conflict.progression_mode', () => {
    const r = inferDimension('conflict_change', '{"progressionMode":"spiral"}', '{"progressionMode":"linear"}')
    expect(r).toEqual({ dimension: 'conflict.progression_mode', valueType: 'enum' })
  })

  it('创建事件（4 字段齐全）→ conflict.created', () => {
    const r = inferDimension(
      'conflict_change',
      '{"stage":"潜伏","intensity":5,"plotFunction":"主线","progressionMode":"linear"}',
      null,
    )
    expect(r).toEqual({ dimension: 'conflict.created', valueType: 'reference' })
  })

  it('创建事件但字段不全（只有 stage）→ 不匹配 created，落到 conflict.stage', () => {
    const r = inferDimension('conflict_change', '{"stage":"潜伏"}', null)
    // isCreate=true 但 matchFields.every 不满足（缺 intensity/plotFunction/progressionMode）
    // 然后落到具体字段规则，stage 命中 → conflict.stage
    expect(r).toEqual({ dimension: 'conflict.stage', valueType: 'enum' })
  })
})

describe('inferDimension - foreshadow_change', () => {
  it('status → foreshadow.beat', () => {
    const r = inferDimension('foreshadow_change', '{"status":"payoff"}', '{"status":"planted"}')
    expect(r).toEqual({ dimension: 'foreshadow.beat', valueType: 'enum' })
  })

  it('lastChapter → foreshadow.payoff_chapter', () => {
    const r = inferDimension('foreshadow_change', '{"lastChapter":20}', '{"lastChapter":0}')
    expect(r).toEqual({ dimension: 'foreshadow.payoff_chapter', valueType: 'number' })
  })

  it('plantMethod → foreshadow.plant_method', () => {
    const r = inferDimension('foreshadow_change', '{"plantMethod":"对话"}', '{"plantMethod":"动作"}')
    expect(r).toEqual({ dimension: 'foreshadow.plant_method', valueType: 'text' })
  })

  it('recoverMethod → foreshadow.recover_method', () => {
    const r = inferDimension('foreshadow_change', '{"recoverMethod":"揭秘"}', '{"recoverMethod":"动作"}')
    expect(r).toEqual({ dimension: 'foreshadow.recover_method', valueType: 'text' })
  })

  it('创建事件（3 字段齐全）→ foreshadow.created', () => {
    const r = inferDimension(
      'foreshadow_change',
      '{"status":"planted","plantMethod":"对话","recoverMethod":"揭秘"}',
      null,
    )
    expect(r).toEqual({ dimension: 'foreshadow.created', valueType: 'reference' })
  })
})

describe('inferDimension - clue_change', () => {
  it('progress → clue.progress', () => {
    const r = inferDimension('clue_change', '{"progress":3}', '{"progress":1}')
    expect(r).toEqual({ dimension: 'clue.progress', valueType: 'number' })
  })

  it('currentStep → clue.step', () => {
    const r = inferDimension('clue_change', '{"currentStep":"找到凶器"}', '{"currentStep":"发现尸体"}')
    expect(r).toEqual({ dimension: 'clue.step', valueType: 'text' })
  })

  it('nextStep → clue.step', () => {
    const r = inferDimension('clue_change', '{"nextStep":"追查凶手"}', '{"nextStep":"找到凶器"}')
    expect(r).toEqual({ dimension: 'clue.step', valueType: 'text' })
  })

  it('pointsTo → clue.points_to', () => {
    const r = inferDimension('clue_change', '{"pointsTo":"管家"}', '{"pointsTo":"主人"}')
    expect(r).toEqual({ dimension: 'clue.points_to', valueType: 'text' })
  })

  it('isMisleading → clue.misleading', () => {
    const r = inferDimension('clue_change', '{"isMisleading":true}', '{"isMisleading":false}')
    expect(r).toEqual({ dimension: 'clue.misleading', valueType: 'enum' })
  })
})

describe('inferDimension - faction_change', () => {
  it('status → faction.status', () => {
    const r = inferDimension('faction_change', '{"status":"衰落"}', '{"status":"鼎盛"}')
    expect(r).toEqual({ dimension: 'faction.status', valueType: 'enum' })
  })

  it('无匹配字段 → fallback 到 faction.activity', () => {
    const r = inferDimension('faction_change', '{"leaderId":"f1"}', '{"leaderId":"f0"}')
    expect(r).toEqual({ dimension: 'faction.activity', valueType: 'text' })
  })

  it('创建事件 → faction.created（优先于 activity fallback）', () => {
    const r = inferDimension('faction_change', '{"name":"剑宗","status":"鼎盛","strength":9}', null)
    expect(r).toEqual({ dimension: 'faction.created', valueType: 'reference' })
  })
})

describe('inferDimension - location_change', () => {
  it('status → location.status', () => {
    const r = inferDimension('location_change', '{"status":"废弃"}', '{"status":"活跃"}')
    expect(r).toEqual({ dimension: 'location.status', valueType: 'enum' })
  })

  it('appearChapters → location.appear', () => {
    const r = inferDimension('location_change', '{"appearChapters":[1,2,3]}', '{"appearChapters":[1]}')
    expect(r).toEqual({ dimension: 'location.appear', valueType: 'set' })
  })

  it('创建事件（含 name+status）→ location.created', () => {
    const r = inferDimension('location_change', '{"name":"长安","status":"活跃"}', null)
    expect(r).toEqual({ dimension: 'location.created', valueType: 'reference' })
  })
})

describe('inferDimension - relationship_change', () => {
  it('currentStage → relationship.stage', () => {
    const r = inferDimension('relationship_change', '{"currentStage":"决裂"}', '{"currentStage":"盟友"}')
    expect(r).toEqual({ dimension: 'relationship.stage', valueType: 'enum' })
  })

  it('dynamicRole → relationship.role', () => {
    const r = inferDimension('relationship_change', '{"dynamicRole":"导师"}', '{"dynamicRole":"同伴"}')
    expect(r).toEqual({ dimension: 'relationship.role', valueType: 'text' })
  })

  it('alignment → relationship.alignment', () => {
    const r = inferDimension('relationship_change', '{"alignment":"敌对"}', '{"alignment":"中立"}')
    expect(r).toEqual({ dimension: 'relationship.alignment', valueType: 'enum' })
  })

  it('trend → relationship.trend', () => {
    const r = inferDimension('relationship_change', '{"trend":"恶化"}', '{"trend":"稳定"}')
    expect(r).toEqual({ dimension: 'relationship.trend', valueType: 'enum' })
  })

  it('chapterHint → relationship.hint', () => {
    const r = inferDimension('relationship_change', '{"chapterHint":"暗示背叛"}', '{"chapterHint":""}')
    expect(r).toEqual({ dimension: 'relationship.hint', valueType: 'text' })
  })

  it('lastUpdatedChapter → relationship.updated', () => {
    const r = inferDimension('relationship_change', '{"lastUpdatedChapter":5}', '{"lastUpdatedChapter":3}')
    expect(r).toEqual({ dimension: 'relationship.updated', valueType: 'number' })
  })

  it('创建事件 → relationship.created', () => {
    const r = inferDimension(
      'relationship_change',
      '{"relationType":"师徒","currentStage":"初识","alignment":"中立","trend":"稳定"}',
      null,
    )
    expect(r).toEqual({ dimension: 'relationship.created', valueType: 'reference' })
  })
})

describe('inferDimension - info_layer_change', () => {
  it('readerKnows → info_layer.reader_knows', () => {
    const r = inferDimension('info_layer_change', '{"readerKnows":true}', '{"readerKnows":false}')
    expect(r).toEqual({ dimension: 'info_layer.reader_knows', valueType: 'enum' })
  })

  it('isRevealed → info_layer.revealed', () => {
    const r = inferDimension('info_layer_change', '{"isRevealed":true}', '{"isRevealed":false}')
    expect(r).toEqual({ dimension: 'info_layer.revealed', valueType: 'enum' })
  })

  it('linkedForeshadows → info_layer.links', () => {
    const r = inferDimension('info_layer_change', '{"linkedForeshadows":["f1","f2"]}', '{"linkedForeshadows":["f1"]}')
    expect(r).toEqual({ dimension: 'info_layer.links', valueType: 'set' })
  })

  it('创建事件 → info_layer.created', () => {
    const r = inferDimension('info_layer_change', '{"readerKnows":false,"isRevealed":false}', null)
    expect(r).toEqual({ dimension: 'info_layer.created', valueType: 'reference' })
  })
})

describe('inferDimension - 匹配顺序验证', () => {
  it('创建事件优先匹配 isCreate 规则，而非具体字段规则', () => {
    // conflict 创建：含 stage，如果先匹配具体字段会得到 conflict.stage
    // 但 isCreate 优先，4 字段齐全 → conflict.created
    const r = inferDimension(
      'conflict_change',
      '{"stage":"潜伏","intensity":5,"plotFunction":"主线","progressionMode":"linear"}',
      null,
    )
    expect(r.dimension).toBe('conflict.created')
  })

  it('非创建事件不匹配 isCreate 规则', () => {
    // 同样的 newValue，但 oldValue 非 null → 落到具体字段规则
    const r = inferDimension(
      'conflict_change',
      '{"stage":"潜伏","intensity":5,"plotFunction":"主线","progressionMode":"linear"}',
      '{"stage":"爆发","intensity":8,"plotFunction":"支线","progressionMode":"linear"}',
    )
    expect(r.dimension).toBe('conflict.stage')
  })

  it('faction_change 创建事件优先于 activity fallback', () => {
    // faction_change 规则顺序：status → activity(fallback) → created
    // 如果不优先 isCreate，创建事件会先命中 activity fallback
    const r = inferDimension('faction_change', '{"name":"剑宗","status":"鼎盛","strength":9}', null)
    expect(r.dimension).toBe('faction.created')
  })
})
