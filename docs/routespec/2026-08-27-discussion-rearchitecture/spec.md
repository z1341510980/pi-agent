# 方案：群聊演绎链路重构

## 目标

把 novel 群聊从“Moderator 每回合 @ 一个角色”的中心化循环，改造成由 Director 的戏剧动作图驱动、角色可结构化提交并自主 mention 的有界演出链路，解决：

1. Moderator 频繁失败后进入低质量降级，且降级仍持续消耗调用。
2. 角色调用失败/取消后错误地拖入下一轮，导致整个流程中断或状态不一致。
3. 角色只输出简单动作+台词，缺少当下想法、冲突判断、应对选择和行动后果。
4. 角色只能等待 Moderator 点名，角色之间无法沿因果关系自行接戏。
5. Director 只规划场景和出场角色，没有规划不同角色的戏份、冲突节点、选择与后果。
6. 5 场景运行出现约 53 次角色调用、接近 30 分钟，调用粒度和收敛条件不可控。

## 范围

- 内：
  - Director 场景计划工具扩展为“场景 + 戏剧动作节点图”。
  - 角色新增结构化 `submit_character_turn` 工具，提交公开演出内容、私有思考和下一步 mention。
  - 用户和 Writer 可见 `innerThought/conflictReading/responsePlan`；其他角色只能看到 `publicText` 和允许公开的后果。
  - acting 阶段改为动作节点 + pending mention 队列推进，正常演出不逐回合调用 Moderator。
  - 角色可以通过结构化 mention 触发当前场景内其他角色回应；引擎负责白名单、信息边界、去环和预算校验。
  - Moderator 改为异常仲裁器：只在动作图偏离、mention 非法、无进展、角色失败、场景出口不明确时介入。
  - Moderator 结构化决策改用 submit 工具主路径，文本解析和规则 fallback 只作明确降级。
  - 角色非取消失败局部容错并继续场景；取消立即终止当前调用，不再发起下一轮 Moderator；全角色失败时显式失败/检查点，禁止静默盲写。
  - 最终 run 保留已有正文、transcript 和场景计划；Reviewer/Reviser 失败不丢正文。
  - 增加按 phase/scene/actionNode/invocationKind 的调用统计，收敛 5 场景的逻辑调用预算。
- 外：
  - 不把群聊改成无边界的常驻 Agent 广播；AgentChannel 仍只负责消息广播，不直接驱动回合。
  - 不让其他角色读取某角色的内心、冲突判断、应对方案或未公开秘密。
  - 不把 Writer 改成逐场景编织；继续保持所有场景完成后一次性编织。
  - 不删除旧快照和旧场景计划的兼容读取；没有动作图的旧快照保留有界 legacy acting 路径。
  - 不在本轮引入跨章节自动规划或卷节拍重新生成。

## 已确认边界

- `innerThought`、`conflictReading`、`responsePlan`：用户和 Writer 可见，其他角色不可见。
- 正常 acting：不逐回合调用 Moderator；动作图和角色 mention 队列正常推进。
- Moderator：只处理异常、偏离、循环、停滞、动作图出口和用户决策。
- 自主 mention：只能触发当前场景在场且通过白名单校验的角色；不允许自 mention、跨场景 mention 或通过普通文本中的 `@` 误触发。
- 角色工具提交是主路径；不能依赖 `session.prompt()` 的终答正文。工具结果由闭包捕获，终答为空也必须能完成演出。

## 假设

- 新生成的 Director 计划默认携带动作节点；旧 Markdown/旧工具计划没有动作节点时进入 legacy bounded acting，并在 diagnostics 标记 `legacy_plan`。
- 动作节点中的角色使用角色档案显示名提交，工具执行时由引擎解析为 canonical member ID；不让模型手写 `char-*` ID 作为唯一输入。
- 角色结构化工具中的 `publicText` 仍保持自然剧本内容，不把“意图/心理/应对”等分析标签写进公开正文；私有字段单独存放。
- 若动作节点计划与 `allowedCharacterMemberIds` 冲突，以白名单为硬约束，工具提交被拒绝并要求 Director 修正。
- 运行级预算默认取设置值，新增的 acting 自主预算缺省为每场 8 个逻辑角色回合；达到预算后交给 Moderator 一次处理，不继续自循环。

## 当前行为

