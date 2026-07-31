/**
 * 九类实体交互语义 + 图例
 *
 * 这两项收口的动因相同：同一语义散在多处，说法已经不一致。
 *
 * - 交互语义此前编码在**五处平行 switch**（GROUP_META / computeCellSymbol /
 *   emptyCellHint|presentCellHint / markLabel|removeLabel / markTooltip|removeTooltip），
 *   新增实体类型要改五处，漏一处就静默落到 default。
 * - 图例此前是手写常量，`★▲▼◆` 四个符号在实现里根本不存在。
 *
 * 用例重点覆盖「表必须穷尽九类」与「文案与实现一致」这两条 —— 前者是本次
 * 收口的核心收益（类型系统强制补全，不会像 switch 那样静默漏项）。
 */
import { describe, it, expect } from 'vitest'
import { GROUP_ORDER, GROUP_META, type MatrixEntityKind } from '../matrix-logic'
import {
  ENTITY_INTERACTION_SPEC,
  getInteractionSpec,
  resolveEmptyCellHint,
  resolvePresentCellHint,
  resolveMarkTooltip,
} from '../entity-interaction-spec'
import { LEGEND_ENTRIES, selectLegendEntries } from '../legend-spec'

describe('ENTITY_INTERACTION_SPEC：必须穷尽九类', () => {
  it('九类实体全部有规格 —— 这是收口的核心收益，替代五处 switch 的 default 静默兜底', () => {
    for (const kind of GROUP_ORDER) {
      expect(ENTITY_INTERACTION_SPEC[kind], `缺少 ${kind} 的交互规格`).toBeDefined()
    }
    expect(Object.keys(ENTITY_INTERACTION_SPEC).length).toBe(GROUP_ORDER.length)
  })

  it('每条规格的 kind 与其 key 一致', () => {
    for (const [key, spec] of Object.entries(ENTITY_INTERACTION_SPEC)) {
      expect(spec.kind).toBe(key)
    }
  })

  it('markable 的类型必须有 markLabel 与 emptyCellHint', () => {
    // 缺失会让右键菜单出现空按钮、空格悬浮无提示
    for (const spec of Object.values(ENTITY_INTERACTION_SPEC)) {
      if (!spec.markable) continue
      expect(spec.markLabel, `${spec.kind} 缺 markLabel`).not.toBe('')
      expect(spec.emptyCellHint, `${spec.kind} 缺 emptyCellHint`).not.toBe('')
    }
  })

  it('removable 的类型必须有 removeLabel', () => {
    for (const spec of Object.values(ENTITY_INTERACTION_SPEC)) {
      if (!spec.removable) continue
      expect(spec.removeLabel, `${spec.kind} 缺 removeLabel`).not.toBe('')
    }
  })

  it('不可标记的类型不给 label，但仍要给 tooltip 说明为什么不能', () => {
    // 原实现用「markLabel 返回空串」表达不可标记，调用方只能靠空串猜意图
    for (const spec of Object.values(ENTITY_INTERACTION_SPEC)) {
      if (spec.markable) continue
      expect(spec.markLabel).toBe('')
      expect(spec.markTooltip).not.toBe('')
    }
  })

  it('九类都有 presentCellHint —— 原实现里 character/faction/location 落到 default 返回空串', () => {
    for (const kind of GROUP_ORDER) {
      expect(ENTITY_INTERACTION_SPEC[kind].presentCellHint, `${kind} 的已占格提示为空`).not.toBe('')
    }
  })

  it('item 有专属语义 —— 它原本在全部五处 switch 里都落到 default', () => {
    const spec = getInteractionSpec('item')
    expect(spec.markLabel).not.toBe('标记出场')
    expect(spec.markLabel).toContain('本章')
    expect(spec.presentCellHint).not.toBe('')
  })

  it('world_element 与 info_layer 不可按章标记（存在范围不由章节决定）', () => {
    expect(getInteractionSpec('world_element').markable).toBe(false)
    expect(getInteractionSpec('info_layer').markable).toBe(false)
  })
})

