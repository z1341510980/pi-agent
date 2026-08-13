# 小说插件架构文档

> 路径：`apps/agent-server/src/plugins/novel-plugin/`
> 作用：基于多 Agent 协作的长篇小说创作系统，支持实体编排、章节生成、状态追踪、长期记忆。
> 本文档为功能索引，方便快速定位模块与数据流。

---

## 1. 整体架构

### 1.1 目录结构

```
novel-plugin/
├── index.ts                       # 插件入口（createNovelPlugin）
├── manifest.json                  # 插件清单（name=novel, builtin=true）
├── novel-migrations.ts            # 静态数据库迁移（表 013-026）
├── novel-services.ts              # 服务组装（createNovelServices）
├── novel-routes.ts                # REST/SSE 路由（前缀 /api/plugins/novel）
├── ARCHITECTURE.md                # 本文档
├── __tests__/                     # 测试
└── core/
    ├── index.ts                   # 公共导出
    ├── types.ts                   # 全部数据模型
    ├── novel-store.ts             # 统一存储层（SQLite CRUD）
    ├── novel-memory-store.ts      # 长期记忆（事件 + 快照 + 因果链）
    ├── novel-agent-config-store.ts # Agent 温度配置存储
    ├── prompt-manager.ts          # 提示词模板管理（三级覆盖）
    ├── prompt-builder.ts          # 缓存优化的提示词构建器
    ├── novel-tools.ts             # Agent 工具定义
    ├── novel-session.ts           # Session 工厂
    ├── novel-engine.ts            # 核心引擎（约束构建 + 章节状态机）
    ├── novel-orchestrator.ts      # 多 Agent 编排引擎
    ├── novel-agents.ts            # 4 个 Agent 配置定义
    ├── novel-character-generator.ts # AI 角色生成器
    ├── novel-entity-generator.ts  # 通用 AI 实体生成器（含 generateAndArrange）
    ├── rhythm-controller.ts       # 节奏控制器
    └── prompts/                   # 提示词模板（10 个 .md）
```

### 1.2 入口 `index.ts` 的 setup 流程（7 步）

1. `createNovelServices(context)` 初始化所有服务
2. 装饰 Fastify（注册 6 个 service：store / promptManager / promptBuilder / sessionFactory / engine / orchestrator）
3. 注册 4 个 Novel Agent 到 AgentManager（director / writer / reviewer / memory）
4. 注册 Novel Team 到 TeamManager（id=`novel-team`，pipeline 策略，成员 4 个）
5. 注册 Pi Session 工具（注入 customTools）
6. 注册 REST API 路由（`/api/plugins/novel` 前缀）
7. 注册前端面板（id=`novel-canvas`，组件 NovelCanvas）

**依赖**：必须在 `databasePlugin` 和 `pluginLoaderPlugin` 之后加载。

### 1.3 服务依赖图（`novel-services.ts`）

```
db ─┬─► NovelStore
    ├─► NovelMemoryStore
    ├─► PromptManager（依赖 db + cwd）
    └─► NovelAgentConfigStore

PromptManager + NovelStore ─► NovelPromptBuilder
NovelStore + PromptManager ─► NovelSessionFactory
NovelStore + NovelSessionFactory ─► NovelEngine
NovelStore + NovelMemoryStore + NovelSessionFactory + NovelPromptBuilder + NovelEngine + PluginContext + NovelAgentConfigStore ─► NovelOrchestrator
NovelPromptBuilder + PromptManager + PluginContext ─► NovelCharacterGenerator
NovelPromptBuilder + PromptManager + PluginContext + NovelCharacterGenerator + NovelStore ─► NovelEntityGenerator
NovelStore ─► createNovelTools
```

---

## 2. 数据模型（`core/types.ts`）

### 2.1 实体清单

| 实体       | 接口                    | 关键字段                                                                                                                                                                                               |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 项目       | `NovelProject`          | id, title, genre, synopsis, outline, targetWords, currentVolume, currentChapter, currentStage(`StoryStage`), status, rhythmModelId                                                                     |
| 卷         | `NovelVolume`           | id, projectId, volumeNumber, title, outline, sortOrder                                                                                                                                                 |
| 章节       | `NovelChapter`          | id, projectId, volume, chapterNumber, title, content, wordCount, status(`ChapterStatus`), narrativeTask, outline, volumeId, acceptanceResult, rhythm                                                   |
| 角色       | `NovelCharacter`        | 见 2.2 节（重点）                                                                                                                                                                                      |
| 关系       | `NovelRelationship`     | characterA, characterB, relationType, currentStage, stageHistory(JSON)                                                                                                                                 |
| 伏笔       | `NovelForeshadow`       | description, category, status(`ForeshadowStatus` 7 态), firstChapter, lastChapter, recoverByChapter, linkedCharacters(JSON), linkedClues(JSON)                                                         |
| 线索       | `NovelClue`             | description, pointsTo, progress(0-100), currentStep, nextStep, isMisleading, linkedForeshadow                                                                                                          |
| 冲突       | `NovelConflict`         | description, type(`ConflictType` 9 种), intensity(1-10), stage(`ConflictStage` 7 阶), participants(JSON), firstChapter, lastChapter, tier(`ConflictTier`: main/secondary/goal)                         |
| 世界规则   | `NovelWorldRule`        | category, rule, cost, isFixed                                                                                                                                                                          |
| 势力       | `NovelFaction`          | name, type(6 种), leaderId, ideology, strength(4 级), resources[], allies[], enemies[], status(4 态), firstChapter, lastChapter                                                                        |
| 地点       | `NovelLocation`         | name, type(7 种), parentId, factionId, significance(4 级), firstChapter, status(4 态), appearChapters[]                                                                                                |
| 世界观要素 | `NovelWorldElement`     | category(7 类), name, description, parentId, attributes(Record)                                                                                                                                        |
| 创作约束   | `NovelConstraint`       | type(`ConstraintType`: fact/cognitive/stage/debt/arc), scope(global/volume/chapter), rule, isActive, relatedEntityId                                                                                   |
| 信息差     | `NovelInformationLayer` | infoDescription, authorKnows, readerKnows, characterKnowledge(JSON), revealStage, revealChapter, isRevealed                                                                                            |
| 风格指南   | `NovelStyleGuide`       | category, rule, example                                                                                                                                                                                |
| 作者意图   | `NovelAuthorIntent`     | chapterId, intentType(plot/foreshadow/character/scene/dialogue), description, targetEntityId                                                                                                           |
| 章节验收   | `NovelChapterReview`    | 10 项评分(consistency/character/taskCompletion/clueProgress/foreshadowStatus/conflictChange/pacing/infoControl/readerHook/style) + overallScore + verdict(accept/revise/reject) + issues + suggestions |
| 角色历史   | `NovelCharacterHistory` | characterId, chapterId, chapterNumber, fieldName(`CharacterHistoryField`: currentState/currentGoal/currentPressure/secret/arcStage), oldValue, newValue, reason                                        |
| 节点位置   | `NovelNodePosition`     | nodeType(`NovelNodeType`), entityId, posX, posY                                                                                                                                                        |
| 画布连线   | `NovelEdge`             | sourceId, sourceType, targetId, targetType, edgeType(`NovelEdgeType` 15 种), label, auto                                                                                                               |
| 提示词模板 | `NovelPromptTemplate`   | projectId(null=全局), name, content, description                                                                                                                                                       |
| 时间轴标记 | `NovelMarker`           | chapter, title, note, type(6 种), color(5 色), entityType, entityId                                                                                                                                    |
| Agent 日志 | `NovelAgentLog`         | 完整 prompt 三层 + 结果 + 耗时 + 状态                                                                                                                                                                  |

