import type { ReactElement, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { driver, type Side } from 'driver.js'
import 'driver.js/dist/driver.css'
import { useOnboardingStore } from './onboarding-store'
import { tours } from './tours'
import { driverTheme } from './driver-theme'
import type { TourStep } from './types'

interface OnboardingProviderProps {
  children: ReactNode
  setView?: (view: 'home' | 'chat' | 'novel' | 'settings') => void
}

/**
 * 把 TourStep.side 映射到 driver.js 1.8.0 的 Side 类型。
 * driver.js 的 Side 仅支持 'top' | 'right' | 'bottom' | 'left'，
 * TourStep 扩展了 'over' | 'auto'（业务语义），映射为 undefined 让 driver 走默认值。
 */
function toDriverSide(side: TourStep['side']): Side | undefined {
  if (side === 'top' || side === 'bottom' || side === 'left' || side === 'right') {
    return side
  }
  return undefined
}

/**
 * OnboardingProvider：负责根据 store 中的 activeTour 启动/销毁 driver.js 实例。
 *
 * 关键设计（基于 driver.js 1.8.0 源码确认）：
 * 1. 只在 activeTour 变化时启动/销毁 driver，stepIndex 变化不重建 driver
 *    （driver 内部维护 activeIndex，store 的 stepIndex 仅作记录同步）。
 * 2. driver.js 1.8.0 中，配置了 onNextClick/onPrevClick/onCloseClick 后，
 *    driver 不会自动导航/关闭，必须在回调里手动调用 moveNext/movePrevious/destroy。
 */
export function OnboardingProvider({
  children,
  setView,
}: OnboardingProviderProps): ReactElement {
  const activeTour = useOnboardingStore((s) => s.activeTour)
  const driverRef = useRef<ReturnType<typeof driver> | null>(null)

  // 暴露 setView 到 window，供 tour 步骤回调（onNext 等）切换视图
  useEffect(() => {
    ;(window as unknown as {
      __onboardingSetView?: (view: 'home' | 'chat' | 'novel' | 'settings') => void
    }).__onboardingSetView = setView
    return () => {
      delete (window as unknown as {
        __onboardingSetView?: (view: 'home' | 'chat' | 'novel' | 'settings') => void
      }).__onboardingSetView
    }
  }, [setView])

  // 仅在 activeTour 变化时启动/销毁 driver
  useEffect(() => {
    if (!activeTour) {
      if (driverRef.current) {
        driverRef.current.destroy()
        driverRef.current = null
      }
      return
    }

    const tour = tours[activeTour]
    if (!tour) {
      console.warn(`[onboarding] 未找到 tour: ${activeTour}`)
      return
    }

    // 空步骤 tour：直接标记完成，避免 drive() 立即 destroy 后状态残留
    if (tour.steps.length === 0) {
      console.info(`[onboarding] tour ${activeTour} 暂无步骤，跳过`)
      return
    }

    const startDriver = () => {
      const driverInstance = driver({
        ...driverTheme,
        steps: tour.steps.map((s) => ({
          element: s.element,
          popover: {
            title: s.title,
            description: s.description,
            side: toDriverSide(s.side) ?? 'bottom',
          },
        })),
        onNextClick: () => {
          const state = useOnboardingStore.getState()
          const currentStep = tour.steps[state.stepIndex]
          currentStep?.onNext?.()
          const nextIndex = state.stepIndex + 1
          if (nextIndex >= tour.steps.length) {
            tour.onComplete?.()
            useOnboardingStore.getState().completeTour()
            driverInstance.destroy()
            driverRef.current = null
          } else {
            useOnboardingStore.getState().nextStep()
            driverInstance.moveNext()
          }
        },
        onPrevClick: () => {
          const state = useOnboardingStore.getState()
          const currentStep = tour.steps[state.stepIndex]
          currentStep?.onPrev?.()
          const prevIndex = Math.max(0, state.stepIndex - 1)
          useOnboardingStore.getState().goToStep(prevIndex)
          driverInstance.movePrevious()
        },
        onCloseClick: () => {
          useOnboardingStore.getState().skipTour(activeTour)
          driverInstance.destroy()
          driverRef.current = null
        },
      })
      driverRef.current = driverInstance
      driverInstance.drive()
    }

    const onStartResult = tour.onStart?.()
    if (onStartResult instanceof Promise) {
      onStartResult.then(startDriver)
    } else {
      startDriver()
    }

    return () => {
      if (driverRef.current) {
        driverRef.current.destroy()
        driverRef.current = null
      }
    }
  }, [activeTour])

  return <>{children}</>
}
