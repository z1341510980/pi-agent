# 小说模块逻辑梳理与设计评审

> 生成时间：2026-08-05
> 分析范围：`apps/agent-server/src/plugins/novel-plugin/`（后端）+ `apps/desktop/src/renderer/src/`（前端小说相关部分）
> 分析方法：codebase-memory-mcp 知识图谱（8793 节点 / 23661 边，full 索引）+ 源码精读

---

## 0. 模块规模总览

| 维度 | 后端 novel-plugin | 前端（renderer 小说相关） |
| --- | --- | --- |
| 代码量 | ~41,032 行（不含测试） | ~27,010 行（79 个组件）+ hooks ~2,200 行 |
| 文件数 | 80+（core/ 55+、routes/ 8、core/stores/ 16） | 组件 79 + stores 4 + hooks 3 + API client 1 |
| 数据库 | 14 张表（迁移 013-026，`novel-migrations.ts` 1354 行） | 无本地库，数据全量走后端 |
| 最大文件 | `prompt-builder.ts` 3798 行 | `matrix-workspace.tsx` 1571 行 |

模块定位：基于**多 Agent 协作**的长篇小说创作系统，覆盖实体编排（角色/冲突/伏笔/势力/地点/物品等 12 类）、章节生成、状态追踪、长期记忆、画布/矩阵可视化、群聊共创、参考小说分析。

---

## 1. 后端逻辑梳理

### 1.1 插件入口与 setup 流程（`index.ts`）

`createNovelPlugin()` 为标准插件形态，`setup` 7 步：

1. `createNovelServices(context)` 初始化全部服务
2. 装饰 Fastify（注册 5 个 service：novelStore / promptManager / novelPromptBuilder / novelEngine / novelOrchestrator）
3. 注册 4 个 Agent 到 `subagentManager`（director / writer / reviewer / memory），并注入 `systemPromptBuilder`（从 task 文本正则提取 projectId 后构建三层缓存 prompt，失败回退 identity）与 `toolFilter`（声明即权限）
4. 注册 `novel-team` 到 TeamManager（pipeline 策略，maxParallel=1）
5. 注册 17 个 Pi Session 工具
6. 注册 REST/SSE 路由（`/api/plugins/novel` 前缀）
7. 注册前端面板 `novel-canvas`

依赖约束：必须在 `databasePlugin`、`pluginLoaderPlugin` 之后加载。

### 1.2 服务依赖图（`novel-services.ts`）

```
db ──► NovelStore（门面）
    ├─► ReferenceAnalysisStore/Service
    ├─► NovelMemoryStore（事件+快照+因果链）
    ├─► PromptManager（三级覆盖：SQLite 运行时 > 项目文件 > 默认 .md）
    └─► ChapterChatStore / DiscussionRunStore / DiscussionSettingsStore

NovelStore ──► setChapterProjectionObserver(createChapterProjectionRecorder)   // 实体写入 → 事件账本
NovelStore ──► setEntityDeletedObserver(deleteLedgerReferencesByEntity)         // 删除 → 账本引用清理

PromptManager + NovelStore + NovelMemoryStore + RelationshipGraph ──► NovelPromptBuilder
NovelStore ──► NovelEngine
NovelStore + memoryStore + promptBuilder ──► createNovelTools（17 工具）
… ──► NovelMemoryGenerator ──► NovelOrchestrator
… ──► NovelDiscussionRunner / ChapterChatRunner / NovelCharacterGenerator /
        NovelEntityGenerator / NovelSimilarityScanner
```

**关键设计点**：存储层是「门面 + 分领域 store」结构 —— `novel-store.ts`（609 行）为门面，`core/stores/` 下拆出 16 个领域 store（chapter / character / conflict / faction / foreshadow / graph / item / project / scene-plan / world / narrative-ledger / entity-candidate / deduplicate-service 等），每类实体独立 CRUD。

### 1.3 数据模型（`core/types.ts`）

12 类核心实体：项目 / 卷 / 章节 / 角色 / 关系 / 伏笔 / 线索 / 冲突 / 世界规则 / 势力 / 地点 / 世界观要素 + 物品 / 信息差 / 风格指南 / 作者意图 / 章节验收 / 角色历史 / 节点位置 / 画布连线 / 提示词模板 / 时间轴标记 / Agent 日志。

