import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Loader2, Wrench, FileText, Terminal, Search, FolderCog, CheckCircle2, XCircle, Clock } from 'lucide-react'
import type { ToolCallInfo } from './types'
import { FileDiffView } from './file-diff-view'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface ToolCallCardProps {
  toolCall: ToolCallInfo
  /** 工具在序列中的序号（可选） */
  index?: number
}

/** 状态标签配置 */
const STATUS_META = {
  pending: { label: '等待', variant: 'secondary' as const },
  running: { label: '执行中', variant: 'default' as const },
  success: { label: '完成', variant: 'outline' as const },
  error: { label: '失败', variant: 'destructive' as const },
}

/** 工具类型视觉配置：色条 + 图标 */
interface ToolVisual {
  /** 左侧色条类名 */
  bar: string
  /** 图标组件 */
  Icon: typeof Wrench
  /** 图标圆背景 */
  iconBg: string
}

/** 按工具名推断类型视觉 */
function getToolVisual(toolName: string): ToolVisual {
  const name = toolName.toLowerCase()
  if (name.includes('read') || name.includes('cat') || name.includes('view')) {
    return { bar: 'bg-blue-500', Icon: FileText, iconBg: 'bg-blue-500/15 text-blue-500' }
  }
  if (name.includes('write') || name.includes('edit') || name.includes('patch') || name.includes('create')) {
    return { bar: 'bg-orange-500', Icon: FolderCog, iconBg: 'bg-orange-500/15 text-orange-500' }
  }
  if (name.includes('bash') || name.includes('shell') || name.includes('exec') || name.includes('run')) {
    return { bar: 'bg-emerald-500', Icon: Terminal, iconBg: 'bg-emerald-500/15 text-emerald-500' }
  }
  if (name.includes('search') || name.includes('grep') || name.includes('find') || name.includes('query')) {
    return { bar: 'bg-purple-500', Icon: Search, iconBg: 'bg-purple-500/15 text-purple-500' }
  }
  return { bar: 'bg-slate-400', Icon: Wrench, iconBg: 'bg-surface-3 text-hint' }
}

/**
 * ToolCallCard：工具调用卡片
 *
 * 借鉴 AionUi：
 *   - 左侧 3px 色条标识工具类型（read=蓝、write=橙、bash=绿、search=紫）
 *   - 顶部图标圆角方块（不再用纯 Wrench 图标）
 *   - 折叠/展开使用 framer-motion 动画
 *   - 失败状态用 destructive 色调
 */