- `TeamDiscussionEngine.runSceneLoop()` 每轮先调用 `moderator.decide()`，再由 `handleDecision()` 调角色；角色输出不能触发下一位角色。
- `Moderator.decide()` 一次失败会重试，双失败进入规则 fallback；acting 中 Moderator 仍是每回合必经节点。
- `ScenePlanToolset` 只表达 title/location/time/conflict/goal/emotion/presentCharacters，没有动作、阻力、选择、后果和下一角色。
- `role-character-actor.md` 只要求动作/表情/心理外化 + 台词；`DiscussionMessage` 没有结构化回合意图或 mention 元数据。
- `prepareCharacterSpeech()` 格式失败会额外调用一次角色，失败后可能归一化丢弃动作、内心和应对信息。
- acting 单角色/合并角色的非取消异常多数被 catch 后继续；取消被吞后下一轮仍可能调用 Moderator，最终才转为 cancelled。
- planning 轮数耗尽或场景无有效演出时仍可能进入 Writer 盲写；最终 Reviewer/Reviser 异常则可能直接结束 run。
- 最近 5 场景运行约 53 次角色调用；当前 Moderator 调用未纳入统一调用统计，无法精确重算总调用。

## 目标行为

### Director 动作图

Director 通过 `novel_submit_scene_plan` 提交的每个场景至少包含：

```ts
{
  title,
  location,
  time,
  conflict,
  goal,
  emotion,
  presentCharacters,
  actionBeats: [
    {
      beatId,
      actor,
      target,
      pressure,
      action,
      choice,
      consequence,
      nextActor,
      exitCondition
    }
  ]
}
```

动作节点必须回答“谁在什么阻力下对谁做什么、对方必须面对什么选择、选择造成什么后果、接下来由谁回应”。`actor/target/nextActor` 必须属于当前场景角色白名单；过渡节点可显式标记 `exitCondition`，不能用空动作节点伪装戏份。

Director 计划校验至少保证：

- 场景动作节点数在预算内，默认每场 2-8 个。
- 每个非功能性出场角色至少有一个动作节点，纯背景角色可只作为 `presentCharacters` 并标记功能角色。
- 每个动作节点有非空 action、pressure、consequence；不能只有“展现关系/推进剧情”这类抽象目标。
- `nextActor` 与动作节点顺序形成可执行路径；缺失时由引擎回到异常仲裁，不自行轮流补齐所有角色。
- 章纲事件覆盖、场景出口和卷级节拍仍由现有章纲/节拍约束提供；动作图是本章戏肉的执行层。

### 角色结构化回合

角色通过 `submit_character_turn` 提交：

```ts
{
  publicText,
  innerThought,
  conflictReading,
  responsePlan,
  consequence,
  progress,
  mentionNames,
  replyToMessageId
}
```

字段语义：

- `publicText`：动作、身体反应、现场语言和可公开信息，进入用户气泡、公共 transcript 和 Writer。
- `innerThought`：角色此刻真正的判断、顾虑或误判，仅用户和 Writer 可见。
- `conflictReading`：角色如何理解当前阻力，仅用户和 Writer 可见。
- `responsePlan`：角色准备采取的应对，仅用户和 Writer 可见；不等于必然成功。
- `consequence`：本次行动已经造成的即时后果，可公开或按角色认知裁剪。
- `progress`：`advance/escalate/retreat/stall/reveal`，用于动作图进度和无进展检测。
- `mentionNames`：角色主动请求回应的角色名列表，由引擎解析、校验并入 pending 队列。
- `replyToMessageId`：因果回应的上一条角色消息，可选但用于审计和去环。

其他角色 prompt 只获得公共 transcript；Writer 获得完整角色回合摘要；用户气泡展示完整结构化回合，但把私有字段放在可展开区，不污染公开剧情文本。

### acting 调度

正常路径：

```text
Director actionBeat
  → 指定 actor 提交 character turn
  → 引擎提交 public bubble + private writer/user metadata
  → 校验 mentionNames / replyTo
  → pending-turn FIFO 执行被 mention 角色
  → 角色继续 mention 或回到 actionBeat.nextActor
  → actionBeat exitCondition 满足
  → 下一个 actionBeat / 下一个 scene
```

Moderator 不参与正常每回合调度，只在以下情况介入一次：