describe('文案保持与原实现一致（不是趁收口偷偷改行为）', () => {
  const cases: Array<[MatrixEntityKind, string, string]> = [
    ['character', '标记本章出场', '删除本章出场'],
    ['conflict', '扩展到本章', '收缩端点'],
    ['faction', '扩展到本章', '收缩端点'],
    ['clue', '标记本章推进', '删除本章线索节点'],
    ['foreshadow', '添加伏笔节点', '删除本章伏笔节点'],
    ['location', '标记本章出场', '删除本章出场'],
  ]

  for (const [kind, markLabel, removeLabel] of cases) {
    it(`${kind} 的按钮文案不变`, () => {
      expect(getInteractionSpec(kind).markLabel).toBe(markLabel)
      expect(getInteractionSpec(kind).removeLabel).toBe(removeLabel)
    })
  }

  it('tooltip 仍说清落库副作用', () => {
    expect(getInteractionSpec('character').markTooltip).toContain('characterHistory')
    expect(getInteractionSpec('location').markTooltip).toContain('appearChapters')
    expect(getInteractionSpec('foreshadow').removeTooltip).toContain('整条事件链')
  })
})

describe('resolve* 查询函数', () => {
  it('冲突高潮覆盖类型默认值（原本硬编码在 presentCellHint 首行）', () => {
    expect(resolvePresentCellHint('conflict', 'conflict-climax')).toBe('冲突高潮')
    expect(resolvePresentCellHint('conflict', 'span-middle')).toBe('冲突进行中')
  })

  it('symbolType 缺省时取类型默认值', () => {
    expect(resolvePresentCellHint('clue')).toBe('线索发现/推进')
  })

  it('present=true 时标记 tooltip 改为说明原因（按钮此时被禁用）', () => {
    expect(resolveMarkTooltip('character', true)).toBe('该章已标记')
    expect(resolveMarkTooltip('character', false)).toContain('characterHistory')
  })

  it('不可标记的类型空格无提示（没有双击行为可说）', () => {
    expect(resolveEmptyCellHint('world_element')).toBe('')
    expect(resolveEmptyCellHint('info_layer')).toBe('')
  })

  it('可标记的类型空格提示以「双击」开头，与实际交互一致', () => {
    for (const spec of Object.values(ENTITY_INTERACTION_SPEC)) {
      if (!spec.markable) continue
      expect(resolveEmptyCellHint(spec.kind), `${spec.kind}`).toMatch(/^双击/)
    }
  })
})

describe('图例从实现派生', () => {
  it('不再出现实现里不存在的 ★▲▼◆ 符号', () => {
    // 这四个是原手写图例的主要错误来源
    const labels = LEGEND_ENTRIES.map((e) => `${e.shape}${e.label}`).join('')
    for (const bogus of ['★', '▲', '▼', '◆']) {
      expect(labels).not.toContain(bogus)
    }
  })

  it('颜色取自 GROUP_META，不再手写十六进制', () => {
    const locationEntry = LEGEND_ENTRIES.find((e) => e.id === 'location-present')
    expect(locationEntry?.color).toBe(GROUP_META.location.color)
  })

  it('地点是圆点而非菱形 —— 实现用 rounded-full', () => {
    expect(LEGEND_ENTRIES.find((e) => e.id === 'location-present')?.shape).toBe('dot')
  })

  it('配角「什么都不画」被显式列出 —— 否则用户以为空格等于未出场', () => {
    const entry = LEGEND_ENTRIES.find((e) => e.id === 'character-supporting')
    expect(entry?.shape).toBe('none')
    expect(entry?.note).toBeTruthy()
  })

  it('伏笔折叠态与子轨道态分层标注 —— 同一语义两套视觉必须说明', () => {
    const collapsed = LEGEND_ENTRIES.filter((e) => e.kind === 'foreshadow' && e.layer === 'collapsed')
    const subtrack = LEGEND_ENTRIES.filter((e) => e.kind === 'foreshadow' && e.layer === 'subtrack')

    expect(collapsed.length).toBeGreaterThan(0)
    // 四色只在子轨道生效
    expect(subtrack).toHaveLength(4)
  })

  it('未展开子轨道时不列四色 —— 折叠视图里找不到对应颜色', () => {
    const collapsedOnly = selectLegendEntries('collapsed')
    expect(collapsedOnly.some((e) => e.id === 'foreshadow-beat-reveal')).toBe(false)
  })

  it('跨类型项（播放头）在两个视图层都出现', () => {
    expect(selectLegendEntries('collapsed').some((e) => e.id === 'playhead')).toBe(true)
    expect(selectLegendEntries('subtrack').some((e) => e.id === 'playhead')).toBe(true)
  })

  it('每个 id 唯一（作为 React key）', () => {
    const ids = LEGEND_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('九类实体在折叠态图例里都有至少一项', () => {
    const covered = new Set(
      selectLegendEntries('collapsed').map((e) => e.kind).filter(Boolean),
    )
    for (const kind of GROUP_ORDER) {
      expect(covered.has(kind), `图例缺少 ${kind}`).toBe(true)
    }
  })
})
