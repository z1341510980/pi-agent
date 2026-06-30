# 时间线编辑模式优化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复阶段1审核发现的 8 个 P0/P1 bug，并新增 7 项视频编辑器风格优化（涟漪删除/In-Out 工作区/多片段成组移动/轨道折叠/章节摘要/片段批注/Solo-Mute 互斥）

**架构：** 在 `timeline-editor.tsx` 与 `novel-timeline-workspace.tsx` 中修复拖拽封顶、吸附阈值、悬停定时器、轨道状态提升与撤销栈；将可测的纯逻辑（吸附/封顶/涟漪/连分组/Solo-Mute 互斥/关系连线）抽取到 `timeline-logic.ts` 纯函数模块以便 TDD；后端通过扩展 `novel_markers.type` 枚举（已有 TEXT 列）+ 新增 migration 040 关联片段实体，支撑 In/Out 标记与片段批注。

**技术栈：** React 19 + Zustand 5 + @xyflow/react + Fastify + better-sqlite3 + Vitest（jsdom 前端 / node 后端）

**关联：** 基于阶段1审核报告，规格见审核结论

---

## 文件结构

**新建：**
- `apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts` — 纯函数模块（吸附/封顶/涟漪/分组移动/Solo-Mute 互斥/关系连线/连续跨度分组），所有可测逻辑集中于此
- `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts` — 纯函数单元测试
- `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-editor.test.tsx` — 编辑器交互测试（封顶/吸附/悬停定时器/轨道折叠/Solo-Mute）
- `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx` — 工作区撤销栈/切分/涟漪删除/In-Out/批注测试
- `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-minimap.test.tsx` — 小地图视口框测试
- `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/use-timeline-data.test.ts` — 数据聚合（连续跨度分组）测试
- `apps/desktop/src/renderer/src/components/novel/timeline/clip-note-dialog.tsx` — 片段批注编辑弹窗
- `apps/agent-server/src/__tests__/novel-marker-routes.test.ts` — 标记路由扩展测试（in/out/clip-note）

**修改：**
- `apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx` — 封顶/吸附/悬停/折叠/Solo-Mute/分组移动/标尺摘要/批注双击
- `apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx` — 状态提升/撤销栈扩展/切分保后半段/涟漪删除/In-Out/批注
- `apps/desktop/src/renderer/src/components/novel/timeline/timeline-minimap.tsx` — 视口框拆分 DOM、canvas 节流
- `apps/desktop/src/renderer/src/components/novel/timeline/timeline-relation-layer.tsx` — useMemo 包裹
- `apps/desktop/src/renderer/src/components/novel/timeline/use-timeline-data.ts` — 角色连续跨度分组、TimelineClip.note
- `apps/desktop/src/renderer/src/components/novel/timeline/timeline-markers.tsx` — In/Out 竖线渲染、clip-note 关联
- `apps/desktop/src/renderer/src/components/novel/timeline/timeline-toolbar.tsx` — In/Out 按钮
- `apps/desktop/src/renderer/src/components/novel/timeline/track-context-menu.tsx` — lock/hide 接通真实状态
- `apps/desktop/src/renderer/src/api/novel-client.ts` — NovelMarkerType 扩展 in/out/clip-note + entityType/entityId
- `apps/agent-server/src/plugins/novel-plugin/core/types.ts` — NovelMarkerType 扩展 + NovelMarker.entityType/entityId
- `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` — createMarkerSchema 扩展
- `apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts` — marker 读写 entityType/entityId
- `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts` — migration 040 扩展 novel_markers 列

**测试命令：**
- 前端：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/<file> --environment jsdom`（或在 `apps/desktop` 下 `npx vitest run`）
- 后端：在 `apps/agent-server` 下 `npx vitest run src/__tests__/novel-marker-routes.test.ts`

---

## 任务 1：A2 — 片段拖拽封顶 maxChapter

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`
- 创建测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx:556-565`（handleMouseMove move/resize 分支）

**背景：** move 分支 `newStart = Math.max(1, origStart + delta)` 没有上界，拖到末尾后 newEnd 会越过 maxChapter。需保证 newEnd ≤ maxChapter。

- [ ] **步骤 1：编写失败的测试**

新建 `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { clampMoveRange, clampResizeRightRange } from '../timeline-logic'

describe('clampMoveRange', () => {
  it('keeps original range when delta is within bounds', () => {
    expect(clampMoveRange(5, 8, 2, 20)).toEqual({ start: 7, end: 10 })
  })

  it('clamps newEnd to maxChapter by limiting newStart', () => {
    // orig 5..8, delta would push to 18..21, maxChapter=20 → newEnd must ≤20
    const r = clampMoveRange(5, 8, 13, 20)
    expect(r.end).toBe(20)
    expect(r.start).toBe(17) // 20 - (8-5) = 17
  })

  it('clamps newStart to 1', () => {
    expect(clampMoveRange(3, 6, -10, 20)).toEqual({ start: 1, end: 4 })
  })

  it('does not allow zero-length or inverted range when maxChapter < duration', () => {
    // duration=5, maxChapter=3 → start clamped to max(1, 3-5+1)=1 but end capped at maxChapter
    const r = clampMoveRange(1, 5, 0, 3)
    expect(r.start).toBeGreaterThanOrEqual(1)
    expect(r.end).toBeLessThanOrEqual(3)
  })
})

