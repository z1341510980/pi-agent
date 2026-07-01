# 小说工作台：工作流主线重设计

> 在现有矩阵视图（章节×实体）基础上，建立「大纲→卷纲→章纲→生成」的创作主线，串联左栏、矩阵、画布三栏，补齐两种生成模式，让用户拿到项目即知如何开始。

## 一、背景与问题诊断

### 1.1 现状能力（已有）

- **数据层**：项目/章节/角色/角色历史/关系/冲突/伏笔/线索/势力/地点/世界观要素/世界规则/风格指南/创作约束/信息差/作者意图/章节验收/记忆事件/画布边/标记/节点位置
- **后端**：多 Agent 编排（Director→Writer→Reviewer→Reviser→Memory，SSE 流式 + 2 检查点）；实体生成器（从核心风格描述生成实体字段）
- **前端**：左栏实体库 + 章节列表；主区矩阵/画布可切换 + 章节正文编辑器；右栏详情/创作实时预览

### 1.2 核心问题

1. **三栏割裂**：侧边栏（实体库视图）、矩阵（章节×实体分布视图）、画布（关系图视图）是同一批数据的三种视图，但缺少一条「创作主线」串联，用户不知道先做什么、再做什么。
2. **生成入口单一且无法输入剧情**：`novel-workspace.tsx` 把 `narrativeTask` 硬编码为「推进主线剧情」，用户无法在启动时给出剧情，只能在检查点期间 `sendMessage` 补救。用户期望的两种模式（手动编排后生成 / 输入剧情自动生成所有元素）均不存在。
3. **大纲/卷纲/章纲完全缺失**：数据模型中 `volume` 仅是整数标记（无 `novel_volumes` 表、无卷标题/卷纲），`narrative_task` 是最接近「章纲」的字段但被硬编码浪费，没有「大纲」概念。

### 1.3 根因

缺少一条从「大纲→编排→生成」的主线。三个问题同源。

## 二、已确认的设计决策

经澄清对话，确认以下三项设计决策：

1. **矩阵为中心工作区**：侧边栏=实体库、画布=关系图、矩阵=主舞台。大纲骨架不占主区顶部，而是并入左栏与章节列表合并为「大纲树」。
2. **单章粒度生成**：复用现有 `create-flow`，不新建弧线规划器。跨章的「弧线」由大纲/卷纲/章纲层体现，生成层只做单章填充。
3. **章纲是统一起点**：`narrative_task` 升级为正式章纲。模式1=手写章纲+手动在矩阵编排实体→生成正文；模式2=写好章纲→AI 据此生成实体并编排到矩阵+生成正文。

## 三、整体架构与布局

### 3.1 布局

```
┌──────────────────────────────────────────────────────────────┐
│ header  项目名 · 第3章 | [开始创作 ▼] | 缓存/日志/导出          │
├─────────────┬──────────────────────────────────┬─────────────┤
│ 左栏 大纲树   │ 主区                              │ 右栏         │
│ 全书大纲[编] │ ┌──────────────────────────────┐ │             │
│ ▼第1卷《起》 │ │ 章节正文编辑器 (上)            │ │ 详情/创作预览│
│   卷纲[编辑] │ │  第3章 (playhead)             │ │             │
│   第1章      │ ├──────────────────────────────┤ │             │
│   第2章      │ │ 矩阵 (下) ← 主舞台             │ │             │
│  ▶第3章←当前 │ │  当前列高亮                   │ │             │
│    章纲[编辑]│ │                              │ │             │
│   [手动编排] │ │                              │ │             │
│   [AI编排]   │ │                              │ │             │
│ ──实体库──   │ └──────────────────────────────┘ │             │
│  角色/冲突.. │                                  │             │
│  伏笔/势力   │                                  │             │
│  地点/世界观 │                                  │             │
└─────────────┴──────────────────────────────────┴─────────────┘
```

