# 矩阵重构方案 v2：从"出场编排"到"状态编排"（基于代码事实重写）

> 日期：2026-07-25
> 状态：设计提案（替代 v1）
> 范围：apps/desktop/src/renderer/src/components/novel/matrix/ + apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts
> 前置文档：[2026-07-25-matrix-state-orchestration-redesign.md](./2026-07-25-matrix-state-orchestration-redesign.md)（v1，已废弃）

---

## 一、v1 方案的问题与本次重写动机

v1 方案的核心叙事是"主轨道管出场，子轨道管实录，作者无处表达按章节状态意图"。经代码核查，这个叙事在三处与事实不符：

### 1.1 子轨道不是纯 AI 实录

[matrix-model.ts:467-478](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts) 的 `buildSubtracksForEntity` 是**三层混叠**，合并优先级为 changes > entity 透传字段 > snapshots：

| 层 | 数据源 | dimension 来源 | 是否读取 source 字段 |
|----|--------|---------------|---------------------|
| 第一层 | `NovelChangeRecord[]`（账本） | `c.dimension` 字符串 | **否**（[matrix-model.ts:355-462](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts) 完全不读取 `source`） |
| 第二层 | 实体结构化字段（`intensityPoints`/`beats`/`chapterSpans`/`stageHistory` 等） | 硬编码字符串（如 `conflict.intensity`） | 不适用 |
| 第三层 | `entity.subtrackSnapshots`（buildGroups 构造） | `snapshot.key` 硬编码 | 不适用 |

`NovelChangeRecord.source` 字段有 4 种取值（`manual`/`ai-extracted`/`ai-planned`/`migration`），但子轨道渲染链路完全忽略它，导致"作者手编"和"AI 实录"在视觉上无法区分。这是死字段问题，不是能力缺失问题。

### 1.2 按章节状态编辑入口已经大量存在

v1 称"按章节的状态编排没有入口"，但实际已有：

| 实体 | 已有按章节字段 | 编辑入口 | 数据来源 |
|------|---------------|---------|---------|
| NovelConflict | `intensityPoints: Array<{chapter, intensity}>` | **无 UI 入口**（仅类型定义） | AI 写入 |
| NovelConflict | `turningPoints: Array<{chapter, label}>` | **无 UI 入口** | AI 写入 |
| NovelConflict | `resolutionProgress: Array<{chapter, percent}>` | **无 UI 入口** | AI 写入 |
| NovelConflict | `climaxChapter: number` | 详情面板 + 主轨道菱形 | 作者 |
| NovelConflict | `chapterSpans` | 拖拽 + 端点 + 右键 + SpanDialog | 混合 |
| NovelConflict | `currentStep/nextStep` | 详情面板 | 混合 |
| NovelCharacter | `arcHistory`（JSON: ArcChange[]） | 矩阵弧光标记（只读）+ ManualHistoryDialog | 混合 |
| NovelCharacter | `characterHistory` | 矩阵单元格 + SpanDialog + ManualHistoryDialog | 混合 |
| NovelForeshadow | `beats: Array<{chapter, type, note}>` | 空格左键 + 右键 + 端点拖拽 + NoteDialog | 混合（作者主导） |
| NovelForeshadow | `firstChapter`/`recoverByChapter` | 端点拖拽 + 详情面板 | 作者 |
| NovelInformationLayer | `revealChapter` | 详情面板 + 主轨道菱形 | 作者 |
| 各类 | `chapterSpans` | 拖拽 + 端点 + 右键 + SpanDialog | 混合 |

真正的能力空缺是：**NovelConflict 的 intensityPoints/turningPoints/resolutionProgress 三个按章节字段由 AI 写入但作者无 UI 编辑入口**，以及 **NovelCharacter 的 arcHistory/pressure 无按章节编辑入口**。其他实体类型的按章节编辑能力已经具备。

### 1.3 prompt 注入已有 waypoint 雏形

[prompt-builder.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts) 的 `formatConstraints` 已经有两个 waypoint 雏形：

- **`ChapterConstraints.conflictTargets`**（[第 1170-1190 行](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)）：含 `targetStage` + `intensityDelta` + `isClimax`，是"本章冲突应推进到 X 阶段、强度变化 Y"的硬约束。仅支持 conflict。
- **`ChapterConstraints.characterArcs`**（[第 1157-1166 行](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)）：含 `character.arcStage`（全局）+ `allowedNextStage`，是"角色当前弧光阶段 + 下一步可达"的约束。但 `arcStage` 是全局当前值，不是按章节值。

而 `formatArrangedEntities`（[第 1264-1622 行](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)）渲染的实体字段**全是全局当前值**（character.currentState/currentGoal/currentPressure、conflict.stage/intensity、foreshadow.status 等），唯一渲染按章节字段的是 `foreshadow.beats[chapter].note`。

`NovelConflict.intensityPoints`/`turningPoints`/`arcHistory` 在 prompt-builder 中**完全不渲染**。这才是真正的注入空缺。

### 1.4 重写动机

v1 方案基于错误认知提出"新建通用 waypoints 字段 + 新建 waypoint popover + 新建偏差检测系统"，会导致：

1. 与已有结构化按章节数据（intensityPoints/beats/arcHistory）双源并行，渲染优先级和偏差基准未定义
2. 通用 `waypoints: Array<{chapter, dimension, value}>` 字段无法承载 set/reference 类型（如 conflict.participants、item.abilities）的复杂值
3. 子轨道三层混叠未先修复 source 死字段问题，叠加 waypoint 会变成四层混叠
4. 拆分 matrix-workspace.tsx 按技术分层（data-hooks/mutations/keyboard/dnd）会引入循环依赖

本方案基于代码事实重新定义核心矛盾，并提出最小侵入的解决路径。

