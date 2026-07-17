# 创作逻辑审查：当前实现与核心系统设计对照

- 审查日期：2026-07-16
- 修订日期：2026-07-17
- 设计基准：`docs/ai_novel_creation_workbench_core_systems.md`
- 审查范围：桌面端、create-flow、create-discussion、ai-arrange、reverse-arrange、章节收尾与记忆
- 结论基准：当前工作区源码与回归测试，不沿用旧行号或旧实现推断

## 1. 结论摘要

当前实现已经形成“编排 → 规划 → 写作 → 验收 → 修订 → 记忆”的主闭环，但不能据此给出“整体符合度 85%”之类的精确百分比。原审查没有定义评分公式，而且多项事实判断与源码相反。

create-flow 的主流程完整，历史章节重写也有快照和状态写入保护。本轮已修复矩阵实体白名单、线索编排、角色认知输出和十维审稿持久化；剩余问题主要是 P2 领域模型增强。

create-discussion 并非缺少质量门和 Reviewer 检查点。它已经具备独立 PostWriteGuard、一次 Writer 重写、完整章节 Reviewer、用户决策和可选 Reviser。本轮已将严重字数阈值和实体匹配策略与 create-flow 对齐，并在重写退化时保留原正文。

作者意图系统已有类型、数据库表和创建方法，但没有读取接口、提示词注入和创作流程接入。应称为“数据骨架已存在，工作流未接通”，而不是“完全未实现”。

## 2. 四条真实入口

| 模式 | 前端任务 | 后端接口 | 核心执行器 | 产出 |
|---|---|---|---|---|
| 编排创作 | `workflow` | `POST /projects/:projectId/chapters/:chapterNumber/create-flow` | `NovelOrchestrator` | 正文、审稿、状态、标题、提要 |
| 群聊共创 | `discussion` | `POST /projects/:projectId/chapters/:chapterNumber/create-discussion` | `NovelDiscussionRunner` + `TeamDiscussionEngine` | 正文、群聊记录、场景、状态、标题、提要 |
| AI 编排 | `arrange` | `POST /projects/:projectId/chapters/:chapterNumber/ai-arrange` | `NovelEntityGenerator` | 矩阵实体，不生成正文 |
| 正文反推 | `reverse` | `POST /projects/:projectId/chapters/:chapterNumber/reverse-arrange` | `NovelEntityGenerator` | 从正文提取并落库矩阵实体 |

AI 编排和正文反推共用 `generateAndArrange`，通过 `source='outline'` 与 `source='content'` 区分输入。AI 编排是独立任务；create-flow 在没有编排实体时不会自动先运行 AI 编排。

create-flow 与 create-discussion 共用章节创作锁。AI 编排与反推共用编排锁，并与正文创作互斥。群聊恢复只支持 `chapter_weaving` 阶段。

## 3. create-flow 实际流程

```text
读取章节与项目状态
→ RhythmController 生成节奏建议
→ Director 规划叙事任务
→ 叙事任务检查点
→ Writer 生成正文，必要时显式推回 Director
→ PostWriteGuard 确定性预检
→ Reviewer 验收
→ 验收检查点
→ 可选 Reviser 或整章重新规划
→ ChapterFinalizer
→ Memory、实体维度同步、快照、持久化、标题和提要
```

Director 输出由 `parseDirectorTask` 解析为 `NarrativeTask`。解析失败时任务类型回退到 `advance_mainline`，但这只是字段级 fallback，不能验证整份叙事方案是否具有足够质量。

14 种 `NarrativeTaskType` 会影响 Writer 收到的 Director 方案和条件写法理论，但 `buildChapterConstraints` 不接收任务类型。冲突目标、伏笔节点和节奏约束主要由数据库状态、章节号、节奏建议和章节定位计算。

叙事任务检查点对 `reject` 有取消分支，`revise` 与 `rewrite` 都会携带用户意见重新调用 Director。

PostWriteGuard 当前只把模型退化、极短元说明、低于 75% 或高于 130% 的字数失控、矩阵角色姓名缺失视为自动重写条件。轻微字数偏差以及势力、地点的全名缺失交给 Reviewer 做语义判断。

历史章节重写会读取第 N-1 章全量快照，并注入下一章开头锚点。Finalizer 检测到后续已有正文时，会跳过 Memory 状态写入、实体维度同步和新快照，避免未来状态被历史正文覆盖。

## 4. create-discussion 实际流程

```text
构建默认任务、章节约束和 sharedContext
→ Moderator 调度 Director 拆分场景
→ 角色 Agent 分场景推演
→ Writer 编织完整章节
→ Discussion PostWriteGuard，最多重写一次
→ Reviewer 验收完整章节
→ 用户 approve / revise / reject
→ 可选 Reviser
→ ChapterFinalizer
```