角色为「静态设定（identity/personality/appearance/speechStyle）+ 动态状态（currentState/currentGoal/currentPressure/secret/arcStage）」双轨模型：
- 静态设定只进 SEMI 层 arrangedEntities（仅本章出场角色完整注入）
- 动态状态进 SEMI 层 formatStoryState（所有角色 name + 状态）
- **secret 字段绝不进任何提示词**（信息差由 `novel_information_layers` 单独管理）

### 1.4 提示词三层缓存（`prompt-builder.ts`，3798 行）

| 层级 | 内容 | 缓存粒度 |
| --- | --- | --- |
| STATIC（系统提示词） | 世界规则 + 风格指南 + Agent 身份（共享前缀在前，Agent 专属在后，**不含角色定义**） | 跨章跨 Agent 命中 |
| SEMI（首条用户消息/章节上下文） | 章节信息 + 约束 + arrangedEntities 完整定义 + 故事状态 + 关系 + 信息差 + 最近 3 章摘要 +（仅 Writer）创作指令 | 单章内命中 |
| DYNAMIC（对话消息） | 工具调用结果、生成内容、用户引导 | 不缓存 |

架构动机（文档 11.1）：200+ 角色全塞系统提示词会上下文爆炸；本章出场角色已由 arrangedEntities 编排，精准注入即可，其余角色仅以 name+动态状态存在，需要详情时调 `novel_query_state` 工具（DYNAMIC 层，不破坏前缀缓存）。

### 1.5 工具系统与权限（`novel-tools.ts`，2485 行）

17 个工具按字母序注入（保证 schema 顺序稳定，最大化 prompt cache 命中）。权限矩阵：

| Agent | 允许工具 |
| --- | --- |
| director | 只读 3 个 query 工具 |
| writer | 仅 `novel_query_state` |
| reviewer | 仅 `novel_query_state` |
| memory | 全部 17 个（唯一写权限 Agent） |

写工具只写库、不改提示词前缀 → 前缀缓存命中，状态变更在下一章新 session 中体现。

### 1.6 多 Agent 编排流程（`novel-orchestrator.ts`，2449 行）

```
createChapterWithFlow(projectId, chapterNumber, { arrangedEntities })
  ├─ RhythmController 建议节奏
  ├─ Phase 1: Director 规划叙事任务 ──► 检查点1（approve/reject/revise/rewrite）
  ├─ Phase 2: Writer 创作正文
  ├─ 确定性质量门（PostWriteGuard：退化/字数失控/矩阵角色缺失 + ProseQualityEvaluator）
  ├─ Phase 3a: Reviewer 文字盲审（identity_only，不带世界状态）
  ├─ Phase 3b: 完整 Reviewer 综合评审 ──► 检查点2（approve/revise→Reviser 局部补丁/rewrite→递归重来）
  ├─ Phase 5: Memory 提取状态变更（前后快照差分 → recordMemoryEvents）
  ├─ saveChapterSnapshot（情景记忆全量快照）
  └─ 推送 dataChanged 事件 → 自动保存章节
```

- `arrangedEntities` 经 `this.currentArrangedEntities` 传递给 runAgent → `formatArrangedEntities` 逐 ID 查询后拼入 SEMI 层；`finally` 清理，防泄漏
- 运行态经 AsyncLocalStorage 隔离，并发章节不串数据
- runAgent：writer 超时 300s、其他 120s；15s 心跳防前端假死；`finally` fire-and-forget 写 `novel_agent_logs`

### 1.7 长期记忆与事件账本

- **NovelMemoryStore**：事件（recordEvent）+ 快照 + 因果链（effectIds）
- **事件账本**（story_event_entities / memory_events）：实体写入经 **Store 门面观察者**收口到账本（`createChapterProjectionRecorder`），覆盖手工编辑 / Memory Agent 工具 / 矩阵拖拽等所有旁路写入路径；删除实体时经 `setEntityDeletedObserver` 清理多态引用
- 启动时 `backfillMissingDimensions()` 幂等回填历史事件

### 1.8 路由组织（`novel-routes.ts` + `routes/` 子目录）

