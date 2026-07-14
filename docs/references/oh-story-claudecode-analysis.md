# oh-story-claudecode 对 pi-agent 的参考分析

> 分析日期：2026-07-11  
> 分析对象：[worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)  
> 目标项目：pi-agent（AI Agent 桌面应用，Electron + React + Fastify + Pi SDK）

---

## 一、两个项目的本质差异

| 维度 | oh-story-claudecode | pi-agent |
|------|---------------------|----------|
| 定位 | 网文写作专用 skill 包 | 通用 AI Agent 桌面应用平台 |
| 运行环境 | Claude Code / Codex / OpenCode / WorkBuddy 等 CLI | 独立 Electron 桌面端 + agent-server |
| 核心能力 | 扫榜、拆文、写作、去 AI 味、封面 | 多 Agent 对话、工具调用、记忆、插件、Novel Plugin |
| 组织方式 | 13 个独立 skill + 7 个 agent + hooks | 插件系统 + 多 Agent 协作 + Service Locator |
| 提示词策略 | SKILL.md 入口 + references/ 按需加载 + hooks 守卫 | 三层提示词缓存 + 模板文件 + 动态注入 |

**结论**：它不是可以直接搬进来的代码库，而是**一套“高度专业化的 Agent 工作流编排方法论”**。pi-agent 已经具备了小说创作插件（Novel Plugin），但 oh-story-claudecode 在“专业化工作流、提示词治理、确定性守卫、知识库管理”方面更加成熟，值得被吸收到 pi-agent 的 skill/agent 生态中。

---

## 二、可直接借鉴的功能

### 1. 把 Skill 提升为与 Plugin 并列的一级概念

**现状**：pi-agent 有 Plugin 系统（Tool / Route / Event / UI Panel），但 Skill 更像是“插件内的一组提示词”，没有独立生命周期。  
**参考**：oh-story-claudecode 的每个 skill 都有独立入口（`SKILL.md`）、触发词、references/、hooks、版本。

**建议加入**：
- `Skill` = 一个可独立安装、启用、禁用的“能力包”。
- 一个 Plugin 可以包含多个 Skill，也可以一个 Skill 不依赖 Plugin 单独运行。
- Skill 元数据：`skillId`、`name`、`triggers`、`description`、`category`、`version`、`references/`、`hooks/`。
- 安装方式：GitHub 仓库 / 本地目录 / 未来 Marketplace。

**对 pi-agent 的落点**：
- 在 `dataDir/skills/` 下建立标准结构。
- 在 Plugin SDK 中增加 `registerSkill(skill)`。
- 前端设置页增加“Skill 市场 / 已安装 Skill”面板。

---

### 2. 自然语言路由（Agent / Skill 分发器）

**参考**：`story` skill 作为“工具箱路由”，模糊意图自动分发到 `story-long-write`、`story-short-write`、`story-deslop` 等。

**建议加入**：
- 在 chat 工作台中，增加 `/` 或 `@` 命令面板，输入 `/写长篇`、`/去 AI 味`、`/扫榜` 即可触发对应 skill。
- 更自然的：用户说“帮我写个短篇悬疑”，系统自动识别意图并加载 `novel-short-write` skill 上下文。
- 实现：一个轻量 `IntentRouter`，用 LLM 或规则匹配（关键词 + 历史行为）选择 skill/agent。

**对 pi-agent 的落点**：
- 在 `sessionStore` 中增加 `activeSkill` 状态。
- 在 `InputArea` 支持 `/` 快速选择 skill。
- 后端 `IntentRouter` 作为可选中间件，在 `beforeToolCall` 之前触发。

---

### 3. 项目模板初始化（story-setup 模式）

**参考**：`story-setup` 自动部署项目文件结构、agents、hooks、AGENTS.md、`.active-book`。

**建议加入**：
- 当用户选择某个 skill（如小说创作、代码审查、竞品分析）时，自动为其生成项目骨架。
- 例如启动小说创作 skill 时：
  - 创建 `agents/{agentId}/skills/novel/` 目录。
  - 写入 `identity.md`、`personality.md`、`project-instructions.md`。
  - 注册该 skill 所需的 subagent。
  - 写入 hooks（如“写正文前检查大纲”）。

**对 pi-agent 的落点**：
- 在 `PluginContext` 中增加 `initProjectTemplate(templateId, targetDir)`。
- 前端增加“新建项目 / 选择模板”入口。

