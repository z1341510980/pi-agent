# 小说前端容错与体验补强 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为小说前端补齐四项关键缺失：局部 ErrorBoundary、SSE 失败重试按钮、Undo/Redo 栈、矩阵虚拟化，让大数据量与异常状态下用户操作可恢复、可挽回。

**架构：**
1. **ErrorBoundary 局部包裹**：复用项目已有 `components/overlays/error-boundary.tsx`，包裹 4 个高风险子区域（编辑器/矩阵/画布/创作面板），单点崩溃不影响整个工作台。
2. **SSE 失败重试**：复用项目已有 `components/chat/error-card.tsx`，在 `chapter-live-view.tsx` 错误卡片替换为 `ErrorCard`，新增 `onRetry` 回调重新触发 `startCreation`（与 chat 行为一致，不实现真正断点续传）。
3. **Undo/Redo 栈**：引入 `zundo`（zustand temporal middleware），与现有 `persist` 中间件共存；追踪数据字段，UI 字段通过 `partialize` 同款黑名单排除；启用 `matrix-toolbar.tsx` 已被注释的撤销/重做按钮。
4. **矩阵虚拟化**：复用项目已安装的 `@tanstack/react-virtual`（`session-list.tsx` 已是参考实现），先做水平（章节列）虚拟化解决主要瓶颈，垂直虚拟化作为第二阶段。

**技术栈：**
- React + TypeScript
- zustand + zundo（temporal middleware）
- @tanstack/react-virtual
- 项目自有 `ErrorBoundary` / `ErrorCard` / `Button` / `Dialog` 组件
- vitest + @testing-library/react

---

## 文件结构

### 新建文件
| 路径 | 职责 |
|------|------|
| `apps/desktop/src/renderer/src/components/novel/matrix-error-fallback.tsx` | 矩阵视图错误回退 UI（带"切换到画布"操作） |
| `apps/desktop/src/renderer/src/components/novel/canvas-error-fallback.tsx` | 画布视图错误回退 UI（带"切换到矩阵"操作） |
| `apps/desktop/src/renderer/src/components/novel/creation-error-fallback.tsx` | 创作面板错误回退 UI（带"丢弃创作"操作） |
| `apps/desktop/src/renderer/src/components/novel/__tests__/novel-undo.test.ts` | Undo/Redo 栈单元测试 |
| `apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-horizontal-virtualization.test.ts` | 矩阵水平虚拟化逻辑测试 |
| `apps/desktop/src/renderer/src/lib/matrix-viewport.ts` | 矩阵视口计算纯函数（可测试） |

### 修改文件
| 路径 | 修改内容 |
|------|---------|
| `apps/desktop/package.json` | 新增 `zundo@^2.1.0` 依赖 |
| `apps/desktop/src/renderer/src/stores/novel-store.ts` | 包裹 `temporal` 中间件；新增 `undo()/redo()/canUndo()/canRedo()/clearHistory()`；新增 `wrapMutation` 内部辅助函数标记破坏性 set |
| `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx` | 4 处 ErrorBoundary 局部包裹；新增 `handleRetryCreation`；向 `ChapterLivePanel` 传 `onRetry` |
| `apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx` | 错误卡片改为复用 `ErrorCard`；`ChapterLivePanelProps` 新增 `onRetry?` |
| `apps/desktop/src/renderer/src/components/novel/matrix/matrix-toolbar.tsx` | 启用被注释的撤销/重做按钮 |
| `apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx` | 接入 `undo()/redo()/canUndo/canRedo` 传给 `MatrixToolbar` |
| `apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx` | 章节列改为按可见范围 slice；接入 `useVirtualizer` 水平虚拟化 |
| `apps/desktop/src/renderer/src/hooks/use-shortcut.ts` | 新增 `onUndo/onRedo` 可选回调（仅在 novel 工作区注册时传入） |
| `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`（重复出现）| 在工作区挂载时注册 Cmd/Ctrl+Z 与 Cmd/Ctrl+Shift+Z 快捷键 |

---

## 任务依赖与顺序

```
任务 1（ErrorBoundary）→ 任务 2（重试按钮）→ 任务 3（Undo/Redo）
                                                 ↓
                                            任务 4（水平虚拟化）→ 任务 5（垂直虚拟化，可选）
```

任务 1、2、3 之间无强依赖，可并行；任务 4 依赖任务 3 完成后 store 稳定（避免改 store 时同时改 view）；任务 5 是可选优化。

---

## 任务 1：ErrorBoundary 局部包裹

**目标：** 在 `novel-workspace.tsx` 主体内对 4 个高风险子组件分别包裹 `ErrorBoundary`，单点崩溃时显示上下文化 fallback UI，提供"重置此区域 / 切换视图 / 丢弃创作"等操作按钮。

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix-error-fallback.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/canvas-error-fallback.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/creation-error-fallback.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`

### 步骤

- [ ] **1.1 编写 matrix-error-fallback.tsx**

```tsx
// apps/desktop/src/renderer/src/components/novel/matrix-error-fallback.tsx
import type { ReactElement } from 'react'
import { AlertTriangle, RotateCcw, LayoutGrid } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface MatrixErrorFallbackProps {
  error: Error
  reset: () => void
  onSwitchToCanvas: () => void
}