- **左栏**：上部「大纲树」（全书大纲 > 卷 > 章，纲要可编辑，与原章节列表合并）；下部「实体库」（角色/冲突/伏笔/势力/地点/世界观 6 个 CollapsibleGroup，保持现有）
- **主区**：上部章节正文编辑器（Tiptap，跟随 playhead）；下部矩阵（章节×实体，主舞台）。矩阵/画布切换条保留
- **右栏**：静态看实体详情；创作时看阶段/进度/检查点/流式内容
- **header**：「开始创作」下拉选模式 + 现有工具

### 3.2 使用流程主线

拿到一个新项目后，顺序为：

1. **写全书大纲**（大纲树顶部，一段文本）
2. **建卷 + 写卷纲**（大纲树卷节点，卷标题 + 卷纲可编辑）
3. **建章 + 写章纲** ← 统一起点（大纲树章节点，章纲可编辑）
4. **选生成模式**（章节点上两个按钮 / header 下拉）：
   - **模式1 手动编排后生成**：在矩阵本章列手动标记出场角色/冲突起止/伏笔埋设 → 点「手动编排」→ 生成正文
   - **模式2 AI 编排生成**：点「AI编排」→ AI 读章纲 → 生成所需实体并自动编排到矩阵本章列 → 继续生成正文
5. **验收/保存/发布**（右栏创作预览，走现有检查点流程）

### 3.3 三视图分工

三栏是同一批数据的三个正交维度，各司其职，互不重叠：

| 视图 | 维度 | 职责 | 不可替代的能力 |
|------|------|------|--------------|
| 左栏（大纲树+实体库） | 组织维度 | 按类型分组管理实体，按卷/章组织大纲 | 实体 CRUD、大纲编辑 |
| 矩阵 | 时间维度 | 章节×实体分布，谁在哪章、跨度多久 | 角色出场★、冲突跨章▲▼、伏笔埋收●┄○ |
| 画布 | 关系维度 | 实体间关系网络 | 角色关系边、势力敌对、伏笔触发链、冲突阵营 |

矩阵做不到的关系可视化由画布承担；画布不再显示章节/项目节点，聚焦实体关系。

## 四、三栏联动机制

复用现有 [novel-store.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/stores/novel-store.ts) 的 `selectedNodeId` / `playheadChapter` / `collapsedGroups` / `matrixScrollTarget`，新增 2 个字段：

| 新增 store 字段 | 作用 | 持久化 |
|----------------|------|--------|
| `creationMode: 'manual' \| 'ai-arrange' \| null` | 区分两种生成模式，驱动 header 下拉 + 章项按钮态 | 否 |
| `expandedVolumes: string[]` | 大纲树按卷展开状态 | 是 |

联动落地：

| 操作 | 链路 | 现状 |
|------|------|------|
| 点左栏章项 | `setPlayheadChapter` + `setMatrixScrollTarget` + `selectNode` → 矩阵滚动高亮列 + 正文加载 + 章项高亮 | 已有，**补：大纲树章项高亮跟随 selectedNodeId** |
| 点左栏实体 | `selectNode` → 矩阵高亮行 + 画布高亮节点 + 右栏详情 | 已有 |
| 点矩阵单元格 | `selectNode` + 若是章列 `setPlayheadChapter` → 左栏大纲树/实体库对应项高亮 + 画布高亮该实体节点 | **补：矩阵单元格点击联动左栏+画布** |
| 点画布节点 | `selectNode` → 矩阵高亮该实体行 + 左栏选中 + 画布高亮该节点与直连邻居 | **补：画布节点点击联动** |
| 编辑章纲 | 大纲树编辑 → `upsertChapter` → 矩阵/正文不受影响（章纲是生成依据，非显示内容） | 新增 |
| 切换 矩阵/画布 | 同一数据两视图，选中状态保持 | 已有 |

## 五、数据层改动

### 5.1 字段与表

