# 小说故事矩阵、事件账本与复合轨道设计

> 状态：实施中（事件账本闭环与聚焦轨道已落地，总览账本投影和 AI 确认队列待完成）  
> 日期：2026-07-21  
> 目标：在保留现有角色、关系、冲突、伏笔、线索、物品等实体数据的前提下，用统一的事件与变化记录驱动章节矩阵、复合轨道、关系投影、批注和 AI 写作上下文。

当前实现进度：

- 已完成 SQLite 增量迁移、StoryEvent / ChangeRecord / Annotation CRUD、实体时间线和章节 `story-context`。
- 已完成第 N 章章前状态重建、未来承诺边界、连续性警告，以及数值到行为语义的提示词转换。
- 已完成基于 `@svar-ui/react-gantt@2.7.1` 的 React 聚焦复合轨道。旧自绘子轨道已退出渲染链路。
- 聚焦页已支持所有矩阵实体，显示兼容快照轨道与账本事件、变化、批注，并可一次创建事件、关联实体和多条原子变化。
- 矩阵总览目前仍以现有实体字段和 marker 为主要投影；`story-matrix` 聚合接口、统一批注面板、AI 提取确认队列和按章节关系投影尚未完成。

---

## 1. 结论

本方案不建设三套相互竞争的编辑器。产品以一个章节矩阵为主界面，提供两种工作状态：

1. **矩阵总览**：同时观察所有小说要素在章节轴上的出现、持续和变化。
2. **聚焦编辑**：双击一个实体后进入类似视频编辑器“复合片段”的子轨道，只编辑该实体及其相关变化。

关系网络是事件账本的可选投影，不是主要录入入口。用户通常不需要手动画线；关系线由结构化关系、事件参与方和变化记录自动生成。只有静态设定关系或尚未绑定事件的规划关系允许手动创建。

数据层采用以下职责划分：

```text
实体表                 保存当前快照与静态设定
StoryEvent             保存某个场景实际发生了什么
ChangeRecord           保存什么从什么变成了什么
Annotation             保存作者说明、意图、待办和疑问
矩阵 / 关系图 / AI上下文  都是上述数据的投影或消费者
```

---

## 2. 设计目标与边界

### 2.1 必须做到

- 矩阵覆盖角色、人物关系、冲突、伏笔、线索、物品、势力、地点、世界要素、世界规则、信息差和关键事件。
- 能回答任意章节或场景结束时：人物在哪里、知道什么、相信谁、持有什么，冲突处于什么阶段，线索和伏笔推进到哪里。
- 能表达非连续出现、跨章节持续、多阶段演化、物品转移、关系转折和因果结果。
- 所有变化都有原因、前值、后值和所在章节，必要时精确到场景顺序。
- 总览模式保持紧凑，复杂编辑只在聚焦模式展开。
- 批注与故事事实分离，只有明确标记的批注才进入 AI 上下文。
- 兼容现有数据，采用增量迁移，不直接删除旧历史字段。

### 2.2 暂不追求

- 不把所有文学概念强行数值化。
- 不在第一阶段实现全局蓝图编辑器。
- 不要求用户维护每一条图连线。
- 不在总览矩阵中永久展开所有实体的全部子轨道。
- 不让一条跨十章的色带代替十章中真实发生的关键事件。

---

## 3. 核心领域模型

### 3.1 实体快照

现有实体表继续保存“现在是什么”：

- `novel_characters`
- `novel_relationships`
- `novel_conflicts`
- `novel_foreshadowing`
- `novel_clues`
- `novel_items`
- `novel_factions`
- `novel_locations`
- 世界要素、世界规则和信息差相关表

实体表适合高频读取和提示词构建，但不能单独承担完整历史。

### 3.2 StoryEvent：发生了什么

`StoryEvent` 是一个具体场景或剧情节拍，必须落在一个章节和场景顺序上。

```ts
interface StoryEvent {
  id: string
  projectId: string
  chapterNumber: number
  sceneId: string | null
  sceneOrder: number
  type: StoryEventType
  title: string
  summary: string
  outcome: string
  status: 'planned' | 'confirmed' | 'generated' | 'superseded'
  parentEventId: string | null
  source: 'manual' | 'ai-extracted' | 'ai-planned' | 'migration'
  createdAt: number
  updatedAt: number
}
```

事件关联实体时必须记录角色，而不是只有 ID：

```ts
interface StoryEventEntityRef {
  eventId: string
  entityType: NovelEntityType
  entityId: string
  role: 'actor' | 'target' | 'participant' | 'trigger' | 'evidence'
      | 'resource' | 'location' | 'affected' | 'outcome'
  note: string
}
```

### 3.3 ChangeRecord：发生了什么变化

