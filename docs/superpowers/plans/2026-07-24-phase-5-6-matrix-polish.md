# Phase 5-6：矩阵渐进展示与工作台细节打磨实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不破坏既有矩阵双向虚拟化、拖拽编排和小说创作流程的前提下，完成矩阵渐进展示、性能基准与交互反馈，并补齐小说工作台的加载、对话、滚动和导航细节。

**架构：** Phase 5 以纯函数测试保护矩阵行模型和可视窗口，再将行点击展开、播放头竖线、可配置虚拟化和拖拽拒绝态接入现有 `MatrixView`。Phase 6 先抽取共享的消息分组和回到底部行为，再让小说共享会话与通用聊天分别消费，最后补齐 Skeleton、Checkpoint 类型边界、滚动条与导航 Rail 微交互。所有新行为遵循 test-first，并保留现有 `prefers-reduced-motion` 约束。

**技术栈：** React 19、TypeScript、Vitest、Testing Library、Zustand、Framer Motion、dnd-kit、Tailwind CSS 4。

---

## 变更文件与职责

### Phase 5：矩阵渐进展示与性能

- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts`
  - 为行模型导出可测试的“单焦点展开”辅助函数，保持 `buildRowSpecs` 的可变行高行为。
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-model.test.ts`
  - 覆盖子轨道默认收起、行展开后的高度、前缀偏移和纵向窗口边界。
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx`
  - 让支持子轨道的实体行在非交互区点击时切换展开；保留单元格、拖拽手柄、右键菜单的原有行为。
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx`
  - 接入行点击展开、运行时性能配置、rAF 合并滚动计算、播放头仅竖线、非法拖放拒绝态和无动画虚拟行更新。
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx`
  - 接收横向可视章节范围，裁剪可见子轨道 SVG 节点和跨度，避免可见行随总章节数线性增长。
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx`
  - 将 Enter 键与当前选中、支持子轨道的实体绑定为展开/收起；同步 `MatrixView` 新增 props。
- 修改：`apps/desktop/src/renderer/src/config/performance.ts`
  - 仅在现有 `runtimePerformance.matrix` 中补充 `overscanRows`，统一矩阵横纵 overscan 来源。
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-performance-fixture.ts`
  - 提供固定的 100 实体、80 章节、10 个展开子轨道数据工厂，供逻辑性能与回归测试复用。
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-vertical-virtualization.test.ts`
  - 覆盖展开后可变行高、深滚动窗口、上下 spacer 和可见章节裁剪。
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx`
  - 覆盖行点击、Enter 展开、播放头样式与非法拖放反馈。

### Phase 6：共享对话、加载与导航细节

- 创建：`apps/desktop/src/renderer/src/components/ui/skeleton.tsx`
  - 提供带 `aria-hidden` 且遵从减弱动效的最小 Skeleton 基础组件。
- 修改：`apps/desktop/src/renderer/src/components/chat/message-stream.tsx`
  - 复用消息分组、流式首 token Skeleton、流式光标和“回到底部”按钮。
- 修改：`apps/desktop/src/renderer/src/components/chat/message-bubble.tsx`
  - 让通用聊天在 `status === 'streaming'` 时显示与小说会话一致的文字尾随光标。
- 修改：`apps/desktop/src/renderer/src/components/chat/streaming-indicator.tsx`
  - 移除硬编码示例文本，仅显示无障碍状态提示和通用等待描述。
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/message-groups.ts`
  - 用纯函数生成日期分隔和连续同来源消息组；不改变 `ConversationMessage` 存储类型。
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/scroll-follow.ts`
  - 封装距底部阈值、rAF 批量滚动和 ResizeObserver 监听，供两套消息流复用。
- 修改：`apps/desktop/src/renderer/src/components/shared/conversation/types.ts`
  - 导出严格的 `CheckpointAction` 联合类型，替代裸 `string` 回调边界。
- 修改：`apps/desktop/src/renderer/src/components/shared/conversation/checkpoint-message.tsx`
  - 使用严格 checkpoint action，展示已决策选项标签与完整选项上下文；按钮使用 `active:scale-[0.97]`。
- 修改：`apps/desktop/src/renderer/src/components/shared/conversation/conversation-stream.tsx`
  - 使用消息分组和共享滚动跟随；增加“新消息 / 回到底部”按钮及动态内容高度跟随。
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/__tests__/message-groups.test.ts`
  - 覆盖同来源连续分组、checkpoint/system 断组和跨天日期分隔。
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/__tests__/checkpoint-message.test.tsx`
  - 覆盖按钮决策、严格 action 回调、已解决态和完整决策回显。
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/__tests__/conversation-stream.test.tsx`
  - 覆盖空态、上滚停止自动跟随、回到底部按钮和新消息提示。
