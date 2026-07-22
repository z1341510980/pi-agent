/**
 * EntityCellMenu：实体单元格右键菜单
 *
 * 触发：右键单元格（已有实体的行 + 具体章节列）
 *
 * 按 entityType 语义化适配：
 * - character：标记/删除出场（操作 characterHistory 关联表）
 * - conflict/faction：扩展到本章 / 收缩端点（仅首尾端点可删）
 * - foreshadow：管理埋设/强化/部分揭示/回收事件链节点
 * - location：标记/删除出场（操作 appearChapters）
 * - world_element：不可标记（恒全程）
 *
 * 普通实体可修改 clip-note marker；伏笔已有节点可编辑 beats[].note。
 */

import { useEffect, type ReactElement } from 'react'
import { Plus, Trash2, StickyNote, ArrowLeftRight, Sparkles, Eye, CircleDot } from 'lucide-react'
import type { ForeshadowBeatType } from '@/api/novel-client'
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
  /** 伏笔事件链所处状态 */
  foreshadowState?: 'unplanted' | 'active' | 'recovered'
  /** 本章已有的伏笔节点类型 */
  foreshadowBeatType?: ForeshadowBeatType
  /** 本章伏笔节点的具体写作内容 */
  foreshadowBeatNote?: string
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
  /** 在指定章节新增一种伏笔事件节点 */
  onMarkForeshadowBeat?: (entityId: string, chapter: number, type: ForeshadowBeatType, editAfterCreate: boolean) => void
}

const menuItemClass = 'w-full min-h-10 flex items-center gap-2 px-3 py-2 text-left text-text hover:bg-muted focus-visible:outline-none focus-visible:bg-muted transition-[background-color,scale] duration-150 ease-out active:scale-[0.96]'
const destructiveMenuItemClass = 'w-full min-h-10 flex items-center gap-2 px-3 py-2 text-left text-red-500 hover:bg-red-500/10 focus-visible:outline-none focus-visible:bg-red-500/10 transition-[background-color,scale] duration-150 ease-out active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed'

/** 按 entityType + foreshadowState 返回「标记出场」文案 */
function markLabel(kind: MatrixEntityKind): string {
  switch (kind) {
    case 'character':
      return '标记本章出场'
    case 'conflict':
    case 'faction':
      return '扩展到本章'
    case 'clue':
      return '标记本章推进'
    case 'foreshadow':
      return '添加伏笔节点'
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
    case 'clue':
      return '删除本章线索节点'
    case 'foreshadow':
      return '删除本章伏笔节点'
    case 'location':
      return '删除本章出场'
    case 'world_element':
      return ''
    default:
      return '删除出场'
  }
}

/** 按 entityType 返回「标记」tooltip */
function markTooltip(kind: MatrixEntityKind, present: boolean): string {
  if (present) return '该章已标记'
  switch (kind) {
    case 'character':
      return '写入一条 characterHistory 记录，标记该角色在本章出场'
    case 'conflict':
    case 'faction':
      return '扩展 firstChapter/lastChapter 端点覆盖到本章'
    case 'clue':
      return '标记该线索在本章被发现、验证或推进'
    case 'foreshadow':
      return '为本章选择埋设、强化、揭示或回收语义'
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
    case 'clue':
      return '删除该线索在本章的推进记录'
    case 'foreshadow':
      return '删除本章节点；若删除埋设点，将同时清空整条事件链'
    case 'location':
      return '从 appearChapters 数组中移除本章'
    default:
      return '删除出场'
  }
}

