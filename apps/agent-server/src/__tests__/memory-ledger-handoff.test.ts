/**
 * Memory 的账本承接段
 *
 * ## 为什么需要这段
 *
 * Memory 此前只拿到实体的**当前值**（`getCurrentEntityState`），看不到这个值是
 * 第几章、因为什么变成这样的。于是它每章都在从零重新判断「这个角色现在算什么状态」，
 * 而不是在已有轨迹上做差分 —— 实测 20.2k input 只换回 1.8k output。
 *
 * ## 一处对方案文档的修正
 *
 * 文档写「memory 拿不到账本承接**与本章编排实体**」。核查后后半句不成立：
 * `getCurrentEntityState` 早已按 `arrangedEntities` 过滤，编排实体的
 * currentState/currentGoal/currentPressure 都注入了。真正缺的只有账本这一侧。
 *
 * ## 用例重点
 *
 * 1. 章前状态与本章计划变更都要出现，且措辞必须是「找变化」而不是「判断状态」
 * 2. 显示名必须来自调用方 —— plannedChanges 是裸 NovelChangeRecord，没有 name 字段，
 *    缺名字会退化成「（未命名实体）」，那段承接对 LLM 就失去意义
 * 3. 按 arrangedEntities 过滤，否则无关角色会把上下文挤满
 */
import { describe, it, expect } from 'vitest'
import {
  buildMemoryLedgerHandoff,
  MEMORY_LEDGER_BUDGET,
} from '../plugins/novel-plugin/core/memory-ledger-handoff.js'
import type { ChapterStoryContext } from '../plugins/novel-plugin/core/types.js'

type PriorState = ChapterStoryContext['stateBeforeChapter'][number]
type PlannedChange = ChapterStoryContext['plannedChanges'][number]

function state(partial: Partial<PriorState> = {}): PriorState {
  return {
    subjectType: 'character' as const,
    subjectId: 'c1',
    dimension: 'character.state',
    targetType: null,
    targetId: null,
    value: '警惕但仍留在队里',
    valueType: 'text' as const,
    effectiveChapter: 9,
    effectiveSceneOrder: 0,
    sourceChangeId: 'ch-1',
    reason: '',
    ...partial,
  }
}

function change(partial: Record<string, unknown> = {}): PlannedChange {
  return {
    id: 'r1',
    projectId: 'p1',
    storyEventId: null,
    chapterNumber: 10,
    sceneOrder: 0,
    subjectType: 'character' as const,
    subjectId: 'c1',
    dimension: 'character.goal',
    targetType: null,
    targetId: null,
    valueType: 'text' as const,
    beforeValue: null,
    afterValue: '主动交出节点坐标',
    reason: '被迫在两难中选边',
    significance: 3,
    source: 'plan' as const,
    cause: null,
    effectIds: [],
    createdAt: 0,
    ...partial,
  } as unknown as PlannedChange
}

function context(partial: Partial<ChapterStoryContext> = {}): ChapterStoryContext {
  return {
    projectId: 'p1',
    chapterNumber: 10,
    snapshotVersion: 1,
    stateBeforeChapter: [],
    activeThreads: [],
    plannedEvents: [],
    plannedChanges: [],
    unresolvedDebts: [],
    futureCommitments: [],
    promptDimensions: [],
    annotations: [],
    continuityWarnings: [],
    ...partial,
  }
}

const NAMES = new Map([['c1', '叶明远'], ['c2', '林霜'], ['f1', '第七处节点']])

describe('buildMemoryLedgerHandoff：章前状态承接', () => {
  it('输出章前状态，并明确要求「找变化」而不是「重新判断」', () => {
    const out = buildMemoryLedgerHandoff(
      context({ stateBeforeChapter: [state()] }),
      { names: NAMES },
    )

    expect(out).toContain('章前状态承接')
    expect(out).toContain('叶明远')
    expect(out).toContain('警惕但仍留在队里')
    expect(out).toContain('第 9 章确立')
    // 这句是本项的核心意图：把任务从「判断现状」改成「做差分」
    expect(out).toContain('找出本章正文让哪些条目发生了变化')
    expect(out).toContain('不必再输出')
  })

  it('维度译成中文标签，与 prompt-builder 的表一致', () => {
    const out = buildMemoryLedgerHandoff(
      context({
        stateBeforeChapter: [
          state({ dimension: 'character.pressure', value: '被上级怀疑' }),
          state({ subjectId: 'f1', subjectType: 'foreshadow', dimension: 'foreshadow.beat', value: 'reinforce' }),
        ],
      }),
      { names: NAMES },
    )

    expect(out).toContain('压力＝')
    expect(out).toContain('伏笔动作＝')
  })

  it('按生效章倒序：越近的变化对判断本章差分越有用', () => {
    const out = buildMemoryLedgerHandoff(
      context({
        stateBeforeChapter: [
          state({ subjectId: 'c1', effectiveChapter: 3, value: '早期状态' }),
          state({ subjectId: 'c2', effectiveChapter: 9, value: '近期状态' }),
        ],
      }),
      { names: NAMES },
    )

    expect(out.indexOf('近期状态')).toBeLessThan(out.indexOf('早期状态'))
  })

  it('创建类维度不是状态推进，排除', () => {
    const out = buildMemoryLedgerHandoff(
      context({ stateBeforeChapter: [state({ dimension: 'character.created' })] }),
      { names: NAMES },
    )
    expect(out).toBe('')
  })

  it('条数受预算限制', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      state({ subjectId: `c${i}`, effectiveChapter: i + 1 }),
    )
    const out = buildMemoryLedgerHandoff(context({ stateBeforeChapter: many }), { names: NAMES })
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(MEMORY_LEDGER_BUDGET.stateCount)
  })

  it('关系类维度带上目标实体名', () => {
    const out = buildMemoryLedgerHandoff(
      context({
        stateBeforeChapter: [state({
          subjectType: 'relationship',
          dimension: 'relationship.stage',
          targetType: 'character',
          targetId: 'c2',
          value: '互相试探',
        })],
      }),
      { names: NAMES },
    )
    expect(out).toContain('叶明远与林霜')
  })
})