- 修改：`apps/desktop/src/renderer/src/assets/main.css`
  - 增加 Skeleton、滚动条容器类、`scrollbar-gutter` 和 `forced-colors: active` 样式；不再以全局选择器为关键消息流滚动条提供唯一行为。
- 修改：`apps/desktop/src/renderer/src/App.tsx`
  - 提取可测试的 `RailButton`，使用延迟 Tooltip，active 使用主色圆点且保留键盘焦点反馈。
- 创建：`apps/desktop/src/renderer/src/components/navigation/rail-button.tsx`
  - 承担主导航单项的 Tooltip、active 指示、ARIA 和按压反馈。
- 创建：`apps/desktop/src/renderer/src/components/navigation/__tests__/rail-button.test.tsx`
  - 覆盖 active 圆点、延迟 Tooltip 和键盘焦点可达性。

---

### 任务 1：先保护矩阵行模型和纵向虚拟化

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts`

- [ ] **步骤 1：编写行模型失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  MATRIX_LAYOUT,
  buildRowSpecs,
  computeRowOffsets,
  computeVisibleRowWindow,
} from '../matrix-model'

const entity = { id: 'row-1', entityId: 'entity-1', name: '沈砚', kind: 'character' } as never
const group = { id: 'character', label: '角色', entities: [entity] } as never

describe('矩阵行模型', () => {
  it('未传入展开实体时只生成分组和实体行', () => {
    const rows = buildRowSpecs({
      groups: [group],
      collapsedGroups: new Set(),
      activeFilter: null,
      expandedTrackCounts: new Map(),
    })

    expect(rows.map((row) => row.type)).toEqual(['group', 'entity'])
  })

  it('展开实体时插入按轨道数计算高度的子轨道行', () => {
    const rows = buildRowSpecs({
      groups: [group],
      collapsedGroups: new Set(),
      activeFilter: null,
      expandedTrackCounts: new Map([['entity-1', 3]]),
    })

    expect(rows[2]).toMatchObject({
      type: 'subtracks',
      key: 'subtracks:row-1',
      height: MATRIX_LAYOUT.subtrackHeight * 3,
    })
  })

  it('深滚动时返回包含可见行的纵向窗口与 overscan', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      type: 'entity' as const,
      key: `entity:${index}`,
      entity,
      height: MATRIX_LAYOUT.entityHeight,
    }))
    const offsets = computeRowOffsets(rows)

    expect(computeVisibleRowWindow({
      offsets,
      rows,
      scrollTop: MATRIX_LAYOUT.entityHeight * 20,
      viewportHeight: MATRIX_LAYOUT.entityHeight * 2,
      overscan: 2,
    })).toEqual({ start: 18, end: 25 })
  })
})
```

- [ ] **步骤 2：运行失败测试确认基线**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/novel/matrix/__tests__/matrix-model.test.ts
```

预期：若测试文件引用、fixture 类型或窗口断言与现状不符，先将测试修正为描述当前目标行为；最终必须看到红灯，原因应为未覆盖的行模型边界或实现缺陷，而非 TypeScript 配置错误。

- [ ] **步骤 3：以最小改动修正行模型并补全类型化 fixture**

在测试中不要使用 `as never` 逃避类型。改为从 `matrix-logic.ts` 导入 `MatrixEntity`、`MatrixGroup`，构造仅含必需字段的 helper：

```ts
function createEntity(id: string): MatrixEntity {
  return {
    id,
    entityId: id,
    name: `实体 ${id}`,
    kind: 'character',
    chapterSpans: [],
  }
}
```

如窗口边界与实现定义不同，只调整 `computeVisibleRowWindow` 的边界逻辑，使其满足“首个可见行减 overscan、末个可见行加 1 加 overscan、范围不越界”的语义；不要引入新的虚拟化库。

- [ ] **步骤 4：运行测试确认通过**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/novel/matrix/__tests__/matrix-model.test.ts
```

