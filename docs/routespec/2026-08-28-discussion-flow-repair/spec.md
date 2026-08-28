# 方案：群聊 create-discussion 控制平面重排

> 本文替换同目录早先的纯修补草案。路线为中间方案：只取重设计的三条核心（确定性调度器 + 后台运行 + 事件日志），暂缓统一身份空间、计划 DAG、可见性投影。

## 目标

`create-discussion` 当前"测试全绿但实际不可用"。根因不是单点 bug，而是两套控制平面并存：Moderator 的 LLM 决策循环与 Director 的动作图。2026-08-27 重构引入动作图但未拆除 Moderator，引擎里叠了五层降级（Moderator 轮询 / 动作图 / mention 队列 / Markdown 场景解析 / legacy 轮询），每层各有失败模式且互相组合。

本方案要达成：

1. 单一控制平面：调度循环里不放 LLM。Moderator 删除，异常处理换成确定性策略表 + 用户检查点。
2. 失败默认降级继续，不整章 throw；判断权在末尾交回用户。
3. 角色自主 mention 成为一等公民（追加 reaction 节点），不再与静态 actionBeats 数组打架。
4. run 脱离 HTTP 生命周期：关闭面板不再杀 run，可重连续看。
5. 状态改为 append-only 事件日志，续跑 = 重放，删除三元组断点与 transcript 反推启发式。
6. 前端气泡在工具主路径（空终答）下不再出现空占位、重复、永久 streaming。

## 范围

- 内：
  - 删除 `moderator.ts` 与 planning/acting 的 Moderator 调用路径；legacy 轮询迁入独立只读模块。
  - `TeamDiscussionEngine` 拆出确定性调度器 + 策略表；planning 改为引擎直呼 Director。
  - mention 改为向计划追加 `kind:'reaction'` 节点。
  - 新增 `novel_discussion_events` append-only 表 + 事件写入收口；状态由 fold 得出。
  - 删除 `failedPhase/failedSceneId/failedActionBeatId` 三元组与 transcript 反推完成集合逻辑。
  - run 改后台执行：`POST` 返 202 + runId；新增 `GET /runs/:id/events?from=seq` 可重连 SSE tail；检查点决策独立端点。
  - 前端：统一占位覆盖辅助；从"消费一次性流"改为"消费事件 tail"。
  - 诊断透出到 `CreationResult`。
- 外：
  - 不改 Director 动作图协议（`novel_submit_scene_plan` 的 actionBeats schema 不变）。
  - 不改角色回合工具 schema（`novel_submit_character_turn` 字段不变）。
  - 不改 Writer 一次性全章编织策略。
  - 不做统一身份空间（定角前移 / 短 key）——留待后续，先保留 `resolveCharacterMembers` 与白名单。
  - 不做完整计划 DAG 的 `after` 依赖求解——本轮 beat 仍按数组顺序，仅 reaction 挂父节点。
  - 不做可见性投影函数重写——`formatTranscriptForMember` 保持现状。
  - 不动 create-flow / ai-arrange / reverse-arrange 路径。

## 假设

- planning 阶段唯一需要 LLM 的成员是 Director，故该阶段 Moderator 调用无信息增益，可直接删除（`moderator.ts:469-483` 已硬编码"planning 只能点 Director"）。
- "降级继续"的边界：只要有任一场景产出有效角色演出即可进 Writer；全部场景零演出仍停下问用户，不静默盲写。
- reaction 回合复用触发它的父 beat 作为压力上下文，不新建 Director 节点，不标记任何 actionBeat 完成。
- 事件日志与现有 `novel_discussion_runs` 快照并存一个迭代：新 run 写事件表，旧快照仍可按旧路径续跑（只读兼容），下个迭代再删快照列。
- 后台 worker 用进程内任务表（沿用 `activeNovelChapterTasks` 语义）即可，不引入外部队列；agent-server 是单进程本地服务。
- 路由图现有条目「群聊共创演绎链路」的入口 URL 写错（记为 `discuss-flow`，实际 `create-discussion`），本次一并纠正。