| 改动 | 位置 | 说明 |
|------|------|------|
| 新增 `outline` 字段 | `novel_projects` | 全书大纲（一段文本） |
| 新建 `novel_volumes` 表 | migration 027 | `id / project_id / volume_number / title / outline / sort_order / created_at / updated_at`，卷纲有归宿 |
| `novel_chapters` 加 `outline` + `volume_id` | migration 028 | `outline`=章纲（用户写）；`volume_id` 指向卷；保留 `volume` 整数做兼容 |
| 保留 `narrative_task` | — | `outline`=用户写的章纲（统一起点），`narrative_task`=Director 从章纲细化的执行任务。两者分工，不合并 |

### 5.2 API 路由（新增/扩展）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/novel/projects/:projectId/volumes` | 列出卷 |
| POST | `/api/novel/projects/:projectId/volumes` | 创建卷 |
| PATCH | `/api/novel/volumes/:id` | 更新卷（title/outline/sort_order），schema 用 `.optional()` 不带 `.default()` |
| DELETE | `/api/novel/volumes/:id` | 删除卷（章节的 volume_id 置空，不级联删章） |
| PATCH | `/api/novel/chapters/:id` | 扩展支持 `outline` / `volume_id` 字段更新，schema 用 `.optional()` 不带 `.default()` |
| PATCH | `/api/novel/projects/:id` | 扩展支持 `outline` 字段更新 |
| POST | `/api/novel/projects/:projectId/chapters/:chapterNumber/ai-arrange` | **新增**：模式2 入口，SSE 流式 |

> 遵循项目约束：PATCH schema 用 `.optional()` 不带 `.default()`，避免覆盖未传字段；实时更新用 SSE 不轮询。

## 六、两种生成模式实现

### 6.1 模式1 · 手动编排后生成（改造现有 create-flow）

```
用户在矩阵第3章列手动标记: 角色★/冲突▲▼/伏笔●
  ↓ 点「手动编排」
create-flow 读取本章已编排实体清单
  (characterHistory / conflict.firstChapter / foreshadow.firstChapter)
  ↓ 作为强约束注入 Director + Writer 提示词 (SEMI 层章节上下文)
Director 据 章纲 + 已编排实体 → 生成 narrative_task
  ↓ 检查点1
Writer 据 narrative_task + 实体约束 → 生成正文
  ↓ 检查点2 → Memory
```

改动点：
- `/create-flow` 接受可选 `arrangedEntities` 参数（角色 id 列表 / 冲突 id 列表 / 伏笔 id 列表）
- `novel-orchestrator.ts` 把 `arrangedEntities` 注入 SEMI 层章节上下文，作为 Writer 必须遵守的约束
- Director 仍从 `outline`（章纲）生成 `narrative_task`，但参考已编排实体

### 6.2 模式2 · AI 编排生成（新增端点）

```
用户点「AI编排」(章纲已写, 前端校验非空)
  ↓
POST /chapters/:chapterNumber/ai-arrange  (SSE)
  ↓ 读章纲 (chapter.outline)
NovelEntityGenerator 扩展: 输入=章纲, 输出=实体字段 + 出场标记
  ↓ 生成实体落库 + 自动编排到本章列
  (角色写 characterHistory[chapterNumber=本章],
   冲突设 firstChapter=本章,
   伏笔设 firstChapter=本章)
  ↓ 编排完成, 同一 SSE 流内继续调 orchestrator.createChapterWithFlow
  (带 arrangedEntities=刚编排的实体, 走 Director→Writer→Reviewer→Memory)
  ↓ 检查点1/2 → Memory
```

改动点：
- 新增 `/ai-arrange` SSE 路由（遵循 SSE 不轮询约束，流式推送编排进度 + 正文生成进度）
- 扩展 `NovelEntityGenerator`：新增 `generateAndArrange(projectId, chapterNumber, outline)` 方法，按章纲批量生成角色/冲突/伏笔等并自动标记到本章
- 编排完成后，**在同一 SSE 流内**调用 `orchestrator.createChapterWithFlow`（带 `arrangedEntities`=刚编排的实体），走 Director→Writer→Reviewer→Memory；不发起二次 HTTP 请求