预期：PASS，3 个测试通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-model.test.ts
git commit -m "test(matrix): cover row model virtualization"
```

### 任务 2：把实体行和键盘 Enter 接到渐进展开

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx`

- [ ] **步骤 1：编写行点击与 Enter 的失败测试**

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { EntityRow } from '../matrix-row'

it('点击实体名称区时展开支持子轨道的实体', () => {
  const onToggleExpand = vi.fn()
  render(
    <EntityRow
      entity={{ id: 'row-1', entityId: 'entity-1', name: '沈砚', kind: 'character', chapterSpans: [] } as never}
      cellWidth={48}
      sidebarWidth={220}
      visibleChapterColumns={[1, 2]}
      playheadChapter={1}
      selected={false}
      expanded={false}
      onSelect={vi.fn()}
      onToggleExpand={onToggleExpand}
    />,
  )

  fireEvent.click(screen.getByText('沈砚'))
  expect(onToggleExpand).toHaveBeenCalledWith('entity-1')
})
```

在同一文件中，为 `MatrixWorkspace` 的键盘 handler 增加测试，目标为：已选中支持子轨道的实体时按 Enter 调用 `toggleEntityExpand`；焦点位于输入控件时不得触发。

- [ ] **步骤 2：运行失败测试确认行为尚未存在**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx
```

预期：FAIL，实体名点击目前只触发选择，不会调用 `onToggleExpand`；Enter handler 不存在。

- [ ] **步骤 3：实现不干扰单元格和拖拽的展开入口**

在 `EntityRow` 的名称区点击处理里：

```ts
const handleLabelClick = () => {
  onSelect()
  if (isSubtrackSupported(entity.kind)) onToggleExpand?.(entity.entityId)
}
```

保留 chevron 按钮，但其点击必须继续 `event.stopPropagation()`，避免一次点击切换两次。对单元格、span、endpoint、右键菜单和拖拽源的事件处理全部保持原样。

在 `MatrixWorkspace` 增加 Enter 热键，满足：

```ts
useHotkeys('enter', (event) => {
  if (!selectedMatrixEntityId || !selectedEntitySupportsSubtracks) return
  event.preventDefault()
  toggleEntityExpand(selectedMatrixEntityId)
}, hotkeyOpts, [selectedMatrixEntityId, selectedEntitySupportsSubtracks, toggleEntityExpand])
```

选择目标必须从当前 `selectedMatrixEntityIds` 和可见矩阵实体解析，不能以 DOM 查询代替 store 数据。

- [ ] **步骤 4：运行测试确认通过**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx
```

预期：PASS，行点击与 Enter 行为均通过，单元格交互回归不受影响。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx
git commit -m "feat(matrix): expand subtracks from row focus"
```

### 任务 3：统一矩阵运行时性能配置并建立 100×80×10 基准 fixture

**文件：**
- 修改：`apps/desktop/src/renderer/src/config/performance.ts`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-performance-fixture.ts`
- 创建：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-vertical-virtualization.test.ts`
- 修改：`apps/desktop/src/renderer/src/__tests__/performance.test.ts`

- [ ] **步骤 1：编写失败的性能配置与纵向窗口测试**

```ts
import { expect, it } from 'vitest'
import { runtimePerformance } from '@/config/performance'
import { createMatrixPerformanceFixture } from './matrix-performance-fixture'

it('矩阵性能配置提供行 overscan，并保持横向默认 3 列', () => {
  expect(runtimePerformance.matrix.overscanColumns).toBe(3)
  expect(runtimePerformance.matrix.overscanRows).toBe(6)
})

it('100 实体、80 章、10 个子轨道展开时窗口只返回局部行', () => {
  const fixture = createMatrixPerformanceFixture()
  expect(fixture.rows).toHaveLength(120)
  expect(fixture.visibleWindow.end - fixture.visibleWindow.start).toBeLessThan(30)
})
```

