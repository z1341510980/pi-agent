# 插件会话 Skill 白名单接入方案（Reviewer 试点 + 全路径迁移 + 剩余路线）

> 日期：2026-08-14
> 范围：`apps/agent-server` 后端
> 状态：全部既定迁移项已交付——标准工作流五角色、Memory JSON 提取、群聊/自由聊天、多 Skill 编译器、受限 skill_read、AgentRuntime 抽象、会话身份索引 P0 与 Skill 指纹审计

## 1. 背景与目标

当前 `plugin:*` 会话（小说创作等）在 `createPiSession` 中设置 `noSkills: true`，原因是在早期的 token 实测中，插件 Agent 不需要编码 Agent 的文件/shell 工具与 Skills，且 Pi 的 Skills 清单、工具说明等会无条件进入系统提示词，单次往返会附带约 1.3–1.7 万字符的无关内容（见 `pi-session.ts` 顶部注释）。

但 `noSkills: true` 同时切断了把 Agent 角色方法 Skill 化的路径：角色规则、提示策略、质量标准目前散落在 `prompts/*.md` 与 TypeScript 编排器中，无法独立迭代，也无法按题材/模式替换。

本方案的目标是：

1. 保持 `plugin:*` 不扫描环境中的全部 Skills（不恢复 token 浪费）。
2. 提供一条**显式授权**的 Skill 加载通道，只加载本次调用指定的 SKILL.md。
3. 用 Pi 原生 `/skill:<name>` 语法在发送前展开 Skill 正文，插件 Agent **不需要**通用 `read` 工具。
4. 以 Reviewer 为首个试点验证通道，随后完成 Director 迁移（标准工作流），再完成 Writer/Reviser 迁移；Memory 与群聊/chat 路径暂不接入。
5. 兼容既有用户配置：项目级文件或 SQLite 覆盖了该角色模板时，自动回退旧 Prompt 路径。

## 2. 总体设计

### 2.1 分层职责

```text
对话产品层（工作流/群聊/反推/矩阵编排，前端对话呈现）
        ↓
应用编排内核（NovelOrchestrator / TeamDiscussionEngine，状态机、检查点、事务、并发锁、恢复）
        ↓
Skill 组合层（按 Agent 角色显式授权 Skill，白名单加载 + 发送前展开）
        ↓
Pi 运行时（DefaultResourceLoader 定向加载 + /skill: 展开）
        ↓
LLM 与工具
```

- **Skill 回答“Agent 应该怎么做”**：角色方法、判定顺序、提交协议。
- **编排器决定“现在轮到谁、失败怎么办、是否允许继续”**：状态转换、检查点、重试、预算。
- **底座决定“如何加载与展开 Skill”**：白名单路径 + 原生 `/skill:` 语法。
- **持久化**：对话历史、运行快照、小说领域账本继续由 SQLite 承载，与 Skill 无关。

### 2.2 为什么不在 `plugin:*` 直接开放 `read`

通用 `read` 会让插件 Agent 重新获得工作区文件读取能力，并带回内置工具 schema 与使用说明，削弱此前的 token 优化。对 Reviewer 这类纯领域 Agent，它只需要读取被授权 Skill 的正文和引用，不需要浏览整个仓库。因此：

- 当前试点：通过 `/skill:novel-reviewer` 由 Pi 原生展开 `SKILL.md`，不需要 `read`。
- 后续若 Skill 拆出大型 `references/`：新增受限 `skill_read`，只读本次授权 Skill 目录，限制文件类型、大小与路径穿越。
- 只有真正需要项目文件的编码型插件 Agent，才显式开放通用 `read`。

### 2.3 与第三方 Pi 插件的关系

本方案不引入第三方运行时，而是先把现有自研 Agent 通道的「策略层」Skill 化。后续再通过统一 `AgentRuntime` 适配器试点 `pi-subagents`（子 Agent 生命周期）与 `pi-actors`（长任务 Run 内核），Jeff 仅用于本项目研发质量流程，不进入小说产品运行时。两者不在本次范围内。

## 3. 接口契约

### 3.1 `PluginSessionOptions.skill`（新增，单值契约）

```ts
/** 显式授权给本次插件 Session 的 Skill。 */
skill?: { name: string; path: string }
```

- 底座仅加载该路径，并在 `prompt()` 时使用 Pi 原生 `/skill:<name>` 语法展开正文。
- 不会扫描或暴露环境中的其他 Skills。
- Pi 原生一次只展开一个 Skill，因此保持单值契约；多 Skill 组合由编排层选择复合 Skill 或后续实现确定性编译器。

### 3.2 `AgentConfig.skillPaths`（新增）

```ts
/** 本次 Agent 调用显式授权的 Skill 文件路径。 */
skillPaths?: string[]
```

`plugin:*` 会话仍保持 `noSkills=true`，仅通过 `DefaultResourceLoader.additionalSkillPaths` 定向加载白名单 Skill。

### 3.3 `PromptManager.getDefaultTemplatePath(name, projectId?)`

返回内置模板文件路径，供同一资源作为显式 Pi Skill 加载。**项目文件或 SQLite 已覆盖该模板时返回 `undefined`**，继续走旧模板渲染路径，避免 Skill 试点绕过用户已保存的自定义配置。

