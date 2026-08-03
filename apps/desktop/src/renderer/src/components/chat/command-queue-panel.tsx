import { useEffect, useRef, useState, type ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ListPlus,
  Pencil,
  Play,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { QueuedCommand } from '@/stores/session-store'
import { cn } from '@/lib/utils'

/**
 * CommandQueuePanel —— 待发消息队列。
 *
 * ## 为什么需要
 *
 * 原来 Agent 忙的时候输入框是"发不出去"的：`handleSend` 里 `if (isRunning) return`，
 * 而 Enter 键更糟 —— `if (isRunning) onAbort()`。**你想到一句后续指令、顺手按下
 * 回车，结果是把正在跑的生成杀掉了。** 这是个真实的踩坑点，不是缺功能。
 *
 * 现在忙时按发送 = 入队，当前轮结束后自动出队发送。
 *
 * ## 出错时不自动出队
 *
 * 如果上一轮是失败结束（API Key 无效、限流、上下文超限），继续自动出队只会
 * 让整个队列以同样的方式连续失败一遍，还白烧 token。所以失败后暂停，
 * 把「继续」交给用户按 —— 他此时通常需要先去改配置。
 */

export interface CommandQueuePanelProps {
  queue: QueuedCommand[]
  /**
   * 上一轮以失败结束。
   *
   * 这种情况下自动出队会让整队以同样方式连续失败一遍还白烧 token，
   * 所以停下来并把原因说出来 —— 否则用户只会觉得「队列卡住了」。
   */
  errorPaused: boolean
  /** 是否显示「继续」按钮（空闲且队列非空时可手动推进） */
  canResume: boolean
  onRemove: (id: string) => void
  onEdit: (id: string, text: string) => void
  onReorder: (ids: string[]) => void
  onClear: () => void
  /** 手动推进一条 */
  onResume: () => void
}

export function CommandQueuePanel({
  queue,
  errorPaused,
  canResume,
  onRemove,
  onEdit,
  onReorder,
  onClear,
  onResume
}: CommandQueuePanelProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)

  // 队列清空后收起，避免下次入队时残留展开态
  useEffect(() => {
    if (queue.length === 0) setExpanded(false)
  }, [queue.length])

  if (queue.length === 0) return null

  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= queue.length) return
    const ids = queue.map((c) => c.id)
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    onReorder(ids)
  }

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-surface-2">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <ListPlus className="size-3.5 shrink-0 text-hint" aria-hidden />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-micro text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="tabular-nums">已排队 {queue.length} 条</span>
          {/* 折叠态给第一条的预览：多数时候用户只想确认"我刚才那句在不在" */}
          {!expanded && (
            <span className="min-w-0 flex-1 truncate text-hint">{queue[0].text}</span>
          )}
          <ChevronDown
            className={cn('size-3 shrink-0 text-hint transition-transform', expanded && 'rotate-180')}
          />
        </button>

        {canResume && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onResume}
            className="h-6 gap-1 px-1.5 text-nano text-primary hover:bg-primary/10"
          >
            <Play className="size-3" />
            继续
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          aria-label="清空队列"
          className="h-6 gap-1 px-1.5 text-nano text-hint hover:bg-surface-3 hover:text-text"
        >
          <Trash2 className="size-3" />
          清空
        </Button>
      </div>

      {/* 失败后暂停的原因要说出来，否则用户只会觉得"队列卡住了" */}
      {errorPaused && (
        <p className="border-t border-border px-2.5 py-1 text-nano leading-relaxed text-hint">
          上一轮失败了，已暂停自动发送 —— 先处理错误再点「继续」，避免整队重复失败。
        </p>
      )}

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="max-h-52 overflow-y-auto border-t border-border"
          >
            {queue.map((item, index) => (
              <QueueRow
                key={item.id}
                item={item}
                index={index}
                total={queue.length}
                onRemove={() => onRemove(item.id)}
                onEdit={(text) => onEdit(item.id, text)}
                onMoveUp={() => move(index, -1)}
                onMoveDown={() => move(index, 1)}
              />
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

function QueueRow({
  item,
  index,
  total,
  onRemove,
  onEdit,
  onMoveUp,
  onMoveDown
}: {
  item: QueuedCommand
  index: number
  total: number
  onRemove: () => void
  onEdit: (text: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const commit = (): void => {
    const next = draft.trim()
    // 空内容视为取消编辑，不静默把排队项变成空消息
    if (next.length > 0 && next !== item.text) onEdit(next)
    setEditing(false)
  }

  return (
    <li className="group/row flex items-start gap-1.5 px-2.5 py-1.5 hover:bg-surface-3/50">
      <span className="mt-0.5 w-4 shrink-0 text-right text-nano tabular-nums text-hint">
        {index + 1}
      </span>

      {editing ? (
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(item.text)
              setEditing(false)
            }
          }}
          rows={2}
          className="min-w-0 flex-1 resize-none rounded-md border border-border bg-surface-1 px-1.5 py-1 text-micro leading-relaxed text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <p className="min-w-0 flex-1 line-clamp-2 text-micro leading-relaxed break-words text-text-secondary">
          {item.text}
        </p>
      )}

      {item.attachments && item.attachments.length > 0 && (
        <span className="mt-0.5 shrink-0 rounded bg-surface-3 px-1 text-nano text-hint">
          {item.attachments.length} 附件
        </span>
      )}

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        {editing ? (
          <RowButton label="确认" onClick={commit}>
            <Check className="size-3" />
          </RowButton>
        ) : (
          <>
            <RowButton label="上移" disabled={index === 0} onClick={onMoveUp}>
              <ArrowUp className="size-3" />
            </RowButton>
            <RowButton label="下移" disabled={index === total - 1} onClick={onMoveDown}>
              <ArrowDown className="size-3" />
            </RowButton>
            <RowButton label="编辑" onClick={() => setEditing(true)}>
              <Pencil className="size-3" />
            </RowButton>
          </>
        )}
        <RowButton label="移除" onClick={onRemove}>
          <X className="size-3" />
        </RowButton>
      </div>
    </li>
  )
}

function RowButton({
  label,
  disabled = false,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactElement
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'rounded p-0.5 text-hint transition-colors hover:bg-surface-3 hover:text-text',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-30 hover:bg-transparent hover:text-hint'
      )}
    >
      {children}
    </button>
  )
}