export function EntityCellMenu({
  position, onClose, onMarkPresent, onRemovePresent, onEditNote, onEditSpan, onRemoveSpan, onMarkForeshadowBeat,
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

  const {
    x, y, entityId, entityName, entityType, chapter, present, editable, removable,
    foreshadowState, foreshadowBeatType, foreshadowBeatNote,
  } = position
  const adjustedX = Math.max(8, Math.min(x, window.innerWidth - 264))
  const adjustedY = Math.max(8, Math.min(y, window.innerHeight - 360))

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
  const handleForeshadowBeat = (type: ForeshadowBeatType): void => {
    onMarkForeshadowBeat?.(entityId, chapter, type, true)
    onClose()
  }

  // foreshadow 在 recoverable 状态（已是回收点）时标记按钮禁用
  const markDisabled = present

  return (
    <div
      className="fixed z-50 min-w-[240px] max-w-[320px] bg-surface-1 border border-border rounded-lg shadow-lg py-1 text-xs"
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
          {entityType === 'foreshadow' ? (
            <>
              {foreshadowBeatType ? (
                <>
                  <div className="px-3 py-1.5 text-muted-foreground">
                    本章节点：{{ plant: '埋设', reinforce: '强化', reveal: '部分揭示', payoff: '回收' }[foreshadowBeatType]}
                  </div>
                  {foreshadowBeatNote && (
                    <div className="mx-2 mb-1 rounded-md bg-amber-500/8 px-2.5 py-2 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.12)]">
                      <div className="mb-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">节点内容</div>
                      <p className="max-w-[280px] text-pretty leading-relaxed text-text line-clamp-3">{foreshadowBeatNote}</p>
                    </div>
                  )}
                </>
              ) : foreshadowState === 'unplanted' ? (
                <button type="button" className={menuItemClass} onClick={() => handleForeshadowBeat('plant')}>
                  <CircleDot className="size-3.5" /><span>设为埋设点</span>
                </button>
              ) : foreshadowState === 'active' ? (
                <>
                  <button type="button" className={menuItemClass} onClick={() => handleForeshadowBeat('reinforce')}>
                    <Sparkles className="size-3.5" /><span>强化伏笔</span>
                  </button>
                  <button type="button" className={menuItemClass} onClick={() => handleForeshadowBeat('reveal')}>
                    <Eye className="size-3.5" /><span>部分揭示</span>
                  </button>
                  <button type="button" className={menuItemClass} onClick={() => handleForeshadowBeat('payoff')}>
                    <CircleDot className="size-3.5" /><span>回收伏笔</span>
                  </button>
                </>
              ) : (
                <div className="px-3 py-1.5 text-muted-foreground">伏笔已回收，不能在回收章之后新增节点</div>
              )}
            </>
          ) : (
            <button
              type="button"
              className={`${menuItemClass} disabled:opacity-40 disabled:cursor-not-allowed`}
              onClick={handleMark}
              disabled={markDisabled}
              title={markTooltip(entityType, present)}
            >
              <Plus className="size-3.5" />
              <span>{markLabel(entityType)}</span>
            </button>
          )}
          {entityType === 'foreshadow' && foreshadowBeatType === 'plant' ? (
            <div className="px-3 py-1.5 text-muted-foreground leading-relaxed">
              埋设点是伏笔链的根节点，可拖动调整；如需移回元素池，请在详情中清空埋设章节。
            </div>
          ) : (
            <button
              type="button"
              className={destructiveMenuItemClass}
              onClick={handleRemove}
              disabled={!removable}
              title={removeTooltip(entityType)}
            >
              <Trash2 className="size-3.5" />
              <span>{removeLabel(entityType)}</span>
            </button>
          )}
          <div className="h-px bg-border my-1" />
        </>
      )}
      {editable && entityType !== 'foreshadow' && onEditSpan && (
        <button
          type="button"
          className={menuItemClass}
          onClick={handleEditSpan}
          title="打开范围编辑对话框，直接指定起止章节"
        >
          <ArrowLeftRight className="size-3.5" />
          <span>编辑范围</span>
        </button>
      )}
      {(entityType !== 'foreshadow' || foreshadowBeatType) && (
        <button
          type="button"
          className={menuItemClass}
          onClick={handleEditNote}
          title={entityType === 'foreshadow' ? '编辑本章伏笔节点的具体写作内容' : '修改此实体的批注'}
        >
          <StickyNote className="size-3.5" />
          <span>
            {entityType === 'foreshadow'
              ? (foreshadowBeatNote ? '编辑节点内容' : '添加节点内容')
              : '修改批注'}
          </span>
        </button>
      )}
      {(entityType === 'conflict' || entityType === 'faction') && present && onRemoveSpan && (
        <>
          <div className="h-px bg-border my-1" />
          <button
            type="button"
            className={destructiveMenuItemClass}
            onClick={handleRemoveSpan}
            title="删除本章所在的整段跨度（含段内所有章节出场）"
          >
            <Trash2 className="size-3.5" />
            <span>删除该段范围</span>
          </button>
        </>
      )}
    </div>
  )
}
