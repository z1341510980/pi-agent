export interface TourStep {
  /** CSS selector 定位目标元素，留空则居中展示 */
  element?: string
  title?: string
  description: string
  /** 可选快捷键展示（用于 shortcuts-tour），传入会以 <kbd> 渲染 */
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right' | 'over' | 'auto'
  view?: 'home' | 'chat' | 'novel' | 'settings'
  onNext?: () => void
  onPrev?: () => void
}

export interface Tour {
  id: TourId
  steps: TourStep[]
  onStart?: () => void | Promise<void>
  onComplete?: () => void
}

export type TourId = 'home-tour' | 'novel-tour' | 'chat-tour' | 'settings-tour' | 'shortcuts-tour'

export interface OnboardingPersistedState {
  completedVersion: string | null
  skippedTours: TourId[]
  lastSeenAt: number
}