### 3.4 `PromptManager.stripPromptFrontmatter`

Skill 化的默认模板仍可作为旧 Prompt 回退；渲染时不把 YAML 元数据发给模型。

## 4. Reviewer 试点（已完成）

### 4.1 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/plugins/novel-plugin/core/prompts/role-reviewer.md` | 增加 Pi Skill frontmatter（`name: novel-reviewer`、`description`、`disable-model-invocation: true`） |
| `src/core/agent/pi-session.ts` | `plugin:*` 仍 `noSkills: true`，新增 `additionalSkillPaths: agentConfigStorage.getStore()?.skillPaths ?? []` |
| `src/core/agent/subagent-tool.ts` | `AgentConfig` 新增 `skillPaths` |
| `src/core/plugin/plugin-types.ts` | `PluginSessionOptions` 新增 `skill` |
| `src/core/plugin/plugin-manager.ts` | `createSession` 透传 `skillPaths`；`prompt()` 前用 `/skill:<name>` 展开；新增 `buildPluginSessionPrompt` 纯函数；加载后校验 Skill 名称与路径一致，否则抛错 |
| `src/plugins/novel-plugin/core/novel-orchestrator.ts` | 标准 Reviewer 运行时解析 `reviewerSkillPath`，身份改用 `buildReviewerSkillIdentity`，传入 `skill: { name: 'novel-reviewer', path }`；日志 metadata 增加 `skillName/skillPath` |
| `src/plugins/novel-plugin/core/prompting/prompt-builder.ts` | 新增 `getReviewerSkillPath(projectId)` 与 `buildReviewerSkillIdentity(projectId)` |
| `src/plugins/novel-plugin/core/prompting/prompt-manager.ts` | 新增 `stripPromptFrontmatter` 与 `getDefaultTemplatePath` |
| `src/plugins/novel-plugin/__tests__/prompt-manager.test.ts` | 新增 frontmatter 剥离、路径解析、覆盖回退测试 |
| `src/__tests__/plugin-manager.test.ts` | 新增 `buildPluginSessionPrompt` 展开测试 |

### 4.2 生效范围（刻意收敛）

| 路径 | 是否使用 Skill |
| --- | --- |
| 标准工作流 Reviewer（`contextMode` 为 `full` / `editor`） | 是 |
| 标准工作流 Director（含检查点 rewrite/revise 与 pushback 重跑） | 是 |
| 标准工作流 Writer（`full`） | 是 |
| Reviser 定向修订（`editor`，标准路径） | 是 |
| Memory（JSON 提取 `novel-memory-generator` + 工具循环回退 `novel-memory`） | 是 |
| 群聊四工种（`novel-{role}-discussion`；reviser 无 discussion 模板 → 回退旧路径） | 是 |
| 群聊最终验收 Reviewer（标准 `novel-reviewer`） | 是 |
| 章节自由聊天四工种（标准 `novel-{role}`） | 是 |
| 盲审文字编辑（`identity_only`，`overrides.identityPrompt`） | 否 |

> 注：试点代码最初用 `!editorOnly` 排除了 Reviewer 的 editor 模式，与本节表意不符（ask_story 开启时 Reviewer 的标准路径恰是 editor）。Writer/Reviser 迁移批次已把判定改为按角色声明的 `modes`（reviewer/reviser 允许 `full`+`editor`，director/writer 仅 `full`），与本节一致。

### 4.3 身份组合

`buildReviewerSkillIdentity` 保留 `system-base`、写作铁律、项目文风档案，但不再嵌入 `role-reviewer` 正文，避免同一套审稿规则同时从旧模板和 Skill 注入两次。

### 4.4 回退条件

- 项目级 `role-reviewer.md` 覆盖 → 不使用 Skill，沿用旧模板。
- SQLite `novel_prompt_templates` 覆盖 → 不使用 Skill，沿用旧模板。
- Skill 文件缺失或 `novel-reviewer` 名称不匹配 → `createSession` 抛错（不再静默退化为普通文本）。

### 4.5 验证结果

- `pnpm --filter agent-server exec tsc --noEmit`：通过。
- 精确回归：4 个测试文件、62 项测试通过（含 SDK 级 `DefaultResourceLoader` 验证 `noSkills: true + additionalSkillPaths` 只加载授权 Skill）。
- 补充测试覆盖：frontmatter 剥离、默认路径解析、项目覆盖回退、`/skill:` 展开。
- `build:bytenode` 未能完整执行：构建脚本启动时清空 `dist/`，被环境批量删除保护拦截（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），与代码无关；普通 `tsc` 构建通过。运行打包前需先确认 `dist/` 清理策略。

## 5. Director 迁移（已完成）

### 5.1 原则

- 迁移标准工作流 Director，不迁移群聊 Director（独立 `role-director-discussion.md`）。
- Director 输出通过 `novel_submit_narrative_task` 结构化工具提交，文本体量小，适合作为第二个验证点。
- Writer 的长正文生成对 token、缓存、文风约束更敏感，应在 Reviewer/Director 稳定后迁移。

