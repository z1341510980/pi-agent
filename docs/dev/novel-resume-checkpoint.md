# 小说创作工作流断点续跑

> 状态：功能代码已接入，专项测试和 agent-server 类型检查通过；lint 仍受仓库既有问题影响
>
> 更新时间：2026-08-15

## 1. 背景

小说创作有两条主要流程：

- `create-flow`：Director -> Writer -> Reviewer -> Reviser -> Memory/Finalizer
- 群聊：Planning -> Scene Acting -> Chapter Weaving -> Reviewing -> Memory/Finalizer

旧行为存在两个问题：

- `create-flow` 失败后只能从 Director 重新开始。
- 群聊只有 `chapter_weaving` 阶段失败时支持续跑，Planning、场景设置和角色演出失败后只能重来。

断点续跑的目标是持久化阶段边界产物，失败后跳过已经完成的高成本阶段。Director 和 Writer 通常是输入量、输出量和 token 消耗最大的阶段，不能因为后续审校或收尾失败而重复执行。

## 2. 续跑策略

### 2.1 create-flow

工作流保存三个可续跑入口：

| 入口        | 已保存内容                                           | 恢复动作                                        |
| ----------- | ---------------------------------------------------- | ----------------------------------------------- |
| `writing`   | Director 叙事任务、Director 输出、节奏建议、编排实体 | 跳过 Director，重新执行 Writer                  |
| `reviewing` | 上述内容 + Writer 草稿                               | 跳过 Director 和 Writer，重新执行 Reviewer      |
| `memory`    | 上述内容 + 最终正文                                  | 跳过生成、审校和修订，直接进入 Finalizer/Memory |

审校或 Reviser 阶段失败时，当前实现会从 `reviewing` 入口继续。这样会重新执行一次 Reviewer，但不会重烧 Director 和 Writer。

### 2.2 群聊

群聊快照支持以下阶段：

| 失败阶段          | 恢复动作                                    |
| ----------------- | ------------------------------------------- |
| `scene_setup`     | 从失败场景重新进入场景循环                  |
| `acting`          | 从 `failedSceneId` 对应场景重新进行角色推演 |
| `chapter_weaving` | 跳过 Moderator 和角色推演，直接重新编织章节 |
| `reviewing`       | 使用已保存正文，直接重新进行最终质量门      |

Planning 阶段暂不支持断点续跑。该阶段失败时通常没有足够稳定的场景计划可以安全恢复，仍然需要重新规划。

## 3. 后端改动

### 3.1 数据库迁移

`apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`

- Migration `101_create_novel_workflow_runs`
  - 新增 `novel_workflow_runs`
  - 保存 `director_task`、`director_output`、`rhythm_suggestion`、`arranged_entities`、`writer_draft`、`final_content`、`model_id`
  - 保存 `phase`、`failed_phase`、`resumed_from_run_id`
- Migration `102_add_discussion_run_failed_scene`
  - 为 `novel_discussion_runs` 增加 `failed_scene_id`

### 3.2 工作流快照存储

文件：`apps/agent-server/src/plugins/novel-plugin/core/workflow-run-store.ts`

主要类型：

- `WorkflowRunPhase`
- `WorkflowResumeState`
- `WorkflowRunSnapshot`
- `WorkflowRunStore`

主要方法：

- `save()`：保存阶段边界或终态
- `get()`：按运行 ID读取快照
- `getLatestResumable()`：按项目和章节读取最近一条 `error/running` 且有阶段边界的快照

### 3.3 create-flow 路由

文件：`apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts`

新增行为：

- create-flow 启动后生成 `workflowRunId`
- 收到阶段边界时立即保存 `running` 快照
- 失败后保存 `error` 快照
- `novel:result` 携带：
  - `workflowRunId`
  - `canResume`
  - `failedPhase`
- 新增接口：

```text
POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/create-flow/:runId/resume
```

其中 `runId=latest` 时，后端会读取该章节最近一条可续跑快照，适用于应用重启后前端已经丢失上次 SSE 结果的情况。

### 3.4 Orchestrator

文件：`apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`

`CreationOptions` 新增：

- `resume?: WorkflowResumeState`
- `onRunStateUpdate?: (state: WorkflowResumeState) => void`

Orchestrator 在三个边界触发 `onRunStateUpdate`：

1. Director 任务确认后
2. Writer 草稿完成后
3. 最终正文确定后

Orchestrator 还会返回 `failedPhase`，用于错误展示和快照审计。

## 4. 群聊改动

### 4.1 类型扩展

`DiscussionResumeState.phase` 从单一的 `chapter_weaving` 扩展为：

- `scene_setup`
- `acting`
- `chapter_weaving`
- `reviewing`

`DiscussionResult` 新增 `failedSceneId`。

### 4.2 引擎

