import type { AnchorHTMLAttributes, ReactElement } from 'react'
import { FileCode } from 'lucide-react'
import { useFileReference } from './file-reference-context'
import { cn } from '@/lib/utils'

/**
 * Markdown 里的 `a` 渲染器。
 *
 * 两种来源：
 * 1. 真链接（模型写了 `[x](https://…)`）—— 原样渲染
 * 2. rehype-file-references 生成的文件引用（带 `data-file-ref`）—— 渲染成可点击
 *    的文件位置，点击在内置预览里打开
 *
 * 没有 FileReferenceProvider 时文件引用降级为 `<code>`：内容照常可读。
 */

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  'data-file-ref'?: string
  'data-file-line'?: string
  'data-file-column'?: string
  'data-file-end-line'?: string
}

export function MarkdownAnchor(props: Props): ReactElement {
  const filePath = props['data-file-ref']
  const context = useFileReference()

  if (!filePath) {
    const { children, href, ...rest } = props
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  }

  const label = props.children

  if (!context) {
    return <code className="rounded bg-surface-4 px-1 py-0.5 text-[0.9em]">{label}</code>
  }

  const line = toNumber(props['data-file-line'])
  const endLine = toNumber(props['data-file-end-line'])
  const column = toNumber(props['data-file-column'])

  return (
    <button
      type="button"
      onClick={() => context.openFile({ raw: String(label ?? ''), path: filePath, line, column, endLine })}
      title={`打开 ${filePath}${line != null ? `（第 ${line} 行）` : ''}`}
      className={cn(
        'inline-flex max-w-full items-baseline gap-0.5 rounded px-1 align-baseline',
        'bg-primary/8 font-mono text-[0.9em] text-primary',
        'transition-colors hover:bg-primary/15',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <FileCode className="size-3 shrink-0 translate-y-[0.1em] opacity-70" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  )
}

function toNumber(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}
