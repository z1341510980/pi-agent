# 小说模块（Novel）架构与现状

> 整理时间：2026-08-01
> 方法：三轮针对性代码调研（流水线与提示词 / 数据层与 API / 前端）+ 本次会话中实际改过的代码。
> 大文件为抽样阅读，抽样范围在各节标注。凡写「未确认」的地方就是真的没查，别当结论用。

---

## 0. 一句话概括

这是一个**多 Agent 长篇小说创作系统**：用户给一句意图，Director 规划叙事任务 → Writer 写正文 →
确定性扫描 + Reviewer 验收 → Reviser 修订 → Memory 提取状态变化落库。全程有 6 个检查点可人工介入。
支撑它的是一套**为 prompt cache 命中而分层的提示词系统**，和一套**双事实源的实体状态账本**。

规模：后端 `novel-plugin` 约 40 个核心文件（最大 `prompt-builder.ts` 3628 行），
前端 `components/novel` 约 30 个文件（最大 `novel-workspace.tsx` 1478 行），
共享类型 31 个实体接口，数据库 64 个迁移。

---

## 1. 数据模型

### 1.1 实体接口（`packages/shared/src/novel/index.ts`）

31 个 `NovelXxx` 接口，按职能分：

| 分组 | 接口 |
|---|---|
| 项目与结构 | `NovelProject`、`NovelVolume`、`NovelChapter` |
| 人物 | `NovelCharacter`、`NovelRelationship`、`NovelCharacterArc`、`NovelCharacterHistory` |
| 情节装置 | `NovelConflict`、`NovelForeshadow`、`NovelClue`、`NovelHook`、`NovelInformationLayer` |
| 世界观 | `NovelWorldRule`、`NovelWorldElement`、`NovelFaction`、`NovelLocation`、`NovelItem` |
| 写作约束 | `NovelConstraint`、`NovelStyleGuide`、`NovelWritingStyleProfile`、`NovelAuthorIntent` |
| 图与布局 | `NovelEdge`、`NovelNodePosition` |
| 提示词与日志 | `NovelPromptTemplate`、`NovelAgentLog`、`NovelAgentLogSummary` |
| 账本与审校 | `NovelStoryEvent`（`:1928`）、`NovelChangeRecord`（`:1954`）、`NovelChapterReview`、`NovelMarker`、`NovelAnnotation` |

矩阵与详情面板覆盖 9 类可选中实体分组：角色 / 冲突 / 线索 / 伏笔 / 势力 / 地点 / 世界要素 / 信息差 / 物品。

### 1.2 字段语义陷阱（已确认）

**`conflict.participants` 存角色 ID 不存名字。** `matrix-model` 用 `characterNameById.get()` 反查，
后端 `chapter-finalizer` 用 `parseIdList` 处理。表单原来用手输文本，用户输的名字永远匹配不上 ID。

**`project.targetWords` 语义在迁移 076 中变过**（`novel-migrations.ts:1037`）：
全书目标字数 → **每章目标字数**。旧代码 `targetWords / 1000` 再夹到 `[2500,5000]`，新代码直接用，
未设置回落 3000。节奏系数在此基准上叠加。

**伏笔的「计划回收」≠「已回收」。** `recoverByChapter` 是意图，`recovered` 是事实。
把前者当后者会让后端判定伏笔已回收，**永久排除出后续编排**。
前端靠 `spanEndKind` 区分（`matrix-logic.ts:196-207`），并有专门测试 `foreshadow-fact-vs-intent.test.ts`
两侧各一份守着。`store-utils.ts:88-91` 记录了这个事故的原始现场。

### 1.3 edges：16 种关系

`NovelEdgeType` 共 **16 种**：`appearance` `relationship` `involvement` `foreshadow` `base`
`member` `hierarchy` `association` `mentor` `kinship` `rivalry` `alliance` `subordinate`
`trigger` `causality` `related`。`related` 是语义最宽的兜底。其余 15 种的端点约束**未确认**。

**边有三个来源，合并只拼接不去重**（`novel-relationship-graph.ts:216-233`）：

1. 落库 `novel_edges`（`GraphStore.listEdges`）
2. 运行时派生的 7 类（冲突→角色、势力→首领/盟友/敌对、地点→父/势力、世界要素→父，`:236-358`）
3. `novel_relationships` 表（`:377-392`）

去重只发生在 `findNeighbors`，按 `(source,target,edgeType)` 且**持久化边优先**（`:86-93`）；
`getAllGraphEdges`（`:171`）绕过去重直出。

**`auto: true` 的边只由迁移 074 写入**（`novel-migrations.ts:977-1016`）。运行时所有 `createEdge`
调用方都不传 `auto`，因此一律落 0。

> ⚠️ **本次会话我在 `edge-relation-field.tsx` 里写的注释有误**：它说 `auto:false` 是「区别于
> reverse-arrange 自动派生的边，后者在重新反推时可能被覆盖」。调研找不到 reverse-arrange 写
> edges 的路径。reverse-arrange 实际是「从已写正文反推实体到矩阵」的 SSE 流程
> （`creation-flow-routes.ts:812`），与 `ai-arrange` 共用 `generateAndArrange`，只有 source 语义不同。
> 那句注释应改掉。

---

## 2. 创作流水线

