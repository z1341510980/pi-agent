# Infinite Canvas 设计画板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为无限画布新增 `design-board` 节点：节点显示画板缩略图，双击/工具栏打开全屏覆盖式设计编辑器（文本/图片/矩形、选择/拖动/缩放/吸附/撤销），图片素材来自画布图片节点，导出 PNG/JPG 生成图片节点。

**Architecture:** 双渲染器——编辑态对象用 DOM/SVG 渲染、交互覆盖层为 DOM（尺寸 ÷screenScale）；canvas 渲染器仅用于导出与节点缩略图。数据模型存节点 `metadata.design`，图片对象用 `{nodeId,index}` 引用画布图片节点（不内嵌 data URL）。交互引擎（吸附/手柄/等比）为纯函数模块。设计规格来源：`docs/superpowers/specs/2026-09-09-infinite-canvas-design-board-design.md`。

**Tech Stack:** React 19、TypeScript、Vitest + React Testing Library、jsdom、现有 `proxyExternalImageUrl` / `compressImageDataUrl` / `createNodeData` / `pushHistory` 基础设施。

---

## 文件边界

- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-types.ts` — 数据模型、默认值、钳制、解析
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-presets.ts` — 尺寸预设表
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-resources.ts` — 画布图片资源收集（纯函数）
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-interaction.ts` — 吸附/手柄/等比/坐标换算（纯函数）
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-renderer.ts` — canvas 渲染器 + 文本排版 + 图片加载缓存
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-export.ts` — 导出（compress 接线）
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-thumbnail.ts` — 节点缩略图（防抖 + LRU）
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-create-dialog.tsx` — 预设选择对话框
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-editor.tsx` — 全屏编辑器（对象视图/覆盖层/工具栏/资源面板/撤销）
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-*.test.ts(x)` — 各模块测试
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/geometry.ts` — NODE_SPECS 注册 design-board
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/batch-download.ts` — design-board → .json 映射
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/canvas-chrome.tsx` — NodeCreateMenu 加「设计画板」
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/canvas-node.tsx` — design-board 分支渲染缩略图 + 双击回调
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx` — 创建入口、编辑器打开/关闭写回、boardEditing 键盘门控、缩略图接线

---

### Task 1: 数据模型与预设

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-types.ts`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-presets.ts`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-types.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import {
  createDesignBoardDoc,
  createImageObject,
  createRectObject,
  createTextObject,
  parseDesignBoardDoc,
  resolveDesignImageSource,
  DESIGN_IMAGE_PLACEHOLDER
} from '../design-board-types'
import { findDesignBoardPreset, DESIGN_BOARD_PRESETS } from '../design-board-presets'

describe('design board document', () => {
  it('creates empty doc with clamped size and white background', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    expect(doc).toEqual({ version: 1, width: 1080, height: 1440, background: '#ffffff', objects: [] })
    expect(createDesignBoardDoc(50, 99999999).width).toBe(100)
    expect(createDesignBoardDoc(50, 99999999).height).toBe(16000)
  })

  it('creates objects with spec defaults', () => {
    const text = createTextObject(100, 100, 400)
    expect(text).toMatchObject({ kind: 'text', text: '', fontSize: 64, fontWeight: 400, align: 'left', color: '#171717', width: 400, height: 78 })
    const rect = createRectObject(0, 0, 200, 120)
    expect(rect).toMatchObject({ kind: 'rect', fill: '#262626', stroke: 'transparent', strokeWidth: 0, radius: 0 })
    const image = createImageObject({ kind: 'node-ref', nodeId: 'n1', index: 0 }, 0, 0, 300, 200)
    expect(image).toMatchObject({ kind: 'image', radius: 0 })
    expect(text.id).not.toBe(rect.id)
  })

  it('parses valid docs, drops invalid objects, clamps fields, blocks NaN', () => {
    const doc = createDesignBoardDoc(1080, 1440)
    doc.objects.push(createRectObject(10, 10, 100, 60))
    doc.objects.push({ ...createTextObject(0, 0, 200), fontSize: Number.NaN })
    const raw = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
    raw.objects.push({ kind: 'bogus' })
    raw.objects.push(null)
    const parsed = parseDesignBoardDoc(raw)
    expect(parsed?.objects).toHaveLength(2)
    expect(parsed?.objects[1]).toMatchObject({ fontSize: 64 })
  })

  it('rejects non-doc payloads', () => {
    expect(parseDesignBoardDoc(null)).toBeNull()
    expect(parseDesignBoardDoc({})).toBeNull()
    expect(parseDesignBoardDoc({ version: 1, width: 'a', height: 100, objects: [] })).toBeNull()
  })

  it('resolves node-ref sources against canvas nodes with placeholder fallback', () => {
    const nodes: CanvasNodeData[] = [
      {
        id: 'n1', type: 'image', title: '图', position: { x: 0, y: 0 }, width: 10, height: 10,
        metadata: { content: 'data:image/png;base64,AAA', images: ['data:image/png;base64,BBB', { id: 'x', content: 'data:image/png;base64,CCC', status: 'success' }] }
      }
    ]
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n1', index: 0 }, nodes)).toBe('data:image/png;base64,AAA')
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'n1', index: 2 }, nodes)).toBe(DESIGN_IMAGE_PLACEHOLDER)
    expect(resolveDesignImageSource({ kind: 'node-ref', nodeId: 'gone', index: 0 }, nodes)).toBe(DESIGN_IMAGE_PLACEHOLDER)
    expect(resolveDesignImageSource({ kind: 'url', url: 'https://x/y.png' }, nodes)).toBe('https://x/y.png')
  })
})

describe('design board presets', () => {
  it('offers categorized presets and finds by id', () => {
    expect(DESIGN_BOARD_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(findDesignBoardPreset('xhs-portrait')).toMatchObject({ width: 1080, height: 1440 })
    expect(findDesignBoardPreset('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-types.test.ts --environment jsdom`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `design-board-types.ts`**

```ts
import { canvasGeneratedImageContent } from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

export const DESIGN_BOARD_DOC_VERSION = 1
export const DESIGN_IMAGE_PLACEHOLDER = 'design-board:placeholder'

const SYSTEM_FONT_STACK = `system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`

export function designBoardFontFamily(): string {
  return SYSTEM_FONT_STACK
}

export type DesignBoardTextAlign = 'left' | 'center' | 'right'

interface DesignBoardBase {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface DesignBoardTextObject extends DesignBoardBase {
  kind: 'text'
  text: string
  fontSize: number
  fontWeight: number
  align: DesignBoardTextAlign
  color: string
}

export interface DesignBoardImageObject extends DesignBoardBase {
  kind: 'image'
  source: DesignImageSource
  radius: number
}

export interface DesignBoardRectObject extends DesignBoardBase {
  kind: 'rect'
  fill: string
  stroke: string
  strokeWidth: number
  radius: number
}

export type DesignImageSource =
  | { kind: 'node-ref'; nodeId: string; index: number }
  | { kind: 'url'; url: string }
  | { kind: 'data'; dataUrl: string }

export type DesignBoardObject = DesignBoardTextObject | DesignBoardImageObject | DesignBoardRectObject

export interface DesignBoardDoc {
  version: typeof DESIGN_BOARD_DOC_VERSION
  width: number
  height: number
  background: string
  objects: DesignBoardObject[]
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `dbo-${Math.random().toString(36).slice(2)}`
}

export function createDesignBoardDoc(width: number, height: number): DesignBoardDoc {
  return {
    version: DESIGN_BOARD_DOC_VERSION,
    width: clampInt(width, 100, 16000, 1080),
    height: clampInt(height, 100, 16000, 1440),
    background: '#ffffff',
    objects: []
  }
}

export function createTextObject(x: number, y: number, width: number): DesignBoardTextObject {
  const fontSize = 64
  return {
    id: makeId(), kind: 'text', x, y, width, height: Math.round(fontSize * 1.22),
    text: '', fontSize, fontWeight: 400, align: 'left', color: '#171717'
  }
}

export function createRectObject(x: number, y: number, width: number, height: number): DesignBoardRectObject {
  return { id: makeId(), kind: 'rect', x, y, width, height, fill: '#262626', stroke: 'transparent', strokeWidth: 0, radius: 0 }
}

export function createImageObject(source: DesignImageSource, x: number, y: number, width: number, height: number): DesignBoardImageObject {
  return { id: makeId(), kind: 'image', x, y, width, height, source, radius: 0 }
}

function parseBase(raw: Record<string, unknown>): DesignBoardBase | null {
  const x = clampNumber(Number(raw.x), -100000, 100000, 0)
  const y = clampNumber(Number(raw.y), -100000, 100000, 0)
  const width = clampInt(Number(raw.width), 1, 16000, 1)
  const height = clampInt(Number(raw.height), 1, 16000, 1)
  const id = typeof raw.id === 'string' && raw.id ? raw.id : makeId()
  return { id, x, y, width, height }
}

function parseImageSource(raw: unknown): DesignImageSource | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.kind === 'node-ref' && typeof value.nodeId === 'string' && Number.isInteger(value.index) && (value.index as number) >= 0) {
    return { kind: 'node-ref', nodeId: value.nodeId, index: value.index as number }
  }
  if (value.kind === 'url' && typeof value.url === 'string' && value.url) return { kind: 'url', url: value.url }
  if (value.kind === 'data' && typeof value.dataUrl === 'string' && value.dataUrl.startsWith('data:')) {
    return { kind: 'data', dataUrl: value.dataUrl }
  }
  return null
}

function parseObject(raw: unknown): DesignBoardObject | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const base = parseBase(value)
  if (!base) return null
  if (value.kind === 'text') {
    return {
      ...base, kind: 'text',
      text: typeof value.text === 'string' ? value.text : '',
      fontSize: clampInt(Number(value.fontSize), 8, 512, 64),
      fontWeight: clampInt(Number(value.fontWeight), 100, 900, 400),
      align: value.align === 'center' || value.align === 'right' ? value.align : 'left',
      color: typeof value.color === 'string' && value.color ? value.color : '#171717'
    }
  }
  if (value.kind === 'image') {
    const source = parseImageSource(value.source)
    if (!source) return null
    return { ...base, kind: 'image', source, radius: clampInt(Number(value.radius), 0, 16000, 0) }
  }
  if (value.kind === 'rect') {
    return {
      ...base, kind: 'rect',
      fill: typeof value.fill === 'string' && value.fill ? value.fill : '#262626',
      stroke: typeof value.stroke === 'string' && value.stroke ? value.stroke : 'transparent',
      strokeWidth: clampNumber(Number(value.strokeWidth), 0, 1600, 0),
      radius: clampInt(Number(value.radius), 0, 16000, 0)
    }
  }
  return null
}

export function parseDesignBoardDoc(raw: unknown): DesignBoardDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.version !== DESIGN_BOARD_DOC_VERSION) return null
  if (typeof value.width !== 'number' || typeof value.height !== 'number') return null
  if (!Array.isArray(value.objects)) return null
  const objects = value.objects
    .map((item) => parseObject(item))
    .filter((item): item is DesignBoardObject => item !== null)
  return {
    version: DESIGN_BOARD_DOC_VERSION,
    width: clampInt(value.width, 100, 16000, 1080),
    height: clampInt(value.height, 100, 16000, 1440),
    background: typeof value.background === 'string' && value.background ? value.background : '#ffffff',
    objects
  }
}

export function cloneDesignBoardDoc(doc: DesignBoardDoc): DesignBoardDoc {
  return JSON.parse(JSON.stringify(doc)) as DesignBoardDoc
}

export function resolveDesignImageSource(source: DesignImageSource, nodes: CanvasNodeData[]): string {
  if (source.kind === 'url') return source.url
  if (source.kind === 'data') return source.dataUrl
  const node = nodes.find((item) => item.id === source.nodeId)
  if (!node) return DESIGN_IMAGE_PLACEHOLDER
  if (source.index === 0 && typeof node.metadata?.content === 'string' && node.metadata.content) {
    return node.metadata.content
  }
  const images = Array.isArray(node.metadata?.images) ? node.metadata.images : []
  const entry = images[source.index]
  if (entry === undefined && source.index === 0) return DESIGN_IMAGE_PLACEHOLDER
  const content = entry === undefined ? undefined : canvasGeneratedImageContent(entry)
  return typeof content === 'string' && content ? content : DESIGN_IMAGE_PLACEHOLDER
}
```