现有 `novel_memory_events` 演化为统一变化账本；代码层可逐步改名为 `ChangeRecord`，数据库表名暂时保留以降低迁移风险。

```ts
interface ChangeRecord {
  id: string
  projectId: string
  storyEventId: string | null
  chapterNumber: number
  sceneOrder: number
  subjectType: NovelEntityType
  subjectId: string
  dimension: string
  targetType: NovelEntityType | null
  targetId: string | null
  valueType: 'enum' | 'level' | 'number' | 'set' | 'reference' | 'text'
  beforeValue: unknown
  afterValue: unknown
  reason: string
  significance: number
  source: 'manual' | 'ai-extracted' | 'migration'
  createdAt: number
}
```

`subject + dimension + target` 唯一说明“谁的什么发生了变化”。例如：

```json
{
  "subjectType": "character",
  "subjectId": "A",
  "dimension": "relationship.suspicion",
  "targetType": "character",
  "targetId": "B",
  "valueType": "level",
  "beforeValue": 20,
  "afterValue": 70,
  "reason": "在 B 的书房发现染血收据"
}
```

### 3.4 Annotation：作者批注

批注不改变故事事实。批注可锚定实体、事件、变化、关系、矩阵单元格或章节跨度。

```ts
interface NovelAnnotation {
  id: string
  projectId: string
  scopeType: 'entity' | 'event' | 'change' | 'relation' | 'matrix-cell' | 'span'
  scopeId: string | null
  entityType: NovelEntityType | null
  entityId: string | null
  chapterStart: number | null
  chapterEnd: number | null
  kind: 'note' | 'intent' | 'todo' | 'warning' | 'question'
  content: string
  color: string
  includeInPrompt: boolean
  resolved: boolean
  createdAt: number
  updatedAt: number
}
```

---

## 4. 量化规则

量化对象是变化维度，不是整个实体。优先使用离散语义，只有确实需要比较、排序或画曲线时才使用数字。

| 要素 | 推荐维度 | 值类型 | 建议范围或枚举 |
|---|---|---|---|
| 角色 | `state`、`goal`、`pressure`、`arcStage` | text / enum / level | 压力 0-10，其余结构化文本或阶段 |
| 角色认知 | `knowledge`、`belief` | set / enum | 知情实体集合；未知/怀疑/相信/确认/否定 |
| 人物关系 | `trust`、`suspicion`、`hostility`、`affection`、`dependency` | level | 0-100；界面显示语义标签 |
| 冲突 | `stage`、`intensity`、`progress`、`participants` | enum / number / set | 阶段枚举；强度 0-10；进度 0-100 |
| 伏笔 | `beat`、`status` | enum | plant/reinforce/reveal/payoff；不虚构精确进度 |
| 线索 | `status`、`verification`、`knownBy`、`holder` | enum / number / set / reference | 未知/发现/怀疑/验证/证伪/使用 |
| 物品 | `owner`、`location`、`status`、`charges` | reference / enum / number | 持有人、位置、正常/遗失/损坏/转化/销毁 |
| 势力 | `alignment`、`strength`、`members` | enum / level / set | 阵营枚举；实力 0-100 |
| 地点 | `controller`、`access`、`state` | reference / enum / text | 控制方、开放状态、环境变化 |
| 信息差 | `knownBy`、`hiddenFrom`、`accuracy` | set / enum | 知情方、被隐瞒方、真实/部分/错误 |

关系强度的默认显示分段：

```text
0-19 无明显表现
20-39 轻微
40-59 明显
60-79 强烈
80-100 主导行为
```

项目允许添加自定义关系标签，但第一阶段不允许自定义任意数值公式。自定义关系仍需选择 `enum / level / text` 中的一种值类型。

### 4.1 数值如何提供给 AI

数据库中的数值用于排序、比较、画曲线和检测突变，不应作为没有解释的裸数字直接交给 AI。提示词构建器必须把数值转换为“数值 + 语义级别 + 行为约束 + 趋势 + 原因”。

错误示例：

```text
A 对 B 的怀疑是 70。
```

推荐示例：

```text
A 对 B 的怀疑：70/100（强烈，正在上升）。
行为表现：A 默认不采信 B 的解释，会主动寻找旁证，但当前证据不足以公开定罪。
变化原因：第9章在 B 的书房发现染血收据，怀疑由 20 上升到 70。
本章边界：第10章可以继续验证或强化怀疑，但不能提前确认 B 有罪，也不能提前解决第12章才爆发的身份冲突。
```

不同维度必须使用不同的行为锚点，不能共用一套模糊的“低、中、高”：

