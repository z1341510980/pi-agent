# 无限画布 裁剪与拆分交互升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将无限画布的裁剪对话框升级为 PS 式可拖动裁剪框（含拖动手柄时的放大镜），拆分对话框升级为可预览网格且可拖动切割线，两个功能独立实现、互不影响。

**Architecture:** 交互数学全部沉淀在纯函数模块 `crop-split-interaction.ts`（百分比空间，含原图宽高换算），裁剪/拆分对话框分别落在 `crop-dialog.tsx` / `split-dialog.tsx`，共用 `media-stage.tsx`（原图尺寸加载 + contain 显式尺寸渲染 + 指针→百分比换算）与 `media-dialog-shell.tsx`（对话框外壳）。`media-dialog.tsx` 保留蒙版/放大对话框与图像变换函数，并 re-export 新对话框保持 workspace 导入路径不变。放大镜用 CSS background 定位实现，无 canvas 重绘。

**Tech Stack:** React 19、TypeScript、Vitest + Testing Library、Tailwind CSS、lucide-react。

---

## 文件边界

- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/crop-split-interaction.ts`
  - 裁剪矩形 8 手柄缩放/移动/绘制/比例重塑 + 切割线播种/增删/移动/像素边界，全部纯函数。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/crop-split-interaction.test.ts`
  - 覆盖上述全部纯函数。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog-shell.tsx`
  - 从 `media-dialog.tsx` 原样搬出 `MediaDialogShell`、`DialogAction`、`NumberField`。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/media-stage.tsx`
  - `useImageNaturalSize` / `fitStageSize` / `pointerToPercent` / `capturePointer` / `MediaStage`。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/media-stage.test.tsx`
  - 覆盖 `fitStageSize` / `pointerToPercent` 纯函数。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/crop-dialog.tsx`
  - PS 式裁剪框 + 三分网格 + 压暗遮罩 + 8 手柄 + 比例预设 + 放大镜。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/split-dialog.tsx`
  - 网格切割线预览 + 可拖动切割线 + 拖动浮签。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/crop-dialog.test.tsx`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/split-dialog.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog.tsx`
  - 删除本地 Shell/DialogAction/NumberField 与旧 CropDialog/SplitDialog，改为导入/re-export；`splitDataUrls` 支持非均匀切割线。
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx`
  - 仅 `splitImage` 的参数类型扩展。