- actor/target 不在当前场景或白名单；
- mention 形成重复边、回环或跨场景请求；
- 角色结构化回合缺失、工具提交失败或连续失败；
- actionBeat 没有有效进展，或 consequence 与场景目标冲突；
- actionBeats 已耗尽但场景出口不满足；
- 用户通过插话要求改变路径或暂停。

自主回合必须受以下限制：

- 每场最多 8 个逻辑角色回合，设置可覆盖但有硬上限。
- 同一消息对同一目标最多入队一次。
- 同一有向角色边在一场中最多重复 2 次。
- mention 深度和连续无状态变化次数均有上限。
- 预算耗尽后交给 Moderator；Moderator 只能选择继续、跳过未完成节点、暂停或收敛，不能重新开启无界循环。

### 失败与取消

- 角色调用 `AbortSignal` 已取消：立即结束当前 acting 调用并返回 cancelled，不再调用下一轮角色或 Moderator；保留当前 transcript/scenes。
- 非取消角色调用失败：当前 actionBeat 最多重试一次；仍失败则标记 `actor_failed`，跳过或交由一次 Moderator 仲裁，继续后续节点。
- 当前场景所有角色均失败：返回显式 acting error/checkpoint，不进入静默盲写。
- Writer/Reviewer/Reviser 失败：保留已有正文、角色演出和场景计划，结果带 failedPhase，允许从对应阶段续跑。
- Reviewer reject 或取消：保留 `content`，不抹掉已生成正文。

### Moderator 降级

- `Moderator` 通过 `submit_moderator_decision` 工具提交结构化决策，去掉 `responseFormat: 'json'`，闭包捕获 payload。
- 工具提交后即使终答为空，也使用 payload，不把空文本交给引擎。
- provider 不支持工具时，文本解析只作兜底，并最多执行一次同会话修复轮。
- 两次 LLM 失败或结构化决策非法时进入规则 fallback，但必须发 `moderator_fallback` 事件、记录 reason 和计数；不能静默把 fallback 当正常决策。
- 新 acting 正常路径不调用 Moderator，因此 Moderator 降级不会再放大为“每个角色回合一次重试”。

### 可观测性与收敛

每次逻辑调用记录：

```ts
{
  logicalInvocationId,
  phase,
  sceneId,
  actionBeatId,
  invocationKind,
  actorIds,
  durationMs,
  firstTokenMs,
  llmRoundTrips,
  payloadTotalChars,
  outcome,
  fallbackReason,
  mentionDepth
}
```

`DiscussionDiagnostics` 增加按场景的 acting 回合、Moderator 异常介入、角色失败、自主 mention、动作节点完成度和 legacy plan 标记。

5 场景基准目标：

- 正常 acting 的 Moderator 逻辑调用数为 0；异常介入目标不超过 5 次，硬上限不超过 8 次。
- 角色逻辑调用目标不超过 35 次，硬上限不超过 40 次；单个 actionBeat 正常只调用一次目标 actor，失败才允许一次重试。
- `formatCorrection` 不再作为结构化 actor 主路径的额外 LLM 调用；目标为 0，legacy 路径单独统计。
- Writer 正常一次，Reviewer 一次，只有验收要求修订时才调用 Reviser。
- 相对现有 53 次角色调用，正常路径至少减少 25%，同时不降低场景覆盖和台词复用质量。
- 每个有戏份的角色至少有一个有效 actionBeat 和一个 `publicText`；每个场景至少有一次双向回应或明确标记为单人过渡。

## 实现方向

### T1：领域协议与动作图

- 扩展 `discussion-types.ts`：新增 `SceneActionBeat`、角色回合结果、mention 元数据、按场景诊断字段；`SceneDefinition.actionBeats` 可选以兼容旧快照。
- 扩展 `novel-tools.ts` / `core/tools/submit.ts`：`novel_submit_scene_plan` 增加 actionBeats 字段和执行时的角色白名单/节点字段校验。
- 新增 `submit_character_turn` 工具与 `CharacterTurnToolset`，闭包捕获 payload；工具 schema 和 execute 内做字段、mention、长度的防御式校验。
- 新增 `submit_moderator_decision` 工具或等价 Moderator toolset，保留旧文本解析作为 provider fallback。
- 验证：工具 schema、payload 捕获、非法 actor/mention/actionBeat、工具调用后空终答等纯单测。