export function MatrixErrorFallback({
  error,
  reset,
  onSwitchToCanvas,
}: MatrixErrorFallbackProps): ReactElement {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 p-6 h-full min-h-[300px] text-center bg-muted/30"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">矩阵视图崩溃</h3>
        <p className="text-xs text-muted-foreground max-w-[360px]">
          矩阵交互发生异常。可重置此区域、切换到画布视图，或查看错误详情。
        </p>
      </div>
      <details className="max-w-[440px] w-full">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-text">
          查看错误详情
        </summary>
        <pre className="mt-2 p-3 bg-surface-2 rounded-md text-xs font-mono text-left overflow-auto max-h-[160px]">
          <code>{error.message}</code>
          {error.stack && `\n\n${error.stack}`}
        </pre>
      </details>
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={reset}>
          <RotateCcw className="size-3.5" />
          重置矩阵
        </Button>
        <Button variant="outline" size="sm" onClick={onSwitchToCanvas}>
          <LayoutGrid className="size-3.5" />
          切换到画布
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **1.2 编写 canvas-error-fallback.tsx**

```tsx
// apps/desktop/src/renderer/src/components/novel/canvas-error-fallback.tsx
import type { ReactElement } from 'react'
import { AlertTriangle, RotateCcw, Grid3x3 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface CanvasErrorFallbackProps {
  error: Error
  reset: () => void
  onSwitchToMatrix: () => void
}

export function CanvasErrorFallback({
  error,
  reset,
  onSwitchToMatrix,
}: CanvasErrorFallbackProps): ReactElement {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 p-6 h-full min-h-[300px] text-center bg-muted/30"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">画布视图崩溃</h3>
        <p className="text-xs text-muted-foreground max-w-[360px]">
          画布渲染发生异常。可重置此区域、切换到矩阵视图，或查看错误详情。
        </p>
      </div>
      <details className="max-w-[440px] w-full">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-text">
          查看错误详情
        </summary>
        <pre className="mt-2 p-3 bg-surface-2 rounded-md text-xs font-mono text-left overflow-auto max-h-[160px]">
          <code>{error.message}</code>
          {error.stack && `\n\n${error.stack}`}
        </pre>
      </details>
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={reset}>
          <RotateCcw className="size-3.5" />
          重置画布
        </Button>
        <Button variant="outline" size="sm" onClick={onSwitchToMatrix}>
          <Grid3x3 className="size-3.5" />
          切换到矩阵
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **1.3 编写 creation-error-fallback.tsx**

```tsx
// apps/desktop/src/renderer/src/components/novel/creation-error-fallback.tsx
import type { ReactElement } from 'react'
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface CreationErrorFallbackProps {
  error: Error
  reset: () => void
  onDiscardCreation: () => void
}

export function CreationErrorFallback({
  error,
  reset,
  onDiscardCreation,
}: CreationErrorFallbackProps): ReactElement {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 p-6 h-full min-h-[240px] text-center bg-muted/30"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">创作面板出错</h3>
        <p className="text-xs text-muted-foreground max-w-[320px]">
          创作流程发生异常。可重置面板、丢弃本次创作，或查看错误详情。
        </p>
      </div>
      <details className="max-w-[420px] w-full">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-text">
          查看错误详情
        </summary>
        <pre className="mt-2 p-3 bg-surface-2 rounded-md text-xs font-mono text-left overflow-auto max-h-[140px]">
          <code>{error.message}</code>
          {error.stack && `\n\n${error.stack}`}
        </pre>
      </details>
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={reset}>
          <RotateCcw className="size-3.5" />
          重置面板
        </Button>
        <Button variant="outline" size="sm" onClick={onDiscardCreation}>
          <Trash2 className="size-3.5" />
          丢弃创作
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **1.4 修改 novel-workspace.tsx 包裹 ErrorBoundary**

在 `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx` 顶部新增 import：

```tsx
import { ErrorBoundary } from '@/components/overlays/error-boundary'
import { MatrixErrorFallback } from './matrix-error-fallback'
import { CanvasErrorFallback } from './canvas-error-fallback'
import { CreationErrorFallback } from './creation-error-fallback'
```

定位 L562-568（`ChapterContentEditor` 包裹），改为：

```tsx
<div style={{ height: contentEditorHeight }}>
  <ErrorBoundary
    fallback={(err, reset) => (
      <MatrixErrorFallback
        error={err}
        reset={reset}
        onSwitchToCanvas={() => setViewMode('canvas')}
      />
    )}
  >
    <ChapterContentEditor ... />
  </ErrorBoundary>
</div>
```

定位 L579-584（`MatrixWorkspace` 包裹），改为：

```tsx
<div className="flex-1 min-h-[200px] overflow-hidden">
  <ErrorBoundary
    fallback={(err, reset) => (
      <MatrixErrorFallback
        error={err}
        reset={reset}
        onSwitchToCanvas={() => setViewMode('canvas')}
      />
    )}
  >
    <MatrixWorkspace ... />
  </ErrorBoundary>
</div>
```

定位 L588-595（`NovelCanvas` 包裹），改为：

```tsx
<ErrorBoundary
  fallback={(err, reset) => (
    <CanvasErrorFallback
      error={err}
      reset={reset}
      onSwitchToMatrix={() => setViewMode('matrix')}
    />
  )}
>
  <NovelCanvas ... />
</ErrorBoundary>
```

定位 L619-634（`ChapterLivePanel` 包裹），改为：

```tsx
<ErrorBoundary
  fallback={(err, reset) => (
    <CreationErrorFallback
      error={err}
      reset={reset}
      onDiscardCreation={handleDiscardCreation}
    />
  )}
>
  <ChapterLivePanel
    ...
    onRetry={handleRetryCreation}
  />
</ErrorBoundary>
```

- [ ] **1.5 验证：手动抛错测试**

在 dev 模式启动应用，临时在 `MatrixWorkspace` 顶部加 `throw new Error('test boundary')`，确认：
1. 矩阵区域显示 `MatrixErrorFallback`
2. 左侧栏、header、右侧详情栏、画布切换按钮仍可用
3. 点"切换到画布"成功切换 viewMode
4. 点"重置矩阵"清空错误状态，恢复渲染
5. 移除测试代码

- [ ] **1.6 类型检查 + commit**

运行：`pnpm --filter desktop typecheck`
预期：通过

```bash
git add apps/desktop/src/renderer/src/components/novel/matrix-error-fallback.tsx \
        apps/desktop/src/renderer/src/components/novel/canvas-error-fallback.tsx \
        apps/desktop/src/renderer/src/components/novel/creation-error-fallback.tsx \
        apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx
git commit -m "feat(novel): 局部 ErrorBoundary 包裹矩阵/画布/创作面板/编辑器，单点崩溃不再白屏"
```

---

## 任务 2：SSE 失败重试按钮（复用 chat ErrorCard）

**目标：** `chapter-live-view.tsx` 错误卡片改为复用 `components/chat/error-card.tsx` 的 `ErrorCard` 组件，新增"重试"按钮；`use-novel-creation-flow.ts` 失败后保留 `agentOutputs` 和 `chapterContent` 半成品供用户参考（与 chat 行为一致，不实现真正断点续传）。

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`

### 步骤

- [ ] **2.1 chapter-live-view.tsx 接入 ErrorCard**

修改 `apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx`：

顶部新增 import：

```tsx
import { ErrorCard } from '@/components/chat/error-card'
```

修改 `ChapterLivePanelProps`（L292-311）新增字段：

```tsx
export interface ChapterLivePanelProps {
  // ... 既有字段 ...
  error: string | null
  /** 错误后重试回调（不传则不显示重试按钮） */
  onRetry?: () => void
  /** 错误后丢弃回调（不传则不显示关闭按钮） */
  onDismissError?: () => void
  // ... 其余字段 ...
}
```

修改函数签名（L313-328）解构新增字段：

```tsx
export function ChapterLivePanel({
  // ... 既有参数 ...
  error,
  onRetry,
  onDismissError,
  // ... 其余参数 ...
}: ChapterLivePanelProps): ReactElement {
```

替换 L481-485 的错误展示为：

```tsx
{error && (
  <ErrorCard
    message={error}
    onRetry={onRetry}
    onDismiss={onDismissError}
  />
)}
```

- [ ] **2.2 novel-workspace.tsx 新增 handleRetryCreation 与 onDismissError**

修改 `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`：

定位 `handleDiscardCreation`（约 L414-420）附近，新增两个 callback：

```tsx
const handleRetryCreation = useCallback((): void => {
  if (!currentProject || creationChapterNumber == null) return
  // 与 chat handleRetry 行为一致：清空错误，重新触发全新 SSE run
  // agentOutputs 和 chapterContent 半成品保留供用户对比
  creationFlow.reset()
  void creationFlow.startCreation(currentProject.id, creationChapterNumber)
}, [currentProject, creationChapterNumber, creationFlow])

const handleDismissError = useCallback((): void => {
  creationFlow.reset()
}, [creationFlow])
```

修改 L619-634 的 `<ChapterLivePanel>` 调用，新增 props：

```tsx
<ChapterLivePanel
  ... // 既有 props
  onRetry={handleRetryCreation}
  onDismissError={handleDismissError}
/>
```

注意：`creationFlow.reset()` 是 `use-novel-creation-flow.ts` 已有的方法（L902-919），将 phase 设回 `idle` 并清空 error。

- [ ] **2.3 验证：手动模拟 SSE 失败**

在 dev 模式下，临时把 `use-novel-creation-flow.ts` 的 `runFlow` 内部 catch 块改为 `throw new Error('mock sse failure')`，确认：
1. 错误卡片显示，含"重试"按钮
2. 点"重试"重新触发 startCreation
3. 点"X 关闭"调用 reset，错误消失，agentOutputs 仍保留显示
4. 移除测试代码

- [ ] **2.4 类型检查 + commit**

运行：`pnpm --filter desktop typecheck`
预期：通过

```bash
git add apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx \
        apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx
git commit -m "feat(novel): SSE 失败错误卡片复用 chat ErrorCard，新增重试与关闭按钮"
```

---

## 任务 3：Undo/Redo 栈（zundo 中间件）

**目标：** 引入 `zundo`（zustand temporal middleware），让 `novel-store.ts` 的破坏性数据操作（upsert/remove/move 等）支持 undo/redo，UI 状态字段不进入历史栈；启用 `matrix-toolbar.tsx` 已被注释的撤销/重做按钮；新增 Cmd/Ctrl+Z 与 Cmd/Ctrl+Shift+Z 快捷键。

**文件：**
- 修改：`apps/desktop/package.json`（新增 zundo 依赖）
- 修改：`apps/desktop/src/renderer/src/stores/novel-store.ts`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-toolbar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx`
- 修改：`apps/desktop/src/renderer/src/hooks/use-shortcut.ts`
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/__tests__/novel-undo.test.ts`

### 步骤

- [ ] **3.1 安装 zundo**

运行：`pnpm --filter desktop add zundo@^2.1.0`

预期：`apps/desktop/package.json` dependencies 中新增 `"zundo": "^2.1.0"`。

- [ ] **3.2 编写失败的测试**

创建 `apps/desktop/src/renderer/src/components/novel/__tests__/novel-undo.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useNovelStore } from '@/stores/novel-store'
import type { NovelCharacter } from '@/api/novel-client'

const mockCharacter = (id: string, name: string): NovelCharacter => ({
  id,
  projectId: 'p1',
  name,
  description: '',
  identity: '',
  personality: {},
  appearance: '',
  currentState: '',
  currentGoal: '',
  currentPressure: '',
  secret: '',
  arcStage: '',
  speechStyle: '',
  createdAt: 0,
  updatedAt: 0,
} as NovelCharacter)

describe('novel-store undo/redo', () => {
  beforeEach(() => {
    useNovelStore.getState().clearProjectData()
    useNovelStore.getState().clear()
  })

  it('upsertCharacter 进入历史栈，undo 后回退', () => {
    const { upsertCharacter, undo, getState } = useNovelStore.getState()
    upsertCharacter(mockCharacter('c1', '张三'))
    expect(getState().characters).toHaveLength(1)

    undo()
    expect(getState().characters).toHaveLength(0)
  })

  it('undo 后 redo 可重做', () => {
    const { upsertCharacter, undo, redo, getState } = useNovelStore.getState()
    upsertCharacter(mockCharacter('c1', '张三'))
    undo()
    expect(getState().characters).toHaveLength(0)

    redo()
    expect(getState().characters).toHaveLength(1)
    expect(getState().characters[0].name).toBe('张三')
  })

  it('canUndo/canRedo 在栈空时为 false', () => {
    const { canUndo, canRedo } = useNovelStore.getState()
    expect(canUndo()).toBe(false)
    expect(canRedo()).toBe(false)
  })

  it('UI 状态字段不进入历史栈（setPlayheadChapter 不可 undo）', () => {
    const { setPlayheadChapter, upsertCharacter, undo, getState } = useNovelStore.getState()
    setPlayheadChapter(5)
    upsertCharacter(mockCharacter('c1', '李四'))
    undo()
    // upsertCharacter 已回退
    expect(getState().characters).toHaveLength(0)
    // playheadChapter 不应回退
    expect(getState().playheadChapter).toBe(5)
  })

  it('批量操作 clearProjectData 进入历史栈', () => {
    const { upsertCharacter, clearProjectData, undo, getState } = useNovelStore.getState()
    upsertCharacter(mockCharacter('c1', '王五'))
    upsertCharacter(mockCharacter('c2', '赵六'))
    clearProjectData()
    expect(getState().characters).toHaveLength(0)

    undo()
    expect(getState().characters).toHaveLength(2)
  })

  it('clearHistory 清空历史栈后 canUndo 为 false', () => {
    const { upsertCharacter, clearHistory, canUndo, getState } = useNovelStore.getState()
    upsertCharacter(mockCharacter('c1', '钱七'))
    expect(canUndo()).toBe(true)

    clearHistory()
    expect(canUndo()).toBe(false)
    // 数据本身不丢
    expect(getState().characters).toHaveLength(1)
  })
})
```

- [ ] **3.3 运行测试验证失败**

运行：`pnpm --filter desktop test novel-undo`
预期：FAIL，报错 `useNovelStore.getState().undo is not a function`

- [ ] **3.4 修改 novel-store.ts 接入 temporal 中间件**

修改 `apps/desktop/src/renderer/src/stores/novel-store.ts`：

L1-2 改为：

```ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { temporal } from 'zundo'
```

定位 store 创建处（约 L198 `export const useNovelStore = create<NovelState>()(` ），改为三层嵌套：

```ts
export const useNovelStore = create<NovelState>()(
  temporal(
    persist(
      (set, get) => ({
        // ... 既有所有 state 字段和 action ...

        // ── Undo/Redo API ──
        undo: () => {
          // temporal 中间件提供 getState().undo.history.undo()
          // 通过 wrapper 暴露给业务代码，避免直接接触 temporal 内部
          useNovelStore.temporal.getState().undo()
        },
        redo: () => {
          useNovelStore.temporal.getState().redo()
        },
        canUndo: () => {
          const { pastStates } = useNovelStore.temporal.getState()
          return pastStates.length > 0
        },
        canRedo: () => {
          const { futureStates } = useNovelStore.temporal.getState()
          return futureStates.length > 0
        },
        clearHistory: () => {
          useNovelStore.temporal.getState().clear()
        },
      }),
      {
        name: 'pi-agent-novel',
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({
          // ... 既有 partialize 字段（L414-441 原样保留）...
        }),
      },
    ),
    {
      // temporal 选项：限制追踪的字段，UI 状态不进入历史栈
      partialize: (state) => {
        // 仅追踪数据字段，剥离 UI 状态
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const {
          selectedNodeId, selectedNodeType, viewMode, canvasEdgeType,
          playheadChapter, creationMode, collapsedGroups, expandedVolumes,
          matrixScrollTarget, loading, error,
          // 同时剥离 actions 自身（temporal 默认会剥离函数，这里显式声明更安全）
          ...dataFields
        } = state
        return dataFields
      },
      limit: 50, // 历史栈最多 50 步
      equality: (pastState, currentState) =>
        // 浅比较：任一字段不同即视为变化
        JSON.stringify(pastState) === JSON.stringify(currentState),
    },
  ),
)
```

> **注意：** zundo 的 `temporal` 中间件默认会自动追踪所有 state 变更（除函数外），并通过 `partialize` 选项过滤要追踪的字段。这里通过第二个参数的 `partialize` 排除 UI 字段。`limit: 50` 限制内存占用。`equality` 用 JSON 字符串比较，简单可靠（数据量约 50KB，可接受）。

- [ ] **3.5 在 NovelState 接口新增 Undo/Redo API 类型**

修改 `apps/desktop/src/renderer/src/stores/novel-store.ts` 的 `NovelState` 接口，在末尾新增：

```ts
export interface NovelState {
  // ... 既有字段 ...

  // ── Undo/Redo ──
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  clearHistory: () => void
}
```

- [ ] **3.6 运行测试验证通过**

运行：`pnpm --filter desktop test novel-undo`
预期：6 个用例全部 PASS

- [ ] **3.7 启用 matrix-toolbar.tsx 的撤销/重做按钮**

修改 `apps/desktop/src/renderer/src/components/novel/matrix/matrix-toolbar.tsx`：

L6 注释改为：`// 编辑组：撤销/重做`

L90-109 取消注释，删除 `/*` 与 `*/`，得到：

```tsx
{/* 编辑组：撤销/重做 */}
<div className="flex items-center gap-0.5">
  <button
    type="button"
    className="inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 text-muted-foreground hover:text-text hover:bg-muted rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    onClick={onUndo}
    title="撤销 (Cmd/Ctrl+Z)"
    disabled={!canUndo}
  >
    <Undo2 className="size-3.5" />
  </button>
  <button
    type="button"
    className="inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 text-muted-foreground hover:text-text hover:bg-muted rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    onClick={onRedo}
    title="重做 (Cmd/Ctrl+Shift+Z)"
    disabled={!canRedo}
  >
    <Redo2 className="size-3.5" />
  </button>
</div>
```

- [ ] **3.8 matrix-workspace.tsx 接入 undo/redo state**

修改 `apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx`：

定位 `MatrixToolbar` 调用处（搜索 `<MatrixToolbar`），新增 4 个 props：

```tsx
<MatrixToolbar
  // ... 既有 props ...
  canUndo={useNovelStore((s) => s.canUndo())}
  canRedo={useNovelStore((s) => s.canRedo())}
  onUndo={useNovelStore((s) => s.undo)}
  onRedo={useNovelStore((s) => s.redo)}
/>
```

> **注意：** 直接在 JSX 内调用 `useNovelStore` 会触发组件级订阅。建议在组件顶部提取：

```tsx
const canUndo = useNovelStore((s) => s.canUndo())
const canRedo = useNovelStore((s) => s.canRedo())
const undo = useNovelStore((s) => s.undo)
const redo = useNovelStore((s) => s.redo)
```

但 `canUndo()` 是函数调用，需改为订阅派生值：

```tsx
// 修改方案：让 store 暴露 pastStates.length 作为派生值
// 在 novel-store.ts 新增字段
const undoCount = useNovelStore((s) => s.undoCount)
const redoCount = useNovelStore((s) => s.redoCount)
```

修订 `novel-store.ts`，新增派生字段：

```ts
// 在 temporal 中间件选项中订阅 history 变化
{
  // ... 既有选项 ...
  onUpdate: () => {
    // temporal 内部 state 变化时同步到主 store 的派生字段
    const { pastStates, futureStates } = useNovelStore.temporal.getState()
    useNovelStore.setState({
      undoCount: pastStates.length,
      redoCount: futureStates.length,
    })
  },
}
```

并在 `NovelState` 新增：

```ts
undoCount: number
redoCount: number
```

初始化为 0。

matrix-workspace.tsx 改为：

```tsx
const undoCount = useNovelStore((s) => s.undoCount)
const redoCount = useNovelStore((s) => s.redoCount)
const undo = useNovelStore((s) => s.undo)
const redo = useNovelStore((s) => s.redo)

<MatrixToolbar
  // ... 既有 props ...
  canUndo={undoCount > 0}
  canRedo={redoCount > 0}
  onUndo={undo}
  onRedo={redo}
/>
```

- [ ] **3.9 use-shortcut.ts 新增 onUndo/onRedo 回调**

修改 `apps/desktop/src/renderer/src/hooks/use-shortcut.ts`：

L6-29 `ShortcutHandlers` 接口新增：

```ts
export interface ShortcutHandlers {
  // ... 既有字段 ...
  onUndo?: () => void
  onRedo?: () => void
}
```

在 hook 体内（L74-126 之间，参考既有 useHotkeys 调用模式）新增：

```ts
useHotkeys('mod+z', (e) => {
  if (isEditableTarget(e)) return
  e.preventDefault()
  handlersRef.current.onUndo?.()
}, { enableOnFormTags: false }, [])

useHotkeys(['mod+shift+z', 'mod+y'], (e) => {
  if (isEditableTarget(e)) return
  e.preventDefault()
  handlersRef.current.onRedo?.()
}, { enableOnFormTags: false }, [])
```

> **注意：** `isEditableTarget` 守卫已存在（L36-46），保证 Tiptap 编辑器内的 Cmd+Z 仍走 ProseMirror 自己的 undo，不被全局 hook 拦截。`enableOnFormTags: false` 是 react-hotkeys-hook 的选项，进一步防止在 INPUT/TEXTAREA 中触发。

- [ ] **3.10 novel-workspace.tsx 注册快捷键**

修改 `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`：

定位 `useShortcut` 调用（如有），新增 `onUndo/onRedo` 回调；如未调用，则在工作区组件顶部新增：

```tsx
useShortcut({
  // ... 既有 handlers（如有）...
  onUndo: () => useNovelStore.getState().undo(),
  onRedo: () => useNovelStore.getState().redo(),
})
```

> **注意：** novel-workspace 此前未调用 useShortcut，本步骤首次接入。需要确认 useShortcut 的 handlers 在 novel 视图激活时才生效（避免与 chat 视图的快捷键冲突）。建议在 use-shortcut.ts 内增加 view 判断，或在 novel-workspace 内部条件性调用（如 `if (currentView === 'novel') useShortcut(...)`）。当前 App.tsx 用 view 路由，novel-workspace 仅在 novel 视图挂载，因此 useShortcut 自然只在 novel 视图激活，无需额外守卫。

- [ ] **3.11 验证：手动测试 undo/redo**

dev 模式启动应用，在矩阵视图：
1. 拖动一个角色到第 3 章（标记出场）
2. 拖动一个冲突端点
3. 按 Cmd/Ctrl+Z，确认最近一次操作回退（端点恢复原位）
4. 再按 Cmd/Ctrl+Z，确认角色出场被移除
5. 按 Cmd/Ctrl+Shift+Z，确认重做
6. 点工具栏撤销按钮，确认与快捷键效果一致
7. 在 Tiptap 编辑器内输入文字，按 Cmd+Z，确认走编辑器自身 undo（不影响 store 数据）

- [ ] **3.12 类型检查 + commit**

运行：`pnpm --filter desktop typecheck`
预期：通过

```bash
git add apps/desktop/package.json pnpm-lock.yaml \
        apps/desktop/src/renderer/src/stores/novel-store.ts \
        apps/desktop/src/renderer/src/components/novel/matrix/matrix-toolbar.tsx \
        apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx \
        apps/desktop/src/renderer/src/hooks/use-shortcut.ts \
        apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx \
        apps/desktop/src/renderer/src/components/novel/__tests__/novel-undo.test.ts
git commit -m "feat(novel): 引入 zundo 实现 undo/redo 栈，启用矩阵工具栏按钮与 Cmd+Z 快捷键"
```

---

## 任务 4：矩阵水平虚拟化（章节列虚拟化）

**目标：** 在 `matrix-view.tsx` 引入 `@tanstack/react-virtual`（项目已安装）对章节列做水平虚拟化，>100 章节时只渲染可见列 + 缓冲列，DOM 节点数从 `O(entities × chapters)` 降为 `O(entities × visibleChapters)`。

**文件：**
- 创建：`apps/desktop/src/renderer/src/lib/matrix-viewport.ts`
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-horizontal-virtualization.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx`

### 步骤

- [ ] **4.1 编写视口计算纯函数 + 测试**

创建 `apps/desktop/src/renderer/src/lib/matrix-viewport.ts`：

```ts
/**
 * 矩阵视口计算纯函数
 *
 * 水平虚拟化：根据 scrollLeft / viewportWidth / cellWidth 计算可见章节列范围
 * 与 @tanstack/react-virtual 的 useVirtualizer 思路一致，但更轻量
 */

export interface VisibleRange {
  start: number // 起始章节号（1-based，含）
  end: number // 结束章节号（1-based，含）
  count: number // 可见列数
}

export interface ComputeVisibleChaptersParams {
  scrollLeft: number
  viewportWidth: number
  sidebarWidth: number
  cellWidth: number
  maxChapter: number
  overscan?: number // 两侧缓冲列数，默认 2
}

export function computeVisibleChapters(params: ComputeVisibleChaptersParams): VisibleRange {
  const { scrollLeft, viewportWidth, sidebarWidth, cellWidth, maxChapter, overscan = 2 } = params

  if (maxChapter <= 0 || cellWidth <= 0) {
    return { start: 1, end: 0, count: 0 }
  }

  // 内容区起始 x = sidebarWidth，章节列从 sidebarWidth 开始排布
  // 章节号 N 的 left = sidebarWidth + (N - 1) * cellWidth
  // 可见区 left = scrollLeft，right = scrollLeft + viewportWidth

  // 左侧第一个可见章节号（不考虑 sidebar）
  const contentScrollLeft = Math.max(0, scrollLeft - sidebarWidth)
  let startIdx = Math.floor(contentScrollLeft / cellWidth) // 0-based
  // 右侧最后一个可见章节号
  const visibleContentWidth = Math.max(0, viewportWidth - Math.max(0, sidebarWidth - scrollLeft))
  let endIdx = Math.floor((contentScrollLeft + visibleContentWidth) / cellWidth)

  // 加 overscan 缓冲
  startIdx = Math.max(0, startIdx - overscan)
  endIdx = Math.min(maxChapter - 1, endIdx + overscan)

  if (startIdx > endIdx) {
    return { start: 1, end: 0, count: 0 }
  }

  const start = startIdx + 1 // 1-based
  const end = endIdx + 1
  return { start, end, count: end - start + 1 }
}

/**
 * 计算章节列在内容区内的 left 偏移
 */
export function getChapterLeft(chapter: number, sidebarWidth: number, cellWidth: number): number {
  return sidebarWidth + (chapter - 1) * cellWidth
}
```

创建 `apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-horizontal-virtualization.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { computeVisibleChapters, getChapterLeft } from '@/lib/matrix-viewport'

describe('computeVisibleChapters', () => {
  const base = {
    sidebarWidth: 200,
    cellWidth: 36,
    maxChapter: 100,
  }

  it('scrollLeft=0 时返回前 N 个可见章节', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 0, viewportWidth: 800, overscan: 0 })
    // 0 - 200 = -200 → max(0) = 0; 可见宽度 = 800 - max(0, 200-0) = 600
    // startIdx = 0; endIdx = floor(600/36) = 16
    expect(r.start).toBe(1)
    expect(r.end).toBe(17) // 0-based 0..16 = 1..17
  })

  it('scrollLeft=500 时跳过左侧不可见章节', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 500, viewportWidth: 800, overscan: 0 })
    // contentScrollLeft = max(0, 500-200) = 300
    // startIdx = floor(300/36) = 8
    // visibleContentWidth = 800 - max(0, 200-500) = 800
    // endIdx = floor((300+800)/36) = floor(1100/36) = 30
    expect(r.start).toBe(9)
    expect(r.end).toBe(31)
  })

  it('overscan 默认 2，前后各加 2 列缓冲', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 0, viewportWidth: 800 })
    // 不带 overscan: start=1, end=17
    // 带 overscan=2: start=max(1, 1-2)=1, end=min(100, 17+2)=19
    expect(r.start).toBe(1)
    expect(r.end).toBe(19)
  })

  it('overscan 不超过边界', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 0, viewportWidth: 800, overscan: 100 })
    expect(r.start).toBe(1)
    expect(r.end).toBe(100)
  })

  it('scrollLeft 超出内容时返回空', () => {
    const r = computeVisibleChapters({ ...base, scrollLeft: 99999, viewportWidth: 800 })
    expect(r.count).toBe(0)
  })

  it('maxChapter=0 返回空', () => {
    const r = computeVisibleChapters({ ...base, maxChapter: 0, scrollLeft: 0, viewportWidth: 800 })
    expect(r.count).toBe(0)
  })
})

