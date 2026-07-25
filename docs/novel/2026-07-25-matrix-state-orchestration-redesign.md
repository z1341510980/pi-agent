# 矩阵重构方案：从"出场编排"到"状态编排"

> 日期：2026-07-25
> 状态：设计提案
> 范围：apps/desktop/src/renderer/src/components/novel/matrix/

---

## 一、现状与核心矛盾

### 1.1 矩阵当前的双层结构

矩阵由两层构成：

- **主轨道（Entity Row）**：决定"谁在哪一章出场"。角色是离散出场点，冲突/势力/物品是连续跨度，伏笔是事件链节点。这是作者的**编排层**——拖拽、标记、裁剪，所有交互都围绕"出场"展开。

- **子轨道（Subtracks）**：展示实体在各维度上随章节的实际变化（弧光阶段、压力、冲突阶段、张力强度等）。数据来源是 `matrix-aggregation` 返回的 `ChangeRecord[]`，由 AI 创作管线的 Memory Agent 在每章生成后写入。这是**实录层**——只读投影，作者只能看，不能写。

### 1.2 核心矛盾

**作者在创作前脑中的画面是统一的**："张三在第 7 章出场，压力从可控升到崩溃边缘，弧光进入谷底，与反派正面冲突。"

**但矩阵给他的操作手段是割裂的**：他只能在主轨道上"把张三拖到第 7 章"（标记出场），然后等 AI 写完再看子轨道上的变化是否符合预期。如果不符合，他没有任何手段在创作前表达"我希望压力这样变"——只能事后修改实体字段，再重新生成。

这导致：

1. **创作上下文缺失状态约束**。`collectArrangedEntities(playhead)` 只收集"谁在场"，不收集"在场时应该处于什么状态"。AI 拿到的约束是"张三在第 7 章"，而不是"张三在第 7 章压力极高、弧光处于谷底"。
2. **子轨道沦为事后审计工具**。作者展开子轨道只是为了"看 AI 写对了没有"，而不是"规划接下来该怎么变"。子轨道的交互价值被严重低估。
3. **作者对变化的编排意图无处安放**。他可以在实体详情面板里改字段，但那是"全局当前值"，不是"第 N 章应该是这个值"。按章节的状态编排没有入口。

### 1.3 一句话总结

> 主轨道管"谁在场"，子轨道管"在场时怎么变"——但子轨道是只读的。作者需要的是：**在创作之前，按章节设定实体的状态意图，并让这个意图流入 AI 创作管线。**

---

## 二、设计原则

1. **主轨道 = 出场编排，子轨道 = 状态编排**。两层各司其职，但都是可编辑的。
2. **作者意图优先于 AI 实录**。当作者设定了某章的状态 waypoint，AI 创作时应以此为约束；实录与意图的偏差应可视化。
3. **渐进式复杂度**。核心操作（设定 waypoint）必须一步完成；高级操作（多维度编排、偏差处理）按需展开。
4. **不破坏现有数据流**。waypoint 是增量能力，不改变 ChangeRecord 账本结构，不改变 AI 管线的基本流程。

---

## 三、Waypoint 系统（核心新增能力）

### 3.1 概念定义

**Waypoint（状态航点）**：作者在某个实体的某个章节上设定的维度值意图。

```
Waypoint = {
  entityId: string
  entityType: MatrixEntityKind
  chapter: number
  dimension: string      // 如 'character.pressure', 'character.arc_stage'
  value: unknown         // 如 'extreme', 'rock_bottom', 7
  note?: string          // 作者备注（"这里需要转折"）
  createdAt: string
}
```

Waypoint 不是 ChangeRecord。ChangeRecord 记录"实际发生了什么变化"（afterValue, beforeValue, reason），Waypoint 记录"作者希望在这一章达到什么状态"。两者可以重合（AI 按意图执行了），也可以不重合（偏差）。

### 3.2 数据存储

**方案 A（推荐）：实体字段内嵌**

在每类实体的数据模型中增加 `waypoints` 字段：

```typescript
// NovelCharacter 扩展
interface NovelCharacter {
  // ...existing fields
  waypoints?: Array<{
    chapter: number
    dimension: string
    value: unknown
    note?: string
  }>
}
```

优点：跟随实体存储，undo/redo 自动覆盖（zundo temporal），无需新 API。
缺点：实体对象体积增大；需要后端 schema 迁移。

**方案 B：独立集合**