### T2：Director prompt 与场景计划构建

- 重写 `role-director-discussion.md` 的工具说明：禁止只提交 cast；每场必须安排 actionBeat 的 actor/target/pressure/action/choice/consequence/nextActor。
- `team-discussion-engine.ts` / scene adapter 增加动作图转换、白名单过滤、动作节点完成度和旧计划 legacy 标记。
- 验证：Director 计划覆盖不同角色戏份、冲突节点和出口；编排外角色被拒绝；旧计划仍能进入 bounded legacy 路径。

### T3：角色结构化演出与可见性

- 重写 `role-character-actor.md`：公开演出仍为自然剧本内容；必须通过工具提交 private turn metadata 和 mention；不能代写其他角色。
- `TeamDiscussionEngine` 增加角色回合调用路径：工具结果主路径跳过格式纠正；文本结果只作 provider fallback。
- `DiscussionMessage` 保存公开 content + 私有 actorTurn metadata；`formatTranscriptForMember` 按角色/Writer/用户可见性裁剪。
- 增加完整 Director/character tool bubble 的 SSE `agent_output` 事件；前端将其覆盖启动占位并展示可展开的 innerThought/conflictReading/responsePlan。
- 验证：角色 A 的私有字段不会进入角色 B prompt；用户和 Writer 能看到；公开台词/动作进入 Writer；工具终答空时气泡仍完整。

### T4：acting 自主调度与 Moderator 异常仲裁

- 重构 `runSceneLoop()`：新 actionBeat 计划走自主 pending-turn 队列；mention 目标经过 canonical member、当前 scene、white-list、去环和预算校验。
- 把 `AgentChannel` 保持为广播设施，不让 channel listener 直接递归唤醒；所有自主回合统一由引擎队列调度。
- 新增异常仲裁入口：只在 actor 失败、非法 mention、无进展、动作图偏离或出口不明确时调用 Moderator。
- legacy scene 没有 actionBeats 时保留旧 `Moderator → actor` 路径，但每场有硬上限并显式标记 `legacy_plan`。
- 验证：actionBeat 顺序、角色自发 mention、mention 回环、跨场景阻止、预算耗尽交 Moderator、Moderator 异常后继续。

### T5：失败语义、断点续跑与收尾

- 所有 acting 调用 catch 先判断 AbortSignal；取消立即返回，不再触发下一轮调度。
- 非取消角色错误局部标记并继续；全场无有效演出进入显式 error/checkpoint，禁止盲写 completed。
- 初次 run 与 resume 的 reviewing/reject/cancelled 统一保留 content/transcript/scenes。
- `resumeSceneActing()` 读取 `actionBeats`，旧快照无动作图时进入 legacy bounded 路径；必要时保存 `failedActionBeatId` 以便精确续跑。
- Writer/Reviewer/Reviser 保留已有正文，失败阶段可续跑。
- 验证：角色失败继续、取消不再调用 Moderator、全角色失败阻断盲写、Reviewer reject 保留正文、acting 续跑不丢动作图。

### T6：Moderator 工具化与降级闭环

- `moderator.ts` 引入闭包捕获式 submit tool，去掉工具会被禁用的 `responseFormat: 'json'` 主路径。
- 保留一次文本修复轮；规则 fallback 记录具体 reason，并通过 `onProgress` 发事件。
- `DiscussionDiagnostics` 增加 `moderatorFallbackReasons`、`moderatorExceptionInvocations` 和 `legacyModeratorRounds`。
- 验证：工具主路径、工具后空终答、文本 fallback、双失败显式降级、取消不重试、不产生无界 fallback。

### T7：前端气泡与运行统计

- `use-novel-creation-flow.ts` 增加通用 `agent_output` 消费：Director/character 的结构化工具提交可覆盖启动占位，不与标准文本流重复。
- Agent 气泡增加结构化回合可展开区；公开内容与私有字段视觉分层，私有字段不进入章节正文。
- 增加按场景/动作节点/角色的运行统计展示或诊断详情，至少能从 result 还原 53 次调用的构成。
- 验证：工具型空终答气泡、角色私有字段、重复气泡、失败/跳过状态和诊断字段。

### T8：性能回归与路由同步