describe('buildMemoryLedgerHandoff：本章计划变更', () => {
  it('列出计划变更并要求逐条核对，禁止凭计划补写', () => {
    const out = buildMemoryLedgerHandoff(
      context({ plannedChanges: [change()] }),
      { names: NAMES },
    )

    expect(out).toContain('本章计划变更')
    expect(out).toContain('目标应变为')
    expect(out).toContain('主动交出节点坐标')
    expect(out).toContain('缘由：被迫在两难中选边')
    // 关键约束：计划不等于事实
    expect(out).toContain('没发生就不要凭计划补写')
  })

  it('显示名必须来自调用方 —— plannedChanges 本身没有 name 字段', () => {
    const withoutNames = buildMemoryLedgerHandoff(context({ plannedChanges: [change()] }))
    expect(withoutNames).toContain('（未命名实体）')

    const withNames = buildMemoryLedgerHandoff(
      context({ plannedChanges: [change()] }),
      { names: NAMES },
    )
    expect(withNames).toContain('叶明远')
    expect(withNames).not.toContain('（未命名实体）')
  })

  it('不在提示词里暴露 UUID', () => {
    const out = buildMemoryLedgerHandoff(
      context({ stateBeforeChapter: [state()], plannedChanges: [change()] }),
      { names: NAMES },
    )
    expect(out).not.toContain('c1')
  })
})

describe('buildMemoryLedgerHandoff：编排范围过滤', () => {
  it('只保留本章编排实体，无关角色不挤占上下文', () => {
    const out = buildMemoryLedgerHandoff(
      context({
        stateBeforeChapter: [state({ subjectId: 'c1' }), state({ subjectId: 'c2', value: '无关角色状态' })],
      }),
      { scope: { entityIds: new Set(['c1']) }, names: NAMES },
    )

    expect(out).toContain('叶明远')
    expect(out).not.toContain('无关角色状态')
  })

  it('scope 为空集时不过滤（无编排信息时保留全部）', () => {
    const out = buildMemoryLedgerHandoff(
      context({ stateBeforeChapter: [state({ subjectId: 'c2' })] }),
      { scope: { entityIds: new Set() }, names: NAMES },
    )
    expect(out).toContain('林霜')
  })

  it('计划变更同样受 scope 约束', () => {
    const out = buildMemoryLedgerHandoff(
      context({ plannedChanges: [change({ subjectId: 'c2' })] }),
      { scope: { entityIds: new Set(['c1']) }, names: NAMES },
    )
    expect(out).toBe('')
  })
})

describe('buildMemoryLedgerHandoff：连续性告警', () => {
  it('账本自身发现的前后值不接续摆到 Memory 面前 —— 往往正是它上次写错的', () => {
    const out = buildMemoryLedgerHandoff(
      context({ continuityWarnings: ['character.state 在第 8 章的前值与上一状态不一致'] }),
      { names: NAMES },
    )
    expect(out).toContain('账本连续性告警')
    expect(out).toContain('第 8 章')
  })

  it('告警条数有上限，不淹没正文', () => {
    const warnings = Array.from({ length: 20 }, (_, i) => `告警 ${i}`)
    const out = buildMemoryLedgerHandoff(context({ continuityWarnings: warnings }), { names: NAMES })
    expect(out.split('\n').filter((l) => l.startsWith('- 告警'))).toHaveLength(4)
  })
})

describe('buildMemoryLedgerHandoff：退化与边界', () => {
  it('账本全空时返回空串，不产生空标题', () => {
    expect(buildMemoryLedgerHandoff(context())).toBe('')
  })

  it('对象型值取有内容的字段，不输出 JSON', () => {
    const out = buildMemoryLedgerHandoff(
      context({
        stateBeforeChapter: [state({
          value: { currentState: '负伤', currentGoal: '撤离', irrelevant: 'x' },
        })],
      }),
      { names: NAMES },
    )
    expect(out).toContain('状态：负伤')
    expect(out).toContain('目标：撤离')
    expect(out).not.toContain('irrelevant')
  })

  it('超长值被截断', () => {
    const long = '很'.repeat(300)
    const out = buildMemoryLedgerHandoff(
      context({ stateBeforeChapter: [state({ value: long })] }),
      { names: NAMES },
    )
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(long.length)
  })

  it('空值输出占位而非空白', () => {
    const out = buildMemoryLedgerHandoff(
      context({ stateBeforeChapter: [state({ value: '' })] }),
      { names: NAMES },
    )
    expect(out).toContain('（空）')
  })

  it('未知维度回落到「状态」而不是暴露原始标识', () => {
    const out = buildMemoryLedgerHandoff(
      context({ stateBeforeChapter: [state({ dimension: 'character.brand_new_dimension' })] }),
      { names: NAMES },
    )
    expect(out).toContain('状态＝')
    expect(out).not.toContain('brand_new_dimension')
  })
})