| 维度 | 高值的行为语义示例 |
|---|---|
| `relationship.trust` | 愿意托付重要信息、承担风险或在证据不足时维护对方 |
| `relationship.suspicion` | 不采信表面解释、主动验证、保留证据，但不等于已经敌对 |
| `relationship.hostility` | 主动阻碍或伤害对方；是否公开行动仍受实力、场合和目标约束 |
| `relationship.affection` | 优先考虑对方利益、关注其情绪和安全；不自动等于恋爱关系 |
| `character.pressure` | 高压力影响判断、耐心和行动选择，但具体反应仍由性格决定 |
| `conflict.intensity` | 冲突对行动和场景的支配程度；高强度不必然等于战斗场面 |

提示词构建时至少输出：

```ts
interface PromptDimensionContext {
  dimension: string
  numericValue: number | null
  levelLabel: string
  behaviorGuide: string
  trend: 'rising' | 'stable' | 'falling'
  previousValue: unknown
  changeReason: string
  allowedThisChapter: string[]
  forbiddenThisChapter: string[]
}
```

AI 写回变化时优先要求输出语义级别、变化方向和原因，再由系统映射或校验数值。不要让模型随意生成“从 63 变成 67”这类没有叙事意义的精度。默认使用五档语义锚点，只有强度曲线等明确场景才允许更细数值。

---

## 5. 跨章节表达模型

跨章节内容分为四类，不能统一当作一个跨度处理。

### 5.1 点事件

在某个章节或场景发生一次：发现线索、物品转移、关系转折、人物做出选择。

- 存储：`StoryEvent + ChangeRecord`
- 显示：节点或菱形标记
- 移动：改变事件章节；其变化记录跟随移动
- 不允许通过拉伸把点事件变成持续状态

### 5.2 持续状态

从一次变化生效，直到下一次同维度变化：A 从第 5 章开始怀疑 B，直到第 12 章确认或解除。

- 存储：只保存第 5 章和第 12 章的变化，不复制第 6-11 章
- 显示：由相邻变化投影为连续色带
- 结束：下一次变化自动结束上一段
- 删除后继变化：上一状态继续向后延伸

### 5.3 阶段片段

有明确起止并允许非连续：冲突潜伏期、调查阶段、物品被封印期间、角色暂时失踪。

- 存储：阶段进入和阶段退出变化，或由兼容字段 `chapterSpans` 导入
- 显示：可拖动、缩放、拆分的片段
- 非连续：同一实体允许多个片段，中间留空
- 相邻同状态片段：默认提示合并，不强制合并

### 5.4 复合事件

一个叙事过程跨越多章，但每章都有不同动作，例如“调查密室”持续第 8-12 章。

- 不保存成一个没有内部信息的五章长事件
- 创建父事件作为复合容器
- 每个真实推进点保存为子事件
- 总览显示父事件跨度，聚焦模式显示子事件和变化

```text
调查密室（第8-12章）
├─ 第8章：获得钥匙
├─ 第9章：确认入口
├─ 第10章：遭遇阻拦
├─ 第11章：破解机关
└─ 第12章：进入密室并发现真相
```

### 5.5 生成第 N 章时的时间切片

生成第 10 章不能只查询“第 10 章有哪些记录”，必须先计算第 10 章开始前的故事状态，再叠加本章计划与未来边界。

读取顺序：

1. 以第 9 章章末快照作为基础。
2. 对没有快照或快照之后发生变化的维度，按 `chapterNumber + sceneOrder` 重放变化账本。
3. 查找第 10 章仍然有效的持续状态和阶段片段。
4. 加载第 10 章计划事件及预期变化。
5. 加载尚未解决的冲突、伏笔、线索、物品状态、人物目标和信息差。
6. 加载第 10 章之后已经确定的爆发、回收、转移或揭示边界，作为“不得提前发生”的约束。

某个维度在第 10 章章初的状态计算规则：

```text
stateBeforeChapter(10, subject, dimension, target)
= 第10章之前按 chapterNumber、sceneOrder 排序后的最后一个 afterValue
```

持续状态不逐章复制。例如钥匙第 8 章由 B 转移给 A，且第 10 章之前没有再次转移，则第 10 章章初拥有者自然为 A。冲突第 7 章进入升级阶段，第 12 章才爆发，则第 10 章仍为升级阶段，同时“第 12 章爆发”作为未来承诺，不能被 Writer 提前解决。

建议的章节上下文结构：

```ts
interface ChapterStoryContext {
  projectId: string
  chapterNumber: number
  snapshotVersion: number
  stateBeforeChapter: StoryStateSnapshot
  activeThreads: ActiveStoryThread[]
  plannedEvents: StoryEvent[]
  plannedChanges: ChangeRecord[]
  unresolvedDebts: NarrativeDebt[]
  futureCommitments: FutureCommitment[]
  promptDimensions: PromptDimensionContext[]
  annotations: NovelAnnotation[]
  continuityWarnings: ContinuityWarning[]
}
```