新建 `novel_waypoints` 表，通过 `entityId + chapter + dimension` 索引。

优点：不污染实体模型；可以独立查询/清理。
缺点：需要新 API 端点；undo/redo 需要额外处理。

**建议先用方案 A 做原型验证**，确认功能价值后再决定是否迁移到方案 B。

### 3.3 创作管线集成

`collectArrangedEntities(playhead)` 扩展为：

```typescript
function collectArrangedEntities(playhead: number): ArrangedContext {
  return {
    // 现有：谁在场
    characters: charactersAt(playhead),
    conflicts: conflictsAt(playhead),
    // ...

    // 新增：在场实体的 waypoint 约束
    waypoints: getWaypointsAtChapter(playhead),
    // 返回格式：
    // [{ entityId, entityType, dimension, value, note }]
  }
}
```

传给创作管线时，waypoint 变成 Director/Writer 的额外约束：

> "张三在第 7 章出场。作者意图：压力应达到'极高'，弧光应处于'谷底'，关联冲突应包含'师徒决裂'。请在创作中体现这些状态变化。"

Memory Agent 提取实际变化后，前端可以对比 waypoint 与 ChangeRecord：
- 重合 → 正常
- 不重合 → 偏差标记（见 4.3）

### 3.4 Waypoint 与子轨道的关系

子轨道的数据源从单一的 `ChangeRecord[]` 变为双源叠加：

```
子轨道渲染 = renderWaypoints(waypoints) + renderLedger(changeRecords)
```

- **Waypoint 节点**：实心菱形 ◆，作者色（实体色），可拖拽/编辑/删除
- **Ledger 节点**：空心圆点 ○，灰色调，只读
- **两者重合**：菱形内嵌圆点，表示"意图已实现"
- **两者不重合**：菱形与圆点分离，中间连线表示偏差方向

---

## 四、子轨道重构

### 4.1 从"全量平铺"到"核心维度常驻 + 全量按需"

当前问题：一个角色展开后有 5-7 条子轨道（弧光阶段、压力、目标、状态、认知、关联冲突、出场区间），26px × 7 = 182px，信息爆炸。

重构为两级：

**核心维度（常驻，折叠态可见）**：每类实体定义 2 个核心维度，直接显示在实体行内（不展开也能看到）：

| 实体类型 | 核心维度 1 | 核心维度 2 |
|---------|-----------|-----------|
| character | 弧光阶段 (arc_stage) | 当前压力 (pressure) |
| conflict | 冲突阶段 (stage) | 张力强度 (intensity) |
| foreshadow | 伏笔状态 (status) | — |
| clue | 推进进度 (progress) | — |
| faction | 势力状态 (status) | 实力消长 (strength) |
| location | 场景状态 (status) | — |
| item | 物品状态 (status) | — |
| world_element | — | — |
| info_layer | 揭示状态 (revealed) | — |

核心维度在实体行右侧（名称后方）以极简芯片展示：

```
[张三] 主 配角  │ 弧光:上升期 · 压力:高 │  ████████████░░░░
```

芯片取播放头章节处的值（有 waypoint 取 waypoint，否则取最近一条 ChangeRecord）。点击芯片 = 展开该维度的子轨道。

**全量维度（展开态）**：点击展开按钮后，显示所有有数据的子轨道（保持当前行为），但默认只展开核心维度对应的 2 条，其余折叠为"+N 维度"按钮。

### 4.2 子轨道行内布局优化

当前 26px 行高内的布局：`[色点] [标签] [图例色点...] │ [编码区]`

重构为：

```
[色点] [标签 → 当前值]          │ [编码区：色带/曲线/节点 + waypoint 菱形]
       ↑ 点击可切换维度          │
```

- 标签后追加"→ 当前值"（播放头处的值），如 `弧光阶段 → 上升期`
- 图例不再内联显示，改为标签 hover 时的 popover
- 编码区内叠加 waypoint 菱形标记

### 4.3 偏差可视化

当某章节同时存在 waypoint 和 ChangeRecord，且值不一致时：

- 在编码区该章节位置显示一个微小的 `⚡` 标记（amber 色）
- Hover 显示：`意图: 压力=极高 → 实际: 压力=高`
- 实体行左侧名称旁显示偏差计数徽标（如 `⚡2`），提示作者有 2 处偏差待处理

