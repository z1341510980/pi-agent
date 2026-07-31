/**
 * 保存契约
 *
 * 同屏内此前有四种互不相同的保存行为，后果不是"不统一"，而是**用户无法预测
 * 自己的编辑会不会丢**：同一个角色，矩阵里拖一下立刻入库，右栏改名字不点按钮就丢；
 * 大纲字段自动保存但失败时只 `console.error`，用户以为存上了。
 *
 * 用例重点在两条：
 *   1. 同一个 `dirty` 在三类契约下措辞必须不同（autosave 是"马上会存"，
 *      explicit 是"不点会丢"）—— 用同一句话说这两件事正是原实现让人搞不清的根源
 *   2. `error` 必须给出可见原因 —— 静默失败是原实现最大的缺口
 */
import { describe, it, expect } from 'vitest'
import {
  describeSaveState,
  needsFlushBeforeLeaving,
  shouldBlockLeaving,
  AUTOSAVE_DEBOUNCE_MS,
  SAVE_CONTRACT_DESCRIPTION,
} from '../save-contract'

describe('describeSaveState：同一状态在不同契约下措辞不同', () => {
  it('autosave 的 dirty 说"会自动保存"', () => {
    const s = describeSaveState('autosave', 'dirty')
    expect(s.tone).toBe('pending')
    expect(s.hint).toContain('自动保存')
  })

  it('explicit 的 dirty 必须说清"不点就会丢"', () => {
    // 这是关键差异：同屏的正文与大纲都自动保存，用户会默认表单也一样
    const s = describeSaveState('explicit', 'dirty')
    expect(s.hint).toContain('丢失')
    expect(s.hint).not.toContain('自动')
  })

  it('immediate 没有中间态', () => {
    expect(describeSaveState('immediate', 'dirty').label).toBe('已保存')
    expect(describeSaveState('immediate', 'saved').label).toBe('已保存')
  })

  it('saved 三类契约一致（稳态无需区分）', () => {
    for (const c of ['autosave', 'explicit', 'immediate'] as const) {
      expect(describeSaveState(c, 'saved')).toMatchObject({ label: '已保存', tone: 'success' })
    }
  })

  it('saving 三类契约一致', () => {
    for (const c of ['autosave', 'explicit', 'immediate'] as const) {
      expect(describeSaveState(c, 'saving')).toMatchObject({ label: '保存中…', tone: 'pending' })
    }
  })
})

describe('describeSaveState：错误必须可见', () => {
  it('带上具体原因', () => {
    const s = describeSaveState('autosave', 'error', 'HTTP 500')
    expect(s.tone).toBe('danger')
    expect(s.hint).toBe('HTTP 500')
  })

  it('无原因时给出兜底提示而非空白', () => {
    // 静默失败是原实现最大的问题，兜底文案不能为空
    const s = describeSaveState('autosave', 'error')
    expect(s.hint).toBeTruthy()
    expect(s.hint).toContain('丢失')
  })

  it('三类契约的错误措辞一致（失败就是失败）', () => {
    for (const c of ['autosave', 'explicit', 'immediate'] as const) {
      expect(describeSaveState(c, 'error').tone).toBe('danger')
    }
  })
})

describe('离开编辑目标时的行为', () => {
  it('autosave 有未保存改动时必须 flush', () => {
    // 否则防抖窗口内的改动随组件卸载消失 ——「显示已保存但其实没入库」的来源
    expect(needsFlushBeforeLeaving('autosave', 'dirty')).toBe(true)
  })

  it('autosave 无改动时无需 flush', () => {
    expect(needsFlushBeforeLeaving('autosave', 'saved')).toBe(false)
  })

  it('explicit 不自动落库（那会违背"必须确认"的语义）', () => {
    expect(needsFlushBeforeLeaving('explicit', 'dirty')).toBe(false)
  })

  it('explicit 有未保存改动时应拦下确认', () => {
    expect(shouldBlockLeaving('explicit', 'dirty')).toBe(true)
  })

  it('autosave 不拦（它会自己存）', () => {
    expect(shouldBlockLeaving('autosave', 'dirty')).toBe(false)
  })

  it('immediate 既不 flush 也不拦', () => {
    expect(needsFlushBeforeLeaving('immediate', 'dirty')).toBe(false)
    expect(shouldBlockLeaving('immediate', 'dirty')).toBe(false)
  })
})

describe('常量', () => {
  it('防抖延迟与正文编辑器/大纲字段原值一致，不改变既有行为', () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(1500)
  })

  it('三类契约都有面向用户的说明', () => {
    for (const c of ['autosave', 'explicit', 'immediate'] as const) {
      expect(SAVE_CONTRACT_DESCRIPTION[c]).toBeTruthy()
    }
  })

  it('explicit 的说明点明会丢失', () => {
    expect(SAVE_CONTRACT_DESCRIPTION.explicit).toContain('丢失')
  })
})
