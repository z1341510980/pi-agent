import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { useAutoScroll } from '../use-auto-scroll'

/**
 * jsdom 没有布局，`scrollHeight` / `clientHeight` 恒为 0，`scrollTop` 的原生
 * setter 也会被钳成 0。所以这些属性都用 `defineProperty` 覆盖成普通可写属性，
 * 由用例自己扮演布局。ResizeObserver 换成可手动触发的假实现。
 */

type Callback = () => void

let observers: Callback[] = []

class ControllableResizeObserver {
  constructor(private readonly callback: Callback) {
    observers.push(this.callback)
  }
  // 观察目标无关紧要：用例通过 fireResize 直接驱动回调
  observe(): void {
    /* noop */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    observers = observers.filter((cb) => cb !== this.callback)
  }
}

/** 触发所有 ResizeObserver 回调（模拟内容长高） */
function fireResize(): void {
  act(() => {
    for (const cb of [...observers]) cb()
  })
}

/** 把元素的滚动几何变成可写普通属性 */
function stubGeometry(
  el: HTMLElement,
  geo: { scrollHeight: number; clientHeight: number; scrollTop: number },
): void {
  Object.defineProperty(el, 'scrollHeight', { value: geo.scrollHeight, writable: true, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: geo.clientHeight, writable: true, configurable: true })
  Object.defineProperty(el, 'scrollTop', { value: geo.scrollTop, writable: true, configurable: true })
}

let api: ReturnType<typeof useAutoScroll> | null = null

function Harness(): ReactElement {
  const hook = useAutoScroll()
  api = hook
  return (
    <section
      data-testid="scroller"
      ref={hook.scrollRef}
      onScroll={hook.handlers.onScroll}
      onWheel={hook.handlers.onWheel}
      onPointerDown={hook.handlers.onPointerDown}
      onTouchStart={hook.handlers.onTouchStart}
      onKeyDown={hook.handlers.onKeyDown}
    >
      <div data-testid="content" ref={hook.contentRef} />
    </section>
  )
}

let originalRaf: typeof globalThis.requestAnimationFrame
let originalRo: typeof globalThis.ResizeObserver

beforeEach(() => {
  observers = []
  api = null
  originalRaf = globalThis.requestAnimationFrame
  originalRo = globalThis.ResizeObserver
  // rAF 同步执行，避免用例里到处等帧
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  }) as typeof globalThis.requestAnimationFrame
  globalThis.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  globalThis.requestAnimationFrame = originalRaf
  globalThis.ResizeObserver = originalRo
  vi.useRealTimers()
})

/** 渲染 harness 并给滚动容器一套初始几何（内容 1000，视口 400，已贴底） */
function setup(): { scroller: HTMLElement } {
  const { getByTestId } = render(<Harness />)
  const scroller = getByTestId('scroller')
  stubGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })
  return { scroller }
}

/** 派发一次 scroll 事件 */
function scrollTo(scroller: HTMLElement, top: number): void {
  ;(scroller as unknown as { scrollTop: number }).scrollTop = top
  act(() => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

describe('useAutoScroll', () => {
  it('双阈值：距底 100px 以内不显示回底按钮', () => {
    const { scroller } = setup()

    // 距底 = 1000 - 550 - 400 = 50
    scrollTo(scroller, 550)
    expect(api?.showJumpButton).toBe(false)
  })

  it('双阈值：距底超过 100px 显示回底按钮', () => {
    const { scroller } = setup()

    // 距底 = 1000 - 400 - 400 = 200
    scrollTo(scroller, 400)
    expect(api?.showJumpButton).toBe(true)
  })

  it('用户滚动离开底部后停止跟随：内容长高不再贴底', () => {
    const { scroller } = setup()

    // 用户滚轮 → 标记为用户输入
    act(() => {
      scroller.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    scrollTo(scroller, 300) // 距底 300，远离底部

    // 内容长高
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1400
    fireResize()

    // 仍停在用户的位置，没被拽到底
    expect(scroller.scrollTop).toBe(300)
  })

  it('未经用户输入的位置变化不解除跟随：内容长高仍贴底', () => {
    const { scroller } = setup()

    // 没有 wheel/pointerdown，仅位置变化（如内容重排）
    scrollTo(scroller, 300)
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1400
    fireResize()

    expect(scroller.scrollTop).toBe(1400)
  })

  it('程序化滚动的 scroll 回声不解除跟随（位置是动画中间值）', () => {
    const { scroller } = setup()

    // scrollToBottom 会开启 150ms 抑制窗口
    act(() => api?.scrollToBottom({ smooth: true }))

    // 平滑滚动过程中浏览器会连续派发 scroll，位置是中间值且远离底部。
    // 没有用户输入标记，因此必须被抑制窗口挡掉。
    scrollTo(scroller, 300)
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1400
    fireResize()

    expect(scroller.scrollTop).toBe(1400)
  })

  it('抑制窗口内的真实用户滚动仍然生效（挂载后立刻滚动不被吃掉）', () => {
    const { scroller } = setup()

    // 挂载时的贴底也会开一个抑制窗口，紧接着的 wheel 必须被尊重
    act(() => {
      scroller.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    scrollTo(scroller, 250)
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1400
    fireResize()

    expect(scroller.scrollTop).toBe(250)
  })

  it('用户滚走后 scrollToBottom 恢复跟随', () => {
    const { scroller } = setup()

    act(() => {
      scroller.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    scrollTo(scroller, 300)
    expect(api?.showJumpButton).toBe(true)

    act(() => api?.scrollToBottom({ smooth: false }))
    expect(api?.showJumpButton).toBe(false)

    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1400
    fireResize()
    expect(scroller.scrollTop).toBe(1400)
  })

  it('beginPrepend 后内容长高按增量补偿 scrollTop，而不是贴底', () => {
    const { scroller } = setup()

    // 用户滚到顶部触发加载更多
    act(() => {
      scroller.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    scrollTo(scroller, 0)

    act(() => api?.beginPrepend())

    // 前插 500px 历史内容
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1500
    fireResize()

    // 0 + (1500 - 1000) = 500，视觉位置不变
    expect(scroller.scrollTop).toBe(500)
  })

  it('前插补偿只生效一次，后续长高恢复正常跟随判定', () => {
    const { scroller } = setup()

    act(() => api?.beginPrepend())
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1500
    fireResize()
    expect(scroller.scrollTop).toBe(1100) // 600 + 500

    // 第二次长高：补偿标记已消耗，且当前处于跟随态 → 贴底
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1800
    fireResize()
    expect(scroller.scrollTop).toBe(1800)
  })

  it('forceFollow 无条件恢复跟随（用户刚发消息的场景）', () => {
    const { scroller } = setup()

    act(() => {
      scroller.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    scrollTo(scroller, 100)

    act(() => api?.forceFollow())
    expect(scroller.scrollTop).toBe(1000)

    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1400
    fireResize()
    expect(scroller.scrollTop).toBe(1400)
  })

  it('方向键也算用户滚动意图', () => {
    const { scroller } = setup()

    act(() => api?.handlers.onKeyDown({ key: 'PageUp' }))
    scrollTo(scroller, 200)
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1400
    fireResize()

    expect(scroller.scrollTop).toBe(200)
  })

  it('无关按键不影响跟随', () => {
    const { scroller } = setup()

    act(() => api?.handlers.onKeyDown({ key: 'a' }))
    scrollTo(scroller, 200)
    ;(scroller as unknown as { scrollHeight: number }).scrollHeight = 1400
    fireResize()

    expect(scroller.scrollTop).toBe(1400)
  })
})
