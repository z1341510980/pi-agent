import { useState, useRef, useCallback, type KeyboardEvent, type ReactElement } from 'react'
import { Send, Square, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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
}

/**
 * ConversationInput：简化版对话输入区
 *
 * 从 chat 的 input-area 提取，去掉附件、斜杠命令、@引用、模型选择、权限模式。
 * - 自适应高度（1-8 行，最大 200px）
 * - Enter 发送，Shift+Enter 换行
 * - 运行中显示停止按钮（红色），非运行时显示发送按钮
 * - showStart 时显示"开始"按钮（用于流程未启动）
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
}: ConversationInputProps): ReactElement {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isRunning || disabled) return
    onSend(trimmed)
    setText('')
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, isRunning, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    [isRunning, onAbort, showStart, onStart, handleSend],
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
          'relative rounded-[12px] border-2 bg-input-bg transition-colors',
          'border-border focus-within:border-primary',
        )}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            handleInput()
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