偏差处理操作（右键 ⚡ 标记）：
- "采纳实际值"→ 删除 waypoint，接受 AI 的结果
- "重新生成"→ 以 waypoint 为约束重新触发该章创作
- "忽略"→ 标记为已审阅，不再提示

### 4.4 子轨道交互

| 操作 | 行为 |
|------|------|
| 双击编码区某章节位置 | 设定/编辑该维度的 waypoint |
| 拖拽 waypoint 菱形 | 移动到其他章节 |
| 右键 waypoint | 菜单：编辑值 / 添加备注 / 删除 |
| 点击子轨道标签 | 切换该轨道显示的维度（下拉选择） |
| Ctrl+点击多个 waypoint | 批量删除 |

Waypoint 设定 popover（双击触发）：

```
┌─────────────────────────────┐
│ 压力 · 第 7 章              │
│                             │
│ ○ 低  ○ 中  ● 高  ○ 极高   │  ← enum 类型：单选按钮
│ ○ 崩溃边缘                  │
│                             │
│ 备注: [这里需要转折____]     │  ← 可选
│                             │
│         [取消]  [设定]       │
└─────────────────────────────┘
```

number 类型（如张力强度）：滑块 + 数字输入。
set 类型（如关联冲突）：多选列表（从项目内实体中选择）。
text/reference 类型：文本输入。

---

## 五、主轨道优化

### 5.1 实体行内联状态芯片

在实体名称右侧（subLabel 位置之后），增加核心维度的状态芯片：

```
[▶] [●] 张三 [主] [配角] [弧光:上升期 · 压力:高] [⚡1]  │ 编码区...
```

- 芯片内容 = 播放头章节处的核心维度值（waypoint 优先，否则取最近 ChangeRecord）
- 芯片可点击 → 展开对应子轨道
- 芯片颜色随值变化（压力高 = 红色调，压力低 = 绿色调）
- 侧栏宽度 < 200px 时芯片隐藏（只显示名称）

### 5.2 播放头列增强

当前播放头列只是一列琥珀色高亮。增强为：

- 列顶部（标尺行）：显示章节标题 + 张力值（已有）
- 列内每个活跃实体格：叠加一个 2px 的状态色条（取核心维度 1 的值映射颜色）
- 列底部：显示"本章活跃: 角色 3 · 冲突 2 · 伏笔 1"的微型统计

### 5.3 播放头摘要栏（Playhead Summary Bar）

在标尺行下方、实体行上方，增加一条 32px 高的固定摘要栏：

```
第 7 章「山雨欲来」│ 角色: 张三、李四、王五 │ 冲突: 师徒决裂(升级中) │ 伏笔: 玉佩之谜(待回收) │ [开始创作]
```

- 按实体类型分组，每组显示前 2-3 个名称 + 总数
- 点击实体名 → 滚动定位到该行
- 显示"与上一章差异"：`+王五` `-赵六` `↑压力变化`
- 右侧固定"开始创作"按钮（等价于当前工具栏的创作入口）
- 这条栏就是 `collectArrangedEntities` 的可视化——作者一眼看到 AI 下一章会用到什么

---

## 六、交互体系整理

### 6.1 操作分层

| 层级 | 操作 | 触发方式 | 适用对象 |
|------|------|---------|---------|
| L1 浏览 | 查看出场/状态 | 单击单元格、hover | 所有实体 |
| L2 编排出场 | 标记/删除出场、拖拽跨度 | 双击空格、拖拽色带/端点 | 主轨道 |
| L3 编排状态 | 设定/编辑/删除 waypoint | 双击子轨道格、拖拽菱形 | 子轨道 |
| L4 高级 | 编辑实体、编辑跨度范围、批注 | 右键菜单、双击色带 | 主轨道 |
| L5 批量 | 多选、批量删除 waypoint | Ctrl+点击、Ctrl+A | 全局 |

### 6.2 右键菜单重构

当前右键菜单按实体类型分叉，选项较多。重构为按使用频率排序 + 分组：

```
─── 出场操作 ───
标记本章出场 / 删除本章出场

─── 状态编排 ───
设定本章状态 ▸ [核心维度 1] [核心维度 2] [更多维度...]
查看偏差 (⚡2)

─── 编辑 ───
编辑实体 / 编辑范围 / 修改批注

─── 章节 ───
从此章开始创作 / 重新生成本章
```

### 6.3 拖拽反馈增强

- 拖拽释放后显示 undo toast：`已将张三移至第 7 章 · [撤销]`（3 秒后消失）
- 拖拽 waypoint 时，目标章节格显示虚线框预览
- 拖拽跨度时，实时显示目标范围（已有，保持）

