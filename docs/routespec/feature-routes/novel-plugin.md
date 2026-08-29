# novel 业务插件

> 插件路径：`apps/agent-server/src/plugins/novel-plugin/`，API 前缀 `/api/plugins/novel`。

### 插件入口与服务组装

- 描述：插件 setup 7 步流程：服务初始化 → Fastify decoration（store/promptManager/promptBuilder/sessionFactory/engine/orchestrator）→ 注册 4 个 Novel Agent → 注册 Team → Session 工具 → REST 路由 → 前端面板。
- 入口：`apps/agent-server/src/plugins/novel-plugin/index.ts`（createNovelPlugin）、`manifest.json`
- 核心：
  - `novel-services.ts`（createNovelServices 服务依赖图）
  - `core/novel-store.ts`（跨域 Store facade 与事务收口）
  - `core/novel-engine.ts` / `core/novel-orchestrator.ts`（创作状态机与多 Agent 编排）
  - `novel-migrations.ts`（唯一 schema 迁移来源）
- 测试：`apps/agent-server/src/plugins/novel-plugin/__tests__/`
- 备注：**详细架构与数据流见同目录 `ARCHITECTURE.md`**（含数据模型、提示词三层缓存、17 个工具、编排流程图、API 清单），改 novel 功能先读它。
- 覆盖：partial
- last-updated: 2026-08-25

### 章节创作流程（SSE）

- 描述：三条触发路径——`create-flow`（手动编排矩阵）、`ai-arrange`（AI 编排后确认再创作）、`create-team`（同步兼容入口）；Director → Writer → 质量门 → 盲审/Reviewer → 检查点 → Reviser/Memory。群聊路径（`create-discussion`，后台运行 + 事件 tail）另见「群聊共创演绎链路」。
- 入口：HTTP `POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/create-flow` 等
- 核心：`routes/creation-flow-routes.ts`（SSE 与检查点决策）、`core/novel-orchestrator.ts`（createChapterWithFlow）
- 测试：`apps/agent-server/src/plugins/novel-plugin/__tests__/creation-flow-routes.test.ts`
- 备注：检查点决策经 `POST .../checkpoint/:type/decision` + EventEmitter 传递；群聊（create-discussion）自 2026-08-28 起为后台运行 + 事件 tail，与其余路径的一次性 SSE 不同。诊断见 `docs/novel/2026-08-24-群聊演绎链路诊断与修复方案.md`。
- 覆盖：partial
- last-updated: 2026-08-28

### 群聊共创演绎链路（确定性调度器 + 事件溯源 + 自主 mention）

- 描述：2026-08-28 控制平面重排——Moderator 整体删除，planning 由引擎直呼 Director（`novel_submit_scene_plan` 工具 payload 即完成信号，空终答也采用；不可解析文本纠正重试一次，连续无产出抛检查点），acting 由确定性策略表处置（`acting-policy.ts`：completed / thin / skipped / unreached，编 cheng SceneActingReport；只有"全部场景零演出"才停检查点问用户，缺口经 Writer 质量契约绕开而非盲写/阻断）。角色 mention 合成为 `kind:'reaction'` 节点（`parentBeatId` 继承压力上下文，不占 Director 节点名额、不误标完成），受去环/深度/边重复/每场预算约束；无预置节点也能接戏。全章 run 落 append-only 事件流 `novel_discussion_events`（迁移 121）：状态 = fold(events)，续跑位置由 `deriveResumeInfo(events)` 推导（run 行已停写 failedPhase 三元组；旧快照按 transcript 反推兼容）。自由聊天的选人用轻量 `chat-respondent-picker.ts`（Moderator 唯一群聊外用途的替代）。
- 入口：HTTP `POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/create-discussion`（**202 + runId，后台执行**）、`GET .../discussion-runs/:runId/events?from=seq`（SSE tail：重放 + 实时，run_finished 收流）、`POST .../discussion-runs/:runId/cancel`（显式取消，等待收尾）、`POST .../create-discussion/:runId/resume`（断点续跑，仍为 SSE）、`POST /projects/:projectId/discussion-checkpoint/:checkpointId/decision`（检查点决策；后台 run 经事件流 `checkpoint_pending` 事件携带 checkpointId）。断开连接不再 abort run，只有显式 cancel 停止。
- 核心：
  - `core/discussion/engine/team-discussion-engine.ts`（`runPlanning` 直呼 Director、`runActionBeatScene` 节点状态机 + 策略表处置、`synthesizeReactionNode`/`drainPendingReactions` reaction 队列、`raiseCheckpoint` 事件成对、`emitEvent` 事件溯源钩子、`applyCastWhitelist` 白名单、`buildDiagnosticsSnapshot` 调用统计）
  - `core/discussion/engine/acting-policy.ts`（策略表 + `decideWeaveGate` 编织闸门 + `buildWriterQualityContract` 质量契约）
  - `core/discussion/engine/step-executor.ts`（Step 执行器：工具闭包 / 空终答 / 重试 / 取消收口）
  - `core/discussion/engine/discussion-types.ts`（`SceneActionBeat.kind/parentBeatId`、`DiscussionEventType`、`DiscussionOptions.onEvent`、`DiscussionResumeState.completedActionBeatIds`）
  - `core/discussion/discussion-event-store.ts`（append/list/`foldDiscussionEvents`/`deriveResumeInfo`/`reconcileOrphanRuns` 启动孤儿回收）
  - `core/tools/submit.ts`（`createNovelSubmitScenePlanTool`（`requireActionBeats`）、`createNovelSubmitCharacterTurnTool`；Moderator 决策工具已删除）
  - `core/discussion/novel-discussion-runner.ts`（成员构建、toolset 工厂、`allowLegacyActing: false`）
  - `core/chapters/chat-respondent-picker.ts`（自由聊天轻量选人）
  - 提示词：`core/prompts/role-director-discussion.md`（动作图契约）、`role-character-actor.md`（结构化回合 + mention 主动接戏）
