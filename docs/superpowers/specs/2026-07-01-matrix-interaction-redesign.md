# 章节-实体矩阵视图：交互重设计方案

> 在已有矩阵视图（matrix-logic + MatrixView + MatrixToolbar + MatrixWorkspace）基础上，修复交互缺失、恢复 demo 视觉细节、建立与 NovelSidebar 的联动。**不推翻已有结构，只补齐交互层**。

## 一、问题诊断

### 1. 数据稀疏导致矩阵"空荡"
- `buildGroups` 过滤 `firstChapter == null` / `spans.length === 0` 的实体 → 新项目角色/冲突/伏笔不进矩阵
- 用户看不到 `●▲▼◆` 等符号，误以为"渲染坏了"
- 实际渲染逻辑正确，但缺数据时无引导

### 2. demo 视觉细节丢失
demo (`demo/matrix-view-demo.html`) 有而当前实现没有的：
- **图例条**：toolbar 下方一行符号说明（●出场 ▲▼起止 ◆地点 色带跨度 虚线伏笔）
- **当前章节 badge**：toolbar 右侧 `CH.08 全面开战` 胶囊
- **hover tooltip**：demo 用 `[data-tip]` + CSS 伪元素；当前用原生 `title`（迟钝、不可样式）
- **行 hover 微高亮**：demo `.entity-row:hover{background:rgba(255,255,255,0.018)}`，当前 `hover:bg-muted/30` 偏重

### 3. 交互缺失
- 无双击编辑跨度
- 右键菜单仅"标记/删除出场"，缺"修改起止章节""修改批注"
- 无键盘左右箭头切换 playheadChapter
- 单元格无 hover 缩放反馈（demo 有 `.cell.has-sym:hover .sym{transform:scale(1.35)}`，当前 `group-hover/cell:scale-[1.35]` 但 group/cell 命名空间与 hover 触发条件不匹配）

### 4. NovelSidebar 与 MatrixView 状态割裂
- NovelSidebar `CollapsibleGroup.expanded` 是组件内 useState，与 MatrixView `collapsedGroups` 独立
- NovelSidebar 无 activeFilter 概念
- 两者 `selectNode` 联动已有（都走 store.selectedNodeId），但视觉上 MatrixView 选中高亮未反馈到 NovelSidebar，反之亦然
- 章节项在 NovelSidebar 可展开看"出场角色/伏笔/冲突"，MatrixView 的章节列无对应反查

## 二、设计目标

1. **数据兜底**：空数据时显示引导（"无出场记录，点此补全历史"或"右键新建实体"）
2. **恢复 demo 视觉**：图例、badge、tooltip、hover 微反馈
3. **完善交互**：双击编辑跨度、右键菜单扩展、键盘导航、单元格 hover 缩放
4. **NovelSidebar ↔ MatrixView 联动**：共享折叠/过滤/选中状态，互相同步高亮
5. **保持简洁**：不引入新状态管理库，复用 novel-store

## 三、方案详述

### 3.1 数据兜底与空状态

**matrix-logic.ts 修改**：
- `buildGroups` 不再过滤 `spans.length === 0` 的角色。**所有角色都进矩阵**，无历史的角色显示为空行（单元格全 empty），右侧带"无出场记录"灰色提示
- 同理 conflict/faction 不过滤 `firstChapter == null`，显示为空行 + "未设置跨度"
- foreshadow 不过滤 `firstChapter == null`，显示为空行 + "未埋设"
- location 不过滤 `appearChapters.length === 0`，显示为空行 + "未出场"
- world_element 全程显示（已是默认）

**MatrixView 空行渲染**：
- 实体行的 sticky 左列右侧加灰色小字提示（如"无出场记录，右键标记"）
- 整个矩阵空时（无任何实体）显示居中引导："暂无实体，请从左侧 NovelSidebar 新建"

### 3.2 恢复 demo 视觉细节

#### 3.2.1 图例条（Legend）
新增 `matrix-legend.tsx`，放在 MatrixToolbar 下方一行：
- 紧凑横排：`● 角色出场  ▲▼ 冲突起止  ◆ 地点  ━ 跨度色带  ┄ 待回收伏笔  ▌ 当前章节`
- 用 GROUP_META 颜色 + 符号
- 高度 24px，`bg-surface-1/50 border-b border-border`
- 可折叠（点击右侧"图例"文字收起），状态存 localStorage

