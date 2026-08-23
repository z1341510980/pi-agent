# ScenePlan V2 覆盖审计与场景级重写激活路径

> 日期：2026-08-23
> 性质：P1-3 v2（场景级物理重写）的前置数据审计 + 激活路径定义
> 结论先行：**当前数据不足以支撑物理场景级重写**；已提供只读探针 `GET /projects/:id/scene-plan-coverage` 供运行时核查，激活需先完成三步使能改造（见 §3）。

---

## 1. 现状盘点（代码级审计结论）

### 1.1 场景数据的三个来源

| 来源 | 触发条件 | 数据质量 |
| --- | --- | --- |
| 主链影子写 | `scenePlanV2Write` flag 开启时，Director 首次成功与 pushback 重规划后各写一次（novel-orchestrator.ts:714/949 → `shadowWriteDirectorPlan`） | **占位拆分**：`buildScenePlanFromNarrativeTask` 把 narrativeTask 机械切分为 sceneCount 份，goal 为占位文本，无正文锚点 |
| 群聊路径 | discussion runner 完章后影子写（novel-discussion-runner.ts:387） | 场景来自真实 SceneDefinition[]（群聊按场景推演），质量高于主链，但仅限群聊生成的章节 |
| 手工计划 | `submitPlanWithScenes`（前端计划工作台保存） | 用户手工维护，质量最高但依赖人工 |

### 1.2 关键缺口：没有"场景 → 正文 span"映射

novel_scene_revisions 存储 order/title/goal/pov/targetWords，**不存储该场景在最终正文中的字符区间**。create-flow 的 Writer 是整章单次输出，场景边界在落库时即丢失。因此即使覆盖率 100%，也无法回答"S2 问题出在第 2 场景，它的正文是哪一段"。

这正是方案文档复盘（§5.6 风险 3）预判的"ScenePlan V2 边界数据质量未审计"的实质——不是行数不够，而是**缺少可定位性**。

### 1.3 已交付的探针

`GET /api/plugins/novel/projects/:projectId/scene-plan-coverage` 返回：

```json
{
  "totalChapters": 0,
  "chaptersWithScenes": 0,
  "chaptersWithApprovedPlan": 0,
  "totalSceneRevisions": 0,
  "avgSceneCountPerChapter": null,
  "sceneRewriteReady": false
}
```

`sceneRewriteReady = 有场景行 且 平均场景数 ≥ 2`。这是**必要条件探针**，不是充分条件——可定位性（§2 步骤 2）完成前它不能作为 v2 开关。

---

## 2. 激活路径：三步使能改造

### 步骤 1：让 Director 输出真实场景锚点（低成本）

role-director 的场景契约已要求写"场景入口：从哪个动作、物件、声音开始"。把这一句结构化为 `scenes[].entryAnchor` 字段（每场一句 8-20 字的开头白描），随 `novel_submit_narrative_task` 提交并进入 ScenePlan。

### 步骤 2：正文锚点定位 + span 回写（中成本）

Writer 完章后运行确定性定位器：对每个 entryAnchor 在正文中做模糊匹配（去空白/标点归一后的子串或编辑距离 ≤2），命中则记录 `[start, end)` 区间到 scene_revisions 新列（迁移 118）。未命中的场景标记 `unlocated`——覆盖率探针同步增加 `locatedScenesRatio`。

### 步骤 3：S2 场景级重写路径（高价值）

修订路由升级为三档：

| 最高严重度 | 行为 |
| --- | --- |
| S1 | 整章 rewrite（现状不变） |
| S2 且 locatedScenesRatio ≥ 阈值 | **物理场景重写**：只重生成问题所在场景——输入 = 该场景 goal/cast/pov + 前一场景结尾 200 字 + 后一场景开头 200 字 + S2 问题清单；输出替换对应 span，前后拼接处各留 1 句过渡校验 |
| S2 但场景不可定位 | 现有指令级整段组重写（P1-3 v1 已上线，作为回退） |
| S3/S4 | 最小改动补丁（不变） |

---

## 3. 决策建议

- **现在**：保持 P1-3 v1（指令级路由）。它在无 span 数据时已能显著改善 S2 的修复方式，且零新增风险。
- **开启 `scenePlanV2Write` 的项目**：用探针确认覆盖后，优先在群聊生成的章节上试点 v2（其场景数据天然真实）。
- **步骤 1+2 合计约一天工作量**，完成后 v2 的增量只剩步骤 3 的重生成流。建议在 A/B 盲评验证（方案 §5.7）确认 P0/P1 批次收益后再投入。
