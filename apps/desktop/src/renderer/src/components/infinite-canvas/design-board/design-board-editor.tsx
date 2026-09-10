import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode
} from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BringToFront,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Copy,
  Eye,
  EyeOff,
  Frame,
  GripVertical,
  HelpCircle,
  Hexagon,
  Image as ImageIcon,
  Layers,
  Minus,
  Redo2,
  SendToBack,
  Square,
  Star,
  Trash2,
  Type,
  Undo2,
  X
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useCanvasTheme, type CanvasTheme } from '../canvas-theme'
import { proxyExternalImageUrl } from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { collectCanvasImageResources } from './design-board-resources'
import {
  DESIGN_IMAGE_PLACEHOLDER,
  createArrowObject,
  createDesignBoardDoc,
  createEllipseObject,
  createImageObject,
  createLineObject,
  createPolygonObject,
  createRectObject,
  createStarObject,
  createTextObject,
  designBoardFontFamily,
  parseDesignBoardDoc,
  reorderDesignBoardObject,
  reorderDesignBoardObjectToIndex,
  resolveDesignImageSource
} from './design-board-types'
import type {
  DesignBoardDoc,
  DesignBoardObject,
  DesignBoardTextObject,
  DesignBoardZOrderAction,
  DesignImageSource
} from './design-board-types'
import {
  DESIGN_TEXT_LINE_HEIGHT_RATIO,
  designArrowGeometry,
  designPolygonPoints,
  designStarPoints,
  exportDesignTextFont,
  layoutDesignText
} from './design-board-renderer'
import type { DesignTextLayout } from './design-board-renderer'
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
const MAX_FONT_SIZE = 512
const MIN_TEXT_WIDTH = 24
const SELECTION_TOOLBAR_OFFSET_PX = 44
const SELECTION_TOOLBAR_BELOW_GAP_PX = 8
const WHEEL_ZOOM_SENSITIVITY = 0.006
const ZOOM_STEP_MULTIPLIER = 1.1
const PLACE_TEXT_WIDTH = 320
/** 拖画尺寸不足该值（近似点击）时按默认尺寸居中放置 */
const MIN_DRAW_SIZE_PX = 12
/** 默认绘制尺寸系数：min(画板宽, 高)·16% */
const DEFAULT_DRAW_SIZE_RATIO = 0.16
/** line/arrow 创建时的默认描边宽（与工厂默认一致） */
const LINE_DEFAULT_STROKE_WIDTH = 4

/** 形状绘制工具的 6 种 kind（rect 复用点击放置语义） */
const SHAPE_TOOL_OPTIONS = [
  { kind: 'rect', label: '矩形', Icon: Square },
  { kind: 'ellipse', label: '椭圆', Icon: Circle },
  { kind: 'polygon', label: '多边形', Icon: Hexagon },
  { kind: 'star', label: '星形', Icon: Star },
  { kind: 'line', label: '直线', Icon: Minus },
  { kind: 'arrow', label: '箭头', Icon: ArrowRight }
] as const

type DesignShapeKind = (typeof SHAPE_TOOL_OPTIONS)[number]['kind']

/** 形状拖画草稿：起点 + 当前点（场景坐标） */
interface ShapeDraft {
  kind: DesignShapeKind
  start: { x: number; y: number }
  current: { x: number; y: number }
}

interface DragState {
  kind: 'move' | 'resize'
  objectId: string
  initial: { x: number; y: number; width: number; height: number }
  handle?: ResizeHandleId
  startPointer: { x: number; y: number }
  prevGuideX: number | null
  prevGuideY: number | null
}

interface HistoryState {
  stack: string[]
  index: number
  applying: boolean
}

/** 缩放锚点：scene 为画板场景坐标，client 为屏幕坐标，缩放后保持二者重合。 */
interface ZoomAnchor {
  sceneX: number
  sceneY: number
  clientX: number
  clientY: number
}

interface ContextMenuState {
  x: number
  y: number
}

type SidePanelKind = 'layers' | 'images' | 'help'