---

### 4. 自动化 Hooks 系统

**参考**：oh-story-claudecode 的 hooks 包括：
- `session-start.sh`：显示进度快照。
- `session-end.sh`：记录会话日志。
- `detect-story-gaps.sh`：检测设定缺口、大纲缺失、伏笔断线。
- `pre-compact.sh` / `post-compact.sh`：上下文压缩前后保存/恢复状态。
- `validate-story-commit.sh`：git commit 时校验设定必填字段。
- `guard-outline-before-prose.sh`：写正文前检查大纲。

**建议加入到 pi-agent**：
- 把 hooks 从“硬编码在 Pi SDK 的 `beforeToolCall`/`afterToolCall`”扩展为**可配置脚本/函数**。
- 支持三类 hook：
  - `session_start` / `session_end`
  - `before_tool_call` / `after_tool_call`
  - `before_compact` / `after_compact`
  - `before_write` / `after_write`（文件写入守卫）
  - `before_commit`（git 提交校验）
- hook 可以是：
  - Shell 脚本（通用但沙箱内）
  - JS/TS 函数（pi-agent 原生，更推荐）
  - 简单规则 YAML（如“写 `正文/` 下文件前必须存在 `大纲.md`”）

**对 pi-agent 的落点**：
- 在 `PluginContext` 中增加 `registerHook(hookName, handler)`。
- 在 `pi-session.ts` 的 `createAgentSession` 钩子中调用这些外部 hook。
- 前端可以展示 hook 触发日志（DevLog 面板）。

---

### 5. 知识库按需加载（references/）

**参考**：oh-story-claudecode 把 100+ 方法论文件放在 `references/`，按子主题拆分（`大纲排布`、`钩子技法`、`反转工具箱`、`去AI味`），避免一次性塞满上下文。

**建议加入**：
- 在 pi-agent 的 `identity.md`/`personality.md` 之外，增加 `references/` 目录。
- 每个 reference 文件是可选的，skill 运行时根据当前任务动态选择加载哪些 reference。
- 例如小说创作时：
  - 题材定位 → 加载 `references/题材框架.md`
  - 写正文 → 加载 `references/风格模块.md`、`references/钩子技法.md`
  - 去 AI 味 → 加载 `references/去AI味.md`

**对 pi-agent 的落点**：
- 扩展 `InstructionLoader` 支持 `references/**/*.md`。
- 在 `PluginSessionOptions` 中增加 `references: string[]` 字段，按名称加载。
- 可以结合 `memory_search` 做 reference 推荐（“当前任务需要哪些知识库”）。

---

### 6. 多 Agent 角色扩展

**参考**：7 个专业 agent（story-architect、character-designer、narrative-writer、consistency-checker、story-researcher、story-explorer、chapter-extractor）。

**pi-agent 现状**：Novel Plugin 已有 4 个 Agent（Director、Writer、Reviewer、Memory）。

**建议补充**：
- 从 oh-story-claudecode 中抽象出更通用的角色模板：
  - `architect`（架构师）：负责规划、拆解、大纲。
  - `researcher`（研究员）：负责搜索、拆文、资料整理。
  - `writer`（执行者）：负责输出正文/代码/设计稿。
  - `reviewer`（审查者）：负责一致性、质量、评分。
  - `memory`（记忆者）：负责提取、更新、反思记忆。
  - `editor`（润色者）：负责改写、去 AI 味、压缩。
- 每个角色模板包含默认 temperature、工具白名单、系统提示词片段。

**对 pi-agent 的落点**：
- 在 `NovelAgentConfigStore` 中把角色模板通用化，不仅限于 novel。
- 前端 Agent 创建向导：选择“角色模板”即可快速生成 Agent。

---

### 7. 检查点与决策流程（Checkpoint）

**参考**：长篇创作中 Director → Writer 前有一个 `narrative_task` 检查点，Writer → Reviewer 后有一个 `review` 检查点，支持 approve/reject/revise/rewrite。

**pi-agent 现状**：已有 `ConfirmationManager` 用于工具确认，但检查点更多用于“任务阶段决策”。

**建议加入**：
- 把 `ConfirmationManager` 扩展为支持“阶段检查点”：
  - 类型：`tool_checkpoint`（工具确认）和 `stage_checkpoint`（阶段确认）。
  - 决策：approve / reject / revise / rewrite。
  - 可配置：哪些 skill 的哪些阶段需要检查点。