#### 3.2.2 当前章节 badge
MatrixToolbar 右侧增加胶囊：
- `CH.{playheadChapter} {chapterTitle}`
- 琥珀色 `bg-amber-500/10 border-amber-500/30 text-amber-500`
- 左侧小圆点 + glow

#### 3.2.3 Hover tooltip
替换原生 `title` 为自定义 tooltip：
- 新增 `matrix-tooltip.tsx`（或复用 shadcn Tooltip）
- 触发：hover 单元格 ≥ 200ms
- 内容：章节号 + 标题 + 实体名 + 状态（出场/起始/埋设等）
- 定位：单元格上方，自动避让视口
- 样式：`bg-popover text-popover-foreground border rounded-md shadow-lg px-2.5 py-1.5 text-xs`

> **简化版**：若 shadcn Tooltip 可用，直接用 `<Tooltip><TooltipTrigger asChild><Cell/></TooltipTrigger><TooltipContent>{tip}</TooltipContent></Tooltip>`，不必自造。

#### 3.2.4 行 hover 微反馈
- 行 hover：`hover:bg-white/[0.018]`（极淡，不抢内容）
- 单元格 hover（有符号时）：符号 `scale(1.35)` + `drop-shadow(0 0 5px currentColor)`
- 修复 `group/cell` 命名：把 `className="group/cell"` 放到 Cell 根 div，`group-hover/cell:scale-[1.35]` 放到 Symbol

### 3.3 完善交互

#### 3.3.1 双击编辑跨度
冲突/势力行双击色带 → 弹窗修改 `firstChapter`/`lastChapter`：
- 新增 `entity-span-dialog.tsx`
- 输入：起始章、结束章（数字 Input + 章节下拉）
- 调 `updateConflict` / `updateFaction`

#### 3.3.2 右键菜单扩展
`entity-cell-menu.tsx` 扩展：
- 角色/地点：标记出场 / 删除出场 / 修改批注（弹窗输入 note）
- 冲突/势力：修改跨度（弹窗）/ 修改批注
- 伏笔：修改埋设章 / 修改回收章 / 修改批注
- 世界要素：修改常驻范围 / 修改批注

#### 3.3.3 ~~键盘导航~~（已移除）

#### 3.3.4 单元格 hover 缩放修复
当前 `group-hover/cell:scale-[1.35]` 不生效，因为 `group/cell` class 在 Cell 根 div，但 hover 触发也在 Cell 根 div，命名空间未正确建立。修复：
```tsx
<div className="group/cell h-full ..." onMouseEnter={...}>
  <Symbol symbol={symbol} color={color} />
</div>
// Symbol 内：
<span className="... group-hover/cell:scale-[1.35] ..." />
```
确认 Tailwind config 支持 `group/{name}` 语法（v3.2+）。

### 3.4 NovelSidebar ↔ MatrixView 联动

#### 3.4.1 共享状态到 store
**novel-store.ts 新增字段**：
```ts
// 矩阵视图状态（与 NovelSidebar 共享）
collapsedGroups: Set<MatrixEntityKind>      // 折叠的分组
activeFilter: MatrixEntityKind | null        // 过滤（null=全部）
toggleCollapsedGroup: (kind: MatrixEntityKind) => void
setActiveFilter: (filter: MatrixEntityKind | null) => void
```
- 不持久化（`partialize` 排除），每次进项目重置
- NovelSidebar 的 `CollapsibleGroup` 改为读 store `collapsedGroups`，调 `toggleCollapsedGroup`
- MatrixView 同样读 store

#### 3.4.2 选中高亮双向同步
已有 `selectedNodeId` + `selectedNodeType`。补：
- NovelSidebar `EntityItem` 高亮：`selectedNodeId === c.id` 时 `bg-primary/10`
- MatrixView `EntityRow` 高亮：已有
- 章节：`ChapterItem` 高亮：`selectedNodeId === chapter.id` 时 `bg-primary/10`

