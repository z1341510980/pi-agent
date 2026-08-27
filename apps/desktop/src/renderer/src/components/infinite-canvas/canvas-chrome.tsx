import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CircleDot,
  Compass,
  Copy,
  Download,
  Eraser,
  Focus,
  Grid2x2,
  Bot,
  Hand,
  HelpCircle,
  ImageIcon,
  Key,
  List,
  Menu,
  Moon,
  MousePointer2,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  Redo2,
  Settings2,
  Square,
  Sun,
  Trash2,
  Type,
  Undo2,
  Upload,
  Video,
  X
} from 'lucide-react'

import type {
  CanvasNodeData,
  CanvasProjectSettings,
  ViewportTransform
} from '@/api/infinite-canvas-client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { CanvasTheme } from './canvas-theme'
import { useCanvasTheme } from './canvas-theme'
import { NODE_DEFAULT_SIZE } from './geometry'
import { getCanvasNodeMinimapColor, listCanvasExtensionDefinitions } from './node-registry'
import type { CanvasTool, ContextMenuState, PendingConnectionCreate, Position } from './types'

// ── 底部 Dock 工具栏 ──

function DockButton({
  icon,
  label,
  active = false,
  danger = false,
  disabled = false,
  onClick
}: {
  icon: ReactNode
  label: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}): React.ReactElement {
  const theme = useCanvasTheme()
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-lg transition',
        disabled && 'pointer-events-none opacity-35'
      )}
      style={{
        color: danger ? '#f87171' : active ? theme.toolbar.activeText : theme.toolbar.item,
        background: active ? theme.toolbar.activeBg : 'transparent'
      }}
      onMouseEnter={(event) => {
        if (!active) event.currentTarget.style.background = theme.toolbar.itemHover
      }}
      onMouseLeave={(event) => {
        if (!active) event.currentTarget.style.background = 'transparent'
      }}
    >
      <span className="[&_svg]:size-4.5">{icon}</span>
    </button>
  )
}

function ToolbarDivider(): React.ReactElement {
  return (
    <span
      className="mx-1 h-6 w-px shrink-0"
      style={{ background: 'currentColor', opacity: 0.15 }}
    />
  )
}

export interface CanvasToolbarProps {
  theme: CanvasTheme
  selectedCount: number
  canvasTool: CanvasTool
  canUndo: boolean
  canRedo: boolean
  settings: CanvasProjectSettings
  onCanvasToolChange: (tool: CanvasTool) => void
  onUndo: () => void
  onRedo: () => void
  onAddText: () => void
  onAddImage: () => void
  onAddVideo: () => void
  onAddAudio: () => void
  onAddConfig: () => void
  onAddGroup: () => void
  onAddExtensionNode: (type: string) => void
  onUpload: () => void
  onDelete: () => void
  onClear: () => void
  onSettingsChange: (patch: Partial<CanvasProjectSettings>) => void
  onOpenMediaConfig?: () => void
}