## 当前行为

- planning：`while (rounds < maxRounds)` 每轮先 `moderator.decide()` 再 `handleDecision` 邀请 Director（team-discussion-engine.ts:254-265）。Moderator 在此阶段被 `enforceDecision` 与 `handleDecision` 双重限制为只能点 Director，即每次 Director 调用前白付一次 LLM 往返（含双次重试、默认 90s 超时）。库内 `maxRounds=50`。session-diag 实测单次 Moderator 往返 10.9–26.2s。
- Director 工具主路径终答为空（gpt-5.6-luna 已实证），靠 `currentScenePlan.extractResult()` 补救；两轮皆空则抛 `discussion_pause`，reject 即 `failed_phase=planning` 终止。库内两条 run 正是 `导演未能产出场景拆分，用户选择中止群聊`。
- acting：角色回合失败 / `progress==='stall'` / 空 consequence 均触发 `interveneForActionBeat()`（各调一次 Moderator）；场景末尾有未完成节点再调一次，随后在 `allowLegacyActing === false`（新 run 固定）下 `throw`，整 run 变 error（team-discussion-engine.ts:863-880）。
- `run()` Phase 2.5 第二道硬闸：任一场景零角色演出即 throw（:401-405）。
- mention：出队后要求 `actionBeats.find(beat => beat.actor === target.id && !completed.has(beat.beatId))`，找不到即丢弃（:778-787）。Director 通常一角色一节点，故自主接戏基本失效。
- 续跑：`failedPhase/failedSceneId/failedActionBeatId` 三元组 + 扫 transcript 的 `actorTurn.actionBeatId` 反推完成集合（:625-638）。该处已返工两次。
- run 绑在 SSE 请求上：`reply.raw.once('close', abortOnDisconnect)`（creation-flow-routes.ts:1256-1261），断开即 abort；结果只在末尾一次性 `save`。库内 5 条 run 有 4 条 `cancelled`。
- 前端：`agent_start` 建 streaming 占位，工具主路径无 `TEXT_MESSAGE_*`；director 分支只覆盖"最后一条"，character 分支近期才补 `findLastIndex`，moderator 的 `agent_output` 无占位关联。
- 诊断只在后端 `DiscussionResult`，未透出 `CreationResult`。

## 目标行为

### 控制平面：确定性调度器

```text
plan   := Director 一次调用产出（beats[]，顺序执行）
step   := { kind: 'plan'|'beat'|'reaction'|'weave'|'review', actorId, input, tool, maxAttempts, timeoutMs }
loop   := 取下一个可运行 step → 执行器执行 → 追加事件 → 策略表判定 → 继续
```

- 循环体内无 LLM 决策。"下一个谁说话"由 beat 顺序、reaction 队列、策略表共同决定，全部是代码。
- Moderator 删除。它原先承担的两件事分别归入：确定性策略表，以及策略判定"需要人"时抛出的 `discussion_pause` 检查点。
- planning：引擎直呼 Director → 读工具 payload → 空则一次纠正性重试 → 仍空抛检查点（approve=重试 / reject=中止）。Markdown 文本回退保留但标 `sceneSource='markdown'` 并告警。

### Step 执行器

一次 agent 调用 = 一个 Step，执行器统一负责：session 组装、工具注入、闭包 payload 捕获、空终答处理、重试预算、取消、用量与 payload 日志。调度器不接触 session。

当前"工具后空终答"在四个调用点各写一遍（Director / 角色回合 / Moderator / Reviewer），收口后只在执行器处理一次。

### 策略表取代 LLM 仲裁