抽样：`novel-orchestrator.ts` 1995 行全读方法清单 + 关键段；`chapter-finalizer.ts` 1671 行读 110-310。

入口：`POST /projects/:projectId/chapters/:chapterNumber/create-flow`
（`routes/creation-flow-routes.ts:104`，SSE 长连接 + 章节互斥锁）
→ `NovelOrchestrator.createChapterWithFlow`（`:181`，只建 `AsyncLocalStorage` 上下文）
→ `createChapterWithFlowInContext`（`:201`）。

### 2.1 阶段表

| # | 阶段 | Agent | 产出 | 行号 |
|---|---|---|---|---|
| 0 | 文风基线检查 | — | `style_baseline_warning`（不阻断） | `:215-226` |
| 0.5 | 节奏建议 | —（`RhythmController`） | `RhythmSuggestion` | `:228-267` |
| 1 | Director 规划 | director (0.5) | `NarrativeTask`（工具提交，非正则解析） | `:269-376` |
| 1.5 | **检查点 `narrative_task`** | — | approve/revise/rewrite/reject | `:299-376` |
| 1.6 | 补高潮目标/悬念时长默认值 | — | 就地改写 `directorTask` | `:387-401` |
| 1.7 | 章尾钩子落库 | — | `createHook`/`updateHook` | `:429-464` |
| 2 | Writer 创作（循环） | writer (0.9, maxToolCalls 2) | 正文 | `:466-771` |
| 2.1 | Writer 推回检测 | — | **检查点 `writer_pushback`** | `:524-616` |
| 2.2 | PostWriteGuard | — | **检查点 `post_write_guard`** | `:620-692` |
| 2.3 | 候选打分与回退 | — | **检查点 `guard_degraded`** | `:623-767` |
| 3.0 | 确定性清理 + 扫描 | — | cliche / prose-quality 报告 | `:777-792` |
| 3.1 | 盲审文字编辑 | reviewer 复用（`identity_only`） | 读感意见 | `:793-808` |
| 3.2 | Reviewer 验收 | reviewer (0.3) | 十维评分 + verdict + issues | `:819-825` |
| 3.3 | 验收报告落库 | — | `saveReview`（失败不阻断） | `:844-875` |
| 4 | **检查点 `review`** | — | approve/revise/rewrite | `:877-907` |
| 4.1 | Reviser 修订 | reviser (0.7) | 工具精确替换；无成功 patch 则保留原文 | `:909-999` |
| 4.2 | rewrite 分支 | — | 递归整章 | `:1000-1007` |
| 5 | 落库收尾 | memory (0.2) | `ChapterFinalizer.finalize` | `:1010-1036` |

「入库」= `status: 'review'`，**不是** published。发布走 `NovelEngine.publishChapter`（`novel-engine.ts:537`）。

### 2.2 Agent 定义（`novel-agents.ts:45-146`）

| type | id | temp | 静态工具 | 动态注入工具 |
|---|---|---|---|---|
| director | `novel-director` | 0.5 | `novel_ask_story` | `novel_submit_narrative_task` |
| writer | `novel-writer` | 0.9 | `novel_ask_story` | — |
| reviser | `novel-reviser` | 0.7 | `novel_ask_story` | `novel_apply_revision` |
| reviewer | `novel-reviewer` | 0.3 | `novel_ask_story` | `novel_submit_review` |
| memory | `novel-memory` | 0.2 | 18 个写工具 | — |

**配置里只有 temperature，模型来自 `subagentManager.getAgent(config.id)?.model`**
（`novel-orchestrator.ts:1549-1550`）。`extraTools` 不进白名单，因为它们通过闭包持有 draft（`:1501-1511`）。

第 6 个「隐形 agent」：盲审文字编辑 = reviewer + `buildProseEditorIdentity` + `contextMode:'identity_only'`。

### 2.3 检查点（6 种）

全部通过 `options.onCheckpoint`，实现是**跨请求**的：
`confirmationManager.requestDecision(..., 0)`（**timeoutMs=0 永不超时**，`creation-flow-routes.ts:199-205`），
`pending.id` 作为 `checkpointId` 随 SSE 下发，用户点按钮走另一条 HTTP
`POST /projects/:projectId/checkpoint/:checkpointId/decision`（`:284`）。
该端点**先 `setUserMessages` 再 `respondDecision`**，注释明确「避免 Agent 抢先读到空消息」。

SSE 只有三个语义事件名：`novel:progress` / `novel:checkpoint` / `novel:result`
（`utils/sse-emitter.ts:35-58`）。LLM token 流走标准 `TEXT_MESSAGE_*`。

### 2.4 PostWriteGuard

判定结构 `{ shouldRewrite, reason, details?, advisory? }`（`:95-101`）。
`advisory` 的注释：「非致命偏差：不重写整章，交给 Reviewer 做语义和质量判断」。

四个维度按顺序 early-return（`:1060-1192`）：

1. **只写了计划没写正文**：`wordCount < 500` 且命中 `/先核对|按章纲|输出正文|.../`
2. **模型退化**：复用 `scanCliches`，只取 4 个 high pattern（`model_repetition` / `model_refusal` / `engineering_leak` / `engineering_words_cn`）
3. **字数**：`<75%` / `>130%` → rewrite；`75-85%` / `115-130%` → advisory
4. **矩阵实体**：角色姓名逐字缺失 → rewrite；势力/地点全名缺失 → advisory（可能用简称）；冲突/伏笔不查