- 例如小说创作 skill：
  - `narrative_task` 检查点：用户确认 Director 的叙事任务后 Writer 才执行。
  - `review` 检查点：用户选择修订/重写/通过。

**对 pi-agent 的落点**：
- 后端 `ConfirmationManager.requestDecision()` 已支持 `decision` 字段，扩展 type 即可。
- 前端 `ConfirmationDialog` 根据 type 显示不同文案和按钮。

---

### 8. 去 AI 味 / 风格润色工具

**参考**：`story-deslop` skill 提供“三遍去 AI 法”、禁用词表、确定性句式检测。

**建议加入**：
- 作为一个通用 skill 或工具：`deslop` / `polish`。
- 不仅用于小说，也可用于代码注释、文档、邮件、报告。
- 功能：
  - 检测 AI 常见句式（“首先，我们需要...”、“值得注意的是...”）。
  - 按用户指定的风格（专业、口语、简洁、文学化）改写。
  - 输出前后对比 + 修改说明。

**对 pi-agent 的落点**：
- 在 Plugin SDK 中提供 `registerPolishStyle(styleId, prompt)`。
- 前端输入区增加“润色”按钮（类似 Copilot 的 rewrite）。

---

### 9. 市场/封面/视觉生成

**参考**：`story-cover` 根据书名/题材生成 GPT-Image-2 提示词并输出封面图。

**建议加入**：
- 通用化为“视觉生成 skill”：
  - 根据任务描述生成图片 prompt。
  - 调用 ImageGen 工具（如果可用）生成图片。
  - 输出到项目目录 `assets/`。
- 可扩展为“生成项目 Logo”、“生成海报”、“生成图表”。

**对 pi-agent 的落点**：
- 在 Extensions 中增加 `image_generate` 工具。
- 插件可以提供“生成封面”面板。

---

### 10. 数据抓取与外部信息复用

**参考**：`browser-cdp` 通过 CDP 协议复用浏览器登录态抓取榜单数据。

**建议加入**：
- pi-agent 已有 `web_search` / `web_fetch`，但可以增强：
  - `browser-cdp` 工具：让用户授权复用本地 Chrome 登录态抓取需要登录的网站。
  - 用于：竞品监控、知乎/小红书/公众号资料收集、内部系统数据读取。
- 注意：需要在 Gate 中标记为 dangerous，并明确告知用户。

**对 pi-agent 的落点**：
- Extension 新增 `browser_cdp` 工具。
- 设置页配置 Chrome 调试端口。

---

## 三、提示词工程可以吸收的部分

### 1. 入口 + 知识库 + 守卫的分层提示词架构

oh-story-claudecode 的提示词结构：
```
SKILL.md（入口：定义角色、输入输出、流程）
  ├── references/（按需加载的方法论）
  └── hooks/（运行时守卫）
```

pi-agent 当前是：
```
System Prompt（三层：codegen + templates + dynamic）
  ├── identity.md
  ├── personality.md
  ├── user.md
  ├── memory.md
  └── pinned.md
```

**建议融合**：
- 在 `templates/` 下增加 `skill/{skillId}/` 目录，包含：
  - `SKILL.md`：入口提示词。
  - `references/*.md`：按子主题拆分。
  - `guards.yaml`：确定性规则（如“写正文前必须有大纲”）。
- 提示词拼装顺序扩展为：
  ```
  1. 代码生成规则（STATIC）
  2. 平台/环境声明（STATIC）
  3. Agent 身份模板（SEMI）
  4. Skill 入口提示词（SEMI，按 activeSkill 加载）
  5. 按需加载的 references（DYNAMIC，按任务选择）
  6. 用户档案 / 记忆 / 置顶（DYNAMIC）
  7. 当前时间 / cwd（DYNAMIC）
  ```
- 这样可以在切换 skill 时只影响 SEMI 层，不破坏 STATIC 缓存前缀。

---

### 2. 提示词版本锚定

**参考**：oh-story-claudecode 使用 `marketplace.json`、`VERSION`、`setup_skill_version`、`agents_version` 形成完整版本链，部署后可验证是否生效。