---

## 二、真正的核心矛盾

经代码核查，核心矛盾不是"作者无处表达按章节状态意图"，而是：

> **已有按章节状态数据（intensityPoints/beats/arcHistory 等）存在三类断层：**
>
> 1. **编辑断层**：NovelConflict 的 intensityPoints/turningPoints/resolutionProgress 由 AI 写入但作者无 UI 编辑入口；NovelCharacter 的 arcHistory/pressure 无按章节编辑入口。作者只能事后改全局字段重新生成。
> 2. **渲染断层**：[buildSubtracksFromChanges](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts) 不读取 `ChangeRecord.source` 字段，导致作者手编（source='manual'）与 AI 实录（source='ai-extracted'）在子轨道视觉上无法区分。作者看不出"哪条变化是我设的，哪条是 AI 写的"。
> 3. **注入断层**：[formatArrangedEntities](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts) 渲染的全是实体全局当前值，作者在矩阵上设定的按章节意图（即使是已有的 beats[chapter].note）只有 foreshadow 一类能进入 prompt，其他实体的按章节字段完全不被创作管线消费。

三类断层的根源是"已有能力没接通"，不是"能力缺失"。本方案的目标是**接通断层**，而不是新建并行系统。

---

## 三、设计原则

1. **扩展现有结构化字段，不新建通用 waypoints 数组**。
   - NovelConflict 的 intensityPoints/turningPoints/resolutionProgress 已是按章节数据，给它们补 UI 编辑入口和 note 字段即可。
   - NovelCharacter 的 arcHistory 已是按章节数据，给它在矩阵上补编辑入口即可。
   - NovelForeshadow 的 beats 已是完整模型，不动。
   - 不在实体上加 `waypoints: Array<{chapter, dimension, value}>` 通用字段，避免与结构化字段双源并行。

2. **修复 source 死字段，让子轨道视觉区分作者意图与 AI 实录**。
   - `buildSubtracksFromChanges` 读取 `c.source`，把 source 透传到 `SubtrackDef`。
   - 渲染层根据 source 调整视觉（实心=作者意图，空心=AI 实录）。
   - 偏差检测基于 source 字段，不新建对比逻辑。

3. **prompt 注入走 formatArrangedEntities 内嵌，不新建 Constraints 段**。
   - 扩展 `ArrangedEntity` 增加 `intentsByChapter` 字段，承载播放头处各实体的按章节意图。
   - `collectArrangedEntities` 收集时一并读取 intensityPoints/beats/arcHistory 等结构化字段。
   - `formatArrangedEntities` 在每个实体短卡后追加"本章状态意图"段。
   - 不扩展 `ChapterConstraints`，避免把"实体在某章的状态"误塞进"跨实体规则约束"。

4. **架构清理先行，能力扩展后行**。
   - 先拆 matrix-workspace.tsx（按实体类型拆 mutation，消除 conflict/faction/item 三类镜像代码）。
   - 再拆 matrix-model.ts 的 buildGroups（按实体类型拆 buildXxxGroup）。
   - 修复 performance.ts 配置未生效问题（overscanColumns 硬编码）。
   - 在干净架构上再做能力扩展，避免在 1563 行文件上叠加新逻辑。

5. **不破坏现有数据流**。
   - 不改变 ChangeRecord 账本结构。
   - 不改变 matrix-aggregation API。
   - 不改变 zundo temporal 的 undo/redo 行为。
   - 新增字段全部可选，不影响现有数据。

---

## 四、数据模型扩展

### 4.1 NovelConflict 扩展（packages/shared/src/novel/index.ts）

```typescript
// 现有 intensityPoints 扩展 note 字段
export interface NovelConflictIntensityPoint {
  chapter: number
  intensity: number              // 0-10
  note?: string                  // 新增：作者备注（"这里需要爆发"）
  source?: 'manual' | 'ai'       // 新增：区分作者设定与 AI 写入
}

export interface NovelConflictTurningPoint {
  chapter: number
  label: string
  note?: string                  // 新增
  source?: 'manual' | 'ai'       // 新增
}

export interface NovelConflict {
  // ...existing fields
  intensityPoints?: NovelConflictIntensityPoint[]
  turningPoints?: NovelConflictTurningPoint[]
  resolutionProgress?: Array<{
    chapter: number
    percent: number
    note?: string                // 新增
    source?: 'manual' | 'ai'     // 新增
  }>
}
```

**理由**：
- intensityPoints 已是按章节强度数据，AI 通过 memory-generator 写入。补 note + source 让作者能编辑并标注。
- 不新建 `pressurePoints`/`arcStagePoints` 通用数组，而是让 character 也用类似结构（见 4.2）。
- `source` 字段用 `'manual' | 'ai'` 二值（不是 ChangeRecord 的 4 值），因为这是实体字段层面的标记，不需要区分 ai-extracted/ai-planned/migration。

### 4.2 NovelCharacter 扩展

```typescript
// 新增 pressurePoints 字段（与 intensityPoints 对称）
export interface NovelCharacterPressurePoint {
  chapter: number
  pressure: string               // enum: '低' | '中' | '高' | '极高' | '崩溃边缘'
  note?: string
  source?: 'manual' | 'ai'
}

export interface NovelCharacter {
  // ...existing fields
  pressurePoints?: NovelCharacterPressurePoint[]    // 新增
  // arcHistory 保持现状（已是 JSON: ArcChange[]，含 chapter）
  // arcHistory 的编辑入口在 4.3 节补
}
```

**理由**：
- character.currentPressure 是全局当前值，无法表达"第 7 章压力应达到极高"。新增 pressurePoints 与 conflict.intensityPoints 对称。
- 不动 arcHistory，因为它已经是按章节结构（ArcChange[] 含 chapter），只是缺编辑入口。