- `novel-routes.ts`（1944 行）：**聚合器 + 内联大量路由**（项目管理/章节/实体 CRUD 等直接内联），认知复杂度 119
- `routes/` 子目录（8 个文件）：story-ledger / reference-analysis / context-preview / creation-flow（SSE 核心）/ chapter / character / entity-candidate / arranged-entities-contract
- SSE 端点（ag-ui 协议）：`create-flow`、`ai-arrange`、`reverse-arrange`、`create-discussion`，检查点经独立 `POST /checkpoint/:type/decision` 端点 + EventEmitter 传递
- 并行路径：`create-team`（TeamManager pipeline，与 SSE 流程并存）

### 1.9 数据库迁移

`novel-migrations.ts`（1354 行）静态声明表 013-026 共 14 张表，setup 前执行。

---

## 2. 前端逻辑梳理

### 2.1 组件树与布局模式

```
App（左侧 rail 导航：首页/对话/小说/设置）
└─ NovelWorkspace（1498 行）
   ├─ NovelSidebar（项目树/大纲树/实体列表）
   ├─ NovelToolbar
   ├─ 中央区（4 种互斥布局模式）：
   │    text          → ChapterContentEditor（Tiptap）
   │    text-timeline → 编辑器 + 时间线分屏
   │    timeline      → MatrixWorkspace（章节×实体矩阵，20+ 文件）
   │    graph         → NovelCanvas（ReactFlow 画布，9 种节点）
   ├─ 右侧面板（3 Tab）：
   │    conversation → NovelConversationPanel（创作流/群聊/章节聊天）
   │    detail       → NovelDetailPanel（实体详情 + detail-forms 表单）
   │    audit        → ConsistencyAuditPanel（一致性审计）
   └─ 浮动面板：CacheMonitor / AgentLog / SimilarityScan / ReferenceAnalysis / ChapterVersion
```

布局模式从旧 `mainMode × viewMode` 双维度合并为单一 `layoutMode`（v3 迁移，含 2 种自相矛盾组合的修复注释）。

### 2.2 状态管理（3 个 zustand store）

| Store | 职责 | 关键设计 |
| --- | --- | --- |
| `novel-data-store` | 19 个实体列表 + 当前项目 | persist(localStorage) + **zundo temporal undo/redo**；指纹相等性判定（避免全量 JSON 序列化）；章节正文**不持久化**（防 QuotaExceeded）；后端为权威数据源（mergeListById 直接采用 remote） |
| `novel-ui-store` | 选中/画布模式/矩阵多选/播放头 | persist 仅 5 个字段；版本迁移删废弃 key |
| `novel-workspace-layout-store` | 布局模式/面板尺寸 | persist v3 迁移，clamp 尺寸，删零消费字段 |

**Undo/Redo**：全局快捷键（App 级 useShortcut）绑定 data store 的 temporal，50 步上限；切项目时手动 clear 历史栈（避免 undo 恢复已删项目）。

### 2.3 API 客户端（`api/novel-client.ts`，1949 行）

- 所有端点封装为函数，BASE = `/api/plugins/novel`
- 类型**全部来自 `@repo/shared/novel` 共享包**（前后端共用同一份定义），re-export 供组件层引用
- SSE 走 `parseSseStream`（与 chat 共用 ag-ui 协议解析器）
- 数据获取经 @tanstack/react-query（staleTime 5s），实体写入后 `invalidateQueries` 触发 refetch

### 2.4 SSE 创作流（`use-novel-creation-flow.ts`，1450 行）

ag-ui 事件协议：`RUN_STARTED / CUSTOM(novel:progress|novel:checkpoint|novel:result) / RUN_FINISHED / RUN_ERROR`。

支持 5 种流程：create-flow（手动编排）、ai-arrange（按章纲 AI 编排）、reverse-arrange（反推）、create-discussion（群聊共创）、resumeDiscussion（快照恢复）。检查点决策经独立端点提交，用户消息暂存、下个检查点一并发送。

### 2.5 矩阵视图（`matrix/`，20+ 文件，约 9,000 行）

dhtmlx-gantt 风格「章节 × 实体」二维矩阵，实体行按组（角色/冲突/伏笔/势力/地点/物品等）划分，支持横向虚拟化、拖拽标记出场、实体 span 调整、子甘特图展开、多选。核心逻辑在 `matrix-logic.ts` / `matrix-model.ts`（1522 行）。