fixture 必须构造：10 个分组、每组 10 个实体、80 章数字、前 10 个实体各 3 条子轨道。按真实 `buildRowSpecs`、`computeRowOffsets`、`computeVisibleRowWindow` 生成 `rows` 与 `visibleWindow`，禁止硬编码窗口结果。

- [ ] **步骤 2：运行失败测试确认 `overscanRows` 和 fixture 缺失**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/__tests__/performance.test.ts src/renderer/src/components/novel/matrix/__tests__/matrix-vertical-virtualization.test.ts
```

预期：FAIL，报错为 `overscanRows` 或 fixture module 尚不存在。

- [ ] **步骤 3：最小实现运行时配置、rAF 滚动合并和纵向 fixture**

在配置中添加：

```ts
matrix: {
  scrollThrottleMs: 16,
  overscanColumns: 3,
  overscanRows: 6,
}
```

在 `MatrixView` 读取 `runtimePerformance.matrix.overscanColumns` 与 `overscanRows`。将 `onScroll` 的可见范围重算收口到一个 `scheduleViewportRecompute`：

```ts
const viewportFrameRef = useRef<number | null>(null)
const scheduleViewportRecompute = useCallback(() => {
  if (viewportFrameRef.current != null) return
  viewportFrameRef.current = requestAnimationFrame(() => {
    viewportFrameRef.current = null
    recomputeVisibleRange()
    recomputeWindow()
  })
}, [recomputeVisibleRange, recomputeWindow])
```

在 effect cleanup 中取消未执行的 animation frame。保留 `ResizeObserver` 和 Ctrl+滚轮缩放的原有触发路径，统一改为调用该函数。

- [ ] **步骤 4：运行性能配置与纵向窗口测试确认通过**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/__tests__/performance.test.ts src/renderer/src/components/novel/matrix/__tests__/matrix-vertical-virtualization.test.ts
```

预期：PASS；fixture 断言证明深滚动时不会渲染全部 120 行。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/config/performance.ts apps/desktop/src/renderer/src/__tests__/performance.test.ts apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-performance-fixture.ts apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-vertical-virtualization.test.ts
git commit -m "perf(matrix): configure and test vertical virtualization"
```

### 任务 4：裁剪子轨道可视 SVG、优化播放头和拖拽反馈

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx`

- [ ] **步骤 1：编写可视范围裁剪与播放头失败测试**

```ts
import { expect, it } from 'vitest'
import { filterTrackSnapshotsByVisibleRange } from '../matrix-subtracks'

it('只保留可视章节范围及相邻一章的子轨道快照', () => {
  const snapshots = [
    { chapter: 1 }, { chapter: 20 }, { chapter: 21 }, { chapter: 40 },
  ] as never[]

  expect(filterTrackSnapshotsByVisibleRange(snapshots, { start: 20, end: 21 }))
    .toEqual([{ chapter: 1 }, { chapter: 20 }, { chapter: 21 }, { chapter: 40 }])
})
```

将这个测试修正为明确的真实算法：保留范围内快照，并额外保留范围两侧最近一个快照以便曲线连续。例如以上输入对 `20..21` 应保留 `1,20,21,40`；对 `20..20` 也应保留前后锚点 `1,20,21`。

在组件测试增加断言：当前播放头列容器不含 `bg-amber-500/[0.07]`，只保留一个 2px 左边线元素。

- [ ] **步骤 2：运行失败测试**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx
```

预期：FAIL，筛选函数尚未导出，播放头仍有整列背景。

- [ ] **步骤 3：实现裁剪和克制反馈**

新增并导出纯函数：

```ts
export function filterTrackSnapshotsByVisibleRange<T extends { chapter: number }>(
  snapshots: T[],
  range: { start: number; end: number },
): T[] {
  const firstVisible = snapshots.findIndex((item) => item.chapter >= range.start)
  if (firstVisible === -1) return snapshots.slice(-1)
  let end = firstVisible
  while (end < snapshots.length && snapshots[end].chapter <= range.end) end += 1
  return snapshots.slice(Math.max(0, firstVisible - 1), Math.min(snapshots.length, end + 1))
}
```

把 `visibleRange` 从 `MatrixView` 传给 `MatrixSubtracks`，使用该函数裁剪曲线、节点、色带和 tooltip 热区的数据。SVG 的视口宽度仍等于完整矩阵宽度以维持横向对齐，但不能为不可见快照创建 SVG 元素。

播放头改为：

```tsx
<div
  className="absolute bottom-0 pointer-events-none z-[4] w-0 border-l-2 border-amber-500/85"
  style={{ top: RULER_H, left: highlightLeft }}
  aria-hidden="true"