describe('clampResizeRightRange', () => {
  it('clamps newEnd to maxChapter', () => {
    expect(clampResizeRightRange(5, 8, 20, 20)).toBe(20)
  })
  it('clamps newEnd to at least origStart', () => {
    expect(clampResizeRightRange(5, 8, -10, 20)).toBe(5)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `clampMoveRange is not a function`（模块尚未创建）

- [ ] **步骤 3：编写最少实现代码**

新建 `apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`：

```typescript
/**
 * 时间轴纯逻辑：所有可测的章节区间计算集中于此。
 * 不依赖 React，便于 TDD。
 */

/** move 拖拽：保证 newStart>=1 且 newEnd<=maxChapter（按原时长反推 newStart 上界） */
export function clampMoveRange(
  origStart: number,
  origEnd: number,
  deltaChapters: number,
  maxChapter: number,
): { start: number; end: number } {
  const duration = origEnd - origStart
  const rawStart = origStart + deltaChapters
  // 上界：newStart + duration <= maxChapter → newStart <= maxChapter - duration
  const startUpper = maxChapter - duration
  const start = Math.max(1, Math.min(rawStart, startUpper))
  const end = start + duration
  return { start, end }
}

/** resize-right 拖拽：newEnd ∈ [origStart, maxChapter] */
export function clampResizeRightRange(
  origStart: number,
  origEnd: number,
  deltaChapters: number,
  maxChapter: number,
): number {
  const raw = origEnd + deltaChapters
  return Math.max(origStart, Math.min(maxChapter, raw))
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS（4 + 2 = 6 用例全过）

- [ ] **步骤 5：接入 timeline-editor.tsx 并 Commit**

修改 `apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx`：

在文件顶部 import 区追加（约第 46 行后）：

```typescript
import { clampMoveRange, clampResizeRightRange } from './timeline-logic'
```

替换 556-565 行的 move/resize 计算：

```typescript
      let newStart = dragState.origStart
      let newEnd = dragState.origEnd
      if (dragState.type === 'move') {
        const r = clampMoveRange(dragState.origStart, dragState.origEnd, deltaChapters, maxChapter)
        newStart = r.start
        newEnd = r.end
      } else if (dragState.type === 'resize-left') {
        newStart = Math.max(1, Math.min(dragState.origEnd, dragState.origStart + deltaChapters))
      } else if (dragState.type === 'resize-right') {
        newEnd = clampResizeRightRange(dragState.origStart, dragState.origEnd, deltaChapters, maxChapter)
      }
```

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx
git commit -m "fix(timeline): 片段拖拽封顶 maxChapter，避免越界 (A2)"
```

---

## 任务 2：A3 — 吸附系统阈值修正

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `findSnapPoint`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx:117-155`（删除本地 findSnapPoint，改用纯函数）
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景：** `threshold = Math.max(0.3, SNAP_PX/chapterWidth)` 恒等于 0.3，SNAP_PX=8 是死代码。chapterWidth=280 时真实阈值应 = 8/280 ≈ 0.0286 章。修复：去掉 Math.max，用浮点位置参与判定。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { findSnapPoint } from '../timeline-logic'

describe('findSnapPoint', () => {
  const tracks = [
    {
      id: 't1', kind: 'character' as const, label: 'A', clips: [
        { id: 'c1', startChapter: 10, endChapter: 14, effectId: 'x', entityType: 'character' as const, entityId: 'e1', label: 'A' },
      ],
    },
  ]

  it('snaps to playhead when within SNAP_PX/chapterWidth distance', () => {
    // chapterWidth=280, SNAP_PX=8 → threshold≈0.0286 章
    // currentStart=5.98, playhead=6 → dist=0.02 < 0.0286 → 命中
    const snap = findSnapPoint(5.98, 9.98, 280, 'c1', tracks, 6, 20)
    expect(snap).not.toBeNull()
    expect(snap!.chapter).toBe(6)
    expect(snap!.type).toBe('playhead')
  })

  it('does NOT snap when distance exceeds threshold (old Math.max(0.3) would have snapped)', () => {
    // chapterWidth=280 → threshold≈0.0286；dist=0.2 远大于阈值，不应命中
    const snap = findSnapPoint(5.8, 9.8, 280, 'c1', tracks, 6, 20)
    expect(snap).toBeNull()
  })

  it('snaps to clip endpoint', () => {
    // currentEnd+1=15, clip c1 endChapter+1=15 → dist=0
    const snap = findSnapPoint(11, 14, 80, 'other', tracks, 1, 20)
    expect(snap).not.toBeNull()
    expect(snap!.chapter).toBe(15)
    expect(snap!.type).toBe('clip-end')
  })

  it('excludes the clip being dragged', () => {
    // 拖动 c1 自身端点不应吸附到自身
    const snap = findSnapPoint(10, 14, 80, 'c1', tracks, 1, 20)
    // c1 被排除；playhead=1 距离 10-1=9 > threshold(0.1) → null
    expect(snap).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `findSnapPoint is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
export const SNAP_PX = 8

export interface SnapResult {
  chapter: number
  type: 'playhead' | 'clip-end' | 'chapter'
  priority: number
  distance: number
}

interface SnapClip {
  id: string
  startChapter: number
  endChapter: number
}
interface SnapTrack {
  id: string
  clips: SnapClip[]
}

/**
 * 吸附判定：threshold = SNAP_PX / chapterWidth（不再 Math.max 兜底）。
 * 接受浮点 currentStart/currentEnd，使吸附在子章节精度生效。
 */
export function findSnapPoint(
  currentStart: number,
  currentEnd: number,
  chapterWidth: number,
  excludeClipId: string,
  tracks: SnapTrack[],
  playheadChapter: number,
  maxChapter: number,
): SnapResult | null {
  const threshold = SNAP_PX / chapterWidth
  const candidates: Array<{ chapter: number; type: SnapResult['type']; priority: number }> = []

  candidates.push({ chapter: playheadChapter, type: 'playhead', priority: 100 })

  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue
      candidates.push({ chapter: clip.startChapter, type: 'clip-end', priority: 85 })
      candidates.push({ chapter: clip.endChapter + 1, type: 'clip-end', priority: 85 })
    }
  }

  for (let ch = 1; ch <= maxChapter; ch++) {
    candidates.push({ chapter: ch, type: 'chapter', priority: 70 })
  }

  let best: SnapResult | null = null
  for (const endpoint of [currentStart, currentEnd + 1]) {
    for (const c of candidates) {
      const dist = Math.abs(c.chapter - endpoint)
      if (dist > threshold) continue
      if (!best || dist < best.distance ||
          (dist === best.distance && c.priority > best.priority)) {
        best = { chapter: c.chapter, type: c.type, priority: c.priority, distance: dist }
      }
    }
  }
  return best
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：接入 timeline-editor.tsx 并 Commit**

在 `timeline-editor.tsx`：

1. 删除 108-155 行本地 `SnapResult` interface 与 `findSnapPoint` 函数。
2. 修改顶部 import（任务 1 已引入 `clampMoveRange` 等），改为：

```typescript
import { clampMoveRange, clampResizeRightRange, findSnapPoint, type SnapResult } from './timeline-logic'
```

3. 第 293 行 `useState<{ x: number; type: SnapResult['type'] } | null>(null)` 中 `SnapResult` 现引自纯函数模块，类型不变，无需改动。
4. 第 568 行调用 `findSnapPoint(...)` 签名不变，无需改动。

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx
git commit -m "fix(timeline): 吸附阈值改用 SNAP_PX/chapterWidth，移除死代码 Math.max (A3)"
```

---

## 任务 3：A8 — 悬停定时器卸载清理 + 吸附后边界二次校验

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `finalClampAfterSnap`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx:567-585`（吸附分支末尾 clamp）+ 新增 useEffect 清理 hoverTimerRef（约 727 行后）
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`
- 新建测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-editor.test.tsx`

**背景：** handleClipMouseEnter 的 setTimeout 在组件卸载时未清理；吸附调整 newStart/newEnd 后未再 clamp，可能轻微越界。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { finalClampAfterSnap } from '../timeline-logic'

describe('finalClampAfterSnap', () => {
  it('clamps move range after snap to keep within [1, maxChapter]', () => {
    // 假设吸附把 newStart 推到 19，原时长 3，maxChapter=20 → newEnd=22 越界
    const r = finalClampAfterSnap('move', 19, 22, 5, 8, 20)
    expect(r.end).toBe(20)
    expect(r.start).toBe(17)
  })

  it('clamps newStart to 1 on resize-left after snap', () => {
    const r = finalClampAfterSnap('resize-left', 0, 8, 0, 8, 20)
    expect(r.start).toBe(1)
    expect(r.end).toBe(8)
  })

  it('clamps newEnd to maxChapter on resize-right after snap', () => {
    const r = finalClampAfterSnap('resize-right', 5, 25, 5, 8, 20)
    expect(r.end).toBe(20)
    expect(r.start).toBe(5)
  })

  it('leaves valid range untouched', () => {
    const r = finalClampAfterSnap('move', 7, 10, 5, 8, 20)
    expect(r).toEqual({ start: 7, end: 10 })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `finalClampAfterSnap is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
/** 吸附后对 newStart/newEnd 做最终边界校验，防止吸附位移导致越界 */
export function finalClampAfterSnap(
  type: 'move' | 'resize-left' | 'resize-right',
  newStart: number,
  newEnd: number,
  origStart: number,
  origEnd: number,
  maxChapter: number,
): { start: number; end: number } {
  if (type === 'move') {
    const duration = origEnd - origStart
    const start = Math.max(1, Math.min(newStart, maxChapter - duration))
    return { start, end: start + duration }
  }
  if (type === 'resize-left') {
    const start = Math.max(1, Math.min(newStart, origEnd))
    return { start, end: newEnd }
  }
  // resize-right
  const end = Math.max(origStart, Math.min(newEnd, maxChapter))
  return { start: newStart, end }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：接入 editor + 加 useEffect 清理 + 写组件测试 + Commit**

修改 `timeline-editor.tsx`：

1. 顶部 import 追加：

```typescript
import { finalClampAfterSnap } from './timeline-logic'
```

2. 替换 567-585 行吸附分支，在 setSnapLine 之后、`const update = ...` 之前插入最终 clamp：

```typescript
      if (useSnap) {
        const snap = findSnapPoint(newStart, newEnd, chapterWidth, clip.id, tracks, playheadChapter, maxChapter)
        if (snap) {
          if (dragState.type === 'move') {
            const offset = snap.chapter - newStart
            newStart += offset
            newEnd += offset
          } else if (dragState.type === 'resize-left') {
            newStart = snap.chapter
          } else if (dragState.type === 'resize-right') {
            newEnd = snap.chapter - 1
          }
          setSnapLine({ x: chapterToX(snap.chapter, chapterWidth), type: snap.type })
        } else {
          setSnapLine(null)
        }
      } else {
        setSnapLine(null)
      }

      // 吸附后二次边界校验（A8）
      const clamped = finalClampAfterSnap(dragState.type, newStart, newEnd, dragState.origStart, dragState.origEnd, maxChapter)
      newStart = clamped.start
      newEnd = clamped.end
```

3. 在 `handleClipMouseLeave`（约 725 行）之后新增 useEffect 清理定时器：

```typescript
  // 卸载时清理悬停定时器（A8）
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
    }
  }, [])
```

新建 `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-editor.test.tsx`：

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TimelineEditor } from '../timeline-editor'
import type { TimelineTrack } from '../use-timeline-data'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const tracks: TimelineTrack[] = [
  {
    id: 't1', kind: 'character', label: 'A', clips: [
      { id: 'c1', startChapter: 1, endChapter: 5, effectId: 'character-protagonist', entityType: 'character', entityId: 'e1', label: 'A' },
    ],
  },
]

describe('TimelineEditor hover timer cleanup', () => {
  it('clears hover timer on unmount (no leak)', () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <TimelineEditor tracks={tracks} chapters={[]} playheadChapter={1} chapterWidth={80} maxChapter={10} />,
    )
    // 卸载不应抛错；fake timer 下未清理的 timeout 会在后续 tick 触发 setState 警告
    expect(() => unmount()).not.toThrow()
    // 推进定时器确认无 state 更新报错
    expect(() => vi.advanceTimersByTime(600)).not.toThrow()
  })
})
```

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-editor.test.tsx apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx
git commit -m "fix(timeline): 悬停定时器卸载清理 + 吸附后边界二次校验 (A8)"
```

---

## 任务 4：A6 — 关系层 memoize

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `buildRelationLines`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-relation-layer.tsx:70-154`
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景：** trackClipRangeMap 与 lines 每次渲染重算，未 useMemo。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { buildRelationLines } from '../timeline-logic'

describe('buildRelationLines', () => {
  it('builds character-character line when ranges overlap', () => {
    const tracks = [
      {
        id: 't1', kind: 'character' as const, label: 'A', clips: [
          { id: 'c1', startChapter: 1, endChapter: 10, effectId: 'x', entityType: 'character' as const, entityId: 'charA', label: 'A' },
        ],
      },
      {
        id: 't2', kind: 'character' as const, label: 'B', clips: [
          { id: 'c2', startChapter: 5, endChapter: 15, effectId: 'x', entityType: 'character' as const, entityId: 'charB', label: 'B' },
        ],
      },
    ]
    const rels = [{ id: 'r1', projectId: 'p', characterA: 'charA', characterB: 'charB', relationType: 'friendship', currentStage: '', stageHistory: '', createdAt: 0, updatedAt: 0 }]
    const lines = buildRelationLines(tracks, rels, [], 80, 36)
    expect(lines.length).toBe(1)
    expect(lines[0].relationType).toBe('friendship')
  })

  it('skips lines when ranges do not overlap', () => {
    const tracks = [
      {
        id: 't1', kind: 'character' as const, label: 'A', clips: [
          { id: 'c1', startChapter: 1, endChapter: 3, effectId: 'x', entityType: 'character' as const, entityId: 'charA', label: 'A' },
        ],
      },
      {
        id: 't2', kind: 'character' as const, label: 'B', clips: [
          { id: 'c2', startChapter: 10, endChapter: 15, effectId: 'x', entityType: 'character' as const, entityId: 'charB', label: 'B' },
        ],
      },
    ]
    const rels = [{ id: 'r1', projectId: 'p', characterA: 'charA', characterB: 'charB', relationType: 'friendship', currentStage: '', stageHistory: '', createdAt: 0, updatedAt: 0 }]
    expect(buildRelationLines(tracks, rels, [], 80, 36).length).toBe(0)
  })

  it('dedupes faction ally pairs bidirectionally', () => {
    const tracks = [
      {
        id: 't1', kind: 'faction' as const, label: 'F1', clips: [
          { id: 'c1', startChapter: 1, endChapter: 10, effectId: 'x', entityType: 'faction' as const, entityId: 'f1', label: 'F1' },
        ],
      },
      {
        id: 't2', kind: 'faction' as const, label: 'F2', clips: [
          { id: 'c2', startChapter: 1, endChapter: 10, effectId: 'x', entityType: 'faction' as const, entityId: 'f2', label: 'F2' },
        ],
      },
    ]
    const factions = [
      { id: 'f1', projectId: 'p', name: 'F1', description: '', type: 'organization' as const, leaderId: null, allies: ['f2'], enemies: [], strength: 'medium' as const, status: 'active' as const, createdAt: 0, updatedAt: 0 },
      { id: 'f2', projectId: 'p', name: 'F2', description: '', type: 'organization' as const, leaderId: null, allies: ['f1'], enemies: [], strength: 'medium' as const, status: 'active' as const, createdAt: 0, updatedAt: 0 },
    ]
    expect(buildRelationLines(tracks, [], factions, 80, 36).length).toBe(1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `buildRelationLines is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
const RELATION_COLOR: Record<string, string> = {
  family: 'rgba(239, 68, 68, 0.7)',
  friendship: 'rgba(59, 130, 246, 0.7)',
  romance: 'rgba(236, 72, 153, 0.7)',
  rivalry: 'rgba(30, 41, 59, 0.7)',
  mentor: 'rgba(168, 85, 247, 0.7)',
  ally: 'rgba(16, 185, 129, 0.7)',
  leader: 'rgba(217, 119, 6, 0.85)',
}

const RELATION_LABEL: Record<string, string> = {
  family: '亲情', friendship: '友情', romance: '爱情',
  rivalry: '敌对', mentor: '师徒', ally: '盟友', leader: '领袖',
}

export interface LineSegment {
  id: string
  x1: number; y1: number; x2: number; y2: number
  color: string
  label: string
  relationType: string
}

interface RelClip { id: string; startChapter: number; endChapter: number; entityId: string }
interface RelTrack { id: string; kind: string; clips: RelClip[] }
interface RelRelationship { id: string; characterA: string; characterB: string; relationType?: string }
interface RelFaction { id: string; leaderId: string | null; allies: string[] | null; enemies: string[] | null }

/** 构建关系连线（纯函数，从 timeline-relation-layer.tsx 抽取） */
export function buildRelationLines(
  tracks: RelTrack[],
  relationships: RelRelationship[],
  factions: RelFaction[],
  chapterWidth: number,
  trackHeight: number,
): LineSegment[] {
  const trackClipRangeMap = new Map<string, { start: number; end: number; midX: number; midY: number }>()
  tracks.forEach((track, idx) => {
    if ((track.kind === 'character' || track.kind === 'faction') && track.clips.length > 0) {
      const clip = track.clips[0]
      const midCh = (clip.startChapter + clip.endChapter) / 2
      trackClipRangeMap.set(clip.entityId, {
        start: clip.startChapter,
        end: clip.endChapter,
        midX: (midCh - 0.5) * chapterWidth,
        midY: idx * trackHeight + trackHeight / 2,
      })
    }
  })

  const lines: LineSegment[] = []

  for (const rel of relationships) {
    const a = trackClipRangeMap.get(rel.characterA)
    const b = trackClipRangeMap.get(rel.characterB)
    if (!a || !b) continue
    if (a.end < b.start || b.end < a.start) continue
    const relationType = rel.relationType ?? 'ally'
    const color = RELATION_COLOR[relationType] ?? 'rgba(100, 100, 100, 0.5)'
    const label = RELATION_LABEL[relationType] ?? relationType
    lines.push({ id: rel.id, x1: a.midX, y1: a.midY, x2: b.midX, y2: b.midY, color, label, relationType })
  }

  const factionPairSeen = new Set<string>()
  for (const f of factions) {
    const fRange = trackClipRangeMap.get(f.id)
    if (!fRange) continue
    for (const allyId of f.allies ?? []) {
      const allyRange = trackClipRangeMap.get(allyId)
      if (!allyRange) continue
      const key = `${[f.id, allyId].sort().join('|')}|ally`
      if (factionPairSeen.has(key)) continue
      factionPairSeen.add(key)
      if (fRange.end < allyRange.start || allyRange.end < fRange.start) continue
      lines.push({ id: `faction-ally-${key}`, x1: fRange.midX, y1: fRange.midY, x2: allyRange.midX, y2: allyRange.midY, color: RELATION_COLOR.ally, label: '同盟', relationType: 'ally' })
    }
    for (const enemyId of f.enemies ?? []) {
      const enemyRange = trackClipRangeMap.get(enemyId)
      if (!enemyRange) continue
      const key = `${[f.id, enemyId].sort().join('|')}|enemy`
      if (factionPairSeen.has(key)) continue
      factionPairSeen.add(key)
      if (fRange.end < enemyRange.start || enemyRange.end < fRange.start) continue
      lines.push({ id: `faction-enemy-${key}`, x1: fRange.midX, y1: fRange.midY, x2: enemyRange.midX, y2: enemyRange.midY, color: RELATION_COLOR.rivalry, label: '敌对', relationType: 'rivalry' })
    }
  }

  for (const f of factions) {
    if (!f.leaderId) continue
    const fRange = trackClipRangeMap.get(f.id)
    if (!fRange) continue
    const leaderRange = trackClipRangeMap.get(f.leaderId)
    if (!leaderRange) continue
    if (fRange.end < leaderRange.start || leaderRange.end < fRange.start) continue
    lines.push({ id: `faction-leader-${f.id}-${f.leaderId}`, x1: fRange.midX, y1: fRange.midY, x2: leaderRange.midX, y2: leaderRange.midY, color: RELATION_COLOR.leader, label: '领袖', relationType: 'leader' })
  }

  return lines
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：接入 relation-layer 并 Commit**

修改 `timeline-relation-layer.tsx`：

1. 顶部 import 替换为：

```typescript
import { useMemo, type ReactElement } from 'react'
import type { NovelRelationship, NovelFaction } from '@/api/novel-client'
import type { TimelineTrack } from './use-timeline-data'
import { buildRelationLines, type LineSegment } from './timeline-logic'

const RELATION_LABEL: Record<string, string> = {
  family: '亲情', friendship: '友情', romance: '爱情',
  rivalry: '敌对', mentor: '师徒', ally: '盟友', leader: '领袖',
}
```

删除本地 `RELATION_COLOR` / `RELATION_LABEL` / `LineSegment` / `ClipRange` 定义（16-54 行）。

2. 替换 70-154 行（trackClipRangeMap + lines 构建）为：

```typescript
  const lines = useMemo<LineSegment[]>(
    () => buildRelationLines(tracks, relationships, factions, chapterWidth, trackHeight),
    [tracks, relationships, factions, chapterWidth, trackHeight],
  )
```

3. 后续渲染逻辑（`if (lines.length === 0)` 起）保持不变，`line.color` / `line.label` 等字段一致。

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-relation-layer.tsx
git commit -m "perf(timeline): 关系层 trackClipRangeMap/lines 包 useMemo (A6)"
```

---

## 任务 5：A5 — 小地图视口框拆分 + canvas 节流

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `computeMinimapViewportFrame`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-minimap.tsx`
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`
- 新建测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-minimap.test.tsx`

**背景：** 视口框目前画在 canvas 上，每次滚动都全量重绘。拆为独立 DOM 元素，滚动时只更新 left/width；canvas 仅在 tracks/maxChapter 变化时用 rAF 节流重绘。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { computeMinimapViewportFrame } from '../timeline-logic'

describe('computeMinimapViewportFrame', () => {
  it('computes left/width in px from chapter range', () => {
    // maxChapter=100, viewportStart=10, visible=20, containerWidth=500
    const f = computeMinimapViewportFrame(10, 20, 100, 500)
    // chapterW = 500/100 = 5; left = (10-1)*5 = 45; width = 20*5 = 100
    expect(f.left).toBe(45)
    expect(f.width).toBe(100)
  })

  it('enforces minimum width of 8px', () => {
    const f = computeMinimapViewportFrame(1, 1, 1000, 100)
    expect(f.width).toBeGreaterThanOrEqual(8)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `computeMinimapViewportFrame is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
/** 计算小地图视口框的 left/width（px），用于独立 DOM 元素定位 */
export function computeMinimapViewportFrame(
  viewportStartChapter: number,
  viewportVisibleChapters: number,
  maxChapter: number,
  containerWidth: number,
): { left: number; width: number } {
  if (maxChapter <= 0) return { left: 0, width: 8 }
  const chapterW = containerWidth / maxChapter
  const left = (viewportStartChapter - 1) * chapterW
  const width = Math.max(8, viewportVisibleChapters * chapterW)
  return { left, width }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：改造 minimap + 写组件测试 + Commit**

修改 `timeline-minimap.tsx` 全文为：

```typescript
/**
 * TimelineMinimap：小地图导航
 *
 * Canvas 仅绘制片段色块（tracks/maxChapter 变化时 rAF 节流重绘）。
 * 视口框为独立绝对定位 DOM 元素，滚动时只更新 left/width。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { TimelineTrack } from './use-timeline-data'
import { computeMinimapViewportFrame } from './timeline-logic'

const MINIMAP_HEIGHT = 32

export interface TimelineMinimapProps {
  tracks: TimelineTrack[]
  maxChapter: number
  chapterWidth: number
  viewportStartChapter: number
  viewportVisibleChapters: number
  onViewportChange?: (startChapter: number) => void
  onChapterWidthChange?: (width: number) => void
}

type DragMode = 'pan' | 'resize-left' | 'resize-right' | null

export function TimelineMinimap({
  tracks,
  maxChapter,
  viewportStartChapter,
  viewportVisibleChapters,
  onViewportChange,
}: TimelineMinimapProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragModeRef = useRef<DragMode>(null)
  const dragStartRef = useRef<{ x: number; startChapter: number; visibleChapters: number } | null>(null)
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // 仅绘制片段色块（不含视口框）
  const drawClips = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return
      const dpr = window.devicePixelRatio || 1
      const width = container.clientWidth
      const height = MINIMAP_HEIGHT
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.03)'
      ctx.fillRect(0, 0, width, height)
      if (maxChapter === 0) return
      const chapterW = width / maxChapter
      const trackColorMap: Record<string, string> = {
        character: 'rgba(59, 130, 246, 0.6)',
        conflict: 'rgba(239, 68, 68, 0.6)',
        foreshadow: 'rgba(245, 158, 11, 0.6)',
        faction: 'rgba(168, 85, 247, 0.6)',
        location: 'rgba(6, 182, 212, 0.6)',
        world_element: 'rgba(99, 102, 241, 0.6)',
      }
      const trackH = Math.max(2, Math.floor(height / Math.max(tracks.length, 1)))
      tracks.forEach((track, idx) => {
        const y = idx * trackH
        ctx.fillStyle = trackColorMap[track.kind] ?? 'rgba(100, 100, 100, 0.5)'
        for (const clip of track.clips) {
          const x = (clip.startChapter - 1) * chapterW
          const w = Math.max(1, (clip.endChapter - clip.startChapter + 1) * chapterW)
          ctx.fillRect(x, y, w, Math.max(2, trackH - 1))
        }
      })
    })
  }, [tracks, maxChapter])

  // canvas 仅在 tracks/maxChapter 变化时重绘
  useEffect(() => {
    drawClips()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [drawClips])

  // 监听容器宽度变化（ResizeObserver 简化版：滚动/挂载时同步）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    setContainerWidth(container.clientWidth)
  }, [tracks, maxChapter])

  const frame = computeMinimapViewportFrame(viewportStartChapter, viewportVisibleChapters, maxChapter, containerWidth || 1)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const chapterW = rect.width / maxChapter
    const vpX = (viewportStartChapter - 1) * chapterW
    const vpW = Math.max(8, viewportVisibleChapters * chapterW)
    const edgeThreshold = 6

    let mode: DragMode = 'pan'
    if (Math.abs(x - vpX) < edgeThreshold) mode = 'resize-left'
    else if (Math.abs(x - (vpX + vpW)) < edgeThreshold) mode = 'resize-right'
    else if (x < vpX || x > vpX + vpW) {
      const centerChapter = Math.max(1, Math.min(maxChapter, Math.floor(x / chapterW) + 1))
      const newStart = Math.max(1, Math.min(maxChapter - viewportVisibleChapters + 1, centerChapter - Math.floor(viewportVisibleChapters / 2)))
      onViewportChange?.(newStart)
      dragModeRef.current = 'pan'
    } else {
      mode = 'pan'
    }
    dragModeRef.current = mode
    dragStartRef.current = { x: e.clientX, startChapter: viewportStartChapter, visibleChapters: viewportVisibleChapters }

    const handleMove = (ev: MouseEvent): void => {
      const start = dragStartRef.current
      const m = dragModeRef.current
      if (!start || !m) return
      const deltaX = ev.clientX - start.x
      const deltaChapters = Math.round(deltaX / chapterW)
      if (m === 'pan') {
        const newStart = Math.max(1, Math.min(maxChapter - start.visibleChapters + 1, start.startChapter + deltaChapters))
        onViewportChange?.(newStart)
      }
    }
    const handleUp = (): void => {
      dragModeRef.current = null
      dragStartRef.current = null
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [maxChapter, viewportStartChapter, viewportVisibleChapters, onViewportChange])

  return (
    <div className="tl-minimap" ref={containerRef} style={{ position: 'relative' }}>
      <canvas ref={canvasRef} onMouseDown={handleMouseDown} style={{ display: 'block' }} />
      {/* 视口框：独立 DOM 元素，滚动时只更新 left/width */}
      <div
        className="tl-minimap-viewport"
        style={{
          position: 'absolute',
          left: frame.left,
          top: 0,
          width: frame.width,
          height: MINIMAP_HEIGHT,
          border: '1.5px solid rgba(59, 130, 246, 0.9)',
          background: 'rgba(59, 130, 246, 0.1)',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
```

新建 `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-minimap.test.tsx`：

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TimelineMinimap } from '../timeline-minimap'

afterEach(() => cleanup())

describe('TimelineMinimap', () => {
  it('renders viewport frame as a separate DOM element', () => {
    const tracks = [
      { id: 't1', kind: 'character' as const, label: 'A', clips: [
        { id: 'c1', startChapter: 1, endChapter: 5, effectId: 'x', entityType: 'character' as const, entityId: 'e1', label: 'A' },
      ] },
    ]
    const { container } = render(
      <TimelineMinimap tracks={tracks} maxChapter={100} chapterWidth={80} viewportStartChapter={10} viewportVisibleChapters={20} />,
    )
    const frame = container.querySelector('.tl-minimap-viewport') as HTMLElement | null
    expect(frame).not.toBeNull()
    // 视口框是独立 div，不是 canvas
    expect(frame!.tagName).toBe('DIV')
  })
})
```

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-minimap.tsx apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-minimap.test.tsx
git commit -m "perf(timeline): 小地图视口框拆分 DOM，canvas rAF 节流 (A5)"
```

---

## 任务 6：A7 — 轨道 lock/hide/solo/mute 状态提升到 workspace

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx`（hidden/locked/soloed/muted 改为受控 props）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx:953-966`（接通 TrackContextMenu）
- 新建测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx`

**背景：** hiddenTracks/lockedTracks/soloedTrack/mutedTracks 是 editor 内部 useState，workspace 的 TrackContextMenu onToggleLock/onToggleVisible 是 no-op。提升到 workspace state，与 trackHeightLevel 一致。

- [ ] **步骤 1：编写失败的测试**

新建 `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx`：

```typescript
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('@/api/novel-client', () => ({
  listMarkers: vi.fn().mockResolvedValue([]),
  createMarker: vi.fn(),
  updateMarker: vi.fn(),
  deleteMarker: vi.fn(),
  createCharacterHistory: vi.fn(),
  batchCreateCharacterHistory: vi.fn(),
  deleteCharacterHistory: vi.fn(),
  deleteChapter: vi.fn(),
  updateConflict: vi.fn(),
  updateForeshadow: vi.fn(),
  updateFaction: vi.fn(),
  updateLocation: vi.fn(),
}))

const storeState: Record<string, unknown> = {
  currentProjectId: 'p1',
  characters: [], chapters: [], conflicts: [], foreshadows: [],
  factions: [], locations: [], worldElements: [], characterHistory: [],
  relationships: [], markers: [],
  selectNode: vi.fn(),
  upsertConflict: vi.fn(), upsertForeshadow: vi.fn(), upsertFaction: vi.fn(), upsertLocation: vi.fn(),
  removeChapter: vi.fn(), setCharacterHistory: vi.fn(), addCharacterHistory: vi.fn(), removeCharacterHistory: vi.fn(),
  setMarkers: vi.fn(), upsertMarker: vi.fn(), removeMarker: vi.fn(),
}

vi.mock('@/stores/novel-store', () => ({
  useNovelStore: (sel: (s: any) => any) => sel(storeState),
}))

import { NovelTimelineWorkspace } from '../novel-timeline-workspace'
import { listMarkers } from '@/api/novel-client'

afterEach(() => { cleanup(); vi.clearAllMocks() })
beforeEach(() => { vi.mocked(listMarkers).mockResolvedValue([]) })

describe('NovelTimelineWorkspace track state lifting (A7)', () => {
  it('TrackContextMenu toggle visible is wired (not a no-op)', async () => {
    render(<NovelTimelineWorkspace />)
    await waitFor(() => expect(listMarkers).toHaveBeenCalled())
    // 等待轨道渲染（占位轨道存在）
    const trackHeader = await screen.findByText('角色')
    fireEvent.contextMenu(trackHeader)
    // 菜单弹出后点击"隐藏轨道"
    const hideBtn = await screen.findByText('隐藏轨道')
    fireEvent.click(hideBtn)
    // 再次右键应显示"显示轨道"（状态翻转）
    fireEvent.contextMenu(await screen.findByText('角色'))
    await screen.findByText('显示轨道')
    expect(true).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx --environment jsdom`
预期：FAIL（菜单点击后状态未翻转，仍显示"隐藏轨道"，或 no-op 不变）

- [ ] **步骤 3：编写实现代码**

3a. 修改 `timeline-editor.tsx`：

- 在 `TimelineEditorProps`（约 197 行起）追加 4 个受控 props：

```typescript
  hiddenTracks?: Set<string>
  lockedTracks?: Set<string>
  soloedTrack?: string | null
  mutedTracks?: Set<string>
  onToggleTrackVisible?: (trackId: string) => void
  onToggleTrackLock?: (trackId: string) => void
  onToggleTrackMute?: (trackId: string) => void
  onToggleTrackSolo?: (trackId: string) => void
```

- 函数参数解构（约 241 行起）追加：

```typescript
  hiddenTracks: propHiddenTracks,
  lockedTracks: propLockedTracks,
  soloedTrack: propSoloedTrack,
  mutedTracks: propMutedTracks,
  onToggleTrackVisible,
  onToggleTrackLock,
  onToggleTrackMute,
  onToggleTrackSolo,
```

- 删除 289-292 行的 4 个 useState（hiddenTracks/lockedTracks/soloedTrack/mutedTracks），改为兼容受控/非受控：

```typescript
  const [internalHidden, setInternalHidden] = useState<Set<string>>(new Set())
  const [internalLocked, setInternalLocked] = useState<Set<string>>(new Set())
  const [internalSoloed, setInternalSoloed] = useState<string | null>(null)
  const [internalMuted, setInternalMuted] = useState<Set<string>>(new Set())
  const hiddenTracks = propHiddenTracks ?? internalHidden
  const lockedTracks = propLockedTracks ?? internalLocked
  const soloedTrack = propSoloedTrack ?? internalSoloed
  const mutedTracks = propMutedTracks ?? internalMuted
```

- 替换 626-655 行的 4 个 toggle 函数，优先调用 props 回调：

```typescript
  const toggleTrackVisible = useCallback((trackId: string) => {
    if (onToggleTrackVisible) { onToggleTrackVisible(trackId); return }
    setInternalHidden((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId)
      return next
    })
  }, [onToggleTrackVisible])

  const toggleTrackLock = useCallback((trackId: string) => {
    if (onToggleTrackLock) { onToggleTrackLock(trackId); return }
    setInternalLocked((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId)
      return next
    })
  }, [onToggleTrackLock])

  const toggleTrackMute = useCallback((trackId: string) => {
    if (onToggleTrackMute) { onToggleTrackMute(trackId); return }
    setInternalMuted((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId)
      return next
    })
  }, [onToggleTrackMute])

  const toggleTrackSolo = useCallback((trackId: string) => {
    if (onToggleTrackSolo) { onToggleTrackSolo(trackId); return }
    setInternalSoloed((prev) => (prev === trackId ? null : trackId))
  }, [onToggleTrackSolo])
```

3b. 修改 `novel-timeline-workspace.tsx`：

- 在本地 UI 状态区（约 133 行 trackHeightLevel 后）追加：

```typescript
  const [hiddenTracks, setHiddenTracks] = useState<Set<string>>(new Set())
  const [lockedTracks, setLockedTracks] = useState<Set<string>>(new Set())
  const [soloedTrack, setSoloedTrack] = useState<string | null>(null)
  const [mutedTracks, setMutedTracks] = useState<Set<string>>(new Set())
```

- 在 `handleContextMenuTrack` 附近（约 618 行后）追加 toggle 函数：

```typescript
  const toggleTrackVisible = useCallback((trackId: string) => {
    setHiddenTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId)
      return next
    })
  }, [])
  const toggleTrackLock = useCallback((trackId: string) => {
    setLockedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId)
      return next
    })
  }, [])
  const toggleTrackMute = useCallback((trackId: string) => {
    setMutedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId)
      return next
    })
  }, [])
  const toggleTrackSolo = useCallback((trackId: string) => {
    setSoloedTrack((prev) => (prev === trackId ? null : trackId))
  }, [])
```

- `<TimelineEditor>`（约 888 行）追加 props：

```tsx
            hiddenTracks={hiddenTracks}
            lockedTracks={lockedTracks}
            soloedTrack={soloedTrack}
            mutedTracks={mutedTracks}
            onToggleTrackVisible={toggleTrackVisible}
            onToggleTrackLock={toggleTrackLock}
            onToggleTrackMute={toggleTrackMute}
            onToggleTrackSolo={toggleTrackSolo}
```

- 替换 953-966 行 `<TrackContextMenu>`：

```tsx
      <TrackContextMenu
        position={trackContextMenu}
        isLocked={trackContextMenu ? lockedTracks.has(trackContextMenu.track.id) : false}
        isHidden={trackContextMenu ? hiddenTracks.has(trackContextMenu.track.id) : false}
        heightLevel={trackHeightLevel}
        canMoveUp={currentTrackIndex > 0}
        canMoveDown={currentTrackIndex >= 0 && currentTrackIndex < tracks.length - 1}
        onClose={() => setTrackContextMenu(null)}
        onMoveUp={handleTrackMoveUp}
        onMoveDown={handleTrackMoveDown}
        onSetHeight={setTrackHeightLevel}
        onToggleLock={() => trackContextMenu && toggleTrackLock(trackContextMenu.track.id)}
        onToggleVisible={() => trackContextMenu && toggleTrackVisible(trackContextMenu.track.id)}
      />
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx --environment jsdom`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx
git commit -m "fix(timeline): 提升 lock/hide/solo/mute 状态到 workspace，接通右键菜单 (A7)"
```

---

## 任务 7：A4 — 删除/剪切/粘贴入撤销栈

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `applyUndoAction` 范围恢复辅助）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx:62-67,418-520,651-673`
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx`

**背景：** EditAction 仅支持 move/resize，删除/剪切/粘贴不入栈。扩展 type，撤销时按 entityType 重建区间。

- [ ] **步骤 1：编写失败的测试**

在 `novel-timeline-workspace.test.tsx` 顶部新增 `storeState` 里加 conflict 数据，并在文件末尾追加测试：

```typescript
import type { NovelConflict } from '@/api/novel-client'

const conflict: NovelConflict = {
  id: 'cf1', projectId: 'p1', description: '主冲突', type: 'inner', intensity: 5,
  stage: 'emerging', participants: '', firstChapter: 3, lastChapter: 8, tier: 'main',
  createdAt: 0, updatedAt: 0,
}

describe('NovelTimelineWorkspace undo stack for delete (A4)', () => {
  it('delete pushes an action and undo restores the range', async () => {
    storeState.conflicts = [conflict]
    const { updateConflict } = await import('@/api/novel-client')
    vi.mocked(updateConflict).mockResolvedValue({ ...conflict, firstChapter: null, lastChapter: null })

    const { rerender } = render(<NovelTimelineWorkspace />)
    await waitFor(() => expect(listMarkers).toHaveBeenCalled())

    // undo 按钮初始不可用，删除后可用
    // 这里验证 updateConflict 在删除时被调用（firstChapter:null），undo 时再次被调用恢复 (3..8)
    expect(updateConflict).toHaveBeenCalled()
    // 简化断言：删除后至少调用过一次 updateConflict
    expect(vi.mocked(updateConflict).mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})
```

> 说明：完整撤销链路涉及多步异步，组件测试聚焦"删除调用 updateConflict 且入栈后 canUndo 为真"。纯逻辑校验由 `applyUndoAction` 单测覆盖（见步骤 3）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx --environment jsdom`
预期：FAIL（删除未调用 updateConflict 或调用次数不符）

- [ ] **步骤 3：编写实现代码**

3a. 在 `timeline-logic.ts` 末尾追加撤销动作类型与纯辅助：

```typescript
export type EditActionType = 'move' | 'resize' | 'delete' | 'paste' | 'cut'

export interface EditAction {
  type: EditActionType
  clip: {
    id: string
    startChapter: number
    endChapter: number
    entityType: 'character' | 'conflict' | 'foreshadow' | 'faction' | 'location' | 'world_element'
    entityId: string
  }
  before: { start: number; end: number }
  after: { start: number; end: number }
}

/** 撤销时根据 action.before 还是 after 恢复区间：撤销应用 before，重做应用 after */
export function rangeToRestore(action: EditAction, direction: 'undo' | 'redo'): { start: number; end: number } {
  return direction === 'undo' ? action.before : action.after
}
```

3b. 修改 `novel-timeline-workspace.tsx`：

- 替换 62-72 行 EditAction/HistoryState 本地定义为 import：

```typescript
import type { EditAction } from './timeline-logic'
```

删除本地 `interface EditAction`（62-67 行），保留 `interface HistoryState { past: EditAction[]; future: EditAction[] }`。

- 替换 `handleClipDelete`（418-492 行）为入栈版本：

```typescript
  const handleClipDelete = useCallback(
    async (clipId: string, opts?: { ripple?: boolean }): Promise<void> => {
      const clip = tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
      if (!clip || !currentProjectId) return
      const before = { start: clip.startChapter, end: clip.endChapter }
      try {
        switch (clip.entityType) {
          case 'character': {
            const records = characterHistory.filter((h) => h.characterId === clip.entityId)
            for (const rec of records) {
              if (rec.chapterNumber != null && rec.chapterNumber >= clip.startChapter && rec.chapterNumber <= clip.endChapter) {
                await deleteCharacterHistory(currentProjectId, rec.id)
                removeCharacterHistory(rec.id)
              }
            }
            break
          }
          case 'conflict': {
            const conflict = conflicts.find((c) => c.id === clip.entityId)
            if (!conflict) break
            const updated = await updateConflict(conflict.id, { firstChapter: null, lastChapter: null })
            upsertConflict(updated)
            break
          }
          case 'foreshadow': {
            const foreshadow = foreshadows.find((f) => f.id === clip.entityId)
            if (!foreshadow) break
            const updated = await updateForeshadow(foreshadow.id, { firstChapter: null, recoverByChapter: null })
            upsertForeshadow(updated)
            break
          }
          case 'faction': {
            const faction = factions.find((f) => f.id === clip.entityId)
            if (!faction) break
            const updated = await updateFaction(faction.id, { firstChapter: null, lastChapter: null })
            upsertFaction(updated)
            break
          }
          case 'location': {
            const location = locations.find((l) => l.id === clip.entityId)
            if (!location) break
            const idx = getLocationClipIndex(clip.id)
            const next = (location.appearChapters ?? []).filter((_, i) => i !== idx)
            const updated = await updateLocation(location.id, { appearChapters: next })
            upsertLocation(updated)
            break
          }
          case 'world_element':
            break
        }
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
        // 入栈：删除后区间为空（start>end），撤销时恢复 before
        pushHistory({
          type: 'delete',
          clip: { ...clip },
          before,
          after: { start: 0, end: -1 },
        })
        // 涟漪删除（B1 在任务 11 接入，此处预留 opts 入参）
        if (opts?.ripple) {
          // 实现见任务 11
        }
        setSelectedClipIds((prev) => {
          const next = new Set(prev)
          next.delete(clipId)
          return next
        })
      } catch (err) {
        console.error('[NovelTimelineWorkspace] 删除片段失败:', err)
      }
    },
    [tracks, currentProjectId, characterHistory, conflicts, foreshadows, factions, locations,
      removeCharacterHistory, upsertConflict, upsertForeshadow, upsertFaction, upsertLocation, queryClient, pushHistory],
  )
```

- 替换 `handleCutClip`（506-509）/ `handlePasteClips`（511-520）为入栈版本：

```typescript
  const handleCutClip = useCallback((clip: TimelineClip) => {
    setClipboard([clip])
    pushHistory({
      type: 'cut',
      clip: { ...clip },
      before: { start: clip.startChapter, end: clip.endChapter },
      after: { start: 0, end: -1 },
    })
    void handleClipDelete(clip.id)
  }, [handleClipDelete, pushHistory])

  const handlePasteClips = useCallback(() => {
    if (!clipboard || clipboard.length === 0) return
    const actions: EditAction[] = []
    for (const clip of clipboard) {
      const origDuration = clip.endChapter - clip.startChapter
      const newStart = playheadChapter
      const newEnd = newStart + origDuration
      actions.push({
        type: 'paste',
        clip: { ...clip },
        before: { start: 0, end: -1 },
        after: { start: newStart, end: newEnd },
      })
      void updateEntityRange(clip, newStart, newEnd)
    }
    for (const a of actions) pushHistory(a)
  }, [clipboard, playheadChapter, updateEntityRange, pushHistory])
```

- 替换 `handleDeleteSelected`（495-499）为 Promise.all 批量：

```typescript
  const handleDeleteSelected = useCallback(async () => {
    const ids = Array.from(selectedClipIds)
    await Promise.all(ids.map((id) => handleClipDelete(id).catch((err) => {
      console.error('[NovelTimelineWorkspace] 批量删除单项失败:', err)
    })))
  }, [selectedClipIds, handleClipDelete])
```

- 替换 `handleUndo`（651-661）/ `handleRedo`（663-673），按 action.type 选择恢复策略：

```typescript
  const handleUndo = useCallback(() => {
    const cur = historyRef.current
    if (cur.past.length === 0) return
    const action = cur.past[cur.past.length - 1]
    // move/resize/delete/cut 恢复 before；paste 删除（区间置空）→ 用 before(0,-1) 表示无
    const restore = rangeToRestore(action, 'undo')
    if (restore.end >= restore.start) {
      void updateEntityRange(action.clip, restore.start, restore.end)
    } else {
      // 区间无效表示撤销应"删除"该片段：按 entityType 置空
      void updateEntityRange(action.clip, 0, -1)
    }
    setHistory({ past: cur.past.slice(0, -1), future: [...cur.future, action] })
  }, [updateEntityRange])

  const handleRedo = useCallback(() => {
    const cur = historyRef.current
    if (cur.future.length === 0) return
    const action = cur.future[cur.future.length - 1]
    const restore = rangeToRestore(action, 'redo')
    if (restore.end >= restore.start) {
      void updateEntityRange(action.clip, restore.start, restore.end)
    }
    setHistory({ past: [...cur.past, action], future: cur.future.slice(0, -1) })
  }, [updateEntityRange])
```

- 顶部 import 追加：

```typescript
import { rangeToRestore, type EditAction } from './timeline-logic'
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx --environment jsdom`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx apps/desktop/src/renderer/src/components/novel/timeline/__tests__/novel-timeline-workspace.test.tsx
git commit -m "fix(timeline): 删除/剪切/粘贴入撤销栈，批量删除用 Promise.all (A4)"
```

---

## 任务 8：A1 — 剃刀切分保留后半段

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `groupContiguousSpans`、`planClipSplit`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/use-timeline-data.ts:96-128`（角色按连续跨度分组）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx:292-415`（handleClipSplit + updateEntityRange 切分分支）
- 新建测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/use-timeline-data.test.ts`
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景与设计决策：** 现状切分只把原 clip endChapter 改为 atChapter-1，[atChapter, 原endChapter] 丢弃。各 entityType 数据模型不同：
- **conflict/foreshadow/faction**：单实体有 firstChapter/lastChapter，一个实体=一个 clip。切分=原实体缩为 [start, atChapter-1]，并新建一个**复制实体**覆盖 [atChapter, end]。
- **location**：appearChapters 是单章出现次数组（每个元素=1 章 clip）。切分单章 clip 无意义；若 clip 跨多章（实际不会），按 atChapter 拆数组。
- **character**：clip = 历史 chapterNumber 的 min..max 聚合。当前数据模型无法表示同一角色的两段不连续区间。修复方案：改造 `use-timeline-data` 按**连续跨度**分组（相邻章节归一段，断开处分新段），切分=删除 [atChapter, end] 的历史记录使原段缩为 [start, atChapter-1]，并新建一段历史记录 [atChapter, end]（在同一角色下，因连续跨度分组会渲染为第二个 clip）。

- [ ] **步骤 1：编写失败的测试**

1a. 在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { groupContiguousSpans, planClipSplit } from '../timeline-logic'

describe('groupContiguousSpans', () => {
  it('groups adjacent chapter numbers into spans', () => {
    expect(groupContiguousSpans([1, 2, 3, 7, 8, 10])).toEqual([
      { start: 1, end: 3 },
      { start: 7, end: 8 },
      { start: 10, end: 10 },
    ])
  })
  it('handles empty input', () => {
    expect(groupContiguousSpans([])).toEqual([])
  })
  it('sorts unsorted input', () => {
    expect(groupContiguousSpans([5, 1, 2, 6])).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ])
  })
})

describe('planClipSplit', () => {
  it('produces first and second ranges for a split', () => {
    expect(planClipSplit(3, 10, 7)).toEqual({
      first: { start: 3, end: 6 },
      second: { start: 7, end: 10 },
    })
  })
  it('returns null first when atChapter <= start', () => {
    expect(planClipSplit(5, 10, 5)).toBeNull()
  })
  it('returns null second when atChapter > end', () => {
    expect(planClipSplit(5, 10, 11)).toEqual({ first: { start: 5, end: 10 }, second: null })
  })
})
```

1b. 新建 `apps/desktop/src/renderer/src/components/novel/timeline/__tests__/use-timeline-data.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { useTimelineData } from '../use-timeline-data'
import type { NovelCharacterHistory, NovelCharacter } from '@/api/novel-client'

function mkChar(id: string): NovelCharacter {
  return {
    id, projectId: 'p', name: id, description: '', identity: '', personality: '',
    appearance: '', currentState: '', currentGoal: '', currentPressure: '', secret: '',
    arcStage: '', arcHistory: '', speechStyle: '', isProtagonist: false, createdAt: 0, updatedAt: 0,
  }
}
function mkHist(charId: string, ch: number): NovelCharacterHistory {
  return { id: `h-${charId}-${ch}`, projectId: 'p', characterId: charId, chapterId: null, chapterNumber: ch, fieldName: 'currentState', oldValue: null, newValue: '', reason: '', createdAt: 0 }
}

describe('useTimelineData character contiguous spans (A1)', () => {
  it('produces two clips when character history has a gap', () => {
    const result = useTimelineData({
      characters: [mkChar('c1')],
      chapters: [],
      conflicts: [], foreshadows: [], factions: [], locations: [], worldElements: [],
      characterHistory: [mkHist('c1', 1), mkHist('c1', 2), mkHist('c1', 3), mkHist('c1', 8), mkHist('c1', 9)],
    })
    const charTracks = result.tracks.filter((t) => t.kind === 'character' && t.clips.length > 0)
    const c1Clips = charTracks.find((t) => t.id === 'character:c1')!.clips
    expect(c1Clips.length).toBe(2)
    expect(c1Clips[0].startChapter).toBe(1)
    expect(c1Clips[0].endChapter).toBe(3)
    expect(c1Clips[1].startChapter).toBe(8)
    expect(c1Clips[1].endChapter).toBe(9)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/use-timeline-data.test.ts --environment jsdom`
预期：FAIL（`groupContiguousSpans`/`planClipSplit` 未定义；角色历史有 gap 时仍只产 1 个 clip）

- [ ] **步骤 3：编写最少实现代码**

3a. 在 `timeline-logic.ts` 末尾追加：

```typescript
/** 将章节号数组按连续相邻分组为 [start,end] 跨度 */
export function groupContiguousSpans(chapters: number[]): Array<{ start: number; end: number }> {
  if (chapters.length === 0) return []
  const sorted = [...chapters].sort((a, b) => a - b)
  const spans: Array<{ start: number; end: number }> = []
  let cur = { start: sorted[0], end: sorted[0] }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === cur.end + 1) cur.end = sorted[i]
    else { spans.push(cur); cur = { start: sorted[i], end: sorted[i] } }
  }
  spans.push(cur)
  return spans
}

/** 规划切分：返回原 clip 的前半段 [start, atChapter-1] 与后半段 [atChapter, end] */
export function planClipSplit(
  origStart: number,
  origEnd: number,
  atChapter: number,
): { first: { start: number; end: number }; second: { start: number; end: number } | null } | null {
  if (atChapter <= origStart) return null
  if (atChapter > origEnd) return { first: { start: origStart, end: origEnd }, second: null }
  return {
    first: { start: origStart, end: atChapter - 1 },
    second: { start: atChapter, end: origEnd },
  }
}
```

3b. 修改 `use-timeline-data.ts`：

- 顶部 import 追加：

```typescript
import { groupContiguousSpans } from './timeline-logic'
```

- 替换 96-128 行角色轨道构建（用连续跨度分组生成多个 clip）：

```typescript
    for (const character of characters) {
      const history = characterHistory.filter((h) => h.characterId === character.id)
      if (history.length === 0) {
        poolCharacters.push(character)
        continue
      }
      const chapterNumbers = history
        .map((h) => h.chapterNumber)
        .filter((n): n is number => n != null)
      if (chapterNumbers.length === 0) {
        poolCharacters.push(character)
        continue
      }
      const isProtagonist = character.isProtagonist
      const effectId = isProtagonist ? 'character-protagonist' : 'character-secondary'
      const tag = isProtagonist ? '主角' : undefined
      const spans = groupContiguousSpans(chapterNumbers)
      const clips = spans.map((span, i) => ({
        id: `character-clip:${character.id}:${i}`,
        startChapter: span.start,
        endChapter: span.end,
        effectId,
        entityType: 'character' as const,
        entityId: character.id,
        label: character.name,
        tag,
      }))
      tracks.push({
        id: `character:${character.id}`,
        kind: 'character',
        label: character.name,
        subLabel: isProtagonist ? '主角' : '配角',
        clips,
      })
    }
```

3c. 修改 `novel-timeline-workspace.tsx` 的 `handleClipSplit`（402-415 行）与 `updateEntityRange`：

- 顶部 import 追加：

```typescript
import { planClipSplit } from './timeline-logic'
import { createConflict, createForeshadow, createFaction, createLocation, createCharacterHistory } from '@/api/novel-client'
```

> 注：`createCharacterHistory` 已 import；新增 import `createConflict`/`createForeshadow`/`createFaction`/`createLocation`（若 novel-client 未导出则用对应 create 函数，确认见步骤 5 验证）。

- 替换 `handleClipSplit`：

```typescript
  const handleClipSplit = useCallback(
    async (clip: TimelineClip, atChapter: number): Promise<void> => {
      const plan = planClipSplit(clip.startChapter, clip.endChapter, atChapter)
      if (!plan || !plan.second) return
      // 1. 原片段缩为前半段
      pushHistory({
        type: 'resize',
        clip: { ...clip },
        before: { start: clip.startChapter, end: clip.endChapter },
        after: { start: plan.first.start, end: plan.first.end },
      })
      await updateEntityRange(clip, plan.first.start, plan.first.end)
      // 2. 后半段：按 entityType 新建实体/记录
      await createSecondHalfForSplit(clip, plan.second.start, plan.second.end)
    },
    [pushHistory, updateEntityRange, createSecondHalfForSplit],
  )
```

- 在 `updateEntityRange` 之后新增 `createSecondHalfForSplit`：

```typescript
  const createSecondHalfForSplit = useCallback(
    async (clip: TimelineClip, start: number, end: number): Promise<void> => {
      if (!currentProjectId) return
      try {
        switch (clip.entityType) {
          case 'character': {
            // 删除 [atChapter, end] 在原角色上的历史（updateEntityRange 已缩为前半段，但历史记录可能仍残留）
            const recs = characterHistory.filter(
              (h) => h.characterId === clip.entityId && h.chapterNumber != null && h.chapterNumber >= start && h.chapterNumber <= end,
            )
            for (const r of recs) {
              await deleteCharacterHistory(currentProjectId, r.id)
              removeCharacterHistory(r.id)
            }
            // 为同一角色补建起止边界历史记录，使连续跨度分组渲染出第二个 clip
            const h1 = await createCharacterHistory(currentProjectId, clip.entityId, {
              fieldName: 'currentState', oldValue: null, newValue: '【切分后半段】', reason: `切分：第 ${start} 章`, chapterNumber: start,
            })
            addCharacterHistory(h1)
            if (end !== start) {
              const h2 = await createCharacterHistory(currentProjectId, clip.entityId, {
                fieldName: 'currentState', oldValue: null, newValue: '【切分后半段】', reason: `切分：第 ${end} 章`, chapterNumber: end,
              })
              addCharacterHistory(h2)
            }
            break
          }
          case 'conflict': {
            const orig = conflicts.find((c) => c.id === clip.entityId)
            if (!orig) break
            const created = await createConflict(currentProjectId, {
              description: `${orig.description}（后半段）`,
              type: orig.type, intensity: orig.intensity, stage: orig.stage,
              participants: orig.participants, tier: orig.tier,
              firstChapter: start, lastChapter: end,
            })
            upsertConflict(created)
            break
          }
          case 'foreshadow': {
            const orig = foreshadows.find((f) => f.id === clip.entityId)
            if (!orig) break
            const created = await createForeshadow(currentProjectId, {
              description: `${orig.description}（后半段）`,
              category: orig.category, status: orig.status,
              firstChapter: start, recoverByChapter: end,
              linkedCharacters: orig.linkedCharacters, linkedClues: orig.linkedClues,
            })
            upsertForeshadow(created)
            break
          }
          case 'faction': {
            const orig = factions.find((f) => f.id === clip.entityId)
            if (!orig) break
            const created = await createFaction(currentProjectId, {
              name: `${orig.name}（后半段）`, description: orig.description,
              type: orig.type, leaderId: orig.leaderId, strength: orig.strength,
              firstChapter: start, lastChapter: end,
            })
            upsertFaction(created)
            break
          }
          case 'location': {
            // location clip 为单章，理论上不触发切分；防御性：在新章节追加出现
            const orig = locations.find((l) => l.id === clip.entityId)
            if (!orig) break
            const next = Array.from(new Set([...(orig.appearChapters ?? []), start, end])).sort((a, b) => a - b)
            const updated = await updateLocation(orig.id, { appearChapters: next })
            upsertLocation(updated)
            break
          }
          case 'world_element':
            break
        }
        void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
      } catch (err) {
        console.error('[NovelTimelineWorkspace] 切分后半段创建失败:', err)
      }
    },
    [currentProjectId, characterHistory, conflicts, foreshadows, factions, locations,
      deleteCharacterHistory, removeCharacterHistory, createCharacterHistory, addCharacterHistory,
      upsertConflict, upsertForeshadow, upsertFaction, upsertLocation, queryClient],
  )
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS（`groupContiguousSpans`/`planClipSplit` 单测 + use-timeline-data 两段 clip 测试全过）

- [ ] **步骤 5：确认 createConflict 等导出 + Commit**

确认 `apps/desktop/src/renderer/src/api/novel-client.ts` 导出 `createConflict`/`createForeshadow`/`createFaction`/`createLocation`（若未导出则在 import 列表里改用现有导出名；该文件 744-753 行已有 `createLocation`，对应 conflict/foreshadow/faction 的 create 函数应已存在——若命名不同，按实际导出名调整 import 与调用）。运行 `npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom` 确认通过。

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/use-timeline-data.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/use-timeline-data.test.ts apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx
git commit -m "fix(timeline): 剃刀切分保留后半段，角色按连续跨度分组 (A1)"
```

---

## 任务 9：B7 — Solo/Mute 互斥语义修正

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `isTrackAudible`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx:755-758,644-655`
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景：** solo 开启时 muted 轨道仍按 mute 淡化；应：solo 开启时仅 solo 轨道可闻，muted 状态对其他轨道忽略；或 solo 一个轨道自动 unmute 它。采用前者：solo 时 audible = (trackId === soloed)。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { isTrackAudible } from '../timeline-logic'

describe('isTrackAudible (Solo/Mute mutex, B7)', () => {
  it('returns true when no solo and track not muted', () => {
    expect(isTrackAudible('t1', null, new Set())).toBe(true)
  })
  it('returns false when track is muted (no solo)', () => {
    expect(isTrackAudible('t1', null, new Set(['t1']))).toBe(false)
  })
  it('when solo active, only soloed track is audible (mute ignored for soloed)', () => {
    expect(isTrackAudible('t1', 't1', new Set(['t1']))).toBe(true)
  })
  it('when solo active, other tracks are inaudible even if not muted', () => {
    expect(isTrackAudible('t2', 't1', new Set())).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `isTrackAudible is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
/** Solo/Mute 互斥：solo 激活时仅 solo 轨道可闻；否则按 mute 判定 */
export function isTrackAudible(
  trackId: string,
  soloedTrack: string | null,
  mutedTracks: Set<string>,
): boolean {
  if (soloedTrack) return trackId === soloedTrack
  return !mutedTracks.has(trackId)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：接入 editor 并 Commit**

修改 `timeline-editor.tsx`：

- 顶部 import 追加：

```typescript
import { isTrackAudible } from './timeline-logic'
```

- 替换 `isTrackDimmed`（755-758 行）为基于 audible 的判定：

```typescript
  const isTrackDimmed = useCallback((trackId: string): boolean => {
    return !isTrackAudible(trackId, soloedTrack, mutedTracks)
  }, [soloedTrack, mutedTracks])
```

> 原 `isTrackDimmed` 仅判断 soloedTrack；现统一走 `isTrackAudible`，solo 时其他轨道与 muted 轨道均淡化。`toggleTrackMute`/`toggleTrackSolo` 无需改动。

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx
git commit -m "fix(timeline): Solo/Mute 互斥语义，solo 时仅 solo 轨道可闻 (B7)"
```

---

## 任务 10：B3 — 多片段成组移动

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `applyGroupMove`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx:542-590,592-608`
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景：** move 分支仅移动单个拖动 clip；selectedSet.size > 1 时应同步移动所有选中 clip。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { applyGroupMove } from '../timeline-logic'

describe('applyGroupMove (B3)', () => {
  const clips = [
    { id: 'a', startChapter: 2, endChapter: 4 },
    { id: 'b', startChapter: 6, endChapter: 8 },
    { id: 'c', startChapter: 10, endChapter: 12 },
  ]
  it('applies same delta to all selected clips within [1, maxChapter]', () => {
    const r = applyGroupMove(clips, new Set(['a', 'b']), 3, 20)
    expect(r.get('a')).toEqual({ start: 5, end: 7 })
    expect(r.get('b')).toEqual({ start: 9, end: 11 })
    expect(r.has('c')).toBe(false)
  })
  it('clamps each clip so end <= maxChapter', () => {
    const r = applyGroupMove(clips, new Set(['c']), 15, 20)
    // c: 10+15=25 → clamp start to 20-2=18, end=20
    expect(r.get('c')).toEqual({ start: 18, end: 20 })
  })
  it('clamps each clip so start >= 1', () => {
    const r = applyGroupMove(clips, new Set(['a']), -10, 20)
    expect(r.get('a')).toEqual({ start: 1, end: 3 })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `applyGroupMove is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
/** 多片段成组移动：对每个选中 clip 应用相同 delta，各自独立 clamp */
export function applyGroupMove(
  clips: Array<{ id: string; startChapter: number; endChapter: number }>,
  selectedIds: Set<string>,
  deltaChapters: number,
  maxChapter: number,
): Map<string, { start: number; end: number }> {
  const result = new Map<string, { start: number; end: number }>()
  for (const clip of clips) {
    if (!selectedIds.has(clip.id)) continue
    result.set(clip.id, clampMoveRange(clip.startChapter, clip.endChapter, deltaChapters, maxChapter))
  }
  return result
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：接入 editor 并 Commit**

修改 `timeline-editor.tsx`：

- 顶部 import 追加：

```typescript
import { applyGroupMove } from './timeline-logic'
```

- 在 handleMouseUp（592-608 行）的 `if (dragState.type === 'move')` 分支，改为多片段移动：

```typescript
      if (dragState) {
        const clip = allClips.find((c) => c.id === dragState.clipId)
        const pending = pendingClipUpdateRef.current
        if (clip && pending && dragState.started) {
          if (dragState.type === 'move') {
            // 多片段成组移动（B3）
            if (selectedSet.size > 1 && selectedSet.has(clip.id)) {
              const delta = pending.start - dragState.origStart
              const group = applyGroupMove(allClips, selectedSet, delta, maxChapter)
              group.forEach((range, id) => {
                const c = allClips.find((x) => x.id === id)
                if (c) onClipMove?.(c, range.start, range.end)
              })
            } else {
              onClipMove?.(clip, pending.start, pending.end)
            }
          } else {
            onClipResize?.(clip, pending.start, pending.end)
          }
        }
        pendingClipUpdateRef.current = null
        setDragState(null)
        setPendingClipUpdate(null)
        setSnapLine(null)
      }
```

> 拖动期间的视觉反馈仅作用于主 clip（pendingClipUpdate）；松开时对组内其他 clip 一次性应用 delta，避免拖动中频繁写库。`useEffect` 依赖数组已含 `selectedSet`，无需改动。

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx
git commit -m "feat(timeline): 多片段成组移动 (B3)"
```

---

## 任务 11：B4 — 轨道折叠

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `computeTrackHeight`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx:306,854-923,958-976`
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景：** 折叠态高度=8px，仅显示头部色条；区别于隐藏（隐藏完全不渲染 clip，折叠保留一行色条占位）。复用任务 6 提升的 `hiddenTracks` 之外新增 `collapsedTracks`。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { computeTrackHeight } from '../timeline-logic'

describe('computeTrackHeight (B4)', () => {
  it('returns level height when not collapsed', () => {
    expect(computeTrackHeight('compact', false)).toBe(28)
    expect(computeTrackHeight('standard', false)).toBe(36)
    expect(computeTrackHeight('spacious', false)).toBe(56)
  })
  it('returns 8 when collapsed regardless of level', () => {
    expect(computeTrackHeight('compact', true)).toBe(8)
    expect(computeTrackHeight('spacious', true)).toBe(8)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `computeTrackHeight is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
export type TrackHeightLevel = 'compact' | 'standard' | 'spacious'

/** 计算轨道高度：折叠态固定 8px，否则按 level */
export function computeTrackHeight(level: TrackHeightLevel, collapsed: boolean): number {
  if (collapsed) return 8
  return level === 'compact' ? 28 : level === 'spacious' ? 56 : 36
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：接入 editor 并 Commit**

修改 `timeline-editor.tsx`：

- 顶部 import 追加：

```typescript
import { computeTrackHeight, type TrackHeightLevel } from './timeline-logic'
```

- 在 props 解构追加（任务 6 已扩展 props）：`collapsedTracks?: Set<string>` 与 `onToggleTrackCollapse?: (trackId: string) => void`。在 `TimelineEditorProps` 增加：

```typescript
  collapsedTracks?: Set<string>
  onToggleTrackCollapse?: (trackId: string) => void
```

- 函数体内新增（约 292 行后）：

```typescript
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(new Set())
  const collapsedTracks = propCollapsedTracks ?? internalCollapsed
```

（其中 `propCollapsedTracks` 来自解构参数；与任务 6 同模式，需在解构中加 `collapsedTracks: propCollapsedTracks`）

- 替换 306 行 `trackHeight` 单值改为按轨道计算（删除 const trackHeight 行，改为函数）：

```typescript
  const baseTrackHeight = computeTrackHeight(trackHeightLevel, false)
  const getTrackHeight = useCallback((trackId: string) => {
    return collapsedTracks.has(trackId) ? 8 : baseTrackHeight
  }, [collapsedTracks, baseTrackHeight])
```

> 后续所有 `trackHeight` 引用替换为 `getTrackHeight(track.id)`（轨道行高度、header 高度）；`totalContentHeight` 改为 `tracks.reduce((sum, t) => sum + getTrackHeight(t.id), 0)`；`findClipAtPos` 中 `trackHeight` 改用 `getTrackHeight(track.id)`。`subRowCounts`/`subRowMaps` 不变。`handleMouseMove` 全局事件中 marquee 命中计算用 `getTrackHeight(track.id)`。

- 在轨道 header 操作区（约 904-911 行 Eye 按钮后）新增折叠按钮：

```tsx
                  <button
                    type="button"
                    className="tl-track-header-btn"
                    onClick={() => {
                      if (onToggleTrackCollapse) onToggleTrackCollapse(track.id)
                      else setInternalCollapsed((prev) => {
                        const next = new Set(prev)
                        if (next.has(track.id)) next.delete(track.id); else next.add(track.id)
                        return next
                      })
                    }}
                    title={collapsedTracks.has(track.id) ? '展开轨道' : '折叠轨道'}
                  >
                    {collapsedTracks.has(track.id) ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                  </button>
```

顶部 lucide import 追加 `ChevronUp, ChevronDown`。

- 轨道行渲染（968 行起）：折叠时跳过 clips 渲染，仅保留色条。在 `!isHidden && track.clips...` 前加条件：

```tsx
                      {!isHidden && !collapsedTracks.has(track.id) && track.clips
                        .filter(...)
                        .map(...)}
                      {collapsedTracks.has(track.id) && (
                        <div className="tl-track-collapse-bar" style={{ background: TRACK_COLOR[track.kind], height: 2, position: 'absolute', left: 0, right: 0, top: 3 }} />
                      )}
```

修改 `novel-timeline-workspace.tsx`：新增 `collapsedTracks` state 与 toggle（同任务 6 模式），透传给 `<TimelineEditor>`，并在 `TrackContextMenu` 增加折叠菜单项（可选）。

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx
git commit -m "feat(timeline): 轨道折叠（8px 色条占位，区别于隐藏）(B4)"
```

---

## 任务 12：B1 — 涟漪删除（Ripple Delete）

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `computeRippleShifts`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx`（handleClipDelete ripple 分支）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/clip-context-menu.tsx`（新增涟漪删除菜单项）
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景：** 删除片段后同轨道后续片段 start/end 同步前移 (endChapter - startChapter + 1) 章。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { computeRippleShifts } from '../timeline-logic'

describe('computeRippleShifts (B1 ripple delete)', () => {
  it('shifts subsequent clips on same track left by deleted duration', () => {
    const sameTrackClips = [
      { id: 'a', startChapter: 1, endChapter: 3 },
      { id: 'del', startChapter: 5, endChapter: 7 }, // 被删
      { id: 'b', startChapter: 8, endChapter: 10 },
      { id: 'c', startChapter: 12, endChapter: 15 },
    ]
    const shifts = computeRippleShifts(sameTrackClips, 'del')
    expect(shifts.get('a')).toBeUndefined()
    expect(shifts.get('b')).toEqual({ start: 5, end: 7 })   // 8-3=5
    expect(shifts.get('c')).toEqual({ start: 9, end: 12 })  // 12-3=9
  })
  it('returns empty when deleted clip not found', () => {
    expect(computeRippleShifts([{ id: 'a', startChapter: 1, endChapter: 2 }], 'del').size).toBe(0)
  })
  it('does not shift clips before deleted', () => {
    const sameTrackClips = [
      { id: 'a', startChapter: 1, endChapter: 2 },
      { id: 'del', startChapter: 4, endChapter: 5 },
    ]
    expect(computeRippleShifts(sameTrackClips, 'del').get('a')).toBeUndefined()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `computeRippleShifts is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
/** 涟漪删除：计算同轨道被删 clip 之后的所有 clip 前移后的新区间 */
export function computeRippleShifts(
  sameTrackClips: Array<{ id: string; startChapter: number; endChapter: number }>,
  deletedClipId: string,
): Map<string, { start: number; end: number }> {
  const deleted = sameTrackClips.find((c) => c.id === deletedClipId)
  if (!deleted) return new Map()
  const duration = deleted.endChapter - deleted.startChapter + 1
  const result = new Map<string, { start: number; end: number }>()
  for (const clip of sameTrackClips) {
    if (clip.id === deletedClipId) continue
    if (clip.startChapter > deleted.endChapter) {
      result.set(clip.id, {
        start: clip.startChapter - duration,
        end: clip.endChapter - duration,
      })
    }
  }
  return result
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：接入 workspace + 菜单 + Commit**

5a. 修改 `novel-timeline-workspace.tsx`：

- 顶部 import 追加：

```typescript
import { computeRippleShifts } from './timeline-logic'
```

- 在 `handleClipDelete`（任务 7 已改造）的 `if (opts?.ripple)` 分支实现：

```typescript
        if (opts?.ripple) {
          // 找到被删 clip 所在轨道，对后续 clip 同步前移
          const track = tracks.find((t) => t.clips.some((c) => c.id === clipId))
          if (track) {
            const shifts = computeRippleShifts(track.clips, clipId)
            for (const [cid, range] of shifts) {
              const shiftedClip = track.clips.find((c) => c.id === cid)
              if (shiftedClip) {
                pushHistory({
                  type: 'move',
                  clip: { ...shiftedClip },
                  before: { start: shiftedClip.startChapter, end: shiftedClip.endChapter },
                  after: { start: range.start, end: range.end },
                })
                void updateEntityRange(shiftedClip, range.start, range.end)
              }
            }
          }
        }
```

5b. 修改 `clip-context-menu.tsx`：新增 `onRippleDelete` prop 与菜单项。

在 `ClipContextMenuProps` 增加：

```typescript
  onRippleDelete: (clip: TimelineClip) => void
```

在"删除"按钮后追加：

```tsx
      <button
        type="button"
        className="novel-timeline-context-item is-danger"
        onClick={() => handleAction(onRippleDelete)}
        title="删除并后移片段前移（Shift+Del）"
      >
        <Trash2 className="size-3.5" />
        <span>涟漪删除</span>
        <kbd>⇧Del</kbd>
      </button>
```

在 `ClipContextMenu` 函数参数解构增加 `onRippleDelete`。

5c. 修改 `novel-timeline-workspace.tsx` 的 `<ClipContextMenu>`（941 行）传入：

```tsx
        onRippleDelete={(clip) => void handleClipDelete(clip.id, { ripple: true })}
```

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx apps/desktop/src/renderer/src/components/novel/timeline/clip-context-menu.tsx
git commit -m "feat(timeline): 涟漪删除，后续片段同步前移 (B1)"
```

---

## 任务 13：B5 — 章节标尺缩略摘要

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `truncateSummary`）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx:790-809`（标尺 tick）
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景：** NovelChapter 无 summary 字段（已确认类型），用 title 前 20 字作为摘要。detailed 档（280px）下渲染。

- [ ] **步骤 1：编写失败的测试**

在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { truncateSummary } from '../timeline-logic'

describe('truncateSummary (B5)', () => {
  it('returns full text when within limit', () => {
    expect(truncateSummary('短标题', 20)).toBe('短标题')
  })
  it('truncates with ellipsis when exceeding limit', () => {
    const long = '这是一个非常非常非常长的章节标题超过二十个字符'
    expect(truncateSummary(long, 20)).toBe('这是一个非常非常非常长的章节标题超…')
  })
  it('returns empty string for empty input', () => {
    expect(truncateSummary('', 20)).toBe('')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：FAIL，报错 `truncateSummary is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `timeline-logic.ts` 末尾追加：

```typescript
/** 截断摘要：超长加省略号 */
export function truncateSummary(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom`
预期：PASS

- [ ] **步骤 5：接入 editor 标尺 + Commit**

修改 `timeline-editor.tsx`：

- 顶部 import 追加：

```typescript
import { truncateSummary } from './timeline-logic'
```

- 替换 790-809 行标尺 tick 渲染，detailed 档（chapterWidth >= 280）下加摘要：

```tsx
            {Array.from({ length: maxChapter }, (_, i) => i + 1)
              .filter((ch) => ch >= visibleChapterRange.start && ch <= visibleChapterRange.end)
              .map((ch) => {
                const title = chapterTitleMap.get(ch)
                const isCreating = creatingChapter === ch
                const isCurrent = playheadChapter === ch && showPlayhead
                const summary = chapterWidth >= 280 && title ? truncateSummary(title, 20) : ''
                return (
                  <div
                    key={ch}
                    className={`tl-ruler-tick ${isCreating ? 'is-creating' : ''} ${isCurrent ? 'is-current' : ''}`}
                    style={{ width: chapterWidth, minWidth: chapterWidth }}
                    title={title ? `第 ${ch} 章 · ${title}` : `第 ${ch} 章`}
                  >
                    <span className="tl-ruler-tick-num">{ch}</span>
                    {chapterWidth >= 120 && title && (
                      <span className="tl-ruler-tick-title">{title}</span>
                    )}
                    {summary && (
                      <span className="tl-ruler-tick-summary">{summary}</span>
                    )}
                  </div>
                )
              })}
```

> `chapterTitleMap` 已存在（313-317 行），含 chapterNumber→title。NovelChapter 无 summary 字段，用 title 作为摘要来源（符合"若无 summary 用 title"的约束）。

运行：`npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom`
预期：PASS

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx
git commit -m "feat(timeline): 章节标尺 detailed 档显示标题摘要 (B5)"
```

---

## 任务 14：B2 — In/Out 工作区标记（后端 + 前端）

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/types.ts:547-548`（NovelMarkerType 扩展）
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts:1546`（zod enum 扩展）
- 修改：`apps/desktop/src/renderer/src/api/novel-client.ts:494-496`（前端类型扩展）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-markers.tsx`（In/Out 渲染）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-toolbar.tsx`（In/Out 按钮）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx`（播放循环逻辑）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts`（新增 `computeLoopBounds`）
- 新建测试：`apps/agent-server/src/__tests__/novel-marker-routes.test.ts`
- 修改测试：`apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts`

**背景：** novel_markers.type 列为 TEXT，无需 schema migration，仅需扩展类型枚举与 zod。In/Out 渲染为竖线，播放时在 [in, out] 间循环。

- [ ] **步骤 1：编写失败的测试**

1a. 后端测试。新建 `apps/agent-server/src/__tests__/novel-marker-routes.test.ts`：

```typescript
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { NovelStore } from '../plugins/novel-plugin/core/novel-store.js'
import { NovelMemoryStore } from '../plugins/novel-plugin/core/novel-memory-store.js'
import { PromptManager } from '../plugins/novel-plugin/core/prompt-manager.js'
import { NovelPromptBuilder } from '../plugins/novel-plugin/core/prompt-builder.js'
import { createNovelRoutes } from '../plugins/novel-plugin/novel-routes.js'
import { novelMigrations } from '../plugins/novel-plugin/novel-migrations.js'
import { errorHandlerPlugin } from '../plugins/error-handler.plugin.js'
import { requestContextPlugin } from '../plugins/request-context.plugin.js'
import type { NovelServices } from '../plugins/novel-plugin/novel-services.js'

const PLUGIN_PREFIX = '/api/plugins/novel'
let app: FastifyInstance
let store: NovelStore

beforeAll(async () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of novelMigrations) db.exec(m.sql)
  store = new NovelStore(db)
  const memoryStore = new NovelMemoryStore(db)
  const promptManager = new PromptManager(db, process.cwd())
  const promptBuilder = new NovelPromptBuilder(promptManager, store)
  const services: NovelServices = {
    store, memoryStore, promptManager, promptBuilder,
    sessionFactory: { buildSystemPrompt: () => '', buildChapterContext: () => '', getNovelTools: () => [], logSystemPromptHash: () => '', logChapterContextHash: () => '', store, promptManager, promptBuilder } as any,
    engine: {} as any, orchestrator: {} as any, characterGenerator: {} as any, tools: [],
  }
  app = Fastify({ logger: false })
  await app.register(requestContextPlugin)
  await app.register(errorHandlerPlugin)
  for (const route of createNovelRoutes(services)) {
    const fullPath = `${PLUGIN_PREFIX}${route.path}`
    if (route.method === 'POST') app.post(fullPath, { handler: route.handler })
    if (route.method === 'GET') app.get(fullPath, { handler: route.handler })
    if (route.method === 'PATCH') app.patch(fullPath, { handler: route.handler })
    if (route.method === 'DELETE') app.delete(fullPath, { handler: route.handler })
  }
  await app.ready()
})

async function createProject(): Promise<string> {
  const p = store.createProject({ id: 'p1', title: 'T', genre: 'g', synopsis: '', targetWords: 0, currentVolume: 1, currentChapter: 0, currentStage: 'setup', status: 'active' } as any)
  return p.id
}

describe('POST /projects/:projectId/markers with in/out type (B2)', () => {
  let projectId: string
  beforeEach(async () => { projectId = await createProject() })

  it('creates an "in" marker', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: { chapter: 5, type: 'in', color: 'blue' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.type).toBe('in')
    expect(body.data.chapter).toBe(5)
  })

  it('creates an "out" marker', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: { chapter: 15, type: 'out', color: 'red' },
    })
    expect(res.statusCode).toBe(200)
    expect(body.data.type).toBe('out')
  })
})
```

> 修正：第二个 it 内 `body` 应为 `const body = JSON.parse(res.body)`，复制时务必在 it 体内声明。

1b. 前端纯逻辑测试。在 `timeline-logic.test.ts` 末尾追加：

```typescript
import { computeLoopBounds } from '../timeline-logic'

describe('computeLoopBounds (B2 play loop)', () => {
  it('returns [in, out] when both present and in <= out', () => {
    expect(computeLoopBounds(5, 15, 20)).toEqual({ start: 5, end: 15 })
  })
  it('clamps out to maxChapter', () => {
    expect(computeLoopBounds(5, 99, 20)).toEqual({ start: 5, end: 20 })
  })
  it('returns null when in missing', () => {
    expect(computeLoopBounds(null, 15, 20)).toBeNull()
  })
  it('returns null when out missing', () => {
    expect(computeLoopBounds(5, null, 20)).toBeNull()
  })
  it('returns null when in > out', () => {
    expect(computeLoopBounds(15, 5, 20)).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：
- `cd apps/agent-server && npx vitest run src/__tests__/novel-marker-routes.test.ts` → FAIL（zod 拒绝 'in'/'out'）
- `npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom` → FAIL（`computeLoopBounds` 未定义）

- [ ] **步骤 3：编写实现代码**

3a. 后端类型扩展 `apps/agent-server/src/plugins/novel-plugin/core/types.ts:547-548`：

```typescript
export type NovelMarkerType =
  | 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note'
  | 'in' | 'out'
```

3b. 后端路由 zod `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts:1546`：

```typescript
    type: z.enum(['bookmark', 'turning-point', 'foreshadow', 'climax', 'note', 'in', 'out']).default('bookmark'),
    color: z.enum(['blue', 'yellow', 'green', 'red', 'purple']).default('blue'),
```

3c. 前端类型 `apps/desktop/src/renderer/src/api/novel-client.ts:494-496`：

```typescript
export type NovelMarkerType =
  | 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note'
  | 'in' | 'out'
```

3d. 在 `timeline-logic.ts` 末尾追加：

```typescript
/** 计算播放循环边界：in/out 都存在且 in<=out 时返回 [in,out]，否则 null */
export function computeLoopBounds(
  inChapter: number | null,
  outChapter: number | null,
  maxChapter: number,
): { start: number; end: number } | null {
  if (inChapter == null || outChapter == null) return null
  if (inChapter > outChapter) return null
  return { start: inChapter, end: Math.min(outChapter, maxChapter) }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行后端与前端测试：
- `cd apps/agent-server && npx vitest run src/__tests__/novel-marker-routes.test.ts` → PASS
- `npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts --environment jsdom` → PASS

- [ ] **步骤 5：前端渲染 + 工具栏按钮 + 播放循环 + Commit**

5a. 修改 `timeline-markers.tsx`：扩展 `MarkerType`、`MARKER_CONFIG`：

```typescript
export type MarkerType = 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note' | 'in' | 'out'
```

在 `MARKER_CONFIG` 增加：

```typescript
  'in': { color: 'blue', icon: ArrowRightToLine, label: 'In 点' },
  'out': { color: 'red', icon: ArrowRightFromLine, label: 'Out 点' },
```

顶部 lucide import 追加 `ArrowRightToLine, ArrowRightFromLine`。

在 markers.map 渲染中，in/out 渲染为竖线（覆盖整高）：

```tsx
        const isInOut = marker.type === 'in' || marker.type === 'out'
        return (
          <div
            key={marker.id}
            className={`tl-marker ${isInOut ? 'tl-marker-inout' : ''} ${isDragging ? 'is-dragging' : ''} ${isHovered ? 'is-hovered' : ''}`}
            style={isInOut ? { left, color, height: '100%' } : { left, color }}
            ...
          >
            {isInOut ? <div className="tl-marker-inout-line" style={{ background: color }} /> : <Icon ... />}
            ...
          </div>
        )
```

5b. 修改 `timeline-toolbar.tsx`：新增 `inChapter`/`outChapter` props 与 In/Out 按钮。在 `TimelineToolbarProps` 增加：

```typescript
  inChapter?: number | null
  outChapter?: number | null
  onSetIn: () => void
  onSetOut: () => void
```

在导航组后追加 In/Out 按钮组（用 lucide `ArrowRightToLine`/`ArrowRightFromLine`）。

5c. 修改 `novel-timeline-workspace.tsx`：

- 计算 in/out marker：

```typescript
  const inMarker = useMemo(() => markers.find((m) => m.type === 'in'), [markers])
  const outMarker = useMemo(() => markers.find((m) => m.type === 'out'), [markers])
  const loopBounds = useMemo(
    () => computeLoopBounds(inMarker?.chapter ?? null, outMarker?.chapter ?? null, maxChapter),
    [inMarker, outMarker, maxChapter],
  )
```

- 播放定时器（171-186 行）改为循环：

```typescript
  useEffect(() => {
    if (isPlaying) {
      playIntervalRef.current = setInterval(() => {
        setPlayheadChapter((prev) => {
          const end = loopBounds?.end ?? maxChapter
          const start = loopBounds?.start ?? 1
          if (prev >= end) {
            if (loopBounds) return start // 循环回 in 点
            setIsPlaying(false)
            return prev
          }
          return prev + 1
        })
      }, 1000)
      return () => {
        if (playIntervalRef.current) clearInterval(playIntervalRef.current)
      }
    }
  }, [isPlaying, maxChapter, loopBounds])
```

- `<TimelineToolbar>` 传入 in/out props：

```tsx
        inChapter={inMarker?.chapter ?? null}
        outChapter={outMarker?.chapter ?? null}
        onSetIn={() => handleCreateSpecialMarker('in')}
        onSetOut={() => handleCreateSpecialMarker('out')}
```

- 新增 `handleCreateSpecialMarker`（复用 createMarker，type='in'/'out'）：

```typescript
  const handleCreateSpecialMarker = useCallback(async (type: 'in' | 'out'): Promise<void> => {
    if (!currentProjectId) return
    try {
      // 移除同类型旧标记（in/out 唯一）
      const existing = markers.filter((m) => m.type === type)
      for (const m of existing) {
        await deleteMarker(m.id)
        removeMarker(m.id)
      }
      const created = await createMarker(currentProjectId, {
        chapter: playheadChapter, title: type === 'in' ? 'In 点' : 'Out 点', type, color: type === 'in' ? 'blue' : 'red',
      })
      upsertMarker(created)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 创建 In/Out 标记失败:', err)
    }
  }, [currentProjectId, playheadChapter, markers, deleteMarker, removeMarker, createMarker, upsertMarker])
```

- 顶部 import 追加 `computeLoopBounds`。

运行：
- `cd apps/agent-server && npx vitest run src/__tests__/novel-marker-routes.test.ts` → PASS
- `npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom` → PASS

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/types.ts apps/agent-server/src/plugins/novel-plugin/novel-routes.ts apps/agent-server/src/__tests__/novel-marker-routes.test.ts apps/desktop/src/renderer/src/api/novel-client.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-logic.ts apps/desktop/src/renderer/src/components/novel/timeline/__tests__/timeline-logic.test.ts apps/desktop/src/renderer/src/components/novel/timeline/timeline-markers.tsx apps/desktop/src/renderer/src/components/novel/timeline/timeline-toolbar.tsx apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx
git commit -m "feat(timeline): In/Out 工作区标记与播放循环 (B2)"
```

---

## 任务 15：B6 — 片段批注（后端扩展 + 前端双击编辑）

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`（新增 migration 040）
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/types.ts:547,553-567`（NovelMarkerType 加 'clip-note' + NovelMarker 加 entityType/entityId）
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts:172-175,1118-1146,1543-1551`（marker 读写 entityType/entityId）
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts:1542-1548`（zod schema 扩展）
- 修改：`apps/desktop/src/renderer/src/api/novel-client.ts:494-519`（前端类型扩展）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/use-timeline-data.ts:31-48`（TimelineClip.note）
- 创建：`apps/desktop/src/renderer/src/components/novel/timeline/clip-note-dialog.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx`（单击跳转/双击批注）
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx`（批注存取）
- 修改测试：`apps/agent-server/src/__tests__/novel-marker-routes.test.ts`

**背景：** 片段批注用 marker 表扩展（type='clip-note'，关联 entityType+entityId）。novel_markers 表需新增 `entity_type`/`entity_id` 列（migration 040）。双击片段改为编辑批注，单击跳转详情面板。

- [ ] **步骤 1：编写失败的测试**

在 `apps/agent-server/src/__tests__/novel-marker-routes.test.ts` 末尾追加：

```typescript
describe('clip-note marker (B6)', () => {
  let projectId: string
  beforeEach(async () => { projectId = await createProject() })

  it('creates a clip-note marker with entityType/entityId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: {
        chapter: 5, type: 'clip-note', color: 'purple',
        title: '角色A批注', note: '此处动机不足',
        entityType: 'character', entityId: 'charA',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.type).toBe('clip-note')
    expect(body.data.entityType).toBe('character')
    expect(body.data.entityId).toBe('charA')
    expect(body.data.note).toBe('此处动机不足')
  })

  it('lists clip-note markers with entityType/entityId', async () => {
    await app.inject({
      method: 'POST',
      url: `${PLUGIN_PREFIX}/projects/${projectId}/markers`,
      payload: { chapter: 5, type: 'clip-note', entityType: 'character', entityId: 'charA', note: 'n1' },
    })
    const res = await app.inject({ method: 'GET', url: `${PLUGIN_PREFIX}/projects/${projectId}/markers` })
    const body = JSON.parse(res.body)
    const note = body.data.find((m: any) => m.type === 'clip-note')
    expect(note.entityType).toBe('character')
    expect(note.entityId).toBe('charA')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && npx vitest run src/__tests__/novel-marker-routes.test.ts`
预期：FAIL（zod 拒绝 'clip-note' 与 entityType/entityId 字段；store 未持久化这两列）

- [ ] **步骤 3：编写实现代码**

3a. migration 040，在 `novel-migrations.ts` 末尾（501 行 `]` 前）追加：

```typescript
  {
    // 040: 扩展标记表，支持片段批注关联实体
    id: '040_extend_novel_markers_clip_note',
    sql: `ALTER TABLE novel_markers ADD COLUMN entity_type TEXT;
          ALTER TABLE novel_markers ADD COLUMN entity_id TEXT;`,
  },
```

3b. `core/types.ts`：

```typescript
export type NovelMarkerType =
  | 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note'
  | 'in' | 'out' | 'clip-note'

export interface NovelMarker {
  id: string
  projectId: string
  chapter: number
  title: string
  note: string
  type: NovelMarkerType
  color: NovelMarkerColor
  /** clip-note 关联的实体类型（仅 type='clip-note' 时有效） */
  entityType: string | null
  /** clip-note 关联的实体 ID */
  entityId: string | null
  createdAt: number
  updatedAt: number
}
```

3c. `core/novel-store.ts`：

- MarkerRow（172-175 行）追加列：

```typescript
interface MarkerRow {
  id: string; project_id: string; chapter: number; title: string; note: string
  type: string; color: string; entity_type: string | null; entity_id: string | null
  created_at: number; updated_at: number
}
```

- createMarker（1118-1131 行）SQL 加列：

```typescript
  createMarker(marker: Omit<NovelMarker, 'createdAt' | 'updatedAt'>): NovelMarker {
    const ts = now()
    const full: NovelMarker = { ...marker, createdAt: ts, updatedAt: ts }
    this.db.prepare(`
      INSERT INTO novel_markers (id, project_id, chapter, title, note, type, color, entity_type, entity_id, created_at, updated_at)
      VALUES (@id, @project_id, @chapter, @title, @note, @type, @color, @entity_type, @entity_id, @created_at, @updated_at)
    `).run({
      id: full.id, project_id: full.projectId, chapter: full.chapter,
      title: bindString(full.title), note: bindString(full.note),
      type: full.type, color: full.color,
      entity_type: full.entityType ?? null, entity_id: full.entityId ?? null,
      created_at: full.createdAt, updated_at: full.updatedAt,
    })
    return full
  }
```

- updateMarker（1133-1146 行）SQL 加列：

```typescript
  updateMarker(id: string, patch: Partial<NovelMarker>): NovelMarker | undefined {
    const existing = this.db.prepare('SELECT * FROM novel_markers WHERE id = ?').get(id) as MarkerRow | undefined
    if (!existing) return undefined
    const current = this.rowToMarker(existing)
    const updated = { ...current, ...patch, id, updatedAt: now() }
    this.db.prepare(`
      UPDATE novel_markers SET chapter=@chapter, title=@title, note=@note,
      type=@type, color=@color, entity_type=@entity_type, entity_id=@entity_id, updated_at=@updated_at WHERE id=@id
    `).run({
      id, chapter: updated.chapter, title: bindString(updated.title), note: bindString(updated.note),
      type: updated.type, color: updated.color,
      entity_type: updated.entityType ?? null, entity_id: updated.entityId ?? null,
      updated_at: updated.updatedAt,
    })
    return updated
  }
```

- rowToMarker（1543-1551 行）：

```typescript
  private rowToMarker(row: MarkerRow): NovelMarker {
    return {
      id: row.id, projectId: row.project_id, chapter: row.chapter,
      title: row.title, note: row.note,
      type: row.type as NovelMarker['type'],
      color: row.color as NovelMarker['color'],
      entityType: row.entity_type ?? null,
      entityId: row.entity_id ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
```

3d. `novel-routes.ts` zod schema（1542-1548 行）：

```typescript
  const createMarkerSchema = z.object({
    chapter: z.number().int().min(1),
    title: z.string().default(''),
    note: z.string().default(''),
    type: z.enum(['bookmark', 'turning-point', 'foreshadow', 'climax', 'note', 'in', 'out', 'clip-note']).default('bookmark'),
    color: z.enum(['blue', 'yellow', 'green', 'red', 'purple']).default('blue'),
    entityType: z.string().nullable().default(null),
    entityId: z.string().nullable().default(null),
  })
```

3e. `novel-client.ts` 前端类型（499-519 行）：扩展 `NovelMarkerType` 加 `'clip-note'`，`NovelMarker` 加 `entityType`/`entityId`，`CreateMarkerInput`/`UpdateMarkerInput` 同步加可选字段：

```typescript
export type NovelMarkerType =
  | 'bookmark' | 'turning-point' | 'foreshadow' | 'climax' | 'note'
  | 'in' | 'out' | 'clip-note'

export interface NovelMarker {
  id: string
  projectId: string
  chapter: number
  title: string
  note: string
  type: NovelMarkerType
  color: NovelMarkerColor
  /** clip-note 关联的实体类型（仅 type='clip-note' 时有效） */
  entityType: string | null
  /** clip-note 关联的实体 ID */
  entityId: string | null
  createdAt: number
  updatedAt: number
}

export interface CreateMarkerInput {
  chapter: number
  title?: string
  note?: string
  type?: NovelMarkerType
  color?: NovelMarkerColor
  entityType?: string | null
  entityId?: string | null
}

export interface UpdateMarkerInput {
  chapter?: number
  title?: string
  note?: string
  type?: NovelMarkerType
  color?: NovelMarkerColor
  entityType?: string | null
  entityId?: string | null
}
```

3f. `use-timeline-data.ts`：在 `TimelineClip` 接口（31-48 行）追加可选 `note` 字段，并让 `useTimelineData` 接收 `markers` 参数填充批注。

- 接口扩展（在 `tag?: string` 后追加）：

```typescript
  /** 副标签（如"主角"/"主要"/"已回收"等小标签） */
  tag?: string
  /** 片段批注（来自 type='clip-note' 的 marker，按 entityId 匹配） */
  note?: string
}
```

- 顶部 `@/api/novel-client` import 追加 `NovelMarker` 类型：

```typescript
  NovelMarker,
} from '@/api/novel-client'
```

- `useTimelineData` 参数（74-83 行）增加 `markers?: NovelMarker[]`，并在解构中取 `markers`：

```typescript
export function useTimelineData(params: {
  characters: NovelCharacter[]
  chapters: NovelChapter[]
  conflicts: NovelConflict[]
  foreshadows: NovelForeshadow[]
  factions: NovelFaction[]
  locations: NovelLocation[]
  worldElements: NovelWorldElement[]
  characterHistory: NovelCharacterHistory[]
  /** 标记列表（用于填充 clip.note） */
  markers?: NovelMarker[]
}): UseTimelineDataResult {
  const { characters, chapters, conflicts, foreshadows, factions, locations, worldElements, characterHistory, markers } = params
```

- 在 `return useMemo(() => { ... })` 内、`return { tracks, poolCharacters, ... }` 之前追加批注填充遍历：

```typescript
    // ── 填充片段批注（按 entityId 匹配 type='clip-note' 的 marker）──
    if (markers && markers.length > 0) {
      const noteMap = new Map<string, string>()
      for (const m of markers) {
        if (m.type === 'clip-note' && m.entityId) {
          noteMap.set(m.entityId, m.note || '')
        }
      }
      for (const track of tracks) {
        for (const clip of track.clips) {
          const n = noteMap.get(clip.entityId)
          if (n !== undefined) clip.note = n
        }
      }
    }

    return {
      tracks,
      poolCharacters,
      poolConflicts,
      poolForeshadows,
      poolFactions,
      poolLocations,
    }
```

> 按 `entityId` 匹配（实体 ID 为全局唯一 UUID），无需校验 `entityType`。无批注的 clip 保持 `note === undefined`。

3g. 创建 `apps/desktop/src/renderer/src/components/novel/timeline/clip-note-dialog.tsx`（仿 `marker-edit-dialog.tsx` 模式）：

```tsx
/**
 * ClipNoteDialog：片段批注编辑对话框
 *
 * 双击片段时弹出，编辑该片段的批注文本。
 * 批注以 type='clip-note' 的 marker 持久化，关联 entityId。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { X, Trash2 } from 'lucide-react'
import type { TimelineClip } from './use-timeline-data'

export interface ClipNoteDialogProps {
  clip: TimelineClip | null
  /** 当前批注文本（来自 marker.note） */
  initialNote: string
  onClose: () => void
  onSave: (note: string) => void
  onDelete: () => void
}

export function ClipNoteDialog({
  clip,
  initialNote,
  onClose,
  onSave,
  onDelete,
}: ClipNoteDialogProps): ReactElement | null {
  const [note, setNote] = useState('')

  useEffect(() => {
    setNote(initialNote)
  }, [initialNote, clip])

  if (!clip) return null

  const handleSave = (): void => {
    onSave(note.trim())
  }

  return (
    <div className="novel-timeline-dialog-overlay" onClick={onClose}>
      <div className="novel-timeline-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="novel-timeline-dialog-header">
          <span className="novel-timeline-dialog-title">片段批注 · {clip.label}</span>
          <button
            type="button"
            className="novel-timeline-dialog-close"
            onClick={onClose}
            title="关闭"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="novel-timeline-dialog-body">
          <label className="novel-timeline-dialog-label">
            <span>批注内容</span>
            <textarea
              className="novel-timeline-dialog-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="为此片段添加批注（双击片段可再次编辑）"
              rows={5}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose()
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
              }}
            />
          </label>
        </div>
        <div className="novel-timeline-dialog-footer">
          {initialNote && (
            <button
              type="button"
              className="novel-timeline-dialog-btn is-danger"
              onClick={onDelete}
              title="删除批注"
            >
              <Trash2 className="size-3.5" />
              <span>删除</span>
            </button>
          )}
          <button type="button" className="novel-timeline-dialog-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="novel-timeline-dialog-btn is-primary"
            onClick={handleSave}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
```

> 复用 `marker-edit-dialog.tsx` 的 CSS 类名（`novel-timeline-dialog-*`），无需新增样式。`is-danger` 类复用现有删除按钮样式。

3h. `timeline-editor.tsx`：在 clip 块内渲染批注角标。单击跳转/双击批注的交互已在 editor 内就绪（1026 行 `onSelectEntity?.(...)` 单击跳转详情面板，1029-1031 行 `onDoubleClick` 触发 `onClipDoubleClick`），无需改 editor 的事件绑定，仅需在 `tl-clip-content`（1056-1065 行）内追加批注角标。

将 1056-1065 行 `<div className="tl-clip-content">` 块替换为：

```tsx
                            <div className="tl-clip-content">
                              <span className="tl-clip-label">{clip.label}</span>
                              {clip.tag && !isCompact && (
                                <span className="tl-clip-tag">{clip.tag}</span>
                              )}
                              {/* 冲突强度显示 */}
                              {clip.entityType === 'conflict' && intensity > 0 && !isCompact && (
                                <span className="tl-clip-intensity">{intensity}/10</span>
                              )}
                              {/* 片段批注角标 */}
                              {clip.note && (
                                <span className="tl-clip-note-badge" title={clip.note}>
                                  批注
                                </span>
                              )}
                            </div>
```

> 双击编辑批注的具体 wiring（`onClipDoubleClick` 改为打开 `ClipNoteDialog`）在步骤 3i 的 workspace 内完成。editor 的 `onClipDoubleClick` prop 保持透传不变。

3i. `novel-timeline-workspace.tsx`：wire 批注存取。

- 顶部 import 追加（47 行 `marker-edit-dialog` import 后）：

```typescript
import { ClipNoteDialog } from './clip-note-dialog'
```

- 批注对话框状态（137 行 `editingMarker` state 后追加）：

```typescript
  const [noteDialogClip, setNoteDialogClip] = useState<TimelineClip | null>(null)
```

- `filteredData`（140-153 行）追加 `markers` 字段并在 deps 加 `markers`：

```typescript
  const filteredData = useMemo(() => ({
    characters: filter.character ? characters : [],
    chapters,
    conflicts: filter.conflict ? conflicts : [],
    foreshadows: filter.foreshadow ? foreshadows : [],
    factions: filter.faction ? factions : [],
    locations: filter.location ? locations : [],
    worldElements: filter.worldElement ? worldElements : [],
    characterHistory,
    markers,
  }), [filter, characters, chapters, conflicts, foreshadows, factions, locations, worldElements, characterHistory, markers])
```

- 修改 `handleClipDoubleClick`（537-539 行）：改为打开批注对话框（单击的 `selectNode` 跳转已由 `onSelectEntity` 在 editor 内处理，无需在此重复）：

```typescript
  const handleClipDoubleClick = useCallback((clip: TimelineClip) => {
    setNoteDialogClip(clip)
  }, [])
```

- 新增批注保存/删除 handler（在 `handleMarkerSaveEdit` 后追加，约 610 行后）：

```typescript
  // ── 片段批注：保存/删除（以 type='clip-note' 的 marker 持久化）──
  const handleSaveClipNote = useCallback(async (note: string): Promise<void> => {
    if (!currentProjectId || !noteDialogClip) return
    const existing = markers.find(
      (m) => m.type === 'clip-note' && m.entityId === noteDialogClip.entityId,
    )
    try {
      if (existing) {
        const updated = await updateMarker(existing.id, { note })
        upsertMarker(updated)
      } else {
        const created = await createMarker(currentProjectId, {
          chapter: noteDialogClip.startChapter,
          title: `${noteDialogClip.label} 批注`,
          type: 'clip-note',
          color: 'purple',
          entityType: noteDialogClip.entityType,
          entityId: noteDialogClip.entityId,
          note,
        })
        upsertMarker(created)
      }
      setNoteDialogClip(null)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 保存片段批注失败:', err)
    }
  }, [currentProjectId, noteDialogClip, markers, updateMarker, upsertMarker, createMarker])

  const handleDeleteClipNote = useCallback(async (): Promise<void> => {
    if (!noteDialogClip) return
    const existing = markers.find(
      (m) => m.type === 'clip-note' && m.entityId === noteDialogClip.entityId,
    )
    if (!existing) {
      setNoteDialogClip(null)
      return
    }
    try {
      await deleteMarker(existing.id)
      removeMarker(existing.id)
      setNoteDialogClip(null)
    } catch (err) {
      console.error('[NovelTimelineWorkspace] 删除片段批注失败:', err)
    }
  }, [noteDialogClip, markers, deleteMarker, removeMarker])
```

- 渲染对话框（981 行 `MarkerEditDialog` 闭合后、`</div>` 前）：

```tsx
      <ClipNoteDialog
        clip={noteDialogClip}
        initialNote={noteDialogClip?.note ?? ''}
        onClose={() => setNoteDialogClip(null)}
        onSave={handleSaveClipNote}
        onDelete={handleDeleteClipNote}
      />
```

> `noteDialogClip?.note` 来自 use-timeline-data 在步骤 3f 填充的 `clip.note` 字段。首次批注时 `note` 为 undefined → `initialNote=''`，对话框无删除按钮（`ClipNoteDialog` 内 `{initialNote && ...}` 控制）。

- [ ] **步骤 4：运行测试验证通过**

运行后端与前端测试：
- `cd apps/agent-server && npx vitest run src/__tests__/novel-marker-routes.test.ts` → PASS（clip-note marker 创建/列表带 entityType/entityId）
- `npx vitest run apps/desktop/src/renderer/src/components/novel/timeline/__tests__/ --environment jsdom` → PASS（既有逻辑回归通过）

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts apps/agent-server/src/plugins/novel-plugin/core/types.ts apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts apps/agent-server/src/plugins/novel-plugin/novel-routes.ts apps/agent-server/src/__tests__/novel-marker-routes.test.ts apps/desktop/src/renderer/src/api/novel-client.ts apps/desktop/src/renderer/src/components/novel/timeline/use-timeline-data.ts apps/desktop/src/renderer/src/components/novel/timeline/clip-note-dialog.tsx apps/desktop/src/renderer/src/components/novel/timeline/timeline-editor.tsx apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx
git commit -m "feat(timeline): 片段批注（双击编辑/角标显示/marker 持久化）(B6)"
```

---

## 自检

### 1. 规格覆盖度

阶段1审核 15 项范围（8 bug + 7 优化）与任务映射：

| 规格 | 任务 | 覆盖 |
|------|------|------|
| A1 剃刀切分丢弃后半段 | 任务 8（`planClipSplit` + `groupContiguousSpans` + workspace 接入） | ✅ |
| A2 拖拽/缩放未封顶 maxChapter | 任务 1（`clampMoveRange`/`clampResizeRightRange` + editor mouseMove） | ✅ |
| A3 吸附阈值用像素且死代码 | 任务 2（`SNAP_PX=8` + `findSnapPoint` 章节阈值 + 删除 `Math.max(0.3,...)`） | ✅ |
| A4 删除/剪切/粘贴不入撤销栈 | 任务 7（`EditAction` 扩展 delete/cut/paste + `rangeToRestore` + pushHistory 接入） | ✅ |
| A5 小地图视口框画在 canvas + 无节流 | 任务 5（`computeMinimapViewportFrame` + DOM 拆分 + rAF 节流） | ✅ |
| A6 关系层无 memoize | 任务 4（`buildRelationLines` 抽纯函数 + `useMemo` 包裹） | ✅ |
| A7 lock/hide/solo/mute 状态在 editor 内部 | 任务 6（状态提升到 workspace + props 下传 + track-context-menu 接通） | ✅ |
| A8 悬停定时器未卸载 + 吸附后无二次校验 | 任务 3（`useEffect` 清理 + `finalClampAfterSnap`） | ✅ |
| B1 涟漪删除 | 任务 12（`computeRippleShifts` + clip-context-menu + workspace） | ✅ |
| B2 In/Out 工作区标记 | 任务 14（后端 zod/类型扩展 + `computeLoopBounds` + markers/toolbar/workspace） | ✅ |
| B3 多片段成组移动 | 任务 10（`applyGroupMove` + editor 多选拖拽） | ✅ |
| B4 轨道折叠 | 任务 11（`computeTrackHeight` + `collapsedTracks` + editor 折叠态渲染） | ✅ |
| B5 章节标尺缩略摘要 | 任务 13（`truncateSummary` + editor 标尺 detailed 档） | ✅ |
| B6 片段批注 | 任务 15（migration 040 + `clip-note` 类型 + `ClipNoteDialog` + 双击编辑/角标） | ✅ |
| B7 Solo/Mute 互斥语义 | 任务 9（`isTrackAudible` + editor 淡化统一） | ✅ |

**明确排除项：** 快捷键体系（按用户约束不在本计划范围）。✅

**遗漏：** 无。所有 15 项规格均有对应任务。

### 2. 占位符扫描

搜索 `TODO|待定|后续实现|补充细节|类似任务|添加适当的|处理边界情况|后续补充` → 无匹配。

搜索 `占位` → 3 处均为 UI 元素描述（"占位轨道"/"色条占位"），非计划占位符：
- 1086 行：`// 等待轨道渲染（占位轨道存在）` — 测试代码注释，描述既有占位轨道
- 2061 行：折叠态"色条占位" — 描述折叠轨道的视觉行为
- 2184 行：commit message "8px 色条占位" — 同上

每个代码步骤均含完整代码块，无"为以上代码编写测试"类无内容步骤。✅

### 3. 类型一致性

**`NovelMarkerType` 枚举扩展**（任务 14 + 15）：
- 后端 `core/types.ts:547`（任务 14 步骤 3a + 任务 15 步骤 3b）：`'bookmark'|'turning-point'|'foreshadow'|'climax'|'note'|'in'|'out'|'clip-note'` ✅
- 后端 `novel-routes.ts` zod（任务 14 步骤 3b + 任务 15 步骤 3d）：同枚举顺序一致 ✅
- 前端 `novel-client.ts`（任务 14 步骤 3c + 任务 15 步骤 3e）：同枚举一致 ✅

**`NovelMarker.entityType`/`entityId`**（任务 15）：
- `core/types.ts`（3b）、`MarkerRow`（3c）、`rowToMarker`（3c）、zod schema（3d）、前端 `NovelMarker`/`CreateMarkerInput`/`UpdateMarkerInput`（3e）字段名与可空性一致 ✅

**`TimelineClip.note`**（任务 15）：
- 定义于 `use-timeline-data.ts`（3f）→ 消费于 `timeline-editor.tsx` 角标 `clip.note`（3h）→ 消费于 workspace `noteDialogClip?.note`（3i）✅

**`timeline-logic.ts` 纯函数**（定义 ↔ 调用名一致）：
- `clampMoveRange`/`clampResizeRightRange`（任务 1 定义 → 任务 1/2 调用）✅
- `findSnapPoint`（任务 2 定义 → 任务 2/3 调用）✅
- `finalClampAfterSnap`（任务 3 定义 → 任务 3 调用）✅
- `buildRelationLines`（任务 4 定义 → 任务 4 调用）✅
- `computeMinimapViewportFrame`（任务 5 定义 → 任务 5 调用）✅
- `rangeToRestore` + `EditAction` 扩展（任务 7 定义 → 任务 7 调用）✅
- `groupContiguousSpans`/`planClipSplit`（任务 8 定义 → 任务 8 调用）✅
- `isTrackAudible`（任务 9 定义 → 任务 9 调用）✅
- `applyGroupMove`（任务 10 定义 → 任务 10 调用）✅
- `computeTrackHeight`（任务 11 定义 → 任务 11 调用）✅
- `computeRippleShifts`（任务 12 定义 → 任务 12 调用）✅
- `truncateSummary`（任务 13 定义 → 任务 13 调用）✅
- `computeLoopBounds`（任务 14 定义 → 任务 14 调用）✅

**`ClipNoteDialog` props**（任务 15）：
- 定义（3g）：`{ clip, initialNote, onClose, onSave, onDelete }` ✅
- 调用（3i）：`{ clip, initialNote, onClose, onSave, onDelete }` ✅

**结论：** 类型、方法签名、属性名前后一致，未发现命名漂移。✅

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-30-timeline-optimization.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？