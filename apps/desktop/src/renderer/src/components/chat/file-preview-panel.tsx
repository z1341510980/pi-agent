import type { ReactElement } from 'react'
import { X, FileText, Image, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FilePreviewState } from '@/stores/ui-store'

// ── 类型定义 ──

interface FilePreviewPanelProps {
  file: FilePreviewState
  onClose: () => void
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── 主组件 ──

export function FilePreviewPanel({ file, onClose }: FilePreviewPanelProps): ReactElement {
  const isImage = file.type === 'image' || file.mimeType?.startsWith('image/')

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 顶部标题栏 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-text"
          onClick={onClose}
          aria-label="返回"
        >
          <ArrowLeft className="size-4" />
        </Button>
        {isImage ? (
          <Image className="size-4 text-primary shrink-0" />
        ) : (
          <FileText className="size-4 text-primary shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{file.name}</p>
          <p className="text-xs text-muted-foreground">{formatSize(file.size)}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-text"
          onClick={onClose}
          aria-label="关闭预览"
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* 预览内容 */}
      <div className="flex-1 overflow-auto min-h-0">
        {isImage && file.thumbnail ? (
          <div className="flex items-center justify-center p-4 min-h-full">
            <img
              src={file.thumbnail}
              alt={file.name}
              className="max-w-full max-h-full object-contain rounded outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          </div>
        ) : file.content && file.encoding === 'utf-8' ? (
          <pre className="px-4 py-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-words text-text leading-relaxed">
            <code>{file.content}</code>
          </pre>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <FileText className="size-10" />
            <p className="text-sm">无法预览此文件</p>
            <p className="text-xs">{file.name}</p>
          </div>
        )}
      </div>
    </div>
  )
}