describe('getChapterLeft', () => {
  it('章节 1 的 left = sidebarWidth', () => {
    expect(getChapterLeft(1, 200, 36)).toBe(200)
  })

  it('章节 N 的 left = sidebarWidth + (N-1) * cellWidth', () => {
    expect(getChapterLeft(5, 200, 36)).toBe(200 + 4 * 36)
  })
})
```

- [ ] **4.2 运行测试验证纯函数通过**

运行：`pnpm --filter desktop test matrix-horizontal-virtualization`
预期：8 个用例全部 PASS（纯函数先验证正确性，再接入 view）

- [ ] **4.3 修改 matrix-view.tsx 接入水平虚拟化**

修改 `apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx`：

顶部新增 import：

```tsx
import { computeVisibleChapters } from '@/lib/matrix-viewport'
```

定位 `chapterColumns` useMemo（L115-119），保留作为全量列表用于虚拟化计算：

```tsx
const chapterColumns = useMemo(() => {
  const cols: number[] = []
  for (let i = 1; i <= maxChapter; i++) cols.push(i)
  return cols
}, [maxChapter])
```

在 hook 顶部新增视口状态：

```tsx
const [visibleRange, setVisibleRange] = useState<{ start: number; end: number }>({
  start: 1,
  end: Math.min(maxChapter, 20), // 初始渲染前 20 列
})

