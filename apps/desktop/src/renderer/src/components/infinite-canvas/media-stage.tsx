import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'

export type NaturalSize = { width: number; height: number }

export function fitStageSize(
  natural: NaturalSize,
  container: { width: number; height: number }
): { width: number; height: number } {
  const scale = Math.min(
    container.width / Math.max(1, natural.width),
    container.height / Math.max(1, natural.height)
  )
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale))
  }
}

export function pointerToPercent(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number }
): { x: number; y: number } {
  const x = ((point.x - rect.left) / Math.max(1, rect.width)) * 100
  const y = ((point.y - rect.top) / Math.max(1, rect.height)) * 100
  return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) }
}

export function useImageNaturalSize(source: string): NaturalSize | null {
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null)
  useEffect(() => {
    let cancelled = false
    setNaturalSize(null)
    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      setNaturalSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 })
    }
    image.src = source
    return () => {
      cancelled = true
    }
  }, [source])
  return naturalSize
}

export function capturePointer(event: ReactPointerEvent<HTMLElement>): void {
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // jsdom 等环境会拒绝未注册的 pointerId，直接忽略
  }
}

export function MediaStage({
  source,
  naturalSize,
  maxHeightPx,
  children
}: {
  source: string
  naturalSize: NaturalSize | null
  maxHeightPx: number
  children?: ReactNode
}): ReactElement {
  const measureRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  useEffect(() => {
    const element = measureRef.current
    if (!element) return
    const update = (): void => setContainerWidth(element.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fit =
    naturalSize && containerWidth > 0
      ? fitStageSize(naturalSize, { width: containerWidth, height: maxHeightPx })
      : null
  return (
    <div ref={measureRef} className="relative w-full">
      {fit ? (
        <div
          data-media-stage-content
          className="relative mx-auto select-none"
          style={{ width: fit.width, height: fit.height }}
        >
          <img
            src={source}
            alt=""
            draggable={false}
            className="pointer-events-none block h-full w-full rounded-xl"
          />
          {children}
        </div>
      ) : (
        <img
          src={source}
          alt=""
          draggable={false}
          className="pointer-events-none block max-h-[50vh] w-full rounded-xl object-contain opacity-60"
        />
      )}
    </div>
  )
}