/>
```

从章节按钮和行背景中移除 amber 背景 class。对不合法目标章节渲染红色窄边框和“无法放置”提示；不得调用 `onDropEntity`、`onMoveCell` 或 `onMoveSpan`。

- [ ] **步骤 4：运行测试确认通过**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx
```

预期：PASS，播放头无列背景，裁剪函数和拒绝态行为通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-interaction.test.tsx
git commit -m "perf(matrix): clip subtracks and refine timeline feedback"
```

### 任务 5：建立共享 Skeleton 与消息分组纯函数

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/ui/skeleton.tsx`
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/message-groups.ts`
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/__tests__/message-groups.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/shared/conversation/types.ts`

- [ ] **步骤 1：编写分组失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { groupConversationMessages } from '../message-groups'

const at = (value: string) => new Date(value).toISOString()

describe('groupConversationMessages', () => {
  it('合并同一天连续且同角色同 agent 的普通消息', () => {
    const groups = groupConversationMessages([
      { id: '1', role: 'assistant', agentType: 'writer', timestamp: at('2026-07-24T09:00:00'), content: '甲' },
      { id: '2', role: 'assistant', agentType: 'writer', timestamp: at('2026-07-24T09:01:00'), content: '乙' },
    ] as never)

    expect(groups).toEqual([
      { type: 'date', day: '2026-07-24' },
      { type: 'messages', key: '1', messages: expect.arrayContaining([expect.objectContaining({ id: '1' }), expect.objectContaining({ id: '2' })]) },
    ])
  })

  it('checkpoint、system 与跨天消息必须断开分组', () => {
    const groups = groupConversationMessages([
      { id: '1', role: 'assistant', agentType: 'writer', timestamp: at('2026-07-24T23:59:00'), content: '甲' },
      { id: '2', role: 'checkpoint', timestamp: at('2026-07-24T23:59:30'), content: '确认' },
      { id: '3', role: 'assistant', agentType: 'writer', timestamp: at('2026-07-25T00:01:00'), content: '乙' },
    ] as never)

    expect(groups.map((group) => group.type)).toEqual(['date', 'messages', 'messages', 'date', 'messages'])
  })
})
```

- [ ] **步骤 2：运行失败测试**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/shared/conversation/__tests__/message-groups.test.ts
```

预期：FAIL，`message-groups` 模块不存在。

- [ ] **步骤 3：实现最小 Skeleton 和分组模型**

Skeleton：

```tsx
import { cn } from '@/lib/utils'

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-surface-3/70 motion-reduce:animate-none', className)} />
}
```

分组模型只处理共享 `ConversationMessage`：

```ts
export type ConversationRenderGroup =
  | { type: 'date'; day: string }
  | { type: 'messages'; key: string; messages: ConversationMessage[] }
```

普通消息只有在同一自然日、`role`、`agentType` 一致且两条都是非 `checkpoint`/非 `system` 时合并。日期键使用本地 `YYYY-MM-DD`，不要直接以 UTC ISO 日期切割。

在 `types.ts` 新增：

```ts
export type CheckpointAction = 'approve' | 'reject' | 'rewrite' | 'revise'
```

把 `checkpointOptions.action` 与相关 callback 类型改为 `CheckpointAction`；保持 API 边界在 `NovelConversationPanel` 内完成一次显式映射。

