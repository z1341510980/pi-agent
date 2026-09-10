import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertCircle,
  ChevronRight,
  Download,
  FileText,
  ImageIcon,
  Loader2,
  Music2,
  Sparkles,
  Star,
  Video
} from 'lucide-react'

import {
  canvasGeneratedImageContent,
  proxyExternalImageUrl,
  type CanvasNodeData
} from '@/api/infinite-canvas-client'
import { cn } from '@/lib/utils'
import type { CanvasTheme } from './canvas-theme'
import type { ConnectionHandleType, Position } from './types'
import { getCanvasExtensionDefinition } from './node-registry'
import { parseDesignBoardDoc } from './design-board/design-board-types'

const SELECTION_BLUE = '#2f80ff'
const MIN_NODE_WIDTH = 220
const MIN_NODE_HEIGHT = 160

export type ResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface CanvasNodeProps {
  data: CanvasNodeData
  theme: CanvasTheme
  scale: number
  isSelected: boolean
  isRelated: boolean
  isFocusRelated: boolean
  isConnectionTarget: boolean
  isConnecting: boolean
  showPanel: boolean
  showImageInfo: boolean
  extensionInput?: string
  groupChildCount?: number
  isGroupDropTarget?: boolean
  renderPanel?: (node: CanvasNodeData) => ReactNode
  onMouseDown: (event: React.MouseEvent, nodeId: string) => void
  onSelectCapture?: (event: React.MouseEvent, nodeId: string) => void
  onHoverStart: (nodeId: string) => void
  onHoverEnd: (nodeId: string) => void
  onConnectStart: (
    event: React.MouseEvent,
    nodeId: string,
    handleType: ConnectionHandleType
  ) => void
  onResizeStart: () => void
  onResize: (nodeId: string, width: number, height: number, position?: Position) => void
  onResizeEnd: () => void
  onContentChange: (nodeId: string, content: string) => void
  onExtensionMetadataChange?: (nodeId: string, patch: Record<string, unknown>) => void
  onTitleChange: (nodeId: string, title: string) => void
  onFontSizeChange?: (nodeId: string, fontSize: number) => void
  onGenerateImage?: (node: CanvasNodeData) => void
  onViewImage?: (node: CanvasNodeData) => void
  onDownloadImage?: (node: CanvasNodeData) => void
  onBatchSelect?: (nodeId: string, index: number) => void
  onBatchDownload?: (node: CanvasNodeData, index: number) => void
  onContextMenu: (event: React.MouseEvent, nodeId: string) => void
  boardPreviewUrl?: string
  onOpenBoard?: (node: CanvasNodeData) => void
}

interface ResizeState {
  corner: ResizeCorner
  startX: number
  startY: number
  startLeft: number
  startTop: number
  startWidth: number
  startHeight: number
  keepRatio: boolean
  ratio: number
  started: boolean
}

function EmptyContent({
  icon,
  text,
  theme
}: {
  icon: ReactNode
  text: string
  theme: CanvasTheme
}): React.ReactElement {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <span
        className="grid size-14 place-items-center rounded-2xl"
        style={{ background: `${theme.node.stroke}55`, color: theme.node.faint }}
      >
        {icon}
      </span>
      <span
        className="px-6 text-center text-xs tracking-wide"
        style={{ color: theme.node.placeholder }}
      >
        {text}
      </span>
    </div>
  )
}

