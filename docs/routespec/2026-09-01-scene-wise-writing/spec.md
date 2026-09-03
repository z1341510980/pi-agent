# 方案：按场生成（结构化场景计划转正 + Writer 分场创作）

> 起因：字数失控（实测首稿 4740 字 / 目标 3000 字 = 158%）已反复修补多轮仍未解决。
> 本方案不再加第七层约束，而是改掉「一次调用产出整章 + 模型自己数字数」这个根因。

## 目标

- 首稿字数落在目标 ±15%（3000 字目标 → 2550-3450），不依赖模型自我计数。
- 字数超标时的浪费从「整章重写」降到「单场重写」（成本约 1/3）。
- 超标在**发生当场**被发现，而不是整章写完后由 PostWriteGuard 事后判定。
- 删除文本正则解析场景结构的做法，与 AGENTS.md「方案 D：submit 工具，非文本 JSON」一致。

## 范围

- 内：
  - Director 的 `novel_submit_narrative_task` 增加结构化 `scenes[]`（含逐场 `targetWords`、`emphasis`），工具内硬校验。
  - `create-flow` 的 Writer 阶段改为按场循环调用，每场一次；合稿后进现有 PostWriteGuard / Reviewer / Reviser 流程。
  - 场景计划从「影子写」转正为生成依据（`shadowWriteDirectorPlan` → 真实计划写入）。
  - 逐场预算提示改为读取结构化字段，删除 `parseSceneEmphasis` 正则与加权拆分。
  - 单场超标的就地处置（压缩重写该场 / 把超出量从后续场预算扣除）。
- 外：
  - 群聊路径（`create-discussion`）：已有自己的场景计划与 Writer 编织链路，本次不改其行为，只保证共享类型与工具不破坏。
  - Reviewer / Reviser 的评分与修订逻辑（lengdu 工作流已于 2026-09-02 整体移除）。
  - 前端创作面板的 UI 重构（仅需接住既有 `progress` 事件，逐场进度复用现有 `phase_change`）。
  - 卷级节拍表（beat-plan）、矩阵编排（arranger）逻辑。

## 假设

- `narrativeTask` 文本字段保留（Writer 仍需要整章级的 POV/边界/钩子说明），只是不再从中解析场景结构。
- 逐场调用的前缀（system + shared + identity）可被 `promptCacheScope` 缓存命中，因此 3 次调用的 input 成本远低于 3×单次。若实测缓存命中率不足，T6 的实测数据会暴露，届时再决定是否合并场次。
- 场景数上限沿用现有 1-5（`sceneCount` schema 已限），不放宽。

## 当前行为

1. Director 提交 `narrativeTask`（自由文本，≤800 字）+ `sceneCount`。
2. `shadowWriteDirectorPlan` 把它映射成 `ChapterScenePlan`（逐场均分字数）落库，注释明确写着「不改变任何生成行为，只让 V2 存储拿到可对账的影子数据」。
3. Writer **一次调用**产出整章，prompt 里带「目标 3000 / 硬上限 3900 / 逐场预算 1000+1000+1000」。
4. 模型无法自我计数，实测 4740 字（158%）。
5. PostWriteGuard 事后判定 >130% → 整章定向压缩重写（再烧一轮完整 input + output）。

已叠加但无效的约束层：prompt 硬上限、逐场预算文本、`max_tokens` 物理闸、Guard 1.3× 天花板、Director 任务 800 字上限、主次笔墨契约。

## 目标行为

1. Director 提交结构化 `scenes[]`：每场 `{ order, title, emphasis, targetWords, goal, entry, pressure, choice, consequence }`。工具内校验：
   - `sum(targetWords)` 必须等于本章 resolvedTarget（±1 容差，与 `validateChapterScenePlan` 同口径）
   - `emphasis === 'core'` 的场景数 ≤ 2
   - 场景数与 `sceneCount` 一致、`order` 连续唯一
   - 不合法 → 不写 draft，返回纠正提示让模型重调（现有 `submit_chapter_beat` 已是这个模式）
2. 计划落库为**批准的生成依据**（非影子），逐场 `targetWords` 由 Director 分配、系统校验总和。
3. Writer 逐场调用：第 N 场的 prompt 只含该场契约 + 该场预算 + 上一场正文尾部（衔接用），要求只写这一场。
4. 每场返回后立刻核字数：
   - 在本场预算 ±20% 内 → 接受，进入下一场
   - 超出 20% → 就地压缩重写该场（最多 1 次），仍超则接受并把超出量从后续场预算扣除
   - 低于 50% → 判该场残稿，重写该场（最多 1 次）
5. 合稿 → 现有 PostWriteGuard（此时字数已在预算内，天花板成为兜底而非主力）→ Reviewer / Reviser 不变。

