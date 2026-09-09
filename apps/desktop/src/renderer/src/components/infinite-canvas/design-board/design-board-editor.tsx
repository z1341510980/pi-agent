import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { Frame, Square, Type, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useCanvasTheme } from '../canvas-theme'
import { proxyExternalImageUrl } from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { collectCanvasImageResources } from './design-board-resources'
import {
  DESIGN_IMAGE_PLACEHOLDER,
  createDesignBoardDoc,
  createImageObject,
  createRectObject,
  createTextObject,
  parseDesignBoardDoc,
  resolveDesignImageSource
} from './design-board-types'
import type { DesignBoardDoc, DesignBoardObject, DesignImageSource } from './design-board-types'
import {
  RESIZE_HANDLE_IDS,
  cursorForHandle,
  pointerToScene,
  resizeBoxWithHandle,
  solveSnapDelta
} from './design-board-interaction'
import type { ResizeHandleId } from './design-board-interaction'

const ZOOM_MIN_PCT = 5
const ZOOM_MAX_PCT = 500
const FIT_PADDING = 48
const HISTORY_DEBOUNCE_MS = 140
const HISTORY_LIMIT = 50
const NUDGE_PX = 1
const NUDGE_PX_LARGE = 10
const CLONE_OFFSET_PX = 24
const MIN_FONT_SIZE = 8
const MIN_TEXT_WIDTH = 24
const WHEEL_ZOOM_SENSITIVITY = 0.006

interface DragState {
  kind: 'move' | 'resize'
  objectId: string
  initial: { x: number; y: number; width: number; height: number }
  handle?: ResizeHandleId
  startPointer: { x: number; y: number }
  prevGuideX: number | null
}

interface HistoryState {
  stack: string[]
  index: number
  applying: boolean
}

export interface DesignBoardEditorProps {
  node: CanvasNodeData
  nodes: CanvasNodeData[]
  onCommit: (doc: DesignBoardDoc) => void
  onClose: () => void
  onExport?: (format: 'png' | 'jpg', doc: DesignBoardDoc) => Promise<void>
}

