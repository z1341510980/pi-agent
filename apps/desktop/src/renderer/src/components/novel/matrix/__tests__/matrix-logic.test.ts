import { describe, it, expect } from 'vitest'
import {
  groupContiguousSpans,
  computeCharacterSpans,
  computeSpanRange,
  shiftChapterSpan,
  computeForeshadowLine,
  moveForeshadowEndpointBeat,
  resolveForeshadowLeftClickBeat,
  setForeshadowBeatNote,
  upsertForeshadowBeat,
  computeMaxChapter,
  buildPool,
  appendPendingEntities,
  computeCellSymbol,
  GROUP_META,
  GROUP_ORDER,
  tensionToBgClass,
  tensionToLabel,
} from '../matrix-logic'
import { buildGroups } from '../matrix-model'
import type { NovelChapter, NovelCharacter, NovelConflict, NovelClue, NovelCharacterHistory, NovelForeshadow, NovelFaction, NovelLocation, NovelWorldElement } from '@/api/novel-client'

// ── 测试夹具 ──

function makeChapter(n: number, title = `第${n}章`): NovelChapter {
  return {
    id: `ch${n}`, projectId: 'p', volume: 1, chapterNumber: n, title,
    content: '', wordCount: 1000, status: 'draft' as never, narrativeTask: '',
    acceptanceResult: null, createdAt: 0, updatedAt: 0,
  }
}

function makeCharacter(id: string, name: string, isProtagonist = false): NovelCharacter {
  return {
    id, projectId: 'p', name, description: '', identity: '', personality: '', appearance: '',
    currentState: '', currentGoal: '', currentPressure: '', secret: '', arcStage: '', arcHistory: '',
    speechStyle: '', isProtagonist,
    longTermDesire: '', plotRole: 'supporting', removalImpact: '',
    createdAt: 0, updatedAt: 0,
  }
}

function makeClue(id: string, chapterSpans: Array<[number, number]>): NovelClue {
  return {
    id, projectId: 'p', description: '铜扣', pointsTo: '真凶', progress: 25,
    currentStep: '已发现', nextStep: '查来源', isMisleading: false,
    chapterSpans, createdAt: 0, updatedAt: 0,
  }
}

function makeHistory(charId: string, chapter: number): NovelCharacterHistory {
  return {
    id: `h${charId}${chapter}`, projectId: 'p', characterId: charId, chapterId: null,
    chapterNumber: chapter, fieldName: 'currentState', oldValue: null, newValue: '', reason: null,
    createdAt: 0,
  }
}

function makeConflict(id: string, first: number | null, last: number | null, tier: 'main' | 'secondary' | 'goal' = 'main'): NovelConflict {
  return {
    id, projectId: 'p', description: id, type: 'man_vs_man' as never, intensity: 5,
    stage: 'rising' as never, participants: '',
    chapterSpans: first != null ? [[first, last ?? first]] : [],
    tier,
    createdAt: 0, updatedAt: 0,
  }
}

function makeForeshadow(id: string, first: number | null, recover: number | null): NovelForeshadow {
  // 迁移 055：chapterSpans 为活跃区间，至少包含 [first, recover ?? first] 一段
  // 无 first 时 chapterSpans 为 []（进元素池，矩阵不渲染行）
  const chapterSpans: Array<[number, number]> = first == null
    ? []
    : [[first, recover ?? first]]
  return {
    id, projectId: 'p', description: id, category: 'item', status: 'planted' as never,
    firstChapter: first, lastChapter: null, recoverByChapter: recover,
    chapterSpans, createdAt: 0, updatedAt: 0,
  }
}

function makeFaction(id: string, first: number | null, last: number | null): NovelFaction {
  return {
    id, projectId: 'p', name: id, description: '', type: 'sect' as never, leaderId: null,
    ideology: '', strength: 'medium' as never, resources: [], allies: [], enemies: [],
    status: 'active' as never,
    chapterSpans: first != null ? [[first, last ?? first]] : [],
    createdAt: 0, updatedAt: 0,
  }
}