失败处理链：上限 `MAX_GUARD_REWRITE = 2`。每次重写走 `buildWriterRewritePlan`
（`writer-rewrite-plan.ts:156`）分 `full` / `targeted` 两种策略 —— 退化类走 full 且**不带上一稿**，
注释说明理由：「把退化输出当上一稿喂回去，模型会顺着那段垃圾继续复读，比全量重写更糟」（`:22-24`）。
每轮 `scoreWriterCandidate` 打分，达上限后回滚最佳候选并**重跑一次 Guard**，然后弹 `guard_degraded`。

---

## 3. 提示词系统

抽样：`prompt-builder.ts` 3628 行，读文件头设计注释、全部方法签名、480-1170 / 1302-1481 / 3234-3373 / 3468-3627。

### 3.1 三层结构与 cache 策略

文件头 `:1-66` 是完整设计说明，五条原则：静态在前动态在后；系统提示词只含静态数据；
章节上下文放首条用户消息；工具结果只追加末尾；状态更新只影响下一章。

| 层 | 内容 | 方法 |
|---|---|---|
| STATIC（system） | 故事简介、全书大纲、卷纲、世界规则(≤40)、风格指南(≤20)。**`void agentType` —— 跨 Agent 逐字相同** | `buildSystemPrompt:623` |
| SEMI-shared | 13 个 section：章节信息 / 创作约束 / 出场要素 / 账本承接 / 实体关联 / 信息差 / 最近 5 章摘要 / 上一章结尾 / 声音锚点 / 下一章锚点 / 未兑现钩子 / 文风指纹 | `buildChapterContextShared:800` |
| SEMI-identity | Agent 身份 + 铁律 + 文风档案 | `buildAgentIdentity:727` |
| SEMI-suffix | Agent 专属：director→宏观节奏 + Reviewer 反馈回流；reviewer→Rubric + 矩阵验收；writer→chapter-instruction；**reviser/memory→空** | `buildChapterContextSuffix:1082` |

**刻意不放进 system prompt 的东西**（注释原文）：

- 角色定义 —— `:12-13`「角色数量可能很大（200+），全部塞会导致上下文爆炸」
- 势力/地点/世界要素 —— `:698-699`「不再整库塞入 STATIC 层，本章需要的实体由矩阵注入」
- **Agent 身份段** —— `:704-711`「provider 端的 cache_control breakpoint 打在 system 末尾，
  整个 system 是一个缓存块，只要末尾的 agent_type 不同，整个 system 块就 cache miss」

同章所有 Agent 共用 `promptCacheScope: novel:${projectId}:${chapterNumber}`
（`novel-orchestrator.ts:1592-1593`「否则各自被导到不同机器，前缀白建」）。

`cache-layer-diagnostics.ts` 是**为验证这套分层是否真的生效而写的**，其 `:11-18` 直言
「这套分层从未验证过是否真的生效」，并列了两个可疑信号：Writer 平均 cache_read 只有 6.1k
而 shared 段有 14.2k 字符；155 条日志 `cache_write_tokens` 全为 0。

预算集中在 `core/prompt-budget.ts`，`:1-17` 说明动因：以前 40 多个裸字面量导致
「性格 120 字 < 此刻状态 160 字」这种失配；`PROMPT_BUDGET_INVARIANTS`（`:162`）用单测强制
「区分度字段预算 ≥ 状态字段」。

### 3.2 文风机制

`NovelWritingStyleProfile` → `compileWritingStylePrompt`（`writing-style-prompt-factory.ts:158`）
→ 拼在 identity 段末尾，**只给 writer / reviser / reviewer / prose_editor**，Director 与 Memory 不注入。

正/反样本处理里有几个值得注意的细节：

- **预算不对称**：正向 1200 字 / 反向 500 字。理由 `:92-98`「正向样本给足体积才能承载
  句式 + 观察距离 + 节奏。700 字太短：中文样本必然断在句中，模型学到的是断句而不是文风」
- 去水印乱码（`SAMPLE_NOISE_RUN` + `SAMPLE_RARE_CJK`，`:46-63`），注释举了真实例子
- 按段落/句末边界截断，注释：「旧实现直接 slice，结果样本末尾是孤零零一个左引号」
- 正向样本带免责：「只学习句式、观察距离、用词和节奏，不复用人物、情节或专有名词」
  「样本仅示范怎么写一句话，不示范段落密度」

并行机制是**文风指纹**（`prompt-builder.ts:3234-3339`）：从前 N 章正文自动量化句长/对话占比/
比喻密度等，进 shared 层。它有一道**降级门**（`FINGERPRINT_TRUST`）—— 这是历史 bug 的产物：
引号正则被编码转换吃成 ASCII，对话占比恒为 0% 还带「⚠️ 必须保持一致」，
**等价于命令 Writer 整章不写对话**（`:3258-3259`、`prompt-budget.ts:126-128`）。
`quality-policy.ts:186-191` 把「档案 vs 指纹」登记为显式冲突，仲裁结论：档案优先。

### 3.3 节奏控制

`suggestRhythm`（`rhythm-controller.ts:160`）五步：

