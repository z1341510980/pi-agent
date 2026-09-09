# Infinite Canvas 批量下载选中节点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在无限画布底部功能栏增加“批量下载选中”入口，将选中的媒体、文本和配置节点打包成一个可下载的 ZIP 文件。

**Architecture:** 新增一个纯函数批量下载模块，负责把画布节点展开为下载条目、清理和去重文件名、按 MIME 类型确定媒体扩展名以及生成 ZIP Blob。workspace 负责解析远程媒体、管理下载中状态和错误提示；CanvasToolbar 只负责展示按钮与转发回调。分组节点不生成文件，单个媒体失败不会阻断其他条目。

**Tech Stack:** React 19、TypeScript、Vitest、`fflate`、现有 `resolveDownloadBlob` / `downloadUrl` 下载工具、Tailwind CSS。

---

## 文件边界

- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/batch-download.ts`
  - 定义批量下载条目类型。
  - 将节点映射为媒体、文本或 JSON 条目。
  - 清理标题、处理重名、推断视频/音频扩展名。
  - 使用 `fflate` 把已经解析好的字节数据生成 ZIP Blob。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/batch-download.test.ts`
  - 覆盖节点展开、文件命名、MIME 扩展名和 ZIP 内容。
- Modify: `apps/desktop/package.json`
  - 增加 renderer 使用的 `fflate` 依赖。
- Modify: `pnpm-lock.yaml`
  - 由 pnpm 更新依赖锁文件。
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/canvas-chrome.tsx`
  - 为 `CanvasToolbar` 增加批量下载回调和下载中状态。
  - 在有选中节点时显示批量下载按钮。
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/canvas-chrome.test.tsx`
  - 验证功能栏按钮的显示、点击和禁用状态。
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx`
  - 调用批量下载模块，解析媒体资源，生成 ZIP 并通过现有下载工具触发保存。
  - 增加下载中状态和完成/失败提示。

### Task 1: Add the ZIP dependency and define failing utility tests

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/batch-download.test.ts`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/batch-download.ts`

- [ ] **Step 1: Add the ZIP dependency without changing unrelated packages**

Run:

```powershell
pnpm add fflate --filter desktop
```

Expected: only `apps/desktop/package.json` and `pnpm-lock.yaml` gain the `fflate` dependency.

- [ ] **Step 2: Write failing tests for node expansion and naming**

Create `batch-download.test.ts` with the following cases:

```ts
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import {
  buildZipBlob,
  collectBatchDownloadItems,
  mediaFileExtension,
  sanitizeBatchFilename,
  uniqueBatchFilename
} from '../batch-download'

const node = (overrides: Partial<CanvasNodeData>): CanvasNodeData => ({
  id: 'node-1',
  type: 'text',
  title: '未命名节点',
  position: { x: 0, y: 0 },
  width: 100,
  height: 100,
  ...overrides
})

describe('batch download item collection', () => {
  it('expands every image result and skips groups', () => {
    const items = collectBatchDownloadItems([
      node({
        id: 'images',
        type: 'image',
        title: '角色图',
        metadata: {
          images: [{ id: 'a', content: 'data:image/png;base64,AA==' }, 'data:image/jpeg;base64,/w==']
        }
      }),
      node({ id: 'group', type: 'group', title: '分组' })
    ])

    expect(items).toEqual([
      {
        baseName: '角色图-1',
        kind: 'media',
        mediaType: 'image',
        content: 'data:image/png;base64,AA=='
      },
      {
        baseName: '角色图-2',
        kind: 'media',
        mediaType: 'image',
        content: 'data:image/jpeg;base64,/w=='
      }
    ])
  })

  it('maps text and config nodes to readable files', () => {
    const items = collectBatchDownloadItems([
      node({ type: 'text', title: '提示词', metadata: { content: '一段文字' } }),
      node({ type: 'config', title: '配置', metadata: { model: 'demo', count: 2 } })
    ])

    expect(items).toEqual([
      { baseName: '提示词', kind: 'text', extension: '.txt', content: '一段文字' },
      {
        baseName: '配置',
        kind: 'text',
        extension: '.json',
        content: '{\n  "model": "demo",\n  "count": 2\n}'
      }
    ])
  })

  it('uses the primary content when an image has no result list', () => {
    expect(
      collectBatchDownloadItems([
        node({ type: 'image', title: '主图', metadata: { content: 'blob:image' } })
      ])
    ).toEqual([
      { baseName: '主图', kind: 'media', mediaType: 'image', content: 'blob:image' }
    ])
  })
})

