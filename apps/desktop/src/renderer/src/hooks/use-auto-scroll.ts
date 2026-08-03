import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * useAutoScroll —— 流式消息的「意图式」自动跟随。
 *
 * ## 为什么不用位置判断
 *
 * 原来的实现是 `useEffect(() => { el.scrollTop = el.scrollHeight }, [messages, …])`
 * 加一个 `scrollHeight - scrollTop - clientHeight < 50` 的单阈值。四个问题：
 *
 * 1. **单阈值同时管两件事**。50px 既决定「显示回底按钮」又决定「继续跟随」，
 *    于是用户往上滚 30px 想看上一段，下一个 delta 就把他拽回底部。
 *    这里分成两个阈值：100px 之外才显示按钮，4px 之内才算「钉住」。
 *
 * 2. **分不清用户滚动和程序滚动**。程序改 `scrollTop` 也会触发 `scroll` 事件，
 *    位置判断在滚动过程中读到的是中间值，容易把自己的滚动误判成用户滚动
 *    （经典的「自动滚动把自己取消掉」）。这里改成只在 `wheel` / `pointerdown` /
 *    `touchstart` / 方向键之后才把状态改成「用户已接管」，并对程序化滚动开
 *    150ms 抑制窗口。
 *
 * 3. **靠 messages 变化驱动，抓不到延迟长高**。图片加载完、mermaid 渲染完、
 *    代码块展开，这些都不改 messages 但会改高度，位置就掉了。这里用
 *    `ResizeObserver` 观察内容元素，高度一变就重新贴底。
 *
 * 4. **浏览器的滚动锚定会反向对抗**。Chrome 的 scroll anchoring 会在内容变化时
 *    自己调 `scrollTop` 保持视觉位置，这和「跟随底部」是直接冲突的。
 *    所以必须给滚动容器和内容都加 `overflow-anchor: none`。
 *
 * ## 与历史分页的耦合
 *
 * 关掉 `overflow-anchor` 的代价是：往顶部前插历史消息时浏览器不再帮忙保位，
 * 画面会突然跳。所以必须自己补偿 —— 调用方在触发「加载更多」前调
 * `beginPrepend()`，内容长高时按 `scrollHeight` 增量把 `scrollTop` 顶回去。
 */

/** 超出这个距离才显示「回到底部」按钮 */
const JUMP_BUTTON_THRESHOLD_PX = 100
/** 在这个距离内才算「钉在底部」，继续自动跟随 */
const FOLLOW_THRESHOLD_PX = 4
/** 程序化滚动后的抑制窗口：这段时间内的 scroll 事件不算用户操作 */
const PROGRAMMATIC_GUARD_MS = 150
/** 前插补偿的兜底超时：请求失败或没有新内容时把标记清掉 */
const PREPEND_TIMEOUT_MS = 3000

/** 会改变滚动意图的按键 */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

export interface UseAutoScrollResult {
  /** 挂到滚动容器 */
  scrollRef: RefObject<HTMLDivElement | null>
  /** 挂到内容元素（容器的直接子节点，高度随消息增长） */
  contentRef: RefObject<HTMLDivElement | null>
  /** 是否显示「回到底部」按钮 */
  showJumpButton: boolean
  /** 滚到底部并恢复跟随 */
  scrollToBottom: (options?: { smooth?: boolean }) => void
  /**
   * 强制贴底并恢复跟随，忽略之前的滚动意图。
   * 用户自己发消息时该无条件跳到底部 —— 他刚提交的东西必须可见。
   */
  forceFollow: () => void
  /** 触发「加载更多历史」之前调用，用于前插后保位 */
  beginPrepend: () => void
  /** 展开到滚动容器上的事件处理器 */
  handlers: {
    onScroll: () => void
    onWheel: () => void
    onPointerDown: () => void
    onTouchStart: () => void
    onKeyDown: (event: { key: string }) => void
  }
}

