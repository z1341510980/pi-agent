# 角色 / 冲突 / 伏笔 现状诊断报告

> 基于"人物工具人化"四层逻辑理论对现有数据模型与生成流程的体检。
> 四层逻辑：
> 1. 目标层（他想要什么）
> 2. 关系层（他和主角是什么关系，是否动态）
> 3. 功能层（他在剧情里负责推动什么）
> 4. 影响层（删掉他，哪段剧情会受影响）

---

## 一、角色（NovelCharacter）

### 1.1 现有数据模型

`NovelCharacter`（[types.ts:140-162](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L140-L162)）：

| 字段 | 含义 | 对应四层 |
|---|---|---|
| `name / description / identity / personality / appearance / speechStyle` | 静态设定 | 设定层 |
| `currentState / currentGoal / currentPressure / secret` | 动态状态 | ① 目标层（半成品） |
| `arcStage / arcHistory` | 角色弧光 | 弧光层 |
| `isProtagonist` | 是否主角 | 标签 |

`NovelCharacterHistory`（[types.ts:428-439](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L428-L439)）跟踪 `currentState / currentGoal / currentPressure / secret / arcStage` 五个字段的历史变更。

### 1.2 四层逻辑覆盖情况

| 四层 | 现状 | 位置 | 评分 |
|---|---|---|---|
| ① 目标 | 半成品 | `currentGoal / currentPressure / secret` | ⚠️ 只有短期目标，缺长期欲望 |
| ② 关系 | 形式上有，实质弱 | `NovelRelationship` | ❌ 标签化、不注入章节 |
| ③ 功能 | **完全缺失** | — | ❌ 无字段无约束 |
| ④ 影响 | **完全缺失** | — | ❌ 无字段无记录 |

### 1.3 问题详解

#### ① 目标层：生成提示词把目标写窄了