### 6.4 键盘快捷键扩展

| 快捷键 | 行为 |
|--------|------|
| ↑/↓ | 选择上/下一个实体（已有） |
| ←/→ | 移动播放头（已有，标尺聚焦时） |
| Enter | 展开/收起选中实体的子轨道 |
| W | 在播放头处为选中实体设定 waypoint（弹出 popover） |
| Delete | 删除选中 waypoint（子轨道聚焦时） |
| Ctrl+Z / Ctrl+Shift+Z | 撤销/重做（已有） |

---

## 七、视觉语言统一

### 7.1 编排态 vs 实录态

| 视觉属性 | 编排态（作者设定） | 实录态（AI 写入） |
|---------|-----------------|-----------------|
| 节点形状 | 实心菱形 ◆ | 空心圆点 ○ |
| 边框 | 实线 | 虚线 |
| 填充 | 实体色 60% 透明度 | 实体色 25% 透明度 |
| 交互 | 可拖拽、可编辑、可删除 | 只读（hover 查看详情） |

### 7.2 状态色映射

核心维度值 → 语义色（用于芯片、状态色条、waypoint 着色）：

```typescript
const PRESSURE_COLORS: Record<string, string> = {
  '低': '#22c55e',
  '中': '#eab308',
  '高': '#f97316',
  '极高': '#ef4444',
  '崩溃边缘': '#dc2626',
}

const ARC_STAGE_COLORS: Record<string, string> = {
  '铺垫': '#94a3b8',
  '上升期': '#3b82f6',
  '高潮': '#f59e0b',
  '下降期': '#8b5cf6',
  '谷底': '#ef4444',
  '觉醒': '#06b6d4',
  '救赎': '#22c55e',
  // ...
}
```

### 7.3 偏差标记

- 符号：`⚡`（amber-500）
- 位置：实体行名称右侧 / 子轨道编码区对应章节
- Hover 卡内容：`意图: X → 实际: Y · 第 N 章`

---

## 八、代码架构重构

### 8.1 matrix-workspace.tsx 拆分

当前 ~1400 行，职责过重。拆分为：

```
matrix/
├── matrix-workspace.tsx        → 纯布局壳（组合 toolbar + legend + view + dialogs）~200 行
├── matrix-data-hooks.ts        → useMatrixData()：所有 useQuery/useMemo 数据获取与投影
├── matrix-mutations.ts         → useMatrixMutations()：所有写操作（mark/remove/move/create/waypoint）
├── matrix-keyboard.ts          → useMatrixKeyboard()：键盘导航逻辑
├── matrix-dnd-handlers.ts      → useMatrixDnd()：拖拽回调（endpoint/span/cell/sidebar/waypoint）
├── matrix-view.tsx             → 纯渲染（保持，接收预计算数据）
├── matrix-row.tsx              → 行组件（增加状态芯片渲染）
├── matrix-subtracks.tsx        → 子轨道（增加 waypoint 渲染 + 交互）
├── matrix-waypoint-popover.tsx → 新增：waypoint 设定/编辑 popover
├── matrix-playhead-bar.tsx     → 新增：播放头摘要栏
├── matrix-model.ts             → 数据模型（增加 waypoint 投影逻辑）
├── matrix-logic.ts             → 纯函数（增加 waypoint 工具函数）
└── ...其余文件保持不变
```

### 8.2 数据流变更

```
novel-data-store
    │
    ├── entities (含 waypoints 字段)
    │
    ▼
matrix-data-hooks.ts
    ├── buildGroups() → MatrixData
    ├── useQuery(getMatrixAggregation) → changes[]
    ├── buildSubtracksForEntity() → SubtrackDef[]（含 waypoint 叠加）
    └── getWaypointsAtChapter(playhead) → Waypoint[]（供摘要栏和创作管线）
    │
    ▼
matrix-view.tsx（渲染）
    │
    ▼
matrix-mutations.ts（写操作）
    ├── setWaypoint(entityId, chapter, dimension, value)
    ├── removeWaypoint(entityId, chapter, dimension)
    ├── moveWaypoint(entityId, dimension, fromChapter, toChapter)
    └── ...现有操作保持不变
```

### 8.3 子轨道数据模型扩展