### 4.3 不扩展的实体

- **NovelForeshadow**：beats 已是完整模型（含 chapter/type/note），不扩展。
- **NovelClue/Faction/Location/Item/WorldElement/InformationLayer**：按章节字段已够用（chapterSpans + 全局状态字段），不扩展。

### 4.4 ArrangedEntity 扩展（prompt 注入载体）

```typescript
// packages/shared/src/novel/index.ts
export interface ArrangedEntity {
  // ...existing fields
  characterIds: string[]
  conflictIds: string[]
  foreshadowIds: string[]
  clueIds?: string[]
  factionIds: string[]
  locationIds: string[]
  itemIds?: string[]
  characterFunctions?: CharacterFunctionEntry[]

  // 新增：播放头处各实体的按章节状态意图
  intentsByChapter?: Array<{
    entityId: string
    entityType: MatrixEntityKind
    chapter: number
    dimension: string           // 如 'character.pressure', 'conflict.intensity'
    value: unknown              // 如 '极高', 8
    note?: string
    source: 'manual' | 'ai'
  }>
}
```

**理由**：
- 走 ArrangedEntity 而非 ChapterConstraints，因为 waypoint 语义是"实体在某章的状态"，与实体编排同源。
- `intentsByChapter` 是扁平数组，不按实体类型分叉，formatArrangedEntities 内部按 entityId 分组渲染。
- 不在 ArrangedEntity 上加 `waypoints?: Waypoint[]` 独立类型，避免引入新概念。intentsByChapter 的元素就是"已存在的结构化字段在播放头处的投影"，不是新数据。

---

## 五、子轨道改造：从只读到可编辑

### 5.1 修复 source 死字段（第一优先级）

**修改 [matrix-model.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)**：

1. `SubtrackDef` 增加可选 `source?: 'manual' | 'ai'` 字段（[第 98-109 行](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)）。
2. `SubtrackBand`/`SubtrackCurvePoint`/`SubtrackNode` 各增加可选 `source?: 'manual' | 'ai'` 字段。
3. `buildSubtracksFromChanges`（[第 355-462 行](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)）读取 `c.source`，映射规则：
   - `source='manual'` → `'manual'`
   - `source='ai-extracted' | 'ai-planned' | 'migration'` → `'ai'`
4. `buildSubtracksFromEntity`（[第 499-680 行](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)）读取扩展后的 `intensityPoints[].source`/`turningPoints[].source`/`pressurePoints[].source`，透传到 SubtrackDef。

**修改 [matrix-subtracks.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx)**：

视觉区分规则（基于 source）：

| 编码元素 | source='manual'（作者意图） | source='ai'（AI 实录） | source 未定义（保底） |
|---------|---------------------------|----------------------|---------------------|
| enum/level 色块 | 实体色 60% 透明度 + 实线边框 | 实体色 25% 透明度 + 虚线边框 | 实体色 40% 透明度 |
| number sparkline | 实线 + 数据点实心圆 | 虚线 + 数据点空心圆 | 实线 + 数据点空心圆 |
| set/reference/text 圆点 | 实心圆 + 实体色描边 | 空心圆 + 灰色描边 | 空心圆 + 实体色描边 |

**实现位置**：
- `matrix-subtracks.tsx:166-176` 的 enum 色块 `<rect>` 增加 `stroke`/`stroke-dasharray` 属性。
- `matrix-subtracks.tsx:180-193` 的 sparkline `<path>` 增加 `stroke-dasharray` 属性。
- `matrix-subtracks.tsx:188-190` 的数据点 `<circle>` 增加 `fill` 属性。
- `matrix-subtracks.tsx:199-211` 的节点 `<circle>` 增加 `fill`/`stroke` 属性。

### 5.2 子轨道双击设定 intent

**修改 [matrix-subtracks.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx)**：

在 hover 热区 div（[第 215-246 行](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx)）添加 `onDoubleClick`：

```tsx
const handleDoubleClick = (e: React.MouseEvent) => {
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left
  const chapter = Math.floor(x / cellWidth) + 1
  onSetIntent?.({
    entityId: entity.entityId,
    entityType: entity.kind,
    dimension: track.dimension,
    chapter,
  })
}
```

**新增 `onSetIntent` prop**：弹出一个轻量 popover（复用 [matrix-hover-card.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-hover-card.tsx) 的 portal 机制），根据 dimension 的 valueType 渲染不同输入控件：

| valueType | 控件 | 示例 dimension |
|-----------|------|---------------|
| enum/level | 单选按钮组 | character.pressure, conflict.stage |
| number | 滑块 + 数字输入 | conflict.intensity, conflict.resolution |
| set | 多选列表 | conflict.participants |
| reference | 实体搜索框 | conflict.linked_clues |
| text | 文本输入 | conflict.current_step |

**popover 提交后**：根据 entityType 调用对应 mutation（见第六章）。

### 5.3 偏差检测（基于 source 字段）

**不新建偏差检测系统**。偏差的定义是：**同一章节同一 dimension 同时存在 source='manual' 和 source='ai' 的数据，且值不一致**。

**实现**：在 `buildSubtracksForEntity`（[第 467-478 行](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)）合并后，扫描每条 SubtrackDef 的 bands/curve/nodes，找出同章节同 dimension 的 manual/ai 数据对，标记 `isDeviated: boolean` 到 SubtrackDef。

**视觉**：偏差章节位置显示一个 6px 的 `⚡` 图标（amber-500），hover 显示 `意图: X → 实际: Y`。

**偏差处理**（右键 `⚡`）：
- "采纳实际值" → 删除 source='manual' 的数据点
- "重新生成" → 以 manual 值为约束重新触发该章创作
- "忽略" → 标记为 `ignored: true`，不再提示