群聊的 Agent 调用是 Moderator 驱动的多轮顺序协作，不应描述成同时并行调用。工种成员包括 Director、Writer、Reviewer、Reviser，Memory 在 Finalizer 阶段执行。

群聊使用 `buildDefaultNarrativeTask` 作为 sharedContext 的初始任务，固定类型为 `advance_mainline`。Director 会在讨论阶段拆分场景，但不会像 create-flow 一样产出并解析完整的 14 类结构化 `NarrativeTask`。

群聊 `goal.constraints` 只摘要 facts 和 cognitive，但 sharedContext 已包含完整 `formatConstraints`。因此不能据此断言 stage、债务、弧光、冲突和伏笔约束没有注入。

群聊已有独立 PostWriteGuard 和 Reviewer 检查点。Guard 现在仅在低于目标 75% 或高于 130% 时因字数自动重写，只对矩阵角色做确定性姓名检查；势力、地点、冲突和伏笔交给 Reviewer 语义验收。

## 5. 矩阵编排与提示词

前端 `collectArrangedEntities` 当前收集角色、冲突、伏笔、线索、势力和地点。角色按历史跨度，冲突、线索和势力按 `chapterSpans`，伏笔按离散 beats，地点按 `appearChapters`。

`ArrangedEntity` 与请求 schema 已增加向后兼容的 `clueIds`。create-flow、create-discussion、AI/反推编排、sharedContext、Memory Generator 和 Finalizer 均已接通线索。

编排实体、规则约束、故事状态、信息差、前后章锚点、未兑现钩子和因果链位于跨 Agent 共用的 sharedContext。Writer suffix 主要包含创作指令和 Director 方案；Reviewer suffix 主要包含平台 Rubric 和 Director 方案。

“实体执行严格按矩阵筛选”现在覆盖角色弧光、冲突目标、伏笔债务与钩子、信息差和紧急回收提醒；未传矩阵时保留旧项目的全量兜底。信息差只因选中伏笔、伏笔反向关联或选中角色的认知记录进入上下文。

矩阵应控制本章实际执行内容，但不能完全切断世界规则、固定事实、前后章钩子和历史连续性。修复目标是“实体执行严格按矩阵，世界与连续性约束始终保留”。

## 6. 创作约束系统

`NovelConstraint` 支持 fact、cognitive、stage、debt、arc 五种类型，但 `buildChapterConstraints` 只直接映射 fact、cognitive、stage。叙事债务和角色弧光由伏笔与角色实体另外生成，显式 debt/arc 规则没有直接映射。

事实约束缺少“固定事实、阶段事实、待定事实”三态字段。现有 `scope` 表示作用范围，不等于事实确定性。

角色弧光采用 `introduction → development → struggle → transformation → resolution` 的线性下一阶段提示。它能提供基础防跳档提醒，但不是完整的心理阶段状态机。

角色缺少结构化的恐惧、误解和底线字段。关系有阶段历史，但 Writer 是否遵守仍主要依赖提示词和 Reviewer，不是代码层状态机。

冲突支持 linear、mutation、stagnation、regression、reversal 五种推进模式，但 `ConflictStage` 没有独立的 `temporary_resolved` 状态。

## 7. 信息差与认知边界

`NovelInformationLayer.characterKnowledge` 存储 `knows/suspects/misunderstands`，`formatInfoLayers` 已按角色名输出知道、怀疑和误解状态；非法旧 JSON 会被忽略而不阻断创作。

`formatArrangedEntities` 输出角色设定、秘密、目标、压力和弧光，但角色实体本身不包含信息层的 `characterKnowledge`。因此原审查所称“编排角色完整定义中隐含认知边界”不成立。

Writer 和 Reviewer 现在能同时看到信息描述、读者状态、揭露阶段、关联伏笔以及明确的角色认知边界。

## 8. 伏笔、线索、冲突和钩子

伏笔拥有 planned、planted、reinforced、partially_revealed、recovering、recovered、abandoned 七状态，并用 plant、reinforce、reveal、payoff 离散 beats 表达真实节点。

线索由 `NovelClue` 记录进度、当前步骤、下一步、误导属性和章节跨度。它已进入 `ArrangedEntity`、提示词矩阵、Memory Generator、`clue_change` 事件和章节跨度同步。

冲突目标由章节跨度、高潮章、推进模式和节奏建议计算；传入矩阵时只处理选中冲突，未传矩阵时保留原有兜底。

上一章和更早的未兑现钩子会进入 sharedContext。本章钩子由 Director 检查点通过后创建；同轮无法命中的“本章规划钩子”共享段已移除，Writer 从已批准的 Director 完整方案获取钩子要求。

## 9. Reviewer 与章节验收

`NovelChapterReview` 数据结构包含十个评分字段。Reviewer 现在固定输出十维评分，create-flow 和 create-discussion 都会容错解析并通过 `NovelEngine.saveReview` 持久化；解析或保存失败不会阻断正文流程。