### 6.3 前置校验

- 模式2：章纲（`chapter.outline`）为空时，前端禁用「AI编排」按钮并提示「请先写章纲」
- 模式1：不强制章纲，但建议有（Writer 会参考；无章纲时退化为现有行为）
- 两种模式都复用现有检查点 + Memory 流程，不重写编排引擎

## 七、画布关系图改造

现状画布与矩阵价值重叠（同批实体自由布局）。改造为「实体关系图」，承担关系维度（矩阵承担时间维度，二者正交）。

### 7.1 节点收敛
- 节点只保留实体类型：角色/势力/伏笔/冲突/地点/世界观要素
- 移除章节节点、项目节点（章节归左栏大纲树，项目归 header；画布不再混入）

### 7.2 关系边带类型
- `novel_edges` 表扩展 `edge_type TEXT NOT NULL DEFAULT ''` + `label TEXT NOT NULL DEFAULT ''`（migration 030）
- 支持类型：师徒/亲属/敌对/同盟/隶属/触发/因果 等（前端枚举，可扩展）
- 现有手动连线（`auto=false`）保留；未来可由 AI 从角色关系/伏笔链自动生成（`auto=true`）

### 7.3 工具栏改造
- 移除「添加章节/角色/冲突/伏笔」按钮（实体创建归左栏实体库）
- 新增「关系类型」选择器：画边前选类型，决定边的 label 与样式
- 保留缩放/适应视图/重新排列/删除

### 7.4 过滤与高亮
- 顶部过滤条：按关系类型筛选（如只看「敌对」、只看「师徒」）
- 点节点 → 高亮该节点 + 直连邻居，其余节点变淡

### 7.5 与矩阵/左栏联动
- 点矩阵/左栏实体 → 画布高亮该节点 + 邻居
- 点画布节点 → 矩阵高亮该实体行 + 左栏选中
- 切换 矩阵/画布，选中状态保持

## 八、左栏大纲树组件

新增 `OutlineTree` 组件（左栏上部），替换 [novel-sidebar.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx) 中 `ProjectTree` 的「章节集合」部分：

- **全书大纲**：一行可编辑文本（点击进入编辑，blur 保存 `updateProject({ outline })`）
- **卷节点**：卷标题 + 卷纲（展开可编辑），可新建/删除卷；折叠/展开状态读 `expandedVolumes`
- **章节点**：章号 + 标题 + 章纲（展开可编辑）；当前 playhead 章高亮；显示「手动编排」「AI编排」两个按钮
- **实体库**：保持现有 6 个 CollapsibleGroup（角色/冲突/伏笔/势力/地点/世界观），在大纲树下方

组件交互：
- 点章节点 → `selectNode(chapter.id, 'chapter')` + `setPlayheadChapter` + `setMatrixScrollTarget`
- 章纲编辑 → 防抖 1.5s → `updateChapter({ outline })` → `upsertChapter`
- 「手动编排」/「AI编排」按钮 → 设置 `creationMode` + 触发生成流程

## 九、数据库迁移

| migration | 内容 |
|-----------|------|
| 027 | 新建 `novel_volumes` 表（id/project_id/volume_number/title/outline/sort_order/created_at/updated_at，索引 project_id）；`novel_projects` 加 `outline TEXT NOT NULL DEFAULT ''` |
| 028 | `novel_chapters` 加 `outline TEXT NOT NULL DEFAULT ''` + `volume_id TEXT`（不加外键约束，兼容旧数据） |
| 029 | **数据回填**：对每个 project 的 `distinct chapter.volume`（整数）自动建 `novel_volumes` 记录（title=`第N卷`，outline=''），回填对应 `chapter.volume_id` |
| 030 | `novel_edges` 加 `edge_type TEXT NOT NULL DEFAULT ''` + `label TEXT NOT NULL DEFAULT ''`（画布关系边类型） |