function makeLocation(id: string, appears: number[]): NovelLocation {
  return {
    id, projectId: 'p', name: id, description: '', type: 'city' as never, parentId: null,
    factionId: null, significance: 'moderate' as never, firstChapter: null, appearChapters: appears,
    status: 'normal' as never, createdAt: 0, updatedAt: 0,
  }
}

function makeWorldElement(id: string): NovelWorldElement {
  return {
    id, projectId: 'p', category: 'history' as never, name: id, description: '', parentId: null,
    attributes: {}, createdAt: 0, updatedAt: 0,
  }
}

// ── groupContiguousSpans ──

describe('groupContiguousSpans', () => {
  it('returns empty for empty input', () => {
    expect(groupContiguousSpans([])).toEqual([])
  })
  it('groups contiguous chapters into single span', () => {
    expect(groupContiguousSpans([1, 2, 3])).toEqual([{ start: 1, end: 3 }])
  })
  it('splits at gaps', () => {
    expect(groupContiguousSpans([1, 2, 5, 6, 7])).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 7 },
    ])
  })
  it('dedupes and sorts unsorted input', () => {
    expect(groupContiguousSpans([5, 1, 3, 2, 5])).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
    ])
  })
})

// ── computeCharacterSpans ──

describe('computeCharacterSpans', () => {
  it('filters null chapterNumber', () => {
    const spans = computeCharacterSpans([
      { chapterNumber: 1 }, { chapterNumber: null }, { chapterNumber: 2 },
    ])
    expect(spans).toEqual([{ start: 1, end: 2 }])
  })
  it('returns empty when all null', () => {
    expect(computeCharacterSpans([{ chapterNumber: null }])).toEqual([])
  })
})

// ── computeSpanRange ──

describe('computeSpanRange', () => {
  it('returns null for empty spans', () => {
    expect(computeSpanRange([])).toBeNull()
  })
  it('returns single-point range for degenerate span', () => {
    expect(computeSpanRange([[5, 5]])).toEqual({ start: 5, end: 5 })
  })
  it('returns range for single span', () => {
    expect(computeSpanRange([[3, 8]])).toEqual({ start: 3, end: 8 })
  })
  it('returns overall range across multiple spans', () => {
    expect(computeSpanRange([[1, 3], [10, 12]])).toEqual({ start: 1, end: 12 })
  })
})

describe('shiftChapterSpan', () => {
  it('keeps span duration while moving it by chapter delta', () => {
    expect(shiftChapterSpan([3, 8], 2, 20)).toEqual([5, 10])
  })

  it('clamps a moved span to both timeline edges', () => {
    expect(shiftChapterSpan([3, 8], -20, 20)).toEqual([1, 6])
    expect(shiftChapterSpan([15, 20], 20, 20)).toEqual([15, 20])
  })
})

// ── computeForeshadowLine ──

describe('computeForeshadowLine', () => {
  it('returns null when first is null', () => {
    expect(computeForeshadowLine(null, 10, 20)).toBeNull()
  })
  it('returns recovered line when recover set', () => {
    expect(computeForeshadowLine(1, 11, 20)).toEqual({
      start: 1, end: 11, recovered: true,
    })
  })
  it('does not imply every later chapter is related when not recovered', () => {
    expect(computeForeshadowLine(7, null, 20)).toEqual({
      start: 7, end: 7, recovered: false,
    })
  })
})

describe('resolveForeshadowLeftClickBeat', () => {
  it('sets the plant point when the chain has not started', () => {
    expect(resolveForeshadowLeftClickBeat([], 4)).toBe('plant')
  })

  it('moves the plant point earlier when clicking before it', () => {
    expect(resolveForeshadowLeftClickBeat([{ chapter: 5, type: 'plant' }], 3)).toBe('plant')
  })

  it('quick-adds a reinforce point inside an active chain', () => {
    expect(resolveForeshadowLeftClickBeat([
      { chapter: 2, type: 'plant' },
      { chapter: 8, type: 'payoff' },
    ], 5)).toBe('reinforce')
  })

  it('does not overwrite an existing point or add after payoff', () => {
    const beats = [
      { chapter: 2, type: 'plant' as const },
      { chapter: 5, type: 'reveal' as const },
      { chapter: 8, type: 'payoff' as const },
    ]
    expect(resolveForeshadowLeftClickBeat(beats, 5)).toBeNull()
    expect(resolveForeshadowLeftClickBeat(beats, 9)).toBeNull()
  })
})