提供给 Writer 时必须分区，不能混成一段无优先级资料：

```text
已经成立的事实
本章必须推进的事件与变化
本章仍然活跃的跨章节内容
不得违反或提前兑现的边界
后续章节已经承诺的节点
明确允许进入提示词的作者批注
```

第 10 章生成完成后，Memory 提取实际事件和变化；Reviewer 对比 `plannedChanges` 与实际结果。确认后生成第 10 章章末快照。重新生成第 10 章时携带 `snapshotVersion`，防止旧生成结果覆盖期间发生的新编辑。

---

## 6. 跨章节编辑规则

### 6.1 拖动片段

- 拖动父复合片段时，默认整体平移所有未锁定子事件。
- 已生成正文或人工确认的事件视为“已落地”，整体平移前必须二次确认。
- 按住修饰键拖动时只移动父片段规划窗口，不移动已存在子事件。
- 移动后校验伏笔先埋后收、线索先发现后使用、物品转移顺序和章节边界。

### 6.2 调整起止

- 调整持续状态起点：移动产生该状态的变化事件。
- 调整持续状态终点：移动下一次状态变化；不存在后继变化时创建显式结束事件。
- 调整复合事件边界：只改变规划窗口，不自动创造或删除子事件。
- 缩短边界导致子事件落在窗口外时，提示“移动子事件 / 扩展窗口 / 取消”。

### 6.3 拆分与合并

- “在当前章节拆分”创建两个阶段片段，保留同一父实体。
- 合并仅允许相邻、同维度、同状态且中间没有冲突变化的片段。
- 合并复合事件时保留所有子事件，按章节和场景顺序重新排序。

### 6.4 重叠处理

不同维度可以重叠；同一维度是否允许重叠由维度规则决定：

| 维度 | 重叠规则 |
|---|---|
| 物品拥有者 | 排他，同一时刻只能有一个拥有者 |
| 物品状态 | 排他，后事件覆盖前状态 |
| 冲突参与者 | 可叠加 |
| 角色目标 | 默认一个主目标，可叠加多个次目标 |
| 人物关系维度 | 每个方向、每个维度只有一个当前值 |
| 已知线索集合 | 可叠加，按集合增删计算 |
| 地点出场 | 同一场景排他；同一章节不同场景可不同 |

同一章节内发生多次变化时按 `sceneOrder` 排序；章节矩阵显示章末状态，聚焦模式显示每次变化。

---

## 7. 矩阵信息架构

### 7.1 总览模式

页面组成：

```text
顶部：视图模式、章节范围、实体过滤、缩放、搜索、批注过滤
左侧固定列：分组、实体名称、当前状态摘要
中部章节轴：变化节点、阶段片段、复合事件色带
右侧检查器：选中实体/事件/变化的详情
```

分组顺序建议：角色、人物关系、冲突、线索、伏笔、物品、势力、地点、世界要素、信息差。

默认每个实体一行。总览只显示：

- 关键变化节点
- 当前章节范围内的阶段色带
- 高显著度事件
- 未解决批注提示

### 7.2 聚焦复合轨道

双击实体或选择“在复合轨道中编辑”进入聚焦模式：

- 其他实体行隐藏，不只是折叠到很小
- 章节标尺、播放头和过滤范围保持不变
- 顶部显示返回路径：`矩阵 > 冲突 > 身份暴露`
- 左侧显示实体摘要和子轨道名称
- 右侧检查器编辑选中的事件或变化

不同实体使用配置化轨道模板：

| 实体 | 默认子轨道 |
|---|---|
| 角色 | 出场、目标、状态、压力、弧光、认知、关系、持有物、关键选择 |
| 关系 | 关系阶段、信任、怀疑、敌意、情感、关键事件 |
| 冲突 | 阶段、强度、参与方、赌注、转折、结果 |
| 伏笔 | 埋设、强化、揭示、回收、关联线索、信息差 |
| 线索 | 发现、持有人、知情者、验证、误导、使用结果 |
| 物品 | 持有人、位置、状态、使用、能力变化、关联伏笔/线索 |
| 势力 | 阵营、控制范围、成员、实力、冲突参与 |
| 地点 | 出场场景、控制方、可访问性、状态变化、发生事件 |

空轨道不占固定高度；用户可以显示或隐藏次要轨道。

### 7.3 缩放层级

- 远景：只显示密度、张力和高显著度变化
- 中景：显示阶段色带、关系趋势和主要节点
- 近景：显示事件标题、前后值、批注和场景顺序

---

## 8. 交互流程

### 8.1 新增一个变化

用户路径：选择实体行和章节 → 点击新增或双击空白 → 选择变化类型 → 填写前后状态、原因和关联实体 → 保存。

系统行为：