- [ ] **Step 4: 实现 `design-board-presets.ts`**

```ts
export type DesignBoardPresetCategory = 'social' | 'general' | 'print' | 'custom'

export interface DesignBoardPreset {
  id: string
  label: string
  category: Exclude<DesignBoardPresetCategory, 'custom'>
  width: number
  height: number
}

export const DESIGN_BOARD_PRESETS: readonly DesignBoardPreset[] = [
  { id: 'xhs-portrait', label: '小红书竖图 3:4', category: 'social', width: 1080, height: 1440 },
  { id: 'xhs-square', label: '小红书方图 1:1', category: 'social', width: 1080, height: 1080 },
  { id: 'vertical-video', label: '抖音/竖屏视频 9:16', category: 'social', width: 1080, height: 1920 },
  { id: 'wechat-cover', label: '公众号首图', category: 'social', width: 900, height: 383 },
  { id: 'x-post', label: 'X/横版帖子', category: 'social', width: 1200, height: 675 },
  { id: 'video-cover', label: '横版视频封面 16:9', category: 'general', width: 1280, height: 720 },
  { id: 'hd', label: 'HD 16:9', category: 'general', width: 1920, height: 1080 },
  { id: 'a4-poster', label: 'A4 海报 @300dpi', category: 'print', width: 2480, height: 3508 }
] as const

export const DEFAULT_DESIGN_BOARD_PRESET_ID = 'xhs-portrait'

export function findDesignBoardPreset(id: string): DesignBoardPreset | undefined {
  return DESIGN_BOARD_PRESETS.find((preset) => preset.id === id)
}
```

- [ ] **Step 5: 运行测试通过并提交**

Run: 同 Step 2。Expected: PASS

```powershell
git add apps/desktop/src/renderer/src/components/infinite-canvas/design-board
git commit -m "feat: add design board data model and presets"
```

---

### Task 2: 画布资源收集

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-resources.ts`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-resources.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { collectCanvasImageResources } from '../design-board-resources'

const imageNode = (id: string, content: string, images: unknown[] = []): CanvasNodeData => ({
  id, type: 'image', title: `节点${id}`, position: { x: 0, y: 0 }, width: 10, height: 10,
  metadata: { content, images }
})

describe('collectCanvasImageResources', () => {
  it('collects content and images entries from image nodes only', () => {
    const nodes = [
      imageNode('a', 'data:1', ['data:2', { id: 'x', content: 'data:3', status: 'success' }]),
      { ...imageNode('b', 'data:4'), type: 'text' as const }
    ]
    const resources = collectCanvasImageResources(nodes)
    expect(resources.map((r) => `${r.nodeId}:${r.index}`)).toEqual(['a:0', 'a:1', 'a:2'])
  })

  it('skips empty entries and dedupes by url', () => {
    const nodes = [imageNode('a', 'data:1', ['', 'data:1'])]
    expect(collectCanvasImageResources(nodes)).toHaveLength(1)
  })

  it('exposes title and resolved url for each resource', () => {
    const resources = collectCanvasImageResources([imageNode('a', 'https://ext/img.png')])
    expect(resources[0]).toMatchObject({ nodeId: 'a', index: 0, title: '节点a', url: 'https://ext/img.png' })
  })
})
```

- [ ] **Step 2: 运行确认失败**（同上模式）

- [ ] **Step 3: 实现**

```ts
import { canvasGeneratedImageContent } from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

export interface DesignBoardResource {
  id: string
  nodeId: string
  index: number
  title: string
  url: string
}

export function collectCanvasImageResources(nodes: CanvasNodeData[]): DesignBoardResource[] {
  const seen = new Set<string>()
  const resources: DesignBoardResource[] = []
  for (const node of nodes) {
    if (node.type !== 'image') continue
    const entries: Array<{ index: number; url: string }> = []
    const content = node.metadata?.content
    if (typeof content === 'string' && content) entries.push({ index: 0, url: content })
    const images = Array.isArray(node.metadata?.images) ? node.metadata.images : []
    images.forEach((entry, index) => {
      const url = typeof entry === 'string' ? entry : canvasGeneratedImageContent(entry)
      if (typeof url === 'string' && url) entries.push({ index, url })
    })
    for (const entry of entries) {
      if (seen.has(entry.url)) continue
      seen.add(entry.url)
      resources.push({ id: `${node.id}:${entry.index}`, nodeId: node.id, index: entry.index, title: node.title, url: entry.url })
    }
  }
  return resources
}
```

- [ ] **Step 4: 运行通过并提交**（`feat: add design board canvas resource collector`）

---