describe('foreshadow beat notes', () => {
  it('修改同章节点类型时保留节点内容', () => {
    const beats = [
      { chapter: 2, type: 'plant' as const, note: '镜背有一道划痕' },
      { chapter: 5, type: 'reinforce' as const, note: '划痕与徽记相似' },
    ]

    expect(upsertForeshadowBeat(beats, 5, 'reveal')).toEqual([
      beats[0],
      { chapter: 5, type: 'reveal', note: '划痕与徽记相似' },
    ])
  })

  it('编辑内容时裁掉首尾空白，清空时移除 note 字段', () => {
    const beats = [{ chapter: 2, type: 'plant' as const }]
    const noted = setForeshadowBeatNote(beats, 2, '  镜背有一道划痕  ')
    expect(noted).toEqual([{ chapter: 2, type: 'plant', note: '镜背有一道划痕' }])
    expect(setForeshadowBeatNote(noted, 2, '   ')).toEqual(beats)
  })

  it('拖动埋设或回收节点时保留节点内容', () => {
    const beats = [
      { chapter: 2, type: 'plant' as const, note: '镜子首次出现' },
      { chapter: 8, type: 'payoff' as const, note: '镜后暗格开启' },
    ]

    expect(moveForeshadowEndpointBeat(beats, 'plant', 3)).toEqual([
      { chapter: 3, type: 'plant', note: '镜子首次出现' },
      beats[1],
    ])
  })
})

// ── computeMaxChapter ──

describe('computeMaxChapter', () => {
  it('returns 20 minimum when no chapters', () => {
    expect(computeMaxChapter([])).toBe(20)
  })
  it('returns 20 minimum when chapters are fewer', () => {
    expect(computeMaxChapter([makeChapter(5)])).toBe(20)
  })
  it('returns max chapter number when above 20', () => {
    expect(computeMaxChapter([makeChapter(25)])).toBe(25)
  })
})

// ── buildGroups ──