- [ ] **步骤 4：运行测试确认通过**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/shared/conversation/__tests__/message-groups.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/ui/skeleton.tsx apps/desktop/src/renderer/src/components/shared/conversation/message-groups.ts apps/desktop/src/renderer/src/components/shared/conversation/types.ts apps/desktop/src/renderer/src/components/shared/conversation/__tests__/message-groups.test.ts
git commit -m "feat(conversation): add grouped message model and skeleton"
```

### 任务 6：共享消息流的回到底部、新消息提示和 Checkpoint 交互

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/scroll-follow.ts`
- 修改：`apps/desktop/src/renderer/src/components/shared/conversation/conversation-stream.tsx`
- 修改：`apps/desktop/src/renderer/src/components/shared/conversation/checkpoint-message.tsx`
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/__tests__/conversation-stream.test.tsx`
- 创建：`apps/desktop/src/renderer/src/components/shared/conversation/__tests__/checkpoint-message.test.tsx`

- [ ] **步骤 1：编写 Checkpoint 与滚动失败测试**

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { CheckpointMessage } from '../checkpoint-message'

it('checkpoint 点击确认时回传严格的 approve action', () => {
  const onResolve = vi.fn()
  render(
    <CheckpointMessage
      message={{
        id: 'checkpoint-1', role: 'checkpoint', timestamp: new Date().toISOString(),
        checkpointType: 'review', checkpointOptions: [{ label: '通过', action: 'approve', variant: 'default' }],
      } as never}
      onResolve={onResolve}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '通过' }))
  expect(onResolve).toHaveBeenCalledWith('approve')
})
```

再为 `ConversationStream` 写两个测试：

```tsx
it('用户上滚后出现新消息时显示回到底部按钮', () => {})
it('点击回到底部按钮后恢复自动跟随', () => {})
```

通过 `Object.defineProperty` 为消息区设置 `scrollHeight`、`clientHeight`、`scrollTop`，使用 `fireEvent.scroll` 模拟离开底部，再 rerender 增加消息。

- [ ] **步骤 2：运行失败测试**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/shared/conversation/__tests__/checkpoint-message.test.tsx src/renderer/src/components/shared/conversation/__tests__/conversation-stream.test.tsx
```

预期：FAIL，当前没有按钮、分组视图或严格 action 类型的实现。

- [ ] **步骤 3：实现共享 `useScrollFollow` 与流渲染**

`scroll-follow.ts` 导出 Hook：

```ts
export function useScrollFollow(dependencies: readonly unknown[]) {
  // 返回 scrollRef、handleScroll、isFollowing、pendingCount、scrollToBottom
}
```

要求：

- 距底部 `< 50` 时视为跟随。
- 新消息到达但用户未跟随时递增 `pendingCount`；恢复到底部时清零。
- 滚动使用 `requestAnimationFrame` 合并同一帧写入。
- 在容器上建立 `ResizeObserver`，消息内 Markdown、卡片或异步内容改变高度时，如果仍跟随则重新滚动。
- cleanup 必须取消动画帧并 `disconnect()` observer。

`ConversationStream` 必须：

- 按 `groupConversationMessages(messages)` 渲染日期分隔和消息组。
- 在同组内让后续普通消息通过 `compact` prop 隐藏重复头像/Agent 名称；先为 `MessageBubble` 增加可选 `compact?: boolean`，默认 `false`，不改变现有调用方。
- 非跟随状态且 `pendingCount > 0` 时，在消息区右下角渲染一个按钮，文本为 `↓ N 条新消息`；点击后滚到底部。
- `checkpoint`、`system` 保持单独卡片，不参与 compact。

`CheckpointMessage` 已解决时显示 `已决策：{匹配选项标签}`，下方列出全部选项并标出选择项，避免只显示内部 action 值。

- [ ] **步骤 4：运行测试确认通过**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/shared/conversation/__tests__/checkpoint-message.test.tsx src/renderer/src/components/shared/conversation/__tests__/conversation-stream.test.tsx
```

预期：PASS，所有 checkpoint 与滚动行为测试通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/shared/conversation/scroll-follow.ts apps/desktop/src/renderer/src/components/shared/conversation/conversation-stream.tsx apps/desktop/src/renderer/src/components/shared/conversation/message-bubble.tsx apps/desktop/src/renderer/src/components/shared/conversation/checkpoint-message.tsx apps/desktop/src/renderer/src/components/shared/conversation/__tests__/conversation-stream.test.tsx apps/desktop/src/renderer/src/components/shared/conversation/__tests__/checkpoint-message.test.tsx
git commit -m "feat(conversation): group messages and restore scroll follow"
```

### 任务 7：让通用聊天具备 Skeleton、流式光标和滚动恢复

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/chat/message-stream.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/message-bubble.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/streaming-indicator.tsx`
- 创建：`apps/desktop/src/renderer/src/components/chat/__tests__/message-stream.test.tsx`