### Task 1: 裁剪与拆分交互纯函数

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/crop-split-interaction.ts`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/crop-split-interaction.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/crop-split-interaction.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  addCut,
  adjustCutsToCount,
  applyCropRatio,
  clampCropRect,
  cutBoundaries,
  dragCropRect,
  moveCropRect,
  moveCut,
  normalizeCuts,
  piecePixelBounds,
  removeCut,
  resizeCropRect,
  seedCuts,
  MIN_CUT_GAP
} from '../crop-split-interaction'

const square = { width: 800, height: 800 }
const wide = { width: 800, height: 600 }

describe('crop rect helpers', () => {
  it('clamps position, size and rounds to two decimals', () => {
    expect(clampCropRect({ x: -5, y: 120, width: 40, height: 0.5 })).toEqual({
      x: 0,
      y: 99.5,
      width: 40,
      height: 2
    })
    expect(clampCropRect({ x: 33.333333, y: 10, width: 10, height: 10 })).toEqual({
      x: 33.33,
      y: 10,
      width: 10,
      height: 10
    })
  })

  it('resizes freely from the se handle with the nw corner anchored', () => {
    const next = resizeCropRect({ x: 0, y: 0, width: 100, height: 100 }, 'se', { x: 50, y: 40 }, {
      ratio: null,
      natural: square
    })
    expect(next).toEqual({ x: 0, y: 0, width: 50, height: 40 })
  })

  it('resizes from the nw handle with the se corner anchored', () => {
    const next = resizeCropRect({ x: 10, y: 10, width: 40, height: 40 }, 'nw', { x: 30, y: 20 }, {
      ratio: null,
      natural: square
    })
    expect(next).toEqual({ x: 30, y: 20, width: 20, height: 30 })
  })

  it('keeps a 1:1 ratio on corner handles by expanding the smaller axis', () => {
    const next = resizeCropRect({ x: 0, y: 0, width: 20, height: 20 }, 'se', { x: 50, y: 40 }, {
      ratio: 1,
      natural: square
    })
    expect(next).toEqual({ x: 0, y: 0, width: 50, height: 50 })
  })

  it('keeps ratio on edge handles and centers the other axis', () => {
    const next = resizeCropRect({ x: 0, y: 0, width: 100, height: 100 }, 'e', { x: 50, y: 50 }, {
      ratio: 1,
      natural: wide
    })
    // ratioPercent = 1 * 600 / 800 = 0.75 -> width 50 -> height 66.67
    expect(next).toEqual({ x: 0, y: 16.67, width: 50, height: 66.67 })
  })

  it('clamps the resized rect into the image bounds', () => {
    const next = resizeCropRect({ x: 0, y: 0, width: 100, height: 100 }, 'se', { x: 150, y: 150 }, {
      ratio: null,
      natural: square
    })
    expect(next).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('moves the rect and clamps it into bounds', () => {
    const next = moveCropRect({ x: 0, y: 0, width: 40, height: 40 }, { x: 90, y: 90 }, { x: 20, y: 20 })
    expect(next).toEqual({ x: 60, y: 60, width: 40, height: 40 })
  })

  it('builds a new rect from an anchor and pointer in any direction', () => {
    expect(dragCropRect({ x: 10, y: 10 }, { x: 60, y: 40 })).toEqual({
      x: 10,
      y: 10,
      width: 50,
      height: 30
    })
    expect(dragCropRect({ x: 70, y: 90 }, { x: 20, y: 30 })).toEqual({
      x: 20,
      y: 30,
      width: 50,
      height: 60
    })
  })

  it('reshapes the rect to a ratio around its center', () => {
    const next = applyCropRatio({ x: 0, y: 0, width: 100, height: 100 }, 1, wide)
    // ratioPercent = 0.75 -> full height 100 -> width 75, centered
    expect(next).toEqual({ x: 12.5, y: 0, width: 75, height: 100 })
  })
})

describe('cut line helpers', () => {
  it('seeds uniform cuts', () => {
    expect(seedCuts(1)).toEqual([])
    expect(seedCuts(2)).toEqual([50])
    expect(seedCuts(3)).toEqual([33.33, 66.67])
    expect(seedCuts(6)).toEqual([16.67, 33.33, 50, 66.67, 83.33])
  })

  it('normalizes cuts by sorting, clamping and deduplicating', () => {
    expect(normalizeCuts([60, 30, 30, 1, 120])).toEqual([5, 30, 60, 95])
  })

  it('adds a cut at the midpoint of the largest gap', () => {
    expect(addCut([])).toEqual([50])
    expect(addCut([25])).toEqual([25, 62.5])
    expect(addCut([25, 50])).toEqual([12.5, 25, 50])
  })

  it('removes the cut closest to the middle', () => {
    expect(removeCut([25, 50])).toEqual([25])
    expect(removeCut([20, 70])).toEqual([70])
    expect(removeCut([])).toEqual([])
  })

  it('moves a cut with a minimum gap to neighbours and borders', () => {
    expect(moveCut([50], 0, 0)).toEqual([MIN_CUT_GAP])
    expect(moveCut([50], 0, 100)).toEqual([100 - MIN_CUT_GAP])
    expect(moveCut([25, 50, 75], 1, 90)).toEqual([25, 45, 75])
    expect(moveCut([25, 50], 5, 60)).toEqual([25, 50])
  })

  it('adjusts cut count while keeping user positions', () => {
    expect(adjustCutsToCount([50], 3)).toEqual([25, 50])
    expect(adjustCutsToCount([25, 50], 2)).toEqual([25])
    expect(adjustCutsToCount([20, 80], 1)).toEqual([80])
  })

  it('exposes cut boundaries including image borders', () => {
    expect(cutBoundaries([25, 75])).toEqual([0, 25, 75, 100])
  })

  it('maps cuts to monotonically increasing pixel boundaries', () => {
    expect(piecePixelBounds([25, 75], 1000)).toEqual([0, 250, 750, 1000])
    expect(piecePixelBounds([], 600)).toEqual([0, 600])
    expect(piecePixelBounds([95, 99], 100)).toEqual([0, 95, 98, 100])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/crop-split-interaction.test.ts --environment jsdom
```

Expected: FAIL because `crop-split-interaction.ts` does not exist.

- [ ] **Step 3: Implement the pure interaction module**

Create `crop-split-interaction.ts`:

```ts
import { RESIZE_HANDLE_IDS, type ResizeHandleId } from './design-board/design-board-interaction'

export type CropHandle = ResizeHandleId
export const CROP_HANDLES: CropHandle[] = RESIZE_HANDLE_IDS

export type CropRect = { x: number; y: number; width: number; height: number }

export const MIN_CROP_PERCENT = 2
export const MIN_CUT_GAP = 5

export function clampCropRect(rect: CropRect): CropRect {
  const width = round2(Math.min(100, Math.max(MIN_CROP_PERCENT, rect.width)))
  const height = round2(Math.min(100, Math.max(MIN_CROP_PERCENT, rect.height)))
  return {
    x: round2(Math.min(100 - width, Math.max(0, rect.x))),
    y: round2(Math.min(100 - height, Math.max(0, rect.y))),
    width,
    height
  }
}

export function resizeCropRect(
  initial: CropRect,
  handle: CropHandle,
  pointer: { x: number; y: number },
  options: { ratio: number | null; natural: { width: number; height: number } }
): CropRect {
  const controlsX = handle !== 'n' && handle !== 's'
  const controlsY = handle !== 'e' && handle !== 'w'
  const anchorX = handle.includes('w') ? initial.x + initial.width : initial.x
  const anchorY = handle.includes('n') ? initial.y + initial.height : initial.y
  let width = initial.width
  let height = initial.height
  if (controlsX) width = Math.abs(pointer.x - anchorX)
  if (controlsY) height = Math.abs(pointer.y - anchorY)
  if (options.ratio !== null) {
    const ratioPercent = (options.ratio * options.natural.height) / options.natural.width
    if (controlsX && controlsY) {
      if (width > height * ratioPercent) height = width / ratioPercent
      else width = height * ratioPercent
    } else if (controlsX) {
      height = width / ratioPercent
    } else {
      width = height * ratioPercent
    }
  }
  width = Math.max(MIN_CROP_PERCENT, width)
  height = Math.max(MIN_CROP_PERCENT, height)
  let x = handle.includes('w') ? anchorX - width : anchorX
  let y = handle.includes('n') ? anchorY - height : anchorY
  if (options.ratio !== null && controlsX !== controlsY) {
    if (controlsX) y = initial.y + initial.height / 2 - height / 2
    else x = initial.x + initial.width / 2 - width / 2
  }
  return clampCropRect({ x, y, width, height })
}

export function moveCropRect(
  rect: CropRect,
  pointer: { x: number; y: number },
  grabOffset: { x: number; y: number }
): CropRect {
  return clampCropRect({
    x: pointer.x - grabOffset.x,
    y: pointer.y - grabOffset.y,
    width: rect.width,
    height: rect.height
  })
}

export function dragCropRect(
  anchor: { x: number; y: number },
  pointer: { x: number; y: number }
): CropRect {
  return clampCropRect({
    x: Math.min(anchor.x, pointer.x),
    y: Math.min(anchor.y, pointer.y),
    width: Math.abs(pointer.x - anchor.x),
    height: Math.abs(pointer.y - anchor.y)
  })
}

export function applyCropRatio(
  rect: CropRect,
  ratio: number,
  natural: { width: number; height: number }
): CropRect {
  const ratioPercent = (ratio * natural.height) / natural.width
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  let width = rect.width
  let height = width / ratioPercent
  if (height > rect.height) {
    height = rect.height
    width = height * ratioPercent
  }
  return clampCropRect({ x: centerX - width / 2, y: centerY - height / 2, width, height })
}

export function seedCuts(count: number): number[] {
  const safeCount = Math.max(1, Math.round(count))
  return Array.from({ length: safeCount - 1 }, (_, index) =>
    round2(((index + 1) * 100) / safeCount)
  )
}

export function normalizeCuts(values: number[]): number[] {
  const clamped = values.map((value) =>
    round2(Math.min(100 - MIN_CUT_GAP, Math.max(MIN_CUT_GAP, value)))
  )
  return [...new Set(clamped)].sort((a, b) => a - b)
}

export function addCut(cuts: number[]): number[] {
  const boundaries = cutBoundaries(cuts)
  let bestIndex = 0
  let bestGap = -1
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const gap = boundaries[index + 1] - boundaries[index]
    if (gap > bestGap) {
      bestGap = gap
      bestIndex = index
    }
  }
  return normalizeCuts([...cuts, round2((boundaries[bestIndex] + boundaries[bestIndex + 1]) / 2)])
}

export function removeCut(cuts: number[]): number[] {
  if (!cuts.length) return cuts
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  cuts.forEach((cut, index) => {
    const distance = Math.abs(cut - 50)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return cuts.filter((_, index) => index !== bestIndex)
}

export function moveCut(cuts: number[], index: number, position: number): number[] {
  if (index < 0 || index >= cuts.length) return cuts
  const lower = index > 0 ? cuts[index - 1] + MIN_CUT_GAP : MIN_CUT_GAP
  const upper = index < cuts.length - 1 ? cuts[index + 1] - MIN_CUT_GAP : 100 - MIN_CUT_GAP
  const next = cuts.slice()
  next[index] = round2(Math.min(upper, Math.max(lower, position)))
  return next
}

export function adjustCutsToCount(cuts: number[], count: number): number[] {
  const target = Math.max(0, Math.round(count) - 1)
  let next = cuts.slice()
  while (next.length > target) next = removeCut(next)
  while (next.length < target) next = addCut(next)
  return next
}

export function cutBoundaries(cuts: number[]): number[] {
  return [0, ...cuts, 100]
}

export function piecePixelBounds(cuts: number[], totalPixels: number): number[] {
  const safeTotal = Math.max(1, Math.round(totalPixels))
  const percentages = cutBoundaries(normalizeCuts(cuts))
  const bounds: number[] = []
  for (let index = 0; index < percentages.length; index += 1) {
    if (index === 0) {
      bounds.push(0)
      continue
    }
    if (index === percentages.length - 1) {
      bounds.push(safeTotal)
      continue
    }
    const bound = Math.round((percentages[index] / 100) * safeTotal)
    const remaining = percentages.length - 1 - index
    const previous = bounds[bounds.length - 1]
    bounds.push(Math.min(safeTotal - remaining, Math.max(previous + 1, bound)))
  }
  return bounds
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
```