### 2.6 画布视图（`novel-canvas.tsx` + `nodes/` + `canvas/`）

ReactFlow 关系图：9 种节点（Project/Chapter/Character/Conflict/Faction/Foreshadow/Location/WorldElement/Group），两种布局（grouped 分区 / d3-force 力导向），连线类型 15 种，支持高亮邻居、路径查找。

---

## 3. 端到端数据流

### 3.1 创作主链路（create-flow）

```
用户点「开始创作」
  │
  ├─ 前端：useNovelCreationFlow.startCreation()
  │     → POST /chapters/:n/create-flow（SSE）
  │
  ├─ 后端：creation-flow-routes → NovelOrchestrator.createChapterWithFlow
  │     ├─ Director → 检查点1（前端弹出决策卡，用户 approve 后 POST decision）
  │     ├─ Writer → 正文流式回流（SSE novel:progress，writer 输出直接展示）
  │     ├─ 质量门 → 盲审 → 完整 Reviewer → 检查点2
  │     ├─ revise → Reviser 局部补丁（novel_apply_revision 精确替换）
  │     └─ Memory → 工具更新实体动态状态 → 快照
  │
  ├─ 后端：写库（章节/角色历史/记忆事件/账本）+ 推送 dataChanged
  │
  └─ 前端：接收 novel:result → 刷新数据（invalidateQueries refetch）→ 画布/矩阵更新
```

### 3.2 状态同步链路

```
后端任意实体写入（REST / Agent 工具 / 矩阵拖拽）
  → NovelStore 门面观察者 → ChapterProjectionRecorder → 事件账本
  → dataChanged 事件 → 前端 refetch → novel-data-store.loadProjectData（remote 权威合并）
```

### 3.3 提示词组装链路

```
runAgent(agentType)
  → buildSystemPrompt（STATIC：世界规则+风格+身份）
  → buildChapterContext（SEMI：章节信息+约束+arrangedEntities+故事状态+信息差+摘要）
  → userMessage（DYNAMIC：任务输入）
  → createSession({ systemPrompt, prefixUserMessage, userMessage, tools, temperature, timeoutMs })
```

---

## 4. 设计不合理之处

按严重程度分级。P0 = 严重影响可维护性/正确性；P1 = 结构性缺陷；P2 = 代码异味。

### P0-1 巨型组件与上帝文件（最突出）

知识图谱复杂度数据（认知复杂度）：

| 文件 | 行数 | 认知复杂度 | 环复杂度 |
| --- | --- | --- | --- |
| `matrix-workspace.tsx` | 1571 | **568** | 208 |
| `use-novel-creation-flow.ts` | 1450 | **221** | 87 |
| `novel-routes.ts createNovelRoutes` | 1944 | **119** | 104 |
| `novel-workspace.tsx` | 1498 | **110** | 66 |
| `creation-flow-routes.ts` | 1339 | 102 | 76 |
| `use-chapter-chat.ts` | 324 | 93 | 39 |
| `novel-canvas.tsx` | 759 | 88 | 59 |
| `prompt-builder.ts` | **3798** | — | — |
| `novel-entity-generator.ts` | 2885 | — | — |
| `novel-tools.ts` | 2485 | — | — |
| `novel-orchestrator.ts` | 2449 | — | — |
| `novel-client.ts` | 1949 | — | — |

- `MatrixWorkspace` 认知复杂度 568 意味着单组件承载了整个矩阵交互的全部状态机，几乎无法安全修改
- 后端 `prompt-builder.ts` 3798 行集缓存分层、上下文拼装、哈希、诊断于一身
- 结论：**模块功能正确性不错，但单体化严重，已到拆分的临界点**

### P0-2 路由层类型安全缺失

`novel-routes.ts` 及子路由所有 handler 均使用 `request: any, reply: any`（如 `POST /projects`、`GET /projects/:id` 等），放弃了 Fastify 的类型推断与运行时校验收益；zod schema 校验结果仅用于 body 校验，参数（params）未做 schema 声明。

### P0-3 双创作路径并存，一致性靠人工维护