| 情形 | 动作 |
| --- | --- |
| beat 两次失败（非取消） | 标 `skipped`，继续下一 beat |
| 回合 `stall` 或空 consequence | 标 `thin`，不计完成，继续 |
| 场景零有效回合 | 标 `thin`，继续 |
| **全部**场景 thin | 停在 Writer 前，抛检查点问用户 |
| actor 不在场（白名单冲突） | 丢弃该 beat，记事件，继续 |
| Writer / Reviewer / Reviser 失败 | 保留正文与 transcript，可续跑 |
| AbortSignal 取消 | 冻结，不再发起任何调用，可续跑 |

Writer 拿到质量契约（"这些节点缺失，不要编造，绕开写"），不再是"盲写 vs 阻断"二选一。

### mention：追加 reaction 节点

- 被 mention 角色不再要求预先拥有未完成 beat；引擎向计划**追加**一个 `kind:'reaction'` 节点，`parentBeatId` 指向触发它的 beat，压力上下文继承父节点。
- reaction 不标记任何 actionBeat 完成，单独计入 `mentionResponseTurns`。
- 保留全部有界保护：同源同目标去重、有向边 ≤2、深度 ≤3、每场 `autonomousRounds` 预算。
- 若被 mention 角色恰好有未完成 beat，该回合同时兼作其完成凭证（保留现有 `completedActionBeats` 口径）。

### 事件日志

```sql
CREATE TABLE novel_discussion_events (
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
```

- 状态 = `fold(events)`。续跑 = 重放，不再有启发式反推。
- 事件类型（首版）：`run_started` `plan_submitted` `beat_started` `beat_completed` `beat_skipped` `turn_submitted` `reaction_enqueued` `scene_completed` `weave_started` `weave_completed` `review_completed` `checkpoint_raised` `checkpoint_resolved` `degraded` `run_finished`。
- `discussion_run` 行退化为索引 + 游标：`status` `plan_version` `cursor_seq` `budgets`。`failed_phase/failed_scene_id/failed_action_beat_id` 三列停写（本轮保留列以兼容旧行，下迭代删）。
- SSE = 事件表的 tail。

### run 脱离 HTTP

```text
POST .../create-discussion            → 202 { runId }
GET  .../discussion-runs/:runId/events?from=seq  → SSE tail（可重连、可重放）
POST .../discussion-runs/:runId/decision         → 检查点决策
POST .../discussion-runs/:runId/cancel           → 显式取消
```

- 断线不再 abort run；只有显式 cancel 才停。
- `from=seq` 支持重放：面板重新打开可补齐历史事件再接实时。
- 现有 `create-discussion/:runId/resume` 保留给旧快照，新 run 走事件重放。

### 预算是运行时闸门

每 run 强制：总逻辑调用数、总墙钟、每场 reaction 预算。由执行器强制并写入事件。"5 场景 ≤ 40 次调用"从测试期望变为运行时保证。

### 删除低收益兜底

- Markdown 场景解析：本轮保留（Director 工具失败时的唯一退路），但降级为显式告警路径，不再静默。
- 角色回合文本兜底：删除。工具不通就在第一个 beat 大声失败，而不是降级成 20 分钟后才暴露的不可解析运行。
- legacy Moderator 轮询：迁入 `legacy-acting.ts` 只读模块，仅旧快照可达；新 run 不可达。

## 实现方向

七个切片，分三个阶段。每阶段结束时功能可用，可随时停。

- 阶段 A（T1-T3）：删 Moderator，换调度器 + 策略表 + reaction；前端气泡。改动集中在引擎单文件，删多于加。
- 阶段 B（T4-T5）：事件表 + 状态 fold；删三元组与反推启发式。
- 阶段 C（T6-T7）：run 脱离 HTTP；前端改消费事件 tail。

阶段 A 单独解决症状 1/2/4 并砍掉 planning 白付的 LLM 往返；阶段 C 解决症状 3。

## 受影响文件

- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/team-discussion-engine.ts`（路由图）：planning 直呼、调度器、策略表、reaction 追加、事件写入；本方案主战场。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/moderator.ts`（路由图）：删除。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/legacy-acting.ts`（新增）：旧快照的 Moderator→角色轮询只读迁移路径。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/discussion-scheduler.ts`（新增）：确定性调度器 + 策略表。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/step-executor.ts`（新增）：Step 执行器（session 组装 / 工具 / 空终答 / 重试 / 取消 / 用量）。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/discussion-types.ts`（路由图）：Step / ReactionBeat / 事件类型 / 诊断字段；删三元组。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/discussion-event-store.ts`（新增）：append-only 事件表读写 + fold。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/discussion-run-store.ts`（路由图）：退化为索引 + 游标。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/novel-discussion-runner.ts`（路由图）：去 moderatorModel、去 buildModeratorDecisionToolset、接执行器与事件 store。
- `apps/agent-server/src/plugins/novel-plugin/core/tools/submit.ts`（路由图）：删 `createNovelSubmitModeratorDecisionTool`。
- `apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts`（路由图）：`create-discussion` 改 202；新增 events / decision / cancel 端点。
- `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`（扫描）：迁移 121 建事件表。
- `apps/agent-server/src/plugins/novel-plugin/utils/chapter-task-registry.ts`（路由图）：后台 run 的任务注册与 abort 语义。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/discussion-settings-store.ts`（路由图）：删 moderatorModel / moderatorTimeoutMs，加 run 级预算。
- `apps/agent-server/src/plugins/novel-plugin/core/chapters/chapter-chat-runner.ts`（扫描）：自由聊天的 Moderator 选人替换为轻量选人实现（Moderator 唯一群聊外调用方）。
- `apps/agent-server/src/plugins/novel-plugin/novel-services.ts`（扫描）：runner 构造参数去 moderatorModel。
- `apps/desktop/src/renderer/src/api/discussion-settings-client.ts`（扫描）：设置类型去 Moderator 字段。
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-character-actor.md`（路由图）：mention 语义改为"追加回应"，删"等待主持人点名"。
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-director-discussion.md`（路由图）：删 Moderator 相关表述。
- `apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts`（扫描）：占位覆盖辅助；改消费事件 tail。
- `apps/desktop/src/renderer/src/components/novel/discussion-settings-panel.tsx`（扫描）：Moderator 模型/轮数配置项替换为预算配置。
- `apps/agent-server/src/plugins/novel-plugin/__tests__/team-discussion-engine.test.ts`（路由图）：58 个用例中依赖 Moderator 的部分需重写。
- `apps/agent-server/src/plugins/novel-plugin/__tests__/moderator.test.ts`（路由图）：删除（26 用例）。
- `apps/agent-server/src/plugins/novel-plugin/__tests__/novel-discussion-runner.test.ts`、`creation-flow-routes.test.ts`、`creation-flow-interject-route.test.ts`（路由图）：端点契约与 toolset 工厂断言更新。
- `docs/novel/2026-08-24-群聊演绎链路诊断与修复方案.md`（扫描）：追加本次重排记录。

## 风险

