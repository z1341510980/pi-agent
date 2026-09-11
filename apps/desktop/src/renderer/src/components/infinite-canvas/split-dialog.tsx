import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { Grid2x2 } from 'lucide-react'

import type { CanvasTheme } from './canvas-theme'
import { DialogAction, MediaDialogShell, NumberField } from './media-dialog-shell'
import { capturePointer, MediaStage, pointerToPercent, useImageNaturalSize } from './media-stage'
import { adjustCutsToCount, moveCut, seedCuts } from './crop-split-interaction'

type CutAxis = 'row' | 'column'
type CutDrag = { axis: CutAxis; index: number; pointerId: number }
type DragInfo = { axis: CutAxis; index: number; position: number }

export function SplitDialog({
  theme,
  source,
  onClose,
  onConfirm
}: {
  theme: CanvasTheme
  source: string
  onClose: () => void
  onConfirm: (params: {
    rows: number
    columns: number
    rowCuts: number[]
    columnCuts: number[]
  }) => void
}): ReactElement {
  const [rows, setRows] = useState(2)
  const [columns, setColumns] = useState(2)
  const [rowCuts, setRowCuts] = useState<number[]>(() => seedCuts(2))
  const [columnCuts, setColumnCuts] = useState<number[]>(() => seedCuts(2))
  const naturalSize = useImageNaturalSize(source)
  const dragRef = useRef<CutDrag | null>(null)
  const [dragInfo, setDragInfo] = useState<DragInfo | null>(null)

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

  const startCutDrag =
    (axis: CutAxis, index: number) =>
    (event: ReactPointerEvent<HTMLElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      capturePointer(event)
      dragRef.current = { axis, index, pointerId: event.pointerId }
      // 兜底：指针捕获失败时防止幽灵拖动
      const endDragFallback = (): void => {
        if (!dragRef.current) return
        dragRef.current = null
        setDragInfo(null)
      }
      window.addEventListener('pointerup', endDragFallback, { once: true })
      window.addEventListener('pointercancel', endDragFallback, { once: true })
    }

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const cuts = drag.axis === 'column' ? columnCuts : rowCuts
    if (drag.index >= cuts.length) {
      dragRef.current = null
      setDragInfo(null)
      return
    }
    event.preventDefault()
    const pointer = percentFrom(event)
    const position = drag.axis === 'column' ? pointer.x : pointer.y
    if (drag.axis === 'column') {
      const next = moveCut(columnCuts, drag.index, position)
      setColumnCuts(next)
      setDragInfo({ axis: drag.axis, index: drag.index, position: next[drag.index] })
    } else {
      const next = moveCut(rowCuts, drag.index, position)
      setRowCuts(next)
      setDragInfo({ axis: drag.axis, index: drag.index, position: next[drag.index] })
    }
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    dragRef.current = null
    setDragInfo(null)
  }

  const changeCount = (axis: CutAxis, value: number): void => {
    if (axis === 'row') {
      setRows(value)
      setRowCuts((current) => adjustCutsToCount(current, value))
    } else {
      setColumns(value)
      setColumnCuts((current) => adjustCutsToCount(current, value))
    }
  }

  const pieceLabel = (info: DragInfo): string => {
    if (!naturalSize) return `${info.position}%`
    if (info.axis === 'column') {
      const previous = columnCuts[info.index - 1] ?? 0
      const next = columnCuts[info.index + 1] ?? 100
      const left = ((info.position - previous) / 100) * naturalSize.width
      const right = ((next - info.position) / 100) * naturalSize.width
      return `${info.position}% · ${Math.round(left)}×${Math.round(right)}`
    }
    const previous = rowCuts[info.index - 1] ?? 0
    const next = rowCuts[info.index + 1] ?? 100
    const top = ((info.position - previous) / 100) * naturalSize.height
    const bottom = ((next - info.position) / 100) * naturalSize.height
    return `${info.position}% · ${Math.round(top)}×${Math.round(bottom)}`
  }

  const maxHeightPx = typeof window === 'undefined' ? 400 : Math.round(window.innerHeight * 0.5)
  const lineBase = 'rgba(255,255,255,.85)'
  const lineActive = theme.node.activeStroke

  return (
    <MediaDialogShell
      theme={theme}
      title="拆分图片"
      icon={<Grid2x2 className="size-4" />}
      onClose={onClose}
    >
      <MediaStage source={source} naturalSize={naturalSize} maxHeightPx={maxHeightPx}>
        <div data-split-overlay className="absolute inset-0 select-none">
          {columnCuts.map((cut, index) => (
            <div
              key={`column-${index}`}
              data-cut="column"
              data-cut-index={index}
              className="absolute inset-y-0 -ml-3 w-6 cursor-ew-resize touch-none"
              style={{ left: `${cut}%` }}
              onPointerDown={startCutDrag('column', index)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
            >
              <div
                className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2"
                style={{
                  background:
                    dragInfo && dragInfo.axis === 'column' && dragInfo.index === index
                      ? lineActive
                      : lineBase,
                  boxShadow: '0 0 2px rgba(0,0,0,.8)'
                }}
              />
            </div>
          ))}
          {rowCuts.map((cut, index) => (
            <div
              key={`row-${index}`}
              data-cut="row"
              data-cut-index={index}
              className="absolute inset-x-0 -mt-3 h-6 cursor-ns-resize touch-none"
              style={{ top: `${cut}%` }}
              onPointerDown={startCutDrag('row', index)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
            >
              <div
                className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2"
                style={{
                  background:
                    dragInfo && dragInfo.axis === 'row' && dragInfo.index === index
                      ? lineActive
                      : lineBase,
                  boxShadow: '0 0 2px rgba(0,0,0,.8)'
                }}
              />
            </div>
          ))}
          {dragInfo && (
            <div
              data-cut-label
              className="pointer-events-none absolute z-10 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white"
              style={
                dragInfo.axis === 'column'
                  ? dragInfo.position > 70
                    ? {
                        left: `${dragInfo.position}%`,
                        top: 8,
                        transform: 'translateX(-100%)'
                      }
                    : { left: `${dragInfo.position}%`, top: 8 }
                  : dragInfo.position > 70
                    ? {
                        top: `${dragInfo.position}%`,
                        left: 8,
                        transform: 'translateY(-100%)'
                      }
                    : { top: `${dragInfo.position}%`, left: 8 }
              }
            >
              {pieceLabel(dragInfo)}
            </div>
          )}
        </div>
      </MediaStage>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <NumberField
          label="行数"
          value={rows}
          min={1}
          max={6}
          onChange={(value) => changeCount('row', value)}
        />
        <NumberField
          label="列数"
          value={columns}
          min={1}
          max={6}
          onChange={(value) => changeCount('column', value)}
        />
      </div>
      <DialogAction
        theme={theme}
        label={`创建 ${rows * columns} 个图片节点`}
        onClick={() => onConfirm({ rows, columns, rowCuts, columnCuts })}
      />
    </MediaDialogShell>
  )
}