describe('buildGroups', () => {
  it('builds all groups in fixed order even when some empty', () => {
    const data = buildGroups({
      chapters: [], characters: [], conflicts: [], clues: [], foreshadows: [], factions: [],
      locations: [], worldElements: [], items: [], characterHistory: [],
    })
    expect(data.groups.map((g) => g.id)).toEqual(GROUP_ORDER)
    expect(data.maxChapter).toBe(20)
  })

  it('places character with history into character group', () => {
    const data = buildGroups({
      chapters: [makeChapter(1), makeChapter(2)],
      characters: [makeCharacter('c1', '主角', true)],
      conflicts: [], clues: [], foreshadows: [], factions: [], locations: [], worldElements: [], items: [],
      characterHistory: [makeHistory('c1', 1), makeHistory('c1', 2)],
    })
    const charGroup = data.groups.find((g) => g.id === 'character')!
    expect(charGroup.entities).toHaveLength(1)
    expect(charGroup.entities[0]).toMatchObject({
      id: 'c1', name: '主角', isProtagonist: true, subLabel: '主角',
    })
    expect(charGroup.entities[0].characterSpans).toEqual([{ start: 1, end: 2 }])
  })

  it('skips character without history (goes to pool)', () => {
    const data = buildGroups({
      chapters: [], characters: [makeCharacter('c1', '路人')],
      conflicts: [], clues: [], foreshadows: [], factions: [], locations: [], worldElements: [], items: [],
      characterHistory: [],
    })
    expect(data.groups.find((g) => g.id === 'character')!.entities).toHaveLength(0)
  })

  it('places conflict with firstChapter into conflict group', () => {
    const data = buildGroups({
      chapters: [], characters: [],
      conflicts: [makeConflict('cf1', 3, 10, 'main'), makeConflict('cf2', null, null)],
      clues: [], foreshadows: [], factions: [], locations: [], worldElements: [], items: [], characterHistory: [],
    })
    const group = data.groups.find((g) => g.id === 'conflict')!
    expect(group.entities).toHaveLength(1)
    expect(group.entities[0]).toMatchObject({
      id: 'cf1', chapterSpans: [[3, 10]], spanStart: 3, spanEnd: 10, subLabel: '主要冲突',
    })
  })

  it('places foreshadow with chapterSpans into foreshadow group', () => {
    const data = buildGroups({
      chapters: [], characters: [], conflicts: [], clues: [],
      foreshadows: [makeForeshadow('f1', 1, 11), makeForeshadow('f2', 7, null), makeForeshadow('f3', null, null)],
      factions: [], locations: [], worldElements: [], items: [], characterHistory: [],
    })
    const group = data.groups.find((g) => g.id === 'foreshadow')!
    expect(group.entities).toHaveLength(2)
    // f1 只有“计划第 11 章回收”，没有 payoff 节点 → 仍是待回收，只有 1 个已发生节点。
    // 矩阵画事实：把计划画成“已回收”曾让用户以为伏笔已结清。
    expect(group.entities[0]).toMatchObject({ id: 'f1', subLabel: '1 个节点 · 待回收' })
    // 跳度终点仍用计划回收章，让色带能表达“还欠着到第 11 章”
    expect(group.entities[0]).toMatchObject({ spanStart: 1, spanEnd: 11, payoffChapter: null })
    expect(group.entities[1]).toMatchObject({ id: 'f2', subLabel: '1 个节点 · 待回收' })
  })

  it('真实 payoff 节点才算已回收', () => {
    const withPayoff = {
      ...makeForeshadow('f-paid', 1, 11),
      beats: [
        { chapter: 1, type: 'plant' as const },
        { chapter: 9, type: 'payoff' as const },
      ],
    }
    const data = buildGroups({
      chapters: [], characters: [], conflicts: [], clues: [],
      foreshadows: [withPayoff],
      factions: [], locations: [], worldElements: [], items: [], characterHistory: [],
    })
    const group = data.groups.find((g) => g.id === 'foreshadow')!
    expect(group.entities[0]).toMatchObject({
      id: 'f-paid',
      subLabel: '2 个节点 · 已回收',
      payoffChapter: 9,
      // 实际回收点优先于计划回收章
      spanEnd: 9,
    })
  })

  it('places a scheduled clue into the clue track', () => {
    const data = buildGroups({
      chapters: [], characters: [], conflicts: [], clues: [makeClue('cl1', [[2, 2], [5, 5]])],
      foreshadows: [], factions: [], locations: [], worldElements: [], items: [], characterHistory: [],
    })
    const clue = data.groups.find((group) => group.id === 'clue')!.entities[0]
    expect(clue).toMatchObject({ id: 'cl1', kind: 'clue', chapterSpans: [[2, 2], [5, 5]] })
    expect(computeCellSymbol(clue, 2)).toEqual({ type: 'clue-progress' })
    expect(computeCellSymbol(clue, 3)).toEqual({ type: 'empty' })
  })

  it('places faction with firstChapter into faction group', () => {
    const data = buildGroups({
      chapters: [], characters: [], conflicts: [], clues: [], foreshadows: [],
      factions: [makeFaction('fa1', 1, 12)],
      locations: [], worldElements: [], items: [], characterHistory: [],
    })
    const group = data.groups.find((g) => g.id === 'faction')!
    expect(group.entities).toHaveLength(1)
    expect(group.entities[0]).toMatchObject({ id: 'fa1', chapterSpans: [[1, 12]], spanStart: 1, spanEnd: 12 })
  })

  it('places location with appearChapters into location group', () => {
    const data = buildGroups({
      chapters: [], characters: [], conflicts: [], clues: [], foreshadows: [], factions: [],
      locations: [makeLocation('l1', [3, 1, 2])],
      worldElements: [], items: [], characterHistory: [],
    })
    const group = data.groups.find((g) => g.id === 'location')!
    expect(group.entities).toHaveLength(1)
    // appearChapters should be sorted
    expect(group.entities[0].appearChapters).toEqual([1, 2, 3])
  })

  it('places all world elements as always-present', () => {
    const data = buildGroups({
      chapters: [makeChapter(15)], characters: [], conflicts: [], clues: [], foreshadows: [], factions: [],
      locations: [], worldElements: [makeWorldElement('w1')], items: [], characterHistory: [],
    })
    const group = data.groups.find((g) => g.id === 'world_element')!
    expect(group.entities).toHaveLength(1)
    expect(group.entities[0]).toMatchObject({ id: 'w1', alwaysStart: 1, alwaysEnd: 20 })
  })

  it('fills note from clip-note markers by entityId', () => {
    const data = buildGroups({
      chapters: [], characters: [makeCharacter('c1', 'A')],
      conflicts: [], clues: [], foreshadows: [], factions: [], locations: [], worldElements: [],
      items: [],
      characterHistory: [makeHistory('c1', 1)],
      markers: [
        { type: 'clip-note', entityId: 'c1', note: '批注内容' },
        { type: 'bookmark', entityId: 'c1', note: '应被忽略' },
      ],
    })
    const char = data.groups.find((g) => g.id === 'character')!.entities[0]
    expect(char.note).toBe('批注内容')
  })
})

