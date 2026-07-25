import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { shortcutsTour } from '../tours/shortcuts-tour'
import { useOnboardingStore, CURRENT_VERSION } from '../onboarding-store'

describe('shortcuts-tour 配置', () => {
  it('共 8 步', () => {
    expect(shortcutsTour.steps).toHaveLength(8)
  })

  it('id 为 shortcuts-tour', () => {
    expect(shortcutsTour.id).toBe('shortcuts-tour')
  })

  it('每步都有 shortcut 字段且为非空字符串', () => {
    for (const [i, step] of shortcutsTour.steps.entries()) {
      expect(step.shortcut, `步骤 ${i + 1} 必须有 shortcut`).toBeTruthy()
      expect(typeof step.shortcut).toBe('string')
    }
  })

  it('每步 side 均为 over（居中 popover）', () => {
    for (const step of shortcutsTour.steps) {
      expect(step.side).toBe('over')
    }
  })

  it('每步 element 留空（不绑定 DOM）', () => {
    for (const step of shortcutsTour.steps) {
      expect(step.element).toBeUndefined()
    }
  })

  it('快捷键文本格式合法（含 Ctrl 或 Cmd）', () => {
    for (const step of shortcutsTour.steps) {
      expect(step.shortcut).toMatch(/Ctrl|Cmd/)
    }
  })

  it('仅最后一步定义 onNext', () => {
    const lastIdx = shortcutsTour.steps.length - 1
    shortcutsTour.steps.forEach((step, i) => {
      if (i === lastIdx) {
        expect(step.onNext).toBeTypeOf('function')
      } else {
        expect(step.onNext).toBeUndefined()
      }
    })
  })
})

describe('shortcuts-tour 最后一步 onNext', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().resetOnboarding()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('调用 completeTour 写入 completedVersion', async () => {
    useOnboardingStore.getState().startTour('shortcuts-tour')
    const lastStep = shortcutsTour.steps[shortcutsTour.steps.length - 1]
    await lastStep.onNext?.()
    // 等动态 import 完成（onNext 内部用 dynamic import 调 store）
    await new Promise((r) => setTimeout(r, 10))
    expect(useOnboardingStore.getState().completedVersion).toBe(CURRENT_VERSION)
    expect(useOnboardingStore.getState().activeTour).toBeNull()
  })

  it('若 window.__onboardingSetView 存在，则切回 home', async () => {
    const setView = vi.fn()
    ;(window as unknown as { __onboardingSetView?: unknown }).__onboardingSetView = setView
    const lastStep = shortcutsTour.steps[shortcutsTour.steps.length - 1]
    await lastStep.onNext?.()
    // 等动态 import 完成
    await new Promise((r) => setTimeout(r, 10))
    expect(setView).toHaveBeenCalledWith('home')
    delete (window as unknown as { __onboardingSetView?: unknown }).__onboardingSetView
  })

  it('若 window.__onboardingSetView 不存在也不报错', async () => {
    const lastStep = shortcutsTour.steps[shortcutsTour.steps.length - 1]
    await lastStep.onNext?.()
    // 等动态 import 完成
    await new Promise((r) => setTimeout(r, 10))
    // 不抛异常即通过
    expect(true).toBe(true)
  })
})