### 2.2 辅助类型

- `StoryStage`: setup / rising / climax / falling / resolution
- `ChapterRhythm`: setup / rising / climax / falling / resolution / twist / breather
- `ArrangedEntity`（重点）：

```ts
export interface ArrangedEntity {
  characterIds: string[]
  conflictIds: string[]
  foreshadowIds: string[]
  clueIds?: string[]
  factionIds: string[]
  locationIds: string[]
}
```

- `CacheLayer`: 'static' | 'semi' | 'dynamic'（提示词缓存分层标记）

---

## 3. 存储层（`core/novel-store.ts`）

类 `NovelStore` 实现 `NovelPromptStores` 接口。设计模式：构造时预编译 SQL + 同步写入 + 行→对象转换。

### 3.1 按 ID 查询方法

| 方法                                   | 说明                                       |
| -------------------------------------- | ------------------------------------------ |
| `getProject(projectId)`                | 项目                                       |
| `getChapter(projectId, chapterNumber)` | 按项目+章号查                              |
| `getChapterById(chapterId)`            | 按 ID 查章节                               |
| `getCharacter(characterId)`            | 按 ID 查角色（供 arrangedEntities 注入用） |
| `getForeshadow(foreshadowId)`          | 按 ID 查伏笔                               |
| `getClue(clueId)`                      | 按 ID 查线索                               |
| `getConflict(conflictId)`              | 按 ID 查冲突                               |
| `getClue(clueId)`                      | 按 ID 查线索                               |
| `getRelationship(relationshipId)`      | 按 ID 查关系                               |
| `getVolume(id)`                        | 按 ID 查卷                                 |
| `getFaction(factionId)`                | 按 ID 查势力                               |
| `getLocation(locationId)`              | 按 ID 查地点                               |
| `getWorldElement(worldElementId)`      | 按 ID 查世界观要素                         |
| `getMarker(markerId)`                  | 按 ID 查标记                               |
| `getChapterReview(chapterId)`          | 按章节 ID 查最新验收                       |
| `getAgentLog(id)`                      | 按 ID 查完整日志                           |

### 3.2 按项目列表查询方法

`listProjects`、`listChapters(projectId)`、`listVolumes(projectId)`、`listCharacters(projectId)`、`listRelationships(projectId)`、`listForeshadowing(projectId)`、`listClues(projectId)`、`listConflicts(projectId)`、`listWorldRules(projectId)`、`listStyleGuide(projectId)`、`listConstraints(projectId)`（仅 is_active=1）、`listInformationLayers(projectId)`、`listRecentChapters(projectId, limit)`（仅 published，倒序）、`listFactions(projectId)`、`listLocations(projectId)`、`listWorldElements(projectId)`、`listEdges(projectId)`、`listMarkers(projectId)`、`listNodePositions(projectId)`、`listCharacterHistory(projectId, characterId?)`、`listAgentLogs(projectId, filter?, limit)`（支持按 chapterNumber / agentType 过滤）。

### 3.3 CRUD 覆盖

每个实体都有 `createXxx` / `updateXxx` / `deleteXxx`。删除实体（角色/章节/冲突/伏笔/势力/地点/世界观要素）时会调用 `deleteEdgesByEntity(entityId)` 级联清理画布连线。删除卷时把章节的 `volume_id` 置空，不级联删章。

---

## 4. 提示词构建（`core/prompt-builder.ts`）

核心设计：**三层缓存结构**（STATIC / SEMI / DYNAMIC），缓存命中率是关键成本指标。

### 4.1 缓存层级结构

```
[系统提示词] (STATIC - 跨章节缓存命中)
├── Layer 1: 世界规则（项目级，极少变）
├── Layer 2: 风格指南（项目级，极少变）
└── Layer 0: Agent 身份（Agent 专属，同 Agent 跨章不变）
（不含角色定义 ← 角色多时避免上下文爆炸）

[首条用户消息] (SEMI - 单章内缓存命中)
├── 章节信息（卷/章/叙事任务/约束）
├── 本章出场角色完整定义（arrangedEntities，仅本章角色）
├── 当前故事状态（所有角色的 name+动态状态，让 LLM 知道存在）
├── 信息差（谁知道什么）
├── 最近章节摘要
└── 创作指令（仅 Writer 注入）

[对话消息] (DYNAMIC - 不缓存)
├── 工具调用 + 结果（追加到末尾，不破坏前缀缓存）
├── 生成内容
└── 用户引导
```

