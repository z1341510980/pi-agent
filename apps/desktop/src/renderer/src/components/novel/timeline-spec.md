# 小说时间轴编辑器 Spec v2

> 状态：待评审
> 创建：2026-06-27
> 更新：2026-06-28（基于 react-timeline-editor 实际 API 重写）
> 决策已确认：
> - 插件库：@xzdarcy/react-timeline-editor
> - 双视图可切换（时间轴主 + 画布辅）
> - 章节顺序固定，不调整顺序
> - 提供角色历史补全功能
> - 世界要素显示在固定轨道（不拖入）
> - 冲突分层：主要冲突 / 次要冲突 / 主角目的

---

## 1. 概述

### 1.1 目标

将小说创作工具的可视化从"自由画布"改为"时间轴编辑器"，类似视频剪辑器：
- **X 轴**：章节序号（线性时间流，固定不可调整）
- **Y 轴**：多条元素轨道（章节/角色/冲突分层/伏笔/势力/地点/世界要素）
- **核心交互**：拖动区间元素调整章节范围、从元素池拖入新元素

### 1.2 技术选型：@xzdarcy/react-timeline-editor

**库**：[`@xzdarcy/react-timeline-editor`](https://github.com/xzdarcy/react-timeline-editor) v1.0.0（MIT，2026-01 发布）

**选择理由**：
- ✅ 原生支持轨道（Row）+ 区间（Action）模型，完美契合小说元素与章节范围
- ✅ 内置拖拽移动、端点调整（resize）、网格吸附（gridSnap）
- ✅ 内置横向滚动同步（header ↔ body）
- ✅ 内置行虚拟化（基于 react-virtualized）
- ✅ 支持自定义 action 渲染（`getActionRender`）
- ✅ 支持自定义刻度渲染（`getScaleRender`）
- ✅ 完整的回调：点击/双击/右键/拖拽/resize
- ✅ TypeScript 原生

**对比 dnd-kit + 自定义方案**：节省约 80% 工作量（拖拽、吸附、滚动同步、虚拟化都不用自己写）。

### 1.3 核心映射

| 库概念 | 小说时间轴概念 | 数据来源 |
|--------|--------------|---------|
| `TimelineRow` | 轨道（角色/冲突/伏笔/势力/地点/世界要素） | 每个元素一条 Row |
| `TimelineAction` | 区间元素（元素在章节范围内的出现） | `start`/`end` = 章节号 |
| `TimelineEffect` | 效果类型（用于渲染样式） | character/conflict/foreshadow/... |
| `scale` | 1 个刻度 = 1 章 | 固定 `scale=1` |
| `scaleWidth` | 单章宽度 | 80/180/280（按缩放级别） |
| `gridSnap` | 章节级吸附 | 固定 `true` |
| `getActionRender` | 渲染角色名/冲突名/伏点名 | 自定义 ReactNode |

---

## 2. 数据模型

### 2.1 现有数据复用

| 数据 | 时间轴用途 |
|------|-----------|
| `chapters` | 章节刻度（X 轴），每个章节一个刻度标记 |
| `characterHistory` | 角色轨道：派生区间 `firstChapter = min(chapterNumber)`, `lastChapter = max(chapterNumber)` |
| `conflicts` | 冲突轨道：使用新增 `firstChapter` / `lastChapter` / `tier` 字段 |
| `foreshadows` | 伏笔轨道：使用现有 `firstChapter` / `recoverByChapter` |
| `factions` | 势力轨道：使用新增 `firstChapter` / `lastChapter` |
| `locations` | 地点轨道：使用新增 `appearChapters`（JSON 数组） |
| `worldElements` | 世界要素轨道：全局横线，不绑定章节 |

### 2.2 数据库迁移

```sql
-- migration 035: 扩展冲突表，支持章节区间 + 层级分类
-- tier: main=主要冲突, secondary=次要冲突, goal=主角目的
ALTER TABLE novel_conflicts ADD COLUMN first_chapter INTEGER;
ALTER TABLE novel_conflicts ADD COLUMN last_chapter INTEGER;
ALTER TABLE novel_conflicts ADD COLUMN tier TEXT DEFAULT 'secondary';

-- migration 036: 扩展势力表，支持章节区间
ALTER TABLE novel_factions ADD COLUMN first_chapter INTEGER;
ALTER TABLE novel_factions ADD COLUMN last_chapter INTEGER;

-- migration 037: 扩展地点表，支持多次出现
ALTER TABLE novel_locations ADD COLUMN appear_chapters TEXT;  -- JSON: [1,3,8,9]
```

> SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，迁移代码需用 try-catch 包裹 `ALTER TABLE`，重复执行时捕获错误。所有迁移文件保持幂等。

### 2.3 冲突分层设计（新需求）

`NovelConflict` 新增 `tier` 字段，区分三种叙事要素：

| tier 值 | 含义 | 视觉 | 示例 |
|---------|------|------|------|
| `main` | 主要冲突 | 红色实色区间，置于冲突轨道顶部 | 贯穿全书的核心矛盾（如正邪之争） |
| `secondary` | 次要冲突 | 橙色半透明区间，置于冲突轨道中部 | 局部冲突（如某场景的争执） |
| `goal` | 主角目的 | 紫色虚线区间，置于冲突轨道底部 | 主角的目标/动机（如"找到失落的传承"） |

冲突轨道按 `tier` 分成 3 个子行渲染：
```
冲突轨道:
  ├─ 主要冲突  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  (red)
  ├─ 次要冲突        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓      (orange)
  └─ 主角目的  ░░░░░░░░░░░░░░░░░░░░░░░░  (purple dashed)
```

### 2.4 角色历史补全功能（新需求）

**问题**：旧角色可能无 `characterHistory` 记录，时间轴上不显示。

**补全方案**：
- 在工具栏提供"补全历史"按钮
- 点击后扫描所有角色，对无 `characterHistory` 的角色：
  - 如果角色有 `firstAppearChapter` 字段，创建一条 `characterHistory` 记录
  - 否则弹出对话框让用户选择起始章节（默认第 1 章）
- 批量调用 `createCharacterHistory` API
- 完成后刷新时间轴

**API 设计**：
```typescript
// 前端 client
async function batchCreateCharacterHistory(
  projectId: string,
  records: Array<{ characterId: string; chapterNumber: number }>
): Promise<void>

// 后端路由
POST /api/plugins/novel/projects/:projectId/character-history/batch
Body: { records: Array<{ characterId: string; chapterNumber: number }> }
```

---

## 3. 库 API 映射

### 3.1 核心 Props 配置

```typescript
import { Timeline, TimelineRow, TimelineAction, TimelineEffect } from '@xzdarcy/react-timeline-editor'

const timelineProps = {
  // 数据
  editorData: rows,           // TimelineRow[]
  effects: effectsMap,        // Record<string, TimelineEffect>

  // 刻度配置：1 刻度 = 1 章
  scale: 1,                   // 单个刻度标记范畴 = 1
  scaleWidth: 180,            // 单章宽度（standard 缩放）
  scaleSplitCount: 1,         // 不细分（章节级精度）
  minScaleCount: 20,          // 最少 20 章刻度
  maxScaleCount: Infinity,    // 不限最大刻度
  startLeft: 120,             // 左侧轨道标题宽度

  // 行配置
  rowHeight: 40,              // 每行高度

  // 交互
  gridSnap: true,             // 章节级吸附
  dragLine: true,             // 拖拽辅助线
  disableDrag: false,         // 允许拖动
  enableRowDrag: false,       // 禁止行重排（轨道顺序固定）

  // 回调
  onChange: handleDataChange,
  onClickAction: handleClickAction,
  onDoubleClickAction: handleDoubleClickAction,
  onContextMenuAction: handleContextMenuAction,
  onClickRow: handleClickRow,
  onContextMenuRow: handleContextMenuRow,
  onActionMoveEnd: handleActionMoveEnd,       // 移动结束
  onActionResizeEnd: handleActionResizeEnd,   // 端点调整结束

  // 自定义渲染
  getActionRender: renderAction,   // 自定义 action 内容
  getScaleRender: renderScale,     // 自定义刻度（显示"第N章"）
}
```

### 3.2 数据转换：Novel 数据 → TimelineRow[]

```typescript
/**
 * 将小说数据转换为时间轴库所需的 TimelineRow[] 格式
 * 每个元素（角色/冲突/伏笔/势力/地点/世界要素）对应一行
 */
function buildTimelineRows(data: NovelProjectData): TimelineRow[] {
  const rows: TimelineRow[] = []

  // ── 角色轨道 ──
  for (const character of data.characters) {
    const history = data.characterHistory.filter(h => h.characterId === character.id)
    if (history.length === 0) continue  // 无历史的角色不显示（可通过元素池补全）

    const firstChapter = Math.min(...history.map(h => h.chapterNumber))
    const lastChapter = Math.max(...history.map(h => h.chapterNumber))

    rows.push({
      id: `character:${character.id}`,
      actions: [{
        id: `character-action:${character.id}`,
        start: firstChapter,
        end: lastChapter,
        effectId: character.isProtagonist ? 'character-protagonist' : 'character-secondary',
      }],
    })
  }

  // ── 冲突轨道（按 tier 分行）──
  const conflictTiers: Array<{ tier: ConflictTier; effectId: string }> = [
    { tier: 'main', effectId: 'conflict-main' },
    { tier: 'secondary', effectId: 'conflict-secondary' },
    { tier: 'goal', effectId: 'conflict-goal' },
  ]
  for (const { tier, effectId } of conflictTiers) {
    const tierConflicts = data.conflicts.filter(c => (c.tier ?? 'secondary') === tier)
    if (tierConflicts.length === 0) continue

    rows.push({
      id: `conflict-tier:${tier}`,
      actions: tierConflicts
        .filter(c => c.firstChapter != null)
        .map(c => ({
          id: `conflict-action:${c.id}`,
          start: c.firstChapter!,
          end: c.lastChapter ?? c.firstChapter!,
          effectId,
        })),
    })
  }

  // ── 伏笔轨道 ──
  rows.push({
    id: 'foreshadow-track',
    actions: data.foreshadows
      .filter(f => f.firstChapter != null)
      .map(f => ({
        id: `foreshadow-action:${f.id}`,
        start: f.firstChapter!,
        end: f.recoverByChapter ?? f.firstChapter!,
        effectId: f.recoverByChapter ? 'foreshadow-resolved' : 'foreshadow-pending',
      })),
  })

  // ── 势力轨道 ──
  rows.push({
    id: 'faction-track',
    actions: data.factions
      .filter(f => f.firstChapter != null)
      .map(f => ({
        id: `faction-action:${f.id}`,
        start: f.firstChapter!,
        end: f.lastChapter ?? f.firstChapter!,
        effectId: 'faction',
      })),
  })

  // ── 地点轨道（每个出现章节一个 action）──
  rows.push({
    id: 'location-track',
    actions: data.locations.flatMap(l =>
      (l.appearChapters ?? []).map((ch, i) => ({
        id: `location-action:${l.id}:${i}`,
        start: ch,
        end: ch,
        effectId: 'location',
      })),
    ),
  })

  // ── 世界要素轨道（全局横线，贯穿所有章节）──
  rows.push({
    id: 'world-element-track',
    actions: data.worldElements.map(w => ({
      id: `world-element-action:${w.id}`,
      start: 1,
      end: data.chapters.length,
      effectId: 'world-element',
    })),
  })

  return rows
}
```

### 3.3 效果类型定义

```typescript
const effects: Record<string, TimelineEffect> = {
  // 角色
  'character-protagonist': { id: 'character-protagonist', name: '主角' },
  'character-secondary':   { id: 'character-secondary',   name: '配角' },
  // 冲突
  'conflict-main':         { id: 'conflict-main',         name: '主要冲突' },
  'conflict-secondary':    { id: 'conflict-secondary',    name: '次要冲突' },
  'conflict-goal':         { id: 'conflict-goal',         name: '主角目的' },
  // 伏笔
  'foreshadow-resolved':   { id: 'foreshadow-resolved',   name: '已回收' },
  'foreshadow-pending':    { id: 'foreshadow-pending',    name: '待回收' },
  // 势力/地点/世界要素
  'faction':               { id: 'faction',               name: '势力' },
  'location':              { id: 'location',              name: '地点' },
  'world-element':         { id: 'world-element',         name: '世界要素' },
}
```

### 3.4 自定义渲染

```typescript
// 自定义 action 渲染（显示元素名称）
function renderAction(action: TimelineAction, row: TimelineRow): ReactNode {
  const [type, id] = row.id.split(':')
  const entity = lookupEntity(type, id)
  return (
    <div className="flex h-full items-center px-2 text-xs text-white">
      {entity?.name ?? id}
    </div>
  )
}

// 自定义刻度渲染（显示"第N章"）
function renderScale(scale: number): ReactNode {
  return <span>第 {scale} 章</span>
}
```

---

## 4. 拖拽回调处理

### 4.1 区间移动（拖动整个区间）

```typescript
function handleActionMoveEnd({ action, row, start, end }): void {
  const [type, id] = row.id.split(':')
  // start/end 即新的章节范围
  updateEntityRange(type, id, { firstChapter: start, lastChapter: end })
}
```

### 4.2 端点调整（拖动起止点）

```typescript
function handleActionResizeEnd({ action, row, start, end, dir }): void {
  const [type, id] = row.id.split(':')
  updateEntityRange(type, id, { firstChapter: start, lastChapter: end })
}
```

### 4.3 数据更新分发

```typescript
async function updateEntityRange(type: string, id: string, range: { firstChapter: number; lastChapter: number }): Promise<void> {
  switch (type) {
    case 'character':
      // 角色需要更新 characterHistory（删除旧记录，创建新范围记录）
      await updateCharacterRange(id, range)
      break
    case 'conflict-tier':
      // 冲突直接更新 firstChapter / lastChapter
      await updateConflict(id, range)
      break
    case 'foreshadow-track':
      await updateForeshadow(id, {
        firstChapter: range.firstChapter,
        recoverByChapter: range.lastChapter,
      })
      break
    case 'faction-track':
      await updateFaction(id, range)
      break
    case 'location-track':
      // 地点的 appearChapters 更复杂（单个 action 对应一次出现）
      await updateLocationAppearChapters(id)
      break
  }
}
```

---

## 5. 元素池拖入

### 5.1 元素池设计

左侧侧边栏，列出**未在轨道上出现**的元素：

```typescript
interface ElementPoolProps {
  characters: NovelCharacter[]      // 无 characterHistory 的
  conflicts: NovelConflict[]        // firstChapter 为 null 的
  foreshadows: NovelForeshadow[]    // firstChapter 为 null 的
  factions: NovelFaction[]          // firstChapter 为 null 的
  locations: NovelLocation[]        // appearChapters 为空的
  onDrop: (element: PoolElement, chapter: number) => void
}
```

> 世界要素**不**出现在元素池中（固定轨道，始终显示）。

### 5.2 拖入实现

由于 react-timeline-editor 自身处理轨道内拖拽，元素池拖入需要**自定义拖拽源**：

- 元素池项使用原生 HTML5 拖拽（`draggable` + `onDragStart`）
- 时间轴容器监听 `onDragOver` + `onDrop`
- drop 时根据 `clientX` 计算章节序号：
  ```typescript
  const chapter = Math.floor((dropX - startLeft) / scaleWidth) + 1
  ```
- 调用对应 API 创建记录（如 `createCharacterHistory`）
- 刷新时间轴

### 5.3 拖入 API 调用

| 元素类型 | 拖入动作 | API |
|---------|---------|-----|
| 角色 | 创建 `characterHistory` 记录（firstChapter = lastChapter = dropChapter） | `createCharacterHistory` |
| 冲突 | 更新 `firstChapter` | `updateConflict(id, { firstChapter })` |
| 伏笔 | 更新 `firstChapter` | `updateForeshadow(id, { firstChapter })` |
| 势力 | 更新 `firstChapter` | `updateFaction(id, { firstChapter })` |
| 地点 | 添加到 `appearChapters` | `updateLocation(id, { appearChapters: [...existing, chapter] })` |

---

## 6. 组件结构

```
novel-workspace.tsx
├── ViewSwitcher (新)                       ← 顶部视图切换（时间轴/画布）
├── NovelTimelineWorkspace (新)             ← 时间轴主视图
│   ├── TimelineToolbar                     ← 工具栏（缩放/补全历史/过滤）
│   ├── ElementPool (左侧侧边栏)            ← 元素池
│   │   ├── PoolSearchBox
│   │   └── PoolItem × N (draggable)
│   ├── Timeline (库组件)                   ← @xzdarcy/react-timeline-editor
│   │   ├── TimelineHeader (库内置)         ← 章节刻度
│   │   └── TimelineRows (库内置)           ← 轨道行（虚拟化）
│   │       └── TimelineAction × N          ← 区间元素（自定义渲染）
│   └── ChapterContextMenu                  ← 章节右键菜单（生成/重新生成/查看/删除）
├── NovelCanvas (保留，辅助视图)
├── NovelDetailPanel (复用，不变)
└── ChapterLivePanel (复用，不变)
```

### 6.1 新增组件清单

| 组件 | 路径 | 职责 |
|------|------|------|
| `NovelTimelineWorkspace` | `novel/timeline/novel-timeline-workspace.tsx` | 容器，数据转换，回调处理 |
| `TimelineToolbar` | `novel/timeline/timeline-toolbar.tsx` | 缩放切换、补全历史按钮、过滤 |
| `ElementPool` | `novel/timeline/element-pool.tsx` | 左侧元素池，HTML5 拖拽源 |
| `PoolItem` | `novel/timeline/pool-item.tsx` | 单个可拖动元素 |
| `useTimelineData` | `novel/timeline/use-timeline-data.ts` | Hook：Novel 数据 → TimelineRow[] 转换 |
| `useTimelineCallbacks` | `novel/timeline/use-timeline-callbacks.ts` | Hook：拖拽/点击/右键回调处理 |
| `ChapterContextMenu` | `novel/timeline/chapter-context-menu.tsx` | 章节右键菜单（复用现有逻辑） |

> 相比 v1 spec，组件数量从 14 个减少到 7 个——库内置了 TrackRow/ChapterBlock/CharacterRange 等渲染逻辑。

---

## 7. 视觉规范

### 7.1 效果样式（通过 CSS）

```less
// 角色
.timeline-action[data-effect-id="character-protagonist"] {
  background: rgb(59 130 246 / 0.4);  // blue-500 40%
  border: 1px solid rgb(59 130 246);
}
.timeline-action[data-effect-id="character-secondary"] {
  background: rgb(59 130 246 / 0.15);  // blue-500 15%
  border: 1px solid rgb(59 130 246 / 0.5);
}

// 冲突
.timeline-action[data-effect-id="conflict-main"] {
  background: rgb(244 63 94 / 0.5);    // rose-500 50%
  border: 1px solid rgb(244 63 94);
}
.timeline-action[data-effect-id="conflict-secondary"] {
  background: rgb(249 115 22 / 0.3);   // orange-500 30%
  border: 1px solid rgb(249 115 22);
}
.timeline-action[data-effect-id="conflict-goal"] {
  background: rgb(168 85 247 / 0.2);   // purple-500 20%
  border: 1px dashed rgb(168 85 247);
}

// 伏笔
.timeline-action[data-effect-id="foreshadow-resolved"] {
  background: rgb(16 185 129 / 0.3);   // emerald-500 30%
  border: 1px solid rgb(16 185 129);
}
.timeline-action[data-effect-id="foreshadow-pending"] {
  background: rgb(245 158 11 / 0.3);   // amber-500 30%
  border: 1px solid rgb(245 158 11);
}

// 势力/地点/世界要素
.timeline-action[data-effect-id="faction"] { background: rgb(168 85 247 / 0.2); }
.timeline-action[data-effect-id="location"] { background: rgb(6 182 212 / 0.3); }
.timeline-action[data-effect-id="world-element"] { background: rgb(99 102 241 / 0.15); }
```

### 7.2 缩放级别

通过调整 `scaleWidth` 实现：

| 级别 | scaleWidth | 显示内容 |
|------|-----------|---------|
| compact | 80 | 仅色块 |
| standard | 180 | 元素名称 |
| detailed | 280 | 元素名称 + 描述前 30 字 |

### 7.3 轨道标题（左侧 120px）

每行左侧显示：
- 元素类型图标
- 元素名称（如"林凡"、"夺宝之争"）
- 状态标签（如"主角"、"主要冲突"）

---

## 8. 视图切换

```typescript
type NovelViewMode = 'timeline' | 'canvas'

// 持久化到 useNovelStore
viewMode: NovelViewMode  // 默认 'timeline'
```

```tsx
// novel-workspace.tsx
<div className="flex-1 flex">
  <ViewSwitcher value={viewMode} onChange={setViewMode} />
  {viewMode === 'timeline' ? (
    <NovelTimelineWorkspace
      projectId={currentProjectId}
      creationPhase={creationFlow.phase}
      onRegenerateChapter={handleRegenerateChapter}
    />
  ) : (
    <NovelCanvas {...} />
  )}
  <div className="w-[420px] border-l">
    {isCreationActive ? <ChapterLivePanel /> : <NovelDetailPanel />}
  </div>
</div>
```

---

## 9. MVP 范围（阶段 1）

### 9.1 MVP 包含

- ✅ ViewSwitcher 视图切换
- ✅ NovelTimelineWorkspace + 库组件集成
- ✅ 章节刻度（getScaleRender 显示"第N章"）
- ✅ 角色轨道（从 characterHistory 派生，只读）
- ✅ 冲突轨道（3 个子行：主要/次要/主角目的，只读）
- ✅ 点击 action → 右侧详情面板
- ✅ 章节右键菜单（生成/重新生成/查看/删除）
- ✅ 创作流程脉冲高亮（通过 cursorTime 联动）
- ✅ 缩放 3 档切换

### 9.2 MVP 不包含（阶段 2+）

- ❌ 元素池拖入（阶段 2）
- ❌ 区间拖动/端点调整（阶段 2）
- ❌ 伏笔/势力/地点/世界要素轨道（阶段 2）
- ❌ 角色历史补全（阶段 2）
- ❌ 跨轨道连线（阶段 3）

### 9.3 MVP 验收标准

1. 默认显示时间轴视图，可切换回画布
2. 章节刻度正确显示"第N章"
3. 角色区间从 characterHistory 正确派生
4. 冲突按 tier 分 3 行显示，颜色区分
5. 点击 action → 右侧显示对应详情
6. 章节右键菜单可触发创作流程
7. 缩放 3 档切换正常
8. 横向滚动流畅（< 100 章时）

---

## 10. 实施任务清单

### 阶段 1：MVP（只读时间轴 + 视图切换）

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| 1.1 | 安装库 + 验证导入 | `package.json` | - |
| 1.2 | 添加 viewMode 状态到 store | `novel-store.ts` | - |
| 1.3 | 实现 ViewSwitcher | `novel-workspace.tsx` | 1.2 |
| 1.4 | 实现 useTimelineData（数据转换 Hook） | `timeline/use-timeline-data.ts` | - |
| 1.5 | 实现 NovelTimelineWorkspace 容器 | `timeline/novel-timeline-workspace.tsx` | 1.4 |
| 1.6 | 集成 Timeline 库组件 + 基础配置 | `timeline/novel-timeline-workspace.tsx` | 1.5 |
| 1.7 | 实现自定义 action 渲染 | `timeline/novel-timeline-workspace.tsx` | 1.6 |
| 1.8 | 实现自定义刻度渲染（"第N章"） | `timeline/novel-timeline-workspace.tsx` | 1.6 |
| 1.9 | 实现缩放控制（3 档 scaleWidth） | `timeline/timeline-toolbar.tsx` | 1.6 |
| 1.10 | 接入点击 action → 选中联动 | `timeline/novel-timeline-workspace.tsx` | 1.7 |
| 1.11 | 实现章节右键菜单 | `timeline/chapter-context-menu.tsx` | 1.6 |
| 1.12 | 接入创作流程脉冲高亮 | `timeline/novel-timeline-workspace.tsx` | 1.6 |
| 1.13 | 引入库 CSS + 自定义效果样式 | `timeline/timeline-styles.css` | 1.6 |
| 1.14 | 类型检查 + 手动测试 | - | 全部 |

### 阶段 2：完整轨道 + 编辑能力 + 元素池

| # | 任务 | 依赖 |
|---|------|------|
| 2.1 | migration 035-037（冲突/势力/地点字段扩展） | - |
| 2.2 | 后端 store + API 扩展（含 batch 接口） | 2.1 |
| 2.3 | 前端 client 扩展 | 2.2 |
| 2.4 | 扩展 useTimelineData（伏笔/势力/地点/世界要素轨道） | 2.3 |
| 2.5 | 实现区间拖动 + 端点调整回调 | 2.3 |
| 2.6 | 实现 ElementPool + 拖入 | 2.3 |
| 2.7 | 实现角色历史补全功能 | 2.3 |
| 2.8 | 类型检查 + 手动测试 | 全部 |

### 阶段 3：高级交互

| # | 任务 | 依赖 |
|---|------|------|
| 3.1 | 跨轨道连线（角色↔冲突） | 阶段 2 |
| 3.2 | 多选 + 批量操作 | 阶段 2 |
| 3.3 | 章节跳转输入框 | 阶段 1 |

---

## 11. 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 库 CSS 与 Tailwind 冲突 | 库使用 less + 类名前缀，与 Tailwind 共存无冲突；自定义样式通过 `data-effect-id` 属性选择器 |
| 库内置虚拟化与自定义拖入冲突 | 元素池拖入使用原生 HTML5 拖拽，不与库内部 dnd 冲突 |
| 章节号从 1 开始，库默认从 0 开始 | 数据转换时 `start = chapterNumber`（1-based），库内部按数值渲染无影响 |
| 库的刻度渲染可能不显示章节号 | 使用 `getScaleRender` 自定义渲染"第N章" |
| 库更新频率（5 个月前发布 1.0） | MIT 协议，必要时可 fork 维护 |

---

## 12. 后续步骤

1. **评审本 spec v2**：确认库选型、数据映射、冲突分层、MVP 范围
2. **实现阶段 1 MVP**：按任务清单 1.1-1.14 执行
3. **手动测试验收**：对照 9.3 节验收标准
4. **迭代阶段 2-3**：按需推进