- 前端：`apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts`（`startDiscussion` 走 202 → events tail：`progress` 镜像事件复用既有 `novel:progress` 处理、`checkpoint_pending`/`run_finished` 映射检查点与结果；`upsertAgentOutput` 统一 director/character/moderator 三类 `agent_output` 占位覆盖）、`hooks/use-conversation-messages.ts`（`actorTurn` 可展开区）
- 测试：`__tests__/team-discussion-engine.test.ts`（51 用例：planning 直呼/空终答/检查点、策略表逐情形、reaction 无预置节点可回应不误标完成、可见性隔离、取消、事件重放续跑、旧快照缺口记账）、`__tests__/discussion-event-store.test.ts`（seq 单调 / fold / from 重放 / deriveResumeInfo）、`__tests__/creation-flow-routes.test.ts`（202 契约、events tail、cancel、断点续跑）、`__tests__/creation-flow-interject-route.test.ts`、`__tests__/novel-discussion-runner.test.ts`、`apps/desktop/.../hooks/__tests__/use-novel-creation-flow.test.ts`
- 备注：事件类型含 `progress`（展示事件镜像，事件 tail 可完整重放旧 SSE 的 UI 内容）与 `interject_status`（插话三态）。`diagnostics` 仍只在后端 `DiscussionResult`，尚未透出到 `CreationResult`。方案与进度见 `docs/routespec/2026-08-28-discussion-flow-repair/spec.md`。
- 覆盖：sufficient
- last-updated: 2026-08-28


### REST 子路由（按域拆分）

- 描述：项目/回收站、卷、章节、角色、剧情轨道、画布图谱、记忆事件、提示词模板、实体维护、缓存诊断、观测等。
- 入口：`novel-routes.ts`（聚合器，前缀 `/api/plugins/novel`）
- 核心：`routes/` 子目录（project-routes、volume-routes、chapter-routes、beat-plan-routes、character-routes、narrative-routes、graph-routes、memory-routes、prompt-routes、entity-delete-routes、entity-maintenance-routes、cache-routes、observability-routes）
- 覆盖：partial
- last-updated: 2026-08-26

### 卷级节拍表与章节一体化（Beat Planner）