- [ ] **Step 4: Run the tests and commit**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/crop-split-interaction.test.ts --environment jsdom
```

Expected: PASS.

```powershell
git add apps/desktop/src/renderer/src/components/infinite-canvas/crop-split-interaction.ts apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/crop-split-interaction.test.ts
git commit -m "feat: add crop and split interaction primitives"
```

### Task 2: 抽出 media-dialog 公共外壳

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog-shell.tsx`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog.tsx`

- [ ] **Step 1: Create the shared shell module**

Create `media-dialog-shell.tsx`（内容从 `media-dialog.tsx` 的 494-595 行原样搬出，仅改导出）:

```tsx
import type { ReactElement } from 'react'
import { Check, X } from 'lucide-react'

import type { CanvasTheme } from './canvas-theme'

export function MediaDialogShell({
  theme,
  title,
  icon,
  onClose,
  children
}: {
  theme: CanvasTheme
  title: string
  icon: ReactElement
  onClose: () => void
  children: ReactElement[] | ReactElement
}): ReactElement {
  return (
    <div
      className="fixed inset-0 z-[110] grid place-items-center bg-black/35 p-5"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-4 shadow-2xl"
        style={{
          background: theme.toolbar.panel,
          borderColor: theme.toolbar.border,
          color: theme.node.text
        }}
        data-canvas-no-zoom
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {icon}
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="grid size-7 place-items-center rounded-lg opacity-55 hover:opacity-100"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function DialogAction({
  theme,
  label,
  disabled = false,
  onClick
}: {
  theme: CanvasTheme
  label: string
  disabled?: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-35"
      style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
      onClick={onClick}
    >
      <Check className="size-3.5" />
      {label}
    </button>
  )
}

export function NumberField({
  label,
  value,
  min = 0,
  max = 100,
  onChange
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}): ReactElement {
  return (
    <label className="block">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) =>
          onChange(Math.min(max, Math.max(min, Number(event.target.value) || 0)))
        }
        className="mt-1 h-8 w-full rounded-lg border bg-transparent px-2"
      />
    </label>
  )
}
```

- [ ] **Step 2: Point media-dialog at the shared shell**

In `media-dialog.tsx`:
1. Remove the local `MediaDialogShell`, `DialogAction`, `NumberField` function definitions (lines 494-595).
2. Remove `Check` and `X` from the lucide import list (they move to the shell; `Crop`, `Grid2x2` 暂时保留，Task 3/4 再移除).
3. Add the import: `import { DialogAction, MediaDialogShell, NumberField } from './media-dialog-shell'`.

- [ ] **Step 3: Run the canvas suite to verify no regression**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas --environment jsdom
```

Expected: PASS (含新增 Task 1 测试)。

```powershell
git add apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog-shell.tsx apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog.tsx
git commit -m "refactor: extract media dialog shell helpers"
```

### Task 3: MediaStage + PS 式裁剪对话框（放大镜）

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/media-stage.tsx`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/crop-dialog.tsx`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/media-stage.test.tsx`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/crop-dialog.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog.tsx`

- [ ] **Step 1: Write the failing media-stage tests**

Create `__tests__/media-stage.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from 'vitest'
import { fitStageSize, pointerToPercent } from '../media-stage'

afterEach(() => {})

describe('fitStageSize', () => {
  it('fits inside the container without distortion', () => {
    expect(fitStageSize({ width: 800, height: 600 }, { width: 480, height: 384 })).toEqual({
      width: 480,
      height: 360
    })
  })

  it('caps by container height when the image is tall', () => {
    expect(fitStageSize({ width: 600, height: 800 }, { width: 480, height: 300 })).toEqual({
      width: 225,
      height: 300
    })
  })

  it('keeps at least one pixel', () => {
    expect(fitStageSize({ width: 0, height: 0 }, { width: 480, height: 300 })).toEqual({
      width: 1,
      height: 1
    })
  })
})

describe('pointerToPercent', () => {
  it('maps pointer coordinates to clamped percentages', () => {
    expect(
      pointerToPercent({ x: 240, y: 90 }, { left: 0, top: 0, width: 480, height: 360 })
    ).toEqual({ x: 50, y: 25 })
    expect(
      pointerToPercent({ x: -10, y: 400 }, { left: 0, top: 0, width: 480, height: 360 })
    ).toEqual({ x: 0, y: 100 })
  })
})
```

