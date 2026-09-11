import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { Crop } from 'lucide-react'

import type { CanvasTheme } from './canvas-theme'
import { DialogAction, MediaDialogShell, NumberField } from './media-dialog-shell'
import {
  capturePointer,
  MediaStage,
  pointerToPercent,
  useImageNaturalSize,
  type NaturalSize
} from './media-stage'
import {
  applyCropRatio,
  clampCropRect,
  CROP_HANDLES,
  dragCropRect,
  moveCropRect,
  resizeCropRect,
  type CropHandle,
  type CropRect
} from './crop-split-interaction'
import { cursorForHandle } from './design-board/design-board-interaction'

const CROP_RATIOS: Array<{ label: string; value: number | null }> = [
  { label: '自由', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 }
]

const LOUPE_SIZE = 112
const LOUPE_ZOOM = 4
const LOUPE_OFFSET = 24
const MIN_DRAG_CROP_PERCENT = 3

type LoupeState = { displayX: number; displayY: number; percentX: number; percentY: number }

type DragMode =
  | { mode: 'move'; grabOffset: { x: number; y: number } }
  | { mode: 'resize'; handle: CropHandle; initial: CropRect }
  | { mode: 'draw'; anchor: { x: number; y: number }; previous: CropRect }

type DragState = DragMode & { pointerId: number }