### 4.2 系统提示词 `buildSystemPrompt(projectId, agentType)`

构建顺序（共享前缀在前，Agent 专属在后）：

1. **Layer 1：世界规则** — `listWorldRules`，按 category 排序
2. **Layer 2：风格指南** — `listStyleGuide`，按 category 排序
3. **Layer 0：Agent 身份** — `promptManager.render('system-base', { agent_type, agent_role })`，`agent_role` 从 `role-{agentType}` 模板读取

各部分用 `\n\n---\n\n` 连接。**关键：系统提示词不含角色定义**，整个项目生命周期内保持不变（除非世界规则/风格被修改）。

### 4.3 章节上下文 `buildChapterContext(...)`

签名：

```ts
buildChapterContext(
  projectId, chapterNumber, narrativeTask,
  constraints: ChapterConstraints,
  arrangedEntities?: ArrangedEntity,  // ← 重点
  agentType?: string,
): string
```

按顺序拼接（用 `\n\n---\n\n` 连接）：

1. **章节信息** `formatChapterInfo` — 卷号、章号、叙事任务、优先级、目标字数（`computeChapterTargetWords`：项目设置的默认每章字数，再按节奏调整）
2. **创作约束** `formatConstraints` — 事实约束 / 认知约束 / 阶段约束 / 叙事债务（待回收伏笔）/ 角色弧光约束
3. **本章已编排实体约束** `formatArrangedEntities`（**重点**）— 见 4.4 节
4. **当前故事状态** `formatStoryState` — 角色动态状态（currentState/currentGoal/currentPressure）+ 关系 + 活跃冲突 + 待回收伏笔 + 活跃线索
5. **实体关联** `formatEdges` — 画布连线，用 `buildEntityNameMap` 把 ID 映射为可读名称
6. **信息差** `formatInfoLayers` — 读者已知/未知 + 计划揭露阶段
7. **最近章节摘要** `formatRecentSummaries` — 默认取最近 3 章 published，优先用 narrativeTask 作为摘要
8. **创作指令**（**仅 writer 注入**）— `promptManager.render('chapter-instruction', { chapter_number, narrative_task, task_type, target_words })`，对 Director/Reviewer/Memory 注入会导致越权写作

### 4.4 arrangedEntities 注入逻辑（`formatArrangedEntities`）

输出标题为「【本章必须出现的实体（已编排约束，Writer 必须遵守）】」，然后：

- **characterIds** → 调用 `stores.getCharacter(id)` 逐个查询，输出**完整静态+动态定义**：
  ```
  出场角色（完整定义）：
    ### 角色名
    - 身份：...
    - 性格：...
    - 外貌：...
    - 说话风格：...
    - 当前状态：...
    - 当前目标：...
    - 当前压力：...
  ```
- **conflictIds** → 调用 `stores.getConflict(id)`，输出 `描述（stage，强度N）`
- **foreshadowIds** → 调用 `stores.getForeshadow(id)`，输出 `描述（status）`

**角色定义放在 SEMI 层（章节上下文）而非 STATIC 层（系统提示词）的原因**：

- 角色数量可能很大（200+），全部塞系统提示词会导致上下文爆炸
- 本章出场角色已通过 arrangedEntities 编排好，只需注入这些角色的完整定义
- 系统提示词不含角色定义 → 跨章缓存命中最好
- 其他角色 LLM 通过 formatStoryState 知道存在（name+动态状态），需要详情时调 `novel_query_state` 工具

### 4.5 缓存诊断方法

- `getSystemPromptHash(projectId, agentType)` — SHA-256 前 16 位
- `getChapterContextHash(...)` — arrangedEntities 参与 hash 输入

### 4.6 `NovelPromptStores` 接口

NovelPromptBuilder 只读取数据，定义了 18 个读方法。除了常规 list 方法，专门定义了 `getCharacter` / `getConflict` / `getForeshadow` 三个按 ID 查询方法，**专门供 arrangedEntities 注入时使用**。

---

## 5. 工具系统（`core/novel-tools.ts`）

共 17 个工具，按字母序注入（确保 tools schema 顺序稳定，最大化 prompt cache 命中率）。

### 5.1 查询类工具（只读，3 个）

| 工具名                  | 作用                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `novel_query_state`     | 按 queryType 查询：characters/relationships/conflicts/foreshadowing/clues/world_rules/constraints/info_layers/style_guide/all |
| `novel_query_factions`  | 查询项目下所有势力                                                                                                            |
| `novel_query_locations` | 查询项目下所有地点                                                                                                            |

### 5.2 更新类工具（5 个）

| 工具名                      | 可更新字段                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `novel_update_character`    | currentState / currentGoal / currentPressure / secret / arcStage（**只更新动态，不动静态**） |
| `novel_update_foreshadow`   | status（自动更新 first/last chapter）                                                        |
| `novel_update_conflict`     | stage / intensity                                                                            |
| `novel_update_clue`         | progress / currentStep / nextStep                                                            |
| `novel_update_relationship` | currentStage                                                                                 |

### 5.3 创建类工具（9 个）

`novel_create_character` / `novel_create_foreshadow` / `novel_create_conflict` / `novel_create_clue` / `novel_create_faction` / `novel_update_faction` / `novel_create_location` / `novel_update_location` / `novel_create_world_element` / `novel_update_world_element`

### 5.4 缓存策略

读工具查询数据库最新状态，结果作为 tool message 追加到对话末尾（DYNAMIC 层）；写工具立即写入数据库但**不修改系统提示词和章节上下文**，前缀缓存命中；状态变更在下一章的新 session 中体现。

