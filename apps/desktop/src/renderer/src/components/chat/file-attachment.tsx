import { useState, type ReactElement } from 'react'
import { FileText, Image, X, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileAttachment } from './types'

// 重新导出 FileAttachment 类型，方便其他组件引用
export type { FileAttachment }

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  return map[ext] ?? ''
}

/** 判断是否为图片类型 */
function isImageType(attachment: FileAttachment): boolean {
  if (attachment.type === 'image') return true
  if (attachment.mimeType?.startsWith('image/')) return true
  const inferred = inferMimeType(attachment.name)
  return inferred.startsWith('image/')
}

/** 判断是否为代码文件 */
function isCodeFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const codeExts = [
    'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h',
    'css', 'scss', 'html', 'json', 'yaml', 'yml', 'toml', 'md', 'sh', 'bash',
    'sql', 'graphql', 'vue', 'svelte',
  ]
  return codeExts.includes(ext)
}

export interface FileAttachmentCardProps {
  attachment: FileAttachment
  /** 是否可删除（输入区预览用） */
  removable?: boolean
  /** 删除回调 */
  onRemove?: (id: string) => void
}

/**
 * FileAttachmentCard：文件附件卡片
 *
 * 显示在消息流或输入区中
 * - 图片类型显示缩略图
 * - 代码文件支持展开查看
 */
export function FileAttachmentCard({
  attachment,
  removable = false,
  onRemove,
}: FileAttachmentCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const isImage = isImageType(attachment)
  const isCode = isCodeFile(attachment.name)

  return (
    <div
      className={cn(
        'group relative rounded-lg border border-border bg-surface-1 overflow-hidden',
        'transition-colors hover:border-border/80',
      )}
    >
      {/* 顶部信息栏 */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* 类型图标 */}
        {isImage ? (
          <Image className="size-4 shrink-0 text-accent" aria-hidden="true" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}

        {/* 文件名和大小 */}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{attachment.name}</p>
          <p className="text-[10px] text-muted-foreground">{formatSize(attachment.size)}</p>
        </div>

        {/* 展开/收起（代码文件且有内容时） */}
        {isCode && attachment.content && attachment.encoding === 'utf-8' && (
          <button
            type="button"
            className="shrink-0 p-0.5 rounded hover:bg-surface-2 transition-colors"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? '收起' : '展开'}
          >
            {expanded ? (
              <ChevronUp className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-3.5 text-muted-foreground" />
            )}
          </button>
        )}

        {/* 删除按钮 */}
        {removable && onRemove && (
          <button
            type="button"
            className="shrink-0 p-0.5 rounded hover:bg-destructive/10 transition-colors"
            onClick={() => onRemove(attachment.id)}
            aria-label="移除附件"
          >
            <X className="size-3.5 text-muted-foreground hover:text-destructive" />
          </button>
        )}
      </div>

      {/* 图片缩略图 */}
      {isImage && attachment.thumbnail && (
        <div className="px-3 pb-2">
          <img
            src={attachment.thumbnail}
            alt={attachment.name}
            className="max-h-32 rounded border border-border object-contain"
          />
        </div>
      )}

      {/* 代码预览 */}
      {expanded && isCode && attachment.content && attachment.encoding === 'utf-8' && (
        <div className="border-t border-border">
          <pre className="px-3 py-2 text-[11px] font-mono overflow-x-auto max-h-48 text-muted-foreground bg-surface-2/50">
            <code>{attachment.content.slice(0, 2000)}{attachment.content.length > 2000 ? '\n... (已截断)' : ''}</code>
          </pre>
        </div>
      )}
    </div>
  )
}

export interface FileAttachmentListProps {
  attachments: FileAttachment[]
  /** 是否可删除 */
  removable?: boolean
  /** 删除回调 */
  onRemove?: (id: string) => void
}

/**
 * FileAttachmentList：附件列表
 */
export function FileAttachmentList({
  attachments,
  removable = false,
  onRemove,
}: FileAttachmentListProps): ReactElement {
  if (attachments.length === 0) return <></>

  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((att) => (
        <div key={att.id} className="w-48">
          <FileAttachmentCard
            attachment={att}
            removable={removable}
            onRemove={onRemove}
          />
        </div>
      ))}
    </div>
  )
}