---

## 六、主轨道优化（不强推状态芯片）

### 6.1 放弃 v1 的"实体行内联状态芯片"

**理由**：[EntityRow](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx) 左侧 sticky 列在 sidebarWidth=240 下已占用 7 个元素（色条/展开按钮/色点/名称/主角徽标/subLabel/note 点），剩余约 127px 给实体名。追加"弧光:上升期 · 压力:高"芯片（约 100-120px）会严重挤压名称 truncate 空间。

**替代方案**：核心维度信息通过子轨道展开查看，不在主轨道常驻。作者需要看状态时展开子轨道即可。

### 6.2 播放头列状态色条（可选，低优先级）

在 [matrix-view.tsx:501-512](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx) 的整列高亮 div 内嵌一个 4px 宽色条，颜色来自播放头处"核心维度 1"的值映射。

**核心维度映射**（与 v1 一致）：

| 实体类型 | 核心维度 |
|---------|---------|
| character | pressure |
| conflict | intensity |
| foreshadow | status |
| 其他 | 不显示色条 |

**实现**：MatrixView 接收 `playheadStateColors: Record<entityId, string>` prop，由 matrix-workspace 计算后传入。

### 6.3 播放头摘要栏（Playhead Summary Bar）

在标尺行下方、实体行上方插入 32px 固定摘要栏。

**虚拟化兼容**（关键）：修改 [matrix-view.tsx:216](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx) 的 `rowsTop` 计算：

```ts
const SUMMARY_H = 32
const rowsTop = RULER_H + SUMMARY_H + (hookRowVisible ? HOOK_H : 0)
```

摘要栏用 `sticky top: RULER_H` 实现悬浮，不计入 `offsets` 数组（offsets 只针对 rows 数组），但需计入 `rowsTop`。关系叠加层 `entityRowY`（[第 453 行](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx)）和 `recomputeWindow`（[第 252 行](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx)）会自动跟随。

**摘要栏内容**：

```
第 7 章「山雨欲来」│ 角色: 张三、李四、王五 │ 冲突: 师徒决裂(升级中) │ 伏笔: 玉佩之谜(待回收) │ [开始创作]
```

- 按实体类型分组，每组显示前 2-3 个名称 + 总数
- 点击实体名 → 滚动定位到该行（复用 `entityRowY` 映射）
- 显示"与上一章差异"：`+王五` `-赵六` `↑压力变化`
- 右侧固定"开始创作"按钮（等价于当前工具栏的创作入口）
- 这条栏就是 `collectArrangedEntities` 的可视化

### 6.4 主轨道 waypoint 菱形（仅在 conflict/info_layer 行）

**不在所有实体行加 waypoint 菱形**。原因：
- [matrix-row.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx) 右侧编码区所有菱形都集中在 `top: ROW_H/2=16`（高潮菱形/信息差揭示菱形/弧光标记），新加菱形会重叠。
- 主轨道的职责是出场编排，状态编排应在子轨道。

**例外**：conflict 行的 `climaxChapter` 菱形和信息差行的 `revealChapter` 菱形已存在，保持现状。这两个是"单点状态意图"，不是通用 waypoint。

---

## 七、prompt 注入设计

### 7.1 扩展 collectArrangedEntities

**修改 [novel-workspace.tsx:573-598](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx)**：

```typescript
const collectArrangedEntities = useCallback((playhead: number) => {
  const arranged: ArrangedEntity = {
    characterIds: /* 现有逻辑 */,
    conflictIds: /* 现有逻辑 */,
    foreshadowIds: /* 现有逻辑 */,
    clueIds: /* 现有逻辑 */,
    factionIds: /* 现有逻辑 */,
    locationIds: /* 现有逻辑 */,
  }

  // 新增：收集播放头处的按章节状态意图
  const intents: ArrangedEntity['intentsByChapter'] = []

  // character 的 pressurePoints + arcHistory
  for (const c of characters) {
    if (!arranged.characterIds.includes(c.id)) continue
    const pressurePoint = c.pressurePoints?.find((p) => p.chapter === playhead)
    if (pressurePoint) {
      intents.push({
        entityId: c.id, entityType: 'character', chapter: playhead,
        dimension: 'character.pressure',
        value: pressurePoint.pressure,
        note: pressurePoint.note,
        source: pressurePoint.source ?? 'manual',
      })
    }
    // arcHistory 的按章节值
    const arcChange = parseArcHistory(c.arcHistory).find((a) => a.chapter === playhead)
    if (arcChange) {
      intents.push({
        entityId: c.id, entityType: 'character', chapter: playhead,
        dimension: 'character.arc_stage',
        value: arcChange.stage,
        source: 'manual',
      })
    }
  }

  // conflict 的 intensityPoints + turningPoints
  for (const c of conflicts) {
    if (!arranged.conflictIds.includes(c.id)) continue
    const intensityPoint = c.intensityPoints?.find((p) => p.chapter === playhead)
    if (intensityPoint) {
      intents.push({
        entityId: c.id, entityType: 'conflict', chapter: playhead,
        dimension: 'conflict.intensity',
        value: intensityPoint.intensity,
        note: intensityPoint.note,
        source: intensityPoint.source ?? 'ai',
      })
    }
    const turningPoint = c.turningPoints?.find((p) => p.chapter === playhead)
    if (turningPoint) {
      intents.push({
        entityId: c.id, entityType: 'conflict', chapter: playhead,
        dimension: 'conflict.turning_point',
        value: turningPoint.label,
        note: turningPoint.note,
        source: turningPoint.source ?? 'ai',
      })
    }
  }

  // foreshadow 的 beats（已有，但之前未收集）
  for (const f of foreshadows) {
    if (!arranged.foreshadowIds.includes(f.id)) continue
    const beat = f.beats?.find((b) => b.chapter === playhead)
    if (beat) {
      intents.push({
        entityId: f.id, entityType: 'foreshadow', chapter: playhead,
        dimension: 'foreshadow.beat',
        value: beat.type,
        note: beat.note,
        source: 'manual',
      })
    }
  }

  arranged.intentsByChapter = intents
  return arranged
}, [characters, characterHistory, conflicts, foreshadows, clues, factions, locations])
```