// 监听 maxChapter 变化时重置视口
useEffect(() => {
  setVisibleRange({ start: 1, end: Math.min(maxChapter, 20) })
}, [maxChapter])
```

修改 onScroll 处理函数（L232-238），在原有 sticky title 同步逻辑后追加视口计算：

```tsx
onScroll={(e) => {
  const el = e.currentTarget
  const x = el.scrollLeft
  // 原有 sticky title 同步逻辑
  const els = el.querySelectorAll<HTMLElement>('[data-sticky-title]')
  for (let i = 0; i < els.length; i++) {
    els[i].style.transform = `translateX(${x}px)`
  }
  // 新增：水平虚拟化视口计算
  const range = computeVisibleChapters({
    scrollLeft: x,
    viewportWidth: el.clientWidth,
    sidebarWidth: SIDEBAR_W,
    cellWidth,
    maxChapter,
    overscan: 3,
  })
  setVisibleRange((prev) => {
    if (prev.start === range.start && prev.end === range.end) return prev
    return { start: range.start, end: range.end }
  })
}}
```

新增派生数据：

```tsx
const visibleChapterColumns = useMemo(() => {
  if (visibleRange.start > visibleRange.end) return []
  return chapterColumns.slice(visibleRange.start - 1, visibleRange.end)
}, [chapterColumns, visibleRange])
```

修改标尺行（L297-329），将 `chapterColumns.map` 改为 `visibleChapterColumns.map`：

```tsx
{/* 章节标尺单元格（仅渲染可见列） */}
<div className="flex">
  {/* 左侧占位：撑开滚动条到第一个可见章节的位置 */}
  {visibleRange.start > 1 && (
    <div style={{ width: `${(visibleRange.start - 1) * cellWidth}px` }} aria-hidden="true" />
  )}
  {visibleChapterColumns.map((ch) => {
    // ... 原有渲染逻辑不变 ...
  })}
  {/* 右侧占位：撑开滚动条到最后一个可见章节之后的位置 */}
  {visibleRange.end < maxChapter && (
    <div style={{ width: `${(maxChapter - visibleRange.end) * cellWidth}px` }} aria-hidden="true" />
  )}
