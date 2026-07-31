import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type KeyboardEvent,
  type ReactElement,
  type DragEvent,
  type ClipboardEvent
} from 'react'
import { ArrowUp, Square, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { type ModelOption, ModelSelector } from './model-selector'
import { FileAttachmentList, type FileAttachment } from './file-attachment'
import { PermissionModeSwitch } from './permission-mode-switch'
import { SlashCommandPanel } from './slash-command-panel'
import { MentionPanel } from './mention-panel'
import type { SessionSummary } from './session-list'
import type { FilePreviewState } from '@/stores/ui-store'

export interface InputAreaProps {
  /** 发送消息（非运行状态） */
  onSend: (text: string, attachments?: FileAttachment[]) => void
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
  /** 可选模型列表 */
  models?: ModelOption[]
  /** 当前选中模型，格式 `${provider}:${id}`；null 表示未选中 */
  selectedModel?: string | null
  /** 模型变化回调 */
  onModelChange?: (provider: string, modelId: string) => void
  /** 可引用的会话列表（@ 功能） */
  sessions?: SessionSummary[]
  /** 当前活跃会话 ID */
  activeSessionId?: string
  /** 附件预览回调 */
  onFilePreview?: (file: FilePreviewState) => void
}

/** 单行模式最大字符数（超过则切换多行） */
const MAX_SINGLE_LINE_CHARACTERS = 200
/** 单行模式最大宽度（px），超过则切换多行 */
const SINGLE_LINE_MAX_WIDTH = 720

/** 根据文件名推断 MIME 类型 */
function inferMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon'
  }
  return map[ext] ?? 'application/octet-stream'
}

/** 判断是否为图片 MIME 类型 */
function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

/**
 * InputArea：消息输入区（对齐 AionUi SendBox 设计）
 *
 * 设计要点：
 *   - 单行/多行自适应：文本含 \n 或超过 MAX_SINGLE_LINE_CHARACTERS 自动切多行
 *   - 单行布局：[左侧工具栏] [textarea flex-1] [发送/中断按钮]
 *   - 多行布局：[textarea 全宽] 行 + [左侧工具栏] [右侧工具栏 + 发送按钮] 行
 *   - 焦点环：聚焦时紫色 1px 边框 + 紫色光晕（box-shadow），过渡 200ms
 *   - 拖拽态：虚线边框 + 主色浅色背景
 *   - 附件预览在 textarea 上方（prefix 区）
 *   - 工具栏：Paperclip 左侧 / 模型选择 + 权限模式右侧
 *
 * 交互：
 *   - Enter 发送，Shift+Enter 换行（IME 合成中不触发）
 *   - / 唤起斜杠命令面板，@ 唤起会话引用面板
 *   - 拖拽文件到输入区，Ctrl+V 粘贴图片
 */