const LAYER_KIND_LABELS: Record<DesignBoardObject['kind'], string> = {
  text: '文本',
  rect: '矩形',
  image: '图片',
  ellipse: '椭圆',
  polygon: '多边形',
  star: '星形',
  line: '直线',
  arrow: '箭头'
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
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [exportFormat, setExportFormat] = useState<'png' | 'jpg'>('png')
  const [textEditingId, setTextEditingId] = useState<string | null>(null)
  const [textDraft, setTextDraft] = useState('')
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null
  })
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [sidePanel, setSidePanel] = useState<SidePanelKind | null>(null)
  const [layerDragOverId, setLayerDragOverId] = useState<string | null>(null)
  // 形状绘制模式：非空时画板空白区拖画创建该类型对象；文字点选放置模式独立开关
  const [drawShape, setDrawShape] = useState<DesignShapeKind | null>(null)
  const [placeText, setPlaceText] = useState(false)
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false)
  const [shapeDraft, setShapeDraft] = useState<ShapeDraft | null>(null)
  const shapeDraftRef = useRef<ShapeDraft | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const artboardRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const historyRef = useRef<HistoryState>({ stack: [], index: -1, applying: false })
  // wheel 事件可能快于重渲染到达：ref 镜像保证连续缩放从最新值复合
  const zoomPercentRef = useRef(100)

  const scale = zoomPercent / 100
  const selectedObject = doc.objects.find((object) => object.id === selectedId) ?? null
  const hoveredObject = doc.objects.find((object) => object.id === hoveredId) ?? null
  const resources = useMemo(() => collectCanvasImageResources(nodes), [nodes])
  const shapeDraftBox = shapeDraft ? normalizeDraftBox(shapeDraft) : null

  // 统一缩放入口：写状态 + 同步 ref；带锚点时在 rAF（布局完成后）校正滚动，
  // 使锚点场景坐标重绘后仍落在原 client 屏幕位置
  const applyZoomPercent = useCallback((nextPercent: number, anchor?: ZoomAnchor): void => {
    const clamped = Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, nextPercent))
    zoomPercentRef.current = clamped
    setZoomPercent(clamped)
    if (!anchor) return
    const newScale = clamped / 100
    requestAnimationFrame(() => {
      const viewport = viewportRef.current
      const artboard = artboardRef.current
      if (!viewport || !artboard) return
      const viewportRect = viewport.getBoundingClientRect()
      const boardRect = artboard.getBoundingClientRect()
      viewport.scrollLeft +=
        boardRect.left -
        viewportRect.left +
        anchor.sceneX * newScale -
        (anchor.clientX - viewportRect.left)
      viewport.scrollTop +=
        boardRect.top -
        viewportRect.top +
        anchor.sceneY * newScale -
        (anchor.clientY - viewportRect.top)
    })
  }, [])

  const fitZoom = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    const availableWidth = Math.max(200, viewport.clientWidth - FIT_PADDING * 2)
    const availableHeight = Math.max(200, viewport.clientHeight - FIT_PADDING * 2)
    const percent = Math.floor(
      Math.min(availableWidth / doc.width, availableHeight / doc.height) * 100
    )
    applyZoomPercent(Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, percent)))
  }, [applyZoomPercent, doc.width, doc.height])

  // 中心锚（画板中心 ↔ 视口中心）：滑杆与 +/- 步进按钮共用
  const setZoomCentered = useCallback(
    (nextPercent: number): void => {
      const viewport = viewportRef.current
      if (!viewport) {
        applyZoomPercent(nextPercent)
        return
      }
      const viewportRect = viewport.getBoundingClientRect()
      applyZoomPercent(nextPercent, {
        sceneX: doc.width / 2,
        sceneY: doc.height / 2,
        clientX: viewportRect.left + viewport.clientWidth / 2,
        clientY: viewportRect.top + viewport.clientHeight / 2
      })
    },
    [applyZoomPercent, doc.height, doc.width]
  )

  const zoomIn = useCallback((): void => {
    setZoomCentered(zoomPercentRef.current * ZOOM_STEP_MULTIPLIER)
  }, [setZoomCentered])

  const zoomOut = useCallback((): void => {
    setZoomCentered(zoomPercentRef.current / ZOOM_STEP_MULTIPLIER)
  }, [setZoomCentered])

  useEffect(() => {
    fitZoom()
  }, [fitZoom])

  // Ctrl+滚轮缩放需要 preventDefault：React onWheel 是被动监听，这里手动挂非被动监听。
  // 锚点缩放（avnac zoomAroundClientPoint）：先记录指针下的场景坐标，
  // 缩放后在 rAF 内校正 viewport 滚动使该场景点保持在指针位置，避免大画板跳视口
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const artboard = artboardRef.current
      if (!artboard) return
      const boardRect = artboard.getBoundingClientRect()
      const oldScale = Math.max(0.01, zoomPercentRef.current / 100)
      const sceneX = (event.clientX - boardRect.left) / oldScale
      const sceneY = (event.clientY - boardRect.top) / oldScale
      const next = zoomPercentRef.current * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY)
      applyZoomPercent(next, { sceneX, sceneY, clientX: event.clientX, clientY: event.clientY })
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [applyZoomPercent])

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

  /** 文字点选放置：在场景点创建文本并进入编辑态，随后退出放置模式 */
  const addTextAtScenePoint = useCallback(
    (x: number, y: number): void => {
      // 先落盘草稿：下方 setTextEditingId/setTextDraft 会覆写当前编辑状态
      commitTextDraft()
      const object = createTextObject(x, y, PLACE_TEXT_WIDTH)
      addObject(object)
      setTextEditingId(object.id)
      setTextDraft('')
      setPlaceText(false)
    },
    [addObject, commitTextDraft]
  )

  const enterPlaceText = useCallback((): void => {
    commitTextDraft()
    setPlaceText(true)
    setDrawShape(null)
    setShapeMenuOpen(false)
    setSelectedId(null)
  }, [commitTextDraft])

  /** 选择形状工具：再点同项取消，切换工具互斥 */
  const selectShapeTool = useCallback(
    (kind: DesignShapeKind): void => {
      commitTextDraft()
      setShapeMenuOpen(false)
      setDrawShape((current) => (current === kind ? null : kind))
      setPlaceText(false)
      setSelectedId(null)
    },
    [commitTextDraft]
  )

  const cancelShapeDraft = useCallback((): void => {
    shapeDraftRef.current = null
    setShapeDraft(null)
  }, [])

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

  const reorderSelected = useCallback(
    (action: DesignBoardZOrderAction): void => {
      if (!selectedId) return
      setDoc((current) => ({
        ...current,
        objects: reorderDesignBoardObject(current.objects, selectedId, action)
      }))
    },
    [selectedId]
  )

  // 图层面板操作：可见性 / ↑↓ 层级 / 拖拽排序（与画布选中解耦，按对象 id 直改）
  const toggleObjectVisible = useCallback(
    (objectId: string): void => {
      updateObject(objectId, (object) => ({ ...object, visible: !object.visible }))
    },
    [updateObject]
  )

  const moveLayerObject = useCallback((objectId: string, action: DesignBoardZOrderAction): void => {
    setDoc((current) => ({
      ...current,
      objects: reorderDesignBoardObject(current.objects, objectId, action)
    }))
  }, [])

  const reorderObjectToIndex = useCallback((objectId: string, toIndex: number): void => {
    setDoc((current) => ({
      ...current,
      objects: reorderDesignBoardObjectToIndex(current.objects, objectId, toIndex)
    }))
  }, [])

  const selectFromLayers = useCallback(
    (objectId: string): void => {
      if (textEditingId && textEditingId !== objectId) commitTextDraft()
      setSelectedId(objectId)
    },
    [commitTextDraft, textEditingId]
  )

  const toggleSidePanel = useCallback((panel: SidePanelKind): void => {
    setSidePanel((current) => (current === panel ? null : panel))
  }, [])

  // 图层条目按 z 序倒序展示（最上层在最上），保留原数组索引用于拖拽落点定位
  const layerEntries = useMemo(
    () => doc.objects.map((object, index) => ({ object, index })).reverse(),
    [doc.objects]
  )

  // 拖拽/缩放（window 级 move/up/cancel）
  const boardRect = (): { left: number; top: number } => {
    const rect = artboardRef.current?.getBoundingClientRect()
    return { left: rect?.left ?? 0, top: rect?.top ?? 0 }
  }

  const startDrag = (event: ReactPointerEvent, objectId: string, handle?: ResizeHandleId): void => {
    if (event.button !== 0) return
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
      prevGuideX: null,
      prevGuideY: null
    }
    setSelectedId(objectId)
  }

  useEffect(() => {
    const handleMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) {
        // 形状拖画中：仅更新预览终点（场景坐标），不触碰对象
        const draft = shapeDraftRef.current
        if (!draft) return
        const pointer = pointerToScene(
          event.clientX,
          event.clientY,
          boardRect(),
          scale,
          doc.width,
          doc.height
        )
        shapeDraftRef.current = { ...draft, current: pointer }
        setShapeDraft(shapeDraftRef.current)
        return
      }
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
        const snap = solveSnapDelta(
          bounds,
          targets,
          doc.width,
          doc.height,
          drag.prevGuideX,
          drag.prevGuideY
        )
        dx += snap.dx
        dy += snap.dy
        drag.prevGuideX = snap.guideX
        drag.prevGuideY = snap.guideY
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
        // 修饰键语义（avnac）：Alt = 中心缩放；image 角柄恒锁比例，
        // rect 角柄默认锁、Shift 解锁；文本保持 factor 公式（keepRatio 恒 false）
        const keepRatio = object.kind === 'image' || (object.kind === 'rect' && !event.shiftKey)
        const box = resizeBoxWithHandle(drag.initial, drag.handle, pointer, {
          keepRatio,
          centered: event.altKey
        })
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
      // 形状拖画结束：按草稿创建对象并退出绘制模式
      const draft = shapeDraftRef.current
      if (!draft) return
      shapeDraftRef.current = null
      setShapeDraft(null)
      const object = createShapeObjectFromDraft(draft, doc.width, doc.height)
      if (!object) return
      addObject(object)
      setDrawShape(null)
      setShapeMenuOpen(false)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [addObject, doc, scale, updateObject])

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
        } else if (shapeDraftRef.current) {
          cancelShapeDraft()
          event.preventDefault()
        } else if (drawShape || placeText) {
          setDrawShape(null)
          setPlaceText(false)
          setShapeMenuOpen(false)
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
      if (mod && event.key === '1') {
        event.preventDefault()
        fitZoom()
        return
      }
      // ] / } 与 [ / { 双覆盖：US 布局按住 Shift 时 event.key 输出 } 和 {
      if (mod && (event.key === ']' || event.key === '}')) {
        event.preventDefault()
        reorderSelected(event.shiftKey ? 'front' : 'forward')
        return
      }
      if (mod && (event.key === '[' || event.key === '{')) {
        event.preventDefault()
        reorderSelected(event.shiftKey ? 'back' : 'backward')
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
    cancelShapeDraft,
    commitTextDraft,
    deleteSelected,
    drawShape,
    duplicateSelected,
    fitZoom,
    placeText,
    redo,
    reorderSelected,
    selectedId,
    textEditingId,
    undo,
    updateObject
  ])

  // 右键菜单：菜单外 pointerdown / Escape 关闭（capture 阶段，检查菜单 ref）
  useEffect(() => {
    if (!contextMenu) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (contextMenuRef.current?.contains(event.target as Node)) return
      setContextMenu(null)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [contextMenu])

  const finish = useCallback((): void => {
    const finalDoc = applyTextDraftToDoc(doc, textEditingId, textDraft)
    if (finalDoc !== doc) {
      setDoc(finalDoc)
      setTextEditingId(null)
    }
    onCommit(finalDoc)
    onClose()
  }, [doc, textDraft, textEditingId, onCommit, onClose])

  return (
    <div
      className="fixed inset-0 z-[150] flex flex-col"
      data-canvas-no-zoom
      style={{ background: theme.canvas.background, color: theme.node.text }}
    >
      {/* 顶栏：左 = 标题 + 画板尺寸；右 = 撤销/重做 ｜ Export ｜ 完成编辑 ｜ 保存并关闭 */}
      <div
        className="flex h-14 shrink-0 items-center gap-2 border-b px-4"
        style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
      >
        <Frame className="size-4 shrink-0" />
        <span className="min-w-0 truncate text-base font-semibold">{node.title}</span>
        <span className="shrink-0 text-xs opacity-55">
          {doc.width}×{doc.height}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={undo}>
            <Undo2 className="mr-1 size-4" />
            撤销
          </Button>
          <Button variant="ghost" size="sm" onClick={redo}>
            <Redo2 className="mr-1 size-4" />
            重做
          </Button>
          {onExport && (
            <>
              <ToolbarDivider />
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
          <ToolbarDivider />
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
      <div className="relative flex min-h-0 flex-1">
        {/* 左侧固定窄导航：图标竖排，悬浮面板经 absolute 卡片展开 */}
        <nav
          className="flex w-14 shrink-0 flex-col items-center gap-1 border-r py-3"
          style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
        >
          <SideNavButton
            Icon={Layers}
            label="图层"
            theme={theme}
            active={sidePanel === 'layers'}
            onClick={() => toggleSidePanel('layers')}
          />
          <SideNavButton
            Icon={ImageIcon}
            label="画布资源"
            theme={theme}
            active={sidePanel === 'images'}
            onClick={() => toggleSidePanel('images')}
          />
          <SideNavButton
            Icon={HelpCircle}
            label="快捷键"
            theme={theme}
            active={sidePanel === 'help'}
            onClick={() => toggleSidePanel('help')}
          />
        </nav>
        {/* 画板视口 */}
        <div
          ref={viewportRef}
          data-design-board-viewport
          className="relative flex-1 overflow-auto overscroll-contain"
          style={{
            background: theme.canvas.background,
            cursor: drawShape || placeText ? 'crosshair' : undefined
          }}
          onPointerDown={(event) => {
            const target = event.target as HTMLElement
            if (
              target.closest(
                '[data-design-board-object], [data-design-board-handle], [data-design-board-property-toolbar]'
              )
            )
              return
            commitTextDraft()
            setShapeMenuOpen(false)
            const scene = pointerToScene(
              event.clientX,
              event.clientY,
              boardRect(),
              scale,
              doc.width,
              doc.height
            )
            // 文字点选放置：点击处创建文本并进入编辑态
            if (placeText) {
              addTextAtScenePoint(scene.x, scene.y)
              return
            }
            // 形状绘制模式：空白区按下开始拖画（替代取消选中）
            if (drawShape) {
              setSelectedId(null)
              shapeDraftRef.current = { kind: drawShape, start: scene, current: scene }
              setShapeDraft(shapeDraftRef.current)
              return
            }
            setSelectedId(null)
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="grid min-h-full place-items-center p-12">
            <div
              ref={artboardRef}
              data-design-board-artboard
              className="relative overflow-visible shadow-2xl"
              style={{
                width: doc.width * scale,
                height: doc.height * scale,
                background: doc.background
              }}
            >
              {/* 对象层：越界内容裁切隐藏，与导出 canvas 行为一致；隐藏图层不渲染 DOM */}
              <div className="absolute inset-0 overflow-hidden">
                {doc.objects
                  .filter((object) => object.visible)
                  .map((object) => (
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
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        if (textEditingId && textEditingId !== object.id) commitTextDraft()
                        if (selectedId !== object.id) setSelectedId(object.id)
                        setContextMenu({ x: event.clientX, y: event.clientY })
                      }}
                      onMouseEnter={() => setHoveredId(object.id)}
                      onMouseLeave={() =>
                        setHoveredId((current) => (current === object.id ? null : current))
                      }
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
              </div>
              {/* 悬停高亮：1px 虚线边框，不随缩放变化 */}
              {hoveredObject && hoveredObject.id !== selectedId && (
                <div
                  className="absolute z-[21] border border-dashed"
                  style={{
                    left: hoveredObject.x * scale,
                    top: hoveredObject.y * scale,
                    width: hoveredObject.width * scale,
                    height: hoveredObject.height * scale,
                    borderColor: '#3b82f6',
                    pointerEvents: 'none'
                  }}
                />
              )}
              {/* 选择覆盖层：手柄/边框为屏幕恒定尺寸，不随缩放变化 */}
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
                    style={{ borderWidth: 1.5, borderColor: '#3b82f6' }}
                  />
                  {RESIZE_HANDLE_IDS.map((handle) => {
                    const metrics = handleMetrics(handle)
                    const leftPercent = handle.includes('w') ? 0 : handle.includes('e') ? 100 : 50
                    const topPercent = handle.includes('n') ? 0 : handle.includes('s') ? 100 : 50
                    return (
                      <button
                        key={handle}
                        type="button"
                        data-design-board-handle
                        className="absolute z-[23] grid place-items-center"
                        style={{
                          width: metrics.hitWidth,
                          height: metrics.hitHeight,
                          left: `calc(${leftPercent}% - ${metrics.hitWidth / 2}px)`,
                          top: `calc(${topPercent}% - ${metrics.hitHeight / 2}px)`,
                          cursor: cursorForHandle(handle),
                          pointerEvents: 'auto'
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          startDrag(event, selectedObject.id, handle)
                        }}
                      >
                        <span
                          className="block rounded-[2px] border border-white"
                          style={{
                            width: metrics.visualWidth,
                            height: metrics.visualHeight,
                            background: '#3b82f6'
                          }}
                        />
                      </button>
                    )
                  })}
                </div>
              )}
              {/* 选中对象浮动属性工具栏（avnac editor-selection-toolbar 形态）：编辑态隐藏 */}
              {selectedObject && !textEditingId && (
                <SelectionToolbar
                  object={selectedObject}
                  scale={scale}
                  boardWidthPx={doc.width * scale}
                  theme={theme}
                  onUpdate={(updater) => updateObject(selectedObject.id, updater)}
                  onReorder={reorderSelected}
                  onDuplicate={duplicateSelected}
                  onDelete={deleteSelected}
                />
              )}
              {/* 吸附参考线 */}
              {snapGuides.x !== null && (
                <div
                  className="absolute top-0 bottom-0 z-[19]"
                  style={{
                    left: snapGuides.x * scale,
                    width: 1,
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
                    height: 1,
                    background: '#3b82f6',
                    pointerEvents: 'none'
                  }}
                />
              )}
              {/* 形状拖画预览：起点到当前点的虚线框 */}
              {shapeDraftBox && (
                <div
                  data-design-board-shape-draft
                  className="absolute z-[24] border border-dashed"
                  style={{
                    left: shapeDraftBox.x * scale,
                    top: shapeDraftBox.y * scale,
                    width: shapeDraftBox.width * scale,
                    height: shapeDraftBox.height * scale,
                    borderColor: '#3b82f6',
                    pointerEvents: 'none'
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* 底部工具条：文字点选 ｜ 形状下拉 ｜ 图片面板 ｜ 复制/删除（缩放控件独立悬浮于右下角） */}
      <div
        className="flex h-14 shrink-0 items-center gap-2 border-t px-4"
        style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
      >
        <Button
          variant="outline"
          size="sm"
          aria-pressed={placeText}
          style={
            placeText
              ? { backgroundColor: theme.toolbar.activeBg, color: theme.toolbar.activeText }
              : undefined
          }
          onClick={enterPlaceText}
        >
          <Type className="mr-1 size-4" />
          文字
        </Button>
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            aria-pressed={drawShape !== null}
            style={
              drawShape
                ? { backgroundColor: theme.toolbar.activeBg, color: theme.toolbar.activeText }
                : undefined
            }
            onClick={() => setShapeMenuOpen((current) => !current)}
          >
            <Square className="mr-1 size-4" />
            形状
          </Button>
          {/* 形状下拉：6 项，选中项打勾；再点同项取消绘制模式 */}
          {shapeMenuOpen && (
            <div
              data-design-board-shape-menu
              className="absolute bottom-full left-0 z-40 mb-2 w-32 overflow-hidden rounded-xl border py-1 shadow-xl"
              style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
            >
              {SHAPE_TOOL_OPTIONS.map(({ kind, label, Icon }) => {
                const active = drawShape === kind
                return (
                  <button
                    key={kind}
                    type="button"
                    data-design-board-shape-option={kind}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10 ${
                      active ? 'font-medium' : ''
                    }`}
                    style={{ color: theme.toolbar.item }}
                    onClick={() => selectShapeTool(kind)}
                  >
                    <Icon className="size-3.5" />
                    {label}
                    {active && <Check className="ml-auto size-3.5" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={sidePanel === 'images'}
          onClick={() => toggleSidePanel('images')}
        >
          <ImageIcon className="mr-1 size-4" />
          图片
        </Button>
        <ToolbarDivider />
        <Button variant="outline" size="sm" onClick={duplicateSelected} disabled={!selectedObject}>
          复制
        </Button>
        <Button variant="outline" size="sm" onClick={deleteSelected} disabled={!selectedObject}>
          删除
        </Button>
      </div>
      {/* 右下角独立缩放悬浮卡 */}
      <div
        className="absolute right-5 bottom-20 z-30 flex items-center gap-2 rounded-xl border px-3 py-2 shadow-lg"
        style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
      >
        <Button variant="ghost" size="sm" aria-label="缩小" title="缩小" onClick={zoomOut}>
          −
        </Button>
        <input
          type="range"
          min={ZOOM_MIN_PCT}
          max={ZOOM_MAX_PCT}
          value={zoomPercent}
          onChange={(event) => setZoomCentered(Number(event.target.value))}
          className="w-28"
          aria-label="缩放"
        />
        <Button variant="ghost" size="sm" aria-label="放大" title="放大" onClick={zoomIn}>
          +
        </Button>
        <ToolbarDivider />
        <Button variant="outline" size="sm" onClick={fitZoom} title="适配 (Ctrl+1)">
          适配
        </Button>
        <span className="w-11 text-right text-xs tabular-nums opacity-70">
          {Math.round(zoomPercent)}%
        </span>
      </div>
      {/* 悬浮侧面板：同一时间只开一个 */}
      {sidePanel === 'layers' && (
        <FloatingPanel title="图层" theme={theme} onClose={() => setSidePanel(null)}>
          <LayersPanel
            entries={layerEntries}
            selectedId={selectedId}
            dragOverId={layerDragOverId}
            theme={theme}
            onSelect={selectFromLayers}
            onToggleVisible={toggleObjectVisible}
            onMove={moveLayerObject}
            onReorderToIndex={reorderObjectToIndex}
            onDragOverRow={setLayerDragOverId}
          />
        </FloatingPanel>
      )}
      {sidePanel === 'images' && (
        <FloatingPanel title="画布资源" theme={theme} onClose={() => setSidePanel(null)}>
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
        </FloatingPanel>
      )}
      {sidePanel === 'help' && (
        <FloatingPanel title="快捷键" theme={theme} onClose={() => setSidePanel(null)}>
          <HelpPanel />
        </FloatingPanel>
      )}
      {/* 对象右键菜单：fixed 定位，pointerdown 菜单外/Escape 关闭 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          data-design-board-context-menu
          className="fixed z-[160] w-32 overflow-hidden rounded-md border shadow-lg"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            borderColor: theme.toolbar.border,
            background: theme.toolbar.panel
          }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => {
              duplicateSelected()
              setContextMenu(null)
            }}
          >
            复制
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => {
              deleteSelected()
              setContextMenu(null)
            }}
          >
            删除
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => {
              reorderSelected('front')
              setContextMenu(null)
            }}
          >
            置顶
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => {
              reorderSelected('back')
              setContextMenu(null)
            }}
          >
            置底
          </button>
        </div>
      )}
    </div>
  )
}

/** 左侧窄导航按钮：选中态用主题 active 色，悬浮面板同色联动。 */
function SideNavButton({
  Icon,
  label,
  theme,
  active,
  onClick
}: {
  Icon: typeof Layers
  label: string
  theme: CanvasTheme
  active: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className="grid size-10 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
      style={
        active
          ? { backgroundColor: theme.toolbar.activeBg, color: theme.toolbar.activeText }
          : { color: theme.toolbar.item }
      }
      onClick={onClick}
    >
      <Icon className="size-5" />
    </button>
  )
}

/** 悬浮侧面板外壳：absolute 定位在导航栏右侧，标题行 + × 关闭。 */
function FloatingPanel({
  title,
  theme,
  onClose,
  children
}: {
  title: string
  theme: CanvasTheme
  onClose: () => void
  children: ReactNode
}): ReactElement {
  return (
    <div
      data-design-board-side-panel
      className="absolute top-16 left-16 z-40 w-60 overflow-hidden rounded-xl border shadow-xl"
      style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
    >
      <div
        className="flex items-center justify-between border-b px-3 py-2"
        style={{ borderColor: theme.toolbar.border }}
      >
        <span className="text-xs font-semibold opacity-60">{title}</span>
        <button
          type="button"
          aria-label={`关闭${title}`}
          title={`关闭${title}`}
          className="grid size-5 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10"
          style={{ color: theme.toolbar.item }}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

/** 图层面板：z 序倒序条目，支持点选 / 眼睛显隐 / ↑↓ 层级 / 手柄拖拽排序。 */
function LayersPanel({
  entries,
  selectedId,
  dragOverId,
  theme,
  onSelect,
  onToggleVisible,
  onMove,
  onReorderToIndex,
  onDragOverRow
}: {
  entries: Array<{ object: DesignBoardObject; index: number }>
  selectedId: string | null
  dragOverId: string | null
  theme: CanvasTheme
  onSelect: (objectId: string) => void
  onToggleVisible: (objectId: string) => void
  onMove: (objectId: string, action: DesignBoardZOrderAction) => void
  onReorderToIndex: (objectId: string, toIndex: number) => void
  onDragOverRow: (objectId: string | null) => void
}): ReactElement {
  if (entries.length === 0) {
    return <p className="text-xs opacity-50">画板上暂无对象</p>
  }
  return (
    <div className="flex flex-col gap-0.5" data-design-board-layers-panel>
      {entries.map(({ object, index }) => {
        const selected = object.id === selectedId
        const dragOver = object.id === dragOverId
        const label =
          object.kind === 'text' && object.text.trim()
            ? object.text.trim()
            : LAYER_KIND_LABELS[object.kind]
        return (
          <div
            key={object.id}
            data-design-board-layer-item
            className={`flex items-center gap-1 rounded-lg px-1.5 py-1 transition ${
              selected || dragOver ? '' : 'hover:bg-black/5 dark:hover:bg-white/10'
            }`}
            style={
              selected || dragOver
                ? { backgroundColor: theme.toolbar.activeBg }
                : { color: theme.toolbar.item }
            }
            onDragOver={(event: ReactDragEvent) => {
              event.preventDefault()
              onDragOverRow(object.id)
            }}
            onDragLeave={() => onDragOverRow(null)}
            onDrop={(event: ReactDragEvent) => {
              event.preventDefault()
              const dragId = event.dataTransfer.getData('text/plain')
              if (dragId && dragId !== object.id) onReorderToIndex(dragId, index)
              onDragOverRow(null)
            }}
            onClick={() => onSelect(object.id)}
          >
            <span
              data-design-board-layer-handle
              draggable
              aria-label={`拖拽排序 ${label}`}
              title="拖拽排序"
              className="shrink-0 cursor-grab opacity-40"
              onDragStart={(event: ReactDragEvent) => {
                event.dataTransfer.setData('text/plain', object.id)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <GripVertical className="size-3.5" />
            </span>
            <button
              type="button"
              className={`min-w-0 flex-1 truncate text-left text-xs ${
                object.visible ? '' : 'opacity-50'
              }`}
              title={label}
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={object.visible ? '隐藏图层' : '显示图层'}
              title={object.visible ? '隐藏图层' : '显示图层'}
              className="grid size-6 shrink-0 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10"
              style={{ color: theme.toolbar.item }}
              onClick={(event) => {
                event.stopPropagation()
                onToggleVisible(object.id)
              }}
            >
              {object.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            </button>
            <button
              type="button"
              aria-label="上移一层"
              title="上移一层"
              className="grid size-6 shrink-0 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10"
              style={{ color: theme.toolbar.item }}
              onClick={(event) => {
                event.stopPropagation()
                onMove(object.id, 'forward')
              }}
            >
              <ChevronUp className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="下移一层"
              title="下移一层"
              className="grid size-6 shrink-0 place-items-center rounded transition hover:bg-black/5 dark:hover:bg-white/10"
              style={{ color: theme.toolbar.item }}
              onClick={(event) => {
                event.stopPropagation()
                onMove(object.id, 'backward')
              }}
            >
              <ChevronDown className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

const EDITOR_SHORTCUTS: Array<[string, string]> = [
  ['撤销', 'Ctrl+Z'],
  ['重做', 'Ctrl+Shift+Z'],
  ['复制', 'Ctrl+D'],
  ['删除', 'Delete / Backspace'],
  ['方向键微移', '方向键（Shift ×10）'],
  ['上移一层', 'Ctrl+]'],
  ['下移一层', 'Ctrl+['],
  ['置顶', 'Ctrl+Shift+]'],
  ['置底', 'Ctrl+Shift+['],
  ['适配画板', 'Ctrl+1'],
  ['退出文本编辑', 'Escape'],
  ['缩放画板', 'Ctrl+滚轮']
]

/** 快捷键说明卡：两列 label/键位。 */
function HelpPanel(): ReactElement {
  return (
    <div className="flex flex-col gap-1.5" data-design-board-help-panel>
      {EDITOR_SHORTCUTS.map(([label, keys]) => (
        <div key={label} className="flex items-center justify-between gap-3 text-xs">
          <span className="shrink-0 opacity-70">{label}</span>
          <span className="text-right font-mono text-[11px]">{keys}</span>
        </div>
      ))}
    </div>
  )
}

/** 手柄命中区/视觉条尺寸（屏幕像素恒定）：角 24×24 命中 + 12×12 视觉；边 n/s 32×24 + 22×8，e/w 24×32 + 8×22。 */
function handleMetrics(handle: ResizeHandleId): {
  hitWidth: number
  hitHeight: number
  visualWidth: number
  visualHeight: number
} {
  if (handle === 'n' || handle === 's') {
    return { hitWidth: 32, hitHeight: 24, visualWidth: 22, visualHeight: 8 }
  }
  if (handle === 'e' || handle === 'w') {
    return { hitWidth: 24, hitHeight: 32, visualWidth: 8, visualHeight: 22 }
  }
  return { hitWidth: 24, hitHeight: 24, visualWidth: 12, visualHeight: 12 }
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
  // 文本排版与 canvas 渲染同源（layoutDesignText + 共享测量上下文）：
  // 展示态提供逐行内容，编辑态提供实时长高的草稿排版高度
  const textLayout = useMemo<DesignTextLayout | null>(() => {
    if (object.kind !== 'text') return null
    return computeTextLayout(editing ? { ...object, text: draft } : object)
  }, [object, editing, draft])

  if (object.kind === 'text') {
    const lineHeightPx =
      (textLayout?.lineHeight ?? object.fontSize * DESIGN_TEXT_LINE_HEIGHT_RATIO) * scale
    if (editing) {
      // 实时长高：编辑容器高度 = max(对象高度, 草稿排版高度)，textarea h-full 跟随
      const editHeight = Math.max(object.height, textLayout?.height ?? object.height) * scale
      return (
        <div className="w-full overflow-visible" style={{ height: editHeight }}>
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
              lineHeight: `${lineHeightPx}px`,
              fontFamily: designBoardFontFamily()
            }}
          />
        </div>
      )
    }
    // 逐行 div 渲染：换行/对齐与 canvas 排版共用 layoutDesignText 结果；
    // 基线由 DOM 行高模型近似（不追求像素级），行内不截断、越界不裁切
    return (
      <div className="h-full w-full overflow-visible">
        {(textLayout?.lines ?? [object.text]).map((line, index) => (
          <div
            key={index}
            data-design-board-text-line
            style={{
              fontSize: object.fontSize * scale,
              lineHeight: `${lineHeightPx}px`,
              textAlign: object.align,
              color: object.color,
              whiteSpace: 'pre',
              fontWeight: object.fontWeight,
              fontFamily: designBoardFontFamily()
            }}
          >
            {line}
          </div>
        ))}
      </div>
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
  // 以下形状几何公式与 canvas 渲染共用（designPolygonPoints/designStarPoints/designArrowGeometry）
  if (object.kind === 'ellipse') {
    return (
      <svg className="h-full w-full" viewBox={`0 0 ${object.width} ${object.height}`}>
        <ellipse
          cx={object.width / 2}
          cy={object.height / 2}
          rx={object.width / 2}
          ry={object.height / 2}
          fill={object.fill}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
        />
      </svg>
    )
  }
  if (object.kind === 'polygon') {
    return (
      <svg className="h-full w-full" viewBox={`0 0 ${object.width} ${object.height}`}>
        <polygon
          points={designPolygonPoints(object.width, object.height, object.sides)}
          fill={object.fill}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
        />
      </svg>
    )
  }
  if (object.kind === 'star') {
    return (
      <svg className="h-full w-full" viewBox={`0 0 ${object.width} ${object.height}`}>
        <polygon
          points={designStarPoints(object.width, object.height, object.points)}
          fill={object.fill}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
        />
      </svg>
    )
  }
  if (object.kind === 'line') {
    const sw = object.strokeWidth
    return (
      <svg className="h-full w-full" viewBox={`0 0 ${object.width} ${object.height}`}>
        <line
          x1={sw / 2}
          y1={object.height / 2}
          x2={Math.max(sw / 2, object.width - sw / 2)}
          y2={object.height / 2}
          stroke={object.stroke}
          strokeWidth={sw}
        />
      </svg>
    )
  }
  if (object.kind === 'arrow') {
    const geometry = designArrowGeometry(object)
    const headPoints = [
      `${formatSvgCoord(geometry.tipX)},${formatSvgCoord(geometry.y)}`,
      `${formatSvgCoord(geometry.tipX - geometry.headLen)},${formatSvgCoord(geometry.y - geometry.spread / 2)}`,
      `${formatSvgCoord(geometry.tipX - geometry.headLen * 0.82)},${formatSvgCoord(geometry.y)}`,
      `${formatSvgCoord(geometry.tipX - geometry.headLen)},${formatSvgCoord(geometry.y + geometry.spread / 2)}`
    ].join(' ')
    return (
      <svg className="h-full w-full" viewBox={`0 0 ${object.width} ${object.height}`}>
        <line
          x1={geometry.shaftX1}
          y1={geometry.y}
          x2={geometry.tipX}
          y2={geometry.y}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
        />
        <polygon points={headPoints} fill={object.stroke} strokeLinejoin="round" />
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
  // 提交高度与编辑态实时长高同源：草稿排版高度（多行时随行数增长）
  const layout = computeTextLayout({ ...object, text: draft })
  const height = Math.max(object.height, Math.round(layout.height))
  if (object.text === draft && object.height === height) return doc
  const objects = [...doc.objects]
  objects[index] = { ...object, text: draft, height }
  return { ...doc, objects }
}

const TEXT_ALIGN_OPTIONS = [
  { value: 'left', label: '左对齐', Icon: AlignLeft },
  { value: 'center', label: '居中对齐', Icon: AlignCenter },
  { value: 'right', label: '右对齐', Icon: AlignRight }
] as const

const Z_ORDER_ACTIONS = [
  { action: 'front', label: '置顶', Icon: BringToFront },
  { action: 'back', label: '置底', Icon: SendToBack },
  { action: 'forward', label: '上移一层', Icon: ArrowUp },
  { action: 'backward', label: '下移一层', Icon: ArrowDown }
] as const

function ToolbarDivider(): ReactElement {
  return <div aria-hidden="true" className="h-5 w-px shrink-0 bg-current opacity-20" />
}

/** 选中对象浮动属性工具栏：贴顶翻到对象下方，left 限制在画板内；分组 + 分隔线，超宽横向滚动。 */
function SelectionToolbar({
  object,
  scale,
  boardWidthPx,
  theme,
  onUpdate,
  onReorder,
  onDuplicate,
  onDelete
}: {
  object: DesignBoardObject
  scale: number
  boardWidthPx: number
  theme: CanvasTheme
  onUpdate: (updater: (object: DesignBoardObject) => DesignBoardObject) => void
  onReorder: (action: DesignBoardZOrderAction) => void
  onDuplicate: () => void
  onDelete: () => void
}): ReactElement {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarWidth, setToolbarWidth] = useState(0)
  useLayoutEffect(() => {
    const width = toolbarRef.current?.offsetWidth ?? 0
    setToolbarWidth((current) => (current === width ? current : width))
  })
  const centerX = (object.x + object.width / 2) * scale
  const aboveTop = object.y * scale - SELECTION_TOOLBAR_OFFSET_PX
  const top =
    aboveTop >= 0 ? aboveTop : (object.y + object.height) * scale + SELECTION_TOOLBAR_BELOW_GAP_PX
  const left = Math.min(
    Math.max(centerX - toolbarWidth / 2, 8),
    Math.max(8, boardWidthPx - toolbarWidth - 8)
  )
  const updateText = (patch: Partial<DesignBoardTextObject>): void => {
    onUpdate((current) => (current.kind === 'text' ? { ...current, ...patch } : current))
  }
  return (
    <div
      ref={toolbarRef}
      data-design-board-property-toolbar
      className="thin-scrollbar absolute z-[30] flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border px-2 py-1 shadow-lg backdrop-blur"
      style={{
        left,
        top,
        background: theme.toolbar.panel,
        borderColor: theme.toolbar.border
      }}
    >
      {object.kind === 'text' && (
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarNumberInput
            label="字号"
            value={object.fontSize}
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            integer
            theme={theme}
            onCommit={(fontSize) => updateText({ fontSize })}
          />
          <label className="flex shrink-0 items-center gap-1 text-[10px] opacity-70">
            字重
            <select
              aria-label="字重"
              value={object.fontWeight === 700 ? '700' : '400'}
              onChange={(event) => updateText({ fontWeight: Number(event.target.value) })}
              className="h-7 rounded-full border bg-transparent px-1.5 text-xs outline-none"
              style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
            >
              <option value="400">400</option>
              <option value="700">700</option>
            </select>
          </label>
          <div role="group" aria-label="对齐" className="flex items-center gap-0.5">
            {TEXT_ALIGN_OPTIONS.map(({ value, label, Icon }) => {
              const active = object.align === value
              return (
                <button
                  key={value}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-pressed={active}
                  className="grid size-7 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
                  style={
                    active
                      ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText }
                      : { color: theme.toolbar.item }
                  }
                  onClick={() => updateText({ align: value })}
                >
                  <Icon className="size-3.5" />
                </button>
              )
            })}
          </div>
          <ToolbarColorInput
            label="文本颜色"
            value={object.color}
            onCommit={(color) => updateText({ color })}
          />
        </div>
      )}
      {object.kind === 'rect' && (
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarColorInput
            label="填充颜色"
            value={object.fill}
            onCommit={(fill) =>
              onUpdate((current) => (current.kind === 'rect' ? { ...current, fill } : current))
            }
          />
          <ToolbarColorInput
            label="描边颜色"
            value={object.stroke}
            onCommit={(stroke) =>
              onUpdate((current) => (current.kind === 'rect' ? { ...current, stroke } : current))
            }
          />
          <ToolbarNumberInput
            label="描边宽度"
            value={object.strokeWidth}
            min={0}
            max={1600}
            theme={theme}
            onCommit={(strokeWidth) =>
              onUpdate((current) =>
                current.kind === 'rect' ? { ...current, strokeWidth } : current
              )
            }
          />
          <ToolbarNumberInput
            label="圆角"
            value={object.radius}
            min={0}
            max={9999}
            integer
            theme={theme}
            onCommit={(radius) =>
              onUpdate((current) => (current.kind === 'rect' ? { ...current, radius } : current))
            }
          />
        </div>
      )}
      {object.kind === 'ellipse' && (
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarColorInput
            label="填充颜色"
            value={object.fill}
            onCommit={(fill) =>
              onUpdate((current) => (current.kind === 'ellipse' ? { ...current, fill } : current))
            }
          />
          <ToolbarColorInput
            label="描边颜色"
            value={object.stroke}
            onCommit={(stroke) =>
              onUpdate((current) => (current.kind === 'ellipse' ? { ...current, stroke } : current))
            }
          />
          <ToolbarNumberInput
            label="描边宽度"
            value={object.strokeWidth}
            min={0}
            max={1600}
            theme={theme}
            onCommit={(strokeWidth) =>
              onUpdate((current) =>
                current.kind === 'ellipse' ? { ...current, strokeWidth } : current
              )
            }
          />
        </div>
      )}
      {object.kind === 'polygon' && (
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarNumberInput
            label="边数"
            value={object.sides}
            min={3}
            max={32}
            integer
            theme={theme}
            onCommit={(sides) =>
              onUpdate((current) => (current.kind === 'polygon' ? { ...current, sides } : current))
            }
          />
          <ToolbarColorInput
            label="填充颜色"
            value={object.fill}
            onCommit={(fill) =>
              onUpdate((current) => (current.kind === 'polygon' ? { ...current, fill } : current))
            }
          />
          <ToolbarColorInput
            label="描边颜色"
            value={object.stroke}
            onCommit={(stroke) =>
              onUpdate((current) => (current.kind === 'polygon' ? { ...current, stroke } : current))
            }
          />
          <ToolbarNumberInput
            label="描边宽度"
            value={object.strokeWidth}
            min={0}
            max={1600}
            theme={theme}
            onCommit={(strokeWidth) =>
              onUpdate((current) =>
                current.kind === 'polygon' ? { ...current, strokeWidth } : current
              )
            }
          />
        </div>
      )}
      {object.kind === 'star' && (
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarNumberInput
            label="角数"
            value={object.points}
            min={4}
            max={32}
            integer
            theme={theme}
            onCommit={(points) =>
              onUpdate((current) => (current.kind === 'star' ? { ...current, points } : current))
            }
          />
          <ToolbarColorInput
            label="填充颜色"
            value={object.fill}
            onCommit={(fill) =>
              onUpdate((current) => (current.kind === 'star' ? { ...current, fill } : current))
            }
          />
          <ToolbarColorInput
            label="描边颜色"
            value={object.stroke}
            onCommit={(stroke) =>
              onUpdate((current) => (current.kind === 'star' ? { ...current, stroke } : current))
            }
          />
          <ToolbarNumberInput
            label="描边宽度"
            value={object.strokeWidth}
            min={0}
            max={1600}
            theme={theme}
            onCommit={(strokeWidth) =>
              onUpdate((current) =>
                current.kind === 'star' ? { ...current, strokeWidth } : current
              )
            }
          />
        </div>
      )}
      {(object.kind === 'line' || object.kind === 'arrow') && (
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarColorInput
            label="描边颜色"
            value={object.stroke}
            onCommit={(stroke) =>
              onUpdate((current) =>
                current.kind === 'line' || current.kind === 'arrow'
                  ? { ...current, stroke }
                  : current
              )
            }
          />
          <ToolbarNumberInput
            label="描边宽度"
            value={object.strokeWidth}
            min={1}
            max={1600}
            theme={theme}
            onCommit={(strokeWidth) =>
              onUpdate((current) =>
                current.kind === 'line' || current.kind === 'arrow'
                  ? { ...current, strokeWidth }
                  : current
              )
            }
          />
        </div>
      )}
      {object.kind === 'image' && (
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarNumberInput
            label="圆角"
            value={object.radius}
            min={0}
            max={9999}
            integer
            theme={theme}
            onCommit={(radius) =>
              onUpdate((current) => (current.kind === 'image' ? { ...current, radius } : current))
            }
          />
        </div>
      )}
      <ToolbarDivider />
      <div className="flex shrink-0 items-center gap-1">
        {Z_ORDER_ACTIONS.map(({ action, label, Icon }) => (
          <button
            key={action}
            type="button"
            aria-label={label}
            title={label}
            className="grid size-7 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
            style={{ color: theme.toolbar.item }}
            onClick={() => onReorder(action)}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
        <ToolbarDivider />
        <button
          type="button"
          aria-label="复制"
          title="复制"
          className="grid size-7 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
          style={{ color: theme.toolbar.item }}
          onClick={onDuplicate}
        >
          <Copy className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="删除"
          title="删除"
          className="grid size-7 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"
          style={{ color: theme.toolbar.item }}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

/** 工具栏小尺寸数字输入：change 即写入（整型走 round+clamp，浮型仅 clamp）。 */
function ToolbarNumberInput({
  label,
  value,
  min,
  max,
  integer,
  theme,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  integer?: boolean
  theme: CanvasTheme
  onCommit: (value: number) => void
}): ReactElement {
  return (
    <label className="flex shrink-0 items-center gap-1 text-[10px] opacity-70">
      {label}
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (!Number.isFinite(next)) return
          onCommit(integer ? clampRoundedInt(next, min, max) : clampBounded(next, min, max))
        }}
        className="h-7 w-14 rounded-full border bg-transparent px-1.5 text-center text-xs outline-none"
        style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
      />
    </label>
  )
}

/** 工具栏颜色输入：受控值经 toHexInputColor 归一为合法 hex，onChange 直接写回新 hex。 */
function ToolbarColorInput({
  label,
  value,
  onCommit
}: {
  label: string
  value: string
  onCommit: (hex: string) => void
}): ReactElement {
  return (
    <label className="flex shrink-0 items-center gap-1 text-[10px] opacity-70">
      {label}
      <input
        type="color"
        aria-label={label}
        title={label}
        value={toHexInputColor(value)}
        onChange={(event) => onCommit(event.target.value)}
        className="size-7 cursor-pointer rounded-full border-0 bg-transparent p-0"
      />
    </label>
  )
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/**
 * input[type=color] 受控值必须是合法 #rrggbb；其余任意 CSS 颜色串显示占位色，
 * onChange 直接写回新 hex（transparent 描边默认按白色占位展示）。
 */
function toHexInputColor(value: string): string {
  if (HEX_COLOR_PATTERN.test(value)) return value
  return value === 'transparent' ? '#ffffff' : '#000000'
}

function clampRoundedInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function clampBounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// 共享文本测量上下文：懒创建一次，展示排版 / 编辑长高 / 草稿提交三处复用
let sharedMeasureContext: CanvasRenderingContext2D | null | undefined

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (sharedMeasureContext === undefined) {
    sharedMeasureContext =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  }
  return sharedMeasureContext
}

/**
 * DOM 侧文本排版：优先与 canvas 渲染共用 layoutDesignText（同字体、同换行）；
 * 无 2d 上下文的环境（jsdom 等）回退为仅按显式换行分段，不做宽度折行。
 */
function computeTextLayout(object: DesignBoardTextObject): DesignTextLayout {
  const ctx = getMeasureContext()
  if (ctx) {
    exportDesignTextFont(ctx, object)
    return layoutDesignText(object, ctx)
  }
  const lineHeight = object.fontSize * DESIGN_TEXT_LINE_HEIGHT_RATIO
  const lines = object.text.split(/\r?\n/)
  return { lines, lineHeight, height: Math.max(lineHeight, lines.length * lineHeight) }
}

function makeObjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `dbo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function formatSvgCoord(value: number): number {
  return Math.round(value * 100) / 100
}

/** 归一化拖画框：min 角 + abs 尺寸（场景坐标）。 */
function normalizeDraftBox(draft: ShapeDraft): {
  x: number
  y: number
  width: number
  height: number
} {
  return {
    x: Math.min(draft.start.x, draft.current.x),
    y: Math.min(draft.start.y, draft.current.y),
    width: Math.abs(draft.current.x - draft.start.x),
    height: Math.abs(draft.current.y - draft.start.y)
  }
}

/**
 * 拖画结束创建对象：
 * - rect/ellipse/polygon/star 用归一化框；拖画尺寸过小（近似点击）时以默认尺寸（画板短边·16%）在起点居中放置
 * - line/arrow 用起点终点构造：水平线段 x 取 min/max，y 取两点均值上移半描边宽，height=max(sw,2)
 */
function createShapeObjectFromDraft(
  draft: ShapeDraft,
  boardWidth: number,
  boardHeight: number
): DesignBoardObject | null {
  const { kind, start, current } = draft
  if (kind === 'line' || kind === 'arrow') {
    const sw = LINE_DEFAULT_STROKE_WIDTH
    let x = Math.min(start.x, current.x)
    let width = Math.abs(current.x - start.x)
    if (width < MIN_DRAW_SIZE_PX) {
      width = Math.round(Math.min(boardWidth, boardHeight) * DEFAULT_DRAW_SIZE_RATIO)
      x = start.x - width / 2
    }
    const centerY = (start.y + current.y) / 2
    const y = centerY - sw / 2
    return kind === 'line'
      ? createLineObject(x, y, width, Math.max(sw, 2))
      : createArrowObject(x, y, width, Math.max(sw, 2))
  }
  const box = normalizeDraftBox(draft)
  let { x, y, width, height } = box
  if (width < MIN_DRAW_SIZE_PX || height < MIN_DRAW_SIZE_PX) {
    const size = Math.round(Math.min(boardWidth, boardHeight) * DEFAULT_DRAW_SIZE_RATIO)
    x = start.x - size / 2
    y = start.y - size / 2
    width = size
    height = size
  }
  if (kind === 'rect') return createRectObject(x, y, width, height)
  if (kind === 'ellipse') return createEllipseObject(x, y, width, height)
  if (kind === 'polygon') return createPolygonObject(x, y, width, height)
  if (kind === 'star') return createStarObject(x, y, width, height)
  return null
}