1. 查节奏模型序列（`standard-three-act` 14 章 / `webnovel-fast` 14 章，`modelIndex = (章号-1) % 长度`）
2. 算 `arcPosition`
3. **连续高潮抑制**：最近 3 章 climax/twist ≥ 2 → 强制 breather
4. **故事状态修正**：`erupting` 冲突 → climax（强度按 intensity 分 major/medium）；
   `reversing` → twist；活跃冲突强度和 > 20 → rising；≥2 条伏笔临期 → rising
5. 生成给 LLM 的自然语言描述（9 种节奏各一段）

对字数的影响**有两处独立实现**：`computeChapterTargetWords`（climax ×1.3、breather/setup ×0.85）
与 `buildChapterConstraints` 的 `wordBudget`（同系数 + `ChapterPositioning` 倍率，`novel-engine.ts:252-284`）。

---

## 4. 质量控制链

| 检查器 | 调用位置 | 性质 | 阈值来源 |
|---|---|---|---|
`cliche-scanner` | ① Guard 内（只取 4 个 high 退化 pattern）② Reviewer 前（全量注入）③ Reviser 的「系统质量门」 | ① 阻塞 ② 建议 ③ 半阻塞 | 各 pattern 自带 `threshold` |
`prose-quality-evaluator` | Reviewer 前 + 盲审输入 + 群聊报告 | 建议式；`error` 级进 `autoReviseReason`，**但只在用户已选 revise 的分支生效** | `PROSE_SHAPE_LIMITS`（`quality-policy.ts:201`） |
`consistency-auditor` | **不在创作流程里**。`novel-services.ts:162-164` 明确其两个消费者「从未被调用，已随死代码一并删除」，只留 `GET /consistency-report` | 离线 | 类静态常量 |
`novel-similarity-scanner` | **不在章节流程里**，是实体去重工具（独立 SSE 端点 + 用户检查点 + `mergeWithPlan`） | 建议式，幂等 | LLM 判断 |

`quality-policy.ts` 提供了一整套仲裁机制：`GATE_REGISTRY`（9 个门）、`arbitrateQuality`、
`CONFLICT_RULES`（4 条显式冲突）、`QUALITY_POLICY_INVARIANTS`（6 条不变量）。
**但 `arbitrateQuality` 全仓库只被单测引用** —— 它是纸面契约，编排层实际仍是散落的 early-return。

---

## 5. 数据层

### 5.1 Store

`novel-store.ts` 是**纯转发 Facade**（`:1-17` 自述「原本 3457 行的上帝类」），分发到
`core/stores/` 下 9 个子 Store + 2 个 Service。`GraphStore` 先实例化并把 `deleteEdgesByEntity`
注入其他 Store。同时 `implements NovelPromptStores`（27 个读方法）。

snake_case 行类型集中在 `stores/row-types.ts`（448 行纯 interface），每个子 Store 有私有 `rowToXxx()`；
写侧 `camelToSnake` 在 `store-utils.ts:43`，但 `foreshadow-store.ts:229` 有一份**私有副本**。

**事务边界很稀疏**（仅 7 处），Facade 层没有事务 API，**跨表写（实体字段 + 账本）不在同一事务里**。
不是标准仓储模式 —— 子 Store 直接持 `better-sqlite3` 写裸 SQL。横切只有两个观察者：
`ChapterProjectionObserver`、`EntityDeletedObserver`。

### 5.2 记忆系统

`novel-memory-store.ts`（1516 行）管五类：`novel_memory_events`（**同一张表既作 `MemoryEvent`
读也作 `NovelChangeRecord` 读**）、`novel_memory_snapshots`、`novel_story_events` + entity refs、
`novel_annotations`、因果链。

粒度：变化记录按 `(章号, 实体, dimension, sceneOrder)` 一条；快照按章一条；story event 按场景聚合。

`novel-memory-generator.ts`（1685 行）是 Memory Agent 实现，`:1-21` 说明它用**单次结构化 LLM 调用
替代了原来的 18 工具循环**。

与提示词是**两条独立链**：
- 「最近 5 章摘要」来自 `novel_chapters.recap`，回退链 recap → content 前 300 字 → narrativeTask。
  **不经过 memory store。**
- 「账本承接」来自 `getChapterStoryContext`。Writer 侧与 Memory 侧**两个 formatter 故意不复用**
  （`memory-ledger-handoff.ts:22-27` 说明取舍相反）。

`memory-ledger-handoff.ts` 的动因写在 `:11-14`：Memory 原先「每章都在从零重新判断」，
导致 20.2k input 只产 1.8k output。

### 5.3 账本与投影

**写入时机**：① 任何实体章节投影变化 → `chapter-projection-recorder.ts:101`（观察者、幂等）
② 编排落库时 ③ 手工 CRUD ④ 存量回填。
**消费方**：提示词、Memory 承接段、`GET /matrix-aggregation`、`matrix-projection.projectFromLedger`。

`matrix-projection.ts` 里「投影」= **「某实体在第 N 章出场」这一事实**。它做两件事：
- **对账**：两个事实源各算成 `ProjectionSet`（实体字段 / 账本），diff 出四类差异，只读不裁决
- **读接口**：`buildArrangedEntitiesForChapter:382`，`DEFAULT_PROJECTION_SOURCE = 'entity-fields'`