- 描述：卷纲质量门（<50 字拒绝）→ 按卷生成节拍表或单章生成/重生成（十种戏剧功能/情绪债务/爽点/弧光位置；单章为外科手术式，只替换该章一行）。发布章节同事务 confirm 节拍；删章重排覆盖 `novel_beat_plans`。前端共享数据源，大纲树章节行内嵌节拍徽标/行内编辑/单章生成，创作面板显示本章节拍横幅，SSE `chapter_context` 事件携带 `beatConstraint`，Director 决策顺序第 0 条服从节拍（role-director.md）。
- 入口：HTTP `POST /api/plugins/novel/projects/:projectId/volumes/:volumeNumber/beat-plan/generate`、`POST .../projects/:projectId/chapters/:chapterNumber/beat-plan/generate`、`GET .../projects/:projectId/beat-plans`、`GET .../chapters/:chapterNumber/beat-plan`、`PATCH /beat-plans/:id`
- 核心：`core/chapters/beat-plan-generator.ts`（VolumeBeatPlanner.generate/generateForChapter + parseBeatPlanDraft/parseSingleBeatDraft + submit_chapter_beat 结构化提交工具）、`core/stores/beat-plan-store.ts`（replaceVolumePlan/upsertChapterPlan/confirmBeatForChapter）、`routes/beat-plan-routes.ts`、`core/prompts/role-beat-planner.md` + `core/prompts/role-chapter-beat-planner.md`、`core/novel-store.ts#publishReviewedChapter`（发布确认接线）、`core/chapters/chapter-renumber.ts`（CHAPTER_RENUMBER_FIELDS 含 novel_beat_plans）、`core/novel-engine.ts#buildChapterConstraints`（beatConstraint 注入）
- 前端：`stores/novel-beat-store.ts`（共享数据源）+ `hooks/use-beat-plans.ts`（加载器挂 ProjectTree）；`components/novel/outline-tree.tsx`（ChapterRow 节拍徽标/行内编辑/单章生成）、`components/novel/sidebar/beat-plan-group.tsx`、`sidebar/beat-edit-form.tsx`、`sidebar/beat-labels.ts`、`components/novel/chapter-beat-banner.tsx`（创作面板横幅）、`hooks/use-novel-creation-flow.ts`（chapter_context 节拍块渲染）
- 测试：`__tests__/beat-plan.test.ts`（草稿解析/按卷替换/单章 upsert/发布确认/删章重排/卷纲质量门）、`apps/desktop/.../components/novel/__tests__/outline-tree.test.tsx`（节拍徽标/单章生成/已发布只读）
- 覆盖：sufficient
- last-updated: 2026-08-26（docs/routespec/2026-08-26-beat-chapter-integration/）

### 领域子模块（core/ 分域）

- 描述：stores（实体 CRUD/版本链/事务）、chapters（章节聊天/版本/场景计划）、prompting（三层缓存 PromptManager/Builder）、memory（长期记忆/账本）、entities（准入/编排/相似度）、quality（文风质量/陈词检测）、analysis（矩阵投影/一致性）、discussion（群聊）、generation（角色/实体生成）。
- 核心：`apps/agent-server/src/plugins/novel-plugin/core/`
- 备注：各分域细节以 `ARCHITECTURE.md` 为准，本次未逐一展开。
- 覆盖：partial
- last-updated: 2026-08-25

### 参考小说 → 文风基线与专家团自动生成

- 描述：分析 run 完成（awaiting_review/completed）后前端弹确认框，一键完成 ① 分层取样正向基线样本（auto-baseline，头/中/尾，≤5 条）② 按维度蒸馏专家团（一维一专家 × 7 维：场景/人物/对话/打斗/情感/冲突/叙事，每维一次 LLM 调用，幂等可断点续传）。产物为草稿态（enabled=false + reviewStatus='draft'），在文风档案面板审核启用；启用后经既有 buildAgentIdentity → compileWritingStylePrompt 注入 writer/reviser/reviewer。
- 入口：HTTP `POST /api/plugins/novel/projects/:projectId/writing-style-profile/auto-baseline`、`POST /api/plugins/novel/reference-sources/:sourceId/style-team-distill/dimension`；前端 `apps/desktop/src/renderer/src/components/novel/reference-analysis/reference-run-panel.tsx`（确认框与逐维进度，需 projectId prop）
- 核心：`core/prompting/style-expert-distiller.ts`（conflict_craft 维度 + `options.dimension` 聚焦蒸馏与硬过滤）、`novel-routes.ts`（auto-baseline + 句界截断共享 `truncateReferenceSample`）、`novel-migrations.ts` 迁移 119（novel_style_experts 加 dimension/team_key/review_status）、`core/stores/world-store.ts`（三字段映射；PATCH 启用即置 approved）
- 前端面板：`apps/desktop/src/renderer/src/components/novel/writing-style-profile-editor.tsx` 与 `writing-style-expert-menu.tsx`（按 teamKey 分组、维度徽标、待审核徽标、组级全选 ≤8）、`api/novel-client.ts`（autoBaselineFromReference / distillStyleTeamDimension / STYLE_TEAM_DIMENSIONS）
- 测试：`apps/agent-server/src/plugins/novel-plugin/__tests__/style-team-distill.test.ts`（维度过滤、幂等、空维度、分层取样、满位跳过、启用流转、迁移默认值）
- 备注：手动单专家蒸馏路径（style-distill-launcher + `/style-distill`）保留不变；历史专家无新字段时分组 UI 以 sourceTitle 兜底。专家团注入增强（场景聚焦 + Reviewer/Reviser 风格决策）落在 `prompt-builder.ts`（`buildWriterSceneExpertFocus`、reviewer-rubric/reviser-guidance chunk）与 `writing-style-prompt-factory.ts`（`buildSceneExpertFocus`、`renderStyleExpertCard` 共享渲染），由 `novel-orchestrator.ts` runAgent 在 writer suffix 追加。
- 覆盖：sufficient
- last-updated: 2026-08-25（docs/routespec/2026-08-25-reference-style-team/）