```typescript
// SubtrackDef 扩展
interface SubtrackDef {
  // ...existing fields
  /** 作者设定的 waypoint（按章节排序） */
  waypoints?: Array<{
    ch: number
    value: string        // 格式化后的值
    rawValue: unknown    // 原始值
    note?: string
    /** 该章节是否有对应的 ChangeRecord（用于判断偏差） */
    hasLedgerMatch: boolean
    /** 与 ChangeRecord 的值是否一致 */
    isDeviated: boolean
  }>
}
```

---

## 九、实施阶段

### 第一阶段：Waypoint 基础能力（验证价值）

**目标**：让作者能设定 waypoint，让创作管线能消费 waypoint。不改子轨道布局。

- [ ] 实体数据模型增加 `waypoints` 字段（前端 store + 后端 schema）
- [ ] 实体行右键菜单增加"设定本章状态"→ 弹出维度选择 + 值设定 popover
- [ ] 实体行对应章节格显示 waypoint 菱形标记
- [ ] `collectArrangedEntities` 扩展，收集播放头处的 waypoint
- [ ] 创作管线 prompt 中注入 waypoint 约束文本
- [ ] 子轨道编码区叠加 waypoint 菱形（只读展示，不可编辑）

**验证指标**：作者是否实际使用 waypoint？使用频率？设定哪些维度最多？

### 第二阶段：子轨道可编辑 + 状态芯片

**目标**：子轨道从只读变为可编辑，核心维度常驻可见。

- [ ] 子轨道双击设定 waypoint（替代右键菜单入口，更直觉）
- [ ] Waypoint 菱形可拖拽移动章节
- [ ] 右键 waypoint → 编辑/删除/添加备注
- [ ] 实体行内联状态芯片（核心维度值）
- [ ] 子轨道标签后追加"→ 当前值"
- [ ] 图例改为 hover popover（解决重叠问题，已在本次迭代中部分完成）
- [ ] 枚举值中文映射（已在本次迭代中完成）

### 第三阶段：偏差系统 + 播放头增强

**目标**：闭环——作者能看到 AI 是否按意图执行，能处理偏差。

- [ ] 偏差检测：对比 waypoint 与同章节 ChangeRecord
- [ ] 偏差标记（⚡）+ 偏差计数徽标
- [ ] 偏差处理操作（采纳/重新生成/忽略）
- [ ] 播放头摘要栏（Playhead Summary Bar）
- [ ] 播放头列状态色条
- [ ] 与上一章差异指示（+/-/↑）

### 第四阶段：架构清理 + 体验打磨

**目标**：代码可维护性 + 交互细节。

- [ ] matrix-workspace.tsx 拆分为 5 个模块
- [ ] 语义缩放（远景/中景/近景不同信息密度）
- [ ] 拖拽 undo toast
- [ ] 键盘快捷键扩展（W 设定 waypoint、Enter 展开子轨道）
- [ ] 子轨道默认聚焦核心维度 + "+N 维度"折叠

---

## 十、风险与约束

| 风险 | 应对 |
|------|------|
| 后端 schema 迁移（waypoints 字段） | 第一阶段用可选字段，不影响现有数据 |
| AI 管线是否真的会尊重 waypoint 约束 | 第一阶段先验证：对比有/无 waypoint 时的生成质量差异 |
| 子轨道编辑与现有拖拽系统冲突 | waypoint 拖拽使用独立 dnd-kit id 前缀（`waypoint:`），与现有 `cell:`/`span:`/`endpoint:` 隔离 |
| 性能：waypoint 增加后子轨道渲染复杂度 | waypoint 数量远少于 ChangeRecord（作者手动设定 vs AI 每章写入），不构成瓶颈 |
| 作者不使用 waypoint（功能空转） | 第一阶段用右键菜单入口（低侵入），验证后再决定是否提升为子轨道内联交互 |

---

## 附录：本次迭代已完成的优化

以下改动已合入代码，作为重构的基础：

1. **子轨道左侧面板**：图例改为纯色点（hover 显示文字），修复标签与图例重叠
2. **枚举值中文映射**：80+ 个英文 enum 值翻译为中文（弧光阶段、压力等级、冲突阶段等）
3. **set 类型 hover 改进**：显示实际名称列表（顿号连接，超 5 项截断），而非仅"N 项"
4. **实体行溢出处理**：名称 title 属性、subLabel 窄屏隐藏、min-w-0 截断修复
5. **hover 卡增强**：宽度 280→320px、scale+fade 动画、子轨道热区 hover 高亮
