/**
 * ChapterContextMenu：章节右键菜单
 *
 * 在章节标尺上右键时弹出，提供以下操作：
 * - 生成：从该章开始新的创作流程
 * - 重新生成：覆盖已有章节内容
 * - 查看：选中并跳转到该章节详情
 * - 删除：删除该章节
 */

import { useEffect, type ReactElement } from 'react'
import { Sparkles, RefreshCw, Eye, Trash2 } from 'lucide-react'

export interface ChapterContextMenuPosition {
  x: number
  y: number
  chapterNumber: number
  chapterId: string | null
  chapterTitle: string | null
}

export interface ChapterContextMenuProps {
  position: ChapterContextMenuPosition | null
  /** 是否有正在进行的创作流程（用于禁用生成/重新生成） */
  creationRunning: boolean
  onClose: () => void
  onGenerate: (chapterNumber: number) => void
  onRegenerate: (chapterNumber: number) => void
  onView: (chapterNumber: number) => void
  onDelete: (chapterId: string) => void
}

export function ChapterContextMenu({
  position,
  creationRunning,
  onClose,
  onGenerate,
  onRegenerate,
  onView,
  onDelete,
}: ChapterContextMenuProps): ReactElement | null {
  useEffect(() => {
    if (!position) return
    const handleClickOutside = (): void => onClose()
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('click', handleClickOutside)
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('click', handleClickOutside)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [position, onClose])

  if (!position) return null

  const { x, y, chapterNumber, chapterId, chapterTitle } = position
  const hasChapter = !!chapterId

  // 防止菜单越出视口
  const adjustedX = Math.min(x, window.innerWidth - 180)
  const adjustedY = Math.min(y, window.innerHeight - 200)

  const handleGenerate = (): void => {
    onGenerate(chapterNumber)
    onClose()
  }
  const handleRegenerate = (): void => {
    onRegenerate(chapterNumber)
    onClose()
  }
  const handleView = (): void => {
    onView(chapterNumber)
    onClose()
  }
  const handleDelete = (): void => {
    if (!chapterId) return
    if (!window.confirm(`确认删除第 ${chapterNumber} 章「${chapterTitle ?? '无标题'}」？`)) return
    onDelete(chapterId)
    onClose()
  }

  return (
    <div
      className="novel-chapter-context-menu"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase tracking-wide border-b border-border mb-1 tabular-nums">
        第 {chapterNumber} 章{chapterTitle ? ` · ${chapterTitle}` : ''}
      </div>

      {!hasChapter && (
        <div
          className={`novel-chapter-context-menu-item ${creationRunning ? 'opacity-50 pointer-events-none' : ''}`}
          onClick={handleGenerate}
        >
          <Sparkles className="size-3.5" />
          <span>从此章开始创作</span>
        </div>
      )}

      {hasChapter && (
        <>
          <div
            className={`novel-chapter-context-menu-item ${creationRunning ? 'opacity-50 pointer-events-none' : ''}`}
            onClick={handleRegenerate}
          >
            <RefreshCw className="size-3.5" />
            <span>重新生成</span>
          </div>
          <div className="novel-chapter-context-menu-item" onClick={handleView}>
            <Eye className="size-3.5" />
            <span>查看详情</span>
          </div>
          <div className="novel-chapter-context-menu-divider" />
          <div
            className={`novel-chapter-context-menu-item is-danger ${creationRunning ? 'opacity-50 pointer-events-none' : ''}`}
            onClick={handleDelete}
          >
            <Trash2 className="size-3.5" />
            <span>删除章节</span>
          </div>
        </>
      )}
    </div>
  )
}