### 5.2 改动清单（已落地）

1. `role-director.md` 增加 frontmatter（`name: novel-director`、`description`、`disable-model-invocation: true`）。✅
2. `PromptBuilder` 新增 `getDirectorSkillPath(projectId)` 与 `buildDirectorSkillIdentity(projectId)`。Director 与 Reviewer 不同：旧身份只有 `system-base + role-director`（Director 被刻意排除在铁律/文风之外），因此薄身份壳**不注入** `system-base-rules` 与项目文风，只保留 system-base + Skill 指引。✅
3. `NovelOrchestrator.runAgentOnce` 的角色映射泛化为 `skillByAgent`（reviewer / director 统一处理路径解析、身份替换与 `skill` 透传）。✅
4. 日志 metadata 统一记录 `skillName/skillPath`（reviewer / director 共用同一字段，不再硬编码 `novel-reviewer`）。✅
5. Writer/Reviser 迁移批次已移除 `skipSkill` 临时开关：pushback 重跑 Director 与其他标准工作流路径统一走 `novel-director` Skill。✅

### 5.3 生效范围与验收标准

| 路径 | 是否使用 Skill |
| --- | --- |
| 标准工作流 Director（含检查点 rewrite/revise 重跑） | 是 |
| Writer 推回后的 Director 重跑（`pushback`） | 是（Writer/Reviser 批次已统一，`skipSkill` 已移除） |
| 群聊 Director（`role-director-discussion.md`） | 否 |
| chapter-chat @Director | 否（独立 runner，未接入） |

- 标准工作流 Director 的 `agent_log.metadata.skillName === 'novel-director'`（含 pushback 重跑）。
- 项目文件或 SQLite 覆盖 `role-director.md` 时回退旧模板（`getDefaultTemplatePath` 返回 undefined）。
- 结构化 `novel_submit_narrative_task` 调用率不下降（Skill 正文与旧模板同源，协议不变）。
- 对比试点前后输入 token、缓存命中率与规划质量（上线后按 `agent_log` 观测）。

### 5.4 验证结果

- `pnpm --filter agent-server exec tsc --noEmit`：通过。
- 新增 `novel-orchestrator-skill-path.test.ts`（6 项）：标准 Director 透传 `novel-director` Skill 且 identity 不重复嵌入角色正文；Reviewer 试点回归；`skipSkill` pushback 保持旧模板；`identity_only` 不走 Skill；SQLite 覆盖 `role-director` 时回退旧模板且使用用户自定义内容；Writer 不受影响。
- `prompt-manager.test.ts`：新增 Director frontmatter 剥离、路径解析、覆盖回退、双 Skill 定向加载断言。
- 回归集：`prompt-manager` / `plugin-manager` / `novel-orchestrator-reviser-context` / `golden-prompt.snapshot` / `novel-plugin-session` 全部通过（本次共跑 82 项测试，0 失败；golden-prompt 快照未变化，证明 frontmatter 剥离不改变旧模板渲染内容）。

## 6. Writer / Reviser 迁移（已完成）

### 6.1 原则

- Reviewer/Director 已验证通道稳定后，按 §6.1 原计划迁移 Writer 与 Reviser。
- Writer：角色方法（场景动力四确认、修辞红线、正文形态）移入 `novel-writer` Skill；薄身份壳保留 `system-base + 铁律 + 项目文风`（与旧 `buildAgentIdentity` 的 writer 分支一致）。
- Reviser：其标准路径就是 `contextMode='editor'`（原文+审稿意见已入输入），因此修订判定不再统一排除 editor，改为按角色声明 `modes`；`novel_apply_revision` 工具协议在 `novel-reviser` Skill 正文中，与 `extraTools` 注入的工具实例叠加。
- 同一批次修正试点遗留：Reviewer 在 editor 模式（ask_story 开启时的标准路径）同样走 Skill，与 §4.2 表意对齐。

### 6.2 改动清单（已落地）

1. `role-writer.md` / `role-reviser.md` 增加 frontmatter（`novel-writer` / `novel-reviser`）。✅
2. `PromptBuilder` 新增 `getWriterSkillPath` / `buildWriterSkillIdentity` / `getReviserSkillPath` / `buildReviserSkillIdentity`。✅
3. `NovelOrchestrator` 的 `skillByAgent` 增加 `modes` 声明：reviewer/reviser 允许 `full`+`editor`，director/writer 仅 `full`；`identity_only` 一律不走 Skill。✅
4. 移除 `RunAgentOverrides.skipSkill`：pushback 重跑 Director 与标准工作流统一走 `novel-director`。✅
5. Memory、群聊（`role-*-discussion.md`）、chapter-chat、盲审文字编辑保持旧模板路径。✅

### 6.3 验证结果