- `create-flow`（NovelOrchestrator + SSE）与 `create-team`（TeamManager pipeline）是两套独立执行引擎
- `index.ts` 注释自述："字段对齐…保证 create-team 路径与 create-flow 路径行为一致"——一致性完全依赖代码注释约定，无测试保障
- 风险：任一引擎改动（如新增检查点、调整工具权限）若不同步更新另一路径，两条路径行为即分叉

### P1-1 事件账本为「事后补丁」设计

`novel-services.ts` 注释自述两个事实：
1. "账本原本完全没有势力/地点的记录，角色/线索/冲突/伏笔也各有缺失，来源是手工编辑、Memory Agent 工具、矩阵拖拽这些**不经过编排器的写入路径**" —— 说明账本最初只覆盖编排器主路径，靠加观察者到 Store 门面才收口
2. "`story_event_entities.entity_id` / `memory_events.subject_id` **没有外键**，不清理会留下悬空引用（真实库实测 11 条）" —— 数据库缺外键/约束，靠应用层手动清理

结论：账本一致性依赖应用层纪律而非数据库约束，存在长期漂移风险（已有启动回填、对账脚本等补丁佐证）。

### P1-2 前端全量数据内存态 + localStorage 持久化上限隐患

- 前端把 19 类实体**全量列表**拉入内存 store（listCharacters / listChapters / listForeshadowing…一次拉全部），长篇项目（300 章、200+ 角色）下首次加载与每次 refetch 的 payload 很大
- `novel-data-store` partialize 注释自述：章节正文若持久化会超 localStorage 配额导致**整个 store 静默失效**——当前用「剥掉 content」规避，但其余元数据 + 历史 + 画布边 + 节点位置全量持久化，体量仍随项目线性增长
- 缺分页/增量加载/按需查询的分层设计（全部依赖 refetch 全量列表）

### P1-3 arrangedEntities 注入存在 N+1 查询

`formatArrangedEntities` 对 characterIds / conflictIds / foreshadowIds **逐 ID 调 `getCharacter/getConflict/getForeshadow`** 查询数据库。编排实体多时（一章 10+ 角色 + 冲突 + 伏笔）产生 N+1 次同步 DB 查询，且位于热路径（每次 runAgent 都执行）。

### P1-4 全局 Undo/Redo 与局部编辑器 Undo 的冲突处理脆弱

全局 Ctrl+Z 绑定 novel-data-store 的 temporal undo（App 级 useShortcut），注释以「编辑器内由 Tiptap 自行处理」规避。但 Tiptap 内部 Undo 与全局快捷键的边界依赖事件冒泡顺序，一旦焦点态判断失误，用户可能在编辑器里误触发「撤销整个画布数据」。属于隐式约定，无显式焦点门控。

### P1-5 硬编码魔法值散落

- writer 超时 300s / 其他 120s、心跳 15s、历史栈 limit 50、refetch staleTime 5s
- 未集中到配置/常量层，调优需改代码

### P2-1 架构文档滞后于实现

- `ARCHITECTURE.md` 仍列 `novel-agent-config-store.ts`、`novel-session.ts`、`rhythm-controller.ts` 等**已删除/改名**模块（services 注释明确"已删除空壳"）
- 文档称 novel-routes.ts 为路由总入口，实际已拆 `routes/` 子目录，novel-routes.ts 是聚合器但仍内联大量路由
- 建议：文档与实现定期对账（或用 codegen 生成路由清单）

### P2-2 代码异味

- `createNovelRoutes` 内 `void promptBuilder / void relationshipGraph / void consistencyAuditor`——解构了但不用（残留调试代码）
- `consistencyAuditor` 在 services 中仍有注释称其 prompt 注入消费者"从未被调用，已随死代码删除"，但实例仍在 services 层存活
- `novel-store.ts` 与 `core/stores/` 16 个领域 store 边界模糊：门面 + 子 store 的调用路径不统一（部分代码直接 new 子 store，部分走门面），有双入口风险

---

## 5. 改进建议（按优先级）

