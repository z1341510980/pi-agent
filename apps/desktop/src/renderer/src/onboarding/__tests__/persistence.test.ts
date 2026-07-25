import { describe, it, expect, beforeEach } from 'vitest'
import { useOnboardingStore, CURRENT_VERSION, STORAGE_KEY } from '../onboarding-store'

describe('onboarding persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().resetOnboarding()
  })

  it('completeTour 后 localStorage 写入 completedVersion', () => {
    useOnboardingStore.getState().completeTour()
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!).state
    expect(parsed.completedVersion).toBe(CURRENT_VERSION)
  })

  it('skipTour 后 localStorage 写入 skippedTours', () => {
    useOnboardingStore.getState().skipTour('novel-tour')
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = JSON.parse(raw!).state
    expect(parsed.skippedTours).toContain('novel-tour')
  })

  it('resetOnboarding 清除 localStorage 持久化字段', () => {
    useOnboardingStore.getState().completeTour()
    useOnboardingStore.getState().skipTour('novel-tour')
    useOnboardingStore.getState().resetOnboarding()
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = JSON.parse(raw!).state
    expect(parsed.completedVersion).toBeNull()
    expect(parsed.skippedTours).toEqual([])
  })

  it('activeTour 和 stepIndex 不被持久化', () => {
    useOnboardingStore.getState().startTour('novel-tour')
    useOnboardingStore.getState().nextStep()
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = JSON.parse(raw!).state
    expect(parsed.activeTour).toBeUndefined()
    expect(parsed.stepIndex).toBeUndefined()
  })
})