## 实现方向

**核心思路：把已建好但闲置的结构化基础设施接到生成路径上。**

现成可复用的（不需要新建）：
- `chapter-scene-plan.ts`：`ChapterScenePlan` / `ChapterScenePlanScene` 类型 + `validateChapterScenePlan`（已含 `scene_budget_mismatch` 校验）
- `novel_scene_revisions` 表（迁移 084 / 109）+ `ScenePlanStore`（`submitPlanWithScenes` / `createSceneRevisions` / `confirmSceneRevision`）
- `novel_submit_scene_plan` 工具（群聊在用，含 actionBeats 结构化校验，可作 schema 范本）
- `resolveWordBudget` / `baseTargetOf`：字数唯一解析点
- `buildWriterRewritePlan`：已有「字数严重超标 → 定向压缩」指令，改为按场传入即可

需要新增的：
- `SubmitNarrativeTaskParams` 增加 `scenes` 数组字段 + 工具内校验分支
- Writer 分场循环（orchestrator 内新方法，替代单次 `runAgent('writer', ...)`）
- 单场 prompt 模板（`chapter-instruction.md` 拆出 scene 变体，或新增 `scene-instruction.md`）
- 单场字数核验函数（纯函数，可单测）

需要删除的：
- `parseSceneEmphasis`、`splitWeightedTargetWords`（正则解析自由文本，违反项目约定）
- `formatSceneBudgetGuidance` 的整章形态（改为单场预算注入）

`max_tokens` 物理闸的定位同步收窄：按**单场**预算换算（1000 字场 → 约 1500 token），闸门天然收紧，且截断风险只影响一场。

## 受影响文件

- `apps/agent-server/src/plugins/novel-plugin/core/tools/submit.ts`（来源：路由图 novel-plugin）：`SubmitNarrativeTaskParams` 增 `scenes[]`，execute 内加总和/核心场景数校验
- `apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`（路由图）：Writer 阶段改分场循环；`shadowWriteDirectorPlan` 转正为 `writeDirectorScenePlan`；PostWriteGuard 保留为兜底
- `apps/agent-server/src/plugins/novel-plugin/core/chapters/chapter-scene-plan-adapter.ts`（路由图）：删正则解析与加权拆分；`buildScenePlanFromNarrativeTask` 改为直接消费 Director 的 `scenes[]`
- `apps/agent-server/src/plugins/novel-plugin/core/chapters/word-budget-resolver.ts`（路由图）：`resolveWriterMaxTokens` 改按单场预算
- `apps/agent-server/src/plugins/novel-plugin/core/prompting/prompt-builder.ts`（路由图）：新增单场创作指令构建；整章 `scene_budgets` 占位符退役
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/chapter-instruction.md`（路由图）：拆分/新增单场变体
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-director.md`（路由图）：主次笔墨契约改为说明结构化 `scenes[]` 字段与预算分配规则
- `apps/agent-server/src/plugins/novel-plugin/core/chapters/writer-rewrite-plan.ts`（路由图）：新增单场压缩/扩写指令变体
- `apps/agent-server/src/plugins/novel-plugin/core/chapters/scene-word-check.ts`（新建）：单场字数核验纯函数
- 测试：`__tests__/novel-tools.test.ts`、`chapter-scene-plan-adapter.test.ts`、`word-budget-resolver.test.ts`、`golden-prompt.snapshot.test.ts`、新增 `scene-wise-writing.test.ts`

## 风险

- **场景衔接断裂**：分场生成最大的真实风险。缓解：把上一场正文末尾（约 300 字）作为「承接锚点」传入下一场 prompt，并要求下一场从该锚点自然进入；Reviewer 合稿后仍会检查全章连贯性。
- **调用次数增加**：3 场 = 3 次调用。缓解：前缀共享 `promptCacheScope`（已实现）；T6 实测对比 token 总量，若未省则回退合并策略（见"回退路径"）。
- **Director 分配预算不合理**：如给高潮场只分 500 字。缓解：工具校验只管总和与核心场景数；不合理分配由 Reviewer 事后反馈，不在本次做智能校正。
- **跨场质量下降**（首尾呼应、伏笔布点分散）：缓解：Reviewer 在合稿后评分，逻辑不变；`role-writer` 提示词说明「你在写第 N/M 场，全章钩子由最后一场兑现」。
- **续跑（resume）语义变化**：现有断点续跑以 `writing` 为整段入口。缓解：T5 把已完成场次记入 run state，续跑从未完成的场次继续；不改现有 `entry` 枚举。
- **群聊路径回归**：共用 `submit.ts` 与场景类型。缓解：`scenes[]` 设为可选字段，群聊路径不传即走原逻辑；T1 完成后先跑群聊全量测试。

## 测试策略

