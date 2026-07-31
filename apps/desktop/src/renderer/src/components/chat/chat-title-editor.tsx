import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ChatTitleEditorProps {
  /** 当前标题文本 */
  title: string
  /** 提交新标题时的回调 */
  onRename: (newTitle: string) => void
  /** 是否允许重命名（默认 true） */
  canRename?: boolean
  /** 标题最大长度（默认 120） */
  maxLength?: number
  /** 输入框 placeholder */
  placeholder?: string
  /** 标题前导节点（一般为 AgentLogoIcon / AgentSwitcher） */
  leading?: ReactNode
  /** 标题下方副标题（一般为模型 · 同步时间） */
  subtitle?: ReactNode
  /** 额外 className */
  className?: string
}

/**
 * ChatTitleEditor：会话标题内联重命名组件
 *
 * 默认以 span 形式展示标题，双击或回车进入编辑态；
 * Enter / blur 提交，Esc 取消。编辑态切换为透明背景的 input，
 * 自动聚焦并全选文本。
 *
 * - 视觉：hover 时显示淡色背景作为可编辑提示
 * - 交互：双击进入编辑、Enter 提交、Esc 取消、blur 提交
 * - 可访问性：role=button + tabIndex + 键盘 Enter/Space 进入编辑
 */
export function ChatTitleEditor({
  title,
  onRename,
  canRename = true,
  maxLength = 120,
  placeholder,
  leading,
  subtitle,
  className,
}: ChatTitleEditorProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)

  // 非编辑态下保持 draft 与 title 同步
  useEffect(() => {
    if (!editing) setDraft(title)
  }, [title, editing])

  // 进入编辑态时聚焦并全选
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const submit = () => {
    const trimmed = draft.trim()
    if (canRename && trimmed && trimmed !== title) {
      onRename(trimmed)
    } else {
      setDraft(title)
    }
    setEditing(false)
  }

  const cancel = () => {
    setDraft(title)
    setEditing(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  // ── 编辑态：透明背景 input，禁用窗口拖拽以允许选中文本 ──
  if (editing && canRename) {
    return (
      <div className={cn('flex items-center gap-2 min-w-0', className)}>
        {leading && <div className="flex-shrink-0">{leading}</div>}
        <div className="flex flex-col min-w-0 flex-1">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={submit}
            maxLength={maxLength}
            placeholder={placeholder}
            aria-label="会话标题"
            className={cn(
              'h-7 w-full min-w-0 rounded-md border-none bg-surface-3 px-2 py-0',
              'text-base font-semibold text-text shadow-none outline-none',
              'focus-visible:ring-0 [webkit-app-region:no-drag]',
            )}
          />
          {subtitle && (
            <div className="text-xs text-subtle truncate px-2 mt-0.5">{subtitle}</div>
          )}
        </div>
      </div>
    )
  }

  // ── 展示态：leading + 标题 + 副标题 ──
  return (
    <div className={cn('flex items-center gap-2 min-w-0', className)}>
      {leading && <div className="flex-shrink-0">{leading}</div>}
      <div className="flex flex-col min-w-0 flex-1">
        <span
          className={cn(
            'block truncate rounded-md px-2 -mx-2 py-0.5 -my-0.5',
            'text-base font-semibold text-text transition-colors [webkit-app-region:no-drag]',
            canRename && 'cursor-text hover:bg-surface-3 focus:bg-surface-3 focus:outline-none',
          )}
          onDoubleClick={() => {
            if (canRename) setEditing(true)
          }}
          role={canRename ? 'button' : undefined}
          tabIndex={canRename ? 0 : undefined}
          title={canRename ? '双击重命名' : undefined}
          onKeyDown={(e) => {
            if (!canRename) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setEditing(true)
            }
          }}
        >
          {title}
        </span>
        {subtitle && (
          <div className="text-xs text-subtle truncate px-2 -mx-2 mt-0.5 [webkit-app-region:no-drag]">
            {subtitle}
          </div>
        )}
      </div>
    </div>
  )
}