</div>
```

> **关键：** 用左右两个空 div 占位，保持 `totalWidth` 不变，浏览器仍能正确显示水平滚动条。sticky 左列（实体名）和 sticky 标尺行不受影响。

修改 `GroupBlock` 内的章节列循环（同样替换为 `visibleChapterColumns` + 左右占位）。需要把 `chapterColumns` prop 改为 `visibleChapterColumns` + `visibleRange` + `maxChapter`，由 GroupBlock 内部计算占位。

具体方案：`GroupBlock` 接收 `visibleChapterColumns: number[]` / `visibleRange: { start, end }` / `maxChapter: number` 三个 prop，渲染时：
- 行首左占位：`<div style={{ width: (visibleRange.start - 1) * cellWidth }} />`
- 中间可见列：`visibleChapterColumns.map(...)` （原 `chapterColumns.map` 替换）
- 行尾右占位：`<div style={{ width: (maxChapter - visibleRange.end) * cellWidth }} />`

- [ ] **4.4 验证：100 章 × 50 实体性能测试**

dev 模式启动应用，创建测试项目：
- 手动或用脚本插入 50 个角色 + 100 个章节
- 进入矩阵视图
- 打开 Chrome DevTools Performance 面板
- 横向滚动矩阵，确认：
  1. DOM 节点数稳定在约 50 × 25 = 1250（可见列 + overscan）
  2. 滚动帧率 ≥ 50fps
  3. 当前章节列高亮带跟随正常
  4. 拖入实体到章节列仍正常工作
  5. 标尺章节号正确显示

- [ ] **4.5 类型检查 + commit**

运行：`pnpm --filter desktop typecheck`
预期：通过

```bash
git add apps/desktop/src/renderer/src/lib/matrix-viewport.ts \
        apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-horizontal-virtualization.test.ts \
        apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx
