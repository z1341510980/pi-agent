/**
 * 伏笔「事实 vs 意图」的分离
 *
 * 矩阵跨度终点原本是 `payoffChapter ?? recoverByChapter`，把两件性质不同的事
 * 压成同一个数：
 *   - `payoff`：已经回收到第 N 章（**事实**，来自 beats）
 *   - `planned`：计划第 N 章前回收，目前还欠着（**意图**，来自 recoverByChapter）
 *
 * 于是「已还」和「欠着」在矩阵上长得一样，而拖动终点在后者情况下改的是计划。
 * 这里覆盖 spanEndKind 的判定 —— 判错的后果是把一条欠着的伏笔显示成已完成，
 * 用户会以为债已还清。
 */
import { describe, it, expect } from 'vitest'
import { buildGroups } from '../matrix-model'
import type { NovelForeshadow } from '@/api/novel-client'

function foreshadow(partial: Partial<NovelForeshadow>): NovelForeshadow {
  return {
    id: 'f1',
    projectId: 'p1',
    description: '第七处节点',
    category: 'item',
    status: 'planted',
    firstChapter: 3,
    lastChapter: 3,
    recoverByChapter: null,
    plantMethod: 'implicit',
    recoverMethod: 'explicit',
    chapterSpans: [],
    beats: [{ chapter: 3, type: 'plant' }],
    ...partial,
  } as NovelForeshadow
}

function build(f: NovelForeshadow) {
  const data = buildGroups({
    chapters: [], characters: [], conflicts: [], clues: [],
    foreshadows: [f], factions: [], locations: [], worldElements: [],
    items: [], characterHistory: [],
  })
  return data.groups.find((g) => g.id === 'foreshadow')!.entities[0]
}

describe('spanEndKind：区分事实与意图', () => {
  it('beats 里有 payoff → 终点是事实', () => {
    const entity = build(foreshadow({
      beats: [{ chapter: 3, type: 'plant' }, { chapter: 8, type: 'payoff' }],
    }))

    expect(entity.spanEnd).toBe(8)
    expect(entity.spanEndKind).toBe('payoff')
    expect(entity.payoffChapter).toBe(8)
  })

  it('只有 recoverByChapter → 终点是意图，且不算已回收', () => {
    const entity = build(foreshadow({ recoverByChapter: 12 }))

    expect(entity.spanEnd).toBe(12)
    expect(entity.spanEndKind).toBe('planned')
    // 关键：计划不能让它显示成已回收
    expect(entity.payoffChapter).toBeNull()
    expect(entity.subLabel).toContain('待回收')
  })

  it('两者都有时事实优先 —— 已回收的伏笔不该再显示"欠着到第 N 章"', () => {
    const entity = build(foreshadow({
      recoverByChapter: 20,
      beats: [{ chapter: 3, type: 'plant' }, { chapter: 8, type: 'payoff' }],
    }))

    expect(entity.spanEnd).toBe(8)
    expect(entity.spanEndKind).toBe('payoff')
  })

  it('两者都没有 → 无终点语义', () => {
    const entity = build(foreshadow({}))

    expect(entity.spanEnd).toBeNull()
    expect(entity.spanEndKind).toBeNull()
  })

  it('中间节点（reinforce/reveal）不构成回收', () => {
    const entity = build(foreshadow({
      beats: [
        { chapter: 3, type: 'plant' },
        { chapter: 5, type: 'reinforce' },
        { chapter: 7, type: 'reveal' },
      ],
      recoverByChapter: 15,
    }))

    expect(entity.spanEndKind).toBe('planned')
    expect(entity.spanEnd).toBe(15)
    expect(entity.payoffChapter).toBeNull()
  })

  it('计划回收章早于最后节点时仍标为意图（数据异常但不能误判为事实）', () => {
    const entity = build(foreshadow({
      beats: [{ chapter: 3, type: 'plant' }, { chapter: 9, type: 'reinforce' }],
      recoverByChapter: 5,
    }))

    expect(entity.spanEndKind).toBe('planned')
    expect(entity.payoffChapter).toBeNull()
  })
})