### 5.5 各 Agent 的工具权限（`novel-agents.ts`）

| Agent    | 允许的工具                                                     |
| -------- | -------------------------------------------------------------- |
| director | novel_query_state, novel_query_factions, novel_query_locations |
| writer   | novel_query_state（只读，不能写状态）                          |
| reviewer | novel_query_state                                              |
| memory   | 全部 17 个工具（含所有 create/update）                         |

---

## 6. 编排流程（`core/novel-orchestrator.ts`）

### 6.1 完整流程图（`createChapterWithFlow`）

```
[入口] createChapterWithFlow(projectId, chapterNumber, options)
  │
  │ options.arrangedEntities → 暂存到 this.currentArrangedEntities
  │
  ├── 计算节奏建议（RhythmController.suggestRhythm）
  │
  ├── Phase 1: Director  runAgent('director', ...)
  │     任务："请分析当前故事状态，为第 N 章规划叙事任务。"
  │     附带 rhythmSuggestion
  │
  ├── 检查点 1（narrative_task）
  │   onCheckpoint({ type: 'narrative_task', data: directorResult })
  │   └─ approve → 继续 / reject → 取消 / revise|rewrite → 当前视为 approve
  │
  ├── Phase 2: Writer  runAgent('writer', ...)
  │     任务："请根据叙事任务创作第 N 章正文。"
  │     附带 narrativeTask: directorResult
  │
  ├── 确定性质量门
  │     PostWriteGuard：退化、字数失控、矩阵角色缺失
  │     ProseQualityEvaluator：碎段、短段、解释腔、模板句式
  │
  ├── Phase 3a: 文字盲审  runAgent('reviewer', contextMode='identity_only')
  │     只携带正文、文风档案和形态扫描，不携带 Director 方案或世界状态
  │
  ├── Phase 3b: 完整 Reviewer  runAgent('reviewer', ...)
  │     综合盲审意见、矩阵、连续性和 Director 方案输出最终报告
  │
  ├── 检查点 2（review）
  │   onCheckpoint({ type: 'review', data: reviewResult })
  │   ├─ approve  → 跳过修订，直接进 Memory
  │   ├─ revise   → runAgent('reviser') 输出“原文/修改后”局部补丁
  │   └─ rewrite  → 递归调用 createChapterWithFlow（重新开始）
  │
  ├── Phase 5: Memory  runAgent('memory', ...)
  │     任务："请从第 N 章中提取状态变更。"
  │     附带 content: finalContent
  │     前后捕获实体状态快照（captureEntityState）→ 比较差异 → recordMemoryEvents
  │
  ├── saveChapterSnapshot（情景记忆，全量状态快照）
  ├── 推送 dataChanged 事件（前端刷新画布）
  ├── 自动保存章节（status='review'，wordCount）
  │
  └── [出口] 返回 { status: 'completed', content, stateChanges }

  运行态通过 AsyncLocalStorage 隔离，并发章节不会共享 arrangedEntities
```

### 6.2 arrangedEntities 数据流（**重点**）

**产生方式有两种**：

1. **模式 1：手动编排**（前端用户在画布上选择实体）→ `create-flow` 路由从 `request.body.arrangedEntities` 读取 → 传入 `orchestrator.createChapterWithFlow({ arrangedEntities })`

2. **模式 2：AI 编排**（按章纲自动生成）→ `ai-arrange` 路由调用 `entityGenerator.generateAndArrange(...)` → 返回 `ArrangedEntity`，只落矩阵，不生成正文；用户确认矩阵后再单独触发 `create-flow`

**消费路径**：

```
options.arrangedEntities
  → this.currentArrangedEntities = options.arrangedEntities
  → runAgent() 内部读取 this.currentArrangedEntities
  → promptBuilder.buildChapterContext(..., currentArrangedEntities, agentType)
  → formatArrangedEntities(projectId, arranged)
      ├─ getCharacter(id) → 输出角色完整静态+动态定义
      ├─ getConflict(id)  → 输出 "描述（stage，强度N）"
      └─ getForeshadow(id) → 输出 "描述（status）"
  → 拼接到 SEMI 层（章节上下文）的"本章必须出现的实体"段落
  → LLM 在 Writer 阶段就能看到编排约束
```

**清理时机**：`createChapterWithFlow` 的 `finally` 块清理 `currentArrangedEntities`，避免泄漏到下一次创作（含 rewrite 递归返回后）。

### 6.3 runAgent 内部流程

1. 从 `NOVEL_AGENT_CONFIGS[agentType]` 取配置
2. 拼接 inputText + 用户检查点指令（`this.userMessages`，消费后清空）
3. **STATIC 层**：`promptBuilder.buildSystemPrompt(projectId, agentType)`
4. **SEMI 层**：`promptBuilder.buildChapterContext(projectId, chapterNumber, narrativeTask, constraints, this.currentArrangedEntities, agentType)`
5. **DYNAMIC 层**：`userMessage = inputText`
6. 工具过滤：`allNovelTools.filter(t => config.tools.includes(t.name))`
7. 温度合并：`agentConfigStore.getByType(agentType)`（持久化覆盖 > 角色默认值）
8. 超时：writer 300s，其他 120s
9. `context.createSession({ systemPrompt, prefixUserMessage: chapterContext, userMessage, tools, signal, temperature, timeoutMs })`
10. `session.promptStream(delta => emitProgress)` 流式推送
11. 15s 心跳（首 token 前防止前端以为卡死）
12. `finally` 块写入 `novel_agent_logs`（fire-and-forget）

### 6.4 长期记忆机制

- `captureEntityState(projectId)` — 捕获角色、冲突、伏笔、线索、势力、地点、关系和信息差状态
- `recordMemoryEvents(...)` — 比较前后差异，把角色、冲突、伏笔、线索等变化记录到 `NovelMemoryStore`
- `saveChapterSnapshot` — 保存全量状态快照（characters + conflicts + foreshadowing + relationships）

### 6.5 Discussion 正文质量边界