文件：`apps/agent-server/src/core/agent/team-discussion-engine.ts`

主要改动：

- 将场景演出循环抽为 `runSceneLoop()`
- `run()` 追踪当前阶段和当前场景
- 场景失败时返回 `failedPhase` 和 `failedSceneId`
- 新增 `resumeSceneActing()`
- `resumeChapterWeaving()` 支持 `reviewing` 入口

### 4.3 Runner 和路由

文件：

- `apps/agent-server/src/plugins/novel-plugin/core/discussion/novel-discussion-runner.ts`
- `apps/agent-server/src/plugins/novel-plugin/routes/creation-flow-routes.ts`
- `apps/agent-server/src/plugins/novel-plugin/core/discussion/discussion-run-store.ts`

Runner 根据快照阶段选择：

- `acting/scene_setup` -> `resumeSceneActing()`
- `chapter_weaving/reviewing` -> `resumeChapterWeaving()`

群聊 `canResume` 判定现在覆盖四个可续跑阶段。快照会保存 `failedSceneId` 和正文 `content`。

## 5. 前端改动

### 5.1 Hook

文件：`apps/desktop/src/renderer/src/hooks/use-novel-creation-flow.ts`

新增：

```ts
resumeWorkflow(projectId, chapterNumber, runId)
```

调用新的 create-flow resume 接口，并将 `flowMode` 设置为 `workflow`。

### 5.2 会话面板

文件：`apps/desktop/src/renderer/src/components/novel/novel-conversation-panel.tsx`

错误卡支持：

- 群聊 `discussionRunId`
- 工作流 `workflowRunId`

`/继续` 命令支持：

- 当前结果中存在具体运行 ID时，按运行 ID续跑
- 工作流没有结果 ID时，回退调用 `workflow/latest`

### 5.3 工作区

文件：`apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`

新增工作流恢复回调：

```ts
handleResumeWorkflow(runId)
```

它会恢复工作流 Tab、重置前端临时状态，然后调用 `creationFlow.resumeWorkflow()`。

## 6. 当前验证结果

截至本次整理，以下验证通过：

### 后端测试

```text
4 test files passed
64 tests passed
```

覆盖：

- `team-discussion-engine.test.ts`
- `novel-discussion-runner.test.ts`
- `creation-flow-routes.test.ts`
- `workflow-run-store.test.ts`
- `team-discussion-engine.test.ts` 中新增 acting 断点续跑用例

### 前端测试

```text
4 test files passed
43 tests passed
```

覆盖：

- `use-novel-creation-flow.test.ts`
- `novel-conversation-panel.test.tsx`
- `novel-conversation-interject.test.tsx`
- `novel-workspace-command.test.tsx`

## 7. 当前验证结论与剩余项

功能专项验证已完成，但以下工程门禁仍需单独处理：

1. `agent-server` 类型检查已通过：`pnpm --filter agent-server exec tsc --noEmit`。
2. `resumeSceneActing()` 专项测试已补充并通过。
3. 前端 `resumeWorkflow()` URL 和 `latest` 入口测试已补充并通过。
4. desktop 全量类型检查仍有仓库原有错误，主要涉及：
   - `novel-client.ts`
   - `usage-panel.tsx`
   - `cache-monitor-panel.tsx`
   - `observability-timeline.tsx`
   - `conversation-input.test.tsx`
   - 其他已有测试 fixture
5. 变更文件 lint 仍有大量仓库既有问题，包括 `explicit-function-return-type`、`no-unused-vars` 和 prettier 行尾/格式警告；本次没有对大型文件做全量自动格式化，避免产生无关 diff。
6. 仍需要补一次真实流程验证：
   - create-flow 在 Writer 后人为失败，然后点击「从中断处继续」
   - 群聊在 acting 阶段失败，然后点击「从中断处继续」
   - 应用重启后使用 `/继续` 恢复最近的工作流快照

## 8. 建议的后续顺序

1. 处理仓库既有 desktop 类型错误。
2. 按团队规则决定是否单独清理本次变更文件的 lint 错误和格式警告。
3. 做一次真实 SSE 手工验证：
   - create-flow 在 Writer 后人为失败，然后点击「从中断处继续」
   - 群聊在 acting 阶段失败，然后点击「从中断处继续」
   - 应用重启后使用 `/继续` 恢复最近的工作流快照
4. 检查最终 diff 后再提交。

## 9. 注意事项

- 当前工作区还有其他未关联的用户修改，不能使用 reset、checkout 或 stash 清理无关文件。
- 本功能未创建 commit，也未 push。
- `novel_workflow_runs.status='running'` 用于识别进程崩溃后留下的阶段快照；resume 接口允许恢复 `running` 和 `error`，但不允许恢复 `completed/cancelled`。
- `planning` 阶段没有稳定的中间快照，群聊仍需重新开始；这是当前设计边界，不是遗漏的前端按钮。