> SQLite binding 仅用 number/string/bigint/buffer/null，时间戳用 `unixepoch()` 秒级，布尔用 INTEGER 0/1——遵循项目约束。

## 十、任务切片

详细实现计划交由后续 writing-plans 生成。此处给出高层切片：

| 切片 | 内容 | 依赖 |
|------|------|------|
| **D-1 数据层** | migration 027/028/029 + 后端 store CRUD (volume) + API 路由 (volume CRUD, chapter 加 outline/volume_id, project 加 outline) + 前端 novel-client 类型 | 无 |
| **D-2 左栏大纲树** | 新增 `OutlineTree` 组件（全书大纲/卷/章纲要可编辑），替换 ProjectTree 的「章节集合」；实体库 6 集合保留 | D-1 |
| **D-3 模式1 手动编排生成** | `/create-flow` 接受 `arrangedEntities` 参数 + orchestrator 注入 SEMI 层 + header 下拉/章项按钮 | D-1 |
| **D-4 模式2 AI编排生成** | 新增 `/ai-arrange` SSE 端点 + 扩展 `NovelEntityGenerator`（按章纲批量生成+自动编排）+ 衔接 create-flow | D-1 |
| **D-5 联动收尾** | store 补 `creationMode`/`expandedVolumes` + 大纲树高亮 + 矩阵单元格点击联动左栏 + header「开始创作」下拉 | D-2 |
| **D-6 画布关系图改造** | 节点收敛为实体（移除章节/项目节点）+ `edge_type` 边类型 + 工具栏改造（关系类型选择器）+ 过滤高亮 + 与矩阵/左栏联动 | D-1 |
| **D-7 验证** | tsc + 后端迁移/路由测试 + 前端组件测试（含画布）+ 手动联动验证 | D-2~D-6 |

## 十一、测试与约束

### 11.1 测试

- **后端**：migration 029 回填正确性；migration 030 edge_type；`/ai-arrange` SSE 端点；`/create-flow` 带 `arrangedEntities` 注入；volume CRUD
- **前端**：OutlineTree 渲染/编辑/折叠；画布关系图节点收敛与边类型；store 联动（playhead/selectedNode/creationMode）
- **matrix-logic**：不受影响（矩阵符号/分组逻辑不变），现有测试应继续通过

### 11.2 约束

- 不破坏现有 matrix-logic（矩阵符号/分组逻辑不变）
- 画布改造为关系图：节点收敛为实体，移除章节/项目节点；边带 `edge_type`
- 保留现有检查点 + Memory 流程
- 实时更新用 SSE 不轮询；PATCH schema 用 `.optional()` 不带 `.default()`；SQLite binding 仅用 number/string/bigint/buffer/null
- 模式2 前置校验：章纲为空时前端禁用「AI编排」并提示

## 十二、与现有架构的映射

| 现有模块 | 本设计的影响 |
|---------|-------------|
| [novel-orchestrator.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts) | `createChapterWithFlow` 接受 `arrangedEntities`，注入 SEMI 层 |
| [novel-entity-generator.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-entity-generator.ts) | 新增 `generateAndArrange`，按章纲批量生成+编排 |
| [novel-routes.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/novel-routes.ts) | 新增 volume CRUD + `/ai-arrange`；扩展 chapter/project PATCH |
| [novel-migrations.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts) | migration 027/028/029/030 |
| [novel-store.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/stores/novel-store.ts) | 新增 `creationMode` / `expandedVolumes` + actions |
| [novel-sidebar.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx) | ProjectTree 的「章节集合」替换为 OutlineTree |
| [novel-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx) | header「开始创作」改为下拉选模式；移除硬编码 narrativeTask |
| [matrix/](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/matrix/) | 不变，仅补单元格点击联动左栏+画布 |
| [novel-canvas.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx) | 改造为关系图：节点收敛为实体，移除章节/项目节点；边带 `edge_type`；过滤高亮 |
| [novel-toolbar.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-toolbar.tsx) | 画布工具栏改造：移除添加实体按钮，新增关系类型选择器 |