1. 自动读取该章节之前的当前值作为 `beforeValue`。
2. 用户填写 `afterValue`，或选择“增加/减少”由系统计算。
3. 可关联现有事件；没有事件时快速创建事件。
4. 保存事件、变化记录和实体当前快照。
5. 重新投影矩阵，并运行局部一致性检查。

### 8.2 新增人物关系变化

用户路径：角色聚焦轨道 → 关系轨道 → 新增变化 → 选择目标角色和维度 → 设置变化级别 → 选择触发事件或填写原因。

用户不需要画线。保存后关系图自动出现或更新连线。若从关系图拖线创建，则拖线只是快捷入口，释放后仍打开同一个关系变化表单。

### 8.3 物品转移

用户路径：物品聚焦轨道或场景事件 → 选择“转移” → 选择原持有人、新持有人、章节和原因。

系统同时生成：

- 物品 `owner` 引用变化
- 事件参与方关联
- 矩阵转移节点
- 新旧持有人的物品子轨道变化

### 8.4 添加批注

用户路径：右键实体、单元格、节点、色带或关系 → 添加批注 → 选择类型 → 输入内容 → 决定是否提供给 AI。

显示规则：

- 单元格批注显示角标
- 点事件批注显示节点旁标记
- 跨章节批注显示覆盖范围但不遮挡色带
- 已解决批注默认隐藏，可通过过滤器查看
- `warning/question/todo` 在批注面板按优先级聚合

---

## 9. 关系处理规则

关系分为三类：

1. **静态结构关系**：亲属、师徒、所属势力、地点层级。允许手动创建，保存在关系表或现有 `novel_edges`。
2. **动态状态关系**：信任、怀疑、敌意、依赖、爱慕。通过 `ChangeRecord` 记录变化。
3. **事件关联关系**：参与、触发、证据、资源、受影响对象。通过 `StoryEventEntityRef` 记录。

关系图只做投影：

- 静态关系直接形成边
- 动态关系以指定章节的最新状态形成边
- 事件关联默认不全部显示；选中事件时显示
- 用户手动画线时必须选择静态关系或创建动态变化，不保存无语义连线

---

## 10. 数据一致性与校验

保存变化后至少运行以下规则：

- 同一场景同一物品不能有两个持有人
- 角色不能使用尚未获得或已经销毁的物品
- 角色不能使用自己尚不知道的线索
- 线索不能在发现前被验证或使用
- 伏笔不能在埋设前强化或回收
- 冲突阶段跳跃必须符合 `progressionMode` 或填写跳跃原因
- 关系数值必须在维度范围内
- 事件的 `beforeValue` 必须与前一状态一致，否则标记并发冲突
- 删除事件时必须展示它产生的变化和下游因果影响
- 调整章节后必须重新校验所有因果先后顺序

校验结果只阻止确定性的事实冲突；文学选择类问题使用警告，不强制阻止保存。

---

## 11. 存储演进方案

### 11.1 新增表

建议新增：

- `novel_story_events`
- `novel_story_event_entities`
- `novel_annotations`

### 11.2 扩展现有表

`novel_memory_events` 增加：

- `story_event_id`
- `scene_order`
- `dimension`
- `target_entity_type`
- `target_entity_id`
- `value_type`
- `source`

复用现有 `old_value/new_value/cause/significance`，不重新创建含义相同的字段。

`novel_edges` 暂时保留，只承担静态关系和兼容旧的手动连线。动态关系不再新增裸 edge。

### 11.3 旧数据迁移

| 旧数据 | 新投影 |
|---|---|
| `novel_character_history` | 角色 `ChangeRecord` |
| `relationship.stageHistory` | 关系阶段 `ChangeRecord` |
| `character.arcHistory` | 角色弧光 `ChangeRecord` |
| `foreshadow.beats` | 伏笔 `StoryEvent + ChangeRecord` |
| `conflict.intensityPoints` 等 | 冲突变化记录 |
| `chapterSpans` | 兼容阶段片段；逐步回填进入/退出变化 |
| `novel_markers` 的 `clip-note` | `NovelAnnotation` |
| `NovelItem.ownerId/status` | 初始快照；后续修改必须记录变化 |

迁移顺序：新增结构 → 双写 → 回填 → 新旧投影对比 → 新读路径 → 停止写旧历史 → 最后再评估删除。

---

## 12. 页面接口清单

接口前缀继续使用 `/api/plugins/novel`。下表中“新增”表示本方案需要实现，“复用”表示已有接口继续使用。

### 12.1 矩阵总览页

用户路径：进入小说工作区 → 打开矩阵 → 选择章节范围和实体过滤 → 浏览变化 → 选择实体或进入聚焦模式。

