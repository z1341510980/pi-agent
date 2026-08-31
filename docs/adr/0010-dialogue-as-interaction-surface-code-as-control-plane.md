# 对话是交互面，代码是控制面；Agent 间通信不驱动回合

日期：2026-08-31 状态：已采纳

背景：有提议放弃工作流形态，改为"主 Agent 派子 Agent、子 Agent 与主 Agent 相互通信"来驱动创作。该提议混合了三件事：交互形态对话化（已由 `ChapterChatRunner` 与群聊插话队列实现）、执行单元子 Agent 化（已由 `AgentManager.dispatchToAgent` + `subagent/subagent_reply/subagent_close` + `ConcurrencyLimiter` 实现）、以及让 Agent 间自由通信充当调度器（未实现）。仅第三项是新增能力，而它与 2026-08-27 群聊重构的显式排除项（"AgentChannel 仍只负责消息广播，不直接驱动回合"）及 2026-08-28 控制平面重排（删除 Moderator，把节点失败/无进展/actor 缺席/节点未完成四类判定从 LLM 仲裁改为 `acting-policy.ts` 纯代码处置）方向相反。

决策：对话只作为用户交互面（插话、@ 指定、随时改向），调度与收敛判定一律由代码承担。`AgentChannel` 维持广播设施定位，不得作为回合驱动器；角色间的自主接戏继续经引擎 FIFO 队列与预算表（`MAX_REACTION_TURNS_PER_SCENE` / `MAX_MENTION_EDGE_REPEATS` / `MAX_MENTION_DEPTH`）裁决。子 Agent 派遣限用于无状态一次性任务（实体生成、相似度扫描、盲审等）；不用于承载角色演出或相位推进。放宽自主度的手段是调整预算参数并用 `discussion-performance-fixture.test.ts` 度量，不是拆除调度器。

理由：三项硬约束都锚在代码控制面上。信息差要求逐层比对 `knowledge` 才允许合并调用，`allowMergedInvocation: false` 明确否决"用提示词做软隔离"，`formatTranscriptForMember` 是私有字段的单一裁剪出口；自由互通会把裁剪点从一个出口扩散到每条边，泄漏一次即让后续章节建立在不存在的因果上。收敛性来自实测——5 场景曾跑出 53 次调用 / 30 分钟，现行预算表和 fixture 断言（`totalMemberInvocations` 恒等 11）是那次回归的产物；自由互通没有天然收敛条件，最终仍需补回同一套预算，届时与现状的差别只剩谁填写 `nextActor`。质量门（PostWriteGuard、盲审、Reviewer、`decideWeaveGate`、`buildWriterQualityContract`）全部挂在相位边界，对话驱动没有"acting 结束"这一时刻，`summarizeActing` 的 completed/thin/skipped 账目无法结算，Writer 也就失去"绕开缺口而非编造"的依据。

后果：交互面可继续加强（插话、追问、改向），不受本决策限制。子 Agent 能力保持可用但用途受限。任何"让角色自主驱动流程"的诉求先转化为预算参数实验，附 fixture 前后对比（逻辑调用数、`transcriptReuseRate`、场景产出率）方可讨论。

反方观点：代码控制面意味着新增交互路径要改引擎，成本高于让模型自行协商。以 `acting-policy.ts` 的策略表集中承载判定来控制该成本——处置规则可读可测，改一条策略不必动状态机；相较之下 LLM 调度的失败面（超时、解析降级、无界重试）无法测试覆盖。