export function CropDialog({
  theme,
  source,
  onClose,
  onConfirm
}: {
  theme: CanvasTheme
  source: string
  onClose: () => void
  onConfirm: (crop: { x: number; y: number; width: number; height: number }) => void
}): ReactElement {
  const [crop, setCrop] = useState<CropRect>({ x: 0, y: 0, width: 100, height: 100 })
  const [ratio, setRatio] = useState<number | null>(null)
  const [loupe, setLoupe] = useState<LoupeState | null>(null)
  const naturalSize = useImageNaturalSize(source)
  const dragRef = useRef<DragState | null>(null)

  const contentRect = (element: HTMLElement): DOMRect => {
    const content = element.closest('[data-media-stage-content]')
    return (content ?? element).getBoundingClientRect()
  }

  const percentFrom = (event: ReactPointerEvent<HTMLElement>): { x: number; y: number } => {
    return pointerToPercent(
      { x: event.clientX, y: event.clientY },
      contentRect(event.currentTarget)
    )
  }

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, drag: DragMode): void => {
    event.preventDefault()
    event.stopPropagation()
    capturePointer(event)
    dragRef.current = { ...drag, pointerId: event.pointerId }
    // 兜底：pointer capture 失败时，避免拖拽状态卡死在窗口层
    const endDragFallback = (): void => {
      if (!dragRef.current) return
      dragRef.current = null
      setLoupe(null)
    }
    window.addEventListener('pointerup', endDragFallback, { once: true })
    window.addEventListener('pointercancel', endDragFallback, { once: true })
  }

  const finishDraw = (pointer: { x: number; y: number }): CropRect => {
    const drag = dragRef.current
    if (!drag || drag.mode !== 'draw') return crop
    const next = dragCropRect(drag.anchor, pointer)
    if (ratio !== null && naturalSize) return applyCropRatio(next, ratio, naturalSize)
    return next
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const pointer = percentFrom(event)
    if (drag.mode === 'move') {
      setCrop((current) => moveCropRect(current, pointer, drag.grabOffset))
      return
    }
    if (drag.mode === 'resize') {
      setCrop(
        resizeCropRect(drag.initial, drag.handle, pointer, {
          ratio,
          natural: naturalSize ?? { width: 1, height: 1 }
        })
      )
      const rect = contentRect(event.currentTarget)
      setLoupe({
        displayX: event.clientX - rect.left,
        displayY: event.clientY - rect.top,
        percentX: pointer.x,
        percentY: pointer.y
      })
      return
    }
    setCrop(finishDraw(pointer))
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    if (drag.mode === 'draw') {
      const next = finishDraw(percentFrom(event))
      setCrop(
        next.width < MIN_DRAG_CROP_PERCENT || next.height < MIN_DRAG_CROP_PERCENT
          ? drag.previous
          : next
      )
    }
    dragRef.current = null
    setLoupe(null)
  }

  const startMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const pointer = percentFrom(event)
    beginDrag(event, {
      mode: 'move',
      grabOffset: { x: pointer.x - crop.x, y: pointer.y - crop.y }
    })
  }

  const startDraw = (event: ReactPointerEvent<HTMLElement>): void => {
    beginDrag(event, { mode: 'draw', anchor: percentFrom(event), previous: crop })
  }

  const startResize =
    (handle: CropHandle) =>
    (event: ReactPointerEvent<HTMLElement>): void => {
      beginDrag(event, { mode: 'resize', handle, initial: crop })
    }

  const selectRatio = (value: number | null): void => {
    setRatio(value)
    if (value !== null && naturalSize) {
      setCrop((current) => applyCropRatio(current, value, naturalSize))
    }
  }

  const controlStyle = { borderColor: theme.toolbar.border, color: theme.node.text }
  const maxHeightPx = typeof window === 'undefined' ? 400 : Math.round(window.innerHeight * 0.5)

  return (
    <MediaDialogShell
      theme={theme}
      title="裁剪图片"
      icon={<Crop className="size-4" />}
      onClose={onClose}
    >
      <MediaStage source={source} naturalSize={naturalSize} maxHeightPx={maxHeightPx}>
        <div
          data-crop-overlay
          className="absolute inset-0 cursor-crosshair touch-none"
          onPointerDown={startDraw}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          <div
            className="absolute left-0 right-0 top-0 bg-black/50"
            style={{ height: `${crop.y}%` }}
          />
          <div
            className="absolute bottom-0 left-0 right-0 bg-black/50"
            style={{ top: `${crop.y + crop.height}%` }}
          />
          <div
            className="absolute bg-black/50"
            style={{ left: 0, top: `${crop.y}%`, width: `${crop.x}%`, height: `${crop.height}%` }}
          />
          <div
            className="absolute right-0 bg-black/50"
            style={{
              top: `${crop.y}%`,
              left: `${crop.x + crop.width}%`,
              height: `${crop.height}%`
            }}
          />
          <div
            className="absolute"
            style={{
              left: `${crop.x}%`,
              top: `${crop.y}%`,
              width: `${crop.width}%`,
              height: `${crop.height}%`
            }}
          >
            <div className="pointer-events-none absolute inset-0 border border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,.35)]" />
            <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/35" />
            <div className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/35" />
            <div className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/35" />
            <div className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/35" />
            <div
              data-crop-move
              className="absolute inset-1 cursor-move"
              onPointerDown={startMove}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
            />
            {CROP_HANDLES.map((handle) => (
              <div
                key={handle}
                data-crop-handle={handle}
                className="absolute size-3 border-2 border-white bg-black/40"
                style={handleStyle(handle)}
                onPointerDown={startResize(handle)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
              />
            ))}
          </div>
          {loupe && naturalSize && (
            <CropLoupe
              theme={theme}
              source={source}
              naturalSize={naturalSize}
              loupe={loupe}
              crop={crop}
            />
          )}
        </div>
      </MediaStage>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {CROP_RATIOS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => selectRatio(preset.value)}
            className="inline-flex h-8 items-center rounded-lg border px-2.5 transition"
            style={{
              ...controlStyle,
              background: ratio === preset.value ? theme.toolbar.activeBg : 'transparent',
              color: ratio === preset.value ? theme.toolbar.activeText : theme.node.text
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
        <NumberField
          label="X"
          value={crop.x}
          onChange={(value) => setCrop(clampCropRect({ ...crop, x: value }))}
        />
        <NumberField
          label="Y"
          value={crop.y}
          onChange={(value) => setCrop(clampCropRect({ ...crop, y: value }))}
        />
        <NumberField
          label="宽"
          value={crop.width}
          onChange={(value) => setCrop(clampCropRect({ ...crop, width: value }))}
        />
        <NumberField
          label="高"
          value={crop.height}
          onChange={(value) => setCrop(clampCropRect({ ...crop, height: value }))}
        />
      </div>
      <DialogAction theme={theme} label="创建裁剪结果" onClick={() => onConfirm(crop)} />
    </MediaDialogShell>
  )
}

function handleStyle(handle: CropHandle): {
  left: string
  top: string
  transform?: string
  cursor: string
} {
  const cursor = cursorForHandle(handle)
  if (handle === 'nw') return { left: '-6px', top: '-6px', cursor }
  if (handle === 'ne') return { left: 'calc(100% - 6px)', top: '-6px', cursor }
  if (handle === 'se') return { left: 'calc(100% - 6px)', top: 'calc(100% - 6px)', cursor }
  if (handle === 'sw') return { left: '-6px', top: 'calc(100% - 6px)', cursor }
  if (handle === 'n')
    return { left: '50%', top: '-5px', transform: 'translateX(-50%) scaleX(2)', cursor }
  if (handle === 's')
    return { left: '50%', top: 'calc(100% - 5px)', transform: 'translateX(-50%) scaleX(2)', cursor }
  if (handle === 'w')
    return { left: '-5px', top: '50%', transform: 'translateY(-50%) scaleY(2)', cursor }
  return { left: 'calc(100% - 5px)', top: '50%', transform: 'translateY(-50%) scaleY(2)', cursor }
}

function CropLoupe({
  theme,
  source,
  naturalSize,
  loupe,
  crop
}: {
  theme: CanvasTheme
  source: string
  naturalSize: NaturalSize
  loupe: LoupeState
  crop: CropRect
}): ReactElement {
  const naturalX = (loupe.percentX / 100) * naturalSize.width
  const naturalY = (loupe.percentY / 100) * naturalSize.height
  const pieceWidth = (crop.width / 100) * naturalSize.width
  const pieceHeight = (crop.height / 100) * naturalSize.height
  const flipLeft = loupe.percentX > 70
  const flipDown = loupe.percentY < 35
  const left = flipLeft ? loupe.displayX - LOUPE_OFFSET - LOUPE_SIZE : loupe.displayX + LOUPE_OFFSET
  const top = flipDown ? loupe.displayY + LOUPE_OFFSET : loupe.displayY - LOUPE_OFFSET - LOUPE_SIZE
  return (
    <div data-crop-loupe className="pointer-events-none absolute z-10" style={{ left, top }}>
      <div
        className="relative grid place-items-center overflow-hidden rounded-full border-2 bg-black/20 shadow-xl"
        style={{
          width: LOUPE_SIZE,
          height: LOUPE_SIZE,
          borderColor: theme.node.activeStroke,
          backgroundImage: `url("${source}")`,
          backgroundSize: `${naturalSize.width * LOUPE_ZOOM}px ${naturalSize.height * LOUPE_ZOOM}px`,
          backgroundPosition: `${LOUPE_SIZE / 2 - naturalX * LOUPE_ZOOM}px ${
            LOUPE_SIZE / 2 - naturalY * LOUPE_ZOOM
          }px`,
          backgroundRepeat: 'no-repeat'
        }}
      >
        <span className="h-full w-px bg-white/70" />
        <span className="absolute inset-x-0 top-1/2 h-px bg-white/70" />
      </div>
      <div
        data-crop-loupe-label
        className="mt-1 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white"
      >
        {Math.round(naturalX)}, {Math.round(naturalY)} · {Math.round(pieceWidth)}×
        {Math.round(pieceHeight)}
      </div>
    </div>
  )
}