- Moderator 只给角色刺激、风险和选择，不得预设结论、方案、台词或情绪答案。
- 工种成员读取矩阵 shared context；角色成员读取 `buildContextPrompt()` 生成的私有上下文，只包含上一章结尾、当前场景、本角色相关冲突及其知道/怀疑/误解的信息。
- 角色输出必须符合 `[可见动作] “角色台词”`。格式错误重试一次，仍失败时保守归一化；“意图/心理/应对”提纲不进入 Writer 剧本。
- Writer 只接收按场景整理后的角色演出，不接收 Moderator 的完整决策历史。
- 完章后与 create-flow 共用“正文形态扫描 → 文字盲审 → 完整 Reviewer → Reviser 通过 `novel_apply_revision` 工具局部修订 → ChapterFinalizer”。

---

## 7. 章节创作流程（端到端）

### 7.1 三种触发路径

#### 路径 A：`create-flow`（SSE）

```
POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/create-flow
body: { arrangedEntities?: { characterIds?, conflictIds?, foreshadowIds? } }
```

- 直接调 `orchestrator.createChapterWithFlow`，可选手动编排约束
- 检查点通过 `POST /api/plugins/novel/projects/:projectId/checkpoint/:type/decision` 推送决策，决策通过 EventEmitter 传递

#### 路径 B：`ai-arrange`（SSE，**模式 2**）

```
POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/ai-arrange
```

阶段 1：AI 编排

- 并发锁：`aiArrangeLocks` 按 `${projectId}:${chapterNumber}`
- 校验：章节存在 + 章纲非空
- 调用 `entityGenerator.generateAndArrange(projectId, chNum, chapter.outline, onProgress)`

阶段 2：前端接收编排结果并展示矩阵；用户确认后另行调用 create-flow，注入 `arrangedEntities`

#### 路径 C：`create-team`（同步）

```
POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/create-team
body: { narrativeTask, rhythm? }
```

- 兼容同步入口，内部复用 `orchestrator.createChapterWithFlow`，自动批准检查点；不再维护独立 TeamManager 创作旁路

### 7.2 `generateAndArrange` 详细流程（`novel-entity-generator.ts`）

```
[入口] generateAndArrange(projectId, chapterNumber, outline)
  │
  ├── 阶段 a: planEntitiesFromOutline
  │   构建 prompt → "你是小说实体规划助手。根据章纲规划本章需要哪些实体"
  │   LLM 返回 JSON: { characters: [{coreStyle}], conflicts: [{coreStyle}], foreshadows: [{coreStyle}] }
  │   用 repairAndParseJson 容错解析（处理 token 截断）
  │
  ├── 阶段 b: 逐个生成 + 落库
  │   for spec in plan.characters:
  │     generate('character', spec.coreStyle) → store.createCharacter(...)
  │     store.createCharacterHistory({ chapterNumber, fieldName:'currentState', newValue:'本章首次出场' })
  │     characterIds.push(created.id)
  │   for spec in plan.conflicts:
  │     generate('conflict', spec.coreStyle) → store.createConflict({ firstChapter: chapterNumber, ... })
  │     conflictIds.push(created.id)
  │   for spec in plan.foreshadows:
  │     generate('foreshadow', spec.coreStyle) → store.createForeshadow({ firstChapter: chapterNumber, ... })
  │     foreshadowIds.push(created.id)
  │
  ├── 失败回滚：反向顺序 best-effort 清理已落库实体
  │
  └── [出口] 返回 { characterIds, conflictIds, foreshadowIds }
```

注意：`generate` 本身不落库（character 委托给 characterGenerator，其他 6 类只返回字段）；落库由 `generateAndArrange` 或前端 review 后调 `createXxx` 完成。

### 7.3 单 Agent 阶段总览

| 阶段      | Agent                                | 输入                                        | 输出               | 工具权限         |
| --------- | ------------------------------------ | ------------------------------------------- | ------------------ | ---------------- |
| directing | director                             | "分析状态，规划叙事任务" + rhythmSuggestion | 叙事任务规划       | 只读 3 个 query  |
| writing   | writer                               | "根据叙事任务创作正文" + narrativeTask      | 章节正文           | 只读 query_state |
| reviewing | reviewer                             | "验收章节" + content                        | 审稿报告 + verdict | 只读 query_state |
| revising  | writer（displayAgentType='reviser'） | "根据审稿意见修订" + content + issues       | 修订后正文         | 只读 query_state |
| memory    | memory                               | "提取状态变更" + content                    | 调用工具更新状态   | 全部 17 个工具   |

---

## 8. 角色相关（**重点**）

### 8.1 角色字段结构（`types.ts`）

```ts
interface NovelCharacter {
  id
  projectId
  name
  description
  // ── 静态设定（跨章不变，进 SEMI 层的 arrangedEntities）──
  identity: string // 身份
  personality: string // 性格
  appearance: string // 外貌
  speechStyle: string // 说话风格
  isProtagonist: boolean
  // ── 动态状态（每章可能变，进 SEMI 层的 formatStoryState）──
  currentState: string // 当前状态（情绪/处境）
  currentGoal: string // 当前目标
  currentPressure: string // 当前压力
  secret: string // 秘密
  arcStage: string // 弧光阶段（introduction/development/struggle/transformation/resolution）
  arcHistory: string // JSON: ArcChange[]
  createdAt
  updatedAt
}
```

`CharacterHistoryField` 限定为 `currentState / currentGoal / currentPressure / secret / arcStage`，即只有这 5 个字段会记录历史。

### 8.2 静态 vs 动态的存储与使用（**核心**）

