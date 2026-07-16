# 核心系统对照审查：pi-agent vs 设计文档

- **审查日期**：2026-07-16
- **设计文档**：[ai_novel_creation_workbench_core_systems.md](file:///d:/WebWork/AI/pi-agent/docs/ai_novel_creation_workbench_core_systems.md)
- **实现代码**：`apps/agent-server/src/plugins/novel-plugin/` + `packages/shared/src/novel/index.ts`
- **审查目的**：对照设计文档 15+1 个核心系统，评估当前 pi-agent 的实现符合度

---

## 总体结论

**大体符合，但存在 6 个部分实现 + 1 个基本未实现。**

| 状态 | 数量 | 系统 |
|------|------|------|
| ✅ 完整实现 | 9 | 故事状态、叙事任务、信息差、伏笔与回收、线索推进、节奏控制、世界规则、章节验收、风格与文体 |
| 🟡 部分实现 | 6 | 创作约束、角色弧光、冲突升级、读者体验、长期记忆分层、多 Agent 协作 |
| 🔴 基本未实现 | 1 | **作者意图系统** |

**符合度**：9/16 完整 + 6/16 部分 + 1/16 缺失 = **整体约 70%**

---

## 一、完整实现的系统（9 个）

### 1. 故事状态系统（文档第 4 节）✅

**实现位置**：
- [index.ts:901-914](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L901-L914)（`StoryState` 接口）
- [novel-store.ts:586-619](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts#L586-L619)（list 方法）
- [prompt-builder.ts:1260](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L1260)（`formatStoryState` 注入 SEMI 层）

**13 项动态状态对照**：

| 文档要求 | 实现字段 | 状态 |
|---|---|---|
| 角色当前状态 | `NovelCharacter.currentState/currentGoal/currentPressure/secret` | ✅ |
| 关系当前状态 | `NovelRelationship.currentStage/alignment/trend` | ✅ |
| 势力当前状态 | `NovelFaction.status/strength` | ✅ |
| 物品当前归属 | （无独立物品表，由 world_element 承载） | ⚠️ |
| 地点当前状态 | `NovelLocation.status` | ✅ |
| 线索当前进度 | `NovelClue.progress/currentStep/nextStep` | ✅ |
| 伏笔当前阶段 | `NovelForeshadow.status` | ✅ |
| 冲突当前强度 | `NovelConflict.intensity/stage` | ✅ |
| 读者已知信息 | `NovelInformationLayer.readerKnows/isRevealed` | ✅ |
| 角色已知信息 | `NovelInformationLayer.characterKnowledge` | ✅ |
| 剧情当前阶段 | `NovelProject.currentStage` | ✅ |
| 当前卷目标 | `NovelVolume.outline` | ✅ |
| 当前章节目标 | `NovelChapter.narrativeTask/outline` | ✅ |

**差距**：物品归属无独立实体表（融合在 world_element 中），其余 12 项完整覆盖。

---

### 2. 叙事任务系统（文档第 6 节）✅

**实现位置**：
- [index.ts:1016-1053](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L1016-L1053)（`NarrativeTask` / `NarrativeTaskType`）
- [novel-orchestrator.ts:1130-1271](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts#L1130-L1271)（`parseDirectorTask`）

**14 种任务类型**与文档完全对应：
`advance_mainline / advance_subline / create_conflict / escalate_conflict / release_info / hide_info / reinforce_foreshadow / recover_foreshadow / change_relationship / change_cognition / create_reversal / create_suspense / phase_closure / introduce_problem`

Director 通过 `parseDirectorTask` 解析中英文标签，提取高潮目标、悬念持续章数、强度变化等执行参数。

---

### 3. 信息差系统（文档第 8 节）✅

**实现位置**：[index.ts:713-728](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L713-L728)

**关键字段**：
- `authorKnows: boolean` / `readerKnows: boolean` / `isRevealed: boolean`
- `characterKnowledge: string`（JSON：`{ [characterId]: { knows, suspects, misunderstands } }`）—— 覆盖文档"主角知道/反派知道/配角知道/某角色误以为/某角色隐瞒"
- `revealStage` / `revealChapter` / `linkedForeshadows`（双向关联伏笔）

---

### 4. 伏笔与回收系统（文档第 9 节）✅

**实现位置**：[index.ts:386-457](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L386-L457)

**ForeshadowStatus 7 值与文档生命周期完全对应**：

| 枚举值 | 文档阶段 |
|---|---|
| `planned` | 计划中 |
| `planted` | 已埋下 |
| `reinforced` | 已重复强化 |
| `partially_revealed` | 已局部揭露 |
| `recovering` | 进入回收区 |
| `recovered` | 已回收 |
| `abandoned` | 已废弃 |

**beats 离散事件链**：`NovelForeshadow.beats: ForeshadowBeat[]`，每条 beat 含 `chapter / type: 'plant'|'reinforce'|'reveal'|'payoff' / note`，engine 按本章号筛选并按 `payoff > reveal > reinforce > plant` 优先级排序。

---

### 5. 线索推进系统（文档第 10 节）✅

**实现位置**：[index.ts:461-473](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L461-L473)

**全部字段**：`progress: number`（0-100）/ `currentStep` / `nextStep` / `isMisleading: boolean` / `linkedForeshadow: string | null` —— 与文档要求完全一致。

---

### 6. 节奏控制系统（文档第 12 节）✅

**实现位置**：
- [index.ts:46-124](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L46-L124)（`ChapterRhythm` / `RhythmModel` / `RhythmSuggestion`）
- [rhythm-controller.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/rhythm-controller.ts)（完整实现）

**ChapterRhythm 8 值**：`setup / rising / climax / falling / resolution / twist / breather / suspense`

对照文档 8 种：setup=铺垫、rising=推进、climax=高潮、falling=下降、resolution=收束、twist=转折、breather=缓冲、suspense≈揭秘/悬念。文档"冲突"未独立列出（climax 已涵盖）。

**RhythmModel**：`DEFAULT_MODEL`（标准三幕剧）+ `WEBNOVEL_MODEL`（网文快节奏），`suggestRhythm` 方法感知活跃冲突 + 待回收伏笔。

---

### 7. 世界规则系统（文档第 13 节）✅

**实现位置**：[index.ts:617-626](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L617-L626)

**字段**：`category: string` / `rule: string` / `cost: string | null` / `isFixed: boolean`

**`cost` 字段明确强调"代价"**（如血契术消耗寿命），与文档"规则最重要的是代价"完全一致。注入 STATIC 层系统提示词。

---

### 8. 章节验收系统（文档第 15 节）✅

**实现位置**：
- [index.ts:793-813](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L793-L813)（`NovelChapterReview` 10 个评分维度）
- [role-reviewer.md](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompts/role-reviewer.md)（Reviewer Rubric）
- [novel-orchestrator.ts:549-636](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts#L549-L636)（`runPostWriteGuard`）

**10 个验收维度**与文档完全对应：
`consistencyScore / characterScore / taskCompletionScore / clueProgressScore / foreshadowStatusScore / conflictChangeScore / pacingScore / infoControlScore / readerHookScore / styleScore`

**PostWriteGuard 重写机制**：检测模型退化（复读/截断/拒绝/工程词）→ 自动重写；字数偏离（< 85% 或 > 130%）→ 自动重写；矩阵实体未出现 → 自动重写。`MAX_GUARD_REWRITE = 2`，超过降级给 Reviewer。

---

### 9. 风格与文体系统（文档第 16 节）✅

**实现位置**：
- [index.ts:732-777](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L732-L777)（`NovelStyleGuide` + `NovelWritingStyleProfile`）
- [writing-style-prompt-factory.ts:92-119](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/writing-style-prompt-factory.ts#L92-L119)（`compileWritingStylePrompt`）

**NovelWritingStyleProfile 字段**覆盖文档 12 项风格要素：
`narrativePerson / narrativeDistance / sentenceRhythm / dialogueRatio / emotionalTemperature / imageryDensity / vocabularyRegister / hardRules / softRules / positiveExamples`

`compileWritingStylePrompt` 按 `target: 'writer' | 'reviser' | 'reviewer'` 编译不同提示词。

---

## 二、部分实现的系统（6 个）

### 10. 创作约束系统（文档第 5 节）🟡

**实现位置**：
- [index.ts:697-709](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L697-L709)（`NovelConstraint` / `ConstraintType`）
- [novel-engine.ts:67-248](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-engine.ts#L67-L248)（`buildChapterConstraints` 分 5 类）

**5 类约束枚举与文档完全对应**：`ConstraintType = 'fact' | 'cognitive' | 'stage' | 'debt' | 'arc'`

**关键差距**：
- 🔴 **事实约束的"固定/阶段/待定"三态未实现**。`NovelConstraint` 只有 `type` 字段，未细分 `factStatus: 'fixed' | 'stage' | 'tentative'`。`isFixed` 字段只存在于 `NovelWorldRule`，未存在于 `NovelConstraint`。
- 约束的 `scope` 字段为 `'global' | 'volume' | 'chapter'`，但无阶段字段。

---

### 11. 角色弧光系统（文档第 7 节）🟡

**实现位置**：
- [index.ts:283-323](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L283-L323)（`NovelCharacter` + `ArcChange`）
- [index.ts:571-613](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L571-L613)（`NovelCharacterArc` 实体 + `ARC_STAGE_MODELS`）
- [novel-engine.ts:489-494](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-engine.ts#L489-L494)（`getNextArcStage` 防跳档）

**已实现**：
- `arcStage` / `arcHistory` 字段
- `NovelCharacterArc` 独立实体：`arcType: 'growth' | 'fall' | 'redemption' | 'shift'`，`currentStage`，`stageHistory: ArcStageHistoryEntry[]`
- `NovelRelationship.stageHistory`（关系阶段变化追踪）
- "不能跳档"机制：`getNextArcStage` 返回线性下一阶段，`allowedNextStage` 注入 `ChapterConstraints.characterArcs`

**关键差距**（文档 10 项心理维度）：

| 文档要求 | 实现情况 |
|---|---|
| 欲望 | ✅ `longTermDesire` |
| 恐惧 | 🔴 **缺失** |
| 误解 | 🔴 **缺失**（仅在 `NovelInformationLayer.characterKnowledge.misundersts` 间接体现） |
| 底线 | 🔴 **缺失** |
| 秘密 | ✅ `secret` |
| 成长阶段 | ✅ `arcStage` + `NovelCharacterArc` |
| 关系变化 | ✅ `NovelRelationship.stageHistory` |
| 心理状态 | 🟡 `currentState`（部分覆盖） |
| 当前目标 | ✅ `currentGoal` |
| 当前压力 | ✅ `currentPressure` |

**结论**：弧光阶段演进 + 关系阶段追踪 + 防跳档机制完整；但**恐惧/误解/底线 3 个心理维度字段缺失**。

---

### 12. 冲突升级系统（文档第 11 节）🟡

**实现位置**：[index.ts:480-532](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L480-L532)

**ConflictType 9 值与文档完全对应**：`inner / relationship / faction / interest / moral / identity / emotional / world_rule / survival`

**ConflictStage 7 值**（文档 8 阶段，缺 1）：

| 文档阶段 | 枚举值 | 状态 |
|---|---|---|
| 潜伏 | `latent` | ✅ |
| 出现 | `emerging` | ✅ |
| 升级 | `escalating` | ✅ |
| 爆发 | `erupting` | ✅ |
| 反转 | `reversing` | ✅ |
| **暂时解决** | — | 🔴 **缺失** |
| 彻底解决 | `resolved` | ✅ |
| 转化为新冲突 | `transformed` | ✅ |

**已实现**：`ConflictTier = 'main' | 'secondary' | 'goal'`、`climaxChapter`、`climaxType`、5 种 `ConflictProgressionMode`（linear/mutation/stagnation/regression/reversal）、`computeConflictTargetStage` 支持非线性推进。

**差距**：文档 8 阶段中"暂时解决"未实现（只有 `resolved` 表示彻底解决）。

---

### 13. 读者体验系统（文档第 14 节）🟡

**实现位置**：
- [role-reviewer.md:28-32](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompts/role-reviewer.md#L28-L32)（Reviewer 提示词"读者体验"章节）
- [index.ts:793-813](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L793-L813)（`NovelChapterReview` 含 `readerHookScore`）
- [index.ts:534-569](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L534-L569)（`NovelHook` 实体 + `chapterEndingHook` 字段）

**10 维度对照**：

| 文档维度 | 实现情况 |
|---|---|
| 悬念感 | 🟡 部分覆盖（`suspenseHooks` 注入 Writer） |
| 期待感 | 🔴 **缺失独立维度** |
| 爽点 | 🔴 **缺失独立维度**（仅在 Reviewer 提示词提到"无爽点"扣分） |
| 压迫感 | 🔴 **缺失独立维度** |
| 情绪释放 | 🔴 **缺失独立维度** |
| 反转冲击 | 🔴 **缺失独立维度** |
| 人物共情 | 🟡 部分覆盖（`情感投入度` 评分） |
| 节奏舒适度 | 🟡 部分覆盖（`pacingScore`） |
| 信息密度 | 🟡 部分覆盖（`信息增量` 评分） |
| 章节钩子 | ✅ **完整实现**（`NovelHook` 实体 + `readerHookScore`） |

**结论**：仅 3/10 维度有结构化评分，其余散落在提示词描述中。**无独立的"读者体验维度检查"模块**。

---

### 14. 长期记忆分层系统（文档第 17 节）🟡

**实现位置**：
- [novel-memory-store.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-memory-store.ts)（`NovelMemoryStore`）
- [novel-memory-generator.ts:258-504](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-memory-generator.ts#L258-L504)（`NovelMemoryGenerator`）
- [chapter-finalizer.ts:147-214](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/core/agent/chapter-finalizer.ts#L147-L214)（章节快照 + 校准触发）

**已实现**：
- `MemoryEvent` 类型：9 种 `MemoryEventType`、8 种 `MemoryEntityType`
- `saveSnapshot` 方法（章节完成时保存全量状态快照）
- `runFullCalibration` 方法：每 10 章触发，校准最近 5 章
- `recordEvent` 方法 + 因果链 `getCausalChain`
- HTTP 路由：`/memory-events` / `/memory-events/timeline/:entityId` / `/memory-events/causal/:eventId` / `/memory-snapshots` / `/memory-snapshots/:chapterNumber`

**关键差距**（文档 8 层记忆 vs 实际 3 层架构）：

| 文档分层 | 实现情况 |
|---|---|
| 永久设定记忆 | 🟡 部分覆盖（世界规则在 STATIC 层） |
| 当前卷记忆 | 🟡 部分覆盖（卷纲在 STATIC 层） |
| 当前剧情线记忆 | 🔴 **缺失显式分层** |
| 当前章节上下文 | ✅ 已实现（SEMI 层） |
| 角色个人记忆 | 🟡 部分覆盖（`NovelCharacterHistory`） |
| 读者已知信息 | 🟡 部分覆盖（`NovelInformationLayer.readerKnows`） |
| 作者规划信息 | 🔴 **缺失**（作者意图系统未连接） |
| 废弃设定记忆 | 🔴 **缺失** |

实际采用 3 层架构（工作记忆 / 情景记忆 / 语义记忆），未按文档 8 层显式分层。

---

### 15. 多 Agent 协作系统（文档第 19 节）🟡

**实现位置**：
- [novel-agents.ts:16](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts#L16)（`NovelAgentType`）
- [novel-orchestrator.ts:122-538](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts#L122-L538)（编排流程）

**NovelAgentType 5 值**：`'director' | 'writer' | 'reviser' | 'reviewer' | 'memory'`

**文档要求 8 Agent vs 实现**：

| 文档 Agent | 实现情况 |
|---|---|
| 导演 Agent | ✅ `director` |
| 设定 Agent | 🔴 **缺失**（职责并入 Director + Memory） |
| 角色 Agent | 🔴 **缺失**（职责并入 Memory） |
| 线索 Agent | 🔴 **缺失**（职责并入 Memory） |
| 写作 Agent | ✅ `writer` |
| 审稿 Agent | ✅ `reviewer` |
| 修订 Agent | ✅ `reviser`（文档未列但已超出） |
| 记忆 Agent | ✅ `memory` |

**调用顺序**：
```
Director → [检查点1: 叙事任务确认] → Writer → PostWriteGuard → Reviewer → [检查点2: 验收确认] → (revise: Reviser | rewrite: 递归 | approve: Memory) → Memory
```

**Writer 推回机制**：Writer 可通过 `[DIRECTOR_PUSHBACK]` 标记推回 Director（`MAX_PUSHBACK = 1`）。

**关键差距**：文档要求"职责隔离"，实际将"设定/角色/线索"3 个 Agent 的职责合并到 Director（规划时）和 Memory（沉淀时），未实现 8 Agent 独立隔离。`novel-agents.ts:35-50` 注释明确说明"Director 无需 query 工具，所有实体信息已通过 SEMI 层 chapterContext 一次性注入"——这是 **token 优化决策，牺牲了 Agent 职责隔离**。

---

## 三、基本未实现的系统（1 个）

### 16. 作者意图系统（文档第 18 节）🔴

**实现位置**：
- [index.ts:779-789](file:///d:/WebWork/AI/pi-agent/packages/shared/src/novel/index.ts#L779-L789)（`NovelAuthorIntent` 类型定义）
- [novel-migrations.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts)（`novel_author_intents` 建表）
- [novel-store.ts:2098-2114](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts#L2098-L2114)（仅 `createAuthorIntent` 一个方法）

**类型定义**：
```typescript
export interface NovelAuthorIntent {
  id: string
  projectId: string
  chapterId: string | null
  intentType: 'plot' | 'foreshadow' | 'character' | 'scene' | 'dialogue'
  description: string
  targetEntityId: string | null
  createdAt: number
}
```

**5 项全缺失**：

| 文档要求 | 实现情况 |
|---|---|
| 读取方法（list/get） | 🔴 **缺失**（NovelStore 中只有 `createAuthorIntent`，无 `listAuthorIntents` / `getAuthorIntent`） |
| HTTP 路由 | 🔴 **缺失**（novel-routes.ts 中无任何 `authorIntent` / `author-intent` / `intention` / `purpose` / `why` 路由） |
| Agent 提示词注入 | 🔴 **缺失**（prompt-builder.ts 中无 `NovelAuthorIntent` 引用，Director/Writer/Reviewer 都看不到作者意图） |
| Memory Agent 提取 | 🔴 **缺失**（novel-memory-generator.ts 的 `MemoryUpdatePayload` 不含 `authorIntent` 字段，`buildUserPrompt` 不提取意图） |
| "为什么这么写"的语义关联 | 🔴 **缺失**（5 类意图虽有 `intentType` 枚举对应，但无任何业务逻辑使用） |

**结论**：**仅有数据库表 + 类型定义 + 一个孤立的写入方法，整个系统未连接到创作流程**。属于"建表但未实现业务"的状态。可以写入但无人读取，Agent 看不到，用户访问不到，Memory 不提取。

---

## 四、按文档推荐优先级的符合度

文档第 21 节定义了 4 个建设阶段：

### 第一阶段：先解决"AI 写崩"问题 ✅ 基本达成

| 系统 | 实现程度 |
|---|---|
| 故事状态系统 | ✅ 完整 |
| 创作约束系统 | 🟡 部分（事实约束三态未实现） |
| 章节验收系统 | ✅ 完整 |
| 长期记忆分层系统 | 🟡 部分（3 层 vs 8 层） |

**目标达成情况**：
- ✅ 不改固定设定（世界规则 `isFixed`）
- 🟡 不提前泄露秘密（信息差系统完整，但约束三态未实现）
- ✅ 不忘记主要伏笔（伏笔生命周期完整 + beats 事件链）
- ✅ 不违反世界规则（`cost` 字段 + STATIC 层注入）
- ✅ 写完后能更新状态（Memory Agent + 快照 + 每 10 章校准）

### 第二阶段：解决"AI 写水"问题 ✅ 完全达成

| 系统 | 实现程度 |
|---|---|
| 叙事任务系统 | ✅ 完整 |
| 线索推进系统 | ✅ 完整 |
| 冲突升级系统 | 🟡 部分（缺"暂时解决"阶段） |
| 节奏控制系统 | ✅ 完整 |

**目标达成情况**：✅ 每章都有明确作用、✅ 主线持续推进、✅ 冲突持续升级、✅ 章节不空转

### 第三阶段：解决"人物和体验"问题 🟡 部分达成

| 系统 | 实现程度 |
|---|---|
| 角色弧光系统 | 🟡 部分（缺恐惧/误解/底线） |
| 信息差系统 | ✅ 完整 |
| 读者体验系统 | 🟡 部分（3/10 维度） |
| 风格与文体系统 | ✅ 完整 |

**目标达成情况**：
- 🟡 人物变化自然（缺 3 个心理维度）
- ✅ 悬念成立（信息差完整）
- ✅ 反转有效（信息差 + 冲突反转阶段）
- 🟡 读者有期待（钩子完整，但体验维度不足）
- ✅ 风格不漂移（文风档案 + 三 Agent 注入）

### 第四阶段：解决"创作工作台"问题 🔴 未达成

| 系统 | 实现程度 |
|---|---|
| 作者意图系统 | 🔴 **基本未实现** |
| 多 Agent 协作系统 | 🟡 部分（5/8 Agent） |
| 更细的世界规则系统 | ✅ 完整 |
| 更复杂的伏笔与回收管理 | ✅ 完整 |

**目标达成情况**：
- 🔴 系统理解作者为什么这么写（作者意图系统空壳）
- 🟡 各 Agent 职责清晰（5/8 Agent，设定/角色/线索未隔离）
- ✅ 长篇复杂结构可持续维护（伏笔 + 线索 + 冲突 + 节奏完整）

---

## 五、改进建议（按优先级）

### P0：必须修复

1. **作者意图系统接入创作流程**（文档第 18 节）
   - 补 `listAuthorIntents` / `getAuthorIntent` 读取方法
   - 补 HTTP 路由（CRUD）
   - 在 `prompt-builder.ts` 注入到 Director/Writer/Reviewer 的 SEMI 层
   - Memory Agent 提取意图（`MemoryUpdatePayload` 加 `authorIntent` 字段）
   - **理由**：这是文档第四阶段的核心，当前是空壳

### P1：建议改进

2. **事实约束三态**（文档 5.3.1）
   - `NovelConstraint` 加 `factStatus: 'fixed' | 'stage' | 'tentative'` 字段
   - `buildChapterConstraints` 按三态区分约束力度

3. **角色心理维度补全**（文档 7.3）
   - `NovelCharacter` 加 `fear` / `bottomLine` 字段（误解已在信息差中体现）
   - 注入 prompt 的角色状态块

4. **冲突"暂时解决"阶段**（文档 11.3）
   - `ConflictStage` 加 `temporary_resolved` 值
   - 区分"暂时解决"（冲突可能再起）和"彻底解决"（`resolved`）

5. **读者体验维度结构化**（文档 14.2）
   - `NovelChapterReview` 加 `readerExperienceScore`（综合分）或拆分 `satisfactionScore / tensionScore / emotionScore`
   - Reviewer 提示词补充爽点/压迫感/情绪释放/反转冲击的检查指令

### P2：可观察

6. **记忆分层显式化**（文档 17.2）
   - 在 `NovelMemoryStore` 中按 8 层标记记忆类型（`memoryLayer: 'permanent' | 'volume' | 'arc' | 'chapter' | 'character' | 'reader' | 'author_plan' | 'deprecated'`）
   - 废弃设定标记 `deprecated`，不再注入 prompt

7. **多 Agent 职责隔离**（文档 19.2）
   - 评估是否拆分 `setting` / `character` / `clue` 三个独立 Agent
   - 或保持当前 5 Agent 架构但在 prompt 中更明确地分离职责边界
   - **权衡**：当前合并是 token 优化决策，拆分会增加调用次数和成本

---

## 六、结论

pi-agent 在**第一、二阶段（防崩、防水）**已基本达成目标，9 个核心系统完整实现，特别是伏笔生命周期、信息差、章节验收、节奏控制四个系统与文档要求高度一致。

**第三阶段（人物和体验）**部分达成，角色弧光的阶段演进和防跳档机制完整，但心理维度字段不足；读者体验只有钩子系统完整，其余维度散落在提示词中。

**第四阶段（创作工作台）**未达成，**作者意图系统是最大缺口**——仅有数据库表和类型定义，未接入创作流程。多 Agent 协作采用 5 Agent 精简架构（合并了设定/角色/线索 Agent），是 token 优化与职责隔离的权衡决策。

**最关键的改进**：接入作者意图系统，让 AI 理解"为什么这么写"，而不仅是"写了什么"。