| 状态 | 方法 | 路径 | 主要字段或结果 |
|---|---|---|---|
| 新增 | GET | `/projects/:projectId/story-matrix` | `chapterStart/chapterEnd/entityTypes/significance`; 返回分组、实体行、阶段片段、变化节点、批注计数 |
| 新增 | GET | `/projects/:projectId/story-events` | 按章节、实体、状态查询事件 |
| 新增 | POST | `/projects/:projectId/story-events` | 创建事件及实体关联 |
| 新增 | PATCH | `/story-events/:eventId` | 移动章节、修改场景顺序、标题、结果和状态 |
| 新增 | DELETE | `/story-events/:eventId` | 返回删除影响；确认后删除或标记 superseded |

矩阵投影内部复用的实体接口和关键字段：

| 方法 | 路径 | 矩阵使用字段 |
|---|---|---|
| GET | `/projects/:projectId/characters` | `id/name/currentState/currentGoal/currentPressure/arcStage/arcHistory/participatingConflicts` |
| GET | `/projects/:projectId/relationships` | `characterA/characterB/relationType/currentStage/stageHistory/alignment/trend/lastUpdatedChapter` |
| GET | `/projects/:projectId/conflicts` | `stage/intensity/participants/chapterSpans/climaxChapter/turningPoints/intensityPoints/resolutionProgress/linkedClues` |
| GET | `/projects/:projectId/foreshadowing` | `status/firstChapter/recoverByChapter/linkedCharacters/linkedClues/linkedInfoLayers/beats/resolutionPoints` |
| GET | `/projects/:projectId/clues` | `pointsTo/progress/currentStep/nextStep/isMisleading/linkedForeshadow/chapterSpans` |
| GET | `/projects/:projectId/items` | `name/type/ownerId/status/abilities/origin/firstChapter/chapterSpans` |
| GET | `/projects/:projectId/factions` | 名称、阵营、首领、成员、盟友、敌对方和章节跨度 |
| GET | `/projects/:projectId/locations` | 名称、父地点、所属势力和出现章节 |
| GET | `/projects/:projectId/world-elements` | `category/name/parentId/attributes` |
| GET | `/projects/:projectId/world-rules` | 世界规则类别、规则内容、约束和状态字段 |
| GET | `/projects/:projectId/info-layers` | 信息内容、知情方、被隐瞒方、揭示计划和关联伏笔 |

### 12.2 聚焦复合轨道页

用户路径：矩阵双击实体 → 查看该实体子轨道 → 新增/移动/拆分变化 → 保存 → 返回矩阵。

| 状态 | 方法 | 路径 | 主要字段或结果 |
|---|---|---|---|
| 新增 | GET | `/projects/:projectId/entities/:entityType/:entityId/timeline` | 事件、变化、持续状态投影、关联实体和批注 |
| 新增 | POST | `/projects/:projectId/change-records` | 单条变化；含 subject、dimension、target、before/after、reason |
| 新增 | POST | `/projects/:projectId/change-records/batch` | 一个事件中的多条原子变化，事务写入 |
| 新增 | PATCH | `/change-records/:changeId` | 修改章节、场景顺序、前后值和原因 |
| 新增 | DELETE | `/change-records/:changeId` | 删除后重算后续状态并返回影响 |
| 复用 | GET | `/projects/:projectId/memory-events/timeline/:entityId` | 迁移期兼容旧时间线 |
| 复用 | GET | `/projects/:projectId/memory-events/causal/:eventId` | 迁移期兼容因果查询 |

### 12.3 批注面板

用户路径：右键矩阵元素添加批注，或打开批注面板筛选未处理事项。

| 状态 | 方法 | 路径 | 主要字段或结果 |
|---|---|---|---|
| 新增 | GET | `/projects/:projectId/annotations` | scope、章节范围、类型、resolved、includeInPrompt 过滤 |
| 新增 | POST | `/projects/:projectId/annotations` | 创建实体/事件/变化/关系/跨度批注 |
| 新增 | PATCH | `/annotations/:annotationId` | 内容、类型、颜色、是否进入提示词、解决状态 |
| 新增 | DELETE | `/annotations/:annotationId` | 删除批注，不影响故事事实 |
| 复用 | GET/POST/PATCH | marker 接口 | 仅作旧 `clip-note` 兼容，迁移后不再承担新批注 |

### 12.4 关系投影页（后续可选）

用户路径：从矩阵选择实体 → 查看关系 → 切换章节快照 → 必要时创建静态关系或动态变化。