1. **拆分巨型组件**：`MatrixWorkspace`（认知复杂度 568）按交互域拆分（矩阵主体/工具条/拖拽逻辑/多选状态机）；`use-novel-creation-flow` 拆出 SSE 事件归约器；后端 `prompt-builder` / `novel-tools` 按职责分文件
2. **路由类型化**：handler 参数用 Fastify 泛型或共享 Zod schema 推导类型，消灭 `any`
3. **收敛双创作路径**：以 `create-flow` 为唯一事实源，`create-team` 薄封装调同一编排器，或为两条路径建一致性测试
4. **账本改数据库约束**：为 `story_event_entities.entity_id` / `memory_events.subject_id` 补外键（或触发器），从源头防悬空引用
5. **前端改按需加载**：章节正文/历史/边等大数据量字段改为按需查询（打开章节时拉取），去掉全量 refetch；localStorage 仅存 UI 偏好
6. **消除 N+1**：`formatArrangedEntities` 改为按 ID 批量查询（`WHERE id IN (...)`）
7. **配置集中化**：超时/心跳/历史栈上限等移入常量或设置
8. **同步文档**：ARCHITECTURE.md 与实际模块对账，删除已死模块条目

---

## 6. 决策记录与第 3 条合并方案设计（2026-08-05 用户确认）

### 6.1 用户对 8 条建议的决策

| # | 建议 | 决策 |
| --- | --- | --- |
| 1 | 拆分巨型组件 | ✅ 可以拆分 |
| 2 | 路由类型化 | ✅ 可以 |
| 3 | 收敛双创作路径 | ⏸ **暂不修改**，改为探索「合并 create-flow + create-team，由导演决定是否角色演出」方案（见 6.3） |
| 4 | 账本改数据库约束 | ✅ 可以 |
| 5 | 前端改按需加载 | ✅ 可以 |
| 6 | 消除 N+1 | ✅ 可以 |
| 7 | 配置集中化 | ✅ 可以，**放入设置**（用户可配置，而非仅常量） |
| 8 | 同步文档 | ✅ 可以 |

### 6.2 现状核实（三条创作路径的关系）

| 路径 | 实现 | 传输 | 检查点 | 质量门 | arrangedEntities | 前端 UI 入口 |
| --- | --- | --- | --- | --- | --- | --- |
| create-flow | NovelOrchestrator | SSE | ✅ 2 个 | ✅ | ✅ | ✅ |
| create-team | TeamManager pipeline | 同步 HTTP | ❌ | ❌ | ❌ | **❌ 无（grep 全前端无调用）** |
| create-discussion | NovelDiscussionRunner | SSE | ✅（群聊） | 部分 | ✅ | ✅ |

**核实结论**：
- create-team 是 create-flow 的「低配简化版」——只拼 narrativeTask 文本走 TeamManager 通用 pipeline，无检查点/质量门/编排实体/SSE；前端 UI 已无入口，仅可通过通用 `team_execute` / subagent 工具间接触发。**与 create-flow 合并是安全的，几乎没有兼容性成本**。
- 群聊共创（create-discussion）是独立完整流程：planning → scene_setup → acting（角色演出）→ scene_weaving → chapter_weaving（Writer 编织），`DISCUSSION_AGENT_TYPES` 包含 director/writer/reviewer/reviser，角色成员读私有上下文（只看自己知道的信息），产出 content + scenes + transcript。
- 两条路径的「场景计划」已在 V2 重构（T01-T05）中被 `ChapterScenePlan` 统一（`buildScenePlanFromNarrativeTask` / `buildScenePlanFromSceneDefinitions` 均为纯函数），**这是本次合并方案的天然基础**。

### 6.3 合并方案设计：create-flow 统一入口 + 导演决策角色演出

#### 目标

1. 移除 create-team 冗余路径，create-flow 成为唯一创作入口
2. Director 在规划阶段**决策本章创作模式**：标准写作（Writer 直写）或角色演出（群聊共创后再编织）
3. 两条模式汇合到统一的 Reviewer → Memory 收尾

#### 目标架构