describe('batch download filenames and archive', () => {
  it('removes path separators and Windows-invalid characters', () => {
    expect(sanitizeBatchFilename('  A/B:C*D?  ')).toBe('A-B-C-D')
    expect(sanitizeBatchFilename('')).toBe('未命名节点')
  })

  it('deduplicates names inside one archive', () => {
    const used = new Set<string>()
    expect(uniqueBatchFilename('同名.txt', used)).toBe('同名.txt')
    expect(uniqueBatchFilename('同名.txt', used)).toBe('同名-2.txt')
  })

  it('maps common media MIME types to extensions', () => {
    expect(mediaFileExtension('image/jpeg', 'image')).toBe('.jpg')
    expect(mediaFileExtension('video/webm', 'video')).toBe('.webm')
    expect(mediaFileExtension('audio/mpeg', 'audio')).toBe('.mp3')
    expect(mediaFileExtension('', 'video')).toBe('.mp4')
  })

  it('creates a readable ZIP blob', async () => {
    const blob = buildZipBlob([
      { filename: 'note.txt', data: new TextEncoder().encode('hello') },
      { filename: 'data.json', data: new TextEncoder().encode('{"ok":true}') }
    ])
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    expect(strFromU8(archive['note.txt'])).toBe('hello')
    expect(strFromU8(archive['data.json'])).toBe('{"ok":true}')
  })
})
```

- [ ] **Step 3: Run the new test to confirm it fails for missing implementation**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/batch-download.test.ts --environment jsdom
```

Expected: FAIL because `batch-download.ts` does not yet export the tested functions.

### Task 2: Implement the pure batch-download module

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/batch-download.ts`
- Test: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/batch-download.test.ts`

- [ ] **Step 1: Implement the node item types and collection function**

Use these interfaces and rules in `batch-download.ts`:

```ts
import { canvasGeneratedImageContent } from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { zipSync } from 'fflate'

export type BatchDownloadItem =
  | { baseName: string; kind: 'media'; mediaType: 'image' | 'video' | 'audio'; content: string }
  | { baseName: string; kind: 'text'; extension: '.txt' | '.json'; content: string }

export type BatchZipFile = { filename: string; data: Uint8Array }

export function collectBatchDownloadItems(nodes: CanvasNodeData[]): BatchDownloadItem[] {
  const items: BatchDownloadItem[] = []
  for (const node of nodes) {
    if (node.type === 'group') continue
    const baseName = sanitizeBatchFilename(node.title || `canvas-${node.type}`)
    const metadata = node.metadata ?? {}
    if (node.type === 'image') {
      const images = Array.isArray(metadata.images)
        ? metadata.images
            .map(canvasGeneratedImageContent)
            .filter((content): content is string => Boolean(content))
        : []
      const sources = images.length ? images : [metadata.content]
      sources.forEach((content, index) => {
        if (typeof content !== 'string' || !content) return
        items.push({
          baseName: images.length > 1 ? `${baseName}-${index + 1}` : baseName,
          kind: 'media',
          mediaType: 'image',
          content
        })
      })
      continue
    }
    if (node.type === 'video' || node.type === 'audio') {
      if (typeof metadata.content === 'string' && metadata.content) {
        items.push({ baseName, kind: 'media', mediaType: node.type, content: metadata.content })
      }
      continue
    }
    if (node.type === 'config') {
      items.push({
        baseName,
        kind: 'text',
        extension: '.json',
        content: JSON.stringify(metadata, null, 2)
      })
      continue
    }
    const content = typeof metadata.content === 'string' ? metadata.content : ''
    if (content) items.push({ baseName, kind: 'text', extension: '.txt', content })
  }
  return items
}
```

The implementation must keep the `images` object/string compatibility already provided by `canvasGeneratedImageContent`, and must not emit a file for empty content or groups.

- [ ] **Step 2: Implement filename normalization and MIME extension helpers**

Add these exact behaviors:

```ts
const WINDOWS_INVALID = /[<>:"/\\|?*\u0000-\u001f]/g

export function sanitizeBatchFilename(value: string): string {
  const sanitized = value.trim().replace(WINDOWS_INVALID, '-').replace(/[. ]+$/g, '')
  return sanitized || '未命名节点'
}

export function uniqueBatchFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename)
    return filename
  }
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  let index = 2
  let candidate = `${stem}-${index}${extension}`
  while (used.has(candidate)) candidate = `${stem}-${++index}${extension}`
  used.add(candidate)
  return candidate
}

export function mediaFileExtension(
  mime: string | undefined,
  mediaType: 'image' | 'video' | 'audio'
): string {
  const subtype = (mime ?? '').toLowerCase().replace(/^\w+\//, '').split(';')[0].trim()
  const known: Record<string, string> = {
    jpeg: '.jpg',
    'svg+xml': '.svg',
    'x-icon': '.ico',
    mpeg: '.mp3',
    mp4: '.mp4',
    webm: '.webm',
    quicktime: '.mov',
    wav: '.wav',
    ogg: '.ogg',
    'x-m4a': '.m4a'
  }
  if (subtype && known[subtype]) return known[subtype]
  return mediaType === 'image' ? '.png' : mediaType === 'video' ? '.mp4' : '.mp3'
}
```

- [ ] **Step 3: Implement ZIP Blob generation**

Add a synchronous ZIP builder that keeps archive creation independent from network fetching:

```ts
export function buildZipBlob(files: BatchZipFile[]): Blob {
  const entries: Record<string, Uint8Array> = {}
  for (const file of files) entries[file.filename] = file.data
  return new Blob([zipSync(entries)], { type: 'application/zip' })
}
```

- [ ] **Step 4: Run the utility tests and commit the isolated module**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/batch-download.test.ts --environment jsdom
```

Expected: PASS with all node mapping, naming, MIME and ZIP assertions.

Commit only the dependency, utility and utility test:

```powershell
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/renderer/src/components/infinite-canvas/batch-download.ts apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/batch-download.test.ts
git commit -m "feat: add infinite canvas batch archive builder"
```

### Task 3: Add the feature-bar button

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/canvas-chrome.tsx`
- Create: `apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/canvas-chrome.test.tsx`

- [ ] **Step 1: Write the toolbar behavior test**

The test should render `CanvasToolbar` with the existing theme returned by `useCanvasTheme` mocked to a minimal toolbar/node color object, pass `selectedCount={2}`, and assert that:

```ts
expect(screen.getByRole('button', { name: '批量下载选中 (2)' })).toBeEnabled()
await user.click(screen.getByRole('button', { name: '批量下载选中 (2)' }))
expect(onBatchDownload).toHaveBeenCalledTimes(1)
```

Render again with `selectedCount={0}` and assert the button is absent. Render with `batchDownloading={true}` and assert the button is disabled and has `aria-label="正在打包下载"`.

- [ ] **Step 2: Run the toolbar test to verify the new props are not implemented**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/canvas-chrome.test.tsx --environment jsdom
```

Expected: FAIL because `CanvasToolbar` has no batch-download props or button.

- [ ] **Step 3: Add the callback and button to `CanvasToolbar`**

Extend `CanvasToolbarProps` with:

```ts
onBatchDownload?: () => void
batchDownloading?: boolean
```

Destructure both values with `batchDownloading = false`. Immediately before the existing delete button at `canvas-chrome.tsx:319`, render:

```tsx
{selectedCount > 0 && onBatchDownload && (
  <DockButton
    icon={<Download />}
    label={batchDownloading ? '正在打包下载' : `批量下载选中 (${selectedCount})`}
    disabled={batchDownloading}
    onClick={onBatchDownload}
  />
)}
```

Use the existing `Download` import and `DockButton` disabled styling; do not add a second toolbar component or a modal.

- [ ] **Step 4: Run the toolbar test and commit the UI-only change**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/canvas-chrome.test.tsx --environment jsdom
```

Expected: PASS.

Commit:

```powershell
git add apps/desktop/src/renderer/src/components/infinite-canvas/canvas-chrome.tsx apps/desktop/src/renderer/src/components/infinite-canvas/__tests__/canvas-chrome.test.tsx
git commit -m "feat: add infinite canvas batch download action"
```

