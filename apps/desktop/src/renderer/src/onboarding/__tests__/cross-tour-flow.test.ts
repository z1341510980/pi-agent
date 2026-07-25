import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useOnboardingStore } from '../onboarding-store'
import { tours } from '../tours'
import type { TourId } from '../types'

/**
 * 跨 tour 流程链路测试。
 *
 * 验证：home → novel → chat → settings → shortcuts → home 的衔接。
 * 每个 tour 最后一步的 onNext 应该：
 *   1. 调用 window.__onboardingSetView 切换到下一个 tour 所在的 view
 *   2. 通过动态 import 启动下一个 tour
 *
 * 用真实定时器：tour 用 500ms setTimeout + 动态 import，
 * 测试中等待 600ms 即可触发完成。
 */
describe('跨 tour 链路', () => {
  const expectedChain: Array<{
    from: TourId
    to: TourId
    view: 'home' | 'chat' | 'novel' | 'settings'
  }> = [
    { from: 'home-tour', to: 'novel-tour', view: 'novel' },
    { from: 'novel-tour', to: 'chat-tour', view: 'chat' },
    { from: 'chat-tour', to: 'settings-tour', view: 'settings' },
    { from: 'settings-tour', to: 'shortcuts-tour', view: 'home' },
  ]

  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().resetOnboarding()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(expectedChain)(
    '$from 最后一步 onNext 切换到 $view 并启动 $to',
    async ({ from, to, view }) => {
      const tour = tours[from]
      const lastStep = tour.steps[tour.steps.length - 1]
      expect(lastStep.onNext, `${from} 最后一步必须有 onNext`).toBeTypeOf('function')

      const setView = vi.fn()
      ;(window as unknown as { __onboardingSetView?: unknown }).__onboardingSetView = setView

      useOnboardingStore.getState().startTour(from)
      expect(useOnboardingStore.getState().activeTour).toBe(from)

      lastStep.onNext?.()

      // tour 用 500ms setTimeout + 动态 import；等 600ms 让链路完成
      await new Promise((r) => setTimeout(r, 600))

      expect(setView).toHaveBeenCalledWith(view)
      expect(useOnboardingStore.getState().activeTour).toBe(to)

      delete (window as unknown as { __onboardingSetView?: unknown }).__onboardingSetView
    },
  )

  it('shortcuts-tour 最后一步 onNext 完成 tour 并回到 home view', async () => {
    const setView = vi.fn()
    ;(window as unknown as { __onboardingSetView?: unknown }).__onboardingSetView = setView

    useOnboardingStore.getState().startTour('shortcuts-tour')
    const tour = tours['shortcuts-tour']
    const lastStep = tour.steps[tour.steps.length - 1]

    await lastStep.onNext?.()
    // shortcuts-tour 的 onNext 仅用动态 import（无 setTimeout）
    await new Promise((r) => setTimeout(r, 10))

    expect(setView).toHaveBeenCalledWith('home')
    expect(useOnboardingStore.getState().completedVersion).not.toBeNull()
    expect(useOnboardingStore.getState().activeTour).toBeNull()

    delete (window as unknown as { __onboardingSetView?: unknown }).__onboardingSetView
  })
})