- **工作区已有未提交改动**：`team-discussion-engine.ts`（+130 行）、`discussion-types.ts`、`use-novel-creation-flow.ts` 及两个测试文件均有未提交修改，其中包含刚修的 resume 完成度判定与 `memberById` 口径修正。缓解：T1 开始前先读 diff；本方案会删掉这些改动所修补的代码路径（反推启发式、Moderator 仲裁分支），需确认删除而非合并，避免"修完又删"的困惑。
- **测试面大规模重写**：现有 58 + 26 用例大量断言 Moderator 决策与 throw 语义。缓解：T1 先建立新的行为测试（策略表、直呼 planning、reaction），再逐个迁移旧用例；`moderator.test.ts` 整体删除而非改造。
- **删除 Moderator 影响章节自由聊天**：`core/chapters/chapter-chat-runner.ts:218` 有活跃调用方——自由聊天在用户未 @ 指定 Agent 时，用 `Moderator.decide()` 以 `phase:'free_chat'` 单轮选出回复者。这是 Moderator 唯一的群聊外用途，且只用到 invite 决策的一次性选人，不涉及场景/动作图。缓解：T2 把这段替换为一个独立的轻量"选人"实现（同一 submit 工具形态或直接规则默认 Director），不保留整个 Moderator 类；`discussion-types.ts` 的 `DiscussionPhase` 保留 `free_chat` 成员。
- **策略表过度宽松导致低质量正文**：全场 thin 才停下，可能放过"5 场景里 4 场 thin"的烂运行。缓解：thin 场景数超半数时抛检查点而非静默继续；诊断透出场景级明细供用户判断。
- **事件表与快照双写期不一致**：阶段 B 期间新 run 写事件、旧快照仍在。缓解：新 run 的快照行只写索引字段；`get()` 按有无事件决定走 fold 还是旧解析。
- **后台 run 的孤儿进程**：run 不再随 HTTP 结束，进程退出或异常时可能留下 `running` 状态行。缓解：启动时扫描 `running` 且超时的行标 `interrupted`；显式 cancel 端点 + 章节互斥锁保持。
- **前端改消费事件 tail 的回归面**：`use-novel-creation-flow.ts` 同时服务 workflow / discussion / reverse / ai-arrange 四条流程。缓解：事件 tail 只对 discussion 生效，其余流程走原 SSE 路径不变。
- **reaction 追加可能放大调用量**：mention 从"基本被丢"变为"真的执行"，实际调用会上升。缓解：每场 reaction 预算独立且默认收紧（≤3），由执行器强制。

## 测试策略

- 调度器单测：beat 顺序执行、reaction 插入顺序（FIFO）、预算耗尽、取消立即返回、循环内零 LLM 决策断言。
- 策略表单测：逐行覆盖上表七种情形，断言"不 throw"与事件类型。
- planning 单测：直呼 Director、工具主路径空终答仍拿到计划、一次纠正性重试、两次空抛检查点、Markdown 回退告警、断言 Moderator 相关调用为 0。
- reaction 单测：无对应 beat 也能回应、父节点上下文继承、不误标完成、去环/深度/边重复、预算耗尽。
- Step 执行器单测：空终答取闭包 payload、重试预算、取消不重试、用量与 payload 统计。
- 事件 store 单测：append 单调 seq、fold 还原状态、按 `from=seq` 重放、旧快照兼容读。
- 续跑测试：事件重放续跑不重复演出、不丢正文；旧快照仍走 legacy 路径完成或显式失败。
- 端点测试：202 + runId 契约、events tail 重连补齐、decision 端点、cancel 端点、断线不 abort、章节互斥 409。
- 前端测试：占位覆盖（director / character / moderator 三类空终答气泡）、无重复气泡、无永久 streaming、事件 tail 重连后气泡不重复、`actorTurn` 可展开区。
- 性能 fixture：固定 5 场景 mock，断言逻辑调用数 ≤40、planning Moderator 调用 = 0、格式纠正 = 0、墙钟相对基线下降。

## 路由图影响

- 需要 route-sync：是。
- 修改 `docs/routespec/feature-routes/novel-plugin.md` 的「群聊共创演绎链路（动作图 + 自主 mention）」：
  - 纠正入口 URL（`discuss-flow` → `create-discussion`），并补 events / decision / cancel 三个新端点。
  - 描述改为"确定性调度器 + 策略表"，删除 Moderator 相关全部表述。
  - 核心文件补 `discussion-scheduler.ts`、`step-executor.ts`、`discussion-event-store.ts`、`legacy-acting.ts`；移除 `moderator.ts`。
  - 测试入口移除 `moderator.test.ts`，补调度器/策略表/事件 store 测试。
- 修改「章节创作流程（SSE）」：说明 discussion 已改后台运行 + 事件 tail，与 create-flow 的一次性 SSE 不同。
- 修改「领域子模块」：`discussion` 分域补事件溯源与调度器说明。

