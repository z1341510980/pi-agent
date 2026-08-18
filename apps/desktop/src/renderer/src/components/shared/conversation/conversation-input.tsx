import { useState, useRef, useCallback, type KeyboardEvent, type ReactElement } from 'react'
import { Send, Square, Play, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { NovelStyleExpert } from '@repo/shared/novel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** 可被 @ 提及的对象（如 agent） */
export interface MentionOption {
  id: string
  label: string
  description?: string
}

/** 斜杠命令候选项 */
export interface CommandOption {
  id: string
  label: string
  description?: string
  insertText: string
}

export interface ConversationInputProps {
  /** 发送消息 */
  onSend: (text: string) => void
  /** 中断当前运行 */
  onAbort: () => void
  /** 是否正在运行 */
  isRunning?: boolean
  /** 运行中是否仍允许发送消息；启用后会同时显示发送与停止按钮 */
  allowSendWhileRunning?: boolean
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
  /** 输入 / 时显示的命令候选 */
  commandOptions?: CommandOption[]
  /** 当前章节本轮可召集的文风专家 */
  styleExperts?: NovelStyleExpert[]
  selectedStyleExpertIds?: string[]
  onStyleExpertsChange?: (expertIds: string[]) => void
  onOpenStyleExperts?: () => void
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
  isRunning = false,
  allowSendWhileRunning = false,
  disabled = false,
  placeholder = '输入消息...',
  startLabel = '开始',
  showStart = false,
  onStart,
  mentionOptions,
  onSendWithMentions,
  commandOptions,
  styleExperts,
  selectedStyleExpertIds = [],
  onStyleExpertsChange,
  onOpenStyleExperts,
}: ConversationInputProps): ReactElement {
  const [text, setText] = useState('')
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionedIdsRef = useRef<Set<string>>(new Set())

  const filteredMentions =
    mentionOpen && mentionOptions && mentionOptions.length > 0
      ? mentionOptions.filter((opt) =>
          opt.label.toLowerCase().includes(mentionQuery.toLowerCase()),
        )
      : []

  const filteredCommands =
    commandOpen && commandOptions && commandOptions.length > 0
      ? commandOptions.filter((command) => {
          const query = text.trim().slice(1).toLowerCase()
          return `${command.label} ${command.description ?? ''} ${command.insertText}`
            .toLowerCase()
            .includes(query)
        })
      : []

  const selectCommand = useCallback((command: CommandOption) => {
    setText(command.insertText)
    setCommandOpen(false)
    setCommandIndex(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(command.insertText.length, command.insertText.length)
    })
  }, [])

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
    if (!trimmed || (isRunning && !allowSendWhileRunning) || disabled) return
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
  }, [text, isRunning, allowSendWhileRunning, disabled, onSend, onSendWithMentions])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const typedCommandIsComplete = filteredCommands.some(
        (command) => command.insertText.trim() === text.trim(),
      )
      if (commandOpen && filteredCommands.length > 0 && !typedCommandIsComplete) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setCommandIndex((i) => (i + 1) % filteredCommands.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setCommandIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
          return
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          selectCommand(filteredCommands[commandIndex]!)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setCommandOpen(false)
          return
        }
      }

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
        if (isRunning && !allowSendWhileRunning) {
          onAbort()
        } else if (!isRunning && showStart && !text.trim()) {
          // 空闲态无文本：直接开始；有文本则进入 handleSend 走命令解析（如 /写 N）
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
      commandOpen,
      filteredCommands,
      commandIndex,
      selectCommand,
      text,
      isRunning,
      allowSendWhileRunning,
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
        if ((!isRunning || allowSendWhileRunning) && !showStart) handleSend()
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

        {commandOpen && filteredCommands.length > 0 && (
          <div
            role="listbox"
            aria-label="可用命令"
            className={cn(
              'absolute bottom-full left-0 mb-1 w-72 max-h-64 overflow-y-auto',
              'rounded-lg border border-border bg-surface-1 shadow-lg',
            )}
          >
            {filteredCommands.map((command, idx) => (
              <div
                key={command.id}
                role="option"
                aria-selected={idx === commandIndex}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectCommand(command)
                }}
                onMouseEnter={() => setCommandIndex(idx)}
                className={cn(
                  'cursor-pointer px-3 py-2 text-xs hover:bg-surface-2',
                  idx === commandIndex && 'bg-surface-2',
                )}
              >
                <div className="font-medium text-text">{command.label}</div>
                {command.description ? <div className="text-subtle">{command.description}</div> : null}
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
            if (commandOptions && newValue.trimStart().startsWith('/')) {
              setCommandOpen(true)
              setCommandIndex(0)
            } else {
              setCommandOpen(false)
            }
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
            setTimeout(() => setCommandOpen(false), 150)
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
          <div className="flex min-w-0 items-center gap-2">
            {styleExperts ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 rounded-md px-2 text-[11px]" title="召集文风专家团">
                    <span className="flex -space-x-1">
                    {styleExperts.filter((expert) => selectedStyleExpertIds.includes(expert.id)).slice(0, 3).map((expert) => (
                        <span key={expert.id} className="flex size-4 items-center justify-center rounded-full border border-background bg-primary/15 text-[9px] text-primary">
                          {expert.name.slice(0, 1)}
                        </span>
                      ))}
                    </span>
                    <span>文风专家团</span>
                    <span className="text-muted-foreground">{selectedStyleExpertIds.length}/{styleExperts.length}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" className="w-80 p-3">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-text">本轮召集文风专家</div>
                      <div className="mt-1 text-[10px] text-muted-foreground">选择参与当前聊天或创作任务的专家</div>
                    </div>
                    <Button type="button" size="icon-sm" variant="ghost" onClick={onOpenStyleExperts} title="管理专家团">
                      <Settings2 className="size-3.5" />
                    </Button>
                  </div>
                  <div className="space-y-1">
                    {styleExperts.map((expert) => {
                      const selected = selectedStyleExpertIds.includes(expert.id)
                      return (
                        <button
                          key={expert.id}
                          type="button"
                          className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors', selected ? 'bg-primary/10' : 'hover:bg-surface-2')}
                          onClick={() => onStyleExpertsChange?.(selected ? selectedStyleExpertIds.filter((id) => id !== expert.id) : [...selectedStyleExpertIds, expert.id])}
                        >
                          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-xs', selected ? 'bg-primary text-primary-foreground' : 'bg-surface-3 text-text')}>{expert.name.slice(0, 1)}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-medium text-text">{expert.name}</span>
                            <span className="block truncate text-[10px] text-muted-foreground">{expert.sourceTitle}</span>
                          </span>
                          <span className={cn('text-[10px]', selected ? 'text-primary' : 'text-muted-foreground')}>{selected ? '本轮参与' : '未召集'}</span>
                        </button>
                      )
                    })}
                    {styleExperts.length === 0 && <div className="rounded-md border border-dashed border-border p-3 text-center text-[11px] text-muted-foreground">还没有文风专家，点击右上角管理按钮创建。</div>}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
            <span className="hidden text-xs text-hint md:inline">Enter 发送 · Shift+Enter 换行</span>
          </div>

          {/* 右侧：发送 / 开始 / 停止 */}
          <div className="flex items-center gap-2">
            {isRunning && allowSendWhileRunning ? (
              <Button
                type="submit"
                size="icon"
                disabled={!canSend}
                className="rounded-full size-8 bg-primary text-primary-foreground hover:bg-primary/90"
                aria-label="发送"
              >
                <Send className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
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
                onClick={() => (text.trim() ? handleSend() : onStart?.())}
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