- [ ] **Step 2: Run it to confirm failure**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/media-stage.test.tsx --environment jsdom
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement media-stage.tsx**

```tsx
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
    // jsdom 等环境会拒绝未注册的 pointerId，直接忽略即可
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
```

- [ ] **Step 4: Run media-stage tests**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/media-stage.test.tsx --environment jsdom
```

Expected: PASS.

- [ ] **Step 5: Write the failing crop dialog tests**

Create `__tests__/crop-dialog.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CropDialog } from '../crop-dialog'
import type { CanvasTheme } from '../canvas-theme'

vi.mock('../media-stage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media-stage')>()
  return { ...actual, useImageNaturalSize: () => ({ width: 800, height: 600 }) }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const theme = {
  node: { panel: '#fff', fill: '#eee', text: '#111', muted: '#666', stroke: '#ddd', placeholder: '#999', activeStroke: '#2563eb' },
  toolbar: { panel: '#fff', border: '#ddd', border2: '#ccc', item: '#333', itemHover: '#eee', activeBg: '#111', activeText: '#fff' },
  canvas: { background: '#fafafa' },
  connection: { default: '#ccc', label: '#666' }
} as unknown as CanvasTheme

const stageRect = {
  left: 0,
  top: 0,
  width: 480,
  height: 360,
  right: 480,
  bottom: 360,
  x: 0,
  y: 0,
  toJSON: () => ({})
} as DOMRect

function renderDialog(): { onConfirm: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(stageRect)
  render(<CropDialog theme={theme} source="data:image/png;base64,A" onClose={vi.fn()} onConfirm={onConfirm} />)
  return { onConfirm }
}

function drag(element: Element, points: Array<{ x: number; y: number }>): void {
  const last = points[points.length - 1]
  fireEvent.pointerDown(element, { pointerId: 1, clientX: points[0].x, clientY: points[0].y })
  for (const point of points.slice(1)) {
    fireEvent.pointerMove(element, { pointerId: 1, clientX: point.x, clientY: point.y })
  }
  fireEvent.pointerUp(element, { pointerId: 1, clientX: last.x, clientY: last.y })
}

