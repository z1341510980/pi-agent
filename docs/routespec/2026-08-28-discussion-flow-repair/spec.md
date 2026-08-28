# 方案：群聊 create-discussion 链路重排

## 目标

让 `create-discussion` 从"能跑通测试但实际不可用"回到可用，并把流程从 Moderator 中心化残留改成动作图直驱：

1. planning 阶段不再由 Moderator 轮询点名 Director，改为引擎直呼 Director → 工具提交 → 直接进 acting。
2. acting 阶段"节点未完成 / 角色回合无效"默认降级继续，不整章 throw；末尾以显式警告 + 诊断把判断权交回用户。
3. 角色自主 mention 不再要求"被 mention 者预先拥有未完成 actionBeat"，改为独立的回应回合。
4. 修掉前端工具主路径气泡问题（空占位、重复、永久 streaming）。
5. 压掉不必要的 LLM 往返与等待，让一次 5 场景运行的耗时和调用量可控可观测。

## 范围

- 内：
  - `TeamDiscussionEngine.run()` 的 planning 阶段重写（去 Moderator 循环）。
  - `runActionBeatScene()` 的失败/未完成语义改为降级继续 + 汇总告警。
  - mention 队列的回应回合语义（不绑定 actionBeat）。
  - Moderator 定位收窄为纯异常仲裁器（acting）；planning 不再调用。
  - 前端 `agent_output` 占位覆盖与去重（director / character / moderator）。
  - 诊断字段补齐：planning 直呼次数、降级继续次数、mention 回应回合数、未完成节点明细。
  - 首跑与 resume 的失败语义、断点字段对齐。
- 外：
  - 不改 Director 动作图协议本身（`novel_submit_scene_plan` 的 actionBeats schema 保持）。
  - 不改角色回合工具 schema（`novel_submit_character_turn` 字段不变）。
  - 不改 Writer 一次性全章编织策略。
  - 不改 SSE 端点路径与请求体契约（`create-discussion` / `create-discussion/:runId/resume`）。
  - 不引入跨章节自动规划、不改卷级节拍。
  - 不删除 legacy 路径（旧快照无 actionBeats 仍走有界 legacy acting）。

## 假设

- Director 是 planning 阶段唯一需要 LLM 的成员，因此该阶段的 Moderator 调用没有信息增益，可直接删除。
- 用户选择"降级继续"意味着：只要有任一场景产出了有效角色演出，就允许进 Writer；全场零演出仍然硬失败（避免完全盲写）。
- mention 回应回合复用触发它的 actionBeat 作为压力上下文，不新建节点；预算与去环规则不变。
- 路由图现有条目「群聊共创演绎链路（动作图 + 自主 mention）」的入口 URL 写错（`discuss-flow`），实际是 `create-discussion`，本次一并纠正。

## 当前行为

- planning：`while (rounds < maxRounds)` 内每轮先 `moderator.decide()`，再 `handleDecision` 邀请 Director。Moderator 在 planning 只被允许点 Director（`enforceDecision` 硬纠偏 + `handleDecision` 二次拒绝非 Director），即每次 Director 调用前都白付一次 Moderator LLM 往返（含双次重试与 90s 超时预算）。maxRounds 当前库内设置为 50。
- Director 走工具主路径时终答为空（已实证 gpt-5.6-luna），引擎靠 `currentScenePlan.extractResult()` 补救；空响应两轮则抛 `discussion_pause` 检查点，reject 即 `failed_phase=planning` 终止。库内两条 run 正是 `导演未能产出场景拆分，用户选择中止群聊`。
- acting：`runActionBeatScene()` 中角色回合失败 / `progress==='stall'` / 无 consequence 都会 `interveneForActionBeat()` 调一次 Moderator；场景末尾若有未完成节点，再调一次 Moderator，然后在 `allowLegacyActing === false`（新运行固定值）下 `throw`，整个 run 变 `error`。
- `run()` 的 Phase 2.5 还有第二道硬闸：任一场景零角色演出即 `throw`。
- mention：`pending` 出队后要求 `actionBeats.find(beat => beat.actor === target.id && !completed.has(beat.beatId))`；找不到就 `continue` 丢弃。Director 通常一个角色只安排一个节点，故绝大多数 mention 直接被丢。
- 前端：`agent_start` 建 streaming 占位气泡；工具主路径无 `TEXT_MESSAGE_*`，director 分支只覆盖"最后一条"，character 分支近期才补了 `findLastIndex` 覆盖，moderator 的 `agent_output` 无占位关联，仍可能出现重复/空气泡。
- 诊断：`DiscussionDiagnostics` 只在后端 `DiscussionResult` 上，未透出 `CreationResult`，UI 无法看到调用构成。

