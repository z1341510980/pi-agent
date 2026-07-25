import { useOnboardingStore } from './onboarding-store'
import type { TourId } from './types'

export function useOnboarding() {
  const store = useOnboardingStore()
  return {
    activeTour: store.activeTour,
    stepIndex: store.stepIndex,
    isCompleted: store.isCompleted(),
    startTour: (tourId: TourId) => store.startTour(tourId),
    skipTour: (tourId: TourId) => store.skipTour(tourId),
    reset: () => store.resetOnboarding(),
  }
}