// ── buildPool ──

describe('buildPool', () => {
  it('returns characters without history', () => {
    const pool = buildPool({
      characters: [makeCharacter('c1', 'A'), makeCharacter('c2', 'B')],
      conflicts: [], clues: [], foreshadows: [], factions: [], locations: [],
      items: [],
      characterHistory: [makeHistory('c1', 1)],
    })
    expect(pool.poolCharacters.map((c) => c.id)).toEqual(['c2'])
  })

  it('returns conflicts without firstChapter', () => {
    const pool = buildPool({
      characters: [], conflicts: [makeConflict('cf1', null, null), makeConflict('cf2', 1, 5)],
      clues: [], foreshadows: [], factions: [], locations: [], items: [], characterHistory: [],
    })
    expect(pool.poolConflicts.map((c) => c.id)).toEqual(['cf1'])
  })

  it('returns locations without appearChapters', () => {
    const pool = buildPool({
      characters: [], conflicts: [], clues: [], foreshadows: [], factions: [],
      locations: [makeLocation('l1', []), makeLocation('l2', [1])],
      items: [],
      characterHistory: [],
    })
    expect(pool.poolLocations.map((l) => l.id)).toEqual(['l1'])
  })
})

// ── appendPendingEntities ──
//
// 「未上线」实体（已创建但未放到任何章节）此前会被 buildGroups 直接跳过，
// 在矩阵里完全不可见，唯一线索是工具栏「补全历史」的角标数字。
// 这里覆盖它们被补回各自分组、且不破坏既有行的行为。