/** 底部居中 Dock：工具切换、节点创建、上传、外观、删除与清空。 */
export function CanvasToolbar({
  theme,
  selectedCount,
  canvasTool,
  canUndo,
  canRedo,
  settings,
  onCanvasToolChange,
  onUndo,
  onRedo,
  onAddText,
  onAddImage,
  onAddVideo,
  onAddAudio,
  onAddConfig,
  onAddGroup,
  onAddExtensionNode,
  onUpload,
  onDelete,
  onClear,
  onSettingsChange,
  onOpenMediaConfig
}: CanvasToolbarProps): React.ReactElement {
  const [stylePanelOpen, setStylePanelOpen] = useState(false)
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!stylePanelOpen) return
    const close = (event: PointerEvent): void => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node))
        setStylePanelOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [stylePanelOpen])

  const dockStyle = {
    background: theme.toolbar.panel,
    borderColor: theme.toolbar.border,
    color: theme.toolbar.item
  }

  return (
    <div
      className="pointer-events-none absolute bottom-5 z-50 flex justify-center"
      style={{ left: 320, right: 16 }}
    >
      <div
        className="thin-scrollbar pointer-events-auto flex h-14 max-w-full items-center gap-1 overflow-x-auto rounded-xl border px-2 shadow-lg backdrop-blur"
        style={dockStyle}
      >
        <DockButton
          icon={<MousePointer2 />}
          label="选择工具"
          active={canvasTool === 'select'}
          onClick={() => onCanvasToolChange('select')}
        />
        <DockButton
          icon={<Hand />}
          label="平移工具（空格 / Ctrl 临时切换）"
          active={canvasTool === 'pan'}
          onClick={() => onCanvasToolChange('pan')}
        />
        <ToolbarDivider />
        <DockButton icon={<Undo2 />} label="撤销 (Ctrl+Z)" disabled={!canUndo} onClick={onUndo} />
        <DockButton
          icon={<Redo2 />}
          label="重做 (Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={onRedo}
        />
        <ToolbarDivider />
        <DockButton icon={<Type />} label="文本节点" onClick={onAddText} />
        <DockButton icon={<ImageIcon />} label="图片节点" onClick={onAddImage} />
        <DockButton icon={<Video />} label="视频节点" onClick={onAddVideo} />
        <DockButton icon={<Music2 />} label="音频节点" onClick={onAddAudio} />
        <DockButton icon={<Settings2 />} label="生成配置节点" onClick={onAddConfig} />
        <DockButton icon={<Grid2x2 />} label="分组" onClick={onAddGroup} />
        <ToolbarDivider />
        <div className="relative">
          <DockButton
            icon={<Puzzle />}
            label="扩展节点"
            active={extensionsOpen}
            onClick={() => setExtensionsOpen((open) => !open)}
          />
          {extensionsOpen && (
            <div
              className="absolute bottom-[72px] left-1/2 w-[260px] -translate-x-1/2 rounded-xl border p-2 shadow-2xl backdrop-blur"
              data-canvas-no-zoom
              style={dockStyle}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <p className="px-2 py-1 text-xs font-semibold opacity-60">扩展节点</p>
              {listCanvasExtensionDefinitions().map((definition) => (
                <button
                  key={definition.type}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => {
                    onAddExtensionNode(definition.type)
                    setExtensionsOpen(false)
                  }}
                >
                  <span
                    className="grid size-7 place-items-center rounded-md"
                    style={{ background: theme.node.fill }}
                  >
                    {definition.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{definition.title}</span>
                    <span className="block truncate opacity-55">{definition.description}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <ToolbarDivider />
        <DockButton icon={<Upload />} label="导入图片 / 视频 / 音频" onClick={onUpload} />
        <div className="relative">
          <DockButton
            icon={<Square />}
            label="画布外观"
            active={stylePanelOpen}
            onClick={() => setStylePanelOpen((open) => !open)}
          />
          {stylePanelOpen && (
            <div
              ref={panelRef}
              className="absolute bottom-[72px] left-1/2 w-[248px] -translate-x-1/2 rounded-xl border p-3 shadow-2xl backdrop-blur"
              data-canvas-no-zoom
              style={{ ...dockStyle }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <p className="mb-2 px-1 text-xs font-semibold opacity-60">背景网格</p>
              <div className="mb-3 flex gap-1">
                {(
                  [
                    { value: 'dots', label: '点阵', icon: <CircleDot className="size-4" /> },
                    { value: 'lines', label: '线条', icon: <Grid2x2 className="size-4" /> },
                    { value: 'blank', label: '空白', icon: <Square className="size-4" /> }
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="flex flex-1 flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs transition"
                    style={{
                      borderColor:
                        settings.backgroundMode === option.value
                          ? theme.node.activeStroke
                          : theme.toolbar.border,
                      background:
                        settings.backgroundMode === option.value
                          ? theme.toolbar.activeBg
                          : 'transparent',
                      color:
                        settings.backgroundMode === option.value
                          ? theme.toolbar.activeText
                          : theme.toolbar.item
                    }}
                    onClick={() => onSettingsChange({ backgroundMode: option.value })}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
              <label className="flex cursor-pointer items-center justify-between px-1 py-1 text-sm">
                图片信息
                <input
                  type="checkbox"
                  checked={settings.showImageInfo}
                  onChange={(event) => onSettingsChange({ showImageInfo: event.target.checked })}
                  className="size-4 accent-current"
                />
              </label>
            </div>
          )}
        </div>
        {onOpenMediaConfig && (
          <DockButton icon={<Key />} label="生图 API 配置" onClick={onOpenMediaConfig} />
        )}
        {selectedCount > 0 && (
          <DockButton
            icon={<Trash2 />}
            label={`删除选中 (${selectedCount})`}
            danger
            onClick={onDelete}
          />
        )}
        <DockButton icon={<Eraser />} label="清空画布" danger onClick={onClear} />
      </div>
    </div>
  )
}

// ── 顶部栏 ──

export interface CanvasTopBarProps {
  theme: CanvasTheme
  title: string
  canUndo: boolean
  canRedo: boolean
  sidePanelOpen?: boolean
  onToggleSidePanel?: () => void
  onBack: () => void
  onCreateProject: () => void
  onDeleteProject: () => void
  onExportProject: () => void
  onExportSelected?: () => void
  onDuplicateProject?: () => void
  onImportFiles: () => void
  onUndo: () => void
  onRedo: () => void
  onRenameProject: (title: string) => void
  onToggleAgent?: () => void
  agentOpen?: boolean
}

/** 顶栏：返回、菜单（新建/删除/导入/导出/撤销重做）、可编辑标题。 */
export function CanvasTopBar({
  theme,
  title,
  canUndo,
  canRedo,
  sidePanelOpen,
  onToggleSidePanel,
  onBack,
  onCreateProject,
  onDeleteProject,
  onExportProject,
  onExportSelected,
  onDuplicateProject,
  onImportFiles,
  onUndo,
  onRedo,
  onRenameProject,
  onToggleAgent,
  agentOpen = false
}: CanvasTopBarProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(title)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!titleEditing) setTitleDraft(title)
  }, [title, titleEditing])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [menuOpen])

  const commitTitle = (): void => {
    const next = titleDraft.trim()
    if (next && next !== title) onRenameProject(next)
    setTitleEditing(false)
  }

  const menuItem = (
    icon: ReactNode,
    label: string,
    action: () => void,
    danger = false,
    hint?: string
  ): ReactNode => (
    <button
      key={label}
      type="button"
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition hover:opacity-80"
      style={{ color: danger ? '#f87171' : theme.node.text }}
      onMouseEnter={(event) => (event.currentTarget.style.background = theme.toolbar.itemHover)}
      onMouseLeave={(event) => (event.currentTarget.style.background = 'transparent')}
      onClick={() => {
        setMenuOpen(false)
        action()
      }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {hint && <span className="text-xs opacity-50">{hint}</span>}
    </button>
  )

  return (
    <div className="pointer-events-none absolute top-0 right-0 left-0 z-50 flex h-16 items-center justify-between pr-4 pl-1">
      <div className="pointer-events-auto flex items-center gap-1">
        {onToggleSidePanel && (
          <button
            type="button"
            title={sidePanelOpen ? '收起侧栏' : '展开侧栏'}
            onClick={onToggleSidePanel}
            className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
            style={{ color: theme.node.label }}
          >
            {sidePanelOpen ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
          </button>
        )}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            title="画布菜单"
            onClick={() => setMenuOpen((open) => !open)}
            className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
            style={{ color: theme.node.label }}
          >
            <Menu className="size-4" />
          </button>
          {menuOpen && (
            <div
              className="absolute top-full left-0 mt-1 w-56 overflow-hidden rounded-xl border p-1 shadow-2xl backdrop-blur"
              style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
            >
              {menuItem(<Plus className="size-4" />, '新建画布', onCreateProject)}
              {menuItem(<Trash2 className="size-4" />, '删除当前画布', onDeleteProject, true)}
              {onDuplicateProject &&
                menuItem(<Copy className="size-4" />, '复制当前画布', onDuplicateProject)}
              <div className="my-1 h-px" style={{ background: theme.toolbar.border }} />
              {menuItem(<Upload className="size-4" />, '导入媒体文件', onImportFiles)}
              {menuItem(<Download className="size-4" />, '导出画布 JSON', onExportProject)}
              {onExportSelected &&
                menuItem(<Download className="size-4" />, '导出选中节点', onExportSelected)}
              <div className="my-1 h-px" style={{ background: theme.toolbar.border }} />
              {menuItem(<Undo2 className="size-4" />, '撤销', onUndo, false, 'Ctrl Z')}
              {menuItem(<Redo2 className="size-4" />, '重做', onRedo, false, 'Ctrl ⇧ Z')}
            </div>
          )}
        </div>
        <button
          type="button"
          title="返回项目列表"
          onClick={onBack}
          className="ml-1 grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
          style={{ color: theme.node.label }}
        >
          <X className="size-4" />
        </button>
        {titleEditing ? (
          <input
            autoFocus
            value={titleDraft}
            maxLength={64}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitTitle()
              if (event.key === 'Escape') setTitleEditing(false)
            }}
            className="max-w-[280px] border-0 border-b border-dashed bg-transparent text-lg font-semibold outline-none"
            style={{ color: theme.node.text, borderColor: theme.node.stroke }}
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setTitleEditing(true)}
            title="双击重命名"
            className="max-w-[280px] truncate border-b border-dashed border-transparent text-lg font-semibold transition hover:border-current"
            style={{ color: theme.node.text }}
          >
            {title || '未命名画布'}
          </button>
        )}
      </div>
      <div className="pointer-events-auto flex items-center gap-2">
        <DockButton icon={<Undo2 />} label="撤销" disabled={!canUndo} onClick={onUndo} />
        <DockButton icon={<Redo2 />} label="重做" disabled={!canRedo} onClick={onRedo} />
        {onToggleAgent && (
          <DockButton icon={<Bot />} label="画布助手" active={agentOpen} onClick={onToggleAgent} />
        )}
      </div>
    </div>
  )
}

// ── 缩放控件 ──

export interface CanvasZoomControlsProps {
  theme: CanvasTheme
  scale: number
  onScaleChange: (scale: number) => void
  onReset: () => void
  isMiniMapOpen: boolean
  onToggleMiniMap: () => void
}

export function CanvasZoomControls({
  theme,
  scale,
  onScaleChange,
  onReset,
  isMiniMapOpen,
  onToggleMiniMap
}: CanvasZoomControlsProps): React.ReactElement {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const dockStyle = {
    background: theme.toolbar.panel,
    borderColor: theme.toolbar.border,
    color: theme.toolbar.item
  }

  return (
    <div
      className="absolute bottom-5 left-5 z-50"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className="flex h-14 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur"
        style={dockStyle}
      >
        <DockButton
          icon={<Compass />}
          label={isMiniMapOpen ? '关闭小地图' : '打开小地图'}
          active={isMiniMapOpen}
          onClick={onToggleMiniMap}
        />
        <DockButton icon={<Focus />} label="重置视图" onClick={onReset} />
        <input
          type="range"
          min={5}
          max={500}
          step={1}
          value={Math.round(scale * 100)}
          onChange={(event) => onScaleChange(Number(event.target.value) / 100)}
          className="w-24"
          style={{ accentColor: theme.node.activeStroke }}
          aria-label="缩放"
        />
        <span className="w-10 text-right text-xs tabular-nums" style={{ color: theme.node.muted }}>
          {Math.round(scale * 100)}%
        </span>
        <DockButton
          icon={<HelpCircle />}
          label="快捷键"
          active={shortcutsOpen}
          onClick={() => setShortcutsOpen(true)}
        />
      </div>
      {shortcutsOpen && (
        <div
          className="absolute bottom-[72px] left-0 w-80 rounded-xl border p-4 shadow-2xl backdrop-blur"
          style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
          data-canvas-no-zoom
        >
          <div className="mb-3 flex items-center justify-between">
            <p className="text-base font-semibold">快捷键</p>
            <button
              type="button"
              onClick={() => setShortcutsOpen(false)}
              className="grid size-6 place-items-center rounded-lg opacity-55 transition hover:opacity-100"
            >
              <X className="size-4" />
            </button>
          </div>
          <ShortcutRow label="空格 / Ctrl + 拖拽" value="临时切换平移工具" />
          <ShortcutRow label="滚轮" value="缩放画布" />
          <ShortcutRow label="拖拽空白" value="框选节点" />
          <ShortcutRow label="Shift / Ctrl + 点击" value="追加选中" />
          <ShortcutRow label="双击空白" value="创建节点" />
          <ShortcutRow label="Ctrl / Cmd + C / V" value="复制粘贴节点" />
          <ShortcutRow label="Delete / Backspace" value="删除选中" />
          <ShortcutRow label="Ctrl + Z / Shift+Z" value="撤销 / 重做" />
          <ShortcutRow label="Ctrl + A" value="全选节点" />
        </div>
      )}
    </div>
  )
}

function ShortcutRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <span className="opacity-60">{value}</span>
    </div>
  )
}

// ── 小地图 ──

export interface MiniMapProps {
  theme: CanvasTheme
  nodes: CanvasNodeData[]
  viewport: ViewportTransform
  viewportSize: { width: number; height: number }
  onViewportChange: (viewport: ViewportTransform) => void
}

const MINIMAP_WIDTH = 240
const MINIMAP_HEIGHT = 160

export function Minimap({
  theme,
  nodes,
  viewport,
  viewportSize,
  onViewportChange
}: MiniMapProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const { worldBounds, scale, offset } = useMemo(() => {
    if (!nodes.length) {
      return {
        worldBounds: { x: -500, y: -500, w: 1000, h: 1000 },
        scale: 0.16,
        offset: { x: 40, y: 0 }
      }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of nodes) {
      minX = Math.min(minX, node.position.x)
      minY = Math.min(minY, node.position.y)
      maxX = Math.max(maxX, node.position.x + node.width)
      maxY = Math.max(maxY, node.position.y + node.height)
    }
    minX -= 500
    minY -= 500
    maxX += 500
    maxY += 500
    const boundsWidth = maxX - minX
    const boundsHeight = maxY - minY
    const nextScale = Math.min(MINIMAP_WIDTH / boundsWidth, MINIMAP_HEIGHT / boundsHeight)
    return {
      worldBounds: { x: minX, y: minY, w: boundsWidth, h: boundsHeight },
      scale: nextScale,
      offset: {
        x: (MINIMAP_WIDTH - boundsWidth * nextScale) / 2,
        y: (MINIMAP_HEIGHT - boundsHeight * nextScale) / 2
      }
    }
  }, [nodes])

  const toMinimap = (worldX: number, worldY: number): Position => ({
    x: (worldX - worldBounds.x) * scale + offset.x,
    y: (worldY - worldBounds.y) * scale + offset.y
  })
  const toWorld = (mapX: number, mapY: number): Position => ({
    x: (mapX - offset.x) / scale + worldBounds.x,
    y: (mapY - offset.y) / scale + worldBounds.y
  })

  const vx = -viewport.x / viewport.k
  const vy = -viewport.y / viewport.k
  const p1 = toMinimap(vx, vy)
  const p2 = toMinimap(vx + viewportSize.width / viewport.k, vy + viewportSize.height / viewport.k)
  const viewportRect = {
    x: p1.x,
    y: p1.y,
    w: Math.max(p2.x - p1.x, 4),
    h: Math.max(p2.y - p1.y, 4)
  }

  const updateFromEvent = (event: React.PointerEvent): void => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const world = toWorld(event.clientX - rect.left, event.clientY - rect.top)
    onViewportChange({
      x: viewportSize.width / 2 - world.x * viewport.k,
      y: viewportSize.height / 2 - world.y * viewport.k,
      k: viewport.k
    })
  }

  return (
    <div
      className="absolute bottom-24 left-6 z-50 overflow-hidden rounded-lg border shadow-2xl backdrop-blur-sm"
      style={{
        width: MINIMAP_WIDTH,
        height: MINIMAP_HEIGHT,
        background: theme.toolbar.panel,
        borderColor: theme.toolbar.border
      }}
    >
      <div
        ref={containerRef}
        className="relative h-full w-full cursor-crosshair"
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          setIsDragging(true)
          updateFromEvent(event)
        }}
        onPointerMove={(event) => {
          if (isDragging) updateFromEvent(event)
        }}
        onPointerUp={() => setIsDragging(false)}
        onPointerLeave={() => setIsDragging(false)}
      >
        {nodes.map((node) => {
          const pos = toMinimap(node.position.x, node.position.y)
          return (
            <div
              key={node.id}
              className="absolute rounded-[1px]"
              style={{
                left: pos.x,
                top: pos.y,
                width: Math.max(node.width * scale, 2),
                height: Math.max(node.height * scale, 2),
                backgroundColor:
                  node.type === 'image'
                    ? '#059669'
                    : node.type === 'config'
                      ? '#7c3aed'
                      : node.type === 'group'
                        ? '#64748b'
                        : getCanvasNodeMinimapColor(node.type, theme.node.muted),
                opacity: 0.8
              }}
            />
          )
        })}
        <div
          className="pointer-events-none absolute border"
          style={{
            left: viewportRect.x,
            top: viewportRect.y,
            width: viewportRect.w,
            height: viewportRect.h,
            borderColor: theme.node.activeStroke,
            background: `${theme.node.activeStroke}18`
          }}
        />
      </div>
    </div>
  )
}

