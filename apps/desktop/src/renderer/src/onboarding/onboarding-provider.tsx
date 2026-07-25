import type { ReactElement, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import type { Driver, Side } from 'driver.js'
import { useOnboardingStore } from './onboarding-store'
import { tours } from './tours'
import { driverTheme } from './driver-theme'
import type { TourStep } from './types'

/**
 * 懒加载 driver.js：仅 type 静态导入（编译期擦除，不进 bundle），
 * 运行时 dynamic import 在首次启动引导时才加载 driver.js + CSS。
 * 这样首屏不会被打包进 driver.js（~30KB gzipped），改善启动性能。
 */
async function loadDriver(): Promise<typeof import('driver.js')['driver']> {
  // 并行加载 JS + CSS
  const [mod] = await Promise.all([
    import('driver.js'),
    import('driver.js/dist/driver.css'),
  ])
  return mod.driver
}

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
 * 构造 popover 描述 HTML。
 * - 无 shortcut 时：返回纯文本 description（driver.js 1.8.0 在 allowHTML=true 下也能正确渲染纯文本）
 * - 有 shortcut 时：拼接 description + <kbd class="pi-driver-kbd">{shortcut}</kbd>
 *
 * HTML 转义：description 来自项目内部静态配置，非用户输入，安全可控，无需转义。
 * shortcut 同理。
 */
function buildDescriptionHTML(step: TourStep): string {
  if (!step.shortcut) {
    return step.description
  }
  return `${step.description}<div class="pi-driver-kbd-row"><kbd class="pi-driver-kbd">${step.shortcut}</kbd></div>`
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
  const driverRef = useRef<Driver | null>(null)

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

    // 标记本次 effect 是否被取消（activeTour 快速切换或组件卸载时为 true），
    // 用于放弃已经发起但尚未完成的 driver.js dynamic import。
    let cancelled = false

    const startDriver = async () => {
      let driverInstance: Driver | null = null
      try {
        const driverFn = await loadDriver()
        // 卸载或 activeTour 已切换 → 放弃这次加载
        if (cancelled) return
        driverInstance = driverFn({
          ...driverTheme,
          // driver.js 1.8.0 默认通过 innerHTML 设置 description，
          // 因此可直接在 description 中嵌入 HTML（kbd 元素等）。
          // 所有 description 来自项目静态配置，非用户输入，安全可控。
          steps: tour.steps.map((s) => ({
            element: s.element,
            popover: {
              title: s.title,
              description: buildDescriptionHTML(s),
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
              driverInstance?.destroy()
              driverRef.current = null
            } else {
              useOnboardingStore.getState().nextStep()
              driverInstance?.moveNext()
            }
          },
          onPrevClick: () => {
            const state = useOnboardingStore.getState()
            const currentStep = tour.steps[state.stepIndex]
            currentStep?.onPrev?.()
            const prevIndex = Math.max(0, state.stepIndex - 1)
            useOnboardingStore.getState().goToStep(prevIndex)
            driverInstance?.movePrevious()
          },
          onCloseClick: () => {
            useOnboardingStore.getState().skipTour(activeTour)
            driverInstance?.destroy()
            driverRef.current = null
          },
        })
        if (cancelled) {
          driverInstance.destroy()
          return
        }
        driverRef.current = driverInstance
        driverInstance.drive()
      } catch (err) {
        console.error('[onboarding] 加载 driver.js 失败：', err)
      }
    }

    const onStartResult = tour.onStart?.()
    const onStartPromise =
      onStartResult instanceof Promise ? onStartResult : Promise.resolve()
    onStartPromise.then(() => startDriver())

    return () => {
      cancelled = true
      if (driverRef.current) {
        driverRef.current.destroy()
        driverRef.current = null
      }
    }
  }, [activeTour])

  return <>{children}</>
}