前端 `matrix-model.ts` **仍自己算行/分组**，只有子轨道消费服务端聚合。
所以「本章有哪些实体出场」目前有**四份实现**：实体字段、账本、服务端 arranged-entities 端点、前端本地计算。

### 5.4 chapter-finalizer（`:138`）

按顺序：判定中间章重写（命中则**跳过全部全局状态写入**）→ 捕获前态 → 跑 Memory Agent →
前后态 diff 出记忆事件（含 4 条启发式连边）→ 同步章节维度 → 全量快照 →
**每 10 章 `runFullCalibration`** → 发 `data_changed` → `updateChapter(status:'review')` →
并行生成 3 个候选标题 + 前情提要 → 发 `completed`。

`runFullCalibration`：取最近 5 章各前 1500 字 + 全量实体状态，让 LLM 输出「遗漏的、
当前状态未反映的」变更。失败只记 log 不阻断。

### 5.5 数据库与 API

**64 个迁移**，`013_create_novel_projects` → `076_project_target_words_to_chapter_words`，全部 `IF NOT EXISTS` 幂等。
演进痕迹明显：035-038 加列、043 回填卷、053/072 补索引、
**074 用 `json_each` 把 7 类旧关联字段搬进 `novel_edges`**、**075 `DROP COLUMN` 删旧字段并加唯一索引**、
076 直接 `UPDATE` 改语义。

API 统一前缀 `/api/plugins/novel`。`routes/` 6 个文件：

| 文件 | 用途 |
|---|---|
`chapter-routes.ts` | 章节 CRUD、完成/发布、版本 diff/回滚、节奏建议 |
`character-routes.ts` | 角色 CRUD + AI 生成、出场历史、成长弧 |
`creation-flow-routes.ts`（57KB） | 全部 SSE 创作流程 + 运行时配置 |
`story-ledger-routes.ts` | 账本 CRUD + 矩阵聚合 + 投影读 |
`context-preview-routes.ts` | 提示词上下文预览 |
`arranged-entities-contract.ts` | 非路由，zod 契约共享 |

**`novel-routes.ts` 仍是 85KB 单体**，承载其余约 90 个端点。

---

## 6. 前端

### 6.1 布局（`novel-workspace.tsx`，1478 行）

- **专注模式短路**（`:820-841`）：只渲染编辑器 + 退出按钮
- **header**（`:843-945`）：三栏 grid，中间是布局模式切换，右侧 4 个弹框入口
- **正文区**（`:962-1125`）包在 `DndContext` 内：左侧栏 → main → 右 aside
- **主区单维度四选一**（不是 tab）：`text | text-timeline | timeline | graph`。
  `text-timeline` 用 `ResizableSplitter` 上下分屏。每分支各自包 `ErrorBoundary`
- **右栏三选一 tab**：`conversation | detail | audit`，另有相似度扫描态抢占
- **4 个 Dialog**：缓存监控、Agent 日志、文风编辑器、相似度合并

### 6.2 Store

| store | 职责 |
|---|---|
`novel-data-store.ts` | 20 个实体数组 + upsert/remove + 位置/边/标记，用 `zundo` 包 `persist` |
`novel-ui-store.ts` | 选中、画布模式、播放头、折叠分组、矩阵多选、高亮/路径查找 |
`novel-workspace-layout-store.ts` | 布局模式与面板尺寸 |

**撤销覆盖全部实体列表**，`currentProjectId` 刻意排除，切项目时手动 `clear()`。历史上限 50。

**数据加载是一次性全量**：`novel-workspace.tsx:261-321` 单个 `useQuery` 里 `Promise.all`
并发 16 个 list 接口，`refetchInterval: 300_000`，结果灌进 `loadProjectData`。
`mergeListById` 以后端为权威**直接替换**本地列表。

### 6.3 矩阵（`matrix/`）

- **列** = 章节号；**行** = `MatrixEntity`；**分组** = 9 类实体
- **双向虚拟化**：垂直靠 `buildRowSpecs` → `computeRowOffsets` → 二分查找 → 可见窗口（overscan 5）；
  水平靠 `lib/matrix-viewport.ts:23`（overscan 2）
- 分工：`matrix-workspace.tsx`（1571 行）= 容器 + 全部写操作；
  `matrix-view.tsx`（782 行）= 纯渲染 + 滚动/播放头/关系叠加；
  `matrix-row.tsx`（1091 行）= 行级组件与视觉编码
- **子轨道** = 展开实体后内联显示的逐维度历史轨道，数据来自 ChangeRecord 账本投影，
  无账本时回落快照

### 6.4 画布

`@xyflow/react` + `d3-force`。

`canvas/layout.ts` 的 `buildLayout`（`:96`）**不是通用图布局算法，而是按类型分区的硬编码坐标**：
角色左侧竖排、冲突贴其首个参与者、伏笔/地点/世界要素各占一条横排。
`force` 模式改由 `force-layout.ts` 跑 d3-force，已保存位置的节点锁定，**结果不落库**。

边两类：派生边（`data.auto=true`）+ 落库手动边，按 `source-target` 去重且手动优先；
同 target 超 3 条降权打包。连线合法性由 `isValidConnection` 白名单校验。
交互：拖动（防抖批量 upsert）、连线建边、边选中删除、类型过滤、邻居高亮、路径查找、MiniMap。
框选**未确认**。

