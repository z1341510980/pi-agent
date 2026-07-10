import { useState, type ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BotIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

// ── 类型定义 ──

/** subagent 派遣状态 */
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed'

/** subagent 派遣卡片属性 */
export interface SubagentCardProps {
  /** 目标 Agent ID */
  agentId: string
  /** 目标 Agent 名称（可选，用于显示） */
  agentName?: string
  /** 任务描述 */
  task: string
  /** 执行状态 */
  status: SubagentStatus
  /** 结果摘要（完成时） */
  result?: string
  /** 错误信息（失败时） */
  error?: string
  /** 开始时间 */
  startedAt?: number
  /** 结束时间 */
  endedAt?: number
}

// ── 状态元数据 ──

interface StatusMeta {
  label: string
  dotClass: string
  badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline'
}

const STATUS_META: Record<SubagentStatus, StatusMeta> = {
  pending: {
    label: '等待中',
    dotClass: 'bg-accent shadow-[0_0_0_4px_rgba(242,193,78,0.16)]',
    badgeVariant: 'secondary',
  },
  running: {
    label: '运行中',
    dotClass: 'bg-accent shadow-[0_0_0_4px_rgba(242,193,78,0.16)] animate-pulse',
    badgeVariant: 'default',
  },
  completed: {
    label: '完成',
    dotClass: 'bg-success shadow-[0_0_0_4px_rgba(47,209,124,0.16)]',
    badgeVariant: 'outline',
  },
  failed: {
    label: '失败',
    dotClass: 'bg-danger shadow-[0_0_0_4px_rgba(255,107,107,0.16)]',
    badgeVariant: 'destructive',
  },
}

// ── 工具函数 ──

function formatTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function durationMs(start?: number, end?: number): string {
  if (!start || !end) return ''
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ── 主组件 ──

/**
 * SubagentCard：消息流中显示 subagent 工具调用状态
 *
 * - 显示目标 Agent、任务描述、执行状态
 * - 完成时显示结果摘要
 * - 失败时显示错误信息
 * - 点击展开查看详细结果
 */
export function SubagentCard({
  agentId,
  agentName,
  task,
  status,
  result,
  error,
  startedAt,
  endedAt,
}: SubagentCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const meta = STATUS_META[status]
  const dur = durationMs(startedAt, endedAt)

  const hasDetail = (status === 'completed' && result) || (status === 'failed' && error)

  return (
    <article className="bg-surface-1 border border-border rounded-lg px-3.5 py-3 grid gap-1.5">
      <header className="flex items-center gap-2 min-w-0">
        <span className={`shrink-0 size-[9px] rounded-full ${meta.dotClass}`} />
        <BotIcon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm font-[760] truncate">
          {agentName ?? agentId}
        </span>
        <Badge variant={meta.badgeVariant} className="ml-auto shrink-0">
          {meta.label}
        </Badge>
      </header>

      <p className="text-xs text-muted-foreground m-0 leading-snug">{task}</p>

      {/* 错误信息（失败时直接显示） */}
      {status === 'failed' && error && !expanded && (
        <p className="text-xs text-danger m-0 truncate">{error}</p>
      )}

      {/* 结果摘要（完成时直接显示） */}
      {status === 'completed' && result && !expanded && (
        <p className="text-xs text-muted-foreground m-0 truncate">
          {result.length > 120 ? `${result.slice(0, 120)}...` : result}
        </p>
      )}

      <footer className="flex items-center gap-3 text-subtle text-[11px] font-mono">
        {startedAt && <time>{formatTime(startedAt)}</time>}
        {dur && <span>· {dur}</span>}
        {hasDetail && (
          <button
            type="button"
            className="text-accent hover:underline ml-auto flex items-center gap-0.5"
            onClick={() => setExpanded(!expanded)}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={expanded ? 'collapse' : 'expand'}
                initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="flex items-center gap-0.5"
              >
                {expanded ? (
                  <>
                    收起
                    <ChevronDownIcon className="size-3" />
                  </>
                ) : (
                  <>
                    详情
                    <ChevronRightIcon className="size-3" />
                  </>
                )}
              </motion.span>
            </AnimatePresence>
          </button>
        )}
      </footer>

      {/* 展开详情 */}
      {expanded && hasDetail && (
        <div className="mt-1 p-2.5 rounded-md bg-surface-2 border border-border text-xs font-mono whitespace-pre-wrap break-all max-h-[240px] overflow-y-auto leading-relaxed">
          {status === 'completed' && result && result}
          {status === 'failed' && error && `错误: ${error}`}
        </div>
      )}
    </article>
  )
}