git commit -m "perf(novel): 矩阵水平虚拟化，>100 章节时 DOM 节点从 O(N*M) 降至 O(N*visibleM)"
```

---

## 任务 5：矩阵垂直虚拟化（可选第二阶段）

**目标：** 进一步对实体行做垂直虚拟化，>100 实体时只渲染可见行 + 缓冲行。需要扁平化 `groups` 为 `flatRows`，使用 `@tanstack/react-virtual` 的 `useVirtualizer`。

> **本任务为可选项。** 任务 4 完成后，若实际使用中实体数未超过 100，可暂缓本任务。若性能仍不达标再启动。

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-vertical-virtualization.test.ts`

### 步骤

- [ ] **5.1 编写 flatRows 扁平化纯函数 + 测试**

在 `apps/desktop/src/renderer/src/components/novel/matrix/matrix-logic.ts` 新增：

```ts
export interface FlatRow {
  type: 'group-header' | 'entity-row'
  group?: MatrixGroup // type='group-header' 时填充
  entity?: MatrixEntity // type='entity-row' 时填充
  groupId: string
}

export function flattenGroups(
  groups: MatrixGroup[],
  collapsedGroups: Set<string>,
): FlatRow[] {
  const rows: FlatRow[] = []
  for (const group of groups) {
    rows.push({ type: 'group-header', group, groupId: group.id })
    if (collapsedGroups.has(group.id)) continue
    for (const entity of group.entities) {
      rows.push({ type: 'entity-row', entity, groupId: group.id })
    }
  }
  return rows
}
```