function setField(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('裁剪对话框', () => {
  it('拖动右下角手柄缩小裁剪框并确认', () => {
    const { onConfirm } = renderDialog()
    drag(document.querySelector('[data-crop-handle="se"]')!, [
      { x: 480, y: 360 },
      { x: 240, y: 180 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 0, y: 0, width: 50, height: 50 })
  })

  it('拖动手柄时显示放大镜，松手后消失', () => {
    renderDialog()
    const handle = document.querySelector('[data-crop-handle="se"]')!
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 480, clientY: 360 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 240, clientY: 180 })
    const loupe = document.querySelector('[data-crop-loupe]')
    expect(loupe).not.toBeNull()
    expect(document.querySelector('[data-crop-loupe-label]')?.textContent).toMatch(
      /^\d+, \d+ · \d+×\d+$/
    )
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 240, clientY: 180 })
    expect(document.querySelector('[data-crop-loupe]')).toBeNull()
  })

  it('1:1 比例下拖动边中点手柄保持比例', () => {
    const { onConfirm } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '1:1' }))
    const handle = document.querySelector('[data-crop-handle="e"]')!
    drag(handle, [
      { x: 420, y: 180 },
      { x: 240, y: 180 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 12.5, y: 25, width: 37.5, height: 50 })
  })

  it('框内拖动整体移动', () => {
    const { onConfirm } = renderDialog()
    setField('宽', '50')
    setField('高', '50')
    drag(document.querySelector('[data-crop-move]')!, [
      { x: 120, y: 90 },
      { x: 240, y: 180 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 25, y: 25, width: 50, height: 50 })
  })

  it('空白处拖出新裁剪框', () => {
    const { onConfirm } = renderDialog()
    setField('宽', '50')
    setField('高', '50')
    drag(document.querySelector('[data-crop-overlay]')!, [
      { x: 240, y: 306 },
      { x: 336, y: 342 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 50, y: 85, width: 20, height: 10 })
  })

  it('误触的小拖拽恢复原框', () => {
    const { onConfirm } = renderDialog()
    setField('宽', '50')
    setField('高', '50')
    drag(document.querySelector('[data-crop-overlay]')!, [
      { x: 240, y: 306 },
      { x: 244.8, y: 309.6 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 0, y: 0, width: 50, height: 50 })
  })

  it('数字输入与拖动双向同步', () => {
    const { onConfirm } = renderDialog()
    setField('X', '20')
    fireEvent.click(screen.getByRole('button', { name: '创建裁剪结果' }))
    expect(onConfirm).toHaveBeenCalledWith({ x: 20, y: 0, width: 100, height: 100 })
  })
})
```

- [ ] **Step 6: Run to confirm failure**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/crop-dialog.test.tsx --environment jsdom
```

Expected: FAIL (`crop-dialog.tsx` missing).

- [ ] **Step 7: Implement crop-dialog.tsx**

```tsx
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { Crop } from 'lucide-react'

import type { CanvasTheme } from './canvas-theme'
import { DialogAction, MediaDialogShell, NumberField } from './media-dialog-shell'
import { capturePointer, MediaStage, pointerToPercent, useImageNaturalSize, type NaturalSize } from './media-stage'
import {
  applyCropRatio,
  clampCropRect,
  CROP_HANDLES,
  dragCropRect,
  MIN_CROP_PERCENT,
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

type DragState =
  | { mode: 'move'; grabOffset: { x: number; y: number } }
  | { mode: 'resize'; handle: CropHandle }
  | { mode: 'draw'; anchor: { x: number; y: number }; previous: CropRect }

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
    return pointerToPercent({ x: event.clientX, y: event.clientY }, contentRect(event.currentTarget))
  }

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, drag: DragState): void => {
    event.preventDefault()
    event.stopPropagation()
    capturePointer(event)
    dragRef.current = drag
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    event.preventDefault()
    const pointer = percentFrom(event)
    if (drag.mode === 'move') {
      setCrop((current) => moveCropRect(current, pointer, drag.grabOffset))
      return
    }
    if (drag.mode === 'resize') {
      setCrop((current) =>
        resizeCropRect(current, drag.handle, pointer, {
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
    setCrop(dragCropRect(drag.anchor, pointer))
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    event.preventDefault()
    if (drag.mode === 'draw') {
      const next = dragCropRect(drag.anchor, percentFrom(event))
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

  const startResize = (handle: CropHandle) => (event: ReactPointerEvent<HTMLElement>): void => {
    beginDrag(event, { mode: 'resize', handle })
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
          <div className="absolute left-0 right-0 top-0 bg-black/50" style={{ height: `${crop.y}%` }} />
          <div className="absolute bottom-0 left-0 right-0 bg-black/50" style={{ top: `${crop.y + crop.height}%` }} />
          <div className="absolute bg-black/50" style={{ left: 0, top: `${crop.y}%`, width: `${crop.x}%`, height: `${crop.height}%` }} />
          <div className="absolute right-0 bg-black/50" style={{ top: `${crop.y}%`, left: `${crop.x + crop.width}%`, height: `${crop.height}%` }} />
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
    return {
      left: '50%',
      top: 'calc(100% - 5px)',
      transform: 'translateX(-50%) scaleX(2)',
      cursor
    }
  if (handle === 'w')
    return { left: '-5px', top: '50%', transform: 'translateY(-50%) scaleY(2)', cursor }
  return {
    left: 'calc(100% - 5px)',
    top: '50%',
    transform: 'translateY(-50%) scaleY(2)',
    cursor
  }
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
  const left = flipLeft
    ? loupe.displayX - LOUPE_OFFSET - LOUPE_SIZE
    : loupe.displayX + LOUPE_OFFSET
  const top = flipDown
    ? loupe.displayY + LOUPE_OFFSET
    : loupe.displayY - LOUPE_OFFSET - LOUPE_SIZE
  return (
    <div data-crop-loupe className="pointer-events-none absolute z-10" style={{ left, top }}>
      <div
        className="relative grid place-items-center overflow-hidden rounded-full border-2 bg-black/20 shadow-xl"
        style={{
          width: LOUPE_SIZE,
          height: LOUPE_SIZE,
          borderColor: theme.node.activeStroke,
          backgroundImage: `url(${source})`,
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
```

- [ ] **Step 8: Swap the old CropDialog for the new one in media-dialog.tsx**

In `media-dialog.tsx`:
1. Delete the whole `CropDialog` function (原 363-412 行，现因 Step 2 行号略有偏移).
2. Remove `Crop` from the lucide-react import.
3. Add re-export: `export { CropDialog } from './crop-dialog'`.

- [ ] **Step 9: Run crop dialog tests and the canvas suite**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/crop-dialog.test.tsx src/renderer/src/components/infinite-canvas --environment jsdom
```

Expected: PASS (crop-dialog 测试与全套件均通过).

- [ ] **Step 10: Commit**

```powershell
git add apps/desktop/src/renderer/src/components/infinite-canvas/media-stage.tsx apps/desktop/src/renderer/src/components/infinite-canvas/crop-dialog.tsx apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/media-stage.test.tsx apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/crop-dialog.test.tsx apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog.tsx
git commit -m "feat: add ps-style crop dialog with drag and loupe"
```

### Task 4: 拆分预览与可拖切割线

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/split-dialog.tsx`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/split-dialog.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx`

- [ ] **Step 1: Write the failing split dialog tests**

Create `__tests__/split-dialog.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SplitDialog } from '../split-dialog'
import type { CanvasTheme } from '../canvas-theme'

