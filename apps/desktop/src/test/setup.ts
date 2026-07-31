/**
 * Vitest 全局环境补齐。
 *
 * jsdom 不实现 IntersectionObserver / ResizeObserver，而渲染层已经用它们做
 * 「滚动到顶部加载更多」和尺寸自适应。缺失时组件会在 effect 里直接抛
 * ReferenceError 并被 ErrorBoundary 兜住，测试看到的就是错误页而不是真实 UI。
 */

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null
  readonly rootMargin: string = ''
  readonly thresholds: ReadonlyArray<number> = []

  constructor(
    _callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    this.root = (options?.root as Element | Document | null) ?? null
    this.rootMargin = options?.rootMargin ?? ''
    const threshold = options?.threshold
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold ?? 0]
  }

  // 不主动触发回调：测试里没有真实布局，交叉状态应由用例显式驱动
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

class MockResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('IntersectionObserver' in globalThis)) {
  globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
}

// jsdom 未实现 scrollIntoView / scrollTo，消息流自动滚到底部时会调用
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {}
  }
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function scrollTo(): void {}
  }
}

// Radix 的浮层组件（Select / DropdownMenu / Popover / ContextMenu）依赖
// Pointer Capture API 与 getBoundingClientRect 的定位信息，jsdom 都没有实现。
// 缺失时 trigger 的 pointerdown 处理器会抛错，浮层根本打不开。
if (typeof HTMLElement !== 'undefined') {
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false
    }
  }
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = function setPointerCapture(): void {}
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(): void {}
  }
}