export function InputArea({
  onSend,
  onAbort,
  isRunning,
  disabled = false,
  placeholder = '今天帮你做些什么？ / 调用技能，@ 引用会话',
  value,
  onChange,
  models = [],
  selectedModel = null,
  onModelChange,
  sessions = [],
  activeSessionId = '',
  onFilePreview
}: InputAreaProps): ReactElement {
  const [internalText, setInternalText] = useState('')
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [slashPanelOpen, setSlashPanelOpen] = useState(false)
  const [mentionPanelOpen, setMentionPanelOpen] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const text = value ?? internalText

  // ── 单行/多行模式判定（对齐 AionUi 逻辑） ──
  const isSingleLine = text.length <= MAX_SINGLE_LINE_CHARACTERS && !text.includes('\n')

  const updateText = useCallback(
    (nextText: string) => {
      if (value === undefined) {
        setInternalText(nextText)
      }
      onChange?.(nextText)
    },
    [onChange, value]
  )

  /** 添加附件到列表 */
  const addAttachments = useCallback((files: Array<{ path: string; name: string }>) => {
    const newAttachments: FileAttachment[] = files.map((f) => {
      const mimeType = inferMimeType(f.name)
      return {
        id: crypto.randomUUID(),
        name: f.name,
        path: f.path,
        size: 0,
        type: isImageMime(mimeType) ? 'image' : 'file',
        mimeType
      }
    })
    setAttachments((prev) => [...prev, ...newAttachments])

    for (const att of newAttachments) {
      if (window.api?.file) {
        window.api.file.read(att.path).then((result) => {
          if (result.ok && result.content) {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === att.id
                  ? {
                      ...a,
                      content: result.content,
                      encoding: result.encoding,
                      size: result.size ?? 0,
                      ...(a.type === 'image' && result.encoding === 'base64'
                        ? { thumbnail: `data:${a.mimeType};base64,${result.content}` }
                        : {})
                    }
                  : a
              )
            )
          }
        })
      }
    }
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleAttachClick = useCallback(async () => {
    if (!window.api?.file) return
    try {
      const result = await window.api.file.select()
      if (!result.canceled && result.files.length > 0) {
        addAttachments(result.files)
      }
    } catch {
      // 静默失败
    }
  }, [addAttachments])

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return
      const fileEntries = files
        .map((f) => {
          const filePath = (f as File & { path?: string }).path
          if (filePath) return { path: filePath, name: f.name }
          return null
        })
        .filter((f): f is { path: string; name: string } => f !== null)
      if (fileEntries.length > 0) addAttachments(fileEntries)
    },
    [addAttachments]
  )

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageFiles: Array<{ path: string; name: string }> = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            const filePath = (file as File & { path?: string }).path
            if (filePath) {
              imageFiles.push({
                path: filePath,
                name: file.name || `pasted-image-${Date.now()}.png`
              })
            }
          }
        }
      }
      if (imageFiles.length > 0) addAttachments(imageFiles)
    },
    [addAttachments]
  )

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || isRunning || disabled) return
    onSend(trimmed, attachments.length > 0 ? attachments : undefined)
    updateText('')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, attachments, isRunning, disabled, onSend, updateText])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // 浮层面板打开时拦截导航键
      if (slashPanelOpen || mentionPanelOpen) {
        if (
          e.key === 'ArrowDown' ||
          e.key === 'ArrowUp' ||
          e.key === 'Enter' ||
          e.key === 'Escape'
        ) {
          e.preventDefault()
          return
        }
      }
      // IME 合成中不触发 Enter 发送
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (isRunning) onAbort()
        else handleSend()
      }
    },
    [isRunning, onAbort, handleSend, slashPanelOpen, mentionPanelOpen]
  )

  // 自适应高度（多行模式）
  useEffect(() => {
    const el = textareaRef.current
    if (!el || isSingleLine) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text, isSingleLine])

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled

  return (
    <form
      className="pi-input-dock px-5 pb-4 pt-3 transition-colors"
      aria-label="发送消息"
      onSubmit={(e) => {
        e.preventDefault()
        handleSend()
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 输入卡片容器：圆角 20px，紫色聚焦光环，拖拽态虚线边框 */}
      <div
        data-tour="input-card"
        data-focused={isFocused ? 'true' : undefined}
        data-dragging={isDragOver ? 'true' : undefined}
        className={cn(
          'pi-input-card relative rounded-[20px] border bg-input-bg transition-[border-color,box-shadow,background-color] duration-200',
          isDragOver
            ? 'border-primary border-dashed bg-primary/5'
            : isFocused
              ? 'border-primary'
              : 'border-transparent'
        )}
      >
        {/* ── 浮层面板（绝对定位在 textarea 上方） ── */}
        {slashPanelOpen && (
          <div className="absolute left-3 right-3 bottom-[calc(100%+8px)] z-50">
            <SlashCommandPanel
              query={(() => {
                const slashIdx = text.lastIndexOf('/')
                if (slashIdx === -1) return ''
                const after = text.slice(slashIdx + 1)
                const spaceIdx = after.search(/[\s\n]/)
                return spaceIdx === -1 ? after : after.slice(0, spaceIdx)
              })()}
              onSelect={(insertText) => {
                const slashIdx = text.lastIndexOf('/')
                if (slashIdx === -1) {
                  updateText(insertText)
                } else {
                  const before = text.slice(0, slashIdx)
                  const afterSlash = text.slice(slashIdx + 1)
                  const spaceIdx = afterSlash.search(/[\s\n]/)
                  const after = spaceIdx === -1 ? '' : afterSlash.slice(spaceIdx)
                  updateText(`${before}${insertText}${after}`)
                }
                setSlashPanelOpen(false)
                textareaRef.current?.focus()
              }}
              onClose={() => setSlashPanelOpen(false)}
            />
          </div>
        )}

        {mentionPanelOpen && (
          <div className="absolute left-3 right-3 bottom-[calc(100%+8px)] z-50">
            <MentionPanel
              query={(() => {
                const atIdx = text.lastIndexOf('@')
                if (atIdx === -1) return ''
                const after = text.slice(atIdx + 1)
                const spaceIdx = after.search(/[\s\n]/)
                return spaceIdx === -1 ? after : after.slice(0, spaceIdx)
              })()}
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={(insertText, _session) => {
                const atIdx = text.lastIndexOf('@')
                if (atIdx === -1) return
                const before = text.slice(0, atIdx)
                const afterAt = text.slice(atIdx + 1)
                const spaceIdx = afterAt.search(/[\s\n]/)
                const after = spaceIdx === -1 ? '' : afterAt.slice(spaceIdx)
                updateText(`${before}${insertText}${after}`)
                setMentionPanelOpen(false)
                // 下一帧恢复焦点并定位光标到插入文本末尾
                requestAnimationFrame(() => {
                  const ta = textareaRef.current
                  if (!ta) return
                  ta.focus()
                  const caret = before.length + insertText.length
                  ta.setSelectionRange(caret, caret)
                })
              }}
              onClose={() => setMentionPanelOpen(false)}
            />
          </div>
        )}

        {/* ── prefix 区：附件预览（textarea 上方） ── */}
        {attachments.length > 0 && (
          <div className="px-3 pt-3">
            <FileAttachmentList
              attachments={attachments}
              removable
              onRemove={handleRemoveAttachment}
              onPreview={
                onFilePreview
                  ? (att) =>
                      onFilePreview({
                        name: att.name,
                        content: att.content,
                        encoding: att.encoding,
                        mimeType: att.mimeType,
                        thumbnail: att.thumbnail,
                        size: att.size,
                        type: att.type
                      })
                  : undefined
              }
            />
          </div>
        )}

        {/* ── 主输入行：单行模式 [tools][textarea][sendBtn]，多行模式 [textarea] ── */}
        <div
          className={cn(
            'flex w-full min-w-0 overflow-hidden',
            isSingleLine ? 'items-center gap-2 px-3 py-2.5' : 'flex-col px-3 pt-3'
          )}
          style={{ maxWidth: isSingleLine ? '100%' : `${SINGLE_LINE_MAX_WIDTH}px` }}
        >
          {/* 单行模式：左侧工具栏 */}
          {isSingleLine && (
            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                type="button"
                className={cn(
                  'inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
                  'text-subtle hover:bg-surface-3 hover:text-text',
                  'transition-[background-color,color,transform] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50'
                )}
                onClick={() => void handleAttachClick()}
                disabled={disabled}
                aria-label="添加附件"
              >
                <Paperclip className="size-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* textarea 主体 */}
          <textarea
            ref={textareaRef}
            id="message-input"
            value={text}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={placeholder}
            rows={1}
            disabled={disabled}
            className={cn(
              'w-full resize-none bg-transparent text-sm leading-relaxed',
              'text-text placeholder:text-hint',
              'focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              isSingleLine ? 'px-0 py-0' : 'px-0 pb-2'
            )}
            style={{
              height: isSingleLine ? '20px' : 'auto',
              minHeight: isSingleLine ? '20px' : '40px',
              maxHeight: '240px',
              overflowY: isSingleLine ? 'hidden' : 'auto',
              whiteSpace: isSingleLine ? 'nowrap' : 'pre-wrap',
              textOverflow: isSingleLine ? 'ellipsis' : 'clip',
              wordBreak: isSingleLine ? 'normal' : 'break-word',
              flex: isSingleLine ? 1 : 'none',
              minWidth: 0
            }}
            aria-label="消息输入"
            onChange={(e) => {
              const newValue = e.target.value
              updateText(newValue)

              const lastChar = newValue[newValue.length - 1]
              if (lastChar === '/') {
                const beforeSlash = newValue.slice(0, -1)
                if (
                  beforeSlash.trim() === '' ||
                  beforeSlash.endsWith(' ') ||
                  beforeSlash.endsWith('\n')
                ) {
                  setSlashPanelOpen(true)
                  setMentionPanelOpen(false)
                }
              }
              if (lastChar === '@') {
                const beforeAt = newValue.slice(0, -1)
                if (!beforeAt.endsWith('.') && !beforeAt.match(/[a-zA-Z]$/)) {
                  setMentionPanelOpen(true)
                  setSlashPanelOpen(false)
                }
              }
              if (slashPanelOpen) {
                const slashIdx = newValue.lastIndexOf('/')
                if (slashIdx === -1) {
                  setSlashPanelOpen(false)
                } else {
                  const afterSlash = newValue.slice(slashIdx + 1)
                  if (afterSlash.includes(' ') || afterSlash.includes('\n')) {
                    setSlashPanelOpen(false)
                  }
                }
              }
              if (mentionPanelOpen) {
                const atIdx = newValue.lastIndexOf('@')
                if (atIdx === -1) {
                  setMentionPanelOpen(false)
                } else {
                  const afterAt = newValue.slice(atIdx + 1)
                  if (afterAt.includes(' ') || afterAt.includes('\n')) {
                    setMentionPanelOpen(false)
                  }
                }
              }
            }}
          />

          {/* 单行模式：右侧发送/中断按钮 */}
          {isSingleLine && (
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {isRunning ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  onClick={onAbort}
                  className="abort-breathe rounded-full size-8"
                  aria-label="中断"
                >
                  <Square className="size-3.5" aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={!canSend}
                  className="pi-send-button rounded-full size-8 bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-hint"
                  aria-label="发送"
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        </div>

        {/* ── 多行模式：textarea 下方独立工具栏行 ── */}
        {!isSingleLine && (
          <div className="flex items-center justify-between gap-2 w-full px-3 pb-2.5">
            {/* 左侧：附件按钮 */}
            <div className="flex items-center gap-1 min-w-0">
              <button
                type="button"
                className={cn(
                  'inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
                  'text-subtle hover:bg-surface-3 hover:text-text',
                  'transition-[background-color,color,transform] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50'
                )}
                onClick={() => void handleAttachClick()}
                disabled={disabled}
                aria-label="添加附件"
              >
                <Paperclip className="size-4" aria-hidden="true" />
              </button>
            </div>

            {/* 右侧：权限模式 + 模型选择 + 发送/中断 */}
            <div className="flex items-center gap-2">
              <PermissionModeSwitch compact />
              {models.length > 0 && onModelChange && (
                <ModelSelector
                  models={models}
                  value={selectedModel}
                  onChange={onModelChange}
                  disabled={disabled}
                />
              )}
              {isRunning ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  onClick={onAbort}
                  className="abort-breathe rounded-full size-8"
                  aria-label="中断"
                >
                  <Square className="size-3.5" aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={!canSend}
                  className="pi-send-button rounded-full size-8 bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-hint"
                  aria-label="发送"
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── 单行模式底部工具栏（隐藏式：权限 + 模型选择，浮在右侧不占主行空间） ── */}
        {isSingleLine && (
          <div className="flex items-center justify-end gap-2 px-3 pb-2.5 -mt-0.5">
            <PermissionModeSwitch compact />
            {models.length > 0 && onModelChange && (
              <ModelSelector
                models={models}
                value={selectedModel}
                onChange={onModelChange}
                disabled={disabled}
              />
            )}
          </div>
        )}
      </div>
    </form>
  )
}