- 纯函数单测：`scene-word-check`（各分支阈值）、`buildScenePlanFromNarrativeTask`（消费结构化 scenes）、`resolveWriterMaxTokens`（单场口径）
- 工具校验单测：`scenes[]` 总和不匹配 / 核心场景 3 个 / order 不连续 → 拒绝并返回纠正提示；合法 → 写入 draft
- 编排集成测（沿用 `novel-orchestrator-interject.test.ts` 的 `createAgUiSession` mock 模式）：
  - 三场全部合规 → 合稿字数 = 各场之和，Writer 被调用 3 次
  - 场景 2 超标 20%+ → 该场被重写 1 次，场景 1/3 的产出未被重复调用
  - 场景 2 重写后仍超标 → 接受并从场景 3 预算扣除
  - 单场残稿 → 该场重写
- 快照：`golden-prompt.snapshot.test.ts` 更新（Director 契约 + 单场指令）
- 全量回归 + `tsc --noEmit`
- 人工验证：真实跑第 1 章，对比 agent-logs 的 token 总量与首稿字数（对照基线：本次 4740 字 / 单次调用）

## 路由图影响

- 需要 route-sync：是
- 预期新增/修改条目（`docs/routespec/feature-routes/novel-plugin.md`）：
  - 修改「章节创作流程（SSE）」：Writer 阶段从单次整章调用改为分场循环，补充单场核验与就地重写行为
  - 新增或并入「结构化场景计划（生成依据）」：说明 `scenes[]` 提交契约、总和校验、计划从影子写转正、`novel_scene_revisions` 成为生成来源
  - 修改「领域子模块（core/ 分域）」中 chapters 分域描述：新增 scene-word-check

## 验收标准

1. Director 不提交合法 `scenes[]`（总和不等于目标 / 核心场景 >2）时，工具拒绝并要求重提，不进入 Writer。
2. Writer 按场调用，agent-logs 中同一章出现 N 条 writer 记录（N = 场景数），每条 `resultLength` 落在该场预算 ±20%。
3. 合稿字数落在目标 ±15%，PostWriteGuard 的「字数严重超标」不再是常态命中项。
4. 单场超标只重写该场：agent-logs 可见该场 2 条记录，其余场各 1 条。
5. 真实跑一章的 token 总量不高于当前「单次整章 + 一轮整章压缩重写」的基线。
6. 群聊路径（`create-discussion`）行为不变，`team-discussion-engine.test.ts` 全绿。
7. `parseSceneEmphasis` 及加权拆分代码已删除，仓库内无从 `narrativeTask` 文本正则解析场景结构的实现。
8. 全量测试 + `tsc --noEmit` 通过。

## 任务

- [x] T1：Director 提交结构化 `scenes[]` + 工具硬校验（2026-09-02 完成）
  - 文件：`core/tools/submit.ts`、`core/prompts/role-director.md`、`__tests__/novel-tools.test.ts`
  - 改动：`SubmitNarrativeTaskParams` 增可选 `scenes` 数组（order/title/emphasis/targetWords/goal/entry/pressure/choice/consequence）；execute 内校验总和（经 `options.baseTarget` 闭包注入，orchestrator 两处调用点均已传）、核心场景 ≤2、order 连续唯一、数量=sceneCount；不合法返回纠正提示。role-director.md 的「主次笔墨」改为结构化字段与预算分配规则（身份预算上限 8000→9000，已同步去重压缩）
  - 验证：`novel-tools.test.ts` 新增 5 个校验用例（合法提交/总和不符/核心>2/order 与数量不一致/无 baseTarget 旁路）；`golden-prompt` director 身份快照更新
  - 实测状态：待真实跑一次 Director 验证首轮合法提交率

- [x] T2：场景计划从影子写转正（2026-09-02 完成）
  - 文件：`core/novel-orchestrator.ts`（`shadowWriteDirectorPlan` → `writeDirectorScenePlan`）、`core/chapters/chapter-scene-plan-adapter.ts`
  - 改动：`buildScenePlanFromNarrativeTask` 直接消费 `task.scenes`（title/goal/逐场 targetWords 取 Director 分配；无 scenes 保留均分兼容）；`formatSceneBudgetGuidance` 改读结构化 scenes 并删除 `parseSceneEmphasis` / `splitWeightedTargetWords` 正则解析与 2:1 加权；方法与日志文案改为「批准的场景计划写入」
  - 验证：`chapter-scene-plan-adapter.test.ts` 重写 formatSceneBudgetGuidance 用例（均分回退/结构化分配/数量不一致防御）+ 新增 scenes 消费用例；store 链路集成用例随方法改名
  - 依赖：T1