## 目标行为

### planning：引擎直呼 Director

```text
run()
  → buildScenePlanToolset()
  → 直呼 Director（不经 Moderator，不经 handleDecision 的 invite 分支）
  → 读工具 payload；空则一次纠正性重试（同一 prompt 骨架 + 显式格式要求）
  → 仍空 → discussion_pause 检查点（继续重试 / 中止）
  → 拿到 scenes → applyCastWhitelist → resolveSceneCharacters → 进 acting
```

- planning 阶段 Moderator 逻辑调用固定为 0；`diagnostics.plannerInvocations` 记录 Director 直呼次数。
- Director 文本回退保留：工具未提交但文本可解析时走 `parseScenes`，标 `sceneSource='markdown'` 并发降级告警。
- 检查点语义不变（approve=重试、reject=中止），但重试路径不再绕 Moderator。

### acting：降级继续

- 角色回合失败（非取消）：当前节点最多重试一次（保持现状）；仍失败标 `actor_failed`，**不再必然调 Moderator**——仅当该场景连续失败节点数达到阈值（默认 2）时才交一次 Moderator 仲裁，其余情况直接跳到下一节点。
- `progress==='stall'` 或空 consequence：视为该节点未完成，记入 `incompleteBeats`，继续下一节点，不调 Moderator。
- 场景末尾有未完成节点：只发一条汇总告警事件 + 系统消息，**不 throw**。
- `run()` Phase 2.5 的硬闸放宽：只有"全部场景都零角色演出"才 throw；部分场景有演出时改为告警 + `diagnostics.emptyScenes` 明细，正常进 Writer。
- 取消语义不变：`AbortSignal` 立即结束，不再发起任何后续调用。

### mention：独立回应回合

- 被 mention 角色的回合不再要求存在未完成 actionBeat；改为以触发它的 `sourceBeat` 作为压力上下文发起"回应回合"。
- 该回合不标记任何 actionBeat 完成，单独计入 `diagnostics.mentionResponseTurns`。
- 保留全部有界保护：同源同目标去重、有向边 ≤2、深度 ≤3、每场 `autonomousRounds` 预算。
- 若被 mention 角色恰好有未完成节点，则该回合同时兼作该节点的完成凭证（保留现有 `completedActionBeats` 口径）。

### Moderator：仅异常仲裁

- 只在三类情形调用：actor 不在场（动作图与白名单冲突）、单场景连续失败达阈值、用户插话要求改路径。
- 保留 submit 工具主路径 + 一次文本修复轮 + 规则 fallback 与 `moderator_fallback` 计数。
- `noteModeratorDegradation` 的一次性告警保留。

### 前端气泡

- 抽出统一的"占位覆盖"辅助：按 `agentType`（+ 可选 `messageId`）找最近一条 `streaming && !hasStreamedText` 的占位并覆盖，找不到才新建。
- director / character / moderator 的 `agent_output` 共用该辅助，消除重复气泡与永久 streaming。
- `actorTurn` 私有字段继续走 `<details>` 可展开区，不进正文。

### 可观测

- `DiscussionDiagnostics` 新增：`plannerInvocations`、`degradedContinues`、`mentionResponseTurns`、`incompleteActionBeatIds`、`emptySceneIds`。
- `DiscussionResult.diagnostics` 透出到 `CreationResult`，SSE `result` 事件可读，供 UI 展示调用构成。

## 实现方向

分 6 个切片，按依赖顺序集成；T1/T2 是可用性关键路径，T3/T4 是流程质量，T5/T6 是可观测与收尾。