| 维度                | 静态设定                                                                              | 动态状态                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **字段**            | identity / personality / appearance / speechStyle / isProtagonist                     | currentState / currentGoal / currentPressure / secret / arcStage                                      |
| **存储位置**        | `novel_characters` 表，跨章不变                                                       | 同一张，但每章可能被 Memory Agent 通过 `novel_update_character` 更新                                  |
| **历史追踪**        | 不追踪                                                                                | `novel_character_history` 表逐章记录 oldValue/newValue/reason                                         |
| **提示词位置**      | **SEMI 层**（章节上下文的 `formatArrangedEntities`，仅本章出场角色）                  | **SEMI 层**（章节上下文的 `formatStoryState`，所有角色）                                              |
| **格式化方法**      | `formatArrangedEntities`                                                              | `formatStoryState` + `formatConstraints`（弧光段）                                                    |
| **输出格式**        | `### 角色名\n- 身份：...\n- 性格：...\n- 外貌：...\n- 说话风格：...\n- 当前状态：...` | `- **角色名**\n  状态：...\n  目标：...\n  压力：...`                                                 |
| **是否含 secret**   | 不含                                                                                  | 不含（secret 字段不在任何提示词中输出，仅存储）                                                       |
| **是否含 arcStage** | 不含                                                                                  | 不直接输出，但通过 `formatConstraints` 的"角色弧光约束"段输出：`角色名：当前阶段「X」→ 下一步可达：Y` |
| **更新工具**        | 无（必须通过 REST API 或 createCharacter）                                            | `novel_update_character`（仅更新动态 5 字段）                                                         |

### 8.3 arrangedEntities 中如何引用角色（**重点**）

数据流：

```
[产生] 模式1前端手选 / 模式2 generateAndArrange 落库后返回 characterIds[]
   ↓
[传递] options.arrangedEntities → orchestrator.currentArrangedEntities
   ↓
[注入] runAgent → buildChapterContext(..., currentArrangedEntities, ...)
   ↓
[格式化] formatArrangedEntities(projectId, arranged)
   ↓ 调用 stores.getCharacter(id) 逐个查询
[输出到 LLM]
  【本章必须出现的实体（已编排约束，Writer 必须遵守）】
  出场角色（完整定义）：
    ### 角色名
    - 身份：...
    - 性格：...
    - 外貌：...
    - 说话风格：...
    - 当前状态：...
    - 当前目标：...
    - 当前压力：...
```

### 8.4 角色与章节的关联

- **通过 arrangedEntities**：本章必须出场的角色 ID 列表（注入 SEMI 层）
- **通过 `novel_character_history` 表**：角色在哪些章节状态变了（chapterId / chapterNumber）
- **通过 `novel_edges` 表**：edgeType=`appearance` 表示角色↔章节出场关系（前端画布连线）
- **通过 `novel_markers` 表**：type=`clip-note` 时可关联 entityType+entityId 到章节标记

### 8.5 章节创作时 LLM 可见性（**重点**）

| 信息                                                                      | 是否可见      | 在哪里                                                | 备注                                                  |
| ------------------------------------------------------------------------- | ------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| 本章出场角色的完整静态设定（identity/personality/appearance/speechStyle） | ✅ 可见       | SEMI 层（`formatArrangedEntities`）                   | 仅 arrangedEntities 中的角色                          |
| 本章出场角色的动态状态（currentState/currentGoal/currentPressure）        | ✅ 可见       | SEMI 层（`formatArrangedEntities`）                   | 仅 arrangedEntities 中的角色                          |
| 所有角色的 name + 动态状态（currentState/currentGoal/currentPressure）    | ✅ 可见       | SEMI 层（`formatStoryState`）                         | 所有角色，让 LLM 知道存在                             |
| 所有角色的 arcStage                                                       | ✅ 间接可见   | SEMI 层（"角色弧光约束"段，通过 `formatConstraints`） | 输出"当前阶段「X」→ 下一步可达：Y"                    |
| 角色关系                                                                  | ✅ 可见       | SEMI 层（"关系当前状态"）                             | characterA ↔ characterB：relationType（currentStage） |
| 所有角色的 secret                                                         | ❌ 不可见     | 不在任何提示词中                                      | 仅存储，信息差由 `novel_information_layers` 单独管理  |
| 角色历史变更                                                              | ❌ 不直接可见 | 仅存储于 `novel_character_history`                    | 需通过专门工具或 API 查询，Agent 工具中无此查询       |

**Writer 额外看到**：chapter-instruction 模板（含字数要求、创作要求、输出格式）
**Director/Reviewer/Memory 看不到**：chapter-instruction 模板（防止越权写作）

---

## 9. 提示词模板（`core/prompts/`）

### 9.1 模板管理器（`prompt-manager.ts`）

三级覆盖优先级：**SQLite 运行时 > 项目文件 > 默认文件**

- 默认模板：`apps/agent-server/src/plugins/novel-plugin/core/prompts/*.md`
- 项目覆盖：`${cwd}/.pi/novel/prompts/*.md`
- 运行时覆盖：`novel_prompt_templates` 表（projectId 为 null 表示全局）
- 支持 `{{variable}}` 占位符替换（同时支持 `{{key}}` 和 `{{ key }}`）

### 9.2 模板清单