- [x] T3：单场创作指令与单场字数核验（2026-09-02 完成）
  - 文件：`core/prompts/scene-instruction.md`（新建）、`core/prompting/prompt-builder.ts`、`core/chapters/scene-word-check.ts`（新建）、`core/chapters/writer-rewrite-plan.ts`、`__tests__/scene-word-check.test.ts`（新建）、`__tests__/scene-instruction.test.ts`（新建）
  - 改动：新增单场指令模板（本场契约/本场预算/承接锚点/只写本场）；prompt-builder 增 `buildSceneInstruction`；`scene-word-check` 纯函数返回 `accept | compress | expand`；`writer-rewrite-plan` 增单场压缩/扩写指令
  - 验证：`scene-word-check.test.ts`、`writer-rewrite-plan.test.ts`、`scene-instruction.test.ts` 与类型检查通过；单场模板已接入 `PromptBuilder.buildSceneInstruction`
  - 依赖：T2

- [x] T4：Writer 分场循环接入 create-flow（2026-09-02 完成）
  - 文件：`core/novel-orchestrator.ts`、`core/chapters/word-budget-resolver.ts`、`__tests__/novel-orchestrator-run-context.test.ts`
  - 改动：Writer 阶段改为按 `scenes[]` 循环调用，每场核验 + 就地重写（上限 1 次）+ 超出量向后扣减；合稿后进现有 Guard；`resolveWriterMaxTokens` 改按单场预算
  - 验证：`novel-orchestrator-run-context.test.ts` 分场调用/就地重写用例通过；`resolveWriterMaxTokens` 已按单场预算接入
  - 依赖：T3

- [x] T5：续跑与进度事件适配（2026-09-02 完成）
  - 文件：`core/novel-orchestrator.ts`、`core/workflow-run-store.ts`、`__tests__/novel-orchestrator-run-context.test.ts`
  - 改动：run state 记录已完成场次与各场正文，续跑从未完成场次继续；逐场进度经现有 `phase_change` 推送（前端无需改动）
  - 验证：`novel-orchestrator-run-context.test.ts` 覆盖已完成场景跳过、上一场尾部承接、逐场快照及失败保留；`workflow-run-store.test.ts` 7 tests passed；`tsc --noEmit` 通过
  - 依赖：T4

- [ ] T6：实测对账与回归
  - 文件：`docs/routespec/2026-09-01-scene-wise-writing/measurement.md`（新建）
  - 改动：真实跑第 1 章，记录各场字数、调用次数、token 总量、缓存命中率；与基线（4740 字 / 单次 + 一轮整章压缩）对比并写入报告
  - 验证：全量 `vitest run` + `tsc --noEmit`；验收标准逐条核对
  - 依赖：T5

## 任务关系

- 强相关：T1 + T2（同一份 `scenes` 契约，schema 与消费方必须一致落地）；T3 + T4（单场指令与调用循环共改 orchestrator 与 prompt-builder，顺序依赖）
- 弱相关：T5（在 T4 之后，文件边界与验证入口相对独立）
- 独立：无（本方案是一条改造链）
- 冲突风险：T2 / T4 / T5 都改 `novel-orchestrator.ts`，必须串行；T3 / T4 都改 `prompt-builder.ts` 与 `writer-rewrite-plan.ts`，同样串行

## 回退路径

若 T6 实测显示 token 总量反而升高（缓存命中不足），保留 T1/T2 的结构化契约（它们本身消除了正则解析、且让 Director 显式分配预算），把 T4 的循环退化为「一次调用但 prompt 内带结构化逐场预算」——即当前形态，但预算来自 Director 结构化分配而非系统均分。这条回退不需要撤销 T1-T3。

> **2026-09-02 执行注记**：T1-T5 已落地。Writer 在 `task.scenes[]` 存在时按场调用，单场
> 字数由系统核验并就地压缩/扩写，已完成场景写入 `novel_workflow_runs.writer_scenes` 供续跑；
> 无结构化场景的旧数据仍走整章兼容路径。T6 的真实模型 token/缓存对账尚未执行。

> **2026-09-02 补充**：`ai-arrange` 的 `arrange_review` 检查点已增加按类型分组的实体明细，
> 审核前可查看具体实体及本章功能/推进/伏笔动作等核心约束；确认、修改、拒绝的实际落库与回滚语义不变，旧版仅计数载荷继续兼容。

## RouteSync

- 需要 route-sync：已完成（T1-T5 的入口、单场循环、续跑快照与测试入口已同步；T6 仅新增对账记录）
- 已更新：`docs/routespec/feature-routes/novel-plugin.md` 的「章节创作流程（SSE）」条目已补
  scenes[] 提交契约、单场 Writer 循环、续跑快照与测试入口；「领域子模块」chapters/prompting 分域已补
  scene-word-check 与单场指令模板说明
