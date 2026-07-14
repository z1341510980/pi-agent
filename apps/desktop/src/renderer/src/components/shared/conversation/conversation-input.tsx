import { useState, useRef, useCallback, type KeyboardEvent, type ReactElement } from 'react'
import { Send, Square, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 可被 @ 提及的对象（如 agent） */
export interface MentionOption {
  id: string
  label: string
  description?: string
}

export interface ConversationInputProps {
  /** 发送消息 */
  onSend: (text: string) => void
  /** 中断当前运行 */
  onAbort: () => void
  /** 是否正在运行 */
  isRunning: boolean
  /** 禁用输入 */
  disabled?: boolean
  /** 占位符 */
  placeholder?: string
  /** 开始按钮文案（非 running 时显示为"开始"而非"发送"） */
  startLabel?: string
  /** 是否显示开始按钮（而非发送），用于流程未启动时 */
  showStart?: boolean
  /** 开始回调（showStart 为 true 时触发） */
  onStart?: () => void
  /** 可被 @ 提及的候选项；提供后输入 @ 将触发下拉 */
  mentionOptions?: MentionOption[]
  /** 带提及 ID 的发送回调；提供后将替代 onSend 调用 */
  onSendWithMentions?: (text: string, mentionedIds: string[]) => void
}

/**
 * 检测光标前是否存在 @ 提及触发：
 * 找到光标前最后一个 @，要求该 @ 位于文本开头或空白符之后，
 * 且 @ 与光标之间没有空白符。返回该 @ 的起始位置与查询串。
 */
function detectMention(
  text: string,
  cursorPos: number,
): { start: number; query: string } | null {
  const before = text.slice(0, cursorPos)
  const match = before.match(/(^|\s)@([^\s]*)$/)
  if (!match) return null
  const atStart = (match.index ?? 0) + match[1].length
  return { start: atStart, query: match[2] }
}

/**
 * ConversationInput：简化版对话输入区
 *
 * 从 chat 的 input-area 提取，去掉附件、斜杠命令、@引用、模型选择、权限模式。
 * - 自适应高度（1-8 行，最大 200px）
 * - Enter 发送，Shift+Enter 换行
 * - 运行中显示停止按钮（红色），非运行时显示发送按钮
 * - showStart 时显示"开始"按钮（用于流程未启动）
 * - 可选 @ 提及：传入 mentionOptions 后，输入 @ 触发下拉选择 agent
 */
export function ConversationInput({
  onSend,
  onAbort,
  isRunning,
  disabled = false,
  placeholder = '输入消息...',
  startLabel = '开始',
  showStart = false,
  onStart,
  mentionOptions,
  onSendWithMentions,
}: ConversationInputProps): ReactElement {
  const [text, setText] = useState('')
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionedIdsRef = useRef<Set<string>>(new Set())

  const filteredMentions =
    mentionOpen && mentionOptions && mentionOptions.length > 0
      ? mentionOptions.filter((opt) =>
          opt.label.toLowerCase().includes(mentionQuery.toLowerCase()),
        )
      : []

  const selectMention = useCallback(
    (agent: MentionOption) => {
      const el = textareaRef.current
      if (!el) return
      const cursorPos = el.selectionStart ?? text.length
      const detection = detectMention(text, cursorPos)
      if (!detection) return
      const before = text.slice(0, detection.start)
      const after = text.slice(cursorPos)
      const insertText = `@${agent.label} `
      const newText = before + insertText + after
      setText(newText)
      mentionedIdsRef.current.add(agent.id)
      setMentionOpen(false)
      setMentionQuery('')
      setMentionIndex(0)
      const newCursorPos = before.length + insertText.length
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
        }
      })
    },
    [text],
  )

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isRunning || disabled) return
    if (onSendWithMentions) {
      onSendWithMentions(trimmed, Array.from(mentionedIdsRef.current))
    } else {
      onSend(trimmed)
    }
    mentionedIdsRef.current.clear()
    setMentionOpen(false)
    setMentionQuery('')
    setMentionIndex(0)
    setText('')
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, isRunning, disabled, onSend, onSendWithMentions])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // 提及下拉导航：方向键 / Enter 选中 / Esc 关闭
      if (mentionOpen && filteredMentions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setMentionIndex((i) => (i + 1) % filteredMentions.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setMentionIndex(
            (i) => (i - 1 + filteredMentions.length) % filteredMentions.length,
          )
          return
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          selectMention(filteredMentions[mentionIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setMentionOpen(false)
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (isRunning) {
          onAbort()
        } else if (showStart) {
          onStart?.()
        } else {
          handleSend()
        }
      }
    },
    [
      mentionOpen,
      filteredMentions,
      mentionIndex,
      selectMention,
      isRunning,
      onAbort,
      showStart,
      onStart,
      handleSend,
    ],
  )

  // 自适应高度（1-8 行，最大 200px）
  const handleInput = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  const canSend = text.trim().length > 0 && !disabled

  return (
    <form
      className="px-2 pb-2 pt-2 transition-colors"
      aria-label="发送消息"
      onSubmit={(e) => {
        e.preventDefault()
        if (!isRunning && !showStart) handleSend()
      }}
    >
      <div
        className={cn(
          // 与 HTML 样例对齐：1px 边框 + 圆角 + focus 时主色边框 + 3px 外发光阴影
          'relative rounded-[10px] border bg-input-bg transition-[border-color,box-shadow] duration-150 ease-out',
          'border-border focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgb(99_102_241_/_0.08)]',
        )}
      >
        {/* @ 提及下拉：定位在 textarea 上方 */}
        {mentionOpen && filteredMentions.length > 0 && (
          <div
            role="listbox"
            aria-label="可提及的 agent"
            className={cn(
              'absolute bottom-full left-0 mb-1 w-56 max-h-48 overflow-y-auto',
              'rounded-lg border border-border bg-surface-1 shadow-lg',
            )}
          >
            {filteredMentions.map((agent, idx) => (
              <div
                key={agent.id}
                role="option"
                aria-selected={idx === mentionIndex}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectMention(agent)
                }}
                onMouseEnter={() => setMentionIndex(idx)}
                className={cn(
                  'px-3 py-2 text-xs cursor-pointer hover:bg-surface-2',
                  idx === mentionIndex && 'bg-surface-2',
                )}
              >
                <div className="font-medium text-text">{agent.label}</div>
                {agent.description ? (
                  <div className="text-subtle">{agent.description}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          onChange={(e) => {
            const newValue = e.target.value
            setText(newValue)
            handleInput()
            if (mentionOptions && mentionOptions.length > 0) {
              const cursorPos = e.target.selectionStart ?? newValue.length
              const detection = detectMention(newValue, cursorPos)
              if (detection) {
                setMentionQuery(detection.query)
                setMentionOpen(true)
                setMentionIndex(0)
              } else {
                setMentionOpen(false)
              }
            }
          }}
          onBlur={() => {
            // 延迟关闭，避免点击下拉项时先触发 blur
            setTimeout(() => setMentionOpen(false), 150)
          }}
          className={cn(
            'w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed',
            'text-text placeholder:text-hint',
            'focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label="消息输入"
        />

        {/* 底部工具栏 */}
        <div className="flex items-center justify-between gap-2 px-4 pb-3">
          {/* 左侧：快捷键提示 */}
          <span className="hidden text-xs text-hint md:inline">
            Enter 发送 · Shift+Enter 换行
          </span>

          {/* 右侧：发送 / 开始 / 停止 */}
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                onClick={onAbort}
                className="rounded-full size-8 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                aria-label="停止"
              >
                <Square className="size-4" aria-hidden="true" />
              </Button>
            ) : showStart ? (
              <Button
                type="button"
                size="sm"
                onClick={() => onStart?.()}
                disabled={disabled}
                aria-label={startLabel}
              >
                <Play className="size-4" aria-hidden="true" />
                {startLabel}
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!canSend}
                className="rounded-full size-8 bg-primary text-primary-foreground hover:bg-primary/90"
                aria-label="发送"
              >
                <Send className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  )
}
