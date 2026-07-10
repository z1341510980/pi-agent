/**
 * EntityCellMenu：实体单元格右键菜单
 *
 * 触发：右键单元格（已有实体的行 + 具体章节列）
 *
 * 按 entityType 语义化适配：
 * - character：标记/删除出场（操作 characterHistory 关联表）
 * - conflict/faction：扩展到本章 / 收缩端点（仅首尾端点可删）
 * - foreshadow：标记埋设/回收点 / 取消埋设/回收
 * - location：标记/删除出场（操作 appearChapters）
 * - world_element：不可标记（恒全程）
 *
 * 所有类型均可「修改批注」（操作 clip-note marker）
 */

import { useEffect, type ReactElement } from 'react'
import { Plus, Trash2, StickyNote, ArrowLeftRight } from 'lucide-react'
import type { MatrixEntityKind } from './matrix-logic'

export interface EntityCellMenuPosition {
  x: number
  y: number
  entityId: string
  entityName: string
  entityType: MatrixEntityKind
  chapter: number
  /** 当前章节是否已出场 */
  present: boolean
  /** 是否支持出场编辑（非 world_element） */
  editable: boolean
  /** 是否支持「删除出场」操作（端点型实体中间格不可删） */
  removable: boolean
  /** foreshadow 动态文案状态：'unplanted' | 'planted' | 'recoverable' */
  foreshadowState?: 'unplanted' | 'planted' | 'recoverable'
}

export interface EntityCellMenuProps {
  position: EntityCellMenuPosition | null
  onClose: () => void
  onMarkPresent: (entityId: string, entityType: MatrixEntityKind, chapter: number) => void
  onRemovePresent: (entityId: string, entityType: MatrixEntityKind, chapter: number) => void
  onEditNote: (entityId: string, entityName: string, entityType: MatrixEntityKind, chapter: number) => void
  /** 编辑范围：所有类型都支持（world_element 不可达，因 editable=false） */
  onEditSpan?: (entityId: string, entityName: string, entityType: MatrixEntityKind) => void
  /** 删除该段跨度（仅 conflict/faction：移除 chapter 所在的整段 chapterSpan） */
  onRemoveSpan?: (entityId: string, entityType: MatrixEntityKind, chapter: number) => void
}

/** 按 entityType + foreshadowState 返回「标记出场」文案 */
function markLabel(kind: MatrixEntityKind, foreshadowState?: 'unplanted' | 'planted' | 'recoverable'): string {
  switch (kind) {
    case 'character':
      return '标记本章出场'
    case 'conflict':
    case 'faction':
      return '扩展到本章'
    case 'foreshadow':
      if (foreshadowState === 'unplanted') return '标记本章为埋设点'
      if (foreshadowState === 'planted') return '标记本章为回收点'
      if (foreshadowState === 'recoverable') return '本章已是回收点'
      return '标记埋设/回收点'
    case 'location':
      return '标记本章出场'
    case 'world_element':
      return ''
    default:
      return '标记出场'
  }
}

/** 按 entityType 返回「删除出场」文案 */
function removeLabel(kind: MatrixEntityKind): string {
  switch (kind) {
    case 'character':
      return '删除本章出场'
    case 'conflict':
    case 'faction':
      return '收缩端点'
    case 'foreshadow':
      return '取消埋设/回收'
    case 'location':
      return '删除本章出场'
    case 'world_element':
      return ''
    default:
      return '删除出场'
  }
}

/** 按 entityType 返回「标记」tooltip */
function markTooltip(kind: MatrixEntityKind, present: boolean, foreshadowState?: 'unplanted' | 'planted' | 'recoverable'): string {
  if (present) return '该章已标记'
  switch (kind) {
    case 'character':
      return '写入一条 characterHistory 记录，标记该角色在本章出场'
    case 'conflict':
    case 'faction':
      return '扩展 firstChapter/lastChapter 端点覆盖到本章'
    case 'foreshadow':
      if (foreshadowState === 'unplanted') return '设 firstChapter = 本章，标记伏笔在此埋设'
      if (foreshadowState === 'planted') return '设 recoverByChapter = 本章，标记伏笔在此回收'
      if (foreshadowState === 'recoverable') return '本章已是回收点，无需重复标记'
      return '未埋设则设为埋设点；已埋设则设为回收点'
    case 'location':
      return '将本章加入 appearChapters 数组'
    default:
      return '标记出场'
  }
}