- `pnpm --filter agent-server exec tsc --noEmit`：通过。
- `novel-orchestrator-skill-path.test.ts` 扩至 8 项：Writer 透传 `novel-writer` 且薄壳保留铁律；Reviser（editor）透传 `novel-reviser`；Reviewer editor 模式走 Skill；`identity_only` 与 SQLite 覆盖 `role-writer` 回退；Memory 未迁移对照组。
- `novel-orchestrator-reviser-context.test.ts` 更新为断言 Reviser editor 模式的 Skill 薄身份壳。
- 回归集 9 个文件、109 项测试全部通过（含 golden-prompt 快照与群聊/chat runner，证明 frontmatter 与身份改动不影响旧路径）。
- 上线观测项：Writer 长正文生成的输入 token、缓存命中率与文风约束（`agent_log.metadata.skillName === 'novel-writer'`）。

## 7. Memory 迁移（已完成）

### 7.1 原则

- Memory 有两条路径：主路径是 `NovelMemoryGenerator` 的**纯 JSON 提取**（`responseFormat='json'`、不挂工具），回退路径是 ChapterFinalizer 未注入 generator 时的**工具循环**（`runAgentOnce('memory')`，18 个写工具）。两条路径本次一并迁移。
- 兼容性结论：`/skill:` 展开是发送前的提示词展开，与 `responseFormat='json'` 触发的 `tool_choice='none'` 注入互不干扰（后者在 provider payload 层）。
- 覆盖回退契约与其他角色一致：项目文件或 SQLite 覆盖 `role-memory*` 模板时回退旧模板身份。

### 7.2 改动清单（已落地）

1. `role-memory-generator.md` → `novel-memory-generator` Skill；`role-memory.md` → `novel-memory` Skill（frontmatter + `disable-model-invocation: true`）。✅
2. `PromptBuilder` 新增 `getMemorySkillPath` / `buildMemorySkillIdentity` / `getMemoryGeneratorSkillPath` / `buildMemoryGeneratorSkillIdentity`（薄壳只保留 system-base，与旧 memory 分支一致不注入铁律/文风）。✅
3. `NovelMemoryGenerator.analyze()`：system prompt 改用薄身份壳 + `skill` 透传（`responseFormat='json'` 保持不变）。✅
4. `NovelMemoryGenerator.runFullCalibration()`：userMessage 前段身份同样切换为薄壳 + `skill` 透传。✅
5. `NovelOrchestrator.skillByAgent` 增加 `memory`（modes `full`），覆盖工具循环回退路径。✅
6. 防御：`getMemoryGeneratorSkillPath` 用 `typeof === 'function'` 守卫，兼容既有测试的 mock promptBuilder。✅

### 7.3 验证结果

- `pnpm --filter agent-server exec tsc --noEmit`：通过。
- 新增 `novel-memory-generator-skill.test.ts`（3 项）：analyze() 透传 Skill 且薄壳不重复嵌入角色正文、`responseFormat='json'` 并存、frontmatter 剥离、SQLite 覆盖回退。
- `novel-orchestrator-skill-path.test.ts` 更新 Memory 回退路径用例（`novel-memory` 透传）。
- 回归集（含 chapter-finalizer / identity-contract / memory 应用安全 / golden-prompt 快照等）全部通过。
- 上线观测项：记忆提取 JSON 解析成功率不下降；`agent_log.metadata.skillName` 记录 `novel-memory` / `novel-memory-generator`。

## 8. 群聊与章节自由聊天迁移（已完成）

### 8.1 原则

- 群聊（`NovelDiscussionRunner`）与章节自由聊天（`ChapterChatRunner`）是独立 runner，成员身份由 `buildIdentityPrompt` 闭包构建，不经过 `runAgentOnce`，需要单独接线。
- 群聊四工种用 `novel-{role}-discussion` Skill（群聊职责：场景拆分/编织/台词审查）；reviser 无 `role-reviser-discussion.md` 模板，`getDefaultTemplatePath` 返回 undefined 自然回退旧身份路径。
- 群聊最终验收（final review）走标准 `novel-reviewer` Skill（与主身份 discussion Skill 区分，通过 `DiscussionMember.finalReviewSkill` 传递）；盲审文字编辑显式不挂 Skill（与标准工作流盲审一致）。
- 章节自由聊天四工种用标准 `novel-{role}` Skill（口径与 `NovelOrchestrator.skillByAgent` 一致），自由聊天模式提示（roleHint）保留在薄身份壳之后。
- 角色成员（`char-*`，role-character-actor）不是工种，不接入。

### 8.2 改动清单（已落地）

1. `role-director-discussion.md` / `role-writer-discussion.md` / `role-reviewer-discussion.md` 增加 frontmatter（`novel-{role}-discussion`）。✅
2. `PromptBuilder` 新增 `getDiscussionSkillPath(agentType, projectId)` 与 `buildDiscussionSkillIdentity(agentType, projectId)`（writer/reviser/reviewer 保留铁律+文风壳，director 仅 system-base）。✅
3. `DiscussionMember` 新增 `skill?` 与 `finalReviewSkill?`；`TeamDiscussionEngine` 的 `invokeMember` 在常规调用中透传 `member.skill`，`invocationOverrides` 派生调用不展开；finalReviewer 取 `finalReviewSkill ?? skill`，proseEditor 显式清空 `skill`。✅
4. `NovelDiscussionRunner` 成员构建接入 discussion Skill（含 reviewer 最终验收 Skill），适配器透传 `opts.skill`。✅
5. `ChapterChatRunner` 新增 `resolveRoleSkill`（标准四角色 Skill），成员身份切薄壳 + roleHint，`invokeMember` 透传 `member.skill`。✅

