import { useMemo, useState, type ReactElement } from 'react'
import { ChevronDown, FileDiff } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * FileDiffView —— 工具改动的 diff 展示。
 *
 * ## 为什么先给统计条再给全文
 *
 * 一次改动的 diff 动辄上百行。直接摊在消息流里，用户要滚很久才能看到 Agent
 * 后面说了什么 —— 而多数时候他只想确认「改了哪个文件、动了几行」。所以默认
 * 只给一行 `+8 −3`，点开才展开全文。这与 AionUi 的做法一致：流内只放紧凑
 * 统计，完整 diff 是二级动作。
 *
 * ## 为什么自己染色而不用 diff2html
 *
 * 需要的只是「加/减/上下文」三种行底色。引一个 HTML 生成库要么得 dangerously
 * 注入，要么得把它的 CSS 一起搬进来，收益不抵成本。逐行判首字符就够了。
 */

export type DiffLineKind = 'add' | 'remove' | 'meta' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** 统计增删行数 */
export interface DiffStats {
  added: number
  removed: number
}

/**
 * 按首字符分类每一行。
 *
 * 展示型 diff（pi-coding-agent 的 `EditToolDetails.diff`）带行号前缀，
 * unified patch 则以 `+`/`-`/` ` 开头。两种都要能吃，所以先剥掉行号前缀
 * 再看首个有效字符。
 */
export function parseDiffLines(diff: string): DiffLine[] {
  const lines = diff.split('\n')
  // 末尾空行是 split 的产物，不是 diff 内容
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines.map((raw) => {
    // 剥掉可能存在的行号前缀，如 "  12 | +foo"
    const stripped = raw.replace(/^\s*\d+\s*\|\s?/, '')
    const marker = stripped[0] ?? ''

    if (/^(diff |index |---|\+\+\+|@@)/.test(stripped)) {
      return { kind: 'meta' as const, text: raw }
    }
    if (marker === '+') return { kind: 'add' as const, text: raw }
    if (marker === '-') return { kind: 'remove' as const, text: raw }
    return { kind: 'context' as const, text: raw }
  })
}

export function computeDiffStats(lines: DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'remove') removed++
  }
  return { added, removed }
}

const LINE_TONE: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300',
  remove: 'bg-rose-500/12 text-rose-800 dark:text-rose-300',
  meta: 'text-hint',
  context: 'text-text-secondary',
}

export interface FileDiffViewProps {
  /** 展示型 diff 或 unified patch */
  diff: string
  /** 关联文件路径（有则显示在统计条左侧） */
  filePath?: string
  /** 后端是否截断过（超长 patch 会截） */
  truncated?: boolean
}

export function FileDiffView({ diff, filePath, truncated = false }: FileDiffViewProps): ReactElement {
  const [expanded, setExpanded] = useState(false)

  const lines = useMemo(() => parseDiffLines(diff), [diff])
  const stats = useMemo(() => computeDiffStats(lines), [lines])

  const fileName = filePath ? filePath.split(/[\\/]/).pop() : undefined

  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-surface-1/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-surface-3/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FileDiff className="size-3 shrink-0 text-hint" aria-hidden />
        {fileName && (
          <span className="min-w-0 truncate font-mono text-nano text-text-secondary" title={filePath}>
            {fileName}
          </span>
        )}
        <span className="shrink-0 font-mono text-nano tabular-nums text-emerald-600 dark:text-emerald-400">
          +{stats.added}
        </span>
        <span className="shrink-0 font-mono text-nano tabular-nums text-rose-600 dark:text-rose-400">
          −{stats.removed}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-3 shrink-0 text-hint transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && (
        <div className="max-h-72 overflow-auto border-t border-border">
          <pre className="m-0 w-max min-w-full font-mono text-nano leading-[1.55]">
            {lines.map((line, index) => (
              <div
                // diff 行没有稳定 id，行号即身份；diff 变化时整体重渲染，可接受
                key={index}
                className={cn('px-2 whitespace-pre', LINE_TONE[line.kind])}
              >
                {line.text || ' '}
              </div>
            ))}
          </pre>
          {truncated && (
            <p className="border-t border-border px-2 py-1 text-nano text-hint">
              diff 过长已被截断，完整内容请查看文件本身
            </p>
          )}
        </div>
      )}
    </div>
  )
}