测试文件 `matrix-vertical-virtualization.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { flattenGroups } from '../matrix-logic'
import type { MatrixGroup } from '../matrix-logic'

const mockGroup = (id: string, entityCount: number): MatrixGroup => ({
  id,
  name: id,
  entities: Array.from({ length: entityCount }, (_, i) => ({
    entityId: `${id}-e${i}`,
    entityType: 'character',
    name: `Entity ${i}`,
  } as any)),
} as any)

describe('flattenGroups', () => {
  it('未折叠时 group header + 全部 entity rows', () => {
    const groups = [mockGroup('char', 3)]
    const rows = flattenGroups(groups, new Set())
    expect(rows).toHaveLength(4) // 1 header + 3 entity
    expect(rows[0].type).toBe('group-header')
    expect(rows[1].type).toBe('entity-row')
  })

  it('折叠时只保留 group header', () => {
    const groups = [mockGroup('char', 3)]
    const rows = flattenGroups(groups, new Set(['char']))
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('group-header')
  })

  it('多分组混合折叠状态', () => {
    const groups = [mockGroup('char', 2), mockGroup('conflict', 3)]
    const rows = flattenGroups(groups, new Set(['char']))
    expect(rows).toHaveLength(4) // char header + char 折叠 + conflict header + 3 entity
    expect(rows[0].groupId).toBe('char')
    expect(rows[0].type).toBe('group-header')
    expect(rows[1].groupId).toBe('conflict')
    expect(rows[1].type).toBe('group-header')
  })
})
```

- [ ] **5.2 运行测试验证 flattenGroups 通过**

运行：`pnpm --filter desktop test matrix-vertical-virtualization`
预期：3 个用例 PASS

- [ ] **5.3 修改 matrix-view.tsx 接入 useVirtualizer**

参考 `apps/desktop/src/renderer/src/components/chat/session-list.tsx` L8-115 的实现模式（项目已用 `@tanstack/react-virtual`）。

在 matrix-view.tsx 顶部新增 import：

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'
import { flattenGroups, type FlatRow } from './matrix-logic'
```

新增 hook 内部状态：

```tsx
const ROW_HEIGHT = 32 // 实体行高
const GROUP_HEADER_HEIGHT = 28 // 分组标题行高

const flatRows = useMemo(
  () => flattenGroups(groups, collapsedGroups),
  [groups, collapsedGroups],
)