vi.mock('../media-stage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media-stage')>()
  return { ...actual, useImageNaturalSize: () => ({ width: 800, height: 600 }) }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const theme = {
  node: { panel: '#fff', fill: '#eee', text: '#111', muted: '#666', stroke: '#ddd', placeholder: '#999', activeStroke: '#2563eb' },
  toolbar: { panel: '#fff', border: '#ddd', border2: '#ccc', item: '#333', itemHover: '#eee', activeBg: '#111', activeText: '#fff' },
  canvas: { background: '#fafafa' },
  connection: { default: '#ccc', label: '#666' }
} as unknown as CanvasTheme

const stageRect = {
  left: 0,
  top: 0,
  width: 480,
  height: 360,
  right: 480,
  bottom: 360,
  x: 0,
  y: 0,
  toJSON: () => ({})
} as DOMRect

function renderDialog(): { onConfirm: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(stageRect)
  render(
    <SplitDialog theme={theme} source="data:image/png;base64,A" onClose={vi.fn()} onConfirm={onConfirm} />
  )
  return { onConfirm }
}

function drag(element: Element, points: Array<{ x: number; y: number }>): void {
  const last = points[points.length - 1]
  fireEvent.pointerDown(element, { pointerId: 1, clientX: points[0].x, clientY: points[0].y })
  for (const point of points.slice(1)) {
    fireEvent.pointerMove(element, { pointerId: 1, clientX: point.x, clientY: point.y })
  }
  fireEvent.pointerUp(element, { pointerId: 1, clientX: last.x, clientY: last.y })
}