Reviewer 提示词会检查矩阵、任务、连续性、信息差、节奏、读者体验、钩子、对话和 AI 腔，结构化 Markdown 报告已接入 `NovelChapterReview` 数据闭环。

已确认的修复方向是：Reviewer 输出固定十维评分字段；代码容错解析；保存评分、结论、问题和建议；解析失败不能阻断正文流程。

## 10. 记忆与历史重写

当前记忆实现采用工作记忆、情景记忆、语义记忆三层工程架构。它与设计文档列出的八类可见性和作用域并非一一对应，尤其缺少作者规划、废弃设定和角色个人可见性的独立边界。

Memory Generator 可以更新角色、冲突、伏笔、线索、势力、地点、关系和信息差。ChapterFinalizer 会记录多数实体变化事件并保存全量快照。

线索创建和关键推进已进入 `MemoryEventType`，并以 `clue_change` 记录到统一事件链；Finalizer 同时补齐线索的章节跨度。

每 10 章运行一次最近 5 章全量校准。历史章节重写不会自动重算后续状态，而是保护现有未来状态；若要让重写影响后续章节，需要从该章起显式重建。

## 11. Agent 职责边界

create-flow 使用 Director、Writer、Reviewer、Reviser、Memory 五类 Agent。设计文档列出的 Setting、Character、Clue 是推荐的概念职责，不是必须存在八个物理 Agent；设计文档也明确“关键不是 Agent 数量，而是职责边界”。

当前职责总体分离，但信息传递并非全部是强类型数据。Director 和 Reviewer 的主要产物仍是 Markdown 文本，`parseDirectorTask` 只提取部分字段。

Writer 提示词包含输出前自检和 `[DIRECTOR_PUSHBACK]`，因此不能表述为“完全不检查规则”。更准确的说法是 Writer 不负责最终验收，但必须执行硬约束并在不可执行时推回。

## 12. 作者意图系统

当前已有：

- `NovelAuthorIntent` 类型。
- `novel_author_intents` 数据表。
- `createAuthorIntent` 写入方法。

当前缺少：

- list/get/update/delete 数据访问。
- HTTP 接口和前端编辑入口。
- Director、Writer、Reviewer 提示词注入。
- Memory 对作者意图的保护策略。

作者意图属于核心系统设计文档第四阶段能力。它值得建设，但不能仅根据设计文档把它定为当前 P0，更不能在没有范围设计时与创作主链修复混在一个小补丁中。

## 13. 已确认修复优先级

### P0：创作主链正确性（本轮完成）

1. `ArrangedEntity` 增加线索，并贯通前端、路由、sharedContext 和 Finalizer。
2. 实体执行约束严格按矩阵筛选，保留世界规则和连续性约束。
3. 输出 `characterKnowledge`，让 Writer 和 Reviewer真正知道角色认知边界。
4. 修复 Director 检查点的 `revise` 分支。
5. 对齐 create-flow 与 create-discussion 的 Guard 策略。

### P1：验收与可追溯性（本轮完成）

6. 接通十维 Reviewer 解析与持久化。
7. 线索变化进入 MemoryEvent 和因果链。
8. 移除或调整同轮无法命中的“本章规划钩子” shared 缓存段。

### P2：领域模型增强

9. 事实约束三态。
10. 角色恐惧、误解、底线。
11. 冲突暂时解决状态。
12. 作者意图完整 CRUD、UI 与 Agent 接入。

P2 涉及迁移、交互和领域语义选择，应单独设计和验收，不应被描述成已有主链代码中的简单 bug。

## 14. 验证基线

修复完成后已运行以下相关测试，共 65 项通过：

- `team-discussion-engine.test.ts`
- `chapter-finalizer.test.ts`
- `novel-orchestrator-run-context.test.ts`
- `arranged-entities.test.ts`
- `novel-constraint-relevance.test.ts`
- `chapter-review-parser.test.ts`
- `novel-agent-identity-budget.test.ts`
- `novel-entity-generator-batch.test.ts`

新增覆盖包括线索编排与跨度、矩阵严格过滤、认知边界格式化、Director revise、群聊 Guard 对齐与退化保护、审稿报告解析。

进一步修复审查过程中暴露的既有问题后，完整验证结果如下：

- 后端：74 个测试文件、849 项测试全部通过。
- 桌面端：15 个测试文件、137 项测试全部通过。
- `desktop typecheck:web` 通过。
- `desktop typecheck:node` 通过。
- `agent-server build` 通过。

同步修复了节奏模型旧断言、软删除项目仍可读取、显式删除伏笔回收拍点后被旧标量字段恢复、Pi Session 测试缺少 `settingsManager`、桌面端类型错误、项目切换后撤销栈残留，以及记忆摘要缺字段导致对话工作台崩溃等问题。大纲树和 App 测试也已按当前 React Query 上下文与“首页 → 功能页”导航路径更新。