export function ToolCallCard({ toolCall, index }: ToolCallCardProps) {
  const { toolName, status, args, partialResult, startedAt, endedAt, details } = toolCall
  const [expanded, setExpanded] = useState(false)

  const meta = STATUS_META[status] ?? STATUS_META.pending
  const visual = getToolVisual(toolName)
  const { Icon } = visual

  // 耗时
  const durationMs = startedAt && endedAt ? endedAt - startedAt : null
  const duration =
    durationMs !== null
      ? durationMs < 1000
        ? `${durationMs}ms`
        : `${(durationMs / 1000).toFixed(1)}s`
      : startedAt && status === 'running'
        ? '…'
        : null

  // 耗时颜色：<1s 绿色，1-5s 黄色，>5s 红色
  const durationColor =
    durationMs !== null
      ? durationMs < 1000
        ? 'text-emerald-500'
        : durationMs < 5000
          ? 'text-amber-500'
          : 'text-red-500'
      : 'text-hint'

  // 参数摘要
  const argsSummary =
    args === undefined
      ? null
      : typeof args === 'string'
        ? args.slice(0, 80)
        : Object.values(args as Record<string, unknown>)
            .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
            .join(', ')
            .slice(0, 80)

  // 结果摘要
  const resultSummary =
    partialResult === undefined
      ? null
      : typeof partialResult === 'string'
        ? partialResult.slice(0, 120)
        : JSON.stringify(partialResult).slice(0, 120)

  // 检测结果类型用于语法高亮
  const detectResultType = (value: unknown): 'json' | 'yaml' | 'shell' | 'text' => {
    if (typeof value !== 'string') return 'json'
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
    if (trimmed.startsWith('---') || /^[a-zA-Z_][a-zA-Z0-9_-]*:/.test(trimmed)) return 'yaml'
    if (/^[\w\-\.]+\s*=\s*/.test(trimmed) || trimmed.includes('$ ')) return 'shell'
    return 'text'
  }

  const hasDetails = args !== undefined || partialResult !== undefined
  const isError = status === 'error'

  /**
   * 改动 diff（edit/write 工具的 details）。
   *
   * 独立于「查看详情」折叠区，直接挂在卡片下方 —— 「改了什么」是这类工具
   * 唯一真正重要的输出，不该埋在二级折叠里再折叠一层。
   */
  const diffText = typeof details?.diff === 'string' ? details.diff : undefined
  const diffFilePath =
    args && typeof args === 'object'
      ? (() => {
          const record = args as Record<string, unknown>
          for (const key of ['path', 'filePath', 'file_path', 'file']) {
            const value = record[key]
            if (typeof value === 'string' && value.length > 0) return value
          }
          return undefined
        })()
      : undefined

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
      className={cn(
        'relative rounded-lg border bg-background overflow-hidden',
        isError ? 'border-destructive/40' : 'border-border',
        'dark:bg-surface-1',
      )}
    >
      {/* 左侧色条 */}
      <div className={cn('absolute left-0 top-0 bottom-0 w-[3px]', visual.bar)} aria-hidden="true" />

      {/* 顶部标题行 */}
      <button
        type="button"
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2.5 pl-4 pr-3.5 py-2.5 text-left',
          hasDetails && 'hover:bg-muted/50 dark:hover:bg-surface-2/50',
        )}
      >
        <span className={cn('flex size-5 items-center justify-center rounded-md', visual.iconBg)} aria-hidden="true">
          <Icon className="size-3" />
        </span>
        <span className="font-mono font-medium text-text truncate text-xs">
          {toolName}
        </span>
        {/* 序号和耗时 */}
        <div className="flex items-center gap-2 ml-auto shrink-0">
          {index !== undefined && (
            <span className="text-[10px] text-hint font-mono">#{index + 1}</span>
          )}
          {duration && (
            <span className={cn('text-[10px] font-mono', durationColor)} aria-label="耗时">
              {duration}
            </span>
          )}
          <Badge variant={meta.variant} className="shrink-0">
            {status === 'running' && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
            {meta.label}
          </Badge>
        </div>
      </button>

      {/* 折叠区域：参数 / 结果 */}
      <AnimatePresence initial={false}>
        {hasDetails && expanded && (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-border/60"
          >
            <div className="pl-4 pr-3.5 py-2.5 space-y-2">
              {args !== undefined && (
                <div>
                  <div className="mb-1 text-[11px] text-hint">参数</div>
                  <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-[11px] text-text/90 dark:bg-surface-2/50">
                    {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
                  </pre>
                </div>
              )}
              {partialResult !== undefined && (
                <div>
                  <div className="mb-1 text-[11px] text-hint">结果</div>
                  <pre className={cn(
                    'max-h-40 overflow-auto rounded p-2 text-[11px]',
                    isError
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-muted/50 text-text/90 dark:bg-surface-2/50',
                  )}>
                    {typeof partialResult === 'string'
                      ? partialResult
                      : JSON.stringify(partialResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 改动 diff：默认只给 +N −M 统计条，点开才展开全文 */}
      {diffText && (
        <div className="border-t border-border/60 pl-4 pr-3.5 pb-2">
          <FileDiffView
            diff={diffText}
            filePath={diffFilePath}
            truncated={details?.diffTruncated === true}
          />
        </div>
      )}

      {/* 底部元信息 */}
      <div className={cn(
        'flex items-center gap-3 border-t border-border/60 pl-4 pr-3.5 py-1.5',
        'text-[11px] text-hint',
      )}>
        {hasDetails ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 hover:text-text"
          >
            <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
            {expanded ? '收起详情' : '查看详情'}
          </button>
        ) : (
          <span>无详情</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {argsSummary && !expanded && (
            <span className="truncate max-w-[180px]" title="参数">{argsSummary}</span>
          )}
          {resultSummary && !expanded && (
            <span className="truncate max-w-[180px]" title="结果">{resultSummary}</span>
          )}
          {duration && (
            <span aria-label="耗时">⏱ {duration}</span>
          )}
        </div>
      </div>
    </motion.div>
  )
}
