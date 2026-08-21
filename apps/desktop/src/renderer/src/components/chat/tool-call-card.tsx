import { useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronDown, ChevronRight, FileText, Terminal, Search, FolderCog, Wrench } from 'lucide-react'
import type { ToolCallInfo } from './types'
import { FileDiffView } from './file-diff-view'
import { cn } from '@/lib/utils'
import { SlotRenderer } from '../slot'

export interface ToolCallCardProps {
  toolCall: ToolCallInfo
  /** 工具在序列中的序号（可选） */
  index?: number
}

/** 工具类型图标（dsh 风格：中性三级灰，不再用彩色圆块） */
function getToolIcon(toolName: string): typeof Wrench {
  const name = toolName.toLowerCase()
  if (name.includes('read') || name.includes('cat') || name.includes('view')) return FileText
  if (name.includes('write') || name.includes('edit') || name.includes('patch') || name.includes('create')) return FolderCog
  if (name.includes('bash') || name.includes('shell') || name.includes('exec') || name.includes('run')) return Terminal
  if (name.includes('search') || name.includes('grep') || name.includes('find') || name.includes('query')) return Search
  return Wrench
}

/**
 * ToolCallCard：工具调用行（对齐 dsh ToolRow）
 *
 * 设计要点（DeepSeek 会话流）：
 *   - 无卡片边框：一条 24px 单行 —— [16px 图标] gap6 [工具名 14/24] · [摘要省略]
 *   - 执行中整行带背景扫光（dsh-sweep-host）
 *   - 展开体：IN/OUT 双段代码卡（r12、代码面填充），diff 紧随其下
 *   - 失败行摘要与 OUT 文本用错误色
 */
export function ToolCallCard({ toolCall, index }: ToolCallCardProps): React.ReactElement {
  const { toolName, status, args, partialResult, startedAt, endedAt, details } = toolCall
  const [expanded, setExpanded] = useState(false)

  const Icon = getToolIcon(toolName)
  const isRunning = status === 'running'
  const isError = status === 'error'

  // 耗时
  const durationMs = startedAt && endedAt ? endedAt - startedAt : null
  const duration =
    durationMs !== null
      ? durationMs < 1000
        ? `${durationMs}ms`
        : `${(durationMs / 1000).toFixed(1)}s`
      : isRunning
        ? '…'
        : null

  // 参数摘要（折叠行的省略文本）
  const argsSummary =
    args === undefined
      ? null
      : typeof args === 'string'
        ? args.slice(0, 120)
        : Object.values(args as Record<string, unknown>)
            .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
            .join(', ')
            .slice(0, 120)

  // 结果摘要
  const resultSummary =
    partialResult === undefined
      ? null
      : typeof partialResult === 'string'
        ? partialResult.slice(0, 160)
        : JSON.stringify(partialResult).slice(0, 160)

  const hasDetails = args !== undefined || partialResult !== undefined

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

  // 折叠行摘要：优先参数，其次结果；失败行用错误色
  const collapsedSummary = isError && resultSummary ? resultSummary : (argsSummary ?? resultSummary)

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
      className={cn('flex min-w-0 flex-col rounded-md', hasDetails && 'cursor-pointer')}
      data-state={status}
      onClick={() => hasDetails && setExpanded(!expanded)}
    >
      {/* 单行折叠头 */}
      <div
        className={cn(
          'dsh-sweep-host -mx-1 flex items-center rounded-md px-1 py-0.5',
          hasDetails && 'transition-colors hover:bg-accent'
        )}
        data-running={isRunning ? 'true' : undefined}
      >
        {/* 引导图标：hover 时切换为展开箭头 */}
        <span className="relative mr-1.5 inline-flex size-4 shrink-0 items-center justify-center text-subtle">
          <Icon
            className={cn(
              'absolute size-3.5 transition-opacity duration-100',
              expanded ? 'opacity-0' : 'group-hover:opacity-0'
            )}
            aria-hidden="true"
          />
          <ChevronRight
            className={cn(
              'absolute size-4 transition-opacity duration-100',
              expanded ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'
            )}
            aria-hidden="true"
          />
          <ChevronDown
            className={cn(
              'absolute size-4 transition-opacity duration-100',
              expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            aria-hidden="true"
          />
        </span>

        {/* 工具名 */}
        <span className="shrink-0 text-sm leading-6 font-normal text-text-secondary">
          {toolName}
        </span>

        {/* 序号 / 耗时 */}
        {index !== undefined && (
          <span className="ml-2 shrink-0 font-mono text-[10px] text-hint">#{index + 1}</span>
        )}
        {duration && (
          <span className="ml-2 shrink-0 font-mono text-[11px] text-hint" aria-label="耗时">
            {duration}
          </span>
        )}

        {/* 分隔点 + 摘要 */}
        {collapsedSummary && (
          <>
            <span className="mx-2 size-0.5 shrink-0 rounded-full bg-hint" aria-hidden="true" />
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm leading-6',
                isError ? 'text-destructive' : 'text-subtle'
              )}
            >
              {collapsedSummary}
            </span>
          </>
        )}
      </div>

      {/* 展开体：IN/OUT 代码卡 */}
      {expanded && hasDetails && (
        <div className="ml-1 flex min-w-0 flex-col">
          {/* 插件贡献的工具详情（keyed slot，按工具名取席位；无贡献时不占空间） */}
          <SlotRenderer
            name="chat.tool.detail"
            entryKey={toolName}
            fallback={null}
            extraProps={{ toolCall }}
          />
          <div className="dsh-io-card">
            {args !== undefined && (
              <div className="dsh-io-section">
                <span className="dsh-io-label">IN</span>
                <pre className="m-0 overflow-x-auto font-[inherit] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  <code className="dsh-io-text block">
                    {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
                  </code>
                </pre>
              </div>
            )}
            {args !== undefined && partialResult !== undefined && (
              <div className="dsh-io-divider" />
            )}
            {partialResult !== undefined && (
              <div className="dsh-io-section">
                <span className="dsh-io-label">OUT</span>
                <pre className="m-0 overflow-x-auto font-[inherit] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  <code className="dsh-io-text block" data-error={isError || undefined}>
                    {typeof partialResult === 'string'
                      ? partialResult
                      : JSON.stringify(partialResult, null, 2)}
                  </code>
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 改动 diff：不依赖展开态，直接展示在行下方（改了什么最重要） */}
      {diffText && (
        <div className="ml-1 mt-1 mb-0.5 min-w-0 pr-1">
          <FileDiffView
            diff={diffText}
            filePath={diffFilePath}
            truncated={details?.diffTruncated === true}
          />
        </div>
      )}
    </motion.div>
  )
}