### 7.2 扩展 formatArrangedEntities

**修改 [prompt-builder.ts:1264-1622](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)**：

在每个实体短卡后追加"本章状态意图"段。例如 character 短卡：

```ts
for (const c of chars) {
  const charLines = [`- **${c.name}**`]
  // ...现有字段渲染（currentState/currentGoal/currentPressure 等）

  // 新增：本章状态意图
  const charIntents = intentsByChapter?.filter((i) => i.entityId === c.id) ?? []
  if (charIntents.length > 0) {
    charLines.push('  ⚡ 本章状态意图：')
    for (const intent of charIntents) {
      const dimLabel = resolveDimensionLabel(intent.dimension)
      const valueLabel = formatIntentValue(intent.dimension, intent.value)
      const noteSuffix = intent.note ? `（${intent.note}）` : ''
      const sourceLabel = intent.source === 'manual' ? '作者设定' : 'AI 推断'
      charLines.push(`    - ${dimLabel}：${valueLabel}${noteSuffix} [${sourceLabel}]`)
    }
  }
}
```

**输出示例**：

```
- **张三**
  笔墨：主角
  身份：剑客
  此刻：被师门追杀
  想要：洗清冤屈
  压力：高
  ⚡ 本章状态意图：
    - 压力：极高（这里需要转折） [作者设定]
    - 弧光阶段：谷底 [作者设定]
```

### 7.3 不扩展 ChapterConstraints

**理由**：
- waypoint 语义是"实体在某章的状态"，不是"跨实体规则约束"。
- 现有 `ChapterConstraints.conflictTargets` 已经是 conflict 专属的 waypoint 雏形（targetStage + intensityDelta），但它只在 AI 编排路径下填充，手动编排路径下不生成。
- 走 ArrangedEntity.intentsByChapter 能覆盖所有实体类型，且与现有 `formatArrangedEntities` 渲染逻辑同源。

### 7.4 Memory Agent 不消费 intentsByChapter

**关键约束**：[novel-memory-generator.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-memory-generator.ts) 的 `buildUserPrompt` 不注入 intentsByChapter。

**理由**：Memory Agent 的职责是"从已生成正文反向抽取实际变化"，如果它看到作者意图，会把意图当实录写入 character_history，污染后续章节的全局当前值。

**实现**：`buildChapterContextShared` 的 shared 层缓存对 4 个 Agent 一致（[第 664-665 行](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts) 注释明确），但 Memory 走独立 `buildUserPrompt`（[第 575-627 行](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-memory-generator.ts)），只注入章节正文 + 当前实体状态。intentsByChapter 只在 shared 层的 `formatArrangedEntities` 中渲染，Memory 不会看到。

### 7.5 Reviewer 增加 waypoint 验收

**修改 [prompt-builder.ts:854-871](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts) 的 Reviewer suffix**：

在现有"矩阵执行验收"段后追加：

```ts
if (arrangedEntities?.intentsByChapter?.length) {
  parts.push('## 状态意图验收')
  parts.push('逐项核对本章状态意图是否在正文中得到体现：')
  for (const intent of arrangedEntities.intentsByChapter) {
    if (intent.source !== 'manual') continue  // 只验收作者设定的意图
    const entity = await this.stores.getEntity(intent.entityId, intent.entityType)
    const dimLabel = resolveDimensionLabel(intent.dimension)
    parts.push(`- ${entity.name} · ${dimLabel}：${formatIntentValue(intent.dimension, intent.value)}`)
  }
  parts.push('若未体现，在 review 反馈中标注偏差。')
}
```

---

## 八、架构清理（先行）

### 8.1 拆分 matrix-workspace.tsx（1563 行 → ~250 行）

**拆分方向**：按业务领域拆，不按技术分层拆。

```
matrix/
├── matrix-workspace.tsx              ~250 行（纯组合 hooks + 渲染 JSX）
├── matrix-data-hooks.ts              useMatrixData() / useMatrixAggregation() / useMatrixPool() / useMatrixMarkers()
├── matrix-mutations/
│   ├── character-mutations.ts        useCharacterMutations()（含 characterHistory + pressurePoints）
│   ├── span-entity-mutations.ts      useSpanEntityMutations()（conflict/faction/item 共享）
│   ├── clue-mutations.ts             useClueMutations()
│   ├── foreshadow-mutations.ts       useForeshadowMutations()（含 beats + firstChapter/recoverByChapter）
│   ├── location-mutations.ts         useLocationMutations()
│   ├── info-layer-mutations.ts       useInfoLayerMutations()
│   ├── entity-create.ts              useEntityCreate()（8 类 createX 分发）
│   ├── chapter-mutations.ts          useChapterDelete()
│   └── marker-note-mutations.ts      useMarkerNoteMutations()
├── matrix-shared/
│   ├── span-helpers.ts               mergeSpanIntoList / findSpanAt
│   ├── foreshadow-helpers.ts         getForeshadowBeats / upsertForeshadowBeat / moveForeshadowEndpointBeat / setForeshadowBeatNote / resolveForeshadowLeftClickBeat
│   └── cell-predicates.ts            isCellEditable / isCellPresent / isCellRemovable
├── matrix-keyboard.ts                useMatrixKeyboard()（moveSelection / selectAllVisible / Enter 展开 / W 设定 intent）
└── matrix-view.tsx                   保持现状（接收预计算数据 + 4 个业务回调）
```

