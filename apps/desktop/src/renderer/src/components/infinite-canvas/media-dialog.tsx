import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { Brush, Eraser, Maximize2, Redo2, RotateCcw, Undo2, WandSparkles } from 'lucide-react'

import type { CanvasTheme } from './canvas-theme'
import { DialogAction, MediaDialogShell } from './media-dialog-shell'
import { piecePixelBounds, seedCuts } from './crop-split-interaction'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { toEditableImageUrl } from '@/lib/download'

export interface MaskEditPayload {
  prompt: string
  maskDataUrl: string
  /** 原图真实像素（宽x高）：服务端按白名单选档，避免 4K 原图被降采样重绘 */
  size?: string
}

export type MaskStroke = {
  mode: 'paint' | 'erase'
  size: number
  points: Array<{ x: number; y: number }>
}

const MASK_PREVIEW_COLOR = 'rgba(37, 99, 235, .45)'

/** 对齐参考项目的蒙版编辑：画笔涂抹 → 导出"涂抹区透明"的 PNG 蒙版（/images/edits 语义）。 */
export function MaskEditDialog({
  theme,
  source,
  onClose,
  onConfirm
}: {
  theme: CanvasTheme
  source: string
  onClose: () => void
  onConfirm: (payload: MaskEditPayload) => void
}): ReactElement {
  const [prompt, setPrompt] = useState('')
  const [brushSize, setBrushSize] = useState(48)
  const [mode, setMode] = useState<'paint' | 'erase'>('paint')
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [, setStrokeVersion] = useState(0)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef<MaskStroke[]>([])
  const redoStrokesRef = useRef<MaskStroke[]>([])
  const activeStrokeRef = useRef<MaskStroke | null>(null)
  const drawingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        // 跨域源画上 canvas 会被污染、无法导出蒙版：先转成同源 object URL
        const url = await toEditableImageUrl(source)
        if (cancelled) {
          if (url !== source) URL.revokeObjectURL(url)
          return
        }
        objectUrl = url
        const image = new Image()
        image.onload = () => {
          if (cancelled) return
          imageRef.current = image
          setNaturalSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 })
        }
        image.src = url
      } catch {
        if (!cancelled) setLoadError('图片读取失败，请稍后重试')
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [source])

  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !naturalSize) return
    if (canvas.width !== naturalSize.width || canvas.height !== naturalSize.height) {
      canvas.width = naturalSize.width
      canvas.height = naturalSize.height
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    for (const stroke of [
      ...strokesRef.current,
      ...(activeStrokeRef.current ? [activeStrokeRef.current] : [])
    ]) {
      context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'
      context.strokeStyle = MASK_PREVIEW_COLOR
      context.lineWidth = stroke.size
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.beginPath()
      stroke.points.forEach((point, index) =>
        index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)
      )
      if (stroke.points.length === 1) {
        context.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y + 0.01)
      }
      context.stroke()
    }
    context.globalCompositeOperation = 'source-over'
  }, [mode, brushSize, naturalSize])

  const toNaturalPoint = (
    event: ReactPointerEvent<HTMLCanvasElement>
  ): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * (naturalSize?.width ?? rect.width),
      y: ((event.clientY - rect.top) / rect.height) * (naturalSize?.height ?? rect.height)
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!naturalSize) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    redoStrokesRef.current = []
    activeStrokeRef.current = {
      mode,
      size: (brushSize / event.currentTarget.getBoundingClientRect().width) * naturalSize.width,
      points: [toNaturalPoint(event)]
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current || !activeStrokeRef.current) return
    event.preventDefault()
    activeStrokeRef.current.points.push(toNaturalPoint(event))
    setStrokeVersion((version) => version + 1)
  }

  const finishStroke = (): void => {
    if (!activeStrokeRef.current) return
    strokesRef.current.push(activeStrokeRef.current)
    activeStrokeRef.current = null
    drawingRef.current = false
    setStrokeVersion((version) => version + 1)
  }

  const undo = (): void => {
    const stroke = strokesRef.current.pop()
    if (stroke) redoStrokesRef.current.push(stroke)
    setStrokeVersion((version) => version + 1)
  }

  const redo = (): void => {
    const stroke = redoStrokesRef.current.pop()
    if (stroke) strokesRef.current.push(stroke)
    setStrokeVersion((version) => version + 1)
  }

  const clearAll = (): void => {
    strokesRef.current = []
    redoStrokesRef.current = []
    setStrokeVersion((version) => version + 1)
  }

  const hasPaintedArea = (): boolean => strokesRef.current.some((stroke) => stroke.mode === 'paint')

  // 导出符合 OpenAI /images/edits 语义的蒙版：不透明底图，涂抹区被抠成全透明。
  const exportMask = (): string | null => {
    const image = imageRef.current
    if (!image || !naturalSize) return null
    const canvas = document.createElement('canvas')
    canvas.width = naturalSize.width
    canvas.height = naturalSize.height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0)
    const replay = (list: MaskStroke[]): void => {
      for (const stroke of list) {
        context.globalCompositeOperation =
          stroke.mode === 'paint' ? 'destination-out' : 'source-over'
        if (stroke.mode === 'erase') {
          // 擦除 = 把原图贴回该笔迹区域。
          context.save()
          context.beginPath()
          stroke.points.forEach((point, index) =>
            index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)
          )
          context.lineWidth = stroke.size
          context.lineCap = 'round'
          context.lineJoin = 'round'
          context.stroke()
          context.clip()
          context.drawImage(image, 0, 0)
          context.restore()
        } else {
          context.strokeStyle = '#000'
          context.lineWidth = stroke.size
          context.lineCap = 'round'
          context.lineJoin = 'round'
          context.beginPath()
          stroke.points.forEach((point, index) =>
            index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)
          )
          if (stroke.points.length === 1) {
            context.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y + 0.01)
          }
          context.stroke()
        }
      }
    }
    replay(strokesRef.current)
    context.globalCompositeOperation = 'source-over'
    return canvas.toDataURL('image/png')
  }

  const confirm = (): void => {
    const maskDataUrl = exportMask()
    if (!maskDataUrl || !prompt.trim()) return
    onConfirm({
      prompt: prompt.trim(),
      maskDataUrl,
      size: naturalSize ? `${naturalSize.width}x${naturalSize.height}` : undefined
    })
  }

  const controlStyle = { borderColor: theme.toolbar.border, color: theme.node.text }

  return (
    <MediaDialogShell
      theme={theme}
      title="蒙版编辑（局部重绘）"
      icon={<WandSparkles className="size-4" />}
      onClose={onClose}
    >
      {loadError ? (
        <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-500">
          {loadError}
        </p>
      ) : (
        <div className="relative select-none">
          <img
            src={source}
            alt="待编辑图片"
            draggable={false}
            className="pointer-events-none block max-h-[50vh] w-full rounded-xl object-contain"
          />
          <canvas
            ref={overlayRef}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none rounded-[inherit]"
            style={{ width: '100%', height: '100%' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
            onWheel={(event) => event.stopPropagation()}
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          title="涂抹重绘区域"
          onClick={() => setMode('paint')}
          className="inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 transition"
          style={{
            ...controlStyle,
            background: mode === 'paint' ? theme.toolbar.activeBg : 'transparent'
          }}
        >
          <Brush className="size-3.5" /> 涂抹
        </button>
        <button
          type="button"
          title="擦除涂抹区域"
          onClick={() => setMode('erase')}
          className="inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 transition"
          style={{
            ...controlStyle,
            background: mode === 'erase' ? theme.toolbar.activeBg : 'transparent'
          }}
        >
          <Eraser className="size-3.5" /> 擦除
        </button>
        <label className="inline-flex items-center gap-2 opacity-80">
          笔刷
          <input
            type="range"
            min={8}
            max={160}
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            className="w-28"
            style={{ accentColor: theme.node.activeStroke }}
          />
        </label>
        <span className="flex-1" />
        <button
          type="button"
          title="撤销"
          disabled={!strokesRef.current.length}
          onClick={undo}
          className="grid size-8 place-items-center rounded-lg border disabled:pointer-events-none disabled:opacity-35"
          style={controlStyle}
        >
          <Undo2 className="size-3.5" />
        </button>
        <button
          type="button"
          title="重做"
          disabled={!redoStrokesRef.current.length}
          onClick={redo}
          className="grid size-8 place-items-center rounded-lg border disabled:pointer-events-none disabled:opacity-35"
          style={controlStyle}
        >
          <Redo2 className="size-3.5" />
        </button>
        <button
          type="button"
          title="清空涂抹"
          disabled={!strokesRef.current.length && !redoStrokesRef.current.length}
          onClick={clearAll}
          className="grid size-8 place-items-center rounded-lg border disabled:pointer-events-none disabled:opacity-35"
          style={controlStyle}
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
        placeholder="描述涂抹区域要变成什么…"
        className="thin-scrollbar mt-3 min-h-20 w-full resize-y rounded-xl border bg-transparent px-3 py-2 text-sm leading-6 outline-none"
        style={controlStyle}
      />
      <DialogAction
        theme={theme}
        label="生成局部重绘"
        disabled={!prompt.trim() || !hasPaintedArea()}
        onClick={confirm}
      />
    </MediaDialogShell>
  )
}

export { CropDialog } from './crop-dialog'

export { SplitDialog } from './split-dialog'

export function UpscaleDialog({
  theme,
  source,
  onClose,
  onConfirm
}: {
  theme: CanvasTheme
  source: string
  onClose: () => void
  onConfirm: (scale: number) => void
}): ReactElement {
  const [scale, setScale] = useState(2)
  return (
    <MediaDialogShell
      theme={theme}
      title="放大图片"
      icon={<Maximize2 className="size-4" />}
      onClose={onClose}
    >
      <img
        src={source}
        alt="待放大图片"
        className="max-h-[50vh] w-full rounded-xl object-contain"
      />
      <label className="mt-3 block text-xs">
        放大倍数
        <Select value={String(scale)} onValueChange={(next) => setScale(Number(next))}>
          <SelectTrigger
            aria-label="放大倍数"
            className="mt-1 h-9 w-full rounded-lg border bg-transparent px-2 text-xs shadow-none dark:bg-transparent"
            style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            className="z-[120]"
            style={{
              background: theme.node.panel,
              borderColor: theme.node.stroke,
              color: theme.node.text
            }}
            data-canvas-no-zoom
            onWheel={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {[2, 3, 4].map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value}x
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <DialogAction theme={theme} label={`创建 ${scale}x 结果`} onClick={() => onConfirm(scale)} />
    </MediaDialogShell>
  )
}

export function cropDataUrl(
  source: string,
  crop: { x: number; y: number; width: number; height: number }
): Promise<string> {
  return imageTransform(source, (canvas, image) => {
    const x = (image.naturalWidth * crop.x) / 100
    const y = (image.naturalHeight * crop.y) / 100
    const width = (image.naturalWidth * crop.width) / 100
    const height = (image.naturalHeight * crop.height) / 100
    canvas.width = Math.max(1, width)
    canvas.height = Math.max(1, height)
    canvas.getContext('2d')?.drawImage(image, x, y, width, height, 0, 0, width, height)
  })
}

export function splitDataUrls(
  source: string,
  params: { rows: number; columns: number; rowCuts?: number[]; columnCuts?: number[] }
): Promise<string[]> {
  return toEditableImageUrl(source).then((editable) =>
    new Promise<string[]>((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const xBounds = piecePixelBounds(
          params.columnCuts ?? seedCuts(params.columns),
          image.naturalWidth
        )
        const yBounds = piecePixelBounds(
          params.rowCuts ?? seedCuts(params.rows),
          image.naturalHeight
        )
        const results: string[] = []
        for (let row = 0; row + 1 < yBounds.length; row += 1) {
          for (let column = 0; column + 1 < xBounds.length; column += 1) {
            const width = xBounds[column + 1] - xBounds[column]
            const height = yBounds[row + 1] - yBounds[row]
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, width)
            canvas.height = Math.max(1, height)
            canvas
              .getContext('2d')
              ?.drawImage(image, xBounds[column], yBounds[row], width, height, 0, 0, width, height)
            results.push(canvas.toDataURL('image/png'))
          }
        }
        resolve(results)
      }
      image.onerror = () => reject(new Error('图片读取失败'))
      image.src = editable
    }).finally(() => {
      if (editable !== source) URL.revokeObjectURL(editable)
    })
  )
}

export function upscaleDataUrl(source: string, scale: number): Promise<string> {
  return imageTransform(source, (canvas, image) => {
    canvas.width = image.naturalWidth * scale
    canvas.height = image.naturalHeight * scale
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
  })
}

function imageTransform(
  source: string,
  draw: (canvas: HTMLCanvasElement, image: HTMLImageElement) => void
): Promise<string> {
  return toEditableImageUrl(source).then((editable) =>
    new Promise<string>((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const canvas = document.createElement('canvas')
        draw(canvas, image)
        resolve(canvas.toDataURL('image/png'))
      }
      image.onerror = () => reject(new Error('图片读取失败'))
      image.src = editable
    }).finally(() => {
      if (editable !== source) URL.revokeObjectURL(editable)
    })
  )
}
