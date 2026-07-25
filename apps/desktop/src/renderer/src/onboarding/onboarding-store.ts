import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { OnboardingPersistedState, TourId } from './types'

export const CURRENT_VERSION = 'v1'
export const STORAGE_KEY = 'pi-agent.onboarding'

interface OnboardingState extends OnboardingPersistedState {
  activeTour: TourId | null
  stepIndex: number
  startTour: (tourId: TourId) => void
  nextStep: () => void
  prevStep: () => void
  goToStep: (index: number) => void
  skipTour: (tourId: TourId) => void
  completeTour: () => void
  resetOnboarding: () => void
  isCompleted: () => boolean
  shouldAutoStart: () => boolean
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      completedVersion: null,
      skippedTours: [],
      lastSeenAt: 0,
      activeTour: null,
      stepIndex: 0,

      startTour: (tourId) => {
        if (get().activeTour && get().activeTour !== tourId) {
          console.warn(`[onboarding] 已有 tour ${get().activeTour} 运行中，被 ${tourId} 覆盖`)
        }
        set({ activeTour: tourId, stepIndex: 0, lastSeenAt: Date.now() })
      },

      nextStep: () => set((s) => ({ stepIndex: s.stepIndex + 1 })),

      prevStep: () => set((s) => ({ stepIndex: Math.max(0, s.stepIndex - 1) })),

      goToStep: (index) => set({ stepIndex: Math.max(0, index) }),

      skipTour: (tourId) =>
        set((s) => ({
          activeTour: null,
          skippedTours: s.skippedTours.includes(tourId) ? s.skippedTours : [...s.skippedTours, tourId],
          lastSeenAt: Date.now(),
        })),

      completeTour: () =>
        set({
          activeTour: null,
          completedVersion: CURRENT_VERSION,
          lastSeenAt: Date.now(),
        }),

      resetOnboarding: () =>
        set({
          activeTour: null,
          stepIndex: 0,
          completedVersion: null,
          skippedTours: [],
          lastSeenAt: 0,
        }),

      isCompleted: () => get().completedVersion === CURRENT_VERSION,

      shouldAutoStart: () =>
        !get().isCompleted() && !get().skippedTours.includes('home-tour'),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        completedVersion: s.completedVersion,
        skippedTours: s.skippedTours,
        lastSeenAt: s.lastSeenAt,
      }),
    }
  )
)