describe('appendPendingEntities', () => {
  function buildWith(characters: NovelCharacter[], characterHistory: NovelCharacterHistory[]) {
    const built = buildGroups({
      chapters: [], characters, conflicts: [], clues: [], foreshadows: [], factions: [],
      locations: [], worldElements: [], items: [], characterHistory,
    })
    const pool = buildPool({
      characters, conflicts: [], clues: [], foreshadows: [], factions: [], locations: [],
      items: [], characterHistory,
    })
    return appendPendingEntities(built.groups, pool)
  }

  it('把无历史的角色补成 pending 行（此前整行不存在）', () => {
    const groups = buildWith([makeCharacter('c1', 'A'), makeCharacter('c2', 'B')], [makeHistory('c1', 1)])
    const characterGroup = groups.find((g) => g.id === 'character')!

    expect(characterGroup.entities.map((e) => e.entityId)).toEqual(['c1', 'c2'])
    expect(characterGroup.entities.find((e) => e.entityId === 'c2')?.pending).toBe(true)
    expect(characterGroup.entities.find((e) => e.entityId === 'c2')?.subLabel).toBe('未上线')
  })

  it('已上线的实体不标 pending，且排在未上线之前', () => {
    const groups = buildWith([makeCharacter('c2', 'B'), makeCharacter('c1', 'A')], [makeHistory('c1', 1)])
    const entities = groups.find((g) => g.id === 'character')!.entities

    expect(entities[0].entityId).toBe('c1')
    expect(entities[0].pending).toBeUndefined()
    expect(entities[entities.length - 1].pending).toBe(true)
  })

  it('pending 行没有任何跨度 —— 整行空单元格，双击即就地上线', () => {
    const groups = buildWith([makeCharacter('c1', 'A')], [])
    const pending = groups.find((g) => g.id === 'character')!.entities[0]

    expect(pending.pending).toBe(true)
    expect(pending.characterSpans).toBeUndefined()
    expect(computeCellSymbol(pending, 1)).toEqual({ type: 'empty' })
  })

  it('kind 保持原样，五处平行 switch 无需改动', () => {
    const groups = buildWith([makeCharacter('c1', 'A')], [])
    const pending = groups.find((g) => g.id === 'character')!.entities[0]

    expect(pending.kind).toBe('character')
    expect(pending.entityType).toBe('character')
  })

  it('元素池为空时原样返回分组对象（不产生多余重渲染）', () => {
    const characters = [makeCharacter('c1', 'A')]
    const characterHistory = [makeHistory('c1', 1)]
    const built = buildGroups({
      chapters: [], characters, conflicts: [], clues: [], foreshadows: [], factions: [],
      locations: [], worldElements: [], items: [], characterHistory,
    })
    const pool = buildPool({
      characters, conflicts: [], clues: [], foreshadows: [], factions: [], locations: [],
      items: [], characterHistory,
    })

    const groups = appendPendingEntities(built.groups, pool)
    const before = built.groups.find((g) => g.id === 'character')!
    expect(groups.find((g) => g.id === 'character')).toBe(before)
  })

  it('未命名实体回落到占位名，不渲染空标签', () => {
    const groups = buildWith([makeCharacter('c1', '')], [])
    expect(groups.find((g) => g.id === 'character')!.entities[0].name).toBe('未命名')
  })
})

// ── computeCellSymbol ──