| 状态 | 方法 | 路径 | 主要字段或结果 |
|---|---|---|---|
| 复用 | GET | `/projects/:projectId/graph/nodes` | 项目全部轻量图节点 |
| 复用 | GET | `/projects/:projectId/graph/edges` | 手动边、实体字段派生边和角色语义关系 |
| 复用 | GET | `/graph/neighbors/:entityId` | 可用 `edgeTypes` 过滤的一跳邻居 |
| 复用 | GET | `/graph/path/:fromId/:toId` | `maxDepth` 限制下的最短关系路径 |
| 复用 | GET | `/graph/entity-chapters/:entityId` | `entityType` 指定实体的出现章节 |
| 新增 | GET | `/projects/:projectId/relationship-graph?chapterNumber=` | 指定章节的动态关系状态和事件证据 |
| 复用 | POST | `/projects/:projectId/relationships` | 创建角色静态/语义关系 |
| 复用 | POST | `/projects/:projectId/edges` | 创建静态结构边；禁止用作无语义动态变化 |
| 新增 | POST | `/projects/:projectId/change-records` | 从图连线创建动态关系变化 |

现有图接口的 `nodeType/sourceType/targetType` 校验尚未完整接受 `item`，`edgeType` 校验也只覆盖早期八类关系。关系图接入物品前必须先扩展共享类型、路由 schema、前端节点类型和自动边投影，不能只在 UI 中增加物品节点。

### 12.5 AI 创作与外部系统

用户路径：完成矩阵编排与变化计划 → 发起章节创作 → Writer 获取章前状态、计划事件、批注和目标变化 → Memory 写回实际变化。

| 状态 | 方法/系统 | 复用或新增 |
|---|---|---|
| 新增 | `GET /projects/:projectId/chapters/:chapterNumber/story-context` | 返回章前快照、活跃跨章内容、本章计划、未来承诺、语义化数值和连续性警告 |
| 复用 | `create-flow` / `create-discussion` | 继续复用 AG-UI/SSE 和检查点 |
| 扩展 | prompt builder | 注入章前快照、计划事件、未完成变化、数值的行为语义和 `includeInPrompt=true` 批注 |
| 扩展 | memory generator | 产出 `StoryEvent + ChangeRecord[]`，并更新实体快照 |
| 扩展 | Reviewer | 对比计划变化和实际变化，检查提前解决、遗漏推进和数值突变 |
| 复用 | LLM Provider Session | Director、Writer、Reviewer、Memory 等继续通过统一 Provider 调用外部模型 |
| 复用 | SQLite | 继续作为本地事实存储，不引入外部图数据库 |
| 复用 | React Flow | 仅用于可选关系投影视图 |
| 已选型 | `@svar-ui/react-gantt@2.7.1`（MIT） | 负责固定列、虚拟化、滚动、缩放、片段拖动和层级行；多个阶段使用独立子任务，避免依赖 PRO Split Tasks |

---

## 13. 接口复用合理性

- 所有实体详情与当前快照继续复用现有 CRUD，不为矩阵重复创建“矩阵实体接口”。
- 所有实体类型共用 `story-events`、`change-records` 和 `annotations`，避免角色、冲突、物品各建一套相似接口。
- 矩阵总览和复合轨道共用变化账本；前者读取压缩投影，后者读取完整时间线。
- 关系图复用同一变化记录，不单独保存动态边，避免双重真相源。
- 批注不复用 marker 作为长期模型，因为 marker 无法稳定锚定事件、变化和关系；仅保留兼容读写。
- AI 写回和人工编辑共用批量变化接口及校验服务，不能各自实现一套更新逻辑。

---

## 14. 待确认与模糊项

以下问题会影响最终交互或存储，实施前需要固定默认规则：

1. **场景粒度**：当前章节是否已有稳定 scene ID；若没有，第一阶段用 `sceneOrder`，后续再关联场景实体。
2. **已生成章节锁定**：建议已确认正文中的事件默认锁定，移动时明确提示可能导致正文与账本不一致。
3. **关系方向性**：信任、怀疑、依赖必须有方向；亲属、同盟可配置为对称。
4. **主目标重叠**：建议同一场景只有一个主目标，但允许多个次目标。
5. **章内多次转移**：物品可能在同一章多次换手，必须依赖场景顺序，矩阵总览只展示章末持有人。
6. **批注进入提示词**：默认关闭；只有用户显式勾选或类型为 `intent` 时才进入 AI 上下文。
7. **AI 提取可信度**：AI 提取的事件和变化先标记 `ai-extracted`，低置信度进入待确认队列，不直接覆盖人工事实。
8. **矩阵直接拖动的权威性**：移动简单点事件可直接保存；涉及多条变化或已生成正文时必须打开确认摘要。

---

## 15. 分阶段实施与验收

实施状态说明：阶段 A 的存储、接口、手工事件录入、章节上下文和提示词接入已完成；阶段 B 已完成聚焦轨道与账本叠加，但总览账本投影、拆分/合并和锁定确认仍未完成；阶段 C 仅完成 Writer 上下文读取，Memory 确认队列和动态关系投影仍待实现。