| 文件                     | 作用                                                                                                                                         | 调用位置                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `system-base.md`         | Agent 身份基础模板，定义工作原则、输出规范、职责边界、当前角色占位 `{{agent_type}}` `{{agent_role}}`                                         | `buildSystemPrompt`                                                     |
| `chapter-instruction.md` | 章节创作指令（Writer 专属），含 `{{chapter_number}}` `{{narrative_task}}` `{{task_type}}` `{{target_words}}`，**仅 writer agentType 时注入** | `buildChapterContext`                                                   |
| `role-director.md`       | 导演职责：分析故事状态、决定章节任务、协调子系统、绝不创作正文                                                                               | director 的 `agent_role`                                                |
| `role-writer.md`         | 写作职责：根据任务创作正文、保持文风、推进弧光/伏笔/冲突；含写作风格要求（禁破折号转折、开头直接进场景、结尾止于画面、语言干净）             | writer 的 `agent_role`                                                  |
| `role-reviewer.md`       | 审稿职责：检查一致性、评估任务完成度、检查信息差、评分 accept/revise/reject；绝不创作或改写                                                  | reviewer 的 `agent_role`                                                |
| `role-memory.md`         | 记忆职责：**必须通过工具更新状态**，含角色/伏笔/冲突/线索/关系工具使用指南，工作流程                                                         | memory 的 `agent_role`                                                  |
| `role-reviser.md`        | 修订职责：必须通过 `novel_apply_revision` 工具应用修改，传入 `pairs: [{from, to}]`，工具内部用 `String.replace` 做精确替换                   | reviser 的 `agent_role`，工具通过 `extraTools` 注入，draft 持有当前正文 |
| `role-director-discussion.md` | 群聊模式导演：确定本章方向、拆分场景（固定 Markdown 契约格式）、单 POV、总输出 ≤1200 字                                    | 群聊 director 的 `agent_role` |
| `role-writer-discussion.md`   | 群聊模式编织：把角色演出还原为场景动力链后编织正文，保留角色声音差异、指代消歧                                        | 群聊 writer 的 `agent_role` |
| `role-reviewer-discussion.md` | 群聊实时审查：角色 Agent 发言后判断 pass/request_rewrite，JSON 输出，PUSHBACK 必须放行                                        | 群聊 reviewer 的 `agent_role` |
| `role-character-actor.md`     | 群聊角色演员：剧本格式 `[动作/表情/心理外化] "台词"` 演出当前动作单元，被点名才发言                                        | 群聊角色成员的 `agent_role` |
| `role-prose-editor.md`    | 盲审文字编辑：只审文字形态与角色声音，不审规划；输出 ≤600 字，含角色声音专项三问                                   | `buildProseEditorIdentity` |
| `role-memory-generator.md`    | 记忆提取（JSON 版，主力）：从正文提取十类实体轨道变更，输出唯一 JSON 对象，系统解析后落库                              | `NovelMemoryGenerator`（memory-generator） |
| `role-similarity-scanner.md`  | 实体相似度扫描：8 类实体找语义重复组，输出 JSON 报告（similarity > 0.6 才报告），不修改实体                            | `novel-similarity-scanner.ts` |
| `role-character.md`      | 角色管家：管理静态设定、跟踪动态状态、维护弧光、管理关系                                                                                     | （已归档至 `_legacy/`，2026-08-06，代码零引用）                        |
| `role-clue.md`           | 线索管家：管理伏笔生命周期、跟踪线索进度、确保叙事债务回收                                                                                   | （已归档至 `_legacy/`，2026-08-06）                                     |
| `role-settings.md`       | 设定管家：管理力量体系/魔法/科技/政治经济、确保规则一致性、区分固定/阶段规则                                                                 | （已归档至 `_legacy/`，2026-08-06）                                     |

注意：`role-character` / `role-clue` / `role-settings` 三个模板曾为"管家 Agent"预留，代码零引用，已于 2026-08-06 归档至 `prompts/_legacy/`（`PromptManager` 只加载顶层 .md，归档目录不注册模板）。若未来启用"管家 Agent"，从 `_legacy/` 恢复即可。

### 9.3 REST API 模板管理

- `GET /prompts` — 列出所有模板名
- `GET /prompts/:name?projectId=` — 获取模板内容
- `PUT /prompts/:name` — 保存模板（body: content, projectId, description）

---

## 10. API 路由（`novel-routes.ts`）

所有路径自动加 `/api/plugins/novel` 前缀。SSE 端点使用 ag-ui 兼容事件（RUN_STARTED / CUSTOM(novel:progress|novel:checkpoint|novel:result) / RUN_FINISHED / RUN_ERROR）。

### 10.1 项目管理

| 方法   | 路径          | 说明     |
| ------ | ------------- | -------- |
| POST   | /projects     | 创建项目 |
| GET    | /projects     | 列出项目 |
| GET    | /projects/:id | 获取项目 |
| PATCH  | /projects/:id | 更新项目 |
| DELETE | /projects/:id | 删除项目 |

### 10.2 卷管理

`GET/POST /projects/:projectId/volumes`、`PATCH/DELETE /volumes/:id`

### 10.3 章节管理

| 方法  | 路径                          | 说明                                            |
| ----- | ----------------------------- | ----------------------------------------------- |
| POST  | /projects/:projectId/chapters | 创建章节（engine.createChapter）                |
| GET   | /projects/:projectId/chapters | 列出章节                                        |
| GET   | /chapters/:id                 | 获取章节                                        |
| PATCH | /chapters/:id                 | 更新章节（传 content 自动重算 wordCount；不能直接发布或改已发布正文） |
| POST  | /chapters/:id/complete        | 完成章节（engine.completeChapter）              |
| POST  | /chapters/:id/publish         | 发布章节（要求 review 状态、非空正文、当前 revision 审稿通过、前序章已发布） |

### 10.4 节奏控制

- `GET /rhythm-models` — 列出所有节奏模型
- `GET /projects/:projectId/rhythm-suggestion?chapterNumber=N` — 获取下一章节奏建议

### 10.5 实体 CRUD

每类实体（角色/伏笔/冲突/线索/关系/世界规则/风格指南/约束/信息差/势力/地点/世界观要素）都有 `POST /projects/:projectId/xxx`、`GET /projects/:projectId/xxx`、`PATCH /xxx/:id`、`DELETE /xxx/:id`。

### 10.6 AI 生成端点（SSE）

| 方法 | 路径                                        | 说明                                                       |
| ---- | ------------------------------------------- | ---------------------------------------------------------- |
| POST | /projects/:projectId/characters/ai-generate | AI 生成单个角色（落库）                                    |
| POST | /projects/:projectId/entities/ai-generate   | AI 生成 6 类实体（**不落库**，前端 review 后调 createXxx） |

### 10.7 角色历史