/** 全屏设计编辑器：DOM 对象视图 + 交互引擎接线 + 撤销栈 + 资源面板。 */
export function DesignBoardEditor({
  node,
  nodes,
  onCommit,
  onClose,
  onExport
}: DesignBoardEditorProps): ReactElement {
  const theme = useCanvasTheme()
  const [doc, setDoc] = useState<DesignBoardDoc>(
    () => parseDesignBoardDoc(node.metadata?.design) ?? createDesignBoardDoc(1080, 1440)
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [exportFormat, setExportFormat] = useState<'png' | 'jpg'>('png')
  const [textEditingId, setTextEditingId] = useState<string | null>(null)
  const [textDraft, setTextDraft] = useState('')
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null
  })
  const viewportRef = useRef<HTMLDivElement>(null)
  const artboardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const historyRef = useRef<HistoryState>({ stack: [], index: -1, applying: false })

  const scale = zoomPercent / 100
  const selectedObject = doc.objects.find((object) => object.id === selectedId) ?? null
  const resources = useMemo(() => collectCanvasImageResources(nodes), [nodes])

  const fitZoom = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    const availableWidth = Math.max(200, viewport.clientWidth - FIT_PADDING * 2)
    const availableHeight = Math.max(200, viewport.clientHeight - FIT_PADDING * 2)
    const percent = Math.floor(
      Math.min(availableWidth / doc.width, availableHeight / doc.height) * 100
    )
    setZoomPercent(Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, percent)))
  }, [doc.width, doc.height])

  useEffect(() => {
    fitZoom()
  }, [fitZoom])

  // Ctrl+滚轮缩放需要 preventDefault：React onWheel 是被动监听，这里手动挂非被动监听
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      setZoomPercent((current) => {
        const next = current * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY)
        return Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, next))
      })
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [])

  // 历史栈：140ms debounce + JSON 去重 + applying 守卫 + 上限 50
  useEffect(() => {
    const state = historyRef.current
    if (state.applying) return
    if (state.index === -1) {
      state.stack = [JSON.stringify(doc)]
      state.index = 0
      return
    }
    const timer = setTimeout(() => {
      const snapshot = JSON.stringify(doc)
      if (state.stack[state.index] === snapshot) return
      state.stack = state.stack.slice(0, state.index + 1)
      state.stack.push(snapshot)
      if (state.stack.length > HISTORY_LIMIT) state.stack.shift()
      state.index = state.stack.length - 1
    }, HISTORY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [doc])

  const restoreHistory = useCallback((index: number): void => {
    const state = historyRef.current
    const snapshot = state.stack[index]
    if (snapshot === undefined) return
    state.applying = true
    state.index = index
    setDoc(JSON.parse(snapshot) as DesignBoardDoc)
    setSelectedId(null)
    setTextEditingId(null)
    setTimeout(() => {
      state.applying = false
    }, 0)
  }, [])

  const undo = useCallback((): void => {
    restoreHistory(Math.max(0, historyRef.current.index - 1))
  }, [restoreHistory])

  const redo = useCallback((): void => {
    restoreHistory(Math.min(historyRef.current.stack.length - 1, historyRef.current.index + 1))
  }, [restoreHistory])

  // 文本编辑：草稿在提交点同步写回文档，避免闭包拿到旧 doc。
  // 返回提交后的 doc，供复制等需要读取「已含草稿」对象的路径同步使用。
  // 幂等：textEditingId 已清空时直接返回当前 doc，重复调用无副作用。
  const commitTextDraft = useCallback((): DesignBoardDoc => {
    if (!textEditingId) return doc
    const finalDoc = applyTextDraftToDoc(doc, textEditingId, textDraft)
    if (finalDoc !== doc) setDoc(finalDoc)
    setTextEditingId(null)
    return finalDoc
  }, [doc, textDraft, textEditingId])

  // 导出用当前 doc（含未提交文本草稿）；编辑器保持打开，错误提示由调用方负责。
  const handleExport = useCallback((): void => {
    if (!onExport) return
    const finalDoc = commitTextDraft()
    void onExport(exportFormat, finalDoc).catch((reason) => {
      console.error('设计画板导出失败', reason)
    })
  }, [commitTextDraft, exportFormat, onExport])

  // 对象操作
  const updateObject = useCallback(
    (objectId: string, updater: (object: DesignBoardObject) => DesignBoardObject): void => {
      setDoc((current) => ({
        ...current,
        objects: current.objects.map((object) =>
          object.id === objectId ? updater(object) : object
        )
      }))
    },
    []
  )

  const addObject = useCallback((object: DesignBoardObject): void => {
    setDoc((current) => ({ ...current, objects: [...current.objects, object] }))
    setSelectedId(object.id)
  }, [])

  const addText = useCallback((): void => {
    // 先落盘草稿：下方 setTextEditingId/setTextDraft 会覆写当前编辑状态
    commitTextDraft()
    const object = createTextObject(doc.width / 2 - 160, doc.height / 2 - 40, 320)
    addObject(object)
    setTextEditingId(object.id)
    setTextDraft('')
  }, [addObject, commitTextDraft, doc.height, doc.width])

  const addRect = useCallback((): void => {
    commitTextDraft()
    const size = Math.round(Math.min(doc.width, doc.height) * 0.16)
    addObject(createRectObject(doc.width / 2 - size / 2, doc.height / 2 - size / 2, size, size))
  }, [addObject, commitTextDraft, doc.height, doc.width])

  const insertResource = useCallback(
    (nodeId: string, index: number): void => {
      commitTextDraft()
      const width = Math.round(doc.width * 0.4)
      addObject(
        createImageObject(
          { kind: 'node-ref', nodeId, index },
          doc.width / 2 - width / 2,
          doc.height * 0.3,
          width,
          Math.round(width * 0.6)
        )
      )
    },
    [addObject, commitTextDraft, doc.height, doc.width]
  )

  const duplicateSelected = useCallback((): void => {
    if (!selectedObject) return
    const committedDoc = commitTextDraft()
    const source =
      committedDoc.objects.find((object) => object.id === selectedObject.id) ?? selectedObject
    const clone = JSON.parse(JSON.stringify(source)) as DesignBoardObject
    clone.id = makeObjectId()
    clone.x += CLONE_OFFSET_PX
    clone.y += CLONE_OFFSET_PX
    addObject(clone)
  }, [addObject, commitTextDraft, selectedObject])

  const deleteSelected = useCallback((): void => {
    if (!selectedId) return
    setDoc((current) => ({
      ...current,
      objects: current.objects.filter((object) => object.id !== selectedId)
    }))
    setSelectedId(null)
  }, [selectedId])

  // 拖拽/缩放（window 级 move/up/cancel）
  const boardRect = (): { left: number; top: number } => {
    const rect = artboardRef.current?.getBoundingClientRect()
    return { left: rect?.left ?? 0, top: rect?.top ?? 0 }
  }

  const startDrag = (event: ReactPointerEvent, objectId: string, handle?: ResizeHandleId): void => {
    if (textEditingId && textEditingId !== objectId) commitTextDraft()
    const object = doc.objects.find((item) => item.id === objectId)
    if (!object) return
    const pointer = pointerToScene(
      event.clientX,
      event.clientY,
      boardRect(),
      scale,
      doc.width,
      doc.height
    )
    dragRef.current = {
      kind: handle ? 'resize' : 'move',
      objectId,
      initial: { x: object.x, y: object.y, width: object.width, height: object.height },
      handle,
      startPointer: pointer,
      prevGuideX: null
    }
    setSelectedId(objectId)
  }

  useEffect(() => {
    const handleMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const pointer = pointerToScene(
        event.clientX,
        event.clientY,
        boardRect(),
        scale,
        doc.width,
        doc.height
      )
      if (drag.kind === 'move') {
        let dx = pointer.x - drag.startPointer.x
        let dy = pointer.y - drag.startPointer.y
        // 吸附参考的 moving bounds 用「对象初始位置 + 总位移」，
        // 不能用当前 doc 位置（那会叠加已应用的位移导致阈值翻倍）
        const bounds = {
          left: drag.initial.x + dx,
          top: drag.initial.y + dy,
          right: drag.initial.x + drag.initial.width + dx,
          bottom: drag.initial.y + drag.initial.height + dy
        }
        const targets = doc.objects.filter((item) => item.id !== drag.objectId)
        const snap = solveSnapDelta(bounds, targets, doc.width, doc.height, drag.prevGuideX)
        dx += snap.dx
        dy += snap.dy
        drag.prevGuideX = snap.guideX
        setSnapGuides({ x: snap.guideX, y: snap.guideY })
        updateObject(drag.objectId, (object) => ({
          ...object,
          x: drag.initial.x + dx,
          y: drag.initial.y + dy
        }))
        return
      }
      if (drag.kind === 'resize' && drag.handle) {
        const object = doc.objects.find((item) => item.id === drag.objectId)
        if (!object) return
        const keepRatio = object.kind === 'image'
        const box = resizeBoxWithHandle(drag.initial, drag.handle, pointer, { keepRatio })
        updateObject(drag.objectId, (current) => {
          if (current.kind === 'text') {
            const factor = Math.max(
              0.1,
              Math.max(
                box.width / Math.max(1, drag.initial.width),
                box.height / Math.max(1, drag.initial.height)
              )
            )
            const fontSize = Math.max(MIN_FONT_SIZE, Math.round(current.fontSize * factor))
            return {
              ...current,
              width: Math.max(MIN_TEXT_WIDTH, box.width),
              height: Math.max(current.height, box.height),
              fontSize
            }
          }
          return { ...current, x: box.x, y: box.y, width: box.width, height: box.height }
        })
      }
    }
    const handleUp = (): void => {
      dragRef.current = null
      setSnapGuides({ x: null, y: null })
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [doc, scale, updateObject])

  // 快捷键（window keydown capture，编辑控件守卫）
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof Element && Boolean(target.closest('[contenteditable="true"]')))
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (textEditingId) {
          commitTextDraft()
          event.preventDefault()
        }
        return
      }
      if (isEditableTarget(event.target)) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelected()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelected()
        return
      }
      if (event.key.startsWith('Arrow') && selectedId) {
        event.preventDefault()
        const step = event.shiftKey ? NUDGE_PX_LARGE : NUDGE_PX
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        updateObject(selectedId, (object) => ({ ...object, x: object.x + dx, y: object.y + dy }))
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [
    commitTextDraft,
    deleteSelected,
    duplicateSelected,
    redo,
    selectedId,
    textEditingId,
    undo,
    updateObject
  ])

  const finish = useCallback((): void => {
    const finalDoc = applyTextDraftToDoc(doc, textEditingId, textDraft)
    if (finalDoc !== doc) {
      setDoc(finalDoc)
      setTextEditingId(null)
    }
    onCommit(finalDoc)
    onClose()
  }, [doc, textDraft, textEditingId, onCommit, onClose])

  const screenScale = Math.max(scale, 0.01)

  return (
    <div
      className="fixed inset-0 z-[150] flex flex-col"
      data-canvas-no-zoom
      style={{ background: theme.canvas.background, color: theme.node.text }}
    >
      {/* 顶栏 */}
      <div
        className="flex h-14 items-center gap-2 border-b px-4"
        style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
      >
        <Frame className="size-4" />
        <span className="mr-2 truncate text-base font-semibold">{node.title}</span>
        <span className="text-xs opacity-55">
          {doc.width}×{doc.height}
        </span>
        <div className="mx-2 h-6 w-px" style={{ background: theme.toolbar.border }} />
        <Button variant="ghost" size="sm" onClick={undo}>
          撤销
        </Button>
        <Button variant="ghost" size="sm" onClick={redo}>
          重做
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {onExport && (
            <>
              <div className="flex items-center gap-2 text-xs opacity-80">
                <label className="flex cursor-pointer items-center gap-1">
                  <input
                    type="radio"
                    name="design-board-export-format"
                    className="accent-current"
                    checked={exportFormat === 'png'}
                    onChange={() => setExportFormat('png')}
                  />
                  PNG
                </label>
                <label className="flex cursor-pointer items-center gap-1">
                  <input
                    type="radio"
                    name="design-board-export-format"
                    className="accent-current"
                    checked={exportFormat === 'jpg'}
                    onChange={() => setExportFormat('jpg')}
                  />
                  JPG
                </label>
              </div>
              <Button variant="outline" size="sm" onClick={handleExport}>
                导出图片
              </Button>
            </>
          )}
          <Button size="sm" onClick={finish}>
            完成编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="保存并关闭"
            title="保存并关闭"
            onClick={finish}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 资源面板 */}
        <div
          className="thin-scrollbar w-56 shrink-0 overflow-y-auto border-r p-3"
          style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
        >
          <p className="mb-2 text-xs font-semibold opacity-60">画布资源</p>
          {resources.length === 0 && <p className="text-xs opacity-50">画布上暂无图片资源</p>}
          <div className="grid grid-cols-2 gap-2">
            {resources.map((resource) => (
              <button
                key={resource.id}
                type="button"
                title={`${resource.title}（点击插入）`}
                className="overflow-hidden rounded-lg border text-left"
                style={{ borderColor: theme.toolbar.border }}
                onClick={() => insertResource(resource.nodeId, resource.index)}
              >
                <img
                  src={proxyExternalImageUrl(resource.url)}
                  alt={resource.title}
                  className="h-16 w-full object-cover"
                />
                <span className="block truncate px-1 py-0.5 text-[10px] opacity-70">
                  {resource.title}
                </span>
              </button>
            ))}
          </div>
        </div>
        {/* 画板视口 */}
        <div
          ref={viewportRef}
          className="relative flex-1 overflow-auto overscroll-contain"
          style={{ background: theme.canvas.background }}
          onPointerDown={(event) => {
            const target = event.target as HTMLElement
            if (target.closest('[data-design-board-object], [data-design-board-handle]')) return
            commitTextDraft()
            setSelectedId(null)
          }}
        >
          <div className="grid min-h-full place-items-center p-12">
            <div
              ref={artboardRef}
              data-design-board-artboard
              className="relative shadow-2xl"
              style={{
                width: doc.width * scale,
                height: doc.height * scale,
                background: doc.background
              }}
            >
              {/* 对象视图（DOM/SVG） */}
              {doc.objects.map((object) => (
                <div
                  key={object.id}
                  data-design-board-object
                  className="absolute"
                  style={{
                    left: object.x * scale,
                    top: object.y * scale,
                    width: object.width * scale,
                    height: object.height * scale
                  }}
                  onPointerDown={(event) => startDrag(event, object.id)}
                  onDoubleClick={() => {
                    if (object.kind === 'text') {
                      setSelectedId(object.id)
                      setTextEditingId(object.id)
                      setTextDraft(object.text)
                    }
                  }}
                >
                  <ObjectView
                    object={object}
                    scale={scale}
                    editing={textEditingId === object.id}
                    draft={textDraft}
                    onDraftChange={setTextDraft}
                    onCommitDraft={commitTextDraft}
                    resolveUrl={(source) => resolveDesignImageSource(source, nodes)}
                  />
                </div>
              ))}
              {/* 选择覆盖层 */}
              {selectedObject && !textEditingId && (
                <div
                  className="absolute z-[22]"
                  style={{
                    left: selectedObject.x * scale,
                    top: selectedObject.y * scale,
                    width: selectedObject.width * scale,
                    height: selectedObject.height * scale,
                    pointerEvents: 'none'
                  }}
                >
                  <div
                    className="absolute inset-0 border"
                    style={{ borderWidth: 1.5 / screenScale, borderColor: '#3b82f6' }}
                  />
                  {RESIZE_HANDLE_IDS.map((handle) => (
                    <button
                      key={handle}
                      type="button"
                      data-design-board-handle
                      className="absolute z-[23] rounded-sm border border-white"
                      style={{
                        width: 12 / screenScale,
                        height: 12 / screenScale,
                        left: `calc(${handle.includes('w') ? 0 : handle.includes('e') ? 100 : 50}% - ${6 / screenScale}px)`,
                        top: `calc(${handle.includes('n') ? 0 : handle.includes('s') ? 100 : 50}% - ${6 / screenScale}px)`,
                        background: '#3b82f6',
                        cursor: cursorForHandle(handle),
                        pointerEvents: 'auto'
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        startDrag(event, selectedObject.id, handle)
                      }}
                    />
                  ))}
                </div>
              )}
              {/* 吸附参考线 */}
              {snapGuides.x !== null && (
                <div
                  className="absolute top-0 bottom-0 z-[19]"
                  style={{
                    left: snapGuides.x * scale,
                    width: 1 / screenScale,
                    background: '#3b82f6',
                    pointerEvents: 'none'
                  }}
                />
              )}
              {snapGuides.y !== null && (
                <div
                  className="absolute right-0 left-0 z-[19]"
                  style={{
                    top: snapGuides.y * scale,
                    height: 1 / screenScale,
                    background: '#3b82f6',
                    pointerEvents: 'none'
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* 底部工具条 */}
      <div
        className="flex h-14 items-center gap-2 border-t px-4"
        style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
      >
        <Button variant="outline" size="sm" onClick={addText}>
          <Type className="mr-1 size-4" />
          添加文本
        </Button>
        <Button variant="outline" size="sm" onClick={addRect}>
          <Square className="mr-1 size-4" />
          添加矩形
        </Button>
        <Button variant="outline" size="sm" onClick={duplicateSelected} disabled={!selectedObject}>
          复制
        </Button>
        <Button variant="outline" size="sm" onClick={deleteSelected} disabled={!selectedObject}>
          删除
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <input
            type="range"
            min={ZOOM_MIN_PCT}
            max={ZOOM_MAX_PCT}
            value={zoomPercent}
            onChange={(event) => setZoomPercent(Number(event.target.value))}
            className="w-32"
            aria-label="缩放"
          />
          <span className="w-12 text-right text-xs tabular-nums opacity-70">
            {Math.round(zoomPercent)}%
          </span>
        </div>
      </div>
    </div>
  )
}

function ObjectView({
  object,
  scale,
  editing,
  draft,
  onDraftChange,
  onCommitDraft,
  resolveUrl
}: {
  object: DesignBoardObject
  scale: number
  editing: boolean
  draft: string
  onDraftChange: (value: string) => void
  onCommitDraft: () => void
  resolveUrl: (source: DesignImageSource) => string
}): ReactElement {
  if (object.kind === 'text') {
    if (editing) {
      return (
        <textarea
          autoFocus
          value={draft}
          spellCheck={false}
          onChange={(event) => onDraftChange(event.target.value)}
          // blur 提交（工具条/资源面板点击先失焦）；与 pointerdown 路径重复触发时幂等
          onBlur={onCommitDraft}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className="h-full w-full resize-none bg-transparent p-0 outline-none"
          style={{
            color: object.color,
            fontSize: object.fontSize * scale,
            fontWeight: object.fontWeight,
            textAlign: object.align,
            fontFamily: 'inherit'
          }}
        />
      )
    }
    // MVP 简化渲染：单 text + whiteSpace pre；精确换行由 canvas 渲染器负责
    return (
      <svg
        className="h-full w-full overflow-visible"
        viewBox={`0 0 ${object.width} ${object.height}`}
        preserveAspectRatio="none"
      >
        <text
          x={
            object.align === 'center'
              ? object.width / 2
              : object.align === 'right'
                ? object.width
                : 0
          }
          y={object.fontSize * 1.22 * 0.8}
          fill={object.color}
          fontSize={object.fontSize}
          fontWeight={object.fontWeight}
          textAnchor={
            object.align === 'center' ? 'middle' : object.align === 'right' ? 'end' : 'start'
          }
          style={{ whiteSpace: 'pre' }}
        >
          {object.text}
        </text>
      </svg>
    )
  }
  if (object.kind === 'rect') {
    return (
      <svg className="h-full w-full">
        <rect
          x={0}
          y={0}
          width="100%"
          height="100%"
          rx={object.radius}
          fill={object.fill}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
        />
      </svg>
    )
  }
  const url = resolveUrl(object.source)
  return url === DESIGN_IMAGE_PLACEHOLDER ? (
    <div
      className="grid h-full w-full place-items-center border border-dashed text-xs opacity-50"
      style={{ borderColor: 'currentColor' }}
    >
      图片不可用
    </div>
  ) : (
    <img
      src={proxyExternalImageUrl(url)}
      alt=""
      className="h-full w-full object-cover"
      style={{ borderRadius: object.radius }}
      draggable={false}
    />
  )
}

function applyTextDraftToDoc(
  doc: DesignBoardDoc,
  editingId: string | null,
  draft: string
): DesignBoardDoc {
  if (!editingId) return doc
  const index = doc.objects.findIndex((item) => item.id === editingId)
  if (index === -1) return doc
  const object = doc.objects[index]
  if (object.kind !== 'text') return doc
  const height = Math.max(object.height, Math.round(object.fontSize * 1.22))
  if (object.text === draft && object.height === height) return doc
  const objects = [...doc.objects]
  objects[index] = { ...object, text: draft, height }
  return { ...doc, objects }
}

function makeObjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `dbo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}