### Task 3: 交互引擎纯函数

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-interaction.ts`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-interaction.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import type { DesignBoardObject } from '../design-board-types'
import {
  oppositeHandle,
  pointerToScene,
  resizeBoxWithHandle,
  snapThresholdFor,
  solveSnapDelta
} from '../design-board-interaction'

const obj = (x: number, y: number, width: number, height: number): DesignBoardObject => ({
  id: `o${x}`, kind: 'rect', x, y, width, height, fill: '#000', stroke: 'transparent', strokeWidth: 0, radius: 0
})

describe('pointerToScene', () => {
  it('converts client to scene coordinates and clamps inside the board', () => {
    const rect = { left: 100, top: 50, width: 540, height: 720 } as DOMRect
    expect(pointerToScene(190, 230, rect, 0.5, 1080, 1440)).toEqual({ x: 180, y: 360 })
    expect(pointerToScene(10, 10, rect, 0.5, 1080, 1440)).toEqual({ x: 0, y: 0 })
    expect(pointerToScene(9999, 9999, rect, 0.5, 1080, 1440)).toEqual({ x: 1080, y: 1440 })
  })
})

describe('snap', () => {
  it('computes threshold from board size', () => {
    expect(snapThresholdFor(1080, 1440)).toBe(8)
    expect(snapThresholdFor(4000, 4000)).toBe(10)
  })

  it('snaps moving edge to target edge within threshold', () => {
    const result = solveSnapDelta(
      { left: 103, top: 10, right: 203, bottom: 110 },
      [obj(300, 0, 100, 50)],
      1080, 1440, null
    )
    expect(result.dx).toBe(-3)
    expect(result.guideX).toBe(300)
    expect(result.guideY).toBeNull()
  })

  it('returns zero delta beyond threshold and prefers board center', () => {
    const far = solveSnapDelta({ left: 400, top: 400, right: 500, bottom: 500 }, [obj(0, 0, 100, 100)], 1080, 1440, null)
    expect(far.dx).toBe(0)
    const center = solveSnapDelta({ left: 541, top: 0, right: 641, bottom: 100 }, [], 1080, 1440, null)
    expect(center.dx).toBe(-1)
    expect(center.guideX).toBe(540)
  })

  it('keeps previous guide when within sticky window', () => {
    const first = solveSnapDelta({ left: 103, top: 0, right: 203, bottom: 100 }, [obj(300, 0, 100, 100)], 1080, 1440, null)
    const next = solveSnapDelta({ left: 100, top: 0, right: 200, bottom: 100 }, [obj(300, 0, 100, 100)], 1080, 1440, first.guideX)
    expect(next.dx).toBe(0)
    expect(next.guideX).toBe(300)
  })
})

describe('resize', () => {
  it('maps handles to opposite anchors', () => {
    expect(oppositeHandle('nw')).toBe('se')
    expect(oppositeHandle('e')).toBe('w')
  })

  it('resizes from se corner keeping top-left anchor', () => {
    const box = resizeBoxWithHandle({ x: 100, y: 100, width: 200, height: 100 }, 'se', { x: 200, y: 200 }, { keepRatio: false })
    expect(box).toEqual({ x: 100, y: 100, width: 100, height: 100 })
  })

  it('enforces 12px minimum and keep-ratio on corners', () => {
    const tiny = resizeBoxWithHandle({ x: 0, y: 0, width: 200, height: 100 }, 'se', { x: 2, y: 2 }, { keepRatio: false })
    expect(tiny.width).toBe(12)
    const ratio = resizeBoxWithHandle({ x: 0, y: 0, width: 200, height: 100 }, 'se', { x: 200, y: 300 }, { keepRatio: true })
    expect(Math.abs(ratio.width / ratio.height - 2)).toBeLessThan(0.01)
  })

  it('resizes symmetrically around center when centered', () => {
    const box = resizeBoxWithHandle({ x: 100, y: 100, width: 200, height: 100 }, 'e', { x: 300, y: 150 }, { keepRatio: false, centered: true })
    expect(box).toEqual({ x: 100, y: 100, width: 400, height: 100 })
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { DesignBoardObject } from './design-board-types'

export type ResizeHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const RESIZE_HANDLE_IDS: ResizeHandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const OPPOSITE: Record<ResizeHandleId, ResizeHandleId> = {
  nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e'
}

export function oppositeHandle(handle: ResizeHandleId): ResizeHandleId {
  return OPPOSITE[handle]
}

export function cursorForHandle(handle: ResizeHandleId): string {
  if (handle === 'n' || handle === 's') return 'ns-resize'
  if (handle === 'e' || handle === 'w') return 'ew-resize'
  if (handle === 'nw' || handle === 'se') return 'nwse-resize'
  return 'nesw-resize'
}

export function pointerToScene(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  scale: number,
  boardWidth: number,
  boardHeight: number
): { x: number; y: number } {
  const safeScale = scale > 0.01 ? scale : 0.01
  const x = (clientX - rect.left) / safeScale
  const y = (clientY - rect.top) / safeScale
  return {
    x: Math.max(0, Math.min(boardWidth, x)),
    y: Math.max(0, Math.min(boardHeight, y))
  }
}

// ── 吸附 ──

export function snapThresholdFor(boardWidth: number, boardHeight: number): number {
  return Math.max(8, Math.round(Math.min(boardWidth, boardHeight) * 0.0025))
}

const SNAP_DEADBAND = 0.25
const SNAP_STICKY_WINDOW = 0.5

interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

function objectBounds(object: DesignBoardObject): Bounds {
  return { left: object.x, top: object.y, right: object.x + object.width, bottom: object.y + object.height }
}

export interface SnapResult {
  dx: number
  dy: number
  guideX: number | null
  guideY: number | null
}

export function solveSnapDelta(
  moving: Bounds,
  targets: DesignBoardObject[],
  boardWidth: number,
  boardHeight: number,
  prevGuideX: number | null
): SnapResult {
  const threshold = snapThresholdFor(boardWidth, boardHeight)
  const movingXs = [moving.left, (moving.left + moving.right) / 2, moving.right]
  const movingYs = [moving.top, (moving.top + moving.bottom) / 2, moving.bottom]
  const targetXs: number[] = [0, boardWidth / 2, boardWidth]
  const targetYs: number[] = [0, boardHeight / 2, boardHeight]
  for (const target of targets) {
    const bounds = objectBounds(target)
    targetXs.push(bounds.left, (bounds.left + bounds.right) / 2, bounds.right)
    targetYs.push(bounds.top, (bounds.top + bounds.bottom) / 2, bounds.bottom)
  }

  let bestX: { delta: number; guide: number } | null = null
  for (const my of movingXs) {
    for (const tx of targetXs) {
      const delta = tx - my
      if (Math.abs(delta) >= threshold) continue
      const sticky = prevGuideX !== null && Math.abs(tx - prevGuideX) < SNAP_STICKY_WINDOW
      const score = Math.abs(delta) - (sticky ? SNAP_STICKY_WINDOW : 0)
      if (!bestX || score < Math.abs(bestX.delta)) bestX = { delta, guide: tx }
    }
  }
  let bestY: { delta: number; guide: number } | null = null
  for (const my of movingYs) {
    for (const ty of targetYs) {
      const delta = ty - my
      if (Math.abs(delta) >= threshold) continue
      if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) bestY = { delta, guide: ty }
    }
  }
  return {
    dx: bestX && Math.abs(bestX.delta) >= SNAP_DEADBAND ? bestX.delta : 0,
    dy: bestY && Math.abs(bestY.delta) >= SNAP_DEADBAND ? bestY.delta : 0,
    guideX: bestX ? bestX.guide : null,
    guideY: bestY ? bestY.guide : null
  }
}

// ── 缩放 ──

const MIN_SIZE = 12

export function resizeBoxWithHandle(
  initial: { x: number; y: number; width: number; height: number },
  handle: ResizeHandleId,
  pointer: { x: number; y: number },
  options: { keepRatio: boolean; centered?: boolean }
): { x: number; y: number; width: number; height: number } {
  const anchorX = handle.includes('w') ? initial.x + initial.width : initial.x
  const anchorY = handle.includes('n') ? initial.y + initial.height : initial.y
  let width = handle === 'n' || handle === 's' ? initial.width : Math.abs(pointer.x - anchorX)
  let height = handle === 'e' || handle === 'w' ? initial.height : Math.abs(pointer.y - anchorY)
  if (options.keepRatio && handle !== 'n' && handle !== 's' && handle !== 'e' && handle !== 'w') {
    const initialRatio = initial.width / Math.max(1, initial.height)
    if (width / Math.max(1, height) > initialRatio) width = height * initialRatio
    else height = width / initialRatio
  }
  width = Math.max(MIN_SIZE, width)
  height = Math.max(MIN_SIZE, height)
  const xDir = handle.includes('w') ? -1 : 1
  const yDir = handle.includes('n') ? -1 : 1
  const centerX = initial.x + initial.width / 2
  const centerY = initial.y + initial.height / 2
  if (options.centered) {
    return { x: centerX - width / 2, y: centerY - height / 2, width, height }
  }
  const x = anchorX + (xDir < 0 ? -width : 0)
  const y = anchorY + (yDir < 0 ? -height : 0)
  return { x, y, width, height }
}
```

- [ ] **Step 4: 运行通过并提交**（`feat: add design board interaction engine`）

---