**关键约束**：
- 保留 `useNovelDataStore.getState()` 模式（[matrix-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx) 内 23 处显式 getState 调用），避免闭包陈旧。
- mutation hook 返回 `{ mutate, mutateAsync }` 风格，内部调用 `useNovelDataStore.getState().upsertX` + `invalidateNovelData`。
- `invalidateNovelData` 作为公共依赖，由 `matrix-data-hooks.ts` 导出，各 mutation hook import。

### 8.2 拆分 matrix-model.ts 的 buildGroups（1496 行 → 9 个独立函数）

```
matrix-model/
├── matrix-model.ts                   主入口，re-export
├── build-groups/
│   ├── build-character-group.ts      ~30 行
│   ├── build-conflict-group.ts       ~60 行
│   ├── build-clue-group.ts           ~40 行
│   ├── build-foreshadow-group.ts     ~45 行
│   ├── build-faction-group.ts        ~50 行
│   ├── build-location-group.ts       ~40 行
│   ├── build-world-element-group.ts  ~25 行
│   ├── build-info-layer-group.ts     ~65 行
│   ├── build-item-group.ts           ~45 行
│   └── index.ts                      buildGroups 编排函数 ~30 行
├── subtrack-builders.ts              buildSubtracksForEntity / buildSubtracksFromChanges / buildSubtracksFromEntity / buildSubtracksFromSnapshots / mergeSubtrackDefs
├── row-model.ts                      MatrixRowSpec / buildRowSpecs / computeRowOffsets / computeVisibleRowWindow
├── layout.ts                         MATRIX_LAYOUT
├── labels.ts                         DIMENSION_LABELS / resolveDimensionLabel / translateEnumValue / formatIntentValue
└── types.ts                          SubtrackDef / SubtrackBand / SubtrackCurvePoint / SubtrackNode
```

**理由**：
- 9 类实体的 buildGroup 逻辑结构同构但字段映射不同，直接抽出通用函数会引入大量 if/else 内部分支。
- 每个 buildXxxGroup 函数 30-65 行，单一职责清晰，可独立测试。
- snapshot 构造与 [matrix-model.ts:1028-1043](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts) 的 `snapshot()` helper 解耦。

### 8.3 修复 performance.ts 配置未生效

**问题**：[performance.ts:13-18](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/config/performance.ts) 定义了 `overscanColumns: 3`，但 [matrix-view.tsx:195, 495](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx) 硬编码 `overscan: 3`，配置未生效。

**修复**：
1. `performance.ts` 的 `MatrixPerfConfig` 增加 `overscanRows: number`（默认 6）。
2. `matrix-view.tsx` 改为读取 `runtimePerformance.matrix.overscanColumns` 和 `overscanRows`。
3. 增加单元测试覆盖配置生效。

### 8.4 dnd-kit 扩展（新增 intent 拖拽）

**修改 [matrix-logic.ts:78-120](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-logic.ts)**：

```typescript
// 新增 WaypointDragData（实际上是 IntentDragData，避免引入 waypoint 概念）
export interface IntentDragData {
  source: 'intent'
  entityId: string
  entityType: MatrixEntityKind
  dimension: string
  fromChapter: number
}

export type MatrixDragData =
  | SidebarDragData
  | EndpointDragData
  | SpanDragData
  | CellDragData
  | IntentDragData  // 新增
```

**修改 [matrix-view.tsx:367-416](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx)**：

```tsx
useDndMonitor({
  onDragMove: ({ active }) => {
    const data = active.data.current as MatrixDragData | undefined
    if (data.source === 'span') { /* 现有 */ }
    else if (data.source === 'intent') {
      // intent 拖拽时显示目标章节虚线框预览
      setDragOverChapter(ch)
    }
    // ...
  },
  onDragEnd: ({ active, over }) => {
    if (!over || over.id !== 'matrix-grid') return
    const data = active.data.current as MatrixDragData | undefined
    // ...现有分支
    if (data.source === 'intent') {
      onMoveIntent?.(data.entityId, data.entityType, data.dimension, data.fromChapter, ch)
      return
    }
    // ...
  },
})
```

**MatrixViewProps 增加**：`onMoveIntent?: (entityId, entityType, dimension, fromChapter, toChapter) => void`

**MatrixWorkspace 实现 `handleMoveIntent`**：调用对应实体的 mutation（如 conflict.intensityPoints 的章节移动）。

**冲突避免**：
- intent 菱形 z-index 设为 z-10（高于 endpoint 的 z-5 和 cell 的 default）。
- intent 菱形 Y 偏移到 `top: 4` 或 `top: ROW_H/4=8`，避免与高潮菱形（conflict 行）/揭示菱形（info_layer 行）/弧光标记（character 行）重叠。
- intent 菱形 `stopPropagation` 防止触发 cell 拖拽。
- intent 菱形 useDraggable id 用 `intent:${entityId}:${dimension}:${chapter}` 前缀。

---

## 九、实施阶段

### 第一阶段：架构清理 + source 死字段修复（无新功能）

**目标**：在干净架构上修复 source 死字段，让子轨道视觉区分作者意图与 AI 实录。

- [ ] 拆分 matrix-workspace.tsx（按 8.1 节）
- [ ] 拆分 matrix-model.ts 的 buildGroups（按 8.2 节）
- [ ] 修复 performance.ts 配置未生效（按 8.3 节）
- [ ] SubtrackDef/SubtrackBand/SubtrackCurvePoint/SubtrackNode 增加 source 字段
- [ ] buildSubtracksFromChanges 读取 c.source 并透传
- [ ] buildSubtracksFromEntity 读取扩展后的 intensityPoints[].source 等字段
- [ ] matrix-subtracks.tsx 渲染层根据 source 调整视觉（实心/空心/边框虚实）
- [ ] 单元测试覆盖 source 透传与渲染

