# 故事矩阵统一引擎 · 设计文档

> 本文替代并修正 `STORY_MATRIX_EVENT_LEDGER_DESIGN.md`。
> 结论经过三轮基于代码的事实核查，推翻了原方案与初版审查中的两个错误前提。

## 1. 背景：为什么对现状不满意

当前矩阵有两套割裂的实现：

- `MatrixView`（自绘 CSS Grid + dnd-kit + SVG）——折叠态总览，读**实体快照字段**（`chapterSpans` / `plantChapter` / `appearChapters`）。
- `EntityGanttFocus`（`@svar-ui/react-gantt`）——展开态聚焦，读 `getEntityStoryTimeline` **账本**。

两套技术栈、两套交互、两套数据源。同一个冲突，折叠态和展开态来自不同数据，视觉与语义都会跳变。这是"对整个矩阵不满意"的根源。

## 2. 核心发现：账本管道没断，是被一道 WHERE 劈开了

初版审查曾断言"AI 生成时零处写账本"。**这个结论是错的。** 事实核查结果：

`ChapterFinalizer`（每章生成收尾必经）有 30+ 处 `recordEvent` 调用，角色/冲突/伏笔/线索/势力/地点/关系/信息差的每处变更都在写。`eventType` 覆盖 8 类 `*_change`。

关键在于：`recordEvent`（AI 自动，海量）与 `createChangeRecord`（手动，稀少）**写的是同一张表 `novel_memory_events`**，但前者**不填 `dimension` 字段**。而账本查询 `listChangeRecords` 的第一道过滤条件就是 `dimension IS NOT NULL`。

| 字段 | recordEvent（AI 自动） | createChangeRecord（手动） |
|---|---|---|
| entity_id / entity_type | ✅ | ✅（叫 subject） |
| old_value / new_value | ✅ | ✅ |
| significance | ✅ | ✅ |
| **dimension** | ❌ NULL | ✅ |
| value_type / target / scene_order | ❌ | ✅ |

**真相：AI 每章写入了大量变更事件，但因为没填 `dimension`，全被账本查询过滤掉了。数据一直在，矩阵账本视图看不见它们。** 问题不是两张表打架，是同一张表的两种写法打架。

## 3. 方案总纲（方向 A：统一轨道引擎）

分五步，从后端接头到前端统一，每步可独立验证：

1. **接头**（后端）：`recordEvent` 内部集中推断并回填 `dimension` + `value_type`。
2. **回填**（后端）：一次性迁移脚本，为历史无 `dimension` 事件补字段。
3. **统一数据源**（前端）：折叠态总览改用账本投影，与展开态同源。
4. **统一渲染**（前端）：消除双引擎，inline 展开子轨道。
5. **增量**（前端）：关系叠加层 + 文风挂接。

## 4. 第一步 · 接头：dimension 集中推断

在 `recordEvent` 内部按 `eventType` + `new_value` 字段名集中推断，不散落到 30+ 调用点。规则表：

| eventType | new_value 字段 | dimension | value_type |
|---|---|---|---|
| character_change | arcStage | character.arc_stage | enum |
| character_change | currentGoal | character.goal | text |
| character_change | currentPressure | character.pressure | level |
| character_change | currentState | character.state | text |
| character_change | secret / longTermDesire | character.cognition | text |
| character_change | participatingConflicts | character.conflict_link | set |
| conflict_change | stage | conflict.stage | enum |
| conflict_change | intensity | conflict.intensity | level |
| conflict_change | (创建) | conflict.created | reference |
| foreshadow_change | (plant/reinforce/payoff) | foreshadow.beat | enum |
| clue_change | progress | clue.progress | number |
| faction_change | * | faction.activity | text |
| location_change | * | location.appear | reference |
| relationship_change | * | character.relationship | reference |
| info_layer_change | * | info_layer.state | enum |

推断函数 `inferDimension(eventType, newValueKeys)` 为纯函数，独立单测。无法匹配时留 `NULL`（保持旧行为，不误伤）。

## 5. 第二步 · 回填迁移

一次性脚本遍历 `novel_memory_events` 中 `dimension IS NULL` 的行，复用 `inferDimension` 规则回填。幂等：已填的跳过。无法推断的保持 NULL。迁移前备份，提供 dry-run 统计。

## 6. 第三步 · 统一数据源

折叠态总览废弃实体快照字段作为数据源，改用账本投影：

- **持续状态色带**：从账本 `stage/appearance` 类维度投影出活跃区间。
- **变化热度**：按章节聚合该实体 ChangeRecord 数量，色深 = 变化多。
- **关键节点**：`plant/payoff/climax/arc转折` 用 icon 标记。

需要新增一个**矩阵级聚合接口**（现有只有单实体 timeline 和单章节 context），一次返回全实体 × 全章节的账本投影。

## 7. 第四步 · 统一渲染

用一套 CSS Grid + SVG 渲染层替代双引擎：

- 折叠态：密度色带 + 关键节点。
- inline 展开：原行下方插入子轨道组，其他实体行仍可见（复合轨道隐喻）。
- 每个 `dimension` 一条子轨道，类型分 band / curve / node / relationship。
- 拖拽从 4 拖源 × 9 实体简化为 2 拖源（band-drag / node-drag）× 统一 `DimensionDragData`。

## 8. 第五步 · 增量能力

- **关系**：角色行"关系"子轨道 + 可切换的全局关系叠加层。
- **文风**：`ChangeRecord` 增 `styleNote?` 字段（后端需加）；写作时 prompt builder 按 `变化骨架 + styleNote（fallback 维度模板）` 组装。

## 9. 风险与验证

- **第一步验证点**：接头后，查冲突实体账本是否立即有数据。有 → 地基成立；异常 → 检查推断规则。
- **回填风险**：迁移前备份 + dry-run。
- **渲染性能**：百章 × 数十实体聚合，需在聚合接口做分页/裁剪。

## 10. 实施顺序

先做第 1–2 步（后端接头 + 回填），用**冲突单实体**验证账本投影跑通，再推进第 3–4 步前端统一，最后第 5 步增量。

