/**
 * ChapterContextMenu：章节右键菜单
 *
 * 在章节标尺上右键时弹出，提供以下操作：
 * - 生成：从该章开始新的创作流程
 * - 重新生成：覆盖已有章节内容
 * - 查看：选中并跳转到该章节详情
 * - 删除：删除该章节
 *
 * 定位、外部点击关闭、Esc 关闭与碰撞规避统一由 CoordinateMenu（Popover）负责，
 * 本组件只描述菜单内容。
 */

import { type ReactElement } from 'react'
import { Sparkles, RefreshCw, Eye, Trash2 } from 'lucide-react'
import {
  CoordinateMenu,
  coordinateMenuDangerItemClass,
  coordinateMenuItemClass,
} from './coordinate-menu'

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
}: ChapterContextMenuProps): ReactElement {
  const chapterNumber = position?.chapterNumber ?? 0
  const chapterId = position?.chapterId ?? null
  const chapterTitle = position?.chapterTitle ?? null
  const hasChapter = !!chapterId

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
    <CoordinateMenu
      position={position}
      onClose={onClose}
      ariaLabel="章节操作"
      className="min-w-[176px]"
    >
      <div className="px-2 py-1 mb-1 border-b border-border text-nano tracking-wide text-muted-foreground uppercase tabular-nums">
        第 {chapterNumber} 章{chapterTitle ? ` · ${chapterTitle}` : ''}
      </div>

      {!hasChapter && (
        <button
          type="button"
          role="menuitem"
          disabled={creationRunning}
          className={coordinateMenuItemClass}
          onClick={handleGenerate}
        >
          <Sparkles className="size-3.5" />
          <span>从此章开始创作</span>
        </button>
      )}

      {hasChapter && (
        <>
          <button
            type="button"
            role="menuitem"
            disabled={creationRunning}
            className={coordinateMenuItemClass}
            onClick={handleRegenerate}
          >
            <RefreshCw className="size-3.5" />
            <span>重新生成</span>
          </button>
          <button type="button" role="menuitem" className={coordinateMenuItemClass} onClick={handleView}>
            <Eye className="size-3.5" />
            <span>查看详情</span>
          </button>
          <div className="-mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            disabled={creationRunning}
            className={coordinateMenuDangerItemClass}
            onClick={handleDelete}
          >
            <Trash2 className="size-3.5" />
            <span>删除章节</span>
          </button>
        </>
      )}
    </CoordinateMenu>
  )
}
