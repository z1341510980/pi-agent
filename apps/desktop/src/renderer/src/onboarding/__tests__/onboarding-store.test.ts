import { describe, it, expect, beforeEach } from 'vitest'
import { useOnboardingStore, CURRENT_VERSION } from '../onboarding-store'

describe('onboarding-store', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().resetOnboarding()
  })

  it('初始状态：无活跃 tour，stepIndex 为 0，completedVersion 为 null', () => {
    const state = useOnboardingStore.getState()
    expect(state.activeTour).toBeNull()
    expect(state.stepIndex).toBe(0)
    expect(state.completedVersion).toBeNull()
    expect(state.skippedTours).toEqual([])
  })

  it('startTour 设置 activeTour', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    expect(useOnboardingStore.getState().activeTour).toBe('novel-tour')
    expect(useOnboardingStore.getState().stepIndex).toBe(0)
  })

  it('nextStep 递增 stepIndex', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    useOnboardingStore.getState().nextStep()
    expect(useOnboardingStore.getState().stepIndex).toBe(1)
  })

  it('prevStep 递减 stepIndex，不小于 0', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    useOnboardingStore.getState().nextStep()
    useOnboardingStore.getState().nextStep()
    useOnboardingStore.getState().prevStep()
    expect(useOnboardingStore.getState().stepIndex).toBe(1)
    useOnboardingStore.getState().prevStep()
    expect(useOnboardingStore.getState().stepIndex).toBe(0)
    useOnboardingStore.getState().prevStep()
    expect(useOnboardingStore.getState().stepIndex).toBe(0)
  })

  it('skipTour 写入 skippedTours 并清除 activeTour', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    useOnboardingStore.getState().skipTour('novel-tour')
    const state = useOnboardingStore.getState()
    expect(state.activeTour).toBeNull()
    expect(state.skippedTours).toContain('novel-tour')
  })

  it('skipTour 幂等，重复跳过不重复添加', () => {
    useOnboardingStore.getState().skipTour('novel-tour')
    useOnboardingStore.getState().skipTour('novel-tour')
    expect(useOnboardingStore.getState().skippedTours.filter((t) => t === 'novel-tour')).toHaveLength(1)
  })

  it('completeTour 写入 completedVersion 并清除 activeTour', () => {
    useOnboardingStore.getState().startTour('shortcuts-tour')
    useOnboardingStore.getState().completeTour()
    const state = useOnboardingStore.getState()
    expect(state.activeTour).toBeNull()
    expect(state.completedVersion).toBe(CURRENT_VERSION)
    expect(state.lastSeenAt).toBeGreaterThan(0)
  })

  it('resetOnboarding 清除 completedVersion 与 skippedTours', () => {
    useOnboardingStore.getState().completeTour()
    useOnboardingStore.getState().skipTour('novel-tour')
    useOnboardingStore.getState().resetOnboarding()
    const state = useOnboardingStore.getState()
    expect(state.completedVersion).toBeNull()
    expect(state.skippedTours).toEqual([])
    expect(state.activeTour).toBeNull()
  })

  it('isCompleted 返回 completedVersion 是否匹配当前版本', () => {
    expect(useOnboardingStore.getState().isCompleted()).toBe(false)
    useOnboardingStore.getState().completeTour()
    expect(useOnboardingStore.getState().isCompleted()).toBe(true)
  })

  it('shouldAutoStart 返回 true 当未完成且未跳过 home-tour', () => {
    expect(useOnboardingStore.getState().shouldAutoStart()).toBe(true)
    useOnboardingStore.getState().skipTour('home-tour')
    expect(useOnboardingStore.getState().shouldAutoStart()).toBe(false)
  })
})