### Task 4: canvas 渲染器与文本排版

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-renderer.ts`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-renderer.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createRectObject, createTextObject, createDesignBoardDoc, DESIGN_IMAGE_PLACEHOLDER } from '../design-board-types'
import { layoutDesignText, renderDesignBoardToCanvas } from '../design-board-renderer'

function mockCtx() {
  const ctx = {
    fillRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(),
    roundRect: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), save: vi.fn(), restore: vi.fn(),
    clearRect: vi.fn(), drawImage: vi.fn(), clip: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    setTransform: vi.fn(), quadraticCurveTo: vi.fn(), ellipse: vi.fn(),
    setLineDash: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 10 })),
    set font(_value: string) { }, get font() { return '' }
  }
  return ctx as unknown as CanvasRenderingContext2D
}

describe('layoutDesignText', () => {
  it('splits explicit newlines and computes lineHeight from fontSize', () => {
    const layout = layoutDesignText({ ...createTextObject(0, 0, 400), text: 'a\nb' }, mockCtx())
    expect(layout.lines).toEqual(['a', 'b'])
    expect(layout.lineHeight).toBeCloseTo(64 * 1.22)
    expect(layout.height).toBeCloseTo(2 * 64 * 1.22)
  })

  it('wraps long single tokens at character level', () => {
    const layout = layoutDesignText({ ...createTextObject(0, 0, 25), text: 'abcdef' }, mockCtx())
    expect(layout.lines.length).toBeGreaterThanOrEqual(3)
    layout.lines.forEach((line) => expect(line.length).toBeGreaterThan(0))
  })
})

describe('renderDesignBoardToCanvas', () => {
  it('fills background then draws each object and resolves image sources', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(100, 100)
    doc.objects.push(createRectObject(0, 0, 50, 50))
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve('data:image/png;base64,AAA'))
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 100, 100)
    expect(ctx.fillRect).toHaveBeenCalled()
    expect(ctx.drawImage).toHaveBeenCalled()
  })

  it('draws nothing for placeholder sources without throwing', async () => {
    const ctx = mockCtx()
    const doc = createDesignBoardDoc(100, 100)
    doc.objects.push({
      id: 'i', kind: 'image', x: 0, y: 0, width: 50, height: 50,
      source: { kind: 'url', url: DESIGN_IMAGE_PLACEHOLDER }, radius: 0
    })
    await renderDesignBoardToCanvas(ctx, doc, () => Promise.resolve(DESIGN_IMAGE_PLACEHOLDER))
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { proxyExternalImageUrl } from '@/api/infinite-canvas-client'
import { DESIGN_IMAGE_PLACEHOLDER, designBoardFontFamily } from './design-board-types'
import type { DesignBoardDoc, DesignBoardImageObject, DesignBoardObject, DesignBoardTextObject } from './design-board-types'

export interface DesignTextLayout {
  lines: string[]
  lineHeight: number
  height: number
}

const FALLBACK_LINE_HEIGHT = 1.22

function textLineHeight(): number {
  return FALLBACK_LINE_HEIGHT
}

function setFont(ctx: CanvasRenderingContext2D, object: DesignBoardTextObject): void {
  ctx.font = `${object.fontWeight} ${object.fontSize}px ${designBoardFontFamily()}`
}

export function measureDesignTextLine(ctx: CanvasRenderingContext2D, line: string): number {
  if (!line) return 0
  return ctx.measureText(line).width
}

export function layoutDesignText(object: DesignBoardTextObject, ctx: CanvasRenderingContext2D): DesignTextLayout {
  setFont(ctx, object)
  const lineHeight = object.fontSize * textLineHeight()
  const maxWidth = Math.max(8, object.width)
  const paragraphs = object.text.split(/\r?\n/)
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    const tokens = paragraph.split(/(\s+)/).filter((token) => token.length > 0)
    let current = ''
    for (const token of tokens) {
      const candidate = current + token
      if (measureDesignTextLine(ctx, candidate) <= maxWidth) {
        current = candidate
        continue
      }
      if (current) lines.push(current.trimEnd())
      let remaining = token.trimStart()
      current = ''
      while (measureDesignTextLine(ctx, remaining) > maxWidth && remaining.length > 1) {
        let cut = 1
        while (cut < remaining.length && measureDesignTextLine(ctx, Array.from(remaining).slice(0, cut + 1).join('')) <= maxWidth) {
          cut += 1
        }
        lines.push(Array.from(remaining).slice(0, cut).join(''))
        remaining = Array.from(remaining).slice(cut).join('')
      }
      current = remaining
    }
    lines.push(current)
  }
  return { lines, lineHeight, height: Math.max(lineHeight, lines.length * lineHeight) }
}

export function designTextBaselineOffset(ctx: CanvasRenderingContext2D, fontSize: number, lineHeight: number): number {
  const metrics = ctx.measureText('Mg')
  const ascent =
    metrics.fontBoundingBoxAscent ?? (metrics as { actualBoundingBoxAscent?: number }).actualBoundingBoxAscent ?? fontSize * 0.8
  const descent =
    metrics.fontBoundingBoxDescent ?? (metrics as { actualBoundingBoxDescent?: number }).actualBoundingBoxDescent ?? fontSize * 0.2
  const fontBox = Math.max(1, ascent + descent)
  return (lineHeight - fontBox) / 2 + ascent
}

const imageElementCache = new Map<string, Promise<HTMLImageElement | null>>()

export function loadDesignImageElement(rawUrl: string): Promise<HTMLImageElement | null> {
  if (rawUrl === DESIGN_IMAGE_PLACEHOLDER) return Promise.resolve(null)
  const safeUrl = proxyExternalImageUrl(rawUrl)
  const cached = imageElementCache.get(safeUrl)
  if (cached) return cached
  const task = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    if (!safeUrl.startsWith('data:') && !safeUrl.startsWith('blob:')) image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = safeUrl
  })
  imageElementCache.set(safeUrl, task)
  void task.then((element) => {
    if (!element) imageElementCache.delete(safeUrl)
  })
  return task
}

function roundedRectPath(ctx: CanvasRenderingContext2D, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2))
  ctx.beginPath()
  if ('roundRect' in ctx) {
    ctx.roundRect(0, 0, width, height, r)
    return
  }
  ctx.moveTo(r, 0)
  ctx.lineTo(width - r, 0)
  ctx.quadraticCurveTo(width, 0, width, r)
  ctx.lineTo(width, height - r)
  ctx.quadraticCurveTo(width, height, width - r, height)
  ctx.lineTo(r, height)
  ctx.quadraticCurveTo(0, height, 0, height - r)
  ctx.lineTo(0, r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.closePath()
}

function drawRect(ctx: CanvasRenderingContext2D, object: Extract<DesignBoardObject, { kind: 'rect' }>): void {
  roundedRectPath(ctx, object.width, object.height, object.radius)
  ctx.fillStyle = object.fill
  ctx.fill()
  if (object.strokeWidth > 0) {
    ctx.strokeStyle = object.stroke
    ctx.lineWidth = object.strokeWidth
    ctx.stroke()
  }
}

async function drawImage(
  ctx: CanvasRenderingContext2D,
  object: DesignBoardImageObject,
  resolveImage: (url: string) => Promise<string>
): Promise<void> {
  const url = object.source.kind === 'url' ? object.source.url : object.source.kind === 'data' ? object.source.dataUrl : DESIGN_IMAGE_PLACEHOLDER
  const resolved = object.source.kind === 'node-ref' ? await resolveImage(DESIGN_IMAGE_PLACEHOLDER) : url
  const raw = object.source.kind === 'node-ref' ? await resolveImageNodeRef(object, resolveImage) : resolved
  if (!raw || raw === DESIGN_IMAGE_PLACEHOLDER) return
  const element = await loadDesignImageElement(raw)
  if (!element) return
  ctx.save()
  roundedRectPath(ctx, object.width, object.height, object.radius)
  ctx.clip()
  ctx.drawImage(element, 0, 0, object.width, object.height)
  ctx.restore()
}

async function resolveImageNodeRef(
  object: DesignBoardImageObject,
  resolveImage: (url: string) => Promise<string>
): Promise<string> {
  return resolveImage(object.source.kind === 'node-ref' ? `${object.source.nodeId}:${object.source.index}` : '')
}

function drawText(ctx: CanvasRenderingContext2D, object: DesignBoardTextObject): void {
  setFont(ctx, object)
  const layout = layoutDesignText(object, ctx)
  const baseline = designTextBaselineOffset(ctx, object.fontSize, layout.lineHeight)
  const anchorX = object.align === 'center' ? object.width / 2 : object.align === 'right' ? object.width : 0
  const anchorMode = object.align === 'center' ? 'center' : object.align === 'right' ? 'right' : 'left'
  ctx.fillStyle = object.color
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  layout.lines.forEach((line, index) => {
    const y = index * layout.lineHeight + baseline
    const width = measureDesignTextLine(ctx, line)
    const startX = anchorMode === 'center' ? anchorX - width / 2 : anchorMode === 'right' ? anchorX - width : 0
    ctx.fillText(line, startX, y)
  })
}

export async function renderDesignBoardToCanvas(
  ctx: CanvasRenderingContext2D,
  doc: DesignBoardDoc,
  resolveImage: (ref: string) => Promise<string>
): Promise<void> {
  ctx.clearRect(0, 0, doc.width, doc.height)
  ctx.fillStyle = doc.background
  ctx.fillRect(0, 0, doc.width, doc.height)
  for (const object of doc.objects) {
    ctx.save()
    ctx.translate(object.x + object.width / 2, object.y + object.height / 2)
    ctx.translate(-object.width / 2, -object.height / 2)
    if (object.kind === 'rect') drawRect(ctx, object)
    else if (object.kind === 'text') drawText(ctx, object)
    else await drawImage(ctx, object, (ref) => resolveImage(ref))
    ctx.restore()
  }
}
```

注意：`drawImage` 中 node-ref 的解析签名简化为 `resolveImage(ref: string)`，由调用方（导出/编辑器/缩略图）闭包持有 nodes 并完成 `${nodeId}:${index}` → URL 的转换（复用 `resolveDesignImageSource`）。测试里 mock 该闭包即可。实现时保持该约定并把无占位分支收敛清楚，消除上面伪代码中的 `resolveImageNodeRef` 冗余调用。

- [ ] **Step 4: 运行通过并提交**（`feat: add design board canvas renderer`）

---

### Task 5: 导出与缩略图

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-export.ts`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-thumbnail.ts`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-export.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createDesignBoardDoc, createRectObject } from '../design-board-types'
import { exportDesignBoardImage } from '../design-board-export'
import { getDesignBoardThumbnail } from '../design-board-thumbnail'

vi.mock('../design-board-renderer', async (importOriginal) => {
  const original = await importOriginal<typeof import('../design-board-renderer')>()
  return { ...original, renderDesignBoardToCanvas: vi.fn(async (ctx: CanvasRenderingContext2D, doc: import('../design-board-types').DesignBoardDoc) => {
    ctx.fillRect(0, 0, doc.width, doc.height)
  }) }
})

describe('exportDesignBoardImage', () => {
  it('renders at multiplier and returns data url with dimensions', async () => {
    const doc = createDesignBoardDoc(100, 200)
    doc.objects.push(createRectObject(0, 0, 10, 10))
    const result = await exportDesignBoardImage(doc, [], { format: 'png', multiplier: 2 })
    expect(result).toMatchObject({ width: 200, height: 400 })
    expect(result.dataUrl.startsWith('data:image/png')).toBe(true)
  })

  it('uses image/jpeg mime for jpg format', async () => {
    const result = await exportDesignBoardImage(createDesignBoardDoc(50, 50), [], { format: 'jpg' })
    expect(result.dataUrl.startsWith('data:image/jpeg')).toBe(true)
  })
})

