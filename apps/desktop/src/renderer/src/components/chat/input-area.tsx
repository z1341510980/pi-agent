import { useState, useRef, useCallback, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface InputAreaProps {
  /** 发送消息（非运行状态） */
  onSend: (text: string) => void
  /** 中断当前 run */
  onAbort: () => void
  /** 是否正在运行 */
  isRunning: boolean
  /** 禁用输入 */
  disabled?: boolean
  /** 占位符 */
  placeholder?: string
  /** 受控输入值 */
  value?: string
  /** 输入变化 */
  onChange?: (text: string) => void
}

/**
 * InputArea：消息输入区
 *
 * 交互：
 *   - Enter 发送，Shift+Enter 换行
 *   - 运行中：发送按钮变为中断按钮（红色）
 *   - 空消息禁用发送
 *   - 自适应高度（3-8 行）
 */
export function InputArea({
  onSend,
  onAbort,
  isRunning,
  disabled = false,
  placeholder = '询问 PI Agent...',
  value,
  onChange
}: InputAreaProps) {
  const [internalText, setInternalText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const text = value ?? internalText

  const updateText = useCallback(
    (nextText: string) => {
      if (value === undefined) {
        setInternalText(nextText)
      }
      onChange?.(nextText)
    },
    [onChange, value]
  )

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isRunning || disabled) return
    onSend(trimmed)
    updateText('')
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, isRunning, disabled, onSend, updateText])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (isRunning) {
          onAbort()
        } else {
          handleSend()
        }
      }
    },
    [isRunning, onAbort, handleSend]
  )

  // 自适应高度
  const handleInput = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  const canSend = text.trim().length > 0 && !disabled

  return (
    <form
      className="grid gap-2.5 border-t border-border px-5 py-3.5"
      aria-label="发送消息"
      onSubmit={(e) => {
        e.preventDefault()
        handleSend()
      }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={3}
        disabled={disabled}
        className={cn(
          'w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50'
        )}
        aria-label="消息输入"
        onChange={(e) => {
          updateText(e.target.value)
          handleInput()
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
        {isRunning ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onAbort}
            className="gap-1.5"
          >
            <Square className="h-3.5 w-3.5" />
            中断
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={!canSend} className="gap-1.5">
            <Send className="h-3.5 w-3.5" />
            发送
          </Button>
        )}
      </div>
    </form>
  )
}