### 6.5 侧栏、表单、创作流程 UI

`sidebar/project-tree.tsx` 层级：项目 → 大纲区（全书大纲 → 卷 → 章）→ 9 个可折叠实体集合，
实体项可拖入矩阵。`style-templates.ts` 是**新建项目的风格预设**（番茄爽文/起点精品/知乎短篇/自定义），
各带平台、节奏模型、目标字数、题材。

`detail-forms/` **14 个文件**：11 个实体表单 + `shared.tsx`（30KB，原语 + 约 25 个枚举选项表）
+ 本次新增的 `entity-picker.tsx` / `edge-relation-field.tsx`。
`detail-panel-edit-context.tsx` 只有 24 行，作用极窄：一个 `(dirty)=>void` 回调的 Context，
供面板级离开守卫。保存契约本体在 `save-contract.ts`：三类 `autosave / explicit / immediate`。

`hooks/use-novel-creation-flow.ts`（1423 行）解析 ag-ui 事件：`TEXT_MESSAGE_*` 累积 Agent 输出
（delta 进缓冲、rAF 批量 flush），`CUSTOM` 下三个语义事件。
`novel-conversation-panel.tsx` 把状态映射为 `ConversationMessage[]` 交给共享 `ConversationStream`。
**检查点没有弹框**，是流内 `role:'checkpoint'` 卡片。5 个流程 tab：工作流 / 群聊·高级 / 反推 / 矩阵编排 / 聊天。

### 6.6 其它面板

| 面板 | 职责 |
|---|---|
`agent-log-panel` | Agent 调用日志 + 展开看 STATIC/SEMI/DYNAMIC 三层提示词与结果 |
`consistency-audit-panel` | 跨章一致性报告：健康分环 + 伏笔回收率/钩子悬挂/孤儿实体/时间线矛盾 |
`chapter-version-panel` | 正文版本历史、Diff、回滚、手动快照 |
`cache-monitor-panel` | 三层哈希稳定性即缓存命中诊断 |
`chapter-content-editor` | Tiptap Markdown 编辑器，播放头单向驱动，1.5s 防抖存，创作中只读 |
`writing-style-profile-editor` | 文风档案编辑，规则以 Markdown 列表双向序列化 |

---

## 7. 群聊 / 讨论模式

`NovelDiscussionRunner`（`novel-discussion-runner.ts:44`）只做「翻译」，循环逻辑在
`TeamDiscussionEngine`（`core/agent/team-discussion-engine.ts:68`），决策在 `Moderator`，
消息总线是 `AgentChannel`。

四阶段：`planning`（Moderator 循环到收敛，解析场景 + 动态补角色）→ `scene_setup`/`acting`
（角色**只推演对戏，不即时编织** —— 注释说明这是为了让 Writer 只触发 1 次避免风格割裂）→
`chapter_weaving`（一次性交给 writer/reviser 编织，8 条要求写死在 prompt）→
`reviewing`（盲审 → Reviewer → 检查点 → 条件性 Reviser）。

死锁防护：`MAX_ROUNDS 20` / `MAX_ROUNDS_PER_SCENE 10` / `MAX_OBSERVE_ROUNDS 3`。

**它与工作流是用户显式选择的两个平行入口**（`/create-flow` vs `/create-discussion`，共用章节锁），
代码里没有自动切换。群聊有断点续跑（`resumeChapterWeaving`，从持久化 transcript 从 Writer 继续），
单 agent 流程没有。

群聊自带一套**独立实现的** PostWriteGuard（`team-discussion-engine.ts:866-954`），
刻意不依赖 novel-plugin 的 cliche-scanner 以「保持引擎通用」。

---

## 8. 测试覆盖

**后端 18 个**（`novel-plugin/__tests__/`）。分两族：

- **账本/投影族**（S4 系列）：`matrix-projection`（对账准确性）、`chapter-projection-recorder`
  （任何改实体章节字段的路径都必须留账本痕）、`ledger-backfill`（回填幂等）、
  `ledger-cleanup`（删实体级联清理）、`projection-read-switch`（两种 source 读切换）
- **提示词族**：`golden-prompt.snapshot` / `golden-arrange.snapshot`（字节级快照）、
  `arranged-entities-contract`（HTTP→zod→映射→prompt 全链不丢字段）、`prompt-budget`、
  `prompt-style-and-character-detail`
- 其他：`foreshadow-plan-vs-fact`、`chapter-renumber`、`quality-policy`、`cliche-scanner`、三组路由测试

**前端 12 个**：`novel-undo`（撤销边界与切项目清栈）、`save-contract`、`chapter-task`、
`chapter-content-editor`、`outline-tree`、`creation-active-notice`、`writing-style-profile-editor`；
矩阵侧 `matrix-logic`（28.9KB）、`entity-interaction-spec`（九类实体 switch 必须全覆盖，防默认漏项）、
`foreshadow-fact-vs-intent`、`matrix-horizontal-virtualization`、`coordinate-menu`。

---

## 9. 问题清单

### P0 —— 守卫失效或数据可丢