#### 3.4.3 过滤联动
NovelSidebar 的"集合"对应 MatrixView 的"分组"：
- 点 NovelSidebar 角色 chip → MatrixView `setActiveFilter('character')` + 滚动到角色分组
- 点 MatrixView 过滤 chip → NovelSidebar 滚动到对应分组（折叠其他）
- NovelSidebar 顶部加一行过滤 chips（与 MatrixToolbar 同步），或 NovelSidebar 的 CollapsibleGroup 标题加"仅看此组"按钮

> **简化方案**：过滤只放 MatrixToolbar，NovelSidebar 不加 chips。但 NovelSidebar 的 CollapsibleGroup 折叠状态与 MatrixView 同步即可。这样 NovelSidebar 始终显示全量列表，MatrixView 负责过滤聚焦。

#### 3.4.4 章节反查
NovelSidebar `ChapterItem` 展开时显示"出场角色/伏笔/冲突"，与 MatrixView 的章节列对应：
- 点 NovelSidebar 章节 → MatrixView `setPlayheadChapter` + 滚动到该列
- 点 MatrixView 标尺 → NovelSidebar 滚动到对应章节项（若展开）

**简化**：只做 NovelSidebar → MatrixView 方向（点章节项滚动矩阵到该列）。MatrixView → NovelSidebar 滚动复杂度高，暂不做。

## 四、文件变更清单

### 修改文件

| 文件 | 变更 |
|------|------|
| `matrix/matrix-logic.ts` | `buildGroups` 不再过滤空实体；新增 `buildEmptyHint` |
| `matrix/matrix-view.tsx` | 空行提示、hover 缩放修复、tooltip 接入 |
| `matrix/matrix-toolbar.tsx` | 当前章节 badge |
| `matrix/matrix-workspace.tsx` | 键盘导航、双击编辑、右键菜单扩展接入 |
| `matrix/entity-cell-menu.tsx` | 扩展菜单项（修改跨度/批注） |
| `novel-store.ts` | 新增 `collapsedGroups` / `activeFilter` / `toggleCollapsedGroup` / `setActiveFilter` |
| `novel-sidebar.tsx` | `CollapsibleGroup` 读 store；选中高亮；章节点击联动 playhead |

### 新建文件

| 文件 | 用途 |
|------|------|
| `matrix/matrix-legend.tsx` | 图例条 |
| `matrix/matrix-tooltip.tsx` | hover tooltip（或复用 shadcn Tooltip） |
| `matrix/entity-span-dialog.tsx` | 跨度编辑弹窗 |
| `matrix/entity-note-dialog.tsx` | 批注编辑弹窗 |

### 删除文件
无。

## 五、实现任务分解

### C-1：数据兜底（matrix-logic + MatrixView 空行）
- `buildGroups` 移除 `if (spans.length === 0) continue` 等过滤
- MatrixView EntityRow 渲染：空实体时 sticky 列右侧加"无出场记录"灰色提示
- 矩阵全空时显示居中引导
- 更新 matrix-logic.test.ts（空实体也进分组）

### C-2：恢复 demo 视觉（legend + badge + tooltip + hover）
- 新建 `matrix-legend.tsx`
- MatrixToolbar 加当前章节 badge
- Cell 接入 shadcn Tooltip
- 修复 `group/cell` hover 缩放

### C-3：NovelSidebar ↔ MatrixView 联动
- novel-store 加 `collapsedGroups` / `activeFilter` + actions
- NovelSidebar `CollapsibleGroup` 改读 store
- NovelSidebar `EntityItem` / `ChapterItem` 加选中高亮
- NovelSidebar 章节点击 → `setPlayheadChapter`

### C-4：完善交互（双击编辑 + 右键扩展 + 键盘）
- 新建 `entity-span-dialog.tsx` / `entity-note-dialog.tsx`
- `entity-cell-menu.tsx` 扩展菜单
- MatrixView 双击色带 → 弹窗
- MatrixWorkspace 键盘导航

### C-5：验证
- tsc
- matrix-logic.test.ts
- 手动验证联动

## 六、约束

- 不修改后端 API
- 不修改画布视图
- 不引入新依赖（shadcn Tooltip 已有则用，否则自造轻量 tooltip）
- 所有 Tailwind class，不用硬编码 CSS
- 保留已有右键菜单功能，只扩展