**建议加入**：
- 为每个 skill / agent 模板增加 `version` 字段。
- 在 agent 启动时计算 `systemHash` + `toolsHash` + `skillVersionHash`。
- 如果 skill 版本与本地不匹配，提示用户更新或重新初始化。
- 在“缓存诊断”面板中显示每个 skill/agent 的版本信息。

**对 pi-agent 的落点**：
- 扩展 `CacheDiagnostics`：增加 `skillVersions` 字段。
- 在 `Novel Plugin` 的 `cache-diagnostics` 路由中返回 skill 版本。

---

### 3. 输出格式约束与模板

**参考**：oh-story-claudecode 的每个 skill 都有明确的输出目录和文件格式（如 `正文/第N章_章名.md`、`拆文报告.md`）。

**建议加入**：
- 为每个 skill 定义输出规范（文件路径、命名规则、Markdown 结构）。
- 在 prompt 中明确告知 Agent 输出到哪个文件、使用什么 frontmatter。
- 配合 `SessionFileRegistry` 管理 skill 产出的文件生命周期。

**对 pi-agent 的落点**：
- 在 `PluginContext` 中增加 `registerOutputTemplate(skillId, template)`。
- 工具执行时检查输出是否符合模板（轻量 guard）。

---

### 4. 更具体的“Agent 纪律”提示词

**参考**：oh-story-claudecode 的 Writer Agent 有 4 条非常具体的写作风格规则（禁破折号、开头直接入场景、结尾止于画面、语言干净）。

**建议加入**：
- 为每个 skill 提供“纪律卡片”：3-7 条不可违反的硬规则。
- 这些规则放在 `references/discipline.md` 中，作为 STATIC 或 SEMI 层注入。
- 也可以由用户自定义（如“代码必须用 TypeScript 严格模式”、“回答必须用中文”）。

**对 pi-agent 的落点**：
- 在 Agent 配置中增加 `discipline: string[]` 字段。
- 在 prompt 拼装时合并到 codegen 规则区。

---

### 5. 去 AI 味 / 风格化提示词资产

**参考**：`story-deslop` 的 `references/` 包含禁用词表、预防规则、改写范例库、三遍去 AI 法。

**建议加入**：
- 把这类资产通用化为“风格化资产”：
  - `polish-anti-ai.md`
  - `polish-professional.md`
  - `polish-casual.md`
  - `polish-concise.md`
- 用户可以在设置中选择默认风格，也可以在输入时用 `/polish` 调用。

---

## 四、流程可以优化的地方

### 1. 多 Agent 协作流程：从“自由协作”到“流水线 + 检查点”

**现状**：pi-agent 的 Novel Plugin 已经有 4 个 Agent 和 2 个检查点，但用户需要手动触发或 Agent 自己决定。

**参考**：oh-story-claudecode 的流水线是：
```
扫榜 → 拆文 → 建立对标/拆文库 → 设定/大纲/细纲 → 正文 → 去AI味 → 审查 → 封面
```

**建议优化**：
- 为每个 skill 定义标准阶段（phase）和检查点（checkpoint）。
- 阶段推进可以是：
  - 自动（Agent 完成当前阶段后自动进入下一阶段）。
  - 手动（每个阶段结束需要用户确认）。
  - 混合（默认自动，危险阶段强制检查点）。
- 在消息流中显示当前阶段进度条（如“阶段 3/7：正文创作”）。

**对 pi-agent 的落点**：
- 在 Novel Orchestrator 中增加 `phase` 和 `checkpoint` 状态机。
- 前端消息流顶部显示 `PhaseProgress` 组件。

---

### 2. 项目初始化流程：从空白到可创作

**参考**：`story-setup` 一键生成项目结构。

**建议优化**：
- 当用户新建 Agent 或切换到某个 skill 时，检测是否缺少项目结构。
- 如果缺少，提示“是否为 {skillName} 初始化项目结构？”
- 初始化内容包括：
  - 目录结构（`大纲/`、`正文/`、`设定/`、`追踪/` 等）。
  - 默认模板文件（`identity.md`、`personality.md`）。
  - 默认 subagent 注册。
  - 默认 hooks（如 guard-outline-before-prose）。

**对 pi-agent 的落点**：
- 在 `AgentManager.createAgent` 中增加 `skillTemplate` 参数。
- 前端 Agent 创建向导：选择“用途” → 自动选择 skill 模板。

---

### 3. 上下文压缩流程：增加压缩前后状态保存