生成提示词（[novel-character-generator.ts:135-156](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-character-generator.ts#L135-L156)）只问了一句"当前短期目标"：

```
- currentGoal: 当前短期目标
```

四层逻辑里的目标分两层：
- **短期目标**（currentGoal，已有）：会随章节变化，比如"夺回剑"
- **长期欲望**（缺失）：人物的发动机，跨章节稳定，比如"为师父复仇"
- **想保住什么 / 争到什么 / 躲开什么**（缺失）：欲望的三个面

只有短期目标没有长期欲望，结果是：每章 AI 都给角色塞一个新目标，但角色没有持续驱动力，写到第 30 章就和第 1 章判若两人。

#### ② 关系层：标签化 + 不注入章节，正是"朋友/师父/恋人不够用"

`NovelRelationship`（[types.ts:174-184](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L174-L184)）：

```ts
relationType: string       // "敌对/合作/师徒/恋人/亲属..."
currentStage: string       // 关系当前阶段
stageHistory: string       // JSON: RelationChange[]
```

三个问题：

1. **`relationType` 是静态字符串**——就是四层逻辑明确说"不够用"的标签。没有"他在帮主角什么 / 拦主角什么 / 同一边还是暂时同路 / 后面会不会变"四个动态面。
2. **关系不注入章节生成**——[prompt-builder.ts:504-526](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L504-L526) 的 `formatArrangedEntities` 只输出角色个体，**完全不输出本章角色之间的关系约束**。Writer 写一章时看不到"这俩人这章的关系状态是 X、本章要推向 Y"。
3. **关系工具只能改 `currentStage` 一个字段**（[novel-tools.ts:113-116](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts#L113-L116)），改不了 `relationType`，也没法标注"关系即将转变"。

#### ③ 功能层：完全缺失（最大的洞）

四层逻辑列举的剧情功能：
- 提供资源 / 制造阻碍 / 放大冲突 / 打开新阶段
- 改变主角判断 / 推进感情线 / 暴露世界规则

现状：
- `NovelCharacter` 没有任何"功能 / 职责 / 推动作用"字段
- `ArrangedEntity`（[types.ts:608-614](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L608-L614)）只存 `characterIds: string[]`，**不带"这个角色本章负责推动什么"**
- `generateAndArrange`（[novel-entity-generator.ts:311-343](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-entity-generator.ts#L311-L343)）生成角色时 `isProtagonist: false` 全员平等，没有"主角 / 主要对手 / 功能配角"的层级区分
- `planEntitiesFromOutline`（[novel-entity-generator.ts:509-605](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-entity-generator.ts#L509-L605)）只产 `coreStyle` 一句话，规划阶段不问"这个角色来干嘛"

直接后果：四层逻辑批评的"两个配角在做同一件事，三个人物在提供同一种信息"会原样发生——系统根本没要求 AI 区分功能。

#### ④ 影响层：完全缺失

四层逻辑的检查法："删掉他，哪段剧情会受影响"——

- `NovelCharacterHistory` 只记录角色**自己**的字段变更，不记录"这个角色**导致**了什么局面变化"
- 冲突有 `stakes / climaxChapter / twistPotential`（[types.ts:240-248](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L240-L248)），但角色没有对应的"叙事重量 / 不可替代性"字段
- 没有任何地方记录"该角色出场后，主角拿到了什么新机会 / 多了什么新压力 / 哪段关系失衡 / 哪个隐藏问题被暴露"

### 1.4 四句检查法可答性

| 检查句 | 现系统能否回答 |
|---|---|
| 1. 他现在想要什么 | 能（`currentGoal`），但只有短期，无长期欲望 |
| 2. 他和主角现在是什么关系 | 勉强（`NovelRelationship` 存在，但不注入章节、不能动态标注功能） |
| 3. 他这次出场负责推动什么 | **答不上** |
| 4. 删掉他，哪段剧情会受影响 | **答不上** |

---

## 二、冲突（NovelConflict）

### 2.1 现有数据模型

`NovelConflict`（[types.ts:228-251](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L228-L251)）：

| 字段 | 含义 |
|---|---|
| `description / type / tier` | 描述 / 类型 / 层级（main/secondary/goal） |
| `intensity` | 强度 1-10 |
| `stage` | 阶段：latent→emerging→escalating→erupting→reversing→resolved/transformed |
| `participants` | 参与方（JSON 字符串数组） |
| `chapterSpans` | 章节跨度（非连续数组，如 [[1,3],[10,12]]） |
| `climaxChapter / climaxType` | 爆发章节 + 高潮类型（emotional/fate/character/combat/theme/composite） |
| `stakes` | 赌注（失败代价） |
| `twistPotential` | 突转潜力 0-10 |
| `relatedConflicts` | 关联冲突 ID 列表（JSON） |

### 2.2 完整生命周期支持

冲突**比角色完整得多**，有：

- **生命周期**：7 个阶段，覆盖潜伏→浮现→升级→爆发→逆转→解决→转化
- **强度量化**：1-10 整数
- **层级划分**：main（主线）/ secondary（次要）/ goal（目标级）
- **赌注**：失败代价
- **突转潜力**：0-10，标注是否适合安排突转
- **高潮类型**：6 种高潮种类（情感/命运/性格/打斗/主题/复合）
- **跨度管理**：非连续章节跨度数组

### 2.3 章节注入与约束构建

- **注入**：[prompt-builder.ts:527-543](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L527-L543) 的 `formatArrangedEntities` 输出冲突的 `description / stage / intensity / tier / stakes / twistPotential`
- **约束构建**：[novel-engine.ts:65-101](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-engine.ts#L65-L101) 的 `buildChapterConstraints` 筛选本章需推进的冲突（按 chapterSpans / climaxChapter / 空跨度），计算 `targetStage` 和 `intensityDelta`，最多 5 个目标
- **节奏感知**：[rhythm-controller.ts:124-153](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/rhythm-controller.ts#L124-L153) 检测 `erupting` 冲突→建议 climax；`reversing` 冲突→建议 twist；高强度总和→建议 rising
- **工具**：`novel_update_conflict`（改 stage + intensity）、`novel_create_conflict`
- **记忆**：Memory Generator 通过 `conflictUpdates / conflictCreates` 应用变更

### 2.4 问题详解

#### ① 冲突与角色脱节

`participants` 是 JSON 字符串数组（按名字记录），但：
- 角色端**没有"参与哪些冲突"的反向字段**
- 删一个角色不知道会断几条冲突线
- 查一个角色不知道他在推动哪些冲突
- 冲突爆发时谁被卷入、谁失去什么、谁做出关键判断——这些都是角色层面的"剧情功能"，但 `NovelConflict` 只记 stage 和 intensity，**不记冲突推进对每个角色的反向影响**

#### ② 冲突与关系脱节

两个角色之间的冲突，本应自动建立或更新他们的关系状态。现在 `NovelConflict` 和 `NovelRelationship` **完全分离**，没有任何关联：
- A 和 B 之间的冲突爆发，不会更新 A↔B 的关系阶段
- A↔B 的关系变化，不会影响他们参与的冲突

#### ③ 冲突推进是机械式线性升级

[novel-engine.ts:185-198](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-engine.ts#L185-L198) 的 `computeConflictTargetStage` 写死成线性推进：

```
latent → emerging → escalating → erupting → reversing → resolved
```

真实故事里冲突可能：
- **反复**（resolved 又重新 emerging）
- **突变**（latent 直接 erupting）
- **停滞**（escalating 多章不升）
- **降级**（erupting → escalating，因外部干预）

现在没有任何"冲突节奏"或"冲突功能位"标注这章冲突要"放大冲突 / 打开新阶段 / 暴露世界规则 / 改变主角判断"，全部按机械线性推进。

#### ④ 冲突网编织弱

`relatedConflicts` 字段存在但：
- 生成器从未生成（[novel-entity-generator.ts:622-640](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-entity-generator.ts#L622-L640) 的 conflict 提示词不要求）
- prompt 也不要求 LLM 输出
- 没有任何"一个冲突的爆发会触发另一个冲突"的因果链

冲突之间是孤岛，无法编织冲突网。

#### ⑤ 冲突的"剧情功能"未结构化

四层逻辑列的剧情功能里有"放大冲突 / 打开新阶段 / 暴露世界规则"——这些是冲突在剧情里的**功能位**。现在冲突只有 `stage` 和 `intensity`，没有功能位标注：
- 这章冲突是要"放大"还是"打开新阶段"？
- 这章冲突是要"暴露世界规则"还是"改变主角判断"？
- 两个冲突都在"升级"，但功能位不同（一个放大冲突，一个打开新阶段），现在无法区分。

---

## 三、伏笔（NovelForeshadow）

### 3.1 现有数据模型

`NovelForeshadow`（[types.ts:188-201](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L188-L201)）：

| 字段 | 含义 |
|---|---|
| `description / category` | 描述 / 类别（自由字符串） |
| `status` | 状态：planned→planted→reinforced→partially_revealed→recovering→recovered→abandoned |
| `firstChapter / lastChapter` | 首次出现 / 最近出现章节 |
| `recoverByChapter` | 应在第几章前回收 |
| `linkedCharacters` | 关联角色（JSON 字符串数组） |
| `linkedClues` | 关联线索（JSON 字符串数组） |

### 3.2 完整生命周期支持

伏笔也有较完整的生命周期：
- **7 个状态**：planned → planted → reinforced → partially_revealed → recovering → recovered → abandoned
- **章节管理**：firstChapter / lastChapter / recoverByChapter
- **关联**：linkedCharacters / linkedClues

### 3.3 章节注入与约束构建

- **注入**：[prompt-builder.ts:544-554](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L544-L554) 的 `formatArrangedEntities` 输出伏笔的 `description + status`
- **约束构建**：[novel-engine.ts:117-157](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-engine.ts#L117-L157) 把待回收伏笔作为 `suspenseHooks`（planting / sustaining / releasing），同时作为 `narrativeDebts`
- **节奏感知**：[rhythm-controller.ts:156-164](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/rhythm-controller.ts#L156-L164) 检测待回收伏笔紧迫时不建议 breather
- **工具**：`novel_update_foreshadow`（改 status）、`novel_create_foreshadow`
- **记忆**：Memory Generator 更新伏笔 status 和创建新伏笔

### 3.4 问题详解

#### ① 伏笔类型未结构化

`category` 是自由字符串（[novel-entity-generator.ts:641-654](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-entity-generator.ts#L641-L654) 提示词只说"物品/言语/事件/身份/秘密/预言"），没有结构化枚举。

不同类型伏笔有不同回收规律：
- **承诺类**：要在承诺人面前回收
- **预言类**：要在兑现时回收
- **物品类**：要在物品再次出现时回收
- **身份类**：要在身份揭晓时回收
- **台词类**：要在台词应验时回收

现在全部按统一 status 流转，LLM 写回收时缺乏类型化指导。

#### ② 伏笔与角色的双向关联弱

`linkedCharacters` 是 JSON 字符串数组（按 ID），但：
- 角色端**没有"埋了哪些伏笔 / 参与哪些伏笔回收"的反向字段**
- 删一个角色不知道会断哪些伏笔线
- 查一个角色不知道他埋了哪些伏笔、参与了哪些伏笔回收

#### ③ 伏笔的"埋设方式"和"回收方式"未结构化

现在只记伏笔描述和 status，不记：
- **如何埋的**：明写（直接点破）/ 暗写（藏在对话里）/ 侧写（通过他人视角提及）
- **如何回收的**：明回收（直接点破）/ 暗回收（让读者自己悟）/ 反向回收（与埋设相反）/ 递进回收（多次点破）

这导致 LLM 写回收时手法单一，全部是"直接点破"。

#### ④ 伏笔的张力管理缺失

没有"伏笔强度"或"读者关注度"字段。一个埋了 50 章的伏笔回收时应该有更大的张力释放，但现在和刚埋的伏笔同等对待。

`sustainedChapters` 字段在 `SuspenseHook`（[types.ts:592-603](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L592-L603)）里有，但只是约束构建时的临时计算，不持久化在伏笔上。

#### ⑤ 伏笔的误导/双重伏笔未支持

`isMisleading` 字段在 `NovelClue`（[types.ts:217](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L217)）上有，但 `NovelForeshadow` **没有**。

真实写作中"假伏笔"（误导读者，反向回收）很重要：
- 表面埋一个伏笔，让读者以为 X 会发生
- 实际反向回收，让 Y 发生
- 这种"双重伏笔"结构现在没有结构化支持

#### ⑥ 伏笔与信息差功能重叠

`NovelForeshadow` 和 `NovelInformationLayer`（[types.ts:361-373](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/types.ts#L361-L373)）功能重叠：

| 维度 | NovelForeshadow | NovelInformationLayer |
|---|---|---|
| 描述 | 描述伏笔内容 | 描述信息内容 |
| 谁知道 | linkedCharacters | characterKnowledge |
| 何时揭露 | firstChapter / recoverByChapter | revealChapter / revealStage |
| 是否已揭露 | status | isRevealed |

两者职责边界不清：
- 伏笔是"埋了等回收"的叙事债务
- 信息差是"谁知道什么"的认知管理

但实际写作中两者经常合一：一个伏笔的回收本质上是信息差的释放。现在两套模型并存但没有打通，导致：
- 同一个叙事元素可能被 LLM 同时记到两张表
- 章节约束里两套都注入（`narrativeDebts` + `suspenseHooks` 来源重叠），Writer 看到重复信息

#### ⑦ 伏笔回收方式未结构化

伏笔回收被简单记为 `status='recovered'`，没有：
- **回收方式**（点破 / 暗示 / 反向 / 递进）
- **回收力度**（轻 / 中 / 重）
- **回收章节的戏剧强度**

LLM 写回收时缺乏指导，容易写成"突然点破"。

---

## 四、跨实体的共性问题

### 4.1 双向关联全部缺失

| 实体 | 反向字段 | 后果 |
|---|---|---|
| 角色 → 冲突 | ❌ 无 | 删角色不知断几条冲突线 |
| 角色 → 伏笔 | ❌ 无 | 删角色不知断哪些伏笔 |
| 冲突 → 角色 | ❌ 无（只有 participants 名字） | 查冲突不知涉及哪些角色 |
| 伏笔 → 角色 | ❌ 无（只有 linkedCharacters ID） | 查伏笔不知涉及哪些角色 |
| 关系 ↔ 冲突 | ❌ 无 | 关系变化不更新冲突，冲突爆发不更新关系 |

**根因**：所有实体都用"正向引用 + JSON 字符串数组"，没有任何反向索引或双向关联表。这正好对应四层逻辑第四句"删掉他，哪段剧情会受影响"——现在系统对所有实体都答不上这句话。

### 4.2 功能位概念全面缺失

四层逻辑的核心是"功能位"——每个实体在剧情里负责推动什么。现在：
- 角色：无功能位字段
- 冲突：无功能位字段（只有 stage / intensity）
- 伏笔：无功能位字段（只有 status）

结果就是"两个实体在做同一件事，三个实体在提供同一种信息"会原样发生。

### 4.3 实体间因果链断裂

四层逻辑强调"出场后局面真的变一下"。现在：
- 角色出场 → 角色状态变更（有 history）
- 冲突爆发 → 冲突 stage 变更（有记录）
- 伏笔回收 → 伏笔 status 变更（有记录）

但**跨实体的因果链全部断裂**：
- 角色出场导致冲突升级？没有记录
- 冲突爆发导致关系失衡？没有记录
- 伏笔回收导致角色认知改变？没有记录

`NovelMemoryStore.recordEvent` 有 `cause / effectIds` 字段（[novel-orchestrator.ts:891-914](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts#L891-L914)），但所有调用都传 `cause: null, effectIds: []`——**字段存在但从未被使用**。

### 4.4 三层缓存设计对功能位的阻碍

[prompt-builder.ts:46-65](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts#L46-L65) 的缓存优化原则：
- STATIC 层：世界规则 + 风格 + 势力/地点/世界要素静态档案
- SEMI 层：章节上下文 + arrangedEntities
- DYNAMIC 层：工具调用结果

角色定义**故意不放在 STATIC 层**（避免 200+ 角色上下文爆炸），只放在 SEMI 层的 arrangedEntities。这意味着：
- 本章未出场的角色，Writer 完全不知道他们的功能位
- 即使加了功能位字段，跨章缓存命中要求 STATIC 层稳定，功能位变更会破坏缓存

**结论**：功能位字段不能放在 STATIC 层（会破坏缓存），必须放在 SEMI 层的 arrangedEntities 或 DYNAMIC 层的工具结果。但这又导致跨角色功能位感知缺失。

---

## 五、改进方向概览

> 以下仅是方向，不是最终方案。确认方向后再细化设计。

### 5.1 角色改进

- **数据模型**：给 `NovelCharacter` 加 `longTermDesire`（长期欲望）、`plotRole`（功能位枚举）、`removalImpact`（删掉影响）
- **生成提示词**：让 `planEntitiesFromOutline` 先规划"本章需要哪些功能位"，再分配给角色
- **章节注入**：`formatArrangedEntities` 输出"本章角色功能 + 与主角关系状态 + 关系走向"
- **工具**：扩 `update_relationship` 支持标注关系功能与走向

### 5.2 冲突改进

- **数据模型**：给 `NovelConflict` 加 `plotFunction`（功能位：放大冲突/打开新阶段/暴露世界规则/改变主角判断）
- **双向关联**：`participants` 改为角色 ID 数组，角色端加 `participatingConflicts` 反向字段
- **冲突网**：`relatedConflicts` 真正生成和使用，建立冲突因果链
- **非线性推进**：`computeConflictTargetStage` 支持反复 / 突变 / 停滞 / 降级
- **角色反向影响**：冲突推进时记录对每个 participant 的反向影响

### 5.3 伏笔改进

- **数据模型**：`category` 改为结构化枚举（物品/言语/事件/身份/秘密/预言/承诺/台词）
- **埋设/回收方式**：加 `plantMethod`（明写/暗写/侧写）+ `recoverMethod`（点破/暗示/反向/递进）
- **张力管理**：加 `intensity`（伏笔强度）+ 持续章数自动计算张力释放
- **误导伏笔**：加 `isMisleading` + `realForeshadowId`（关联真实伏笔）
- **与信息差打通**：明确职责边界，伏笔管"叙事债务"，信息差管"认知管理"，两者通过 `linkedInfoLayer` 关联

### 5.4 跨实体改进

- **双向关联表**：建立 `novel_entity_relations` 表，记录所有实体间的关系（角色↔冲突↔伏笔↔关系）
- **因果链**：`NovelMemoryStore.recordEvent` 的 `cause / effectIds` 真正使用，记录跨实体因果
- **功能位统一**：所有实体都有 `plotFunction` 字段，章节注入时统一输出

---

## 六、优先级建议

按"投入产出比 + 对四层逻辑的修复程度"排序：

| 优先级 | 改进项 | 修复的四层 | 投入 |
|---|---|---|---|
| P0 | 角色 `plotRole` + `longTermDesire` | ① ③ | 小（加字段 + 改提示词） |
| P0 | `formatArrangedEntities` 输出角色功能位 | ③ | 小（改格式化） |
| P1 | `NovelRelationship` 动态化 + 注入章节 | ② | 中（改模型 + 改注入） |
| P1 | 冲突 `participants` 双向关联 | ④ | 中（改存储 + 反向索引） |
| P2 | 冲突 `plotFunction` + 非线性推进 | ③ | 中（改模型 + 改引擎） |
| P2 | 伏笔 `category` 枚举 + 埋设/回收方式 | ③ | 中（改模型 + 改提示词） |
| P3 | 跨实体因果链（cause/effectIds） | ④ | 大（改记忆系统） |
| P3 | 伏笔与信息差打通 | — | 大（重构两个模型） |