## 10. 统一章节会话

第二阶段已完成前端入口合并：

- 右侧旧的独立“聊天”Tab 已移除。
- 旧 localStorage 中的 `rightPanelView: 'chat'` 会迁移到 `conversation`。
- 统一“会话”面板同时承载：
  - 自由聊天历史和流式回复
  - `create-flow` 工作流输出
  - 群聊输出
  - 检查点
  - 插话
  - 错误卡和断点续跑操作
- 空闲状态的普通文本进入自由聊天。
- `/写 N`、`/重写 N`、`/群聊 N`、`/继续` 仍然是流程命令。
- 运行结构化流程时，普通文本仍然作为插话，不会另起自由聊天。
- 后端 `ChapterChatRunner`、`NovelOrchestrator`、`TeamDiscussionEngine` 仍保持独立，避免破坏各自状态机。

第二阶段验证：

```text
3 test files passed
33 tests passed
```

这次合并属于会话入口和展示层合并，不是后端执行器合并。下一步如果需要继续，可以抽出 `useNovelSession`，将现有两个 Hook 的状态适配成统一的 `activeRun`、`runKind` 和消息事件模型。

## 11. 统一会话适配层

第三阶段已新增 `useNovelSession`：

- 工作区通过它取得 `creationFlow` 和 `chapterChat`。
- 新增 `activeRun`，统一表达 `idle`、`chat`、`workflow`、`discussion` 等运行态。
- 保留两个底层 Hook 的完整返回值，暂不改写已有业务调用点。
- 新增统一会话 Hook 测试。

这一步是状态适配，不是后端执行器合并。后续可以继续把工作区对 `creationFlow`/`chapterChat` 的直接调用逐步收口到 `useNovelSession`。

## 12. 命令入口与模式分类

第四阶段已完成：

- 输入框输入 `/` 时显示命令候选弹层。
- 支持键盘上下选择、Enter 选中、Esc 关闭。
- 命令弹层包含：
  - `/写 N`
  - `/重写 N`
  - `/群聊 N`
  - `/继续`
- 已输入完整命令时，Enter 仍然直接执行，不会被弹层拦截。
- 顶部不再把工作流和群聊作为两个长期存在的分类入口。
- 顶部只保留反推和矩阵编排等低频模式。
- 工作流和群聊通过命令弹层选择，普通文本默认进入自由聊天。

因此，当前交互分类变成：

```text
统一章节会话
  ├── 普通文本：自由聊天
  ├── /写 N：默认工作流
  ├── /群聊 N：群聊共创
  ├── /重写 N：重写工作流
  └── /继续：断点续跑
```

命令输入相关回归测试通过：33 个测试通过。

## 13. 文风专家团（已迁出）

> 本节记录的是演进过程中的阶段性状态。文风系统的完整诊断、目标模型、
> 交互设计与实施路线已独立成文档：**[novel-style-system.md](./novel-style-system.md)**。
> 以下内容仅作历史留痕，以新文档为准。

文风功能曾整理为“专家团”形态，以 `NovelWritingStyleProfile` 作为唯一生效源。

### 专家模型

- 每个专家代表一套从某本小说或某组样本中蒸馏出的独立文风能力。
- 专家有自己的名字、来源小说/样本、能力摘要和可编辑提示词。
- 专家不是“文风总监/样本策展”这类工作岗位，也不负责调度其他专家。
- 输入框的“文风专家团”选择的是本轮要叠加的文风能力。

### 生效链路

```text
文风设置 -> 专家团配置 -> NovelWritingStyleProfile
  -> WritingStylePromptFactory
  -> Writer / Reviewer / Reviser
```

专家团配置存入 `novel_writing_style_profiles.style_experts`，不会产生第二套文风档案。旧档案没有专家配置时，读取时自动使用四个默认蒸馏风格专家。每个专家包含 `sourceTitle`、`description` 和 `prompt`，用户可以修改对应提示词。

当前默认专家仅是内置示例，实际项目应通过后续“从小说样本蒸馏”流程替换或新增。专家不会互相调度，也没有岗位型主理人；它们只是本轮可以叠加的独立文风能力。

文风蒸馏入口已接入详细设置页：输入来源作品、作者和样本后，调用
`POST /projects/:projectId/writing-style-experts/distill` 生成专家草稿；草稿先回填到编辑器，用户确认保存文风档案后才正式生效。样本不会自动覆盖已有专家。

设置页新增“专家团”页签，可以逐个启用/停用专家并编辑专家指令。专家意见有长度上限，避免重新突破原有文风提示词预算。

验证：文风档案和提示词相关后端测试 14 个通过，`agent-server` 类型检查通过；编辑器测试 2 个通过。