## 七、符号系统（确认）

| 实体 | 符号 | 说明 |
|------|------|------|
| 角色出场 | ★ | 蓝色，主角加 glow |
| 冲突起始 | ▲ | 红色，跨度起点 |
| 冲突结束 | ▼ | 红色，跨度终点 |
| 冲突中段 | ─ | 红色色带 |
| 伏笔埋设 | ● | 琥珀色，埋设点 |
| 伏笔回收 | ○ | 琥珀色，回收点 |
| 伏笔跨度 | ┄ | 虚线连线（埋设→回收） |
| 地点出场 | ◆ | 青色 |
| 势力跨度 | ▲▼◆ | 紫色色带 |
| 世界要素 | ▌ | 靛色常驻带 |

**伏笔连线**（小说特有）：埋设 ● 到回收 ○ 之间画虚线 `┄┄┄`，未回收的伏笔连线末端淡出（无 ○）。这是矩阵视图区别于视频时间轴的核心价值。

## 八、验证清单

- [ ] 空项目矩阵显示引导
- [ ] 无历史的角色显示空行 + "无出场记录"
- [ ] 图例条显示
- [ ] 当前章节 badge 显示章节号+标题
- [ ] hover 单元格显示 tooltip
- [ ] hover 单元格符号缩放
- [ ] NovelSidebar 折叠 ↔ MatrixView 折叠同步
- [ ] NovelSidebar 选中 ↔ MatrixView 选中高亮
- [ ] 点 NovelSidebar 章节 → MatrixView 滚动到该列
- [ ] 双击冲突色带 → 弹窗修改跨度
- [ ] 右键单元格 → 完整菜单
- [ ] tsc 无新增错误
- [ ] matrix-logic 测试通过

## 九、方案自检与修正

审查上述方案，发现以下问题需修正：

### 修正 1：数据兜底策略——不塞空行，改用空状态引导
**问题**：3.1 "buildGroups 不再过滤空实体" 会导致矩阵塞满空行。项目有 50 个角色但都无出场记录时，矩阵会出现 50 个空行，体验更差。
**修正**：保留 `buildGroups` 的过滤逻辑。改为：
- 分组标题显示**总数**（含未放置），如"角色（12 / 5 已放置）"
- 矩阵只显示已放置的实体行
- 矩阵全空时（无任何已放置实体）显示居中引导："暂无实体出场记录，请点击「开始创作」让 AI 生成，或从左侧 NovelSidebar 新建实体后右键标记出场"

### 修正 2：tooltip 用 CSS 伪元素，不用 shadcn Tooltip
**问题**：3.2.3 shadcn Tooltip 包裹每个 Cell 会创建大量 TooltipProvider/Root 实例（几百个单元格），性能差。
**修正**：用 CSS 伪元素 `data-tip` 属性（demo 方式）：
- Cell 加 `data-tip={tip}` 属性
- 全局 CSS（Tailwind 任意值或一次性 style 标签）：`[data-tip]:hover::after { content: attr(data-tip); ... }`
- 零 JS、零额外组件、性能无影响
- 文本够用，不需要 React 节点

### 修正 3：activeFilter 不进 store，collapsedGroups 进 store
**问题**：3.4.1 把 activeFilter 也放 store，但 NovelSidebar 不需要读 activeFilter（它始终显示全量列表）。
**修正**：
- `collapsedGroups` 进 store（用 `MatrixEntityKind[]` 数组存，可序列化；partialize 包含；组件内用 `new Set(arr)` 转 Set）
- `activeFilter` 留在 MatrixWorkspace useState（本地状态）
- NovelSidebar 联动过滤：点 CollapsibleGroup 标题 → 调 `setActiveFilter(kind)`（通过 callback prop 传给 NovelSidebar）
- MatrixToolbar 点 chip → 同样调 setActiveFilter

### 修正 4：双击编辑——色带需 pointer-events: auto
**问题**：3.3.1 双击色带编辑跨度，但当前 EntityOverlay 是 `pointer-events-none`，无法接收双击事件。
**修正**：
- 冲突/势力色带改为 `pointer-events: auto` + `cursor: pointer` + `onDoubleClick` 触发弹窗
- 伏笔连线/世界要素常驻带保持 `pointer-events-none`（不接收双击，避免误触）
- 色带 hover 时给行加微高亮（`hover:bg-{color}/5`）

