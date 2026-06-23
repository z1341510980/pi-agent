import { useState, useRef, useCallback, type KeyboardEvent, type ReactElement, type DragEvent, type ClipboardEvent } from 'react'
import { Send, Square, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { type ModelOption, ModelSelector } from './model-selector'
import { FileAttachmentList, type FileAttachment } from './file-attachment'
import { PermissionModeSwitch } from './permission-mode-switch'

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
}

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
    ico: 'image/x-icon',
  }
  return map[ext] ?? 'application/octet-stream'
}

/** 判断是否为图片 MIME 类型 */
function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

/**
 * InputArea：消息输入区（Craft 风格）
 *
 * 交互：
 *   - Enter 发送，Shift+Enter 换行
 *   - 运行中：发送按钮变为中断按钮（红色圆形）
 *   - 空消息禁用发送
 *   - 自适应高度（1-8 行，最大 200px）
 *   - 附件图标按钮选择文件
 *   - 拖拽文件到输入区
 *   - Ctrl+V 粘贴图片
 */
export function InputArea({
  onSend,
  onAbort,
  isRunning,
  disabled = false,
  placeholder = '输入消息...',
  value,
  onChange,
  models = [],
  selectedModel = null,
  onModelChange,
}: InputAreaProps): ReactElement {
  const [internalText, setInternalText] = useState('')
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
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

  /** 添加附件到列表 */
  const addAttachments = useCallback((files: Array<{ path: string; name: string }>) => {
    const newAttachments: FileAttachment[] = files.map((f) => {
      const mimeType = inferMimeType(f.name)
      return {
        id: crypto.randomUUID(),
        name: f.name,
        path: f.path,
        size: 0, // 将在读取时更新
        type: isImageMime(mimeType) ? 'image' : 'file',
        mimeType,
      }
    })
    setAttachments((prev) => [...prev, ...newAttachments])

    // 异步读取文件内容和大小
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
                      // 图片类型生成缩略图
                      ...(a.type === 'image' && result.encoding === 'base64'
                        ? { thumbnail: `data:${a.mimeType};base64,${result.content}` }
                        : {}),
                    }
                  : a,
              ),
            )
          }
        })
      }
    }
  }, [])

  /** 移除附件 */
  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  /** 附件图标按钮点击 */
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

  /** 拖拽事件处理 */
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

      // 从 Electron 的 file:// 协议中提取路径
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return

      // Electron 的 File 对象有 path 属性
      const fileEntries = files
        .map((f) => {
          // Electron 扩展的 path 属性
          const filePath = (f as File & { path?: string }).path
          if (filePath) {
            return { path: filePath, name: f.name }
          }
          return null
        })
        .filter((f): f is { path: string; name: string } => f !== null)

      if (fileEntries.length > 0) {
        addAttachments(fileEntries)
      }
    },
    [addAttachments],
  )

  /** 粘贴事件处理（支持粘贴图片） */
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
            // Electron 扩展的 path 属性
            const filePath = (file as File & { path?: string }).path
            if (filePath) {
              imageFiles.push({ path: filePath, name: file.name || `pasted-image-${Date.now()}.png` })
            }
          }
        }
      }

      if (imageFiles.length > 0) {
        addAttachments(imageFiles)
      }
    },
    [addAttachments],
  )

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || isRunning || disabled) return
    onSend(trimmed, attachments.length > 0 ? attachments : undefined)
    updateText('')
    setAttachments([])
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, attachments, isRunning, disabled, onSend, updateText])

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

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled

  return (
    <form
      className="px-6 pb-4 pt-2 transition-colors"
      aria-label="发送消息"
      onSubmit={(e) => {
        e.preventDefault()
        handleSend()
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 附件预览 */}
      {attachments.length > 0 && (
        <FileAttachmentList
          attachments={attachments}
          removable
          onRemove={handleRemoveAttachment}
        />
      )}

      {/* 输入卡片：白色圆角大输入框，聚焦态 2px 紫色边框 */}
      <div
        className={cn(
          'relative rounded-[12px] border-2 bg-input-bg transition-all',
          'border-border focus-within:border-primary',
          isDragOver && 'border-primary/50',
        )}
      >
        <textarea
          ref={textareaRef}
          id="message-input"
          value={text}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          className={cn(
            'w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed',
            'text-text placeholder:text-hint',
            'focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label="消息输入"
          onChange={(e) => {
            updateText(e.target.value)
            handleInput()
          }}
        />

        {/* 底部工具栏 */}
        <div className="flex items-center justify-between gap-2 px-4 pb-3">
          {/* 左侧：附件图标 + 指令提示 */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-md',
                'text-subtle hover:bg-surface-3 hover:text-text',
                'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              )}
              onClick={() => void handleAttachClick()}
              disabled={disabled}
              aria-label="添加附件"
            >
              <Paperclip className="size-4" aria-hidden="true" />
            </button>
            <span className="hidden text-xs text-hint sm:inline">
              / 唤起指令面板
            </span>
          </div>

          {/* 中间：发送快捷键提示 */}
          <span className="hidden text-xs text-hint md:inline">
            Enter 发送 · Shift+Enter 换行
          </span>

          {/* 右侧：权限 + 模型选择 + 发送/中断 */}
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
                className="rounded-full size-8 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                aria-label="中断"
              >
                <Square className="size-4" aria-hidden="true" />
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