- [ ] **步骤 1：编写通用聊天失败测试**

```tsx
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { MessageBubble } from '../message-bubble'

it('流式助手消息在文本末尾显示光标', () => {
  render(<MessageBubble message={{ id: 'm1', role: 'assistant', status: 'streaming', streamingBuffer: '正在生成' } as never} />)
  expect(screen.getByLabelText('正在生成')).toBeInTheDocument()
})
```

在 `message-stream.test.tsx` 增加：`messages` 为空且 `isStreaming` 为 true 时显示 `data-testid="streaming-skeleton"`，并且不显示固定示例说明文本。

- [ ] **步骤 2：运行失败测试**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/chat/__tests__/message-stream.test.tsx
```

预期：FAIL，通用消息气泡没有 `正在生成` 标签，首 token 前不存在 Skeleton。

- [ ] **步骤 3：实现最小统一视觉**

在通用 `MessageBubble` 中，当 `message.status === 'streaming'` 时，在实际显示内容尾部渲染：

```tsx
<span aria-label="正在生成" className="ml-0.5 inline-block h-3.5 w-0.5 animate-[cursor-blink_1s_step-end_infinite] bg-primary align-middle motion-reduce:animate-none" />
```

`MessageStream` 在 `messages.length === 0 && isStreaming` 时渲染 2 条不同宽度的 Skeleton 气泡，并使用 `data-testid="streaming-skeleton"`。有真实消息时继续显示 `StreamingIndicator`，但该组件只能显示 `role="status"`、`aria-live="polite"` 和“正在生成回复”，不得保留示例业务文案。

将通用消息流的滚动逻辑迁移为 `useScrollFollow`，使它拥有与小说面板一致的“回到底部 / 新消息计数”行为；保留 session 切换动画和错误卡片。

- [ ] **步骤 4：运行测试确认通过**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/chat/__tests__/message-stream.test.tsx
```

预期：PASS，流式光标、首 token Skeleton 与无固定示例文案均验证通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/message-stream.tsx apps/desktop/src/renderer/src/components/chat/message-bubble.tsx apps/desktop/src/renderer/src/components/chat/streaming-indicator.tsx apps/desktop/src/renderer/src/components/chat/__tests__/message-stream.test.tsx
git commit -m "feat(chat): add streaming cursor and loading skeleton"
```

### 任务 8：细化滚动条、系统高对比和导航 Rail

**文件：**
- 修改：`apps/desktop/src/renderer/src/assets/main.css`
- 修改：`apps/desktop/src/renderer/src/App.tsx`
- 创建：`apps/desktop/src/renderer/src/components/navigation/rail-button.tsx`
- 创建：`apps/desktop/src/renderer/src/components/navigation/__tests__/rail-button.test.tsx`

- [ ] **步骤 1：编写 Rail 按钮失败测试**

```tsx
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { Home } from 'lucide-react'
import { RailButton } from '../rail-button'