### 修正 5：~~键盘导航用全局监听~~（已移除，不做键盘导航）

### 修正 6：章节滚动通过 store 信号
**问题**：审查提到"点 NovelSidebar 章节滚动矩阵"，但 MatrixView 的 scroll-x 容器在 MatrixWorkspace 内，NovelSidebar 无法直接操作 ref。
**修正**：
- store 加 `matrixScrollTarget: { chapter: number; ts: number } | null`（ts 用于触发 effect 即使 chapter 相同）
- NovelSidebar 点章节 → `setMatrixScrollTarget({ chapter, ts: Date.now() })`
- MatrixView useEffect 监听 `matrixScrollTarget`，`scrollLeft = (chapter-1) * cellWidth`
- 同样用于"点 NovelSidebar 实体 → 矩阵滚动到该实体行"（需额外存 `entityId`）

### 修正 7：图例条简化——默认显示，不可折叠
**问题**：3.2.1 图例可折叠存 localStorage 增加复杂度。
**修正**：图例条默认显示，不可折叠。高度 24px，紧凑横排。如果未来觉得占地方再加折叠。

### 修正 8：NovelSidebar 联动细化
**修正**：NovelSidebar 与 MatrixView 的联动分三类：
1. **折叠同步**：NovelSidebar CollapsibleGroup 标题点击 → toggleCollapsedGroup(kind)（store）→ MatrixView 同步折叠
2. **过滤联动**：NovelSidebar CollapsibleGroup 标题**双击** → setActiveFilter(kind)（callback prop）→ MatrixView 只显示该组。单击仍为折叠。避免单击语义冲突。
3. **选中同步**：已有 selectedNodeId，补 NovelSidebar EntityItem/ChapterItem 高亮
4. **章节滚动**：NovelSidebar ChapterItem 点击 → selectNode + setMatrixScrollTarget → MatrixView 滚动到该列

### 修正 9：batchCreateCharacterHistory 不适合标记出场
**问题**：审查 matrix-workspace 的 handleMarkPresent 用 `batchCreateCharacterHistory`，但该接口语义是"补全起始章节"，且 fieldName 必填（currentState/currentGoal/...），无 'appearance'。用它标记出场是误用。
**修正**：
- 角色出场标记：**不调 characterHistory API**。改为修改 `character.appearChapters`（但 NovelCharacter 无此字段）。
- 实际方案：**角色出场标记功能移除**（数据由 AI 创作流程写入 characterHistory，手动标记语义不清）。
- 只保留**地点出场标记**（location.appearChapters 字段存在，updateLocation 可改）。
- 角色/冲突/伏笔/势力/世界要素的"添加"改为：右键分组空白 → 新建实体（已有 EntityCreateDialog）；新建后实体进矩阵但无出场数据，由创作流程填充。

## 十、最终任务清单（修正后）

### C-1：空状态引导（不改 buildGroups 过滤）
- MatrixView：groups 全空时显示居中引导
- MatrixToolbar：分组计数显示"已放置/总数"

### C-2：demo 视觉恢复
- 新建 `matrix-legend.tsx`（不可折叠）
- MatrixToolbar 当前章节 badge
- Cell 用 `data-tip` 属性 + 全局 CSS 伪元素 tooltip
- 修复 `group/cell` hover 缩放

### C-3：NovelSidebar ↔ MatrixView 联动
- novel-store 加 `collapsedGroups: MatrixEntityKind[]` + `matrixScrollTarget` + actions
- NovelSidebar CollapsibleGroup 改读 store
- NovelSidebar EntityItem/ChapterItem 加选中高亮
- NovelSidebar 章节点击 → setMatrixScrollTarget
- MatrixView useEffect 滚动

### C-4：交互完善
- 角色出场标记移除（修正 9）
- 地点出场标记保留
- 冲突/势力色带双击编辑跨度（pointer-events: auto）
- 右键菜单：角色/冲突/伏笔/势力/世界要素 → 只保留"修改批注"（跨度通过双击编辑）

### C-5：验证
- tsc + matrix-logic.test.ts
- 手动验证联动