describe('拆分对话框', () => {
  it('默认 2×2 均分确认', () => {
    const { onConfirm } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [50],
      columnCuts: [50]
    })
  })

  it('拖动列切割线改变位置并显示浮签', () => {
    const { onConfirm } = renderDialog()
    const line = document.querySelector('[data-cut="column"][data-cut-index="0"]')!
    fireEvent.pointerDown(line, { pointerId: 1, clientX: 240, clientY: 180 })
    fireEvent.pointerMove(line, { pointerId: 1, clientX: 120, clientY: 180 })
    expect(document.querySelector('[data-cut-label]')).not.toBeNull()
    expect(document.querySelector('[data-cut-label]')?.textContent).toContain('25%')
    fireEvent.pointerUp(line, { pointerId: 1, clientX: 120, clientY: 180 })
    expect(document.querySelector('[data-cut-label]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [50],
      columnCuts: [25]
    })
  })

  it('切割线钳制最小间距', () => {
    const { onConfirm } = renderDialog()
    drag(document.querySelector('[data-cut="column"][data-cut-index="0"]')!, [
      { x: 240, y: 180 },
      { x: 0, y: 180 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [50],
      columnCuts: [5]
    })
  })

  it('行数增加时在最大空隙中点插入切割线', () => {
    const { onConfirm } = renderDialog()
    fireEvent.change(screen.getByLabelText('行数'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '创建 6 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 3,
      columns: 2,
      rowCuts: [25, 50],
      columnCuts: [50]
    })
  })

  it('行数减少时移除最接近中间的切割线', () => {
    const { onConfirm } = renderDialog()
    fireEvent.change(screen.getByLabelText('行数'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('行数'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [25],
      columnCuts: [50]
    })
  })

  it('拖动行切割线改变位置', () => {
    const { onConfirm } = renderDialog()
    drag(document.querySelector('[data-cut="row"][data-cut-index="0"]')!, [
      { x: 240, y: 180 },
      { x: 240, y: 90 }
    ])
    fireEvent.click(screen.getByRole('button', { name: '创建 4 个图片节点' }))
    expect(onConfirm).toHaveBeenCalledWith({
      rows: 2,
      columns: 2,
      rowCuts: [25],
      columnCuts: [50]
    })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/split-dialog.test.tsx --environment jsdom
```

Expected: FAIL (`split-dialog.tsx` missing).

- [ ] **Step 3: Implement split-dialog.tsx**

```tsx
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { Grid2x2 } from 'lucide-react'

import type { CanvasTheme } from './canvas-theme'
import { DialogAction, MediaDialogShell, NumberField } from './media-dialog-shell'
import { capturePointer, MediaStage, pointerToPercent, useImageNaturalSize } from './media-stage'
import { adjustCutsToCount, moveCut, seedCuts } from './crop-split-interaction'

type CutAxis = 'row' | 'column'
type CutDrag = { axis: CutAxis; index: number }
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
  onConfirm: (params: { rows: number; columns: number; rowCuts: number[]; columnCuts: number[] }) => void
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
    return pointerToPercent({ x: event.clientX, y: event.clientY }, contentRect(event.currentTarget))
  }

  const startCutDrag = (axis: CutAxis, index: number) => (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    capturePointer(event)
    dragRef.current = { axis, index }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag) return
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
    if (!dragRef.current) return
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
                  ? { left: `${dragInfo.position}%`, top: 8 }
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
```

- [ ] **Step 4: Replace the old SplitDialog and extend splitDataUrls in media-dialog.tsx**

In `media-dialog.tsx`:
1. Delete the whole `SplitDialog` function and remove `Grid2x2` from the lucide-react import.
2. Add re-export: `export { SplitDialog } from './split-dialog'`.
3. Add import: `import { piecePixelBounds, seedCuts } from './crop-split-interaction'`.
4. Replace `splitDataUrls` with the non-uniform version:

```ts
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
        const yBounds = piecePixelBounds(params.rowCuts ?? seedCuts(params.rows), image.naturalHeight)
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
```

- [ ] **Step 5: Update the workspace split handler signature**

In `infinite-canvas-workspace.tsx` (约 1292 行), only change the params type:

```ts
  const splitImage = useCallback(
    async (
      source: LocalNode,
      params: { rows: number; columns: number; rowCuts: number[]; columnCuts: number[] }
    ): Promise<void> => {
```

The body stays exactly the same (`splitDataUrls(source.metadata.content, params)` 继续可用，因为新参数是超集)。

- [ ] **Step 6: Run the split tests and full canvas suite**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas --environment jsdom
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src/renderer/src/components/infinite-canvas/split-dialog.tsx apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/split-dialog.test.tsx apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog.tsx apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx
git commit -m "feat: add split dialog with draggable cut lines"
```

### Task 5: 全量回归验证

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the full canvas suite**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas --environment jsdom
```

Expected: all PASS (168 + 新增测试).

- [ ] **Step 2: Web typecheck**

Run:

```powershell
pnpm --filter desktop typecheck:web
```

Expected: exit code 0.

- [ ] **Step 3: ESLint on all touched files**

Run:

```powershell
pnpm exec eslint apps/desktop/src/renderer/src/components/infinite-canvas/crop-split-interaction.ts apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog-shell.tsx apps/desktop/src/renderer/src/components/infinite-canvas/media-stage.tsx apps/desktop/src/renderer/src/components/infinite-canvas/crop-dialog.tsx apps/desktop/src/renderer/src/components/infinite-canvas/split-dialog.tsx apps/desktop/src/renderer/src/components/infinite-canvas/media-dialog.tsx apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx
```

Expected: exit code 0.

- [ ] **Step 4: Inspect git status**

Run:

```powershell
git status --short
git log --oneline -6
```

Confirm: only the intended files were committed; user's untracked docs (`docs/new-api-video-generation.md`, `docs/new-api/`) remain untouched.

## Plan Self-Review

- Spec coverage: 裁剪拖动/手柄/压暗/三分线（Task 3）、放大镜（Task 3 Loupe）、比例预设（Task 3）、数字同步（Task 3 测试）、空白拖新框/误触恢复（Task 3）、拆分预览/拖线/浮签（Task 4）、行列智能增删与 5% 间距（Task 1+4）、非均匀切图与向后兼容（Task 4）、外壳抽取与导入稳定（Task 2）均覆盖。
- Placeholder scan: 无 TBD/TODO；每个改动均有完整代码与命令。
- Type consistency: `CropRect`/`CropHandle`/`NaturalSize`/`MIN_CUT_GAP`/`piecePixelBounds`/`seedCuts` 在 Task 1/3/4 中签名一致；`SplitDialog.onConfirm` 与 workspace `splitImage` 参数类型一致；`splitDataUrls` 新参数为可选超集。
- Scope: 无服务端/迁移改动；蒙版与放大对话框仅受外壳抽取影响（行为不变）。