describe('computeCellSymbol', () => {
  it('returns present for character in span', () => {
    const entity = {
      id: 'c1', kind: 'character' as const, name: 'A', entityId: 'c1', entityType: 'character' as const,
      isProtagonist: true, characterSpans: [{ start: 1, end: 3 }],
    }
    expect(computeCellSymbol(entity, 2)).toEqual({ type: 'present', protagonist: true })
    expect(computeCellSymbol(entity, 5)).toEqual({ type: 'empty' })
  })

  it('returns span-start/middle/end for conflict', () => {
    const entity = {
      id: 'cf1', kind: 'conflict' as const, name: 'X', entityId: 'cf1', entityType: 'conflict' as const,
      chapterSpans: [[3, 8]] as Array<[number, number]>, spanStart: 3, spanEnd: 8,
    }
    expect(computeCellSymbol(entity, 3)).toEqual({ type: 'span-start' })
    expect(computeCellSymbol(entity, 5)).toEqual({ type: 'span-middle' })
    expect(computeCellSymbol(entity, 8)).toEqual({ type: 'span-end' })
    expect(computeCellSymbol(entity, 9)).toEqual({ type: 'empty' })
  })

  it('handles multi-span conflict with gaps', () => {
    const entity = {
      id: 'cf2', kind: 'conflict' as const, name: 'Y', entityId: 'cf2', entityType: 'conflict' as const,
      chapterSpans: [[1, 3], [10, 12]] as Array<[number, number]>, spanStart: 1, spanEnd: 12,
    }
    // 第一段中部
    expect(computeCellSymbol(entity, 2)).toEqual({ type: 'span-middle' })
    // gap 章节（4-9 之间）→ empty
    expect(computeCellSymbol(entity, 4)).toEqual({ type: 'empty' })
    expect(computeCellSymbol(entity, 9)).toEqual({ type: 'empty' })
    // 第二段起点
    expect(computeCellSymbol(entity, 10)).toEqual({ type: 'span-start' })
    // 第二段终点
    expect(computeCellSymbol(entity, 12)).toEqual({ type: 'span-end' })
  })

  it('handles multi-span faction with gaps', () => {
    const entity = {
      id: 'fa1', kind: 'faction' as const, name: 'Z', entityId: 'fa1', entityType: 'faction' as const,
      chapterSpans: [[1, 3], [10, 12]] as Array<[number, number]>, spanStart: 1, spanEnd: 12,
    }
    // 第一段中部
    expect(computeCellSymbol(entity, 2)).toEqual({ type: 'span-middle' })
    // gap 章节 → empty
    expect(computeCellSymbol(entity, 4)).toEqual({ type: 'empty' })
    // 第二段起点
    expect(computeCellSymbol(entity, 10)).toEqual({ type: 'span-start' })
    // 第二段终点
    expect(computeCellSymbol(entity, 12)).toEqual({ type: 'span-end' })
  })

  it('returns conflict-climax at climaxChapter (overrides span symbols)', () => {
    const entity = {
      id: 'cf3', kind: 'conflict' as const, name: 'Climax', entityId: 'cf3', entityType: 'conflict' as const,
      chapterSpans: [[3, 8]] as Array<[number, number]>, spanStart: 3, spanEnd: 8,
      climaxChapter: 5,
    }
    // 高潮章节优先于 span-middle
    expect(computeCellSymbol(entity, 5)).toEqual({ type: 'conflict-climax' })
    // 高潮章节与 span-start 重合时也优先
    const entity2 = {
      id: 'cf4', kind: 'conflict' as const, name: 'ClimaxAtStart', entityId: 'cf4', entityType: 'conflict' as const,
      chapterSpans: [[3, 8]] as Array<[number, number]>, spanStart: 3, spanEnd: 8,
      climaxChapter: 3,
    }
    expect(computeCellSymbol(entity2, 3)).toEqual({ type: 'conflict-climax' })
    // 非高潮章节仍返回 span 符号
    expect(computeCellSymbol(entity, 3)).toEqual({ type: 'span-start' })
    expect(computeCellSymbol(entity, 8)).toEqual({ type: 'span-end' })
  })

  it('faction ignores climaxChapter (no conflict-climax for faction)', () => {
    const entity = {
      id: 'fa2', kind: 'faction' as const, name: 'F', entityId: 'fa2', entityType: 'faction' as const,
      chapterSpans: [[3, 8]] as Array<[number, number]>, spanStart: 3, spanEnd: 8,
      climaxChapter: 5,
    }
    // faction 即使有 climaxChapter 也不返回 conflict-climax
    expect(computeCellSymbol(entity, 5)).toEqual({ type: 'span-middle' })
  })

  it('returns foreshadow-plant/payoff/empty for foreshadow', () => {
    // 旧数据仍兼容 plant/payoff 端点；没有显式节点的中间章节必须保持 empty。
    const entity = {
      id: 'f1', kind: 'foreshadow' as const, name: 'Y', entityId: 'f1', entityType: 'foreshadow' as const,
      plantChapter: 2, payoffChapter: 10, chapterSpans: [[2, 10]] as Array<[number, number]>,
    }
    expect(computeCellSymbol(entity, 2)).toEqual({ type: 'foreshadow-plant' })
    expect(computeCellSymbol(entity, 5)).toEqual({ type: 'empty' })
    expect(computeCellSymbol(entity, 10)).toEqual({ type: 'foreshadow-payoff' })
    expect(computeCellSymbol(entity, 15)).toEqual({ type: 'empty' })
  })

  it('returns empty for foreshadow without payoff (only plant has symbol)', () => {
    const entity = {
      id: 'f2', kind: 'foreshadow' as const, name: 'Y', entityId: 'f2', entityType: 'foreshadow' as const,
      plantChapter: 5, payoffChapter: null, chapterSpans: [[5, 5]] as Array<[number, number]>,
    }
    expect(computeCellSymbol(entity, 5)).toEqual({ type: 'foreshadow-plant' })
    expect(computeCellSymbol(entity, 7)).toEqual({ type: 'empty' })
  })

  it('renders only explicit foreshadow event chapters', () => {
    const entity = {
      id: 'f3', kind: 'foreshadow' as const, name: '事件链', entityId: 'f3', entityType: 'foreshadow' as const,
      plantChapter: 2, payoffChapter: 12,
      foreshadowBeats: [
        { chapter: 2, type: 'plant' as const },
        { chapter: 5, type: 'reinforce' as const },
        { chapter: 8, type: 'reveal' as const },
        { chapter: 12, type: 'payoff' as const },
      ],
    }
    expect(computeCellSymbol(entity, 2)).toEqual({ type: 'foreshadow-plant' })
    expect(computeCellSymbol(entity, 5)).toEqual({ type: 'foreshadow-reinforce' })
    expect(computeCellSymbol(entity, 8)).toEqual({ type: 'foreshadow-reveal' })
    expect(computeCellSymbol(entity, 12)).toEqual({ type: 'foreshadow-payoff' })
    expect(computeCellSymbol(entity, 6)).toEqual({ type: 'empty' })
  })

  it('returns location for appearChapters', () => {
    const entity = {
      id: 'l1', kind: 'location' as const, name: 'Z', entityId: 'l1', entityType: 'location' as const,
      appearChapters: [1, 5, 8],
    }
    expect(computeCellSymbol(entity, 5)).toEqual({ type: 'location' })
    expect(computeCellSymbol(entity, 6)).toEqual({ type: 'empty' })
  })

  it('returns world-element across full range', () => {
    const entity = {
      id: 'w1', kind: 'world_element' as const, name: 'W', entityId: 'w1', entityType: 'world_element' as const,
      alwaysStart: 1, alwaysEnd: 12,
    }
    expect(computeCellSymbol(entity, 1)).toEqual({ type: 'world-element' })
    expect(computeCellSymbol(entity, 12)).toEqual({ type: 'world-element' })
    expect(computeCellSymbol(entity, 13)).toEqual({ type: 'empty' })
  })
})

