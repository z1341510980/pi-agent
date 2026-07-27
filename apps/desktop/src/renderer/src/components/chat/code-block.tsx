import { useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

interface CodeBlockProps {
  /** 语言标识（来自 `language-xxx` className） */
  language: string
  /** 代码正文（已去除尾部换行） */
  code: string
  /** 标题栏显示的文件名（可选） */
  filename?: string
}

/**
 * CodeBlock：AionUi 风格的代码块（Stage 2 Task 2.1）
 *
 * - 标题栏：语言标签 + 可选文件名 + hover 显示的复制按钮
 * - 主体：`<pre><code>` 横向滚动
 * - 复制成功后 1.5s 内显示 "已复制" 反馈，失败弹 toast
 * - 视觉走 Stage 1 引入的语义 token（--bg-* / --t-* / --fill-* / --border-1）
 */
export function CodeBlock({ language, code, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast({ title: '复制失败', variant: 'destructive' })
    }
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-[var(--border-1)] bg-[var(--bg-2)]">
      <div className="flex items-center justify-between border-b border-[var(--border-1)] bg-[var(--bg-3)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-[var(--t-secondary)]">{language}</span>
          {filename && <span className="text-[11px] text-[var(--t-tertiary)]">{filename}</span>}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--t-tertiary)] opacity-0 transition-opacity hover:bg-[var(--fill-2)] hover:text-[var(--t-primary)] group-hover:opacity-100"
          title="复制代码"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  )
}

/**
 * 用于 react-markdown v9 的 `code` 组件渲染器。
 *
 * v9 移除了 `inline` prop，改用 `node` 的 position/tagName 判断。
 * 这里采用保守策略：
 * - `className` 含 `language-xxx` → 块级 CodeBlock
 * - 否则 → inline code（保留原 `<code>` 渲染，套语义 token）
 */
export function MarkdownCode({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'code'> & { node?: unknown }) {
  const match = /language-(\w+)/.exec(className || '')
  const code = String(children ?? '').replace(/\n$/, '')

  if (match) {
    return <CodeBlock language={match[1]} code={code} />
  }

  // inline code：保持轻量样式，不引入 CodeBlock
  return (
    <code
      className="rounded bg-[var(--bg-3)] px-1 py-0.5 text-[0.85em] text-[var(--t-primary)]"
      {...props}
    >
      {children}
    </code>
  )
}