```
POST /chapters/:n/create-flow（唯一入口，SSE）
  │
  ├─ Phase 1: Director 规划
  │    输出：narrativeTask + mode 建议（'direct' | 'discussion'）+ modeReason
  │    │
  │    ├─ 检查点1（决策卡片）：
  │    │    「导演建议：角色演出（理由：本章为冲突爆发章，多角色对峙，演出可让对话更自然）」
  │    │    选项：direct（标准写作）/ discussion（角色演出）/ 直接 approve 导演建议
  │    │
  │    └─ 模式分派：
  │         ├─ direct      → Phase 2: Writer 直写（现状不变）
  │         └─ discussion  → Phase 2': DiscussionRunner 演出模式
  │                             ├─ planning / scene_setup / acting（Moderator + 角色成员）
  │                             ├─ scene_weaving / chapter_weaving（Writer 编织 → content）
  │                             └─ 产出 content + scenes
  │
  ├─ Phase 3: 质量门 + Reviewer（盲审 + 完整评审）← 两模式汇合
  ├─ Phase 4: Reviser（revise 时）
  └─ Phase 5: Memory（提取状态变更）
```

#### 关键设计点

1. **Director 的 mode 决策能力**：Director 工具集增加 `novel_ask_story`（已存在）即可基于故事状态判断；mode 字段写入 NarrativeTask 输出（V2 `ChapterScenePlan` 的 scene_count / pov 已隐含决策素材）
2. **决策收敛在检查点 1**：不让 Director 全自动（成本/质量失控风险），而是「导演建议 + 用户拍板」——检查点 1 同时展示叙事任务与模式建议，用户可 approve 或切换
3. **讨论模式复用而非重构**：Phase 2' 调用 `discussionRunner` 的演出核心（planning→acting→weaving），但**检查点收敛到 create-flow 的统一决策通道**（现状 discussion 有自己的 checkpoint 端点，需适配为统一 `POST /checkpoint/:id/decision`）
4. **汇合点定义**：讨论产出 `content + scenes + transcript`，scenes 经 `buildScenePlanFromSceneDefinitions` 归一为 ChapterScenePlan（V2 已具备），正文走统一质量门 → Reviewer → Memory
5. **成本护栏**：discussion 模式 LLM 调用数远高于 direct（每角色一次），Director 建议 mode 时需参考字数预算（WordBudgetResolver V2）与本章定位；可在设置中加「角色演出默认模式」开关
6. **create-team 的处置**：HTTP 端点删除或标记 deprecated（前端已无调用）；`novel-team` 在 TeamManager 的注册**保留**（通用 `team_execute` / subagent 路径仍需要它），但改为薄封装——把 task 文本解析后委托 orchestrator 执行，保证两条入口行为一致

#### 风险与边界

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 双检查点通道 | workflow checkpoint 与 discussion checkpoint 现状是两个端点 | 统一到 create-flow 单一决策通道，discussion 内部检查点降级为进度事件 |
| 讨论流程嵌入复杂度 | discussionRunner.run 是完整独立流程，含断点续跑 | 抽出「演出+编织」核心（不包断点续跑/独立 SSE），或先以「嵌套调用」快速验证再抽 |
| 成本失控 | 群聊模式每角色一次 LLM 调用 | Director 建议 + 用户确认；设置项「角色演出需确认/直接执行」；预算护栏 |
| V2 兼容 | T01-T05 已落地 ChapterScenePlan 双写/账本 | 合并方案依赖 V2 的 plan 归一，建议在 V2 收尾（前端接入）后实施 |

#### 建议实施顺序

1. （前置）T01-T05 前端 UI 接入完成，V2 双写对账稳定
2. Director 输出增加 mode 建议字段 + 检查点 1 增加模式选项（direct/discussion）
3. discussionRunner 抽出可复用的「演出核心」；orchestrator 增加 discussion 分支
4. create-team 端点 deprecated → 删除；novel-team 注册保留并薄封装委托 orchestrator
5. 设置页新增「角色演出」默认模式与成本护栏开关

---

## 附录：知识图谱复杂度证据（codebase-memory-mcp）

查询 `MATCH (f:Function) WHERE f.cognitive >= 25` 返回 30 个函数，Top 5：
`MatrixWorkspace(568) > useNovelCreationFlow(221) > build-bytenode.patchDynamicImports(141) > createNovelRoutes(119) > NovelWorkspace(110)`

热路径信号：`linear_scan_in_loop` 命中 `useChapterChat(2)`、`buildReferenceQualityReport(3)`、`findExistingByName/Description(2)` 等。