- `GET /projects/:projectId/characters/:characterId/history`
- `POST /projects/:projectId/characters/:characterId/history`
- `POST /projects/:projectId/character-history/batch`（批量补全）

### 10.8 画布相关

- `GET/PUT /projects/:projectId/node-positions`、`DELETE /projects/:projectId/node-positions/:nodeType/:entityId`
- `GET/POST /projects/:projectId/edges`、`DELETE /edges/:id`

### 10.9 长期记忆

- `GET /projects/:projectId/memory-events`（支持 chapterNumber/entityType/entityId/eventType/minSignificance/limit 过滤）
- `GET /projects/:projectId/memory-events/timeline/:entityId`（实体时间线）
- `GET /projects/:projectId/memory-events/causal/:eventId`（因果链）
- `GET /projects/:projectId/memory-snapshots`、`GET /projects/:projectId/memory-snapshots/:chapterNumber`

### 10.10 多 Agent 创作流程（**重点**）

| 方法 | 路径                                                     | 说明                                                                          |
| ---- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| POST | /projects/:projectId/chapters/:chapterNumber/create-flow | **SSE**，触发多 Agent 创作流程，body 可带 arrangedEntities（模式 1 手动编排） |
| POST | /projects/:projectId/checkpoint/:type/decision           | 推送检查点决策（approve/reject/revise/rewrite），可带 userMessages            |
| POST | /projects/:projectId/chapters/:chapterNumber/ai-arrange  | **SSE**，模式 2：只执行 AI 编排；用户确认后另行触发 create-flow               |
| POST | /projects/:projectId/chapters/:chapterNumber/create-team | 同步兼容入口，复用正式 Orchestrator 并自动批准检查点                           |

### 10.11 缓存诊断

- `GET /projects/:projectId/cache-diagnostics?chapterNumber=N` — 返回 4 个 Agent 的系统提示词哈希 + 章节上下文哈希

### 10.12 提示词模板

`GET /prompts`、`GET /prompts/:name`、`PUT /prompts/:name`

### 10.13 Agent 调用日志

- `GET /projects/:projectId/agent-logs?chapterNumber=&agentType=&limit=`（精简字段）
- `GET /agent-logs/:id`（完整字段）
- `DELETE /projects/:projectId/agent-logs`

### 10.14 时间轴标记

`POST/GET /projects/:projectId/markers`、`PATCH/DELETE /markers/:id`

### 10.15 Agent 配置

- `GET /agent-config` — 列出 4 个 Agent 的温度
- `PUT /agent-config` — 批量更新温度

---

## 11. 关键设计决策

### 11.1 角色定义精准注入（2026-07-02）

**问题**：角色数量大时（200+），全部塞系统提示词会导致上下文爆炸（~2万字）。而本章出场角色已通过 arrangedEntities 编排好，无需注入所有角色的完整定义。

**方案**：精准注入

1. 系统提示词不含任何角色定义 → 跨章缓存命中最好
2. 章节上下文注入 arrangedEntities 中角色的完整静态+动态定义 → 单章内缓存命中
3. 其他角色通过 formatStoryState 输出 name+动态状态 → LLM 知道存在
4. 需要其他角色详情时调用 query_state 工具 → DYNAMIC 层，不破坏前缀缓存

### 11.2 Agent 职责边界隔离（2026-07-02）

**问题**：`chapter-instruction.md`（含"直接输出章节正文"）注入到所有 Agent，导致 Director 越权写作。

**方案**：

- `buildChapterContext` 增加 `agentType` 参数，`chapter-instruction` 仅对 writer 注入
- `system-base.md` 增加"职责边界"段，明确各角色不能越权创作正文
- `role-director.md` / `role-reviewer.md` / `role-writer.md` 强化边界约束

### 11.3 系统提示词跨 Agent 缓存共享（2026-07-02）

**问题**：原 `system-base.md` 标题为 `# 小说创作系统 - director`，不同 Agent 第一字符就不同，破坏跨 Agent 缓存命中。

**方案**：

- 标题改为 `# 小说创作系统`（不带 agent_type）
- 共享部分（工作原则/输出规范/职责边界）作为前缀
- `{{agent_type}}` 和 `{{agent_role}}` 移到末尾的"## 当前角色"段
- 构建顺序：`世界规则 → 风格指南 → Agent身份`，共享前缀在前，Agent 专属在后

### 11.4 Writer 写作风格约束（2026-07-02）

**问题**：用户对写作风格有 4 条特殊要求。

**方案**：写入 `role-writer.md` 的 `## 写作风格要求（严格遵守）` 段：

1. 绝不使用破折号"——"进行情节转折或插说
2. 开头必须直接进入场景、动作或对话，禁止纯风景/环境描写
3. 结尾止于动作、对话或画面，绝不发表总结性、感悟性句子
4. 语言干净，避免滥用"突然""然而""于是"等连接词

### 11.5 Agent 执行过程流式可见（2026-07-02）

**问题**：LLM 处理大 prompt 时 60-120s 首 token 延迟，前端以为卡死。

**方案**：

- 推 LLM 前发 progress 事件（含输入字符数）
- 15s 心跳定时器（首 token 前持续推送"已等待 Ns"）
- 首 delta 触发"开始生成内容..."事件
- Writer timeout 300s，其他 120s

---

## 12. 测试与迁移

### 12.1 测试文件

- `__tests__/arranged-entities.test.ts` — arrangedEntities 注入逻辑测试
- `__tests__/chapter-routes.test.ts` — 章节路由测试
- `__tests__/volume-routes.test.ts` — 卷路由测试

### 12.2 数据库迁移

`novel-migrations.ts` 包含表 013-026 的全部迁移，作为静态属性声明，在 setup 之前执行，确保 NovelStore 构造时表已存在。

### 12.3 TeamManager 集成

`novel-team` 团队（pipeline 策略，maxParallel=1）：director(analyst) → writer(writer) → reviewer(reviewer) → memory(analyst)。与 SSE 流程并存，提供统一的 team_execute 触发方式。