### 8.3 验证结果

- `pnpm --filter agent-server exec tsc --noEmit`：通过。
- `novel-discussion-runner.test.ts` 的工种身份用例更新为新契约（Skill 挂载 + 薄壳 + reviser 回退），12 项全通过。
- `prompt-manager.test.ts` 新增 discussion Skill 路径解析 / frontmatter 剥离 / 三 Skill 定向加载断言。
- 回归集：`team-discussion-engine`（27）/ `chapter-chat-runner`（5）/ `golden-prompt.snapshot`（15，快照无变化）/ `plugin-manager`（33）/ `novel-plugin-session`（17）等 9 个文件 127 项测试全部通过。

## 9. 剩余路线落地（已完成）

### 9.1 多 Skill 确定性组合编译器 ✅

- `PluginSessionOptions.extraSkills?: { name, path }[]`：主 `skill` 保持 Pi 原生 `/skill:` 展开；有附加 Skill 时由编排层确定性编译——`skill-compose.ts` 剥离各 SKILL.md frontmatter，按 `[主 Skill → 附加 Skill]` 顺序包成 `<skill name="...">` 块，前置到任务消息。
- `plugin-manager` 校验所有授权 Skill 的 name/path 一致，`skillPaths` 定向加载全部路径，不扫描环境其他 Skills。
- 测试：`skill-compose-and-read.test.ts`（frontmatter 剥离、顺序确定性、单/多/无 Skill 三种 prompt 形态）。

### 9.2 受限 `skill_read` 工具 ✅

- `PluginSessionOptions.skillRead?: { roots; maxBytes?; extensions? }`：仅在会话显式授权 Skill 时按声明注入。
- `skill-read-tool.ts`：路径必须落在授权根目录内（resolve 前缀校验拒绝穿越/越界）、扩展名白名单（默认 .md/.txt/.json）、单文件大小上限（默认 64KB）、只读普通文件；per-session extraTool，不进入全局 pluginSessionTools。
- 测试：目录内读取、穿越拒绝、目录外拒绝、扩展名白名单、大小上限、缺失文件。

### 9.3 AgentRuntime 抽象 ✅

- `agent-runtime.ts`：`AgentRuntime`（按 PluginSessionOptions 创建会话句柄）+ `AgentRuntimeRegistry`；`PluginSessionOptions.runtime` 选择运行时，默认 `'pi-session'` 走内联实现，未注册的 kind 在 `createSession` 显式抛错。
- `PluginManagerOptions.runtimeRegistry` 注入第三方适配器；`PiSessionAgentRuntime` 提供委托工厂的参考实现。
- 测试：注册表 CRUD/重复注册、工厂委托、PluginManager 路由、未知 kind 抛错、默认路径错误语义。

### 9.3.1 第三方 Pi 包调研结论（2026-08-14 实测，含 SDK 升级）

