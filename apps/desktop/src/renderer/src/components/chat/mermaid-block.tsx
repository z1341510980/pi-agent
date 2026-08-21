import { useEffect, useRef, useState, type ReactElement } from 'react'
import { AlertTriangle, Code2, Copy, Check, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * MermaidBlock —— ```mermaid 代码块的图形渲染。
 *
 * ## 流式渲染的三个坑
 *
 * 1. **半成品语法一定会报错**。模型逐字吐 `graph TD` 的过程中，绝大多数中间态
 *    都不是合法的 mermaid。所以初始视图是**源码**，渲染成功才切到图；
 *    渲染抛错就留在源码视图，不弹错误。
 *
 * 2. **不能每个 delta 都渲染一次**。mermaid 的 parse + layout 很重，逐字触发会
 *    卡住主线程。这里对源码做 300ms 防抖。
 *
 * 3. **不能把用户选的视图切回去**。用户主动点了"源码"之后，后续 delta 渲染成功
 *    不该把他弹回图表视图。用 `preferredViewRef` 记住用户的显式选择。
 *
 * mermaid 用动态 import 引入：它是整个渲染链里最大的一块（~2.5MB），
 * 绝大多数会话根本不含图表，没有理由让它进初始包。
 */

/** 源码防抖：渲染很重，不能逐字触发 */
const DEBOUNCE_MS = 300

type ViewMode = 'source' | 'diagram'

let mermaidReady: Promise<typeof import('mermaid').default> | null = null

/**
 * 懒加载并初始化 mermaid（进程内只做一次）。
 *
 * `securityLevel: 'strict'` 禁止图里的 HTML/脚本 —— 图表源码来自模型输出，
 * 属不可信内容。`suppressErrorRendering` 避免 mermaid 往 DOM 里塞它自己的
 * 错误图，错误由我们回落源码视图来表达。
 */
async function loadMermaid(isDark: boolean): Promise<typeof import('mermaid').default> {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then((mod) => mod.default)
  }
  const mermaid = await mermaidReady
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: isDark ? 'dark' : 'default',
    fontFamily: 'inherit',
  })
  return mermaid
}

export interface MermaidBlockProps {
  code: string
  isDark: boolean
}

export function MermaidBlock({ code, isDark }: MermaidBlockProps): ReactElement {
  // 初始停在源码：流式中途的语法几乎必然不合法，先渲染再回退会闪
  const [view, setView] = useState<ViewMode>('source')
  const [svg, setSvg] = useState<string | null>(null)
  const [debounced, setDebounced] = useState(code)
  const [copied, setCopied] = useState(false)

  /** 用户显式选过的视图；非 null 时渲染成功也不自动切换 */
  const preferredViewRef = useRef<ViewMode | null>(null)
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 10)}`)
  const copyTimer = useRef<number | null>(null)

  // 源码防抖
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(code), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [code])

  // 尝试渲染；失败就静默留在源码视图
  useEffect(() => {
    let cancelled = false
    const source = debounced.trim()
    if (!source) {
      setSvg(null)
      return
    }

    void (async () => {
      try {
        const mermaid = await loadMermaid(isDark)
        const { svg: rendered } = await mermaid.render(idRef.current, source)
        if (cancelled) return
        // 让图跟随容器宽度，mermaid 默认输出固定 max-width
        setSvg(rendered.replace(/<svg /, '<svg style="max-width:100%;height:auto" '))
        // 只在用户没有显式选过视图时自动切到图表
        if (preferredViewRef.current === null) setView('diagram')
      } catch {
        if (cancelled) return
        // 语法还没写完（或真的写错了）——保持源码视图，不打扰用户
        setSvg(null)
        if (preferredViewRef.current === null) setView('source')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [debounced, isDark])

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const choose = (next: ViewMode): void => {
    preferredViewRef.current = next
    setView(next)
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时静默失败
    }
  }

  const canShowDiagram = svg !== null

  return (
    <div className="group/code my-4 overflow-hidden rounded-xl bg-[var(--color-code-block-bg)]">
      <div className="flex items-center justify-between gap-3 bg-[var(--color-code-block-banner)] px-3.5 py-2">
        <span className="font-mono text-xs leading-[18px] text-text select-none">mermaid</span>
        <div className="flex items-center gap-1">
          {/* 视图切换：只有渲染成功才给图表选项 */}
          <div
            role="tablist"
            aria-label="图表视图"
            className="flex items-center rounded-md bg-surface-3/60 p-0.5"
          >
            <ViewTab
              active={view === 'diagram'}
              disabled={!canShowDiagram}
              label="图表"
              onClick={() => choose('diagram')}
            >
              <ImageIcon className="size-3" />
            </ViewTab>
            <ViewTab active={view === 'source'} label="源码" onClick={() => choose('source')}>
              <Code2 className="size-3" />
            </ViewTab>
          </div>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-hint opacity-0 transition-all hover:bg-accent hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/code:opacity-100 max-sm:opacity-100"
            aria-label={copied ? '已复制' : '复制源码'}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        </div>
      </div>

      {view === 'diagram' && canShowDiagram ? (
        <div
          className="flex justify-center overflow-x-auto px-3 py-3"
          // svg 来自 mermaid 且已设 securityLevel: 'strict'，不含脚本
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre className="m-0 overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-text-secondary">
          {code}
        </pre>
      )}

      {/* 渲染不出来时给一句解释，避免用户以为功能坏了 */}
      {!canShowDiagram && debounced.trim().length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-[var(--dsw-alias-border-l1)] px-3 py-1.5 text-xs text-hint">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          图表语法尚不完整或有误，暂显示源码
        </div>
      )}
    </div>
  )
}

function ViewTab({
  active,
  disabled = false,
  label,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  children: ReactElement
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded px-1.5 py-0.5 text-nano transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-surface-1 text-text shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-hint hover:text-text',
        disabled && 'cursor-not-allowed opacity-40 hover:text-hint',
      )}
    >
      {children}
      {label}
    </button>
  )
}