export function useAutoScroll(): UseAutoScrollResult {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const [showJumpButton, setShowJumpButton] = useState(false)

  /** 是否继续跟随底部 */
  const followingRef = useRef(true)
  /** 用户是否刚刚做了滚动输入（wheel / 指针 / 方向键） */
  const userInputActiveRef = useRef(false)
  /** 程序化滚动抑制窗口的截止时间 */
  const guardUntilRef = useRef(0)
  /** 待补偿的前插：记录长高前的 scrollHeight / scrollTop */
  const prependRef = useRef<{ height: number; top: number; expireAt: number } | null>(null)
  /** 合并到单个 rAF 的跟随任务 */
  const rafRef = useRef<number | null>(null)

  /** 立刻贴底（不走 rAF），并开启程序化滚动抑制窗口 */
  const pinToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    guardUntilRef.current = Date.now() + PROGRAMMATIC_GUARD_MS
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }, [])

  /** 跟随底部：合并到一帧，避免一次高度变化触发多次滚动 */
  const scheduleFollow = useCallback(() => {
    if (!followingRef.current) return
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      pinToBottom(false)
    })
  }, [pinToBottom])

  const scrollToBottom = useCallback(
    (options?: { smooth?: boolean }) => {
      followingRef.current = true
      setShowJumpButton(false)
      pinToBottom(options?.smooth ?? true)
    },
    [pinToBottom],
  )

  const forceFollow = useCallback(() => {
    followingRef.current = true
    userInputActiveRef.current = false
    setShowJumpButton(false)
    // 双 rAF：等 React 把新消息提交进 DOM 并完成布局后再贴底
    requestAnimationFrame(() => requestAnimationFrame(() => pinToBottom(false)))
  }, [pinToBottom])

  const beginPrepend = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    prependRef.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      expireAt: Date.now() + PREPEND_TIMEOUT_MS,
    }
  }, [])

  /**
   * scroll 事件只做两件事：更新按钮可见性；在确认是用户操作时解除跟随。
   *
   * 「是否用户操作」不看位置，看 `userInputActiveRef` ——
   * 位置在滚动动画过程中是连续变化的中间值，据此判断必然误伤。
   *
   * 顺序很重要：**先看用户输入标记，再看抑制窗口**。抑制窗口的目的是过滤
   * 程序化滚动自己引发的 scroll 回声；而 wheel / 指针 / 方向键是用户意图的
   * 确凿证据，哪怕落在窗口内也必须尊重（否则挂载后 150ms 内的滚动会被吃掉）。
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight

    setShowJumpButton(distance > JUMP_BUTTON_THRESHOLD_PX)

    if (userInputActiveRef.current) {
      // 用户主动滚动：只有真正回到底部才恢复跟随
      followingRef.current = distance <= FOLLOW_THRESHOLD_PX
      userInputActiveRef.current = false
      return
    }

    // 程序化滚动的回声：位置是动画中间值，不足以判断意图，直接忽略
    if (Date.now() < guardUntilRef.current) return

    // 其余的位置变化（如内容重排）：贴底就继续跟随，否则保持原状
    if (distance <= FOLLOW_THRESHOLD_PX) followingRef.current = true
  }, [])

  const markUserInput = useCallback(() => {
    userInputActiveRef.current = true
  }, [])

  const onKeyDown = useCallback((event: { key: string }) => {
    if (SCROLL_KEYS.has(event.key)) userInputActiveRef.current = true
  }, [])

  // 内容/容器高度变化 → 前插补偿 或 跟随底部
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el) return

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      const pending = prependRef.current
      if (pending) {
        if (Date.now() > pending.expireAt) {
          prependRef.current = null
        } else {
          const delta = el.scrollHeight - pending.height
          if (delta > 0) {
            // 关掉 overflow-anchor 后浏览器不再保位，这里手动把视口顶回原处
            guardUntilRef.current = Date.now() + PROGRAMMATIC_GUARD_MS
            el.scrollTop = pending.top + delta
            prependRef.current = null
          }
          return
        }
      }
      scheduleFollow()
    })

    observer.observe(el)
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [scheduleFollow])

  // 首次挂载贴底
  useEffect(() => {
    pinToBottom(false)
  }, [pinToBottom])

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  return {
    scrollRef,
    contentRef,
    showJumpButton,
    scrollToBottom,
    forceFollow,
    beginPrepend,
    handlers: {
      onScroll,
      onWheel: markUserInput,
      onPointerDown: markUserInput,
      onTouchStart: markUserInput,
      onKeyDown,
    },
  }
}