### Task 4: Integrate resource fetching and ZIP download in the workspace

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx`

- [ ] **Step 1: Add the download state and imports**

Import `TextEncoder`-compatible utilities from the platform, plus these batch module exports:

```ts
import {
  buildZipBlob,
  collectBatchDownloadItems,
  mediaFileExtension,
  uniqueBatchFilename
} from './batch-download'
```

Add alongside the existing media state:

```ts
const [batchDownloading, setBatchDownloading] = useState(false)
```

- [ ] **Step 2: Implement the async batch handler**

Add this callback after `exportSelected` and before `duplicateProject`:

```ts
const downloadSelectedBatch = useCallback(async (): Promise<void> => {
  if (!project || !selectedNodeIds.size || batchDownloading) return
  setBatchDownloading(true)
  setSaveError(null)
  const files: Array<{ filename: string; data: Uint8Array }> = []
  const failures: string[] = []
  const usedNames = new Set<string>()
  try {
    const items = collectBatchDownloadItems(nodes.filter((node) => selectedNodeIds.has(node.id)))
    for (const item of items) {
      try {
        const blob =
          item.kind === 'media'
            ? await resolveDownloadBlob(item.content)
            : new Blob([item.content], {
                type: item.extension === '.json' ? 'application/json' : 'text/plain;charset=utf-8'
              })
        const extension =
          item.kind === 'media'
            ? mediaFileExtension(blob.type, item.mediaType)
            : item.extension
        const filename = uniqueBatchFilename(`${item.baseName}${extension}`, usedNames)
        files.push({ filename, data: new Uint8Array(await blob.arrayBuffer()) })
      } catch (reason) {
        failures.push(`${item.baseName}: ${reason instanceof Error ? reason.message : '读取失败'}`)
      }
    }
    if (!files.length) {
      setSaveError(failures.length ? `没有可下载的文件：${failures.join('；')}` : '选中的节点没有可下载内容')
      return
    }
    const archive = buildZipBlob(files)
    downloadUrl(`${project.title || 'canvas'}-selected.zip`, archive)
    setSaveError(
      failures.length
        ? `已打包 ${files.length} 个文件，${failures.length} 个文件失败：${failures.join('；')}`
        : `已打包 ${files.length} 个文件`
    )
  } catch (reason) {
    setSaveError(reason instanceof Error ? reason.message : '批量下载失败，请稍后重试')
  } finally {
    setBatchDownloading(false)
  }
}, [batchDownloading, nodes, project, selectedNodeIds])
```

The callback must use the current `nodes` and `selectedNodeIds` snapshot, skip groups through `collectBatchDownloadItems`, continue after per-item failures, and avoid generating a ZIP when there are no successful files.

- [ ] **Step 3: Pass the handler and state into `CanvasToolbar`**

Extend the existing JSX call at `infinite-canvas-workspace.tsx:2726` with:

```tsx
onBatchDownload={() => void downloadSelectedBatch()}
batchDownloading={batchDownloading}
```

Keep `onDelete={deleteSelected}` and all existing toolbar callbacks unchanged.

- [ ] **Step 4: Run focused tests and web typecheck**

Run:

```powershell
pnpm --filter desktop exec vitest run src/renderer/src/components/infinite-canvas/__tests__/batch-download.test.ts src/renderer/src/components/infinite-canvas/__tests__/canvas-chrome.test.tsx --environment jsdom
pnpm --filter desktop typecheck:web
```

Expected: both test files PASS and web TypeScript exits with code 0.

- [ ] **Step 5: Inspect the final diff and commit the integration**

Run:

```powershell
git status --short
```

Confirm no unrelated user changes are staged, then commit:

```powershell
git add apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx
git commit -m "feat: integrate infinite canvas batch downloads"
```

### Task 5: Verify the feature against the existing desktop suite

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the full desktop test suite**

Run:

```powershell
pnpm --filter desktop test
```

Expected: all desktop Vitest tests PASS.

- [ ] **Step 2: Run desktop typechecks and lint on touched files**

Run:

```powershell
pnpm --filter desktop typecheck
pnpm exec eslint apps/desktop/src/renderer/src/components/infinite-canvas/batch-download.ts apps/desktop/src/renderer/src/components/infinite-canvas/canvas-chrome.tsx apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx
```

Expected: typecheck and ESLint exit with code 0.

- [ ] **Step 3: Review status and commits**

Run:

```powershell
```

Confirm the feature commits contain only the intended files and leave the user's pre-existing worktree changes untouched.

## Plan Self-Review

- Spec coverage: toolbar entry, ZIP packaging, all requested node types, image result expansion, filename sanitization, duplicate handling, per-file failure continuation, empty-result handling, tests and verification are covered by Tasks 1-5.
- Placeholder scan: no `TODO`, `TBD`, or unspecified implementation step remains; each code change has a concrete file, API, command, or code block.
- Type consistency: `BatchDownloadItem`, `collectBatchDownloadItems`, `mediaFileExtension`, `uniqueBatchFilename`, `buildZipBlob`, `CanvasToolbar` props, and `downloadSelectedBatch` use the same names and signatures throughout.
- Scope: no backend route, persistence migration, or unrelated canvas refactor is included.