/** 按 entityType 返回「删除」tooltip */
function removeTooltip(kind: MatrixEntityKind): string {
  switch (kind) {
    case 'character':
      return '删除该角色在本章的所有 characterHistory 记录'
    case 'conflict':
    case 'faction':
      return '收缩端点（仅首尾端点可删，中间格不可删）'
    case 'foreshadow':
      return '取消埋设点或回收点'
    case 'location':
      return '从 appearChapters 数组中移除本章'
    default:
      return '删除出场'
  }
}

export function EntityCellMenu({
  position, onClose, onMarkPresent, onRemovePresent, onEditNote, onEditSpan, onRemoveSpan,
}: EntityCellMenuProps): ReactElement | null {
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

  const { x, y, entityId, entityName, entityType, chapter, present, editable, removable, foreshadowState } = position
  const adjustedX = Math.min(x, window.innerWidth - 220)
  const adjustedY = Math.min(y, window.innerHeight - 200)

  const handleMark = (): void => {
    onMarkPresent(entityId, entityType, chapter)
    onClose()
  }
  const handleRemove = (): void => {
    onRemovePresent(entityId, entityType, chapter)
    onClose()
  }
  const handleEditNote = (): void => {
    onEditNote(entityId, entityName, entityType, chapter)
    onClose()
  }
  const handleEditSpan = (): void => {
    onEditSpan?.(entityId, entityName, entityType)
    onClose()
  }
  const handleRemoveSpan = (): void => {
    onRemoveSpan?.(entityId, entityType, chapter)
    onClose()
  }

  // foreshadow 在 recoverable 状态（已是回收点）时标记按钮禁用
  const markDisabled = present || (entityType === 'foreshadow' && foreshadowState === 'recoverable')

  return (
    <div
      className="fixed z-50 min-w-[200px] bg-surface-1 border border-border rounded-md shadow-lg py-1 text-xs"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wide border-b border-border mb-1 truncate tabular-nums">
        {entityName} · 第 {chapter} 章
      </div>
      {editable && (
        <>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleMark}
            disabled={markDisabled}
            data-tip={markTooltip(entityType, present, foreshadowState)}
          >
            <Plus className="size-3.5" />
            <span>{markLabel(entityType, foreshadowState)}</span>
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleRemove}
            disabled={!removable}
            data-tip={removeTooltip(entityType)}
          >
            <Trash2 className="size-3.5" />
            <span>{removeLabel(entityType)}</span>
          </button>
          <div className="h-px bg-border my-1" />
        </>
      )}
      {editable && onEditSpan && (
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text hover:bg-muted transition-colors"
          onClick={handleEditSpan}
          data-tip="打开范围编辑对话框，直接指定起止章节"
        >
          <ArrowLeftRight className="size-3.5" />
          <span>编辑范围</span>
        </button>
      )}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text hover:bg-muted transition-colors"
        onClick={handleEditNote}
        title="修改此实体的批注"
      >
        <StickyNote className="size-3.5" />
        <span>修改批注</span>
      </button>
      {(entityType === 'conflict' || entityType === 'faction') && present && onRemoveSpan && (
        <>
          <div className="h-px bg-border my-1" />
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-red-500 hover:bg-red-500/10 transition-colors"
            onClick={handleRemoveSpan}
            data-tip="删除本章所在的整段跨度（含段内所有章节出场）"
          >
            <Trash2 className="size-3.5" />
            <span>删除该段范围</span>
          </button>
        </>
      )}
    </div>
  )
}
