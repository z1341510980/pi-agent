import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { MermaidBlock } from './mermaid-block'
import { cn } from '@/lib/utils'

/**
 * CodeBlock —— Markdown 代码块渲染。
 *
 * ## 为什么需要
 *
 * 此前 `message-bubble` 只有一行裸 `<ReactMarkdown remarkPlugins={[remarkGfm]}>`，
 * 代码块仅靠 `prose-pre:*` 给个背景圆角：**无语法高亮、无复制按钮、无语言标签**。
 * 提交 `f7d1d7b` 曾加过 CodeBlock，被 `501827c` 的批量整理删掉了，属功能回退。
 *
 * ## 关键取舍
 *
 * - **高亮实现按需加载**（`./highlighted-code`）。hljs 核心加 28 个语言有几百 KB，
 *   而绝大多数会话不含代码块，压进主包只是让冷启动白读一遍。未加载完成前显示
 *   无高亮纯文本 —— 内容立刻可读，颜色随后补上。
 *
 * - **靠"内容里有没有换行"判断行内代码**。react-markdown v9 移除了 `inline` prop，
 *   所以只能自己判。这个判法顺带解决流式问题：模型刚吐出半个 ``` 围栏时，
 *   内容还没有换行，会降级成 `<code>` 而不是先闪一个空代码块。
 *
 * - **超长代码默认折叠**。工具输出动辄几百行，不折叠会把整屏挤满。
 */

const HighlightedCode = lazy(() => import('./highlighted-code'))

/** 折叠阈值：超过这个行数才折叠 */
const COLLAPSE_LINE_THRESHOLD = 24
/** 折叠态显示的行数 */
const COLLAPSED_LINES = 16

/** 从 `language-xxx` className 里取语言名 */
function parseLanguage(className: string | undefined): string | null {
  if (!className) return null
  const match = /language-([\w+#-]+)/.exec(className)
  if (!match) return null
  return match[1].toLowerCase()
}

/**
 * 跟随 `<html>` 的 dark class 切换高亮主题。
 *
 * 不用 `useTheme()`：它返回的可能是未解析的 `'system'`，而这里需要的是
 * 最终生效的明暗。直接观察 class 变化更可靠，也覆盖了系统主题跟随的场景。
 */
function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )

  useEffect(() => {
    const root = document.documentElement
    const sync = (): void => setIsDark(root.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDark
}

export interface CodeBlockProps {
  /** react-markdown 传入的 `language-xxx` */
  className?: string
  children?: ReactNode
}

export function CodeBlock({ className, children }: CodeBlockProps): ReactElement {
  const raw = typeof children === 'string' ? children : String(children ?? '')
  // 尾随换行是 markdown 解析的产物，不是代码的一部分
  const code = raw.replace(/\n$/, '')

  const langClass = parseLanguage(className)

  // 行内代码判定：没有换行且没有 language- 标记。
  // react-markdown v9 去掉了 inline prop，只能这样判；顺带避免流式时
  // 半个围栏先闪一个空代码块。
  const isInline = !langClass && !code.includes('\n')
  if (isInline) {
    return (
      <code className="inline-flex items-center rounded-md bg-[var(--dsw-alias-markdown-inline-code)] px-[5px] py-0 text-[0.875em] text-text">
        {code}
      </code>
    )
  }

  if (langClass === 'mermaid') return <MermaidCodeBlock code={code} />

  return <CodeBlockFrame code={code} langClass={langClass} />
}

/** mermaid 需要知道明暗以选主题，单独包一层拿 hook（CodeBlock 本身可能走行内分支） */
function MermaidCodeBlock({ code }: { code: string }): ReactElement {
  const isDark = useIsDark()
  return <MermaidBlock code={code} isDark={isDark} />
}

function CodeBlockFrame({
  code,
  langClass,
}: {
  code: string
  langClass: string | null
}): ReactElement {
  const isDark = useIsDark()
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const copyTimer = useRef<number | null>(null)

  const lineCount = useMemo(() => code.split('\n').length, [code])
  const collapsible = lineCount > COLLAPSE_LINE_THRESHOLD
  const isCollapsed = collapsible && !expanded

  // 折叠态只把前 N 行交给高亮器：几百行的工具输出没必要全量 tokenize
  const shownCode = useMemo(
    () => (isCollapsed ? code.split('\n').slice(0, COLLAPSED_LINES).join('\n') : code),
    [code, isCollapsed],
  )

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时静默失败，不值得为此弹错误
    }
  }

  return (
    // dsh CodeBlock：r12、代码面填充、语言横幅（banner 色）。
    // 横幅 sticky 钉在滚动容器顶部：长代码滚动时语言标签始终可读。
    // 外层不做 overflow:hidden（会困住 sticky），底部圆角交给内容区裁剪。
    <div className="group/code my-4 rounded-xl bg-[var(--color-code-block-bg)]">
      {/* 横幅 sticky 包装：底色用页面背景，代码从其下穿过时被遮住 */}
      <div className="sticky top-0 z-10 rounded-t-xl bg-app-bg">
        <div className="flex items-center justify-between gap-3 rounded-t-xl bg-[var(--color-code-block-banner)] px-3.5 py-2">
          <span className="font-mono text-xs leading-[18px] text-text select-none">
            {langClass ?? 'text'}
          </span>
          <button
            type="button"
            onClick={() => void handleCopy()}
            // 移动/触摸设备没有 hover，用 focus-within 兜不住，所以小屏常显
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-hint opacity-0 transition-all hover:bg-accent hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/code:opacity-100 max-sm:opacity-100"
            aria-label={copied ? '已复制' : '复制代码'}
            title={copied ? '已复制' : '复制代码'}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-b-xl">
        <div className={cn('relative', isCollapsed && 'overflow-hidden')}>
          {/* fallback 是同样排版的纯文本：加载高亮 chunk 期间内容照常可读，不留白 */}
          <Suspense fallback={<PlainCode code={shownCode} />}>
            <HighlightedCode code={shownCode} language={langClass} isDark={isDark} />
          </Suspense>

          {isCollapsed && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--color-code-block-bg)] to-transparent" />
          )}
        </div>

        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-xs text-hint transition-colors hover:bg-accent hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
            {expanded ? '收起' : `展开剩余 ${lineCount - COLLAPSED_LINES} 行`}
          </button>
        )}
      </div>
    </div>
  )
}

/** 无高亮的纯文本代码，排版与高亮版保持一致以避免加载完成时跳动 */
function PlainCode({ code }: { code: string }): ReactElement {
  return (
    <pre
      className="m-0 overflow-x-auto text-text-secondary"
      style={{
        padding: '12px 14px',
        fontSize: '12.5px',
        lineHeight: '1.6',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      }}
    >
      {code}
    </pre>
  )
}