// ── 右键菜单 ──

export interface CanvasContextMenuProps {
  theme: CanvasTheme
  menu: ContextMenuState
  onClose: () => void
  onDuplicate: () => void
  onDelete: () => void
}

export function CanvasContextMenu({
  theme,
  menu,
  onClose,
  onDuplicate,
  onDelete
}: CanvasContextMenuProps): React.ReactElement {
  useEffect(() => {
    const close = (): void => onClose()
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [onClose])

  return (
    <div
      className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
      style={{
        left: menu.x,
        top: menu.y,
        background: theme.toolbar.panel,
        borderColor: theme.toolbar.border,
        color: theme.node.text
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.type === 'node' && (
        <MenuRow
          icon={<Plus className="size-4" />}
          label="创建副本"
          theme={theme}
          onClick={onDuplicate}
        />
      )}
      <MenuRow
        icon={<Trash2 className="size-4" />}
        label="删除"
        theme={theme}
        danger
        onClick={onDelete}
      />
    </div>
  )
}

function MenuRow({
  icon,
  label,
  theme,
  danger = false,
  onClick
}: {
  icon: ReactNode
  label: string
  theme: CanvasTheme
  danger?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80"
      style={{ color: danger ? '#f87171' : theme.node.text }}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

// ── 创建菜单（双击空白 / 连线落点） ──

interface CreateOptionSpec {
  type: string
  icon: ReactNode
  title: string
  description?: string
}

const CREATE_OPTIONS: CreateOptionSpec[] = [
  {
    type: 'text',
    icon: <List className="size-5" />,
    title: NODE_DEFAULT_SIZE.text.title,
    description: '记录提示词或素材文本'
  },
  { type: 'image', icon: <ImageIcon className="size-5" />, title: NODE_DEFAULT_SIZE.image.title },
  { type: 'video', icon: <Video className="size-5" />, title: NODE_DEFAULT_SIZE.video.title },
  { type: 'audio', icon: <Music2 className="size-5" />, title: NODE_DEFAULT_SIZE.audio.title },
  {
    type: 'config',
    icon: <Settings2 className="size-5" />,
    title: NODE_DEFAULT_SIZE.config.title,
    description: '汇聚上游输入，组织生成指令'
  }
]

function CreateOption({
  theme,
  spec,
  onClick
}: {
  theme: CanvasTheme
  spec: CreateOptionSpec
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
      style={{ color: theme.node.text }}
      onClick={onClick}
      onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
      onMouseLeave={(event) => (event.currentTarget.style.background = 'transparent')}
    >
      <span
        className="grid size-11 shrink-0 place-items-center rounded-xl"
        style={{ background: theme.node.fill, color: theme.node.muted }}
      >
        {spec.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-base leading-5 font-semibold">
          {spec.title}
        </span>
        {spec.description && (
          <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
            {spec.description}
          </span>
        )}
      </span>
    </button>
  )
}

export interface ConnectionCreateMenuProps {
  theme: CanvasTheme
  pending: PendingConnectionCreate
  onCreate: (type: string) => void
  onClose: () => void
}

/** 连线落到空白处时弹出：从该节点继续创建下一跳。 */
export function ConnectionCreateMenu({
  theme,
  pending,
  onCreate,
  onClose
}: ConnectionCreateMenuProps): React.ReactElement {
  return (
    <div
      className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
      data-canvas-no-zoom
      data-connection-create-menu
      style={{
        left: pending.position.x,
        top: pending.position.y,
        background: theme.node.panel,
        borderColor: theme.node.stroke,
        color: theme.node.text
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
          从当前节点继续创建
        </span>
        <button
          type="button"
          className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100"
          onClick={onClose}
          aria-label="关闭"
        >
          ×
        </button>
      </div>
      <div className="grid gap-1">
        {CREATE_OPTIONS.map((spec) => (
          <CreateOption
            key={spec.type}
            theme={theme}
            spec={spec}
            onClick={() => onCreate(spec.type)}
          />
        ))}
      </div>
    </div>
  )
}

export interface NodeCreateMenuProps {
  theme: CanvasTheme
  position: Position
  onCreate: (type: string) => void
  onClose: () => void
}

/** 双击空白处弹出：在点击位置创建新节点。 */
export function NodeCreateMenu({
  theme,
  position,
  onCreate,
  onClose
}: NodeCreateMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="thin-scrollbar absolute z-[120] max-h-[70vh] w-[300px] overflow-y-auto rounded-[18px] border p-3 shadow-2xl backdrop-blur"
      data-canvas-no-zoom
      style={{
        left: position.x,
        top: position.y,
        background: theme.node.panel,
        borderColor: theme.node.stroke,
        color: theme.node.text
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
          选择要创建的节点
        </span>
        <button
          type="button"
          className="grid size-7 place-items-center rounded-lg opacity-55 transition hover:opacity-100"
          onClick={onClose}
          aria-label="关闭"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="grid gap-1">
        {CREATE_OPTIONS.map((spec) => (
          <CreateOption
            key={spec.type}
            theme={theme}
            spec={spec}
            onClick={() => onCreate(spec.type)}
          />
        ))}
        <CreateOption
          theme={theme}
          spec={{
            type: 'group',
            icon: <Grid2x2 className="size-5" />,
            title: NODE_DEFAULT_SIZE.group.title,
            description: '把相关节点圈进一组'
          }}
          onClick={() => onCreate('group')}
        />
      </div>
    </div>
  )
}

// ── 主题切换按钮（跟随宿主暗色模式） ──

export function ThemeToggleButton(): React.ReactElement {
  const toggle = (): void => {
    const root = document.documentElement
    root.classList.toggle('dark', !root.classList.contains('dark'))
    root.classList.toggle('light', root.classList.contains('dark') ? false : true)
    window.dispatchEvent(new CustomEvent('pi-theme-changed'))
  }
  const isDark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  return (
    <Button variant="ghost" size="icon" className="size-9" title="切换明暗" onClick={toggle}>
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}