| 包 | 版本 | 类型 | peer 约束 | 结论 |
| --- | --- | --- | --- | --- |
| [`pi-subagents`](https://pi.dev/packages/pi-subagents?name=pi-subagents) | 0.49.0 | extension+skill+prompt，暴露 `/delegation`、`/background-work`、`/external-runs` 等子路径 API | `pi-ai >= 0.80.0` | **已接入（可观测桥）**：SDK 升级 0.84.1 解锁依赖；`pi-subagents-bridge.ts` 注册 background-work / external-runs provider |
| [`@llblab/pi-actors`](https://pi.dev/packages/@llblab/pi-actors) | 0.47.0 | extension+skill；入口是扩展工厂（非独立服务端库） | 与 0.79.4 及 0.84.1 兼容 | **Skill 层已接入**（见 9.3.2） |
| [`@johanthoren/jeff`](https://pi.dev/packages/@johanthoren/jeff) | 6.1.0 | extension+skill | 无 | **研发质量流程**接入（`docs/dev/jeff-quality-workflow.md`），不进入产品运行时 |

### 9.3.1a Pi SDK 0.79.4 → 0.84.1 升级（已完成）

- `@earendil-works/pi-*` 四包同升至 0.84.1（`package.json` 已更新），全量 169 文件 1905 项测试通过。
- 破坏性变更迁移：
  - `AuthStorage` 移除 → `ModelRuntime`（模型目录 + 凭证统一运行时）；`ModelRegistry` 变为同步兼容门面（`new ModelRegistry(modelRuntime)`），`find/getAll` 等既有调用面保留；
  - `CreateAgentSessionOptions` 的 `authStorage`/`modelRegistry` → `modelRuntime`；
  - API Key 注入从 `authStorage.setRuntimeApiKey`（同步）→ `modelRuntime.setRuntimeApiKey`（异步），`pi-sdk.plugin` / `provider.route` 注册点已改；
  - 移除死代码 `CredentialBridge`（类 + 测试）。
- `pi-session.ts` 的 `setFallbackResolver` 桥接删除：Key 在注册点注入 ModelRuntime，会话创建不再需要 fallback。

### 9.3.3 pi-subagents 运行时接入（可观测桥，已完成）

- `runtime-run-registry.ts`：进程内运行观测记录（Subagent 派遣起止/终态），`subagent-plugin` dispatch 路径已接线。
- `pi-subagents-bridge.ts`：把两类真实工作注册进 pi-subagents 服务端注册表——
  - `novel-chapter-tasks` → `registerBackgroundWorkProvider`（章节任务：workflow/discussion/ai-arrange/reverse-arrange/re-revise，来自 `activeNovelChapterTasks`）；
  - `novel-agent-runtime` → `registerExternalRunProvider`（Subagent 运行，含 running/completed/failed 状态转移）。
  - app.ts 启动时建桥、onClose dispose；纯供给侧接入，不改变调度/并发/领域语义。
- 测试：`pi-subagents-bridge.test.ts` 4 项（快照读取 provider 与状态转移、dispose 幂等、依赖缺失跳过）。
- 边界：`/delegation` 事件协议需要 pi-subagents 扩展宿主作为消费端；我们的 AgentManager 自持子 Agent 生命周期（认知隔离、并发限制），接入委托协议留待扩展宿主引入后评估。

### 9.3.2 第三方包 Skills 白名单接入 ✅

- `external-skill-paths.ts`：`resolveExternalSkillPaths(packageName)` 解析已安装 Pi 包的 `skills/<name>/SKILL.md`（首个命中目录优先，避免 dist 镜像重复；未安装返回 []）。
- 试点：`@llblab/pi-actors` 六技能（actors/artifacts/media/project-work/recipe-memory/swarm）经 `noSkills=true + additionalSkillPaths` 定向加载；`actors` Skill 自带 `references/*.md`，以该 Skill 目录为授权根，`skill_read` 可读 references、拒绝越界 —— 完整复现「第三方 Skill + 受限参考读取」组合（`external-skill-paths.test.ts` 4 项）。
- 边界：包内 Skill 描述其自身扩展工具（spawn/registry 等），服务端会话未接入对应扩展时不可盲目加载；是否授权由编排层判断。产品运行时（小说五角色/Memory）不加载第三方 Skills。

### 9.3.4 能力级接入（已完成）：pi-actors 长任务 Run 内核

- **结论：可行，不需要 CLI。** `@llblab/pi-actors` 的 Run 内核（`dist/lib/async-runs.js`）是宿主无关的：只依赖 Node 内置模块与包内模块，`startRun / getRunStatus / listRuns / cancelRun / killRun` 均为独立导出（包无 exports 映射，深导入合法）。
- `pi-actors-kernel.ts`：`PiActorsKernel` 封装 spawn（无 shell 的 argv 拆分，命令/Recipe）→ `status()` / `stdoutTail()`（state_dir/stdout.log 留痕）/ `cancel()` / `kill()` / `waitForTerminal()` 轮询终态（running/done/failed/exited/cancelled/killed）。
- 观测接线：spawn 写入 `RuntimeRunRegistry`（source='pi-actors-run'），自动进入 pi-subagents external-runs 可观测桥（§9.3.3）。
- app.ts decorate `app.piActorsKernel`；测试 `pi-actors-kernel.test.ts` 3 项（真实 spawn node 进程：短命令终态+输出留痕+观测接线、长驻进程 cancel、无观测注册表独立使用）。
- 定位边界（GPT 评审第 3 条）：承担「后台运行 / 运行状态统计 / steer-cancel-inspect」基础设施；小说工作流阶段、认知隔离、检查点、账本仍由编排器自持；Run 是本地进程执行，不承载 LLM 会话。

### 9.3.5 能力级接入（已完成）：pi-subagents 无头扩展宿主

- **结论：可行，不需要 CLI。** 其扩展工厂只依赖 ExtensionAPI 子集，且全链路带 `hasUI=false` 无头分支；委托桥接（`prompt-template-bridge`）注册在 `pi.events` 上，无上下文绑定时返回确定性响应。
- `pi-subagents-host.ts`：`PiSubagentsHost` 用最小宿主桩承载扩展工厂——
  - events 复用 `@repo/shared/events` EventBus；`registerTool/registerMessageRenderer/registerCommand/registerShortcut` 收集器；`on(event, handler)` 生命周期注册表（`bindSession` 触发 `session_start`、`dispose` 触发 `session_shutdown`）；其余 API 由 Proxy 兜底为安全 no-op + node 兼容垫片（watchdog/文件扫描用真实 fs/timers）。
  - `delegate(request)` 事件协议闭环：emit REQUEST → 收集 STARTED/UPDATE → 终态 RESPONSE（超时上限防悬挂）；`cancel(requestId)` 发 CANCEL。
  - **无 LLM 的确定性协议路径**：未绑定会话时，有效结构化请求 → `unavailable_context`；非法请求 → `invalid_request`——已由测试钉死。
- 编译期隔离：`tsconfig.json` paths 映射把 `'pi-subagents'` 根指向 `src/types/pi-subagents-shim.d.ts`（扩展源码树不进入本项目类型程序）；运行时 Node/vitest 仍解析真实包；`pi-subagents/delegation` 子路径保持真实类型。
- app.ts 启动时建宿主（decorate `app.piSubagentsHost`），onClose dispose。
- 测试 `pi-subagents-host.test.ts` 5 项（工具注册探针、invalid_request、unavailable_context、超时防悬挂、bind/dispose 幂等）。
- 边界与生产接线：绑定会话上下文后，扩展会经 `PI_SUBAGENT_PI_BINARY`（可覆盖）派生 pi CLI 子进程真正执行子 Agent；扩展假设单一交互会话（CLI 出身），多线程并发绑定以最近绑定为准；小说工作流不依赖本宿主（AgentManager 自持子 Agent 生命周期、认知隔离、并发限制、日志）。

### 9.3.6 后续接入路线（按需触发）

1. **生产级子 Agent 执行**：为 chat 线程在会话创建时绑定宿主上下文（`sessionProvider` 返回真实 sessionFile/entries），并评估 `PI_SUBAGENT_PI_BINARY` 指向本服务打包的 pi CLI 入口；与 AgentManager 的权限/并发语义对齐后再开放。
2. **pi-actors Recipe 注册表**：`registry.js` 同样宿主无关，可按需接入持久化 Recipe（`~/.pi/agent/recipes/*.json`）。

### 9.4 会话身份索引 P0 ✅

- 迁移 `015_create_pi_session_identity`（thread_id → session_path）。
- `SqliteSessionIdentityRegistry`：会话创建成功后异步写入（fire-and-forget，失败不影响会话；plugin:* 线程不写）。
- `PiSessionStore`：`getSessionFilePath` 内存 miss 回退注册表（修复 LRU 淘汰/重启后历史消息分页返回空）；`getOrCreate` 对 chat 线程在注册表命中时把 `resumePath` 传给工厂。
- `pi-session.ts`：新增 `deps.resumePath`，`selectSessionManager` 纯函数选择 `SessionManager.open(path, sessionDir, cwd)` 恢复既有 JSONL；plugin 线程仍每次新建。
- `app.ts` 接线注册表并透传 `resumePath`。
- 测试：注册表 CRUD、内存 miss 回退、chat 恢复上下文透传、plugin 不恢复/不持久化、`selectSessionManager` 三分支。

### 9.5 增强：Skill 内容指纹审计 ✅

- `fingerprintSkillContent`（SHA-256 前 16 位）：`createSession` 加载校验后对每个授权 Skill 记指纹日志，供规则漂移检测与审计留痕。
- 测试：指纹稳定性与敏感性。

### 9.6 能力拆分落地：character-actor / entity-extractor / matrix-arranger ✅

GPT 评审建议"按能力而非按前端 Tab 拆分"的最后一个缺口，本批次补齐：

1. **`novel-character-actor`**（群聊角色演员）：
   - `role-character-actor.md` 加 frontmatter；`PromptBuilder` 新增 `getCharacterActorSkillPath` / `buildCharacterActorSkillIdentity`（薄壳只含 system-base）。
   - `buildCharacterIdentityPrompt` 新增 `actorIdentityBuilder` 参数：单角色调用用薄壳（演出方法由 Skill 展开），合并演出保留完整模板。
   - `DiscussionMember` 新增 `buildMergedActorIdentityPrompt`：合并调用（多角色同一次 LLM 调用，无 Skill 展开）必须内联完整角色方法，避免丢失剧本格式/演出规则；引擎按 `buildMergedActorIdentityPrompt ?? buildIdentityPrompt` 取合并身份。
   - 建档角色与临时角色同口径；chapter-chat 自由聊天角色不挂 Skill（原路径不使用角色模板）。
2. **`novel-entity-extractor`**（正文反推）：从 `planEntitiesFromOutline` 提示词提炼方法文档（正文为唯一事实来源、复用优先、标注协议、伏笔/冲突/物品准入、输出约束），接线 `source='content'` 会话。
3. **`novel-matrix-arranger`**（章纲编排）：同源提炼（三层大纲、复用优先、冲突编排准入、角色功能位七选一不重复），接线 `source='outline'` 会话。
4. 回退契约与其他角色一致：项目/SQLite 覆盖新模板时渲染覆盖内容（`promptManager.render` 三级覆盖）；模板不可用时退回旧的通用生成器身份。动态 JSON 契约仍留在任务消息（Skill 只承载方法）。
5. 测试：`novel-entity-generator-skill.test.ts` 3 项（outline/content 透传 + 覆盖回退）；discussion-runner 角色用例更新为新契约；prompt-manager 九 Skill 定向加载。

## 10. 关键决策记录

| 决策点 | 选择 | 原因 |
| --- | --- | --- |
| `noSkills` 是否放开 | 不放开，新增定向 `additionalSkillPaths` | 保持 token 优化，不暴露全部环境 Skills |
| 是否开放通用 `read` | 不开放；多 Skill 时用受限 `skill_read`（授权目录/扩展名/大小三重校验） | 插件 Agent 无需工作区文件能力；Skill 正文由 `/skill:` 展开 |
| 单一 Skill 还是数组 | 单值主 Skill + `extraSkills`；多 Skill 由编排层确定性编译 `<skill>` 块 | Pi 原生一次只展开一个，避免假支持 |
| Skill 与旧 Prompt 是否并存 | 同一文件双态（frontmatter + 正文） | 单一事实来源，避免两套审稿规则漂移 |
| 项目/SQLite 覆盖时 | 回退旧模板 | 不绕过用户已有自定义配置 |
| Skill 加载失败时 | 显式抛错 | 避免静默退化为普通文本导致行为漂移 |
| 运行时接入方式 | `AgentRuntime` 注册表 + `PluginSessionOptions.runtime`，默认 pi-session；第三方运行时未安装时不引入 | 抽象层先行，适配器随依赖落地 |
| 会话恢复策略 | threadId → sessionPath 持久化 + `SessionManager.open` 恢复；plugin:* 线程不恢复 | 修复重启/LRU 淘汰后的历史丢失与分页空结果 |
| Skill 审计 | 加载校验 + 内容 SHA-256 指纹日志 | 规则漂移检测与审计留痕 |
| 群聊角色合并演出 | 单角色走 Skill；合并演出内联完整模板（`buildMergedActorIdentityPrompt`） | 合并调用不展开 Skill，不能因薄壳丢失演出格式规则 |

## 附录 A：外部评审记录（GPT 分析 + 实测修正）

> 2026-08-14 存档：GPT 对方案的评审分析，含方向判定与三处实施修正。

### A.1 方向判定（全部经受实现检验）

1. **能力 Skill 化方向正确**：角色方法独立迭代、按题材替换、工作流与群聊复用同一 Skill、Prompt 与运行时解耦、接入 Pi 生态、应用无需为每套创作方法重发版。按能力拆分而非按前端 Tab 拆分——已落地（九角色 Skill + 三 discussion Skill）。
2. **放开 plugin:* Skills 方向正确，但必须白名单式定向**：不恢复 1.3–1.7 万字符固定开销（实现见 §9.3 与决策记录第一行）。
3. **使用现成插件替换运行时基础设施方向正确**：可外包的是子 Agent 生命周期/后台运行/并行调度/steer-cancel-inspect/运行状态统计/通用消息通道；不可外包的是小说工作流阶段、角色认知隔离、章节检查点、矩阵领域事务、故事账本、正文质量门、最终落库。适配器逐步接管而非一次性替换。
4. **前端保留对话形式正确**：对话是四种能力的统一产品入口；三类数据（展示历史 / 运行快照 / 领域事实）必须分离持久化，不能只存对话文本。
5. **四层边界正确**：对话前端 → 应用编排器 → Skill 组合层 → Agent 运行时/第三方插件 → LLM 与工具；旁路持久化（对话历史 + 运行快照 + 领域账本）。**Skill 不是工作流引擎**——Skill 回答"怎么做"，编排器决定"轮到谁、失败怎么办"，插件运行时负责"启动/并行/控制/观察"，应用负责"展示/持久化/修改业务数据"。
6. **执行顺序正确**：定向放开 → Reviewer 试点 → Director/Writer/Reviser → 抽象 AgentRuntime → 试点 pi-subagents/pi-actors（实际执行顺序一致）。

### A.2 三处实施修正（GPT 处方与代码现实不符处）

1. **过滤式放开 → 定向加载**：GPT 的 `noSkills: false + skillsOverride` 是"扫描后过滤"；实现采用 `noSkills: true + additionalSkillPaths`（连扫描都不发生），效果等价但机制上杜绝漏过滤导致的固定开销回归。
2. **entity-extractor / matrix-arranger 的拆分形态**：GPT 从产品概念推断独立 Agent；代码现实是二者同为 `novel-entity-generator` 的两条 JSON 流水线（`source='content'` / `source='outline'`），原身份兜底是"小说创作助手"。本批次按现实形态落地：从生成器提示词提炼 `role-entity-extractor.md` / `role-matrix-arranger.md`，接线到 `planEntitiesFromOutline` 两条路径，动态 JSON 契约仍留在任务消息。
3. **第三方运行时生态成熟度**：GPT 假设成熟插件可替换；实测 pi-subagents / pi-actors 均为 Pi CLI 扩展（extension factory 入口，非独立服务端库），pi-subagents 全版本要求 `pi-ai >= 0.80`（SDK 已升 0.84.1 解锁）。服务端可承接的是可观测桥（§9.3.3）与 Skill 层（§9.3.2），`/delegation` 协议待扩展宿主（§9.3.4）。

### A.3 能力拆分清单（GPT 建议 + 实际落地）

| GPT 建议 | 落地形态 |
| --- | --- |
| novel-director / writer / reviewer / reviser | ✅ 五角色 Skill（§5/§6/§7） |
| novel-character-actor | ✅ 本批次（单角色 Skill + 合并演出内联模板） |
| novel-entity-extractor | ✅ 本批次（反推路径，`planEntitiesFromOutline source='content'`） |
| novel-matrix-arranger | ✅ 本批次（编排路径，`planEntitiesFromOutline source='outline'`） |
| 工作流/群聊/反推/矩阵编排负责组合 | ✅ 编排器不感知 Skill 细节，Skill 由 `skillByAgent` / 成员 / 生成器按路径解析 |