1. **golden prompt 快照是失效的守卫。** `.gitignore:40` 忽略 `*.snap`，
   `golden-prompt.snapshot.test.ts` 在新克隆上首跑必过 —— 它防不住提示词漂移，
   而这是它存在的唯一理由。对这个项目影响最大，因为提示词就是核心资产。
2. **迁移 074→075 的顺序耦合不可逆。** `novel-migrations.ts:1019-1020` 注明「必须在 074
   搬运完成后执行，否则旧字段数据会丢失」。074 幂等，**075 是 `DROP COLUMN`，不幂等不可逆**。
   074 部分失败而 075 照跑 = 数据无从恢复。
3. **075 加了唯一索引，写入路径仍是裸 `INSERT`。** `graph-store.ts:162` 无 `OR IGNORE`，
   `novel-routes.ts:692-702` 成批调用且无 try —— 重复连线会抛 `SQLITE_CONSTRAINT`。
   是否被上层统一捕获**未确认**。
4. **章节正文被排除出前端持久化。** `novel-data-store.ts:461-466`：写入会抛 `QuotaExceededError`，
   「zustand persist 捕获后静默失败，于是**整个 store 的持久化全部失效**」。副作用：离线打不开正文。
5. **全量替换 + 后台 refetch 会擦除刚建的本地实体**，靠每处手动 `invalidateQueries` 兜。
   `outline-tree.tsx:102` 有专门注释。**任何漏掉 invalidate 的新建路径都会在 5 分钟内被静默回滚。**

### P1 —— 契约与实现脱节

6. **`quality-policy.ts` 是纸面法律没有执法者。** `arbitrateQuality` / `GATE_REGISTRY` /
   `CONFLICT_RULES` 全仓库只被单测引用。`WORD_COUNT_LIMITS` 定义了阈值，
   而 `runPostWriteGuard`（`novel-orchestrator.ts:1123-1145`）写的是**裸字面量**。
   改阈值时改错一边，单测全绿。
7. **`run.directorOutput` 写而不读，注释描述的是已不存在的机制。** 3 处写入、0 处读取。
   实际填 `{{narrative_task}}` 的是 `directorTask.description`。
   即 **Director 的完整推理从未进入 Writer 提示词**，`secondaryTasks` / `positioning`
   等结构化字段只出现在前端气泡，Writer 看不到。
8. **`formatConstraints` 的 POV / 场景数 / 时间线三段是死代码。**
   `prompt-builder.ts:1419-1454` 读这三个字段，但 `buildChapterConstraints` 的返回对象根本不含它们。
   Director 通过工具提交的这三项永远不会变成 Writer 的硬约束。
9. **`chapter_budget` 检查点的 revise 选项是空操作。** 前端按钮写「尽快收尾：跳过可选环节」，
   后端只对 `reject` 抛错，其余一律继续 —— 点「尽快收尾」和点「继续创作」效果完全一样。
10. **破折号铁律没有任何强制路径。** `em_dash_abuse` 是 high/threshold=1，
    但 Guard 只筛 4 个 pattern、`autoReviseHits` 5 个 pattern 都不含它、
    `stripEmDash` 只清洗注入侧不动 LLM 输出。破折号只会出现在 Reviewer 报告里，落库正文可自由存在。
11. **保存行为四套并存。** `save-contract.ts:15-17` 自承：「不是『不统一』这么轻，
    是**用户无法预测自己的编辑会不会丢**」；该模块「不改任何组件的保存时机」，只统一文案，根因仍在。

### P2 —— 结构性重复与漂移

12. **双事实源承认未修。** `matrix-projection.ts:17`「手工编辑实体字段不产生账本记录
    （未修，属结构问题）」；`:364-366` 对账把一致率从 38.6% 提到 91%，
    「但『账本有、实体字段无』仍有 12 条反向漂移需要人工判断」。
    而默认源仍是 `entity-fields`，前端还自算一份 —— **「本章有哪些实体出场」共四份实现**。
13. **账本引用是无外键的多态引用。** `novel-store.ts:108-110`：「删除实体不会级联清理。
    真实项目因此积累了 11 条悬空引用」。补救靠观察者 + 脚本，而非 schema 约束。
14. **群聊与工作流的 Guard 是两份独立实现**，阈值靠注释互相对齐，无共享单测钉住。
15. **字数口径三套并存**：Guard 用去空白字符数，落库 `wordCount` 含空白，
    `completeChapter` 又是另一个 —— **前端展示的字数和 Guard 判定的不是同一个数**。
16. **`camelToSnake` 有两份**（`store-utils.ts:43` + `foreshadow-store.ts:229` 私有副本）。
17. **用户检查点意见可能被错误的 Agent 吃掉。** `pendingUserMessages` 按章存，
    任何后续 `runAgent` 都会消费并清空。在 `post_write_guard` 选 revise 并附意见，
    下一个跑的是 Reviewer 而非 Reviser —— 给 Reviser 的意见会被 Reviewer 消费。
    （作者已意识到部分风险：盲审那步显式传 `consumeUserMessages: false`。）
18. **重写次数的总闸门是漏的。** `MAX_GUARD_REWRITE=2` 只管 Guard 触发的原地重写。
    用户在 `review` / `guard_degraded` 选 rewrite 会递归且**不传 `guardRewriteCount`**，
    计数归零。真正的兜底只剩 `chapter_budget`。