**验证指标**：
- matrix-workspace.tsx 行数 ≤ 300
- matrix-model.ts 行数 ≤ 500（拆分后）
- 子轨道上作者手编数据（source='manual'）与 AI 实录（source='ai'）视觉可区分
- performance.ts 配置生效（修改 overscanColumns 后矩阵行为变化）

### 第二阶段：NovelConflict 按章节字段补 UI 编辑入口

**目标**：让作者能编辑 intensityPoints/turningPoints/resolutionProgress。

- [ ] packages/shared 扩展 NovelConflictIntensityPoint/NovelConflictTurningPoint（加 note + source 字段）
- [ ] 子轨道双击设定 intent（按 5.2 节，先支持 conflict.intensity 和 conflict.turning_point）
- [ ] IntentDragData 类型扩展 + matrix-view.tsx onDragEnd 分支（按 8.4 节）
- [ ] matrix-mutations/span-entity-mutations.ts 增加 setIntent/moveIntent/removeIntent
- [ ] 偏差检测（按 5.3 节，基于 source 字段）
- [ ] 偏差处理右键菜单（采纳实际值/重新生成/忽略）
- [ ] 单元测试覆盖 intent CRUD + 偏差检测

**验证指标**：
- 作者能在子轨道双击设定 conflict.intensity 值
- 设定后的 intent 菱形可拖拽移动章节
- 偏差章节显示 ⚡ 标记
- 右键偏差标记可处理

### 第三阶段：NovelCharacter 按章节字段 + prompt 注入

**目标**：让作者能编辑 character.pressure/arc，并让创作管线消费这些意图。

- [ ] packages/shared 扩展 NovelCharacterPressurePoint（按 4.2 节）
- [ ] 子轨道双击支持 character.pressure 和 character.arc_stage
- [ ] character-mutations.ts 增加 setPressurePoint/movePressurePoint/removePressurePoint
- [ ] ArrangedEntity 扩展 intentsByChapter 字段（按 4.4 节）
- [ ] collectArrangedEntities 收集播放头处 intents（按 7.1 节）
- [ ] formatArrangedEntities 渲染"本章状态意图"段（按 7.2 节）
- [ ] Reviewer suffix 增加 waypoint 验收（按 7.5 节）
- [ ] Memory Agent 不消费 intentsByChapter（按 7.4 节，验证）
- [ ] 端到端测试：作者设定 intent → 创作管线消费 → Reviewer 验收

**验证指标**：
- 作者设定 character.pressure=极高 后，Writer 生成的正文中角色压力体现"极高"
- Reviewer 反馈中包含状态意图验收结果
- Memory Agent 写入的 character_history 不包含 intent 值（避免污染）

### 第四阶段：播放头摘要栏 + 体验打磨

**目标**：闭环可视化，作者一眼看到 AI 下一章会用到什么。

- [ ] 播放头摘要栏（按 6.3 节，含 rowsTop 修改）
- [ ] 播放头列状态色条（按 6.2 节，低优先级）
- [ ] 与上一章差异指示（+/-/↑）
- [ ] 拖拽 undo toast
- [ ] 键盘快捷键扩展（W 设定 intent、Enter 展开子轨道、Delete 删除选中 intent）
- [ ] 子轨道默认聚焦核心维度 + "+N 维度"折叠
- [ ] 语义缩放（远景/中景/近景不同信息密度）

**验证指标**：
- 摘要栏显示当前章实体出场情况
- 点击摘要栏实体名可滚动定位
- 拖拽释放后显示 undo toast
- 键盘 W 可设定 intent

---

## 十、风险与约束

| 风险 | 应对 |
|------|------|
| NovelConflict.intensityPoints 已有 AI 写入数据，补 UI 编辑入口后作者改值会覆盖 AI 数据 | source 字段区分：作者设定 source='manual'，AI 写入 source='ai'，两者可共存；偏差检测基于 source |
| 子轨道三层混叠叠加 source 后变成四层（changes/透传/snapshots/source） | source 是 changes 层的子属性，不是独立层；透传字段层（intensityPoints 等）的 source 在 buildSubtracksFromEntity 内透传，不增加层级 |
| buildGroups 拆分后循环引用（matrix-model ↔ matrix-logic） | 保持单向：build-groups/ 子目录只 import matrix-logic 的 GROUP_META/computeMaxChapter 等，不反向 |
| matrix-workspace.tsx 拆分后 mutation hook 闭包陈旧 | 保留 useNovelDataStore.getState() 模式，mutation hook 内部显式调用 getState() |
| ArrangedEntity.intentsByChapter 扩展后 prompt 体积增长 | 每实体最多 2-3 个 intent，每条 intent 一行文本，单章 prompt 增长 < 200 token |
| Memory Agent 误消费 intentsByChapter | Memory 走独立 buildUserPrompt，不调用 formatArrangedEntities；增加集成测试验证 |
| 子轨道双击与现有 hover 卡冲突 | 不同事件类型（mouseover vs dblclick），无冲突；双击会触发两次 click，若 hover 热区有点击逻辑需用 e.detail === 2 区分 |
| intent 菱形与现有 cell/span/endpoint 拖拽冲突 | intent 菱形 z-10 高于 endpoint（z-5）和 cell（default）；Y 偏移到 top:4 避开 top:16 的现有菱形；stopPropagation 防止触发 cell 拖拽 |
| 作者不使用 intent 编辑（功能空转） | 第二阶段先只支持 conflict.intensity（最高频维度），验证使用频率后再扩展到 character |