## 验收标准

1. 全仓无 `moderator.ts` 引用；planning 与正常 acting 的 Moderator 逻辑调用为 0（fixture 断言）。
2. 调度循环内无任何 LLM 调用决定"下一步谁说话"；beat 顺序、reaction 队列、策略表全部为纯代码路径。
3. 上表七种情形均不使 run 变 error；只有"全部场景 thin"与"取消"会停下，且都保留 transcript 与已有正文。
4. 角色 mention 在被点角色没有预置 beat 时也能触发回应回合，且受去环/深度/边重复/预算约束。
5. `POST create-discussion` 返回 202 + runId；关闭前端后 run 继续执行；重新打开经 `GET events?from=0` 能完整重放并接上实时。
6. 续跑基于事件重放：不重复已完成 beat、不丢正文；`failedPhase/failedSceneId/failedActionBeatId` 在代码中已无写入方。
7. 工具主路径终答为空时，Director 计划与角色回合仍完整进入事件、气泡、Writer 上下文与最终正文。
8. 前端在 director / character / moderator（历史事件）三类空终答场景下均无空气泡、无重复气泡、无永久 streaming。
9. 5 场景 fixture：逻辑调用 ≤40，reaction 回合 ≤ 每场 3，墙钟相对当前基线下降 ≥30%。
10. 服务端与桌面端 typecheck、相关测试、性能 fixture、route-sync 全部通过。

## 任务

- [ ] T1：调度器骨架 + planning 直呼 Director
  - 文件：`discussion-scheduler.ts`（新）、`step-executor.ts`（新）、`team-discussion-engine.ts`、`discussion-types.ts`
  - 改动：抽出 Step 类型与执行器（session/工具/空终答/重试/取消/用量收口）；planning 循环替换为直呼 Director + 一次纠正性重试 + 检查点；`buildScenePlanToolset` 调用点保持。
  - 验证：planning 单测（直呼、空终答、重试、检查点、Markdown 回退）；断言无 Moderator 调用。
  - 依赖：无。执行前先读工作区 diff，确认删除而非合并既有修补。
- [ ] T2：策略表取代 Moderator 仲裁 + 删除 moderator.ts
  - 文件：`team-discussion-engine.ts`、`discussion-scheduler.ts`、`moderator.ts`（删）、`legacy-acting.ts`（新）、`chapter-chat-runner.ts`、`submit.ts`、`novel-discussion-runner.ts`、`novel-services.ts`、`discussion-settings-store.ts`、`creation-flow-routes.ts`（settings schema）、`discussion-settings-client.ts`、两个提示词
  - 改动：`interveneForActionBeat` 全部调用点替换为策略表；Phase 2.5 硬闸放宽为"全部 thin 才停"；自由聊天的 Moderator 选人替换为轻量选人实现；删 Moderator 类、submit 工具、`moderatorModel`/`moderatorTimeoutMs` 设置项与其全链路类型；legacy 轮询迁只读模块；删角色回合文本兜底。
  - 验证：策略表逐行单测；自由聊天选人测试；`moderator.test.ts` 删除；`team-discussion-engine.test.ts` 中 Moderator 相关用例迁移。
  - 依赖：强依赖 T1。
- [ ] T3：mention 改 reaction 节点 + 前端占位覆盖
  - 文件：`team-discussion-engine.ts`、`discussion-types.ts`、`role-character-actor.md`、`use-novel-creation-flow.ts`
  - 改动：mention 出队不再查静态数组，改为追加 `kind:'reaction'` 节点并继承父 beat 上下文；抽统一占位覆盖辅助供 director/character/moderator 三类 `agent_output` 共用。
  - 验证：reaction 单测（无预置 beat 可回应、不误标完成、有界保护、预算）；前端三类空终答气泡测试。
  - 依赖：强依赖 T2（策略表已就位）；前端部分可与 T2 并行。