// ── GROUP_META / GROUP_ORDER ──

describe('GROUP_META', () => {
  it('has entries for all matrix kinds', () => {
    expect(Object.keys(GROUP_META)).toHaveLength(9)
    expect(GROUP_META.character.color).toBe('#3b82f6')
  })
})

describe('GROUP_ORDER', () => {
  it('lists character first, item last', () => {
    expect(GROUP_ORDER[0]).toBe('character')
    expect(GROUP_ORDER[GROUP_ORDER.length - 1]).toBe('item')
  })
})

// ── TensionLevel 色阶 ──

describe('TensionLevel 矩阵色阶', () => {
  it('tension=1 (LOW) 返回最浅色阶', () => {
    expect(tensionToBgClass(1)).toContain('bg-amber')
    expect(tensionToLabel(1)).toBe('LOW')
  })

  it('tension=10 (EXTREME) 返回最深色阶', () => {
    expect(tensionToBgClass(10)).toContain('bg-red')
    expect(tensionToLabel(10)).toBe('EXTREME')
  })

  it('tension=null/undefined 返回空字符串', () => {
    expect(tensionToBgClass(null)).toBe('')
    expect(tensionToBgClass(undefined)).toBe('')
    expect(tensionToLabel(null)).toBe('')
    expect(tensionToLabel(undefined)).toBe('')
  })

  it('tension 阶梯映射：1-3 浅色, 4-6 中色, 7-8 深色, 9-10 极深', () => {
    expect(tensionToBgClass(3)).toMatch(/bg-amber-100|bg-amber-200/)
    expect(tensionToBgClass(6)).toMatch(/bg-amber-300|bg-amber-400/)
    expect(tensionToBgClass(8)).toMatch(/bg-red-400|bg-red-500/)
    expect(tensionToBgClass(10)).toMatch(/bg-red-600|bg-red-700/)
  })
})