### 阶段 A：事件账本闭环

- 新增 StoryEvent、事件实体关联、ChangeRecord 扩展和 Annotation。
- 完成手工创建事件、一组变化和批注。
- 物品转移、人物关系变化、冲突阶段变化可在事务中一次保存。
- 完成指定章节 `story-context` 时间切片，正确读取章前状态、跨章活跃内容和未来边界。
- 数值维度可以转换为行为语义，不向 AI 只提供裸分数。
- 现有实体快照仍可正常读取和编辑。

验收：第 12 章创建“书房对质”后，能同时看到 A 怀疑 B、钥匙转移、冲突升级和线索验证，删除事件时能列出这四项影响；生成第 10 章上下文时能读取第 8 章完成的物品转移、第 9 章形成的怀疑状态，以及第 12 章不得提前爆发的冲突边界。

### 阶段 B：矩阵与复合轨道

- 矩阵从变化账本生成总览。
- 双击实体进入聚焦轨道，支持点事件、持续状态、阶段片段和复合事件。
- 支持跨章节移动、缩放、拆分、合并与重叠校验。
- 批注在矩阵、轨道和右侧面板之间同步。

验收：一个跨第 8-12 章的调查复合事件可展开五个子事件；移动父片段时正确处理已锁定事件；物品拥有者没有重复。

### 阶段 C：AI 写回与可选关系图

- Writer 读取章前状态与计划变化。
- Memory 把正文结果写成事件和原子变化。
- Reviewer 检查计划变化是否兑现。
- 关系图支持按章节查看动态关系及其证据事件。

验收：生成章节后，用户可逐条确认 AI 提取的变化；确认后矩阵、实体快照和关系投影一致。

---

## 16. 最终原则

1. **变化只记录一次，所有视图从同一账本投影。**
2. **跨章节状态通过变化边界推导，不逐章复制。**
3. **复杂过程用复合事件和子事件表达，不用空洞长色带代替。**
4. **关系线是结果，不是主要数据。**
5. **批注与事实分离，进入 AI 上下文必须显式控制。**
6. **现有实体表保留，迁移采用双写和对比，不一次性推翻。**

---

## 17. 需求覆盖检查

| 需求点 | 方案位置 | 主要接口或实现 |
|---|---|---|
| 所有小说要素在一个矩阵展示 | 7.1 总览模式 | `GET /projects/:projectId/story-matrix`，复用全部实体列表接口 |
| 角色、冲突、伏笔、线索、物品相互关联 | 3.2、3.3、9 | StoryEventEntityRef、ChangeRecord、关系投影接口 |
| 关系不是全部手动画线 | 8.2、9 | 关系变化表单写 ChangeRecord，图边自动投影 |
| 可手动添加自定义关系 | 4、8.2、9 | 静态关系复用 relationships/edges；动态关系使用 dimension + valueType |
| 子轨道记录实体变化 | 7.2 | 实体 timeline + change-records 接口 |
| 编辑时只显示复合轨道 | 7.2 | 聚焦模式隐藏其他实体行，保留章节标尺和检查器 |
| 跨越多章节 | 5、6 | 点事件、持续状态、阶段片段、复合事件四类处理 |
| 多阶段、非连续跨度 | 5.3、6.3、6.4 | 拆分、合并、重叠规则和变化边界投影 |
| 物品归属、转移、使用和状态 | 4、7.2、8.3 | items CRUD + 原子变化批量接口 |
| A 怀疑 B 的原因与结果 | 3.3、8.2 | subject/target/dimension + StoryEvent trigger/outcome |
| 为实体、节点、关系、跨度添加批注 | 3.4、8.4、12.3 | annotations CRUD；旧 marker 只做兼容 |
| 批注是否进入写作上下文 | 3.4、8.4、12.5 | `includeInPrompt`，默认不注入 |
| 变化驱动 AI 写作 | 12.5、15 阶段 C | prompt builder 扩展 + memory generator 写回 |
| 生成中间章节时读取跨章节状态 | 5.5、12.5、15 阶段 A | `story-context` 时间切片、章前快照、未来承诺 |
| AI 理解强度数字 | 4.1、12.5 | 数值转换为级别、行为约束、趋势、原因与本章边界 |
| 不推翻现有存储 | 11 | 新增结构、双写、回填、新旧投影对比 |
| 外部系统引用 | 12.5 | LLM Provider、AG-UI/SSE、SQLite、React Flow、待选 Timeline/Gantt |
| 接口复用合理性 | 13 | 实体 CRUD、统一事件/变化/批注接口、关系派生规则 |
| 模糊需求单列 | 14 | 场景粒度、锁定规则、关系方向、章内顺序、AI 可信度等 |