19. **`buildSystemPrompt` 里留了两段互相矛盾的注释**（`:612-616` vs `:698-699`），
    代码行为是后者，读代码的人会先看到过期那段。
20. **`prompt-builder.ts` 3628 行 / `novel-routes.ts` 85KB / `novel-workspace.tsx` 1478 行**
    三个单体文件。

### P3 —— 观察与体验

21. **shared 缓存在 Director 时刻定型**，Writer 拿到的是「过期约束」：
    首次构建发生在 Director 调用时，此时 `directorTask` 还不存在。
    字数因为在 suffix 实时算所以没问题，但从 constraints 派生又落在 shared 段的内容
    （冲突推进目标、悬念钩子）都是 Director 时刻的快照。**这个取舍没有注释说明**，
    看起来是缓存策略的副作用而非有意为之。
22. **Reviser 和 Memory 看不到 Director 方案**（suffix 对 reviser 明确返回空），
    「修订后是否仍满足叙事任务」无从判断。
23. **一个「永远为真」的检查等于没有检查。** `prose-quality-evaluator.ts:56-61` 记录了
    中文段落句子连写导致 `fragmented_paragraphs` 在真实项目 11 章**全部命中 error**、
    每章强制走一次 Reviser。已修，但值得作为同类问题的样板记住。
24. **文风档案的前后端不一致**：前端过滤 < 20 字符样本，后端只能靠 `console.warn` 提示样本为空。
25. **`characterFunctions` 无论切到哪个事实源都拿不到**（`matrix-projection.ts:379-380`：
    不落库、无法派生，仍由编排结果缓存单独提供）—— 缓存失效即静默丢失。
26. **力导向布局位置故意不落库**（`force-layout.ts:13-14`），用户在 force 模式下的手工调整刷新即丢。
27. **若 `project` 不存在，Guard 的字数检查整段跳过**，退化为只查退化 + 矩阵角色。
28. **token 用量依赖 `sessionId` 才能回填**，缺失时 `inputTokens` 计 0，成本闸门在这些调用上失效。
    `cache-layer-diagnostics.ts:15` 记录的「155 条日志 cache_write 全为 0」说明采集本身不可靠。
29. **若干 cliche 正则易误报**：`meta_narration` 匹配「故事」「文字」这类常用词且 threshold=2；
    `genericSimile` 会匹配任何以「像」开头的片段。只进报告不阻塞，但稀释信噪比。

---

## 10. 值得学习的地方

这个模块有不少注释把**取舍的理由**写下来了，比多数代码库做得好。几个样板：

- **网络重试与质量重写分账**（`novel-orchestrator.ts:1216-1218`）：
  「那个配额限制的是『正文质量不合格所以重写』，与『网关 502』是两件事；
  混用会让几次网络抖动吃掉本该留给质量问题的重写次数。」
- **成本超限推检查点而不硬停**（`chapter-budget.ts:24-27`）：
  「硬停会把已经花掉的 100 万 token 全部作废，比超支更糟 —— 用户往往宁愿再花一点把这一章写完。」
- **不给 Director query 工具**（`novel-agents.ts:60-63`）：给了反而会让它规划前重复查询，
  每次工具调用重发完整历史，「3 次工具调用 = 3 倍 token」，移除后省约 18K。
- **质量门冲突是取舍不是 bug**（`quality-policy.ts:160-164`）：
  「写下来才不会在下次调阈值时被无意破坏。」
- **`llm-error-policy.ts` 的分类基于实测**：11 章 272 条日志，Director 102 次调用失败 29 次（28%），
  退避间隔 `[1s,4s,12s]` 的理由是「Director 单次调用平均 53s，退避到 12s 相对调用本身仍然便宜」。

---

## 11. 本次会话对小说模块的实际改动（未提交）

**新增**
- `detail-forms/entity-picker.tsx` —— 搜索 + 多选实体选择器，值恒为 ID、显示恒为名字，失效引用显式标出
- `detail-forms/edge-relation-field.tsx` —— 把 edges 增删封装成多选字段，即时生效
  （⚠️ 内含一条关于 reverse-arrange 的错误注释，见 §1.3）

**修改**
- `conflict-form.tsx` —— participants 从手输文本改为从角色库选择（修真实功能缺陷）
- `character-form.tsx` / `foreshadow-form.tsx` / `info-layer-form.tsx` —— 恢复被删掉的关联分区
- `novel-detail-panel.tsx:374` / `detail-overview.tsx:285` —— 修可选链只护一层导致的面板白屏
- `__tests__/creation-active-notice.test.tsx` —— 适配 overview/edit 双模式；改用 `findByTestId` 消除 flaky
- `golden-prompt.snapshot.test.ts.snap` —— 随 targetWords 语义变更更新（该文件被 gitignore）

> 工作区里还有一批**不是我改的** novel 侧改动在会话中途出现
> （`novel-engine.ts`、`prompt-builder.ts`、`novel-migrations.ts`、`packages/shared/src/novel/index.ts`、
> `detail-overview.tsx`、`detail-panel-edit-context.tsx`、`novel-sidebar.tsx`、`novel-data-store.ts` 等）。
> §1.2 的 targetWords 与 §1.3 的 edges 迁移与这批改动有交叉。