describe('getDesignBoardThumbnail', () => {
  it('caches by node id and updatedAt', async () => {
    const node = {
      id: 'board1', type: 'design-board', title: '画板', position: { x: 0, y: 0 }, width: 340, height: 240,
      metadata: { design: createDesignBoardDoc(100, 100), updatedAt: 1 }
    }
    const first = await getDesignBoardThumbnail(node, [])
    const second = await getDesignBoardThumbnail(node, [])
    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 `design-board-export.ts`**

```ts
import { compressImageDataUrl } from '../graph-persistence'
import { renderDesignBoardToCanvas } from './design-board-renderer'
import { resolveDesignImageSource } from './design-board-types'
import type { DesignBoardDoc, DesignImageSource } from './design-board-types'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

export interface DesignBoardExportOptions {
  format: 'png' | 'jpg'
  multiplier?: number
}

export interface DesignBoardExportResult {
  dataUrl: string
  width: number
  height: number
}

export async function exportDesignBoardImage(
  doc: DesignBoardDoc,
  nodes: CanvasNodeData[],
  options: DesignBoardExportOptions
): Promise<DesignBoardExportResult> {
  const multiplier = Math.max(1, Math.round(options.multiplier ?? 1))
  const width = Math.max(1, Math.round(doc.width * multiplier))
  const height = Math.max(1, Math.round(doc.height * multiplier))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建导出画布')
  ctx.setTransform(multiplier, 0, 0, multiplier, 0, 0)
  await renderDesignBoardToCanvas(ctx, doc, async (ref) => {
    const [nodeId, indexRaw] = ref.split(':')
    const source: DesignImageSource = { kind: 'node-ref', nodeId, index: Number(indexRaw) || 0 }
    return resolveDesignImageSource(source, nodes)
  })
  const mime = options.format === 'jpg' ? 'image/jpeg' : 'image/png'
  let dataUrl = canvas.toDataURL(mime)
  dataUrl = await compressImageDataUrl(dataUrl)
  return { dataUrl, width, height }
}
```

- [ ] **Step 4: 实现 `design-board-thumbnail.ts`**

```ts
import { renderDesignBoardToCanvas } from './design-board-renderer'
import { parseDesignBoardDoc, resolveDesignImageSource } from './design-board-types'
import type { DesignBoardDoc, DesignImageSource } from './design-board-types'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

const THUMBNAIL_MAX_EDGE = 480
const CACHE_LIMIT = 48
const cache = new Map<string, string>()

export async function getDesignBoardThumbnail(node: CanvasNodeData, nodes: CanvasNodeData[]): Promise<string | null> {
  const doc = parseDesignBoardDoc(node.metadata?.design)
  if (!doc) return null
  const updatedAt = typeof node.metadata?.designUpdatedAt === 'number' ? node.metadata.designUpdatedAt : 0
  const key = `${node.id}:${doc.objects.length}:${doc.width}x${doc.height}:${updatedAt}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const longest = Math.max(doc.width, doc.height)
  const multiplier = Math.max(0.05, Math.min(1, THUMBNAIL_MAX_EDGE / longest))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(doc.width * multiplier))
  canvas.height = Math.max(1, Math.round(doc.height * multiplier))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(multiplier, 0, 0, multiplier, 0, 0)
  await renderDesignBoardToCanvas(ctx, doc, async (ref) => {
    const [nodeId, indexRaw] = ref.split(':')
    const source: DesignImageSource = { kind: 'node-ref', nodeId, index: Number(indexRaw) || 0 }
    return resolveDesignImageSource(source, nodes)
  })
  const dataUrl = canvas.toDataURL('image/png')
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, dataUrl)
  return dataUrl
}

export function invalidateDesignBoardThumbnail(nodeId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${nodeId}:`)) cache.delete(key)
  }
}

export type { DesignBoardDoc }
```

- [ ] **Step 5: 运行通过并提交**（`feat: add design board export and thumbnail`）

---

### Task 6: 节点注册与批量下载映射

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/geometry.ts`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/batch-download.ts`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/batch-download.test.ts`

- [ ] **Step 1: 写失败测试（batch-download 追加用例）**

```ts
it('exports design-board nodes as formatted json', () => {
  const design = { version: 1, width: 1080, height: 1440, background: '#ffffff', objects: [] }
  const items = collectBatchDownloadItems([
    node({ id: 'board', type: 'design-board', title: '画板', metadata: { design } })
  ])
  expect(items).toEqual([
    { baseName: '画板', kind: 'text', extension: '.json', content: JSON.stringify(design, null, 2) }
  ])
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 修改 `geometry.ts` NODE_SPECS**

在 `NODE_SPECS` 中 `group` 条目后追加：

```ts
design-board: { ...NODE_DEFAULT_SIZE.designBoard, metadata: { status: 'idle' } }
```

并在 `NODE_DEFAULT_SIZE` 中加入：

```ts
designBoard: { width: 340, height: 240, title: '设计画板' }
```

（key 名用 `designBoard` 避免与现有连字符 key 风格冲突时取值写法不一致；`NODE_SPECS` 的 key 保持 `'design-board'` 与节点 type 一致。）

- [ ] **Step 4: 修改 `batch-download.ts`**

在 `collectBatchDownloadItems` 的 config 分支后追加（保持现有 API 与行为不变）：

```ts
if (node.type === 'design-board') {
  const design = metadata.design
  if (design && typeof design === 'object') {
    items.push({ baseName, kind: 'text', extension: '.json', content: JSON.stringify(design, null, 2) })
  }
  continue
}
```

- [ ] **Step 5: 运行 batch-download 全部测试通过并提交**（`feat: register design-board node type and download mapping`）

---

### Task 7: 预设选择对话框与创建入口

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-create-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/canvas-chrome.tsx`（NodeCreateMenu 增加项）
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx`（createNode 分支）
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-create-dialog.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DesignBoardCreateDialog } from '../design-board-create-dialog'

describe('DesignBoardCreateDialog', () => {
  it('lists presets with dimensions and confirms selection', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<DesignBoardCreateDialog onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.getByText('小红书竖图 3:4')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /创建画板/ }))
    expect(onConfirm).toHaveBeenCalledWith({ width: 1080, height: 1440 })
  })

  it('supports custom dimensions with clamping', async () => {
    const onConfirm = vi.fn()
    render(<DesignBoardCreateDialog onConfirm={onConfirm} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('radio', { name: /自定义/ }))
    await userEvent.clear(screen.getByLabelText('宽'))
    await userEvent.type(screen.getByLabelText('宽'), '50')
    await userEvent.click(screen.getByRole('button', { name: /创建画板/ }))
    expect(onConfirm).toHaveBeenCalledWith({ width: 100, height: 100 })
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现对话框（遵循画布现有 dialog 风格：主题色 + `data-canvas-no-zoom`）**

```tsx
import { useState } from 'react'
import { useCanvasTheme } from '../canvas-theme'
import { Button } from '@/components/ui/button'
import { DESIGN_BOARD_PRESETS, DEFAULT_DESIGN_BOARD_PRESET_ID, findDesignBoardPreset } from './design-board-presets'

export interface DesignBoardCreateResult {
  width: number
  height: number
}

export function DesignBoardCreateDialog({
  onConfirm,
  onCancel
}: {
  onConfirm: (result: DesignBoardCreateResult) => void
  onCancel: () => void
}): React.ReactElement {
  const theme = useCanvasTheme()
  const [presetId, setPresetId] = useState(DEFAULT_DESIGN_BOARD_PRESET_ID)
  const [customWidth, setCustomWidth] = useState('1080')
  const [customHeight, setCustomHeight] = useState('1440')
  const isCustom = presetId === 'custom'
  const preset = findDesignBoardPreset(presetId)
  const confirm = (): void => {
    if (isCustom) {
      onConfirm({ width: clampSize(customWidth), height: clampSize(customHeight) })
      return
    }
    onConfirm({ width: preset?.width ?? 1080, height: preset?.height ?? 1440 })
  }
  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-black/40" data-canvas-no-zoom>
      <div className="w-[420px] rounded-xl border p-4 shadow-2xl" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
        <p className="mb-3 text-base font-semibold" style={{ color: theme.node.text }}>画板尺寸</p>
        <div className="mb-3 max-h-64 overflow-y-auto thin-scrollbar">
          {DESIGN_BOARD_PRESETS.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm" style={{ color: theme.node.text }}>
              <input type="radio" name="design-board-preset" checked={presetId === item.id} onChange={() => setPresetId(item.id)} className="accent-current" />
              <span className="flex-1">{item.label}</span>
              <span className="text-xs opacity-55">{item.width}×{item.height}</span>
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm" style={{ color: theme.node.text }}>
            <input type="radio" name="design-board-preset" checked={isCustom} onChange={() => setPresetId('custom')} className="accent-current" />
            <span className="flex-1">自定义</span>
          </label>
        </div>
        {isCustom && (
          <div className="mb-3 flex items-center gap-2 text-sm" style={{ color: theme.node.text }}>
            <input aria-label="宽" value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} className="w-24 rounded-md border px-2 py-1" style={{ borderColor: theme.toolbar.border, background: 'transparent', color: theme.node.text }} />
            ×
            <input aria-label="高" value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} className="w-24 rounded-md border px-2 py-1" style={{ borderColor: theme.toolbar.border, background: 'transparent', color: theme.node.text }} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button onClick={confirm}>创建画板</Button>
        </div>
      </div>
    </div>
  )
}

function clampSize(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return 1080
  return Math.max(100, Math.min(16000, parsed))
}
```

- [ ] **Step 4: NodeCreateMenu 增加入口（canvas-chrome.tsx）**

在 `NodeCreateMenu` 的类型列表（约 870 行 `NODE_CREATE_ITEMS` 一带，与 image/text 并列）追加：

```tsx
{ type: 'design-board', icon: <Frame className="size-5" />, title: '设计画板' }
```

（`lucide-react` 增加 `Frame` import；保持现有 list 结构与点击回调 `onCreate(type)` 不变。）

- [ ] **Step 5: workspace createNode 分支**

在 `infinite-canvas-workspace.tsx` 的 `createNode` 开头追加分支：

```ts
if (type === 'design-board') {
  setDesignBoardCreatePosition(position ?? canvasCenter())
  return
}
```

并新增 state：

```ts
const [designBoardCreatePosition, setDesignBoardCreatePosition] = useState<Position | null>(null)
```

渲染层（与其他 dialog 同级）：

```tsx
{designBoardCreatePosition && (
  <DesignBoardCreateDialog
    onConfirm={async ({ width, height }) => {
      const position = designBoardCreatePosition
      setDesignBoardCreatePosition(null)
      const doc = createDesignBoardDoc(width, height)
      const node = createNodeData('design-board', position, { design: doc, designUpdatedAt: Date.now() })
      node.title = `设计画板 ${width}×${height}`
      pushHistory()
      setNodes((current) => [...current, node])
      setDesignBoardEditorNodeId(node.id)
    }}
    onCancel={() => setDesignBoardCreatePosition(null)}
  />
)}
```

`createNodeData('design-board', …)` 的类型参数走 `CanvasNodeTypeId`（string 联合已放宽）；`NODE_SPECS` Task 6 已注册。

- [ ] **Step 6: 运行对话框测试通过并提交**（`feat: add design board preset dialog and creation entry`）

---

### Task 8: 全屏编辑器

**Files:**
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-editor.tsx`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-editor.test.tsx`

- [ ] **Step 1: 写失败测试（交互内核经组件冒烟 + 行为断言）**

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { createDesignBoardDoc, createRectObject } from '../design-board-types'
import { DesignBoardEditor } from '../design-board-editor'

const boardNode: CanvasNodeData = {
  id: 'board1', type: 'design-board', title: '画板', position: { x: 0, y: 0 }, width: 340, height: 240,
  metadata: { design: createDesignBoardDoc(1080, 1440) }
}

function setup(overrides: Partial<Parameters<typeof DesignBoardEditor>[0]> = {}) {
  const onCommit = vi.fn()
  const onClose = vi.fn()
  render(
    <DesignBoardEditor
      node={boardNode}
      nodes={[boardNode]}
      onCommit={onCommit}
      onClose={onClose}
      {...overrides}
    />
  )
  return { onCommit, onClose }
}

describe('DesignBoardEditor', () => {
  it('renders board title, tools and resources panel', () => {
    setup()
    expect(screen.getByRole('button', { name: '添加文本' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加矩形' })).toBeInTheDocument()
    expect(screen.getByText('画布资源')).toBeInTheDocument()
    expect(screen.getByText(/1080×1440/)).toBeInTheDocument()
  })

  it('adds a text object centered on the board and commits on close', async () => {
    const { onCommit } = setup()
    await userEvent.click(screen.getByRole('button', { name: '添加文本' }))
    await userEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as ReturnType<typeof createDesignBoardDoc>
    expect(doc.objects).toHaveLength(1)
    expect(doc.objects[0]).toMatchObject({ kind: 'text', fontSize: 64 })
    expect(doc.objects[0].x).toBeGreaterThan(0)
  })

  it('restores selection-free state and supports undo of creation', async () => {
    const { onCommit } = setup()
    await userEvent.click(screen.getByRole('button', { name: '添加矩形' }))
    await userEvent.click(screen.getByRole('button', { name: '撤销' }))
    await userEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as ReturnType<typeof createDesignBoardDoc>
    expect(doc.objects).toHaveLength(0)
  })

  it('shows empty-resources hint when canvas has no image nodes', async () => {
    setup()
    expect(await screen.findByText('画布上暂无图片资源')).toBeInTheDocument()
  })

  it('inserts image object from resource panel', async () => {
    const imageNode: CanvasNodeData = {
      id: 'img1', type: 'image', title: '素材', position: { x: 0, y: 0 }, width: 10, height: 10,
      metadata: { content: 'data:image/png;base64,AAA' }
    }
    const { onCommit } = setup({ nodes: [boardNode, imageNode] })
    await userEvent.click(await screen.findByRole('button', { name: /素材/ }))
    await userEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    const doc = onCommit.mock.calls[0][0] as ReturnType<typeof createDesignBoardDoc>
    expect(doc.objects[0]).toMatchObject({ kind: 'image', source: { kind: 'node-ref', nodeId: 'img1', index: 0 } })
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现编辑器（完整组件，DOM 对象视图 + 交互引擎接线）**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { Frame, Redo2, Square, Type, Undo2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useCanvasTheme } from '../canvas-theme'
import {
  collectCanvasImageResources
} from './design-board-resources'
import {
  cloneDesignBoardDoc,
  createImageObject,
  createRectObject,
  createTextObject,
  parseDesignBoardDoc,
  resolveDesignImageSource,
  DESIGN_IMAGE_PLACEHOLDER
} from './design-board-types'
import type { DesignBoardDoc, DesignBoardObject } from './design-board-types'
import {
  cursorForHandle,
  pointerToScene,
  resizeBoxWithHandle,
  solveSnapDelta
} from './design-board-interaction'
import { RESIZE_HANDLE_IDS, oppositeHandle } from './design-board-interaction'
import { proxyExternalImageUrl } from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'

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

interface DragState {
  kind: 'move' | 'resize'
  objectId: string
  initial: { x: number; y: number; width: number; height: number }
  handle?: (typeof RESIZE_HANDLE_IDS)[number]
  startPointer: { x: number; y: number }
  prevGuideX: number | null
}

export interface DesignBoardEditorProps {
  node: CanvasNodeData
  nodes: CanvasNodeData[]
  onCommit: (doc: DesignBoardDoc) => void
  onClose: () => void
}

export function DesignBoardEditor({ node, nodes, onCommit, onClose }: DesignBoardEditorProps): ReactElement {
  const theme = useCanvasTheme()
  const [doc, setDoc] = useState<DesignBoardDoc>(() => parseDesignBoardDoc(node.metadata?.design) ?? createDesignBoardDoc(1080, 1440))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [textEditingId, setTextEditingId] = useState<string | null>(null)
  const [textDraft, setTextDraft] = useState('')
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null })
  const viewportRef = useRef<HTMLDivElement>(null)
  const artboardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const historyRef = useRef<{ stack: string[]; index: number; timer: ReturnType<typeof setTimeout> | null; applying: boolean }>({
    stack: [], index: -1, timer: null, applying: false
  })

  const scale = zoomPercent / 100
  const selectedObject = doc.objects.find((object) => object.id === selectedId) ?? null
  const resources = useMemo(() => collectCanvasImageResources(nodes), [nodes])

  const fitZoom = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    const availableWidth = Math.max(200, viewport.clientWidth - FIT_PADDING * 2)
    const availableHeight = Math.max(200, viewport.clientHeight - FIT_PADDING * 2)
    const percent = Math.floor(Math.min(availableWidth / doc.width, availableHeight / doc.height) * 100)
    setZoomPercent(Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, percent)))
  }, [doc.width, doc.height])

  useEffect(() => {
    fitZoom()
  }, [fitZoom])

  // ── 历史栈：140ms debounce + JSON 去重 + applying 守卫 ──
  useEffect(() => {
    if (historyRef.current.applying) return
    if (historyRef.current.index === -1) {
      historyRef.current.stack = [JSON.stringify(doc)]
      historyRef.current.index = 0
      return
    }
    const timer = setTimeout(() => {
      const snapshot = JSON.stringify(doc)
      if (historyRef.current.stack[historyRef.current.index] === snapshot) return
      historyRef.current.stack = historyRef.current.stack.slice(0, historyRef.current.index + 1)
      historyRef.current.stack.push(snapshot)
      if (historyRef.current.stack.length > HISTORY_LIMIT) historyRef.current.stack.shift()
      historyRef.current.index = historyRef.current.stack.length - 1
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

  // ── 对象操作 ──
  const updateObject = useCallback((objectId: string, updater: (object: DesignBoardObject) => DesignBoardObject): void => {
    setDoc((current) => ({ ...current, objects: current.objects.map((object) => (object.id === objectId ? updater(object) : object)) }))
  }, [])

  const addObject = useCallback((object: DesignBoardObject): void => {
    setDoc((current) => ({ ...current, objects: [...current.objects, object] }))
    setSelectedId(object.id)
  }, [])

  const addText = useCallback((): void => {
    const object = createTextObject(doc.width / 2 - 160, doc.height / 2 - 40, 320)
    addObject(object)
    setTextEditingId(object.id)
    setTextDraft('')
  }, [addObject, doc.height, doc.width])

  const addRect = useCallback((): void => {
    const size = Math.round(Math.min(doc.width, doc.height) * 0.16)
    addObject(createRectObject(doc.width / 2 - size / 2, doc.height / 2 - size / 2, size, size))
  }, [addObject, doc.height, doc.width])

  const insertResource = useCallback((nodeId: string, index: number): void => {
    const width = Math.round(doc.width * 0.4)
    addObject(createImageObject({ kind: 'node-ref', nodeId, index }, doc.width / 2 - width / 2, doc.height * 0.3, width, Math.round(width * 0.6)))
  }, [addObject, doc.height, doc.width])

  const duplicateSelected = useCallback((): void => {
    if (!selectedObject) return
    const clone = JSON.parse(JSON.stringify(selectedObject)) as DesignBoardObject
    clone.id = `${clone.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    clone.x += CLONE_OFFSET_PX
    clone.y += CLONE_OFFSET_PX
    addObject(clone)
  }, [addObject, selectedObject])

  const deleteSelected = useCallback((): void => {
    if (!selectedId) return
    setDoc((current) => ({ ...current, objects: current.objects.filter((object) => object.id !== selectedId) }))
    setSelectedId(null)
  }, [selectedId])

  // ── 文本编辑 ──
  const commitTextDraft = useCallback((): void => {
    const id = textEditingId
    if (!id) return
    const draft = textDraft
    updateObject(id, (object) =>
      object.kind === 'text'
        ? { ...object, text: draft, height: Math.max(object.height, Math.round(object.fontSize * 1.22)) }
        : object
    )
    setTextEditingId(null)
  }, [textDraft, textEditingId, updateObject])

  // ── 拖拽/缩放（window 级 move/up）──
  const boardRect = (): { left: number; top: number } => {
    const rect = artboardRef.current?.getBoundingClientRect()
    return { left: rect?.left ?? 0, top: rect?.top ?? 0 }
  }

  const startDrag = (event: ReactPointerEvent, objectId: string, handle?: (typeof RESIZE_HANDLE_IDS)[number]): void => {
    if (textEditingId && textEditingId !== objectId) commitTextDraft()
    const object = doc.objects.find((item) => item.id === objectId)
    if (!object) return
    const pointer = pointerToScene(event.clientX, event.clientY, boardRect(), scale, doc.width, doc.height)
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
      const pointer = pointerToScene(event.clientX, event.clientY, boardRect(), scale, doc.width, doc.height)
      if (drag.kind === 'move') {
        let dx = pointer.x - drag.startPointer.x
        let dy = pointer.y - drag.startPointer.y
        const moving = doc.objects.find((item) => item.id === drag.objectId)
        if (moving) {
          const bounds = {
            left: moving.x + dx, top: moving.y + dy,
            right: moving.x + moving.width + dx, bottom: moving.y + moving.height + dy
          }
          const targets = doc.objects.filter((item) => item.id !== drag.objectId)
          const snap = solveSnapDelta(bounds, targets, doc.width, doc.height, drag.prevGuideX)
          dx += snap.dx
          dy += snap.dy
          drag.prevGuideX = snap.guideX
          setSnapGuides({ x: snap.guideX, y: snap.guideY })
        }
        updateObject(drag.objectId, (object) => ({ ...object, x: drag.initial.x + dx, y: drag.initial.y + dy }))
        return
      }
      if (drag.kind === 'resize' && drag.handle) {
        const object = doc.objects.find((item) => item.id === drag.objectId)
        if (!object) return
        const keepRatio = object.kind === 'image'
        const box = resizeBoxWithHandle(drag.initial, drag.handle, pointer, { keepRatio })
        updateObject(drag.objectId, (current) => {
          if (current.kind === 'text') {
            const factor = Math.max(0.1, Math.max(box.width / Math.max(1, drag.initial.width), box.height / Math.max(1, drag.initial.height)))
            const fontSize = Math.max(MIN_FONT_SIZE, Math.round(current.fontSize * factor))
            return { ...current, width: Math.max(MIN_TEXT_WIDTH, box.width), height: Math.max(current.height, box.height), fontSize }
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

  // ── 快捷键（作用域守卫）──
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
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
  }, [commitTextDraft, deleteSelected, duplicateSelected, redo, selectedId, textEditingId, undo, updateObject])

  const finish = useCallback((): void => {
    commitTextDraft()
    onCommit(doc)
    onClose()
  }, [commitTextDraft, doc, onClose, onCommit])

  const screenScale = Math.max(scale, 0.01)

  return (
    <div className="fixed inset-0 z-[150] flex flex-col" data-canvas-no-zoom style={{ background: theme.canvas.background, color: theme.node.text }}>
      {/* 顶栏 */}
      <div className="flex h-14 items-center gap-2 border-b px-4" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
        <Frame className="size-4" />
        <span className="mr-2 truncate text-base font-semibold">{node.title}</span>
        <span className="text-xs opacity-55">{doc.width}×{doc.height}</span>
        <div className="mx-2 h-6 w-px" style={{ background: theme.toolbar.border }} />
        <Button variant="ghost" size="sm" onClick={undo}>撤销</Button>
        <Button variant="ghost" size="sm" onClick={redo}>重做</Button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={finish}>完成编辑</Button>
          <Button variant="ghost" size="sm" aria-label="关闭" onClick={onClose}><X className="size-4" /></Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 资源面板 */}
        <div className="w-56 shrink-0 overflow-y-auto border-r p-3 thin-scrollbar" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
          <p className="mb-2 text-xs font-semibold opacity-60">画布资源</p>
          {resources.length === 0 && <p className="text-xs opacity-50">画布上暂无图片资源</p>}
          <div className="grid grid-cols-2 gap-2">
            {resources.map((resource) => (
              <button
                key={resource.id}
                type="button"
                title={`${resource.title}（点击插入）`}
                className="overflow-hidden rounded-lg border"
                style={{ borderColor: theme.toolbar.border }}
                onClick={() => insertResource(resource.nodeId, resource.index)}
              >
                <img src={proxyExternalImageUrl(resource.url)} alt={resource.title} className="h-16 w-full object-cover" />
                <span className="block truncate px-1 py-0.5 text-left text-[10px] opacity-70">{resource.title}</span>
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
          onWheel={(event) => {
            if (!event.ctrlKey) return
            event.preventDefault()
            const next = zoomPercent * Math.exp(-event.deltaY * 0.006)
            setZoomPercent(Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, next)))
          }}
        >
          <div className="grid min-h-full place-items-center p-12">
            <div
              ref={artboardRef}
              data-design-board-artboard
              className="relative shadow-2xl"
              style={{ width: doc.width * scale, height: doc.height * scale, background: doc.background }}
            >
              {/* 对象视图（DOM/SVG） */}
              {doc.objects.map((object) => (
                <div
                  key={object.id}
                  data-design-board-object
                  className="absolute"
                  style={{ left: object.x * scale, top: object.y * scale, width: object.width * scale, height: object.height * scale }}
                  onPointerDown={(event) => startDrag(event, object.id)}
                  onDoubleClick={() => {
                    if (object.kind === 'text') {
                      setSelectedId(object.id)
                      setTextEditingId(object.id)
                      setTextDraft(object.text)
                    }
                  }}
                >
                  <ObjectView object={object} scale={scale} editing={textEditingId === object.id}
                    draft={textDraft} onDraftChange={setTextDraft} resolveUrl={(source) => resolveDesignImageSource(source, nodes)} />
                </div>
              ))}
              {/* 选择覆盖层 */}
              {selectedObject && !textEditingId && (
                <div className="absolute z-[22]" style={{ left: selectedObject.x * scale, top: selectedObject.y * scale, width: selectedObject.width * scale, height: selectedObject.height * scale, pointerEvents: 'none' }}>
                  <div className="absolute inset-0 border" style={{ borderWidth: 1.5 / screenScale, borderColor: '#3b82f6' }} />
                  {RESIZE_HANDLE_IDS.map((handle) => (
                    <button
                      key={handle}
                      type="button"
                      data-design-board-handle
                      className="absolute z-[23] rounded-sm border border-white bg-white"
                      style={{
                        width: 12 / screenScale, height: 12 / screenScale,
                        left: `calc(${handle.includes('w') ? 0 : handle.includes('e') ? 100 : 50}% - ${6 / screenScale}px)`,
                        top: `calc(${handle.includes('n') ? 0 : handle.includes('s') ? 100 : 50}% - ${6 / screenScale}px)`,
                        background: '#3b82f6', cursor: cursorForHandle(handle), pointerEvents: 'auto'
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
                <div className="absolute top-0 bottom-0 z-[19]" style={{ left: snapGuides.x * scale, width: 1 / screenScale, background: '#3b82f6', pointerEvents: 'none' }} />
              )}
              {snapGuides.y !== null && (
                <div className="absolute right-0 left-0 z-[19]" style={{ top: snapGuides.y * scale, height: 1 / screenScale, background: '#3b82f6', pointerEvents: 'none' }} />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* 底部工具条 */}
      <div className="flex h-14 items-center gap-2 border-t px-4" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
        <Button variant="outline" size="sm" onClick={addText}><Type className="mr-1 size-4" />添加文本</Button>
        <Button variant="outline" size="sm" onClick={addRect}><Square className="mr-1 size-4" />添加矩形</Button>
        <Button variant="outline" size="sm" onClick={duplicateSelected} disabled={!selectedObject}>复制</Button>
        <Button variant="outline" size="sm" onClick={deleteSelected} disabled={!selectedObject}>删除</Button>
        <div className="ml-auto flex items-center gap-2">
          <input type="range" min={ZOOM_MIN_PCT} max={ZOOM_MAX_PCT} value={zoomPercent} onChange={(event) => setZoomPercent(Number(event.target.value))} className="w-32" aria-label="缩放" />
          <span className="w-12 text-right text-xs tabular-nums opacity-70">{Math.round(zoomPercent)}%</span>
        </div>
      </div>
    </div>
  )
}

function ObjectView({
  object, scale, editing, draft, onDraftChange, resolveUrl
}: {
  object: DesignBoardObject
  scale: number
  editing: boolean
  draft: string
  onDraftChange: (value: string) => void
  resolveUrl: (source: DesignBoardObject extends { kind: 'image'; source: infer S } ? S : never) => string
}): ReactElement {
  if (object.kind === 'text') {
    if (editing) {
      return (
        <textarea
          autoFocus
          value={draft}
          spellCheck={false}
          onChange={(event) => onDraftChange(event.target.value)}
          onBlur={() => onDraftChange(draft)}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className="h-full w-full resize-none bg-transparent p-0 outline-none"
          style={{ color: object.color, fontSize: object.fontSize * scale, fontWeight: object.fontWeight, textAlign: object.align, fontFamily: 'inherit' }}
        />
      )
    }
    return (
      <svg className="h-full w-full overflow-visible" viewBox={`0 0 ${object.width} ${object.height}`} preserveAspectRatio="none">
        <text x={object.align === 'center' ? object.width / 2 : object.align === 'right' ? object.width : 0}
          y={object.fontSize * 1.22 * 0.8}
          fill={object.color}
          fontSize={object.fontSize}
          fontWeight={object.fontWeight}
          textAnchor={object.align === 'center' ? 'middle' : object.align === 'right' ? 'end' : 'start'}
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
        <rect x={0} y={0} width="100%" height="100%" rx={object.radius} fill={object.fill} stroke={object.stroke} strokeWidth={object.strokeWidth} />
      </svg>
    )
  }
  const url = resolveUrl(object.source)
  return url === DESIGN_IMAGE_PLACEHOLDER ? (
    <div className="grid h-full w-full place-items-center border border-dashed text-xs opacity-50" style={{ borderColor: 'currentColor' }}>图片不可用</div>
  ) : (
    <img src={proxyExternalImageUrl(url)} alt="" className="h-full w-full object-cover" style={{ borderRadius: object.radius }} draggable={false} />
  )
}
```

实现说明（执行时遵守）：
- `ObjectView` 的 `resolveUrl` prop 签名在实现时简化为 `(source: DesignImageSource) => string`，从 `design-board-types` 导入类型，删除上面泛型伪签名。
- 文本 SVG 视图为 MVP 简化渲染（单 `<text>`、`whiteSpace: pre`、基线近似）；换行精确排版由 canvas 渲染器负责（导出/缩略图），DOM 视图与 canvas 的差异在阶段二用 `layoutDesignText` 对齐。测试断言不依赖 DOM 文本换行。
- `import { RESIZE_HANDLE_IDS, oppositeHandle }` 与首个 import 块合并；`oppositeHandle` 当前未被编辑器直接消费（resizeBoxWithHandle 内部处理 anchor），如 lint 报 unused 则移除该导入。
- 悬浮属性工具栏（字号/字重/对齐/颜色/填充/圆角）本任务可先提供「属性面板」内嵌于资源面板下方（选中对象时显示），避免浮动定位复杂度；规格中的浮动工具栏为阶段二优化。

- [ ] **Step 4: 运行编辑器测试通过并提交**（`feat: add design board fullscreen editor`）

---

### Task 9: workspace 集成（打开/写回/门控/缩略图）

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/canvas-node.tsx`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/__tests__/design-board-integration.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CanvasNode } from '../canvas-node'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { createDesignBoardDoc } from '../design-board/design-board-types'

const boardNode: CanvasNodeData = {
  id: 'b1', type: 'design-board', title: '画板', position: { x: 0, y: 0 }, width: 340, height: 240,
  metadata: { design: createDesignBoardDoc(1080, 1440) }
}

function renderNode(overrides: Partial<Parameters<typeof CanvasNode>[0]> = {}) {
  const onOpenBoard = vi.fn()
  render(
    <CanvasNode
      data={boardNode}
      theme={expect.anything() as never}
      scale={1}
      isSelected={false}
      isRelated={false}
      isFocusRelated={false}
      isConnectionTarget={false}
      isConnecting={false}
      showPanel={false}
      showImageInfo={false}
      extensionInput=""
      groupChildCount={0}
      isGroupDropTarget={false}
      onOpenBoard={onOpenBoard}
      {...overrides}
    />
  )
  return { onOpenBoard }
}

describe('design-board node', () => {
  it('renders empty-board hint and opens editor on double click', async () => {
    const { onOpenBoard } = renderNode()
    expect(screen.getByText('双击开始设计')).toBeInTheDocument()
    await userEvent.dblClick(screen.getByText('双击开始设计'))
    expect(onOpenBoard).toHaveBeenCalledWith(boardNode)
  })

  it('renders thumbnail image when provided', () => {
    renderNode({ boardPreviewUrl: 'data:image/png;base64,AAA' })
    expect(screen.getByAltText('画板预览')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: `canvas-node.tsx` 增加 design-board 分支**

- `CanvasNodeProps` 增加可选 props：

```ts
boardPreviewUrl?: string
onOpenBoard?: (node: CanvasNodeData) => void
```

- 在图片/视频/音频内容渲染分支之前加 design-board 分支（渲染区域，替换默认文本内容渲染）：

```tsx
{data.type === 'design-board' ? (
  <div
    className="relative h-full w-full overflow-hidden rounded-[inherit]"
    onDoubleClick={() => onOpenBoard?.(data)}
  >
    {boardPreviewUrl ? (
      <img src={boardPreviewUrl} alt="画板预览" className="h-full w-full object-contain" draggable={false} />
    ) : (
      <div className="grid h-full w-full place-items-center text-xs" style={{ color: theme.node.muted }}>
        {docObjectCount > 0 ? `${docObjectCount} 个对象` : '双击开始设计'}
      </div>
    )}
    <span className="absolute right-1.5 bottom-1.5 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
      {boardWidth}×{boardHeight}
    </span>
  </div>
) : (
  /* 原有内容渲染分支 */
)}
```

其中头部增加：

```ts
const boardDoc = data.type === 'design-board' ? parseDesignBoardDoc(data.metadata?.design) : null
const boardWidth = boardDoc?.width ?? 0
const boardHeight = boardDoc?.height ?? 0
const docObjectCount = boardDoc?.objects.length ?? 0
```

`import { parseDesignBoardDoc } from './design-board/design-board-types'`。

- [ ] **Step 4: workspace 集成**

新增 state 与导入：

```ts
import { DesignBoardEditor } from './design-board/design-board-editor'
import { getDesignBoardThumbnail, invalidateDesignBoardThumbnail } from './design-board/design-board-thumbnail'
const [designBoardEditorNodeId, setDesignBoardEditorNodeId] = useState<string | null>(null)
const [boardPreviewUrls, setBoardPreviewUrls] = useState<Record<string, string>>({})
```

打开/提交处理：

```ts
const boardEditorNode = designBoardEditorNodeId ? nodeMap.get(designBoardEditorNodeId) : undefined

const commitDesignBoard = useCallback((nodeId: string, doc: DesignBoardDoc): void => {
  invalidateDesignBoardThumbnail(nodeId)
  setNodes((current) =>
    current.map((node) =>
      node.id === nodeId
        ? { ...node, metadata: { ...node.metadata, design: doc, designUpdatedAt: Date.now() } }
        : node
    )
  )
}, [])
```

渲染（与其他 overlay 同级）：

```tsx
{boardEditorNode && (
  <DesignBoardEditor
    node={boardEditorNode}
    nodes={nodes}
    onCommit={(doc) => commitDesignBoard(boardEditorNode.id, doc)}
    onClose={() => setDesignBoardEditorNodeId(null)}
  />
)}
```

`CanvasNode` 传参（design-board 节点）：

```tsx
boardPreviewUrl={boardPreviewUrls[node.id]}
onOpenBoard={(item) => setDesignBoardEditorNodeId(item.id)}
```

悬停工具栏「编辑 / 打开面板」按钮的 onClick 分支：`toolbarNode.type === 'design-board'` 时改为 `setDesignBoardEditorNodeId(toolbarNode.id)`（原 `setPanelNodeId` 行为保持给其他类型）。

缩略图异步生成（boardEditorNodeId 为空即编辑器关闭时刷新）：

```ts
useEffect(() => {
  if (designBoardEditorNodeId) return
  const boardNodes = nodes.filter((node) => node.type === 'design-board')
  let cancelled = false
  const timer = setTimeout(async () => {
    for (const node of boardNodes) {
      const url = await getDesignBoardThumbnail(node, nodes)
      if (cancelled) return
      if (url) setBoardPreviewUrls((current) => (current[node.id] === url ? current : { ...current, [node.id]: url }))
    }
  }, 200)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}, [nodes, designBoardEditorNodeId])
```

键盘门控：定位画布全局 Delete/Backspace/Ctrl+Z/Ctrl+A 监听（workspace 内 useEffect，注释「keep-alive 下隐藏挂载时必须关闭全局按键监听」一带），在其处理函数最前加：

```ts
if (designBoardEditorNodeId) return
```

并把 `designBoardEditorNodeId` 加入该 effect 依赖数组。

- [ ] **Step 5: 运行新测试 + 既有 infinite-canvas 测试（batch-download/canvas-chrome/canvas-node-panel）通过**

Run: `pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas --environment jsdom`
Expected: PASS

- [ ] **Step 6: 提交**（`feat: integrate design board into canvas workspace`）

---

### Task 10: 导出为图片节点与全量验证

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/design-board/design-board-editor.tsx`（顶栏导出按钮）
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx`（导出生成图片节点）
- Test: 编辑器测试追加导出回调用例

- [ ] **Step 1: 编辑器顶栏增加「导出图片」按钮**

```tsx
<Button size="sm" variant="outline" onClick={() => void onExport()}>导出图片</Button>
```

`onExport` prop 加入 `DesignBoardEditorProps`：

```ts
onExport?: (format: 'png' | 'jpg') => Promise<void>
```

按钮旁提供格式切换（png/jpg 两个 radio 或分段按钮，默认 png）。

- [ ] **Step 2: workspace 提供导出实现并传入**

```ts
const exportDesignBoard = useCallback(async (nodeId: string, doc: DesignBoardDoc, format: 'png' | 'jpg'): Promise<void> => {
  const source = nodes.find((item) => item.id === nodeId)
  if (!source) return
  const result = await exportDesignBoardImage(doc, nodes, { format })
  const imageNode = createNodeData('image', { x: source.position.x + source.width + 96, y: source.position.y }, {
    content: result.dataUrl,
    status: 'success',
    mimeType: format === 'jpg' ? 'image/jpeg' : 'image/png',
    naturalWidth: result.width,
    naturalHeight: result.height
  })
  imageNode.title = `${source.title}-导出`
  pushHistory()
  setNodes((current) => [...current, imageNode])
  setConnections((current) => [
    ...current,
    { id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, fromNodeId: nodeId, toNodeId: imageNode.id }
  ])
  setSaveError(null)
}, [nodes, pushHistory])

// 传给编辑器
onExport={(format) => exportDesignBoard(boardEditorNode.id, boardEditorNode.metadata?.design as DesignBoardDoc ?? doc, format)}
```

实际实现时导出应使用编辑器当前草稿 doc（把 `onExport(format)` 交给编辑器内部拿当前 doc 调用 prop 回调 `onExport(format, doc)`），签名定为：

```ts
onExport?: (format: 'png' | 'jpg', doc: DesignBoardDoc) => Promise<void>
```

编辑器按钮点击时传当前 `doc`。失败 catch 走 `setSaveError` 展示（图片代理/CORS 失败提示「部分图片无法加载，导出失败」）。

- [ ] **Step 3: 编辑器测试追加**

```tsx
it('invokes export callback with current doc and format', async () => {
  const onExport = vi.fn().mockResolvedValue(undefined)
  setup({ onExport })
  await userEvent.click(screen.getByRole('button', { name: '添加矩形' }))
  await userEvent.click(screen.getByRole('button', { name: '导出图片' }))
  expect(onExport).toHaveBeenCalledWith('png', expect.objectContaining({ objects: expect.any(Array) }))
})
```

- [ ] **Step 4: 全量验证**

```powershell
pnpm --filter desktop test
pnpm --filter desktop typecheck
pnpm exec eslint apps/desktop/src/renderer/src/components/infinite-canvas/design-board apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx apps/desktop/src/renderer/src/components/infinite-canvas/canvas-node.tsx apps/desktop/src/renderer/src/components/infinite-canvas/canvas-chrome.tsx apps/desktop/src/renderer/src/components/infinite-canvas/batch-download.ts
git diff --check
git status --short
```

Expected: 测试通过（既有 App.test 冷启动超时为已知环境问题，与本功能无关需单独说明）；typecheck 0 错误；eslint 0 errors（workspace 既有 9 条 prettier warning 可保留）；diff --check 干净。

- [ ] **Step 5: 提交**（`feat: add design board image export to canvas`）

## Plan Self-Review

- Spec coverage：预设选择（Task 7）、节点缩略图与双击入口（Task 9）、全屏编辑器三类对象与拖动/缩放/吸附/撤销/文本编辑（Task 8）、资源面板（Task 2/8）、导出 PNG/JPG 生成图片节点（Task 10）、batch-download 映射（Task 6）、键盘门控（Task 9）、尺寸标签/空画板提示（Task 9）均有对应任务。阶段二/三内容按 spec 明确排除。
- Placeholder scan：Task 4/8 的「实现说明」是对伪代码缺口的显式修正指令（签名统一、导入合并），非 TBD；其余步骤均含具体代码与命令。
- Type consistency：`DesignBoardDoc/DesignBoardObject/DesignImageSource/resolveDesignImageSource`（Task 1）在渲染器/导出/缩略图/编辑器/集成任务中签名一致；`resizeBoxWithHandle/solveSnapDelta/pointerToScene`（Task 3）与编辑器接线一致；`collectCanvasImageResources`（Task 2）返回结构在 Task 8 消费一致；`exportDesignBoardImage`（Task 5）与 Task 10 消费一致；`getDesignBoardThumbnail`（Task 5）与 Task 9 接线一致。
- Scope：无后端路由、无迁移、无现有节点类型行为改动；NodeCreateMenu/geometry/batch-download 修改均为加法。