- 建立 5 场景固定 fixture，统计 logical invocation 与 provider round trip，比较旧中心化路径和新动作图路径。
- 目标：actor 逻辑调用 ≤35、硬上限 ≤40；正常 acting Moderator=0；格式纠正主路径=0；总 payload 与耗时相对基线下降至少 25%。
- 更新 `docs/novel/2026-08-24-群聊演绎链路诊断与修复方案.md` 新增重构记录。
- 任务完成后执行 route-sync，更新 `novel-plugin.md` 的群聊演绎链路、工具协议、acting 状态机和测试入口。

## 受影响文件

- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/discussion-types.ts`（路由图/扫描）：动作节点、角色回合、mention、诊断和失败/续跑协议。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/team-discussion-engine.ts`（路由图/扫描）：planning/acting 状态机、角色调用、工具结果、失败语义和自主队列。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/engine/moderator.ts`（路由图/扫描）：决策工具化、异常仲裁和降级统计。
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/novel-discussion-runner.ts`（路由图/扫描）：成员构建、角色回合工具工厂、Writer 可见性和运行设置。
- `apps/agent-server/src/plugins/novel-plugin/core/tools/submit.ts` / `core/novel-tools.ts`（扫描）：场景计划和新 submit 工具。
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-director-discussion.md`（路由图/扫描）：动作图提示词。
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-character-actor.md`（路由图/扫描）：结构化角色回合提示词。
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-writer-discussion.md`（路由图/扫描）：Writer 私有回合摘要与落地义务。
- `apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts`（路由图/扫描）：discussion SSE、checkpoint、resume 结果字段。
- `apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts`（扫描）：结构化工具气泡消费。
- `apps/desktop/src/renderer/src/hooks/__tests__/use-novel-creation-flow.test.ts`（扫描）：工具型 Director/character 气泡测试。
- `apps/agent-server/src/plugins/novel-plugin/__tests__/team-discussion-engine.test.ts`（路由图/扫描）：状态机、动作图、mention、失败和预算测试。
- `apps/agent-server/src/plugins/novel-plugin/__tests__/moderator.test.ts`（路由图/扫描）：Moderator submit/fallback 测试。
- `apps/agent-server/src/plugins/novel-plugin/__tests__/novel-discussion-runner.test.ts`（路由图/扫描）：成员工具工厂、可见性和续跑测试。
- `docs/novel/2026-08-24-群聊演绎链路诊断与修复方案.md`（扫描）：实证与重构记录。

## 风险

- **动作图过度规定**：Director 若把每句台词都写死，角色会失去现场选择。缓解：动作图只规定压力、选择边界和后果，不规定角色必须说哪句话；角色工具保留拒绝、误判和失败。
- **私有信息泄漏**：共用 `DiscussionMessage` 时容易把 actorTurn 直接送给其他角色。缓解：所有角色 prompt 经过显式可见性裁剪，增加跨角色泄漏测试。
- **自主 mention 回环**：角色 A/B 互相 mention 可能重新制造死循环。缓解：有向边重复上限、深度上限、无进展 hash 和 Moderator 仲裁。
- **工具后二次空终答**：gpt-5.6-luna 已实证会在工具结果后返回空 stop。缓解：引擎只认闭包 payload，不依赖 `prompt()` 文本；前端也用 custom agent_output 展示。
- **旧快照兼容**：历史 scenes 没有 actionBeats。缓解：字段可选，进入有界 legacy 路径并标记 diagnostics，不修改旧数据。
- **角色失败继续导致因果缺口**：跳过关键 actor 可能让场景目标不成立。缓解：动作节点标记失败，交一次 Moderator 决定跳过/改由目标角色承接/暂停；全角色失败不得盲写。
- **Moderator 工具化反向增加单次 round trip**：正常 acting 不再调用 Moderator，异常路径的额外 round trip 由整体调用数下降抵消；性能 fixture 必须分别统计逻辑调用和 provider round trip。
- **并发与顺序**：pending mention 队列不能并发执行有因果依赖的角色。缓解：FIFO；只有 Director 明确标记信息对称且无先后依赖时才复用现有合并调用。
- **用户既有工作区改动**：discussion 文件存在未提交改动，实施时只修改本方案涉及的局部，先读 diff，不回退其他变更。

## 测试策略

- 工具协议测试：`novel_submit_scene_plan` 动作图字段、`submit_character_turn` 私有/公开字段、`submit_moderator_decision` 主路径、空终答后 payload 仍可读。
- 状态机测试：planning 工具提交直接进入 acting；actionBeat 顺序执行；角色 mention 触发目标；mention 非法/回环/跨场景被阻止；正常 acting 不调用 Moderator。
- 失败测试：角色非取消失败后继续；AbortSignal 取消后不再调用 Moderator；全角色失败不盲写；Writer/Reviewer/Reviser 失败保留正文；Reviewer reject 保留 content。
- 可见性测试：角色 A 的 innerThought/conflictReading/responsePlan 不出现在角色 B prompt；Writer 和用户气泡能看到；publicText 进入 Writer。
- 兼容测试：旧 scenes 无 actionBeats 进入 legacy bounded acting；旧 snapshot 的临时角色、场景和 resume 不崩。
- Moderator 测试：工具成功、工具后二次空终答、文本解析修复轮、双失败显式 fallback、取消不重试。
- SSE/UI 测试：Director 和 character 的工具提交气泡展示完整内容；启动占位被替换；无标准正文 delta 时不产生空气泡；thinking 与结构化私有区不重复。
- 性能 fixture：固定 5 场景、角色、动作节点和模型 mock，断言逻辑调用数、Moderator 介入数、格式纠正数、mention 深度、payload 字符数和总耗时指标。

## 路由图影响

- 需要 route-sync：是。
- 修改 `docs/routespec/feature-routes/novel-plugin.md` 的「章节创作流程（SSE）」：补充 discussion 的动作图 planning、autonomous acting、异常 Moderator 和失败/续跑语义。
- 修改「领域子模块」：补充 `discussion/engine` 的 actionBeat、character turn tool、pending mention queue 和可见性裁剪。
- 修改「工具协议」相关描述：补充 `novel_submit_scene_plan` 的动作节点、`submit_character_turn`、`submit_moderator_decision`。
- 测试入口补充 `team-discussion-engine.test.ts`、`moderator.test.ts`、`novel-discussion-runner.test.ts` 和桌面端 creation-flow hook 测试。

## 验收标准

1. Director 生成的每个新场景包含可执行 actionBeats；每个有戏份角色至少有动作节点；动作节点包含压力、行动、选择、后果和下一回应角色。
2. 正常 acting 阶段不逐回合调用 Moderator；角色提交 `mentionNames` 后，当前场景内合法目标会按 FIFO 被唤醒并看到公共信息。
3. 角色气泡展示 publicText，并可展开查看 innerThought、conflictReading、responsePlan、consequence；其他角色 prompt 不包含这些私有字段。
4. 角色非取消调用失败不会中断整个 run；AbortSignal 取消不会再触发下一轮 Moderator；全角色失败不会静默进入盲写 completed。
5. Moderator 双次失败时有明确 `moderator_fallback` 事件、fallback reason 和 diagnostics；正常 acting 不因 Moderator 降级而反复追加调用。
6. 工具调用后模型终答为空时，场景计划和角色回合仍能从闭包 payload 进入 transcript、SSE 气泡、Writer 上下文和最终正文。
7. 5 场景固定 fixture 下，角色逻辑调用目标不超过 35、硬上限不超过 40；正常 acting Moderator 调用为 0；主路径格式纠正调用为 0。
8. Writer 能看到完整角色结构化回合并将有效动作、台词、选择和后果写入正文；私有字段不被其他角色泄漏。
9. 旧快照无 actionBeats 时仍能有界完成或显式失败，不能无界循环；acting/reviewing 断点续跑不丢场景计划和已有正文。
10. 服务端、桌面端 typecheck、相关测试、性能 fixture 和 route-sync 全部通过。

## 任务

- [ ] T1：领域协议与工具 schema
  - 文件：`discussion-types.ts`、`core/tools/submit.ts`、`core/novel-tools.ts`
  - 改动：新增 actionBeat、characterTurn、mention、diagnostics 类型；扩展场景计划工具；新增角色回合和 Moderator submit 工具。
  - 验证：工具主路径/空终答/非法字段/白名单校验单测。
  - 依赖：无。
- [ ] T2：Director 动作图与提示词
  - 文件：`role-director-discussion.md`、`team-discussion-engine.ts`、scene adapter、Director 相关测试。
  - 改动：从 cast+scene 契约升级为动作节点图，校验戏份、压力、选择、后果、nextActor 和场景出口。
  - 验证：动作图覆盖、编外角色拒绝、旧计划 legacy 标记。
  - 依赖：强依赖 T1。
- [ ] T3：角色结构化回合与可见性
  - 文件：`role-character-actor.md`、`team-discussion-engine.ts`、`novel-discussion-runner.ts`、`role-writer-discussion.md`。
  - 改动：工具化角色回合；公开/私有字段分层；Writer 完整读取，角色按认知裁剪；主路径取消格式纠正。
  - 验证：跨角色不泄漏、用户/Writer 可见、空终答仍落地。
  - 依赖：强依赖 T1，弱依赖 T2。
- [ ] T4：自主 acting 队列与 Moderator 异常仲裁
  - 文件：`team-discussion-engine.ts`、`moderator.ts`、`discussion-actor-batching.ts`、状态机测试。
  - 改动：actionBeat + pending mention FIFO；有界深度/边重复/无进展保护；正常 acting 不调用 Moderator；legacy 路径保留硬上限。
  - 验证：自主 mention、回环、跨场景、预算耗尽、异常仲裁和场景收敛。
  - 依赖：强依赖 T2/T3。
- [ ] T5：失败、取消、收尾与续跑
  - 文件：`team-discussion-engine.ts`、`novel-discussion-runner.ts`、`creation-flow-routes.ts`、runner/route 测试。
  - 改动：AbortSignal 立即退出；角色失败局部继续；全角色失败阻断盲写；reviewing 保留 content；旧快照和 acting resume 兼容动作图。
  - 验证：角色失败/取消、Reviewer reject、Writer 失败、断点续跑和旧快照。
  - 依赖：强依赖 T3/T4。
- [ ] T6：Moderator submit/fallback 闭环
  - 文件：`moderator.ts`、`discussion-types.ts`、Moderator 测试。
  - 改动：submit 工具主路径、一次文本修复轮、明确 fallback reason/事件/diagnostics。
  - 验证：工具、空终答、fallback、取消和无界循环保护。
  - 依赖：可与 T3 并行，最终由 T4 集成。
- [ ] T7：SSE 气泡与前端结构化展示
  - 文件：`use-novel-creation-flow.ts`、相关桌面测试、必要的消息展示组件。
  - 改动：通用 agent_output 消费；工具型 Director/character 气泡覆盖占位；私有回合可展开且不进正文。
  - 验证：完整工具气泡、无正文终答、无重复气泡和可见性。
  - 依赖：强依赖 T3。
- [ ] T8：性能基线、全链路验证与 route-sync
  - 文件：性能 fixture、相关测试、诊断文档、`novel-plugin.md`。
  - 改动：按 logical invocation/round trip 统计；5 场景基准；更新诊断和路由图。
  - 验证：调用预算、质量不回退、typecheck/test/lint/route-sync。
  - 依赖：强依赖 T4/T5/T6/T7。

## 任务关系

- 强相关：T1 → T2 → T3 → T4 → T5；这些任务共享 `SceneDefinition`、工具闭包和引擎状态机，需按顺序集成。
- 弱相关：T6 与 T3 文件边界较清晰，但 Moderator 工具协议最终由 T4 的异常仲裁调用。
- 独立：T7 可在 T3 的 SSE 事件契约确定后独立开发；T8 必须等核心状态机和气泡完成。
- 冲突风险：T2/T3/T4 都会修改 `team-discussion-engine.ts` 和 `team-discussion-engine.test.ts`；T1/T6 都会修改 `core/tools/submit.ts`、`discussion-types.ts` 和相关工具测试；执行时避免并行编辑同一文件。

## RouteSync

- 需要 route-sync：是。
- 预期更新：`novel-plugin.md` 的章节创作流程、群聊演绎状态机、工具协议和测试入口；新增 actionBeat/autonomous acting/character turn tool 的定位说明，并更新覆盖状态与日期。

## 下一步

→ 方案已收敛；确认后加载 `exec-plan`，按 T1 → T2 → T3 → T4 → T5 集成，T6/T7 在契约确定后并行，最后执行 T8。