---

## 附录 A：v1 方案与 v2 方案对比

| 维度 | v1 方案 | v2 方案 |
|------|---------|---------|
| 核心叙事 | 子轨道是纯 AI 实录，作者无处表达按章节意图 | 已有按章节数据存在编辑/渲染/注入三类断层 |
| 数据模型 | 新建通用 `waypoints: Array<{chapter, dimension, value}>` | 扩展现有结构化字段（intensityPoints/pressurePoints）加 note + source |
| 子轨道改造 | 新建 waypoint popover + 偏差检测系统 | 修复 source 死字段 + 双击设定 intent + 基于 source 的偏差检测 |
| 主轨道改造 | 实体内联状态芯片 + 播放头摘要栏 | 放弃状态芯片（容量不足）+ 仅播放头摘要栏 + 状态色条（可选） |
| prompt 注入 | 扩展 collectArrangedEntities 返回 waypoints，未明确注入位置 | 扩展 ArrangedEntity.intentsByChapter，走 formatArrangedEntities 内嵌 |
| 架构清理 | 按技术分层拆（data-hooks/mutations/keyboard/dnd） | 按业务领域拆（character-mutations/span-entity-mutations/...） |
| 实施阶段 | 4 阶段，第一阶段就让创作管线消费 waypoint 但无视觉反馈 | 4 阶段，第一阶段先架构清理 + source 修复，第二阶段才补 UI 编辑入口 |
| 行数声称 | matrix-workspace.tsx ~1400 行 | 实测 1563 行 |
| dnd-kit 扩展 | 仅提"独立 id 前缀" | 明确列出 7 处扩展点（类型/onDragMove/onDragEnd/Props/Workspace 回调等） |

---

## 附录 B：关键代码位置索引

### 数据模型
- 实体类型权威定义：[packages/shared/src/novel/index.ts](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts)
- ArrangedEntity 接口：[packages/shared/src/novel/index.ts:1224-1241](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts)
- ChapterConstraints 接口：[packages/shared/src/novel/index.ts:1127-1152](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts)
- NovelChangeRecord 接口：[packages/shared/src/novel/index.ts:1773-1795](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts)

### 矩阵前端
- matrix-workspace.tsx：[apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)（1563 行）
- matrix-model.ts：[apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)（1496 行）
- matrix-logic.ts：[apps/desktop/src/renderer/src/components/novel/matrix/matrix-logic.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-logic.ts)（607 行）
- matrix-view.tsx：[apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx)（783 行）
- matrix-row.tsx：[apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx)（1050 行）
- matrix-subtracks.tsx：[apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx)（258 行）

### 子轨道三层混叠
- buildSubtracksForEntity：[matrix-model.ts:467-478](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)
- buildSubtracksFromChanges：[matrix-model.ts:355-462](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)
- buildSubtracksFromEntity：[matrix-model.ts:499-680](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)
- buildSubtracksFromSnapshots：[matrix-model.ts:727-805](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)
- mergeSubtrackDefs：[matrix-model.ts:701-713](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)

### 创作管线
- prompt-builder.ts：[apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)
- formatArrangedEntities：[prompt-builder.ts:1264-1622](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)
- formatConstraints：[prompt-builder.ts:1106-1247](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)
- buildChapterContextShared：[prompt-builder.ts:678-817](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)
- Reviewer suffix：[prompt-builder.ts:854-871](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts)
- novel-memory-generator.ts：[apps/agent-server/src/plugins/novel-plugin/core/novel-memory-generator.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-memory-generator.ts)
- collectArrangedEntities：[novel-workspace.tsx:573-598](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx)

### 虚拟化与布局
- MATRIX_LAYOUT 常量：[matrix-model.ts:47-64](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)
- buildRowSpecs：[matrix-model.ts:937-969](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)
- computeRowOffsets：[matrix-model.ts:972-980](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)
- computeVisibleRowWindow：[matrix-model.ts:1012-1026](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-model.ts)
- rowsTop 计算：[matrix-view.tsx:216](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx)
- 垂直虚拟化 overscan=6：[matrix-view.tsx:254](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx)
- 水平虚拟化 overscan=3（硬编码）：[matrix-view.tsx:195, 495](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx)
- EntityRow 左侧 sticky 列：[matrix-row.tsx:300-355](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx)
- EntityRow 右侧编码区：[matrix-row.tsx:358-407](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-row.tsx)
- MatrixSubtracks 编码区 SVG：[matrix-subtracks.tsx:163-212](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx)
- MatrixSubtracks hover 热区：[matrix-subtracks.tsx:215-246](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-subtracks.tsx)
- MatrixDragData 联合类型：[matrix-logic.ts:78-120](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-logic.ts)
- onDragEnd 分发：[matrix-view.tsx:381-416](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx)
- runtimePerformance.matrix：[performance.ts:13-18, 62-65](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/config/performance.ts)

### 按章节编辑入口（现有）
- handleMarkPresent：[matrix-workspace.tsx:571-714](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
- handleRemovePresent：[matrix-workspace.tsx:716-855](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
- handleMarkForeshadowBeat：[matrix-workspace.tsx:857-894](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
- handleMoveEndpoint：[matrix-workspace.tsx:917-988](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
- handleMoveSpan：[matrix-workspace.tsx:991-1027](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
- handleMoveCell：[matrix-workspace.tsx:1031-1070](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
- handleSubmitSpan：[matrix-workspace.tsx:1169-1261](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
- handleSubmitNote：[matrix-workspace.tsx:1108-1151](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
- handleCreateEntity：[matrix-workspace.tsx:1268-1430](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx)