- [ ] T4：事件表 + 状态 fold
  - 文件：`discussion-event-store.ts`（新）、`novel-migrations.ts`（迁移 121）、`team-discussion-engine.ts`、`discussion-run-store.ts`
  - 改动：建 append-only 表；事件写入收口到执行器与调度器；实现 fold；`discussion_run` 行退化为索引 + 游标。
  - 验证：事件 store 单测（seq 单调、fold、按 from 重放、旧快照兼容读）。
  - 依赖：强依赖 T1（执行器是写入点）。可与 T3 并行。
- [ ] T5：续跑改事件重放 + 删三元组
  - 文件：`team-discussion-engine.ts`、`discussion-types.ts`、`discussion-run-store.ts`、`creation-flow-routes.ts`
  - 改动：`resumeSceneActing`/`resumeChapterWeaving` 改为按事件重放定位；删除 `failedPhase/failedSceneId/failedActionBeatId` 写入方与 transcript 反推逻辑；旧快照走 legacy 路径。
  - 验证：续跑测试（不重复演出、不丢正文、旧快照兼容）。
  - 依赖：强依赖 T4。
- [ ] T6：run 脱离 HTTP
  - 文件：`creation-flow-routes.ts`、`chapter-task-registry.ts`、`novel-discussion-runner.ts`
  - 改动：`POST` 返 202 + runId 并后台执行；新增 `GET .../discussion-runs/:runId/events?from=seq`、`POST .../decision`、`POST .../cancel`；断线不 abort；启动时清理孤儿 `running` 行。
  - 验证：端点测试（202 契约、tail 重连、decision、cancel、断线不 abort、互斥 409）。
  - 依赖：强依赖 T4/T5。
- [ ] T7：前端改消费事件 tail + 诊断透出 + route-sync
  - 文件：`use-novel-creation-flow.ts`、`novel-conversation-panel.tsx`、`discussion-settings-panel.tsx`、`novel-plugin.md`、诊断文档
  - 改动：discussion 分支改为 202 → events tail（支持 `from=seq` 重连补齐）；设置面板替换为预算配置；`diagnostics` 透出 `CreationResult` 并展示；执行 route-sync。
  - 验证：前端事件 tail 测试（重连不重复气泡）；性能 fixture；全链路 typecheck/test。
  - 依赖：强依赖 T6。

## 任务关系

- 强相关：T1 → T2 → T3 与 T1 → T4 → T5 → T6 → T7。两条链共享 `team-discussion-engine.ts` 与 `discussion-types.ts`，必须顺序集成。
- 弱相关：T3 的前端占位覆盖与 T2 文件边界清晰，可并行；T4 与 T3 分别动事件层与调度层，可并行但需同一 `discussion-types.ts` 变更协调。
- 独立：无。本方案所有切片都收敛到同一引擎。
- 冲突风险：`team-discussion-engine.ts` 被 T1/T2/T3/T4/T5 全部触碰，`discussion-types.ts` 被 T1/T3/T4/T5 触碰，`team-discussion-engine.test.ts` 被 T1/T2/T3 触碰，`creation-flow-routes.ts` 被 T5/T6 触碰。禁止并行编辑同一文件；T3 前端部分与 T4 事件层是唯一安全的并行窗口。

## RouteSync

- 需要 route-sync：是。
- 预期更新：`novel-plugin.md` 的「群聊共创演绎链路」整条重写（入口 URL 纠正 + 三个新端点 + 调度器/策略表/事件溯源 + 新增四个核心文件 + 移除 moderator.ts 与其测试）；「章节创作流程（SSE）」补 discussion 后台运行差异；「领域子模块」补 discussion 事件溯源；更新覆盖状态与日期。

## 下一步

→ 方案已收敛。确认后加载 `exec-plan`，按 T1 → T2 →（T3 ∥ T4）→ T5 → T6 → T7 执行；T1 开始前先读 discussion 相关未提交 diff，确认本方案删除的代码路径与其中的既有修补重叠部分。