it('激活项显示主色状态点且保留当前页语义', () => {
  render(<RailButton icon={Home} label="首页" active onClick={() => {}} />)

  expect(screen.getByRole('button', { name: '首页' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByTestId('rail-active-indicator')).toBeInTheDocument()
})
```

添加 hover 测试：hover 后延迟 400ms 显示 `role="tooltip"` 的“首页”。使用 fake timers 推进时间。

- [ ] **步骤 2：运行失败测试**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/navigation/__tests__/rail-button.test.tsx
```

预期：FAIL，`RailButton` 尚未作为独立组件导出，且无延迟 Tooltip、状态点。

- [ ] **步骤 3：实现 Rail、滚动条与高对比最小方案**

`RailButton` props：

```ts
interface RailButtonProps {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}
```

实现要求：

- 按钮有 `aria-label`、active 时有 `aria-current="page"`。
- active 通过左侧或右下角 `<span data-testid="rail-active-indicator" />` 的 `bg-primary` 圆点表示，不使用整块 `bg-surface-3` 作为唯一状态。
- Tooltip 在 hover 或 focus 后 400ms 出现，mouseleave/blur 后立即隐藏；tooltip 仅辅助说明，不能替代 `aria-label`。
- 图标按钮使用 `active:scale-[0.97]`，符合方案对 Button 的反馈边界。

在 `main.css`：

```css
.scrollbar-subtle {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: rgba(115, 115, 115, 0.24) transparent;
}

@media (forced-colors: active) {
  .scrollbar-subtle { forced-color-adjust: auto; }
  :focus-visible { outline: 2px solid CanvasText; outline-offset: 2px; }
}
```

将消息流、小说侧栏和矩阵滚动容器加上 `scrollbar-subtle`，不要移除现有全局滚动条基础样式。确认所有状态点、错误、运行中提示同时保留文字或 ARIA 文案。

在 `App.tsx` 用新 `RailButton` 替换内联按钮，保持现有页面切换状态逻辑不变。

- [ ] **步骤 4：运行 Rail 测试确认通过**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/navigation/__tests__/rail-button.test.tsx
```

预期：PASS，active 指示器、ARIA 当前页语义、延迟 Tooltip 通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/assets/main.css apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/components/navigation/rail-button.tsx apps/desktop/src/renderer/src/components/navigation/__tests__/rail-button.test.tsx
git commit -m "feat(shell): refine navigation and accessible scrolling"
```

### 任务 9：全量验证与性能记录

**文件：**
- 修改：`docs/frontend-redesign-proposal.md`
- 修改：`docs/superpowers/plans/2026-07-24-phase-5-6-matrix-polish.md`

- [ ] **步骤 1：运行矩阵与对话相关测试集**

运行：

```bash
pnpm --dir apps/desktop test -- src/renderer/src/components/novel/matrix/__tests__ src/renderer/src/components/shared/conversation/__tests__ src/renderer/src/components/chat/__tests__ src/renderer/src/components/navigation/__tests__ src/renderer/src/__tests__/performance.test.ts
```

预期：PASS。若已有无关失败，记录文件、报错与是否由本阶段引入；不得忽略本阶段相关失败。

- [ ] **步骤 2：运行静态检查**

运行：

```bash
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop typecheck
```

预期：两个命令均退出码 0。

- [ ] **步骤 3：执行性能手工验证并记录结果**

运行：

```bash
pnpm --dir apps/desktop dev
```

在桌面应用中创建或加载 100 实体、80 章节、展开 10 个子轨道的项目。使用 Chromium DevTools Performance 记录以下操作各 10 秒：纵向滚动、横向滚动、连续展开/收起、拖拽实体到章节。将设备信息、构建版本、每项操作的最大长任务和主观是否出现空白/跳动，追加到本计划末尾的“验证记录”。

预期：无大面积空白、无连续布局跳动、滚动与拖拽可持续交互。若出现长任务，记录复现步骤后再调节 `overscanRows` 或 `overscanColumns`，不得凭感觉改动。

- [ ] **步骤 4：更新方案状态**

在 `docs/frontend-redesign-proposal.md` 的 Phase 5 和 Phase 6 条目中将已经实际完成并验证通过的子项标为“已完成”，未完成项保留“待办”，不要把计划文本本身当作完成证据。

- [ ] **步骤 5：Commit**

```bash
git add docs/frontend-redesign-proposal.md docs/superpowers/plans/2026-07-24-phase-5-6-matrix-polish.md
git commit -m "docs(frontend): record phase 5 and 6 validation"
```

---

## 计划自检

- Phase 5 的子轨道默认收起、行点击/Enter 展开、纵向虚拟化、配置化 overscan、100×80×10 fixture、拖拽反馈和时间轴播放头均有对应任务。
- Phase 6 的 Skeleton、空态/流式状态、消息分组、流式光标、Checkpoint 决策卡、滚动恢复、滚动条、系统高对比和导航 Rail 均有对应任务。
- 所有新增生产行为都先有失败测试，并在每个任务内指定了单独的 RED、GREEN 和验证命令。
- 当前工作区存在未提交改动。执行任务前必须先确认这些改动是否属于 P1-P4；不得覆盖、重置、暂存或提交不属于当前任务的用户改动。