const rowVirtualizer = useVirtualizer({
  count: flatRows.length,
  getScrollElement: () => scrollContainerRef.current,
  estimateSize: (idx) =>
    flatRows[idx].type === 'group-header' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT,
  overscan: 8,
})
```

替换原 `groups.map` 渲染为 `rowVirtualizer.getVirtualItems().map`：

```tsx
<div
  style={{
    height: `${rowVirtualizer.getTotalSize()}px`,
    width: `${totalWidth}px`,
    position: 'relative',
  }}
>
  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
    const row = flatRows[virtualRow.index]
    return (
      <div
        key={virtualRow.key}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          transform: `translateY(${virtualRow.start}px)`,
          width: '100%',
          height: `${virtualRow.size}px`,
        }}
      >
        {row.type === 'group-header' ? (
          <GroupHeaderRow group={row.group!} ... />
        ) : (
          <EntityRow entity={row.entity!} ... />
        )}
      </div>
    )
  })}
</div>
```

> **关键：** 垂直虚拟化用 `position: absolute` + `transform: translateY` 定位每行，参考 session-list.tsx 模式。sticky 标尺行仍用 `sticky top-0`。原有 onScroll 内的 sticky title 同步逻辑保留。

- [ ] **5.4 验证：200 实体 × 100 章节性能测试**

dev 模式创建测试项目：
- 插入 200 个角色 + 100 个章节
- 进入矩阵视图
- 纵向 + 横向滚动，确认：
  1. DOM 节点数稳定在约 30（可见行）× 25（可见列）= 750
  2. 滚动帧率 ≥ 50fps
  3. 拖拽、右键菜单、端点拖动仍正常
  4. 当前章节列高亮带、闪烁反馈仍正常

- [ ] **5.5 类型检查 + commit**

运行：`pnpm --filter desktop typecheck`
预期：通过

```bash
git add apps/desktop/src/renderer/src/components/novel/matrix/matrix-logic.ts \
        apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-vertical-virtualization.test.ts \
        apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx
git commit -m "perf(novel): 矩阵垂直虚拟化，>100 实体时按可见行渲染"
```

---

## 自检清单

### 1. 规格覆盖度

| 用户提出的薄弱点 | 对应任务 | 状态 |
|----------------|---------|------|
| 全局零 undo/redo | 任务 3 | 已覆盖（zundo 中间件 + 工具栏按钮 + 快捷键） |
| 创作流程错误无重试按钮 | 任务 2 | 已覆盖（复用 ErrorCard + onRetry） |
| 工作区无 ErrorBoundary | 任务 1 | 已覆盖（4 个子区域局部包裹） |
| 矩阵视图无虚拟化 | 任务 4 + 5 | 已覆盖（水平虚拟化必做，垂直可选） |
| SSE 中断无会话恢复 | 任务 2（部分） | 已覆盖（与 chat 行为一致，不实现真正断点续传） |
| 矩阵无文本搜索 | 未覆盖 | 本计划聚焦"容错与体验补强"，搜索为独立功能，留待后续 |
| 零快捷键（novel） | 任务 3.9-3.10 | 已覆盖 undo/redo 快捷键，其他快捷键留待后续 |
| 零 i18n | 未覆盖 | 与本计划无关，留待后续 |
| a11y 缺口 | 任务 1.1-1.3 | 部分覆盖（fallback UI 含 role/aria-live），其他 a11y 留待后续 |
| 乐观更新回滚 | 任务 3 | 间接覆盖（undo 可回退 API 失败导致的 store 不一致） |

### 2. 占位符扫描

- ✅ 无 "TODO"、"待定"、"后续实现"
- ✅ 无 "添加适当的错误处理"（具体代码已给出）
- ✅ 无 "为上述代码编写测试"（测试代码已完整）
- ✅ 无 "类似任务 N"
- ✅ 所有代码步骤都包含完整代码块

### 3. 类型一致性

- `MatrixErrorFallback` props 在任务 1.1 定义，在任务 1.4 使用：`error / reset / onSwitchToCanvas` ✅
- `CanvasErrorFallback` props 一致 ✅
- `CreationErrorFallback` props 一致 ✅
- `ChapterLivePanelProps` 在任务 2.1 新增 `onRetry?` / `onDismissError?`，在任务 2.2 使用 ✅
- `useNovelStore` 在任务 3.4-3.5 新增 `undo() / redo() / canUndo() / canRedo() / clearHistory() / undoCount / redoCount`，在任务 3.8/3.10 使用 ✅
- `MatrixToolbarProps` 已有 `canUndo/canRedo/onUndo/onRedo`（L31-35），任务 3.7 仅启用注释，无需改接口 ✅
- `ShortcutHandlers` 在任务 3.9 新增 `onUndo?/onRedo?`，在任务 3.10 使用 ✅
- `computeVisibleChapters` 在任务 4.1 定义，在任务 4.3 使用，参数名一致 ✅
- `flattenGroups` / `FlatRow` 在任务 5.1 定义，在任务 5.3 使用 ✅

### 4. 已知风险与缓解

| 风险 | 缓解 |
|------|------|
| zundo 与 persist 共存可能导致历史栈被持久化 | temporal 中间件在 persist 外层，temporal 自身 state 不被 persist 序列化（zundo 默认不持久化 pastStates） |
| undo 后 store 数据与后端 DB 不一致 | 本计划不解决"乐观更新回滚到后端"，undo 仅回退本地 store；如需同步后端，需在 undo 后调用 API 反向操作（留作后续） |
| 矩阵虚拟化破坏 sticky 同步逻辑 | onScroll 内 `querySelectorAll('[data-sticky-title]')` 仅对可见行操作，但虚拟化后行被卸载，可能漏掉；任务 4.3 保留原逻辑，若实测异常再改为 CSS sticky + transform |
| ErrorBoundary 包裹后子组件 state 丢失 | reset 后子组件重新挂载，本地 state 丢失是预期行为；矩阵视图持久化字段（collapsedGroups 等）在 store 中，重置不丢失 |
| useShortcut 在 novel 视图与其他视图快捷键冲突 | App.tsx 路由切换，novel 视图独占挂载，无冲突 |

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-07-04-novel-frontend-resilience.md`。

两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