/** 节点组件：纯展示 + 交互转发；拖拽移动由父级统一管理，缩放在本组件内完成。 */
export const CanvasNode = memo(function CanvasNode({
  data,
  theme,
  scale,
  isSelected,
  isRelated,
  isFocusRelated,
  isConnectionTarget,
  isConnecting,
  showPanel,
  showImageInfo,
  extensionInput,
  groupChildCount = 0,
  isGroupDropTarget = false,
  renderPanel,
  onMouseDown,
  onSelectCapture,
  onHoverStart,
  onHoverEnd,
  onConnectStart,
  onResizeStart,
  onResize,
  onResizeEnd,
  onContentChange,
  onExtensionMetadataChange,
  onTitleChange,
  onGenerateImage,
  onViewImage,
  onDownloadImage,
  onBatchSelect,
  onBatchDownload,
  onContextMenu,
  boardPreviewUrl,
  onOpenBoard
}: CanvasNodeProps): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(data.title)
  const [isEditingContent, setIsEditingContent] = useState(false)
  const [batchExpanded, setBatchExpanded] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const resizeRef = useRef<ResizeState | null>(null)

  const metadata = data.metadata ?? {}
  // 渲染时统一过代理：相对资产路径补全为绝对地址，外站 URL 走服务端代理，
  // data:/blob: 原样放行
  const content = proxyExternalImageUrl(
    typeof metadata.content === 'string' ? metadata.content : ''
  )
  // 批量图片（对齐参考 BatchFrame）：images 存全部结果，content 始终为主图。
  const batchImages =
    data.type === 'image' && Array.isArray(metadata.images)
      ? metadata.images
          .map(canvasGeneratedImageContent)
          .filter((value): value is string => Boolean(value))
      : []
  const batchCount = batchImages.length
  const isBatchRoot = batchCount > 1
  const batchIndex = Math.min(Math.max(0, Number(metadata.batchIndex) || 0), batchCount - 1)
  useEffect(() => {
    if (!isSelected && !hovered) setBatchExpanded(false)
  }, [hovered, isSelected])
  const status = typeof metadata.status === 'string' ? metadata.status : 'idle'
  const isGroup = data.type === 'group'
  const extension = getCanvasExtensionDefinition(data.type)
  const isActive = isConnectionTarget || isSelected || isFocusRelated
  const boardDoc = data.type === 'design-board' ? parseDesignBoardDoc(metadata.design) : null
  const boardWidth = boardDoc?.width ?? 0
  const boardHeight = boardDoc?.height ?? 0
  const docObjectCount = boardDoc?.objects.length ?? 0

  useEffect(() => {
    if (!isEditingTitle) setTitleDraft(data.title)
  }, [data.title, isEditingTitle])

  useEffect(() => {
    if (isEditingTitle) titleInputRef.current?.focus()
  }, [isEditingTitle])

  // ── 标题编辑：外部 pointerdown（capture）结束编辑 ──
  useEffect(() => {
    if (!isEditingTitle) return
    const finish = (): void => {
      setIsEditingTitle((editing) => {
        if (editing) {
          const next = titleDraft.trim()
          if (next && next !== data.title) onTitleChange(data.id, next)
          else if (!next) setTitleDraft(data.title || '未命名节点')
        }
        return false
      })
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (titleInputRef.current?.contains(event.target as Node)) return
      finish()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [data.id, data.title, isEditingTitle, onTitleChange, titleDraft])

  // ── 缩放：window 级 mousemove/mouseup，四角手柄；首次实际移动才入栈历史 ──
  const commitResizeMove = (event: MouseEvent): void => {
    const state = resizeRef.current
    if (!state) return
    if (!state.started) {
      state.started = true
      onResizeStart()
    }
    const dx = (event.clientX - state.startX) / scale
    const dy = (event.clientY - state.startY) / scale
    const fromLeft = state.corner === 'top-left' || state.corner === 'bottom-left'
    const fromTop = state.corner === 'top-left' || state.corner === 'top-right'

    let width = state.startWidth + (fromLeft ? -dx : dx)
    let height = state.startHeight + (fromTop ? -dy : dy)
    if (state.keepRatio) {
      const dominantAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
      width =
        dominantAxis === 'x'
          ? width
          : state.startHeight * state.ratio + (fromTop ? -dy : dy) * state.ratio
      height = width / state.ratio
    }
    width = Math.max(MIN_NODE_WIDTH, width)
    height = Math.max(MIN_NODE_HEIGHT, height)
    const x = fromLeft ? state.startLeft + state.startWidth - width : state.startLeft
    const y = fromTop ? state.startTop + state.startHeight - height : state.startTop
    onResize(data.id, width, height, { x, y })
  }

  const finishResize = (): void => {
    if (!resizeRef.current) return
    resizeRef.current = null
    window.removeEventListener('mousemove', commitResizeMove)
    window.removeEventListener('mouseup', finishResize)
    onResizeEnd()
  }

  const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner): void => {
    event.stopPropagation()
    event.preventDefault()
    const keepRatio = (data.type === 'image' && !metadata.freeResize) || data.type === 'video'
    const ratio =
      (Number(metadata.naturalWidth) || data.width) /
      Math.max(1, Number(metadata.naturalHeight) || data.height || 1)
    resizeRef.current = {
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: data.position.x,
      startTop: data.position.y,
      startWidth: data.width,
      startHeight: data.height,
      keepRatio,
      ratio,
      started: false
    }
    window.addEventListener('mousemove', commitResizeMove)
    window.addEventListener('mouseup', finishResize)
  }

  useEffect(
    () => () => {
      if (resizeRef.current) {
        window.removeEventListener('mousemove', commitResizeMove)
        window.removeEventListener('mouseup', finishResize)
      }
    },
    []
  )

  const commitTitle = (): void => {
    const next = titleDraft.trim()
    if (next && next !== data.title) onTitleChange(data.id, next)
    else if (!next) setTitleDraft(data.title || '未命名节点')
    setIsEditingTitle(false)
  }

  // ── 外观规则 ──
  const transparentBg =
    extension?.transparentBackground ||
    ((data.type === 'image' || data.type === 'video') && Boolean(content))
  const background = isGroup
    ? `${theme.toolbar.panel}66`
    : transparentBg
      ? 'transparent'
      : theme.node.fill
  const borderColor = isGroup
    ? isGroupDropTarget || isActive
      ? SELECTION_BLUE
      : theme.node.stroke
    : data.type === 'image' && content
      ? isActive
        ? SELECTION_BLUE
        : isRelated
          ? theme.node.muted
          : 'transparent'
      : isActive
        ? SELECTION_BLUE
        : isRelated
          ? theme.node.muted
          : transparentBg
            ? 'transparent'
            : theme.node.stroke
  const boxShadow = isGroupDropTarget
    ? `0 0 0 2px ${SELECTION_BLUE}66, inset 0 0 0 999px ${SELECTION_BLUE}10`
    : isActive
      ? `0 0 0 1px ${SELECTION_BLUE}55`
      : isRelated
        ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)`
        : undefined

  const fontSize = Number(metadata.fontSize) || 14

  const renderContent = (): ReactNode => {
    if (status === 'loading') {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3">
          <Loader2 className="size-7 animate-spin" style={{ color: theme.node.muted }} />
          <span className="text-xs" style={{ color: theme.node.placeholder }}>
            生成中…
          </span>
        </div>
      )
    }
    if (status === 'error') {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6">
          <AlertCircle className="size-7" style={{ color: '#f87171' }} />
          <span
            className="line-clamp-3 text-center text-xs"
            style={{ color: theme.node.placeholder }}
          >
            {typeof metadata.errorDetails === 'string' ? metadata.errorDetails : '生成失败'}
          </span>
        </div>
      )
    }
    if (extension)
      return (
        <ExtensionContent
          data={data}
          theme={theme}
          extensionType={extension.type}
          extensionInput={extensionInput}
          onContentChange={(value) => onContentChange(data.id, value)}
          onMetadataChange={(patch) => onExtensionMetadataChange?.(data.id, patch)}
        />
      )
    switch (data.type) {
      case 'text': {
        const shared = cn(
          // flex-1 + min-h-0：内容区在 flex 列里占满剩余高度，h-full 百分比链
          // 在 items-center 嵌套下会塌缩成单行；whitespace-pre-wrap 两种模式都要
          // （显示态之前漏了，换行被折叠）；data-canvas-no-zoom 防节点内滚动缩放画布。
          // 行高不内联指定，跟随浏览器默认（此前 1.65 系数行距过大）。
          'block min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words pl-4 pr-4 pt-0 pb-4 m-0 font-mono outline-none select-text appearance-none thin-scrollbar',
          isEditingContent ? 'resize-none bg-transparent border-none' : ''
        )
        return (
          <div className="flex h-full w-full flex-col overflow-hidden pt-8">
            {!isEditingContent && (
              <button
                type="button"
                className="absolute top-3 right-3 z-20 inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
                style={{
                  borderColor: theme.node.stroke,
                  color: theme.node.text,
                  background: theme.node.panel
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  onGenerateImage?.(data)
                }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <ImageIcon className="size-3.5" />
                生图
              </button>
            )}
            {isEditingContent ? (
              <textarea
                className={shared}
                style={{ fontSize, color: theme.node.text }}
                value={content}
                autoFocus
                onChange={(event) => onContentChange(data.id, event.target.value)}
                onBlur={() => setIsEditingContent(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setIsEditingContent(false)
                  event.stopPropagation()
                }}
                onWheel={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              />
            ) : (
              <div
                className={cn(shared, 'cursor-text')}
                data-canvas-no-zoom
                style={{ fontSize, color: theme.node.text }}
                onDoubleClick={() => setIsEditingContent(true)}
              >
                {content || <span style={{ color: theme.node.placeholder }}>双击编辑文本</span>}
              </div>
            )}
          </div>
        )
      }
      case 'image': {
        if (!content) {
          return (
            <EmptyContent
              icon={<ImageIcon className="size-7" />}
              text="拖入图片或双击空白创建"
              theme={theme}
            />
          )
        }
        return (
          <>
            <img
              src={content}
              alt={data.title}
              draggable={false}
              className={cn(
                'pointer-events-none block h-full w-full select-none',
                metadata.freeResize ? 'object-fill' : 'object-contain'
              )}
            />
            {showImageInfo && (
              <div className="pointer-events-none absolute right-3 bottom-3 z-40 rounded-md bg-black/55 px-2 py-1 text-[11px] leading-none font-medium text-white backdrop-blur-sm tabular-nums">
                {Number(metadata.naturalWidth) || Math.round(data.width)} ×{' '}
                {Number(metadata.naturalHeight) || Math.round(data.height)}
                {metadata.bytes ? ` · ${(Number(metadata.bytes) / 1024).toFixed(0)}KB` : ''}
              </div>
            )}
            {onDownloadImage && (
              <button
                type="button"
                title="下载图片"
                className="absolute top-2.5 left-2.5 z-30 grid h-8 w-8 place-items-center rounded-lg border backdrop-blur-md transition hover:scale-[1.04]"
                style={{
                  borderColor: theme.node.stroke,
                  color: theme.node.text,
                  background: theme.node.panel
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  onDownloadImage(data)
                }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <Download className="size-3.5" />
              </button>
            )}
            {isBatchRoot && (
              <button
                type="button"
                aria-label={batchExpanded ? '收起批量图片' : `展开全部 ${batchCount} 张`}
                className="absolute top-2.5 right-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                style={{
                  borderColor: theme.node.stroke,
                  color: theme.node.text,
                  background: theme.node.panel
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  setBatchExpanded((value) => !value)
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <span className="leading-none">{batchCount} 张</span>
                <ChevronRight
                  className={cn(
                    'size-3.5 opacity-80 transition-transform',
                    batchExpanded && 'rotate-90'
                  )}
                />
              </button>
            )}
          </>
        )
      }
      case 'config':
        return (
          <EmptyContent
            icon={<Sparkles className="size-7" />}
            text="连线到上游内容，在下方面板编写生成指令"
            theme={theme}
          />
        )
      case 'video': {
        if (!content)
          return (
            <EmptyContent
              icon={<Video className="size-7" />}
              text="拖入视频文件创建"
              theme={theme}
            />
          )
        return (
          <video
            src={content}
            controls
            className="h-full w-full rounded-[18px] bg-black object-contain"
            data-canvas-no-zoom
          />
        )
      }
      case 'audio': {
        if (!content)
          return (
            <EmptyContent
              icon={<Music2 className="size-7" />}
              text="拖入音频文件创建"
              theme={theme}
            />
          )
        return (
          <div
            className="flex h-full w-full flex-col justify-center gap-3 px-4"
            style={{ background: theme.node.fill }}
          >
            <span className="truncate text-sm opacity-70">
              <Music2 className="mr-1 inline size-4" />
              {data.title}
            </span>
            <audio src={content} controls className="w-full" data-canvas-no-zoom />
          </div>
        )
      }
      case 'group':
        return (
          <div className="pointer-events-none flex h-full w-full flex-col p-4">
            <div className="flex items-center gap-2">
              <span
                className="grid size-8 place-items-center rounded-xl"
                style={{ background: theme.toolbar.activeBg, color: theme.node.label }}
              >
                <FileText className="size-4" />
              </span>
              <span className="truncate text-sm font-semibold" style={{ color: theme.node.text }}>
                {data.title}
              </span>
              <span
                className="ml-auto rounded-full px-2 py-1 text-[11px] font-medium"
                style={{ background: theme.toolbar.activeBg, color: theme.node.label }}
              >
                {groupChildCount} 个节点
              </span>
            </div>
            <div
              className="mt-3 flex-1 rounded-2xl border border-dashed"
              style={{ borderColor: theme.node.stroke, background: `${theme.node.fill}55` }}
            />
          </div>
        )
      case 'design-board':
        return (
          <div
            className="relative h-full w-full overflow-hidden rounded-[inherit]"
            onDoubleClick={() => onOpenBoard?.(data)}
          >
            {boardPreviewUrl ? (
              <img
                src={boardPreviewUrl}
                alt="画板预览"
                draggable={false}
                className="h-full w-full select-none object-contain"
              />
            ) : (
              <div
                className="grid h-full w-full place-items-center text-xs"
                style={{ color: theme.node.muted }}
              >
                {docObjectCount > 0 ? `${docObjectCount} 个对象` : '双击开始设计'}
              </div>
            )}
            {boardDoc && (
              <span className="absolute right-1.5 bottom-1.5 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
                {boardWidth}×{boardHeight}
              </span>
            )}
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div
      data-node-id={data.id}
      className={cn(
        'node-element absolute flex select-none flex-col transition-shadow duration-200',
        isGroup ? 'z-[5]' : isSelected ? 'z-50' : 'z-10'
      )}
      style={{
        transform: `translate(${data.position.x}px, ${data.position.y}px)`,
        width: data.width,
        height: data.height,
        contain: 'layout style'
      }}
      onMouseEnter={() => {
        setHovered(true)
        onHoverStart(data.id)
      }}
      onMouseLeave={() => {
        setHovered(false)
        onHoverEnd(data.id)
      }}
      onMouseDownCapture={(event) => onSelectCapture?.(event, data.id)}
      onContextMenu={(event) => onContextMenu(event, data.id)}
    >
      {/* 悬浮标题条 */}
      {(isSelected || hovered || isEditingTitle) && !isGroup && (
        <div
          className="absolute top-[-28px] left-3 z-[65] max-w-[calc(100%-24px)]"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              maxLength={64}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitTitle()
                if (event.key === 'Escape') {
                  setTitleDraft(data.title)
                  setIsEditingTitle(false)
                }
              }}
              className="h-6 max-w-full border-0 border-b border-dashed bg-transparent px-0 text-left text-xs font-medium outline-none"
              style={{ color: theme.node.text, borderColor: theme.node.stroke }}
            />
          ) : (
            <button
              type="button"
              onDoubleClick={() => setIsEditingTitle(true)}
              className="block max-w-full truncate border-b border-dashed border-transparent px-0 py-0.5 text-left text-xs font-medium opacity-75 transition hover:border-current hover:opacity-100"
              style={{ color: theme.node.label }}
            >
              {data.title || '未命名节点'}
            </button>
          )}
        </div>
      )}

      {/* 连接点：左=入 右=出；config 无右侧出点；group 无连接点 */}
      {!isGroup && (
        <>
          <ConnectionDot
            side="left"
            theme={theme}
            visible={hovered || isSelected || isConnecting}
            onMouseDown={(event) => onConnectStart(event, data.id, 'target')}
          />
          <ConnectionDot
            side="right"
            theme={theme}
            visible={data.type !== 'config' && (hovered || isSelected || isConnecting)}
            onMouseDown={(event) => onConnectStart(event, data.id, 'source')}
          />
        </>
      )}

      {/* 批量背板（对齐参考 BatchFrame）：最多 3 张渐变卡片错位旋转垫在主图后。 */}
      {isBatchRoot && (
        <div className="pointer-events-none absolute inset-0 overflow-visible">
          {Array.from({ length: Math.min(batchCount - 1, 3) }).map((_, index) => (
            <div
              key={index}
              className="absolute rounded-[inherit] border shadow-[0_10px_24px_rgba(68,64,60,.12)] transition-all duration-300"
              style={{
                inset: 0,
                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                borderColor: theme.node.stroke,
                opacity: batchExpanded ? 0 : 1,
                transform: `translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)`,
                zIndex: -index - 1
              }}
            />
          ))}
        </div>
      )}

      {/* 边框主体 */}
      <div
        className="relative h-full w-full overflow-visible rounded-3xl border-2"
        style={{
          background,
          borderColor,
          borderStyle: isGroup ? 'dashed' : 'solid',
          boxShadow,
          transition: 'box-shadow 200ms ease'
        }}
        onMouseDown={(event) => onMouseDown(event, data.id)}
        onDoubleClick={() => {
          if (data.type === 'image' && content) onViewImage?.(data)
          else if (data.type === 'text') setIsEditingContent(true)
          else if (extension) {
            // Extension content owns its editor state in metadata; the panel is hidden.
            onContentChange(data.id, content)
          }
        }}
      >
        <div
          className={cn(
            'relative flex h-full w-full items-center justify-center rounded-[inherit]',
            isGroup ? 'overflow-visible' : 'overflow-hidden'
          )}
          style={{ background: isGroup ? 'transparent' : undefined }}
        >
          {renderContent()}
        </div>

        {/* 四角缩放手柄 */}
        <ResizeHandle corner="top-left" onResizeStart={handleResizeMouseDown} />
        <ResizeHandle corner="top-right" onResizeStart={handleResizeMouseDown} />
        <ResizeHandle corner="bottom-left" onResizeStart={handleResizeMouseDown} />
        <ResizeHandle corner="bottom-right" onResizeStart={handleResizeMouseDown} />

        {/* 底部渐隐遮罩（空内容时） */}
        {!isGroup && !content && status === 'idle' && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
            style={{
              background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)`
            }}
          />
        )}
      </div>

      {showPanel && !isGroup && (
        <div className="absolute top-full left-1/2 z-[70] w-[600px] -translate-x-1/2 pt-4">
          {renderPanel?.(data)}
        </div>
      )}

      {/* 批量展开网格：主图留在原位，其余卡片飞出到右侧网格。 */}
      {isBatchRoot && batchExpanded && (
        <>
          {batchImages
            .map((image, index) => ({ image, index }))
            .filter(({ index }) => index !== batchIndex)
            .map(({ image, index }, position) => {
              const columns = Math.min(batchCount, 4)
              const rows = Math.ceil(batchCount / columns)
              const rootSlot = (rows - 1) * columns
              // 主图占据首格，其余卡片顺次排入剩余槽位（跳过主图所在槽）。
              const slot = position < rootSlot ? position : position + 1
              const column = slot % columns
              const row = Math.floor(slot / columns) - (rows - 1)
              return (
                <div
                  key={`${index}-${slot}`}
                  className="absolute z-20 overflow-hidden rounded-3xl border shadow-[0_18px_50px_rgba(28,25,23,.18)]"
                  style={{
                    left: column * (data.width + 18),
                    top: row * (data.height + 18),
                    width: data.width,
                    height: data.height,
                    background: theme.node.panel,
                    borderColor: theme.node.stroke
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <img
                    src={image}
                    alt={`${data.title} ${index + 1}`}
                    draggable={false}
                    className="pointer-events-none h-full w-full select-none object-contain"
                  />
                  <div className="absolute inset-x-2 top-2 flex items-center gap-1">
                    {onBatchSelect && (
                      <button
                        type="button"
                        title="设为主图"
                        className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium backdrop-blur-md transition hover:scale-[1.02]"
                        style={{
                          background: theme.node.panel,
                          borderColor: theme.node.stroke,
                          color: theme.node.text
                        }}
                        onClick={(event) => {
                          event.stopPropagation()
                          setBatchExpanded(false)
                          onBatchSelect(data.id, index)
                        }}
                      >
                        <Star className="size-3 shrink-0" style={{ color: SELECTION_BLUE }} />
                        主图
                      </button>
                    )}
                    {onBatchDownload && (
                      <button
                        type="button"
                        title="下载此图"
                        className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium backdrop-blur-md transition hover:scale-[1.02]"
                        style={{
                          background: theme.node.panel,
                          borderColor: theme.node.stroke,
                          color: theme.node.text
                        }}
                        onClick={(event) => {
                          event.stopPropagation()
                          onBatchDownload(data, index)
                        }}
                      >
                        <Download className="size-3 shrink-0" />
                        下载
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
        </>
      )}
    </div>
  )
})

function ResizeHandle({
  corner,
  onResizeStart
}: {
  corner: ResizeCorner
  onResizeStart: (event: React.MouseEvent, corner: ResizeCorner) => void
}): React.ReactElement {
  const positionClass =
    corner === 'top-left'
      ? '-top-[14px] -left-[14px] cursor-nwse-resize'
      : corner === 'top-right'
        ? '-top-[14px] -right-[14px] cursor-nesw-resize'
        : corner === 'bottom-left'
          ? '-bottom-[14px] -left-[14px] cursor-nesw-resize'
          : '-right-[14px] -bottom-[14px] cursor-nwse-resize'
  return (
    <div
      className={cn('absolute z-50 size-7', positionClass)}
      onMouseDown={(event) => onResizeStart(event, corner)}
    />
  )
}

function ConnectionDot({
  side,
  theme,
  visible,
  onMouseDown
}: {
  side: 'left' | 'right'
  theme: CanvasTheme
  visible: boolean
  onMouseDown: (event: React.MouseEvent) => void
}): React.ReactElement {
  return (
    <div
      className={cn(
        'absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150',
        side === 'left' ? '-left-6' : '-right-6',
        visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
      )}
      onMouseDown={onMouseDown}
    >
      <span
        className="size-3 rounded-full border-2 transition-all hover:scale-125"
        style={{ background: theme.node.panel, borderColor: theme.node.muted }}
      />
    </div>
  )
}

function ExtensionContent({
  data,
  theme,
  extensionType,
  extensionInput,
  onContentChange,
  onMetadataChange
}: {
  data: CanvasNodeData
  theme: CanvasTheme
  extensionType: string
  extensionInput?: string
  onContentChange: (value: string) => void
  onMetadataChange: (patch: Record<string, unknown>) => void
}): React.ReactElement {
  const [editing, setEditing] = useState(Boolean(data.metadata?.editing))
  const fileRef = useRef<HTMLInputElement>(null)
  const content = typeof data.metadata?.content === 'string' ? data.metadata.content : ''
  useEffect(() => setEditing(Boolean(data.metadata?.editing)), [data.id, data.metadata?.editing])
  const updateEditing = (next: boolean): void => {
    setEditing(next)
    onMetadataChange({ editing: next })
  }
  const updateContent = (next: string): void => {
    onContentChange(next)
  }

  if (extensionType === 'sticky-note:note') {
    const color =
      typeof data.metadata?.pluginColor === 'string' ? data.metadata.pluginColor : '#fde68a'
    return (
      <div
        className="relative flex h-full w-full flex-col rounded-2xl p-3"
        style={{ background: color, color: '#1c1917' }}
        onDoubleClick={(event) => {
          event.stopPropagation()
          updateEditing(true)
        }}
      >
        <input
          type="color"
          value={color}
          onChange={(event) => onMetadataChange({ pluginColor: event.target.value })}
          className="absolute top-2 right-2 size-5 cursor-pointer rounded-full border-0 p-0 opacity-80"
        />
        {editing ? (
          <textarea
            autoFocus
            value={content}
            onChange={(event) => updateContent(event.target.value)}
            onBlur={() => updateEditing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') updateEditing(false)
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            className="h-full w-full resize-none bg-transparent text-sm leading-6 outline-none"
            placeholder="输入便利贴内容…"
          />
        ) : (
          <div className="h-full w-full whitespace-pre-wrap overflow-hidden pr-5 text-sm leading-6">
            {content || '双击编辑便利贴'}
          </div>
        )}
      </div>
    )
  }

  if (extensionType === 'markdown:doc') {
    return editing ? (
      <textarea
        autoFocus
        value={content}
        onChange={(event) => updateContent(event.target.value)}
        onBlur={() => updateEditing(false)}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        className="h-full w-full resize-none rounded-2xl p-4 font-mono text-sm leading-6 outline-none"
        style={{ background: theme.node.fill, color: theme.node.text }}
        placeholder="# 输入 Markdown"
      />
    ) : (
      <div
        className="h-full w-full overflow-auto whitespace-pre-wrap rounded-2xl p-4 text-sm leading-6"
        data-canvas-no-zoom
        onDoubleClick={(event) => {
          event.stopPropagation()
          updateEditing(true)
        }}
      >
        {content ? (
          renderSimpleMarkdown(content)
        ) : (
          <span style={{ color: theme.node.placeholder }}>双击编辑 Markdown</span>
        )}
      </div>
    )
  }

  if (extensionType === 'svg:vector') {
    return editing ? (
      <textarea
        autoFocus
        value={content}
        onChange={(event) => updateContent(event.target.value)}
        onBlur={() => updateEditing(false)}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        className="h-full w-full resize-none rounded-2xl p-4 font-mono text-xs outline-none"
        style={{ background: theme.node.fill, color: theme.node.text }}
        placeholder="粘贴 SVG 源码"
      />
    ) : (
      <div
        className="flex h-full w-full items-center justify-center p-3"
        onDoubleClick={(event) => {
          event.stopPropagation()
          updateEditing(true)
        }}
      >
        {content ? (
          <div
            className="pointer-events-none max-h-full max-w-full"
            dangerouslySetInnerHTML={{ __html: content }}
          />
        ) : (
          <span className="text-xs" style={{ color: theme.node.placeholder }}>
            双击编辑 SVG
          </span>
        )}
      </div>
    )
  }

  if (extensionType === 'html:render') {
    const html = content.replace(/\{\{\s*input\s*\}\}/g, extensionInput ?? '')
    return editing ? (
      <textarea
        autoFocus
        value={content}
        onChange={(event) => updateContent(event.target.value)}
        onBlur={() => updateEditing(false)}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        className="h-full w-full resize-none rounded-2xl p-4 font-mono text-xs outline-none"
        style={{ background: theme.node.fill, color: theme.node.text }}
        placeholder="<div>Hello, {{input}}</div>"
      />
    ) : (
      <div
        className="h-full w-full"
        data-canvas-no-zoom
        onDoubleClick={(event) => {
          event.stopPropagation()
          updateEditing(true)
        }}
      >
        {content ? (
          <iframe
            title="html-preview"
            sandbox="allow-scripts allow-forms"
            srcDoc={html}
            className="h-full w-full rounded-2xl border-0 bg-white"
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-xs"
            style={{ color: theme.node.placeholder }}
          >
            双击编辑 HTML
          </div>
        )}
      </div>
    )
  }

  if (extensionType === 'panorama:viewer') {
    return content ? (
      <PanoramaPreview source={content} />
    ) : (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-3"
        style={{ color: theme.node.placeholder }}
      >
        <span className="text-3xl">🌐</span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = () => onContentChange(String(reader.result ?? ''))
            reader.readAsDataURL(file)
          }}
        />
        <button
          type="button"
          className="rounded-full border px-3 py-1.5 text-xs"
          style={{ borderColor: theme.node.stroke, color: theme.node.text }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => fileRef.current?.click()}
        >
          上传全景图
        </button>
        <span className="text-xs">支持 2:1 等距柱状全景图</span>
      </div>
    )
  }

  return (
    <div
      className="flex h-full w-full items-center justify-center text-xs"
      style={{ color: theme.node.placeholder }}
    >
      双击编辑 {data.title}
    </div>
  )
}

function PanoramaPreview({ source }: { source: string }): React.ReactElement {
  const [offset, setOffset] = useState(50)
  const [dragStart, setDragStart] = useState<number | null>(null)
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragStart === null) return
    const delta = event.clientX - dragStart
    setDragStart(event.clientX)
    setOffset((current) => (current - delta / 4 + 200) % 100)
  }
  return (
    <div
      className="h-full w-full overflow-hidden rounded-[inherit] bg-black"
      data-canvas-no-zoom
      onPointerDown={(event) => {
        event.stopPropagation()
        setDragStart(event.clientX)
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={move}
      onPointerUp={() => setDragStart(null)}
      onPointerCancel={() => setDragStart(null)}
      onWheel={(event) => event.stopPropagation()}
    >
      <img
        src={source}
        alt="全景图"
        draggable={false}
        className="pointer-events-none h-full max-w-none select-none object-cover"
        style={{ width: '200%', transform: `translateX(-${offset}%)` }}
      />
    </div>
  )
}

function renderSimpleMarkdown(source: string): React.ReactNode {
  return source.split('\n').map((line, index) => {
    const trimmed = line.trim()
    const content = trimmed.replace(/^#{1,6}\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1')
    const className = trimmed.startsWith('#') ? 'font-semibold text-base' : ''
    return (
      <div key={`${index}-${line}`} className={className}>
        {content || '\u00a0'}
      </div>
    )
  })
}