**参考**：oh-story-claudecode 的 `pre-compact.sh` 和 `post-compact.sh` 保存/恢复进度快照。

**建议优化**：
- pi-agent 已有 Pi SDK 内置 compaction，但可以增加：
  - 压缩前保存当前“工作上下文”（如 novel 中的当前章节、关键实体状态）。
  - 压缩后提示 Agent 重新读取关键文件（如 `追踪/上下文.md`）。
  - 在压缩通知中显示“哪些信息被保留 / 哪些被摘要”。

**对 pi-agent 的落点**：
- 在 `MemoryTicker` 或 `SessionCoordinator` 中增加 `preCompact` / `postCompact` hook。
- 压缩事件 WebSocket 推送中增加 `preservedKeys` 字段。

---

### 4. 工具调用流程：增加任务验证和证据链

**参考**：oh-story-claudecode 的 `validate-story-commit.sh` 在 git commit 前校验设定必填字段。

**建议优化**：
- 把 `Evidence Ledger` 和 `Final Readiness Check` 从架构决策变成可配置规则。
- 例如：
  - 在 Agent 说“任务完成”前，必须调用过 `read` 或 `grep` 验证结果（证据链）。
  - 在 git commit 前，检查是否有未解决的 TODO、测试是否通过。
  - 在文件写入前，检查是否符合项目命名规范。

**对 pi-agent 的落点**：
- 在 `Gate` 中增加 `readiness` 规则类型。
- 在 `PluginContext` 中增加 `registerReadinessCheck(name, fn)`。

---

### 5. 文件写入流程：增加写入前 Guard

**参考**：`guard-outline-before-prose.sh` 在写正文前检查大纲。

**建议优化**：
- 通用化为“写入前条件检查”：
  - 写代码前是否已有测试？
  - 写文档前是否已有设计说明？
  - 写小说正文前是否已有细纲？
- 条件不满足时：
  - 阻止写入（严格模式）。
  - 或自动先调用相关工具补全条件（宽松模式）。

**对 pi-agent 的落点**：
- 在 `Gate` 中增加 `pre-write` 检查类型。
- 在 Plugin SDK 中提供 `registerWriteGuard(condition, handler)`。

---

### 6. 会话启动流程：显示上下文快照

**参考**：`session-start.sh` 显示分支、进度快照、拆文状态。

**建议优化**：
- 当用户打开一个已有会话时，自动显示：
  - 当前进行中的阶段。
  - 最近修改的文件。
  - 待确认的 checkpoint。
  - 未完成的子任务。
- 让用户快速恢复上下文，而不是从头看历史消息。

**对 pi-agent 的落点**：
- 在 `session_start` hook 中读取会话元数据并生成摘要。
- 前端会话打开时显示 `SessionSnapshot` 卡片（可折叠）。

---

### 7. 版本管理与升级流程

**参考**：oh-story-claudecode 的 `CHANGELOG.md` 和版本链。

**建议优化**：
- 为 skill 和插件提供版本管理：
  - 安装时记录版本。
  - 检测到新版本时提示更新。
  - 更新时执行迁移脚本（如目录结构变更、提示词调整）。
- 与 pi-agent 已有的数据迁移系统结合：skill 也可以有自己的迁移。

**对 pi-agent 的落点**：
- 在 `PluginManifest` 中增加 `version` 和 `migrations`。
- 在插件加载时运行迁移。

---

## 五、建议加入的新功能（按优先级排序）

### P0：skill 一级概念 + 自然语言路由
- 建立 `Skill` 与 `Plugin` 的区分。
- 前端 `/` 命令面板触发 skill。
- 这是后续所有专业化的基础。

### P0：hooks 系统扩展
- 把 `beforeToolCall` / `afterToolCall` 扩展为可注册的外部 hook。
- 支持 `session_start` / `session_end` / `before_compact` / `after_compact` / `before_write`。
- 这是“确定性守卫”的前提。

### P1：references/ 知识库按需加载
- 为每个 skill 提供可拆分的方法论文件。
- 按任务动态选择加载，控制上下文成本。
- 这是 pi-agent 提示词工程的下一步。

### P1：项目模板初始化
- 选择 skill 时自动初始化项目目录和模板文件。
- 对 novel plugin 尤其有价值。

### P1：阶段检查点（stage checkpoint）
- 把 `ConfirmationManager` 扩展为支持任务阶段决策。
- 在小说创作、代码生成、报告撰写等长流程中都需要。

### P2：通用润色 / 去 AI 味 skill
- 不仅小说，任何文本输出都可以用。
- 可以作为一个独立 skill 或输入区功能。

### P2：浏览器 CDP 抓取工具
- 复用本地浏览器登录态抓取数据。
- 需要严格的权限控制和用户告知。

### P2：视觉生成 skill（封面/海报/图表）
- 调用 ImageGen 或多模态生成能力。
- 与项目的“仙居杨梅海报设计”等视觉任务结合。

### P3：Skill Marketplace
- 本地 skill 目录 + GitHub 安装 + 版本管理。
- 需要长期规划，不是当前最急迫。

---

## 六、与现有 pi-agent 模块的对应关系

| 建议功能 | 复用/改造 pi-agent 的哪个模块 | 新增哪个模块 |
|---------|---------------------------|------------|
| Skill 一级概念 | `PluginManager` | `SkillManager` |
| 自然语言路由 | `session.prompt()` 之前 | `IntentRouter` |
| 项目模板初始化 | `AgentManager.createAgent` | `ProjectTemplateService` |
| Hooks 系统 | `beforeToolCall` / `afterToolCall` | `HookRegistry` |
| references 按需加载 | `InstructionLoader` | `ReferenceLoader` |
| 阶段检查点 | `ConfirmationManager` | 扩展 `checkpoint` type |
| 通用润色 | `Extensions` 工具系统 | `deslop` skill / tool |
| 浏览器 CDP | `web_fetch` / `web_search` | `browser-cdp` extension |
| 视觉生成 | 当前无，需接入 ImageGen | `image-generate` extension |
| Skill Marketplace | 插件加载机制 | `SkillMarketplace` |

---

## 七、最小可落地的第一版（MVP）

如果只想先快速验证价值，建议按这个顺序做：

1. **在 Novel Plugin 内引入 `references/` 按需加载**：
   - 把现有 prompts/*.md 拆分为 `references/world-rules.md`、`references/style-guide.md`、`references/writing-discipline.md`。
   - 在 `prompt-builder.ts` 中按当前阶段加载不同 reference。

2. **增加 2 个 stage checkpoint**：
   - `narrative_task`：Director 输出后，用户确认再进入 Writer。
   - `review`：Reviewer 输出后，用户选择 revise/rewrite/approve。

3. **增加 1 个 guard hook**：
   - `guard-outline-before-prose`：在 Writer 尝试写正文前，检查是否存在本章细纲。

4. **把 `deslop` 作为通用工具**：
   - 实现 `deslop` 工具，检测并改写 AI 味句式。
   - 在 Novel Plugin 中写正文后自动调用一次。

5. **前端增加 skill 触发入口**：
   - 在输入区支持 `/` 列出可用 skill（先只列出 novel 相关）。
   - 选择后设置 `activeSkill` 并加载对应 references。

---

## 八、风险提示

1. **上下文成本控制**：references 按需加载虽然省，但 skill 多了之后容易失控。需要 token 预算和截断策略。
2. **skill 版本漂移**：多人协作或用户自己修改后，需要版本校验和迁移。
3. **浏览器 CDP 安全**：复用浏览器登录态可能读取敏感网站，必须明确授权和审计。
4. **过度工程化**：不是所有 Agent 都需要 skill 工作流。应让 skill 是可选的，不强制改变通用 chat 体验。

---

## 九、总结

oh-story-claudecode 最值得 pi-agent 吸收的不是它的网文写作能力，而是**“把专业工作流封装成 skill”的治理方式**：

- **入口**：统一的 `SKILL.md` 定义 skill 的职责和触发。
- **知识库**：`references/` 按需加载，避免提示词膨胀。
- **守卫**：`hooks/` 在关键节点做确定性校验。
- **模板**：`story-setup` 一键生成项目结构。
- **流水线**：阶段 + 检查点 + 多 Agent 协作。

pi-agent 已经拥有非常完整的技术底座（多 Agent、插件、记忆、SSE/WebSocket、确认机制），缺的正是这层“面向专业场景的 skill 包装”。把这些吸收进来后，pi-agent 就从“通用 Agent 平台”进化成“可承载各种专业工作流（写作、编程、研究、设计）的 Agent 操作系统”。
