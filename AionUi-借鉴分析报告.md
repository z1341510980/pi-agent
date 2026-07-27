# 借鉴 AionUi 改进 pi-agent —— Agent 平台 UI 与交互分析报告

> 生成时间：2026-07-27
> 数据来源：codebase-memory-mcp 知识图谱对比
> - AionUi 索引：8,778 节点 / 20,090 边 / 791 TS 文件
> - pi-agent 索引：5,276 节点 / 14,356 边 / 332 TS 文件

---

## 项目定位

**pi-agent 是什么**：
- 通用 AI Agent 平台（Fastify 后端 + Electron 前端）
- 核心能力：Session / Agent / Subagent / Team / Memory / Tool / Gate / Cron / Plugin / Usage
- 小说只是 `novel-plugin` 插件，与 `hello-plugin` 同级
- 已有 Team（pipeline / parallel）、Subagent（深度隔离）、AG-UI 协议、Gate 四级权限、Evidence Ledger、Memory FactStore

**借鉴核心目标**：让 pi-agent 作为**通用 Agent 平台**的 UI/交互能力对齐 AionUi，让任何 Agent 任务（不只是小说）都受益。

---

## 借鉴优先级矩阵

| 优先级 | 借鉴项 | pi-agent 改造位置 | 价值 |
|---|---|---|---|
| P0 | Team 模式专用 UI | 新增 `pages/team/` | 让后端 Team 能力有前端入口 |
| P0 | MessageToolGroup + Gate 内联 | 新增 `message-tool-group.tsx` + 改 `confirmation-dialog.tsx` | Gate 系统可视化 |
| P0 | 多 Runtime 选择器 | 升级 `model-selector.tsx` + 新增 `runtime-selector-pill.tsx` | 区分 Agent 类型 |
| P0 | 三栏 ChatLayout + Preview | 重构 `chat-workspace.tsx` + 新增 `preview-panel/` | 通用任务预览 |
| P0 | 语义 Token + 主题引擎 | `tailwind.config.ts` + 新增 `utils/theme/` | 专业感基础 |
| P1 | Subagent/Team/Cron 消息可视化 | 新增多种 Message 组件 | 编排能力可视化 |
| P1 | 助手市场 + 三层技能 | 新增 `pages/settings/assistants/` | 助手抽象 |
| P1 | GuidPage 指令台 | 重构 `home-page.tsx` → `guid-page.tsx` | 入口优化 |
| P1 | 命令队列 + Slash 扩展 | 新增 `command-queue-panel.tsx` | 任务编排 |
| P1 | Agent 自动检测 + 协议探测 | 升级 `agent-page.tsx` + `provider-manager.tsx` | 接入门槛 |
| P2 | 字号控制 | 新增 `use-font-sizes.ts` + Titlebar 步进器 | 无障碍 |
| P2 | Sider 拖拽 + 搜索 + 分组 | 升级 `session-list.tsx` | 列表管理 |
| P2 | VSCode 图标 + FileChangeList | 新增通用工作区 | 文件任务 |
| P2 | 语音输入 | 新增 `SpeechInputButton` | 输入方式 |

---

## 一、Agent 平台核心交互借鉴（P0）

### 1. 多 Runtime 选择器 + 模型二级菜单

**AionUi 方案**：
- 三套 runtime 适配器：ACP / Aionrs / Gemini（`packages/desktop/src/renderer/pages/conversation/platforms/`）
- Runtime 选择药丸：`packages/desktop/src/renderer/components/agent/RuntimeSelectorPill.tsx`
- 二级菜单：`packages/desktop/src/renderer/components/agent/runtimeSelectorOptions.tsx`
- AcpModelSelector：`packages/desktop/src/renderer/components/agent/AcpModelSelector.tsx`
- AionrsModelSelector：`packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsModelSelector.tsx`
- GoogleModelSelector：`packages/desktop/src/renderer/pages/conversation/platforms/gemini/GoogleModelSelector.tsx`
- 运行时配置 Hook：`packages/desktop/src/renderer/hooks/agent/useAcpConfigOptions.ts`、`useAcpModelInfo.ts`

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/chat/model-selector.tsx`（118 行）单一模型选择器
- `apps/agent-server/src/core/config/provider-config-store.ts` 有多 provider，但 UI 层无 runtime 抽象
- Agent 都是后端注册（`AgentManager.registerAgent`），前端无 runtime 概念

**pi-agent 改造建议**：

Step 1：定义 Runtime 概念

```typescript
// packages/shared/src/agent/runtime.ts
type AgentRuntime = 'local-cli' | 'cloud-api' | 'plugin' | 'team'
// local-cli: Claude Code/Codex 等 CLI 工具
// cloud-api: OpenAI/Anthropic/Gemini 直接 API
// plugin: novel-plugin 等插件 Agent
// team: Team 编排
```

Step 2：新增 `components/agent/runtime-selector-pill.tsx`，借鉴 AionUi 的药丸样式，显示当前 Agent 的 runtime 类型。

Step 3：升级 `model-selector.tsx` 为二级菜单：第一级选 runtime，第二级选该 runtime 下的 model/agent。

**价值**：让 pi-agent 不再只展示"模型"，而是展示"Agent 运行时 + 模型"，清晰区分 Claude Code（CLI）vs GPT-4（API）vs Novel-Director（Plugin）vs Team（编排）。

---

### 2. Team 模式专用 UI

**AionUi 方案**：
- TeamPage：`packages/desktop/src/renderer/pages/team/TeamPage.tsx`（639 行）
- TeamChatView：`packages/desktop/src/renderer/pages/team/components/TeamChatView.tsx`
- 成员选择器：`packages/desktop/src/renderer/pages/team/components/memberPicker/`
  - `TeamAddMemberPopover.tsx` — 添加成员弹层
  - `TeamMemberDraftList.tsx` — 草稿成员列表
  - `TeamAssistantPicker.tsx` — 助手选择
- 成员身份色：`packages/desktop/src/renderer/pages/team/identity/useTeamMemberColors.ts`
- 权限上下文：`packages/desktop/src/renderer/pages/team/hooks/TeamPermissionContext.tsx`
- 空状态：`packages/desktop/src/renderer/pages/team/components/TeamChatEmptyState.tsx`
- 侧边栏分区：`packages/desktop/src/renderer/components/layout/Sider/TeamSiderSection.tsx`

**pi-agent 现状**：
- 后端有完整 Team（`apps/agent-server/src/core/agent/team-manager.ts` 的 `executeParallel`/`executePipeline` + `team-discussion-engine.ts` 的 `invokeMember`）
- 前端**无 Team 专用 UI**，Team 只能通过 API 触发

**pi-agent 改造建议**：

Step 1：新增 `pages/team/` 路由

```
pages/team/
├── TeamPage.tsx              # Team 主页
├── components/
│   ├── TeamChatView.tsx      # Team 聊天（成员消息按颜色区分）
│   ├── memberPicker/         # 成员选择
│   │   ├── TeamAddMemberPopover.tsx
│   │   ├── TeamMemberDraftList.tsx
│   │   └── TeamAssistantPicker.tsx
│   ├── TeamChatEmptyState.tsx
│   └── TeamJobIndicator.tsx  # Team 任务指示
├── identity/
│   └── useTeamMemberColors.ts
└── hooks/
    ├── TeamPermissionContext.tsx
    └── useTeamRunning.ts
```

Step 2：在 `apps/desktop/src/renderer/src/App.tsx` 的 RailButton 加 Team 入口。

Step 3：消息流支持 Team 成员头像 + 颜色区分（借鉴 `useTeamMemberColors`）。

**价值**：让 pi-agent 的 Team 能力（已是后端核心）终于有前端入口，不再只是 API 玩具。

---

### 3. 助手市场 + 三层技能源

**AionUi 方案**：
- 助手列表：`packages/desktop/src/renderer/pages/settings/AssistantSettings/`
- 21 个内置助手：`packages/desktop/src/renderer/hooks/agent/usePresetAssistantInfo.ts`
- 技能市场：`packages/desktop/src/renderer/pages/settings/SkillsSettings/SkillsHubSettings.tsx` + `SkillDetailPage.tsx`
- 三层技能源：builtin / custom / extension
- 会话内技能指示：`packages/desktop/src/renderer/pages/conversation/components/ConversationSkillsIndicator.tsx`
- 技能规则生成：`packages/desktop/src/renderer/pages/conversation/components/SkillRuleGenerator.tsx`
- 技能建议卡片：`packages/desktop/src/renderer/pages/conversation/Messages/components/SkillSuggestCard.tsx`

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/settings/agent-page.tsx` 是 Agent 配置页
- `apps/agent-server/src/core/plugin/plugin-manager.ts` 支持插件，但无"助手"概念
- 无技能市场

**pi-agent 改造建议**：

Step 1：定义"助手" = Agent + 系统提示词 + 技能 + 记忆 + 默认模型

```typescript
// 复用现有 PiSession + Agent + FactStore
interface PiAssistant {
  id: string
  name: string
  avatar: string
  agentId: string              // 绑定 AgentManager 中的 Agent
  systemPrompt: string
  skills: SkillRef[]           // 引用插件提供的技能
  memoryFactIds: string[]      // 绑定 FactStore 中的事实
  defaultModel?: string
  defaultRuntime: AgentRuntime
}
```

Step 2：新增 `pages/settings/assistants/` 助手市场，分内置 / 自定义 / 插件提供三层。

Step 3：会话内显示当前助手标识 + 技能徽章（借鉴 `ConversationSkillsIndicator`）。

**价值**：让用户感知"我在和谁对话"（是 Claude Code 还是 Novel-Director 还是通用助手），而非只看到"model: gpt-4"。

---

## 二、Agent 平台布局借鉴（P0）

### 4. 三栏 ChatLayout + Workspace/Preview 分层

**AionUi 方案**：
- ChatLayout：`packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx`（357 行）
- useResizableSplit：`packages/desktop/src/renderer/hooks/ui/useResizableSplit.tsx`（支持 ratio/px 双单位、LocalStorage 持久化、`preview-panel-resize` 事件广播）
- useWorkspaceCollapse：`packages/desktop/src/renderer/pages/conversation/hooks/useWorkspaceCollapse.ts`
- useLayoutConstraints：`packages/desktop/src/renderer/pages/conversation/hooks/useLayoutConstraints.ts`
- MobileWorkspaceOverlay：`packages/desktop/src/renderer/pages/conversation/components/ChatLayout/MobileWorkspaceOverlay.tsx`
- Layout 主框架：`packages/desktop/src/renderer/components/layout/Layout.tsx`（488 行）

布局结构：

```
┌─────────────────────────────────────────────────┐
│ Titlebar（标签页 + 工作区开关 + 反馈 + 更新）     │
├──────┬──────────────────────┬───────────────────┤
│      │                      │ WorkspacePanel    │
│      │  ChatConversation    │  ─────────────    │
│ Sider│  (Messages + Input)  │ PreviewPanel      │
│      │                      │  (多标签查看器)    │
│      │                      │                   │
└──────┴──────────────────────┴───────────────────┘
```

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx`（720 行）两栏
- `apps/desktop/src/renderer/src/components/ui/resizable-splitter.tsx`（112 行，无持久化）
- 无独立 Preview 面板（文件预览塞在 chat 内）
- ResizableSplitter 无 LocalStorage 持久化
- 无移动端响应式 Overlay
- 无 Titlebar 集成的工作区开关

**pi-agent 改造建议**：

Step 1：升级 `resizable-splitter.tsx`，借鉴 AionUi 的 `useResizableSplit`：

```typescript
// 新增 storageKey 持久化 + preview-panel-resize 事件
interface ResizableSplitOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  storageKey?: string;       // 新增：持久化
  unit: 'ratio' | 'px';      // 新增：单位选择
}
// 拖动时 dispatchEvent('preview-panel-resize') 让 CodeMirror 等重新计算
```

Step 2：新增 `components/chat/preview-panel/` 独立预览区，把 `file-preview-panel.tsx` 升级为多标签 PreviewPanel，与 Workspace 平级。

Step 3：新增 `components/layout/titlebar/`，集成标签页 + 工作区开关 + 反馈按钮。

**价值**：任何 Agent 任务（代码生成、文档撰写、数据分析）都需要独立预览面板，不只是小说。

---

### 5. Titlebar 标签页 + 工作区开关 + 反馈入口

**AionUi 方案**：
- Titlebar：`packages/desktop/src/renderer/components/layout/Titlebar/index.tsx`（437 行）
  - `SidebarIcon` — 侧边栏折叠按钮
  - `handleSiderToggle` / `handleWorkspaceToggle` / `handleBackToChat`
  - `FeedbackIcon` — 反馈按钮
  - `updateOffset` — 标签页滚动
- 移动端品牌区：`packages/desktop/src/renderer/components/layout/Titlebar/MobileConversationBrand.tsx`

**pi-agent 现状**：无独立 Titlebar，操作按钮散落在 `chat-workspace.tsx` 和 `novel-workspace.tsx`。

**pi-agent 改造建议**：新建 `components/layout/titlebar/`，集成：
1. 会话标签页（多开任务切换）
2. 工作区折叠按钮（一键专注对话）
3. 反馈按钮 + 一键诊断（pi-agent 用 bytenode，更需要诊断入口）
4. 自动更新提示入口（已有 `update-dialog.tsx`，但入口缺失）

---

## 三、消息流与工具交互借鉴（P0/P1）

### 6. 17 种消息类型组件 + 工具组折叠

**AionUi 方案**：`packages/desktop/src/renderer/pages/conversation/Messages/components/` 17 个组件：

| 组件 | 用途 | pi-agent 对应 |
|---|---|---|
| `MessageText` | 文本（Markdown + 代码高亮 + Mermaid） | message-bubble.tsx |
| `MessageThinking` | 思考过程（可折叠 + 流式光标） | thinking-block.tsx |
| `MessageToolCall` | 单工具调用卡片 | tool-call-card.tsx |
| `MessageToolGroup` | 工具组（多工具聚合 + 确认按钮） | 缺失 |
| `MessageToolGroupSummary` | 工具组摘要（一行总结） | 缺失 |
| `MessagePlan` | Agent 规划展示 | 缺失 |
| `MessagePermission` | 权限请求面板（allow once/always/cancel） | confirmation-dialog.tsx |
| `MessageCronBadge` | 定时任务触发标识 | 缺失 |
| `MessageCronTrigger` | 定时任务触发卡片 | 缺失 |
| `MessageSkillSuggest` | 技能建议 | 缺失 |
| `MessageAgentStatus` | Agent 状态指示 | 缺失 |
| `MessageFileChanges` | 文件变更面板 | 缺失 |
| `MessageTips` | 提示卡片 | 缺失 |
| `SelectionReplyButton` | 选中文字快速回复 | 缺失 |

关键设计 — MessageToolGroup（`MessageToolGroup.tsx`，601 行）：
- 多个连续工具调用聚合为一个可折叠组
- 组头显示摘要（`MessageToolGroupSummary`）
- 组内集成确认按钮（`useConfirmationButtons`）：allow once / allow always / cancel
- 折叠状态通过 `CollapsibleContent.tsx` 统一管理
- 集成 `FileChangesPanel` + `ButlerDiagnoseButton` + `FeedbackButton`

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/chat/tool-call-card.tsx`（145 行）单卡片，无聚合
- `apps/desktop/src/renderer/src/components/chat/confirmation-dialog.tsx` 独立弹窗，不在消息流内

**pi-agent 改造建议**：

Step 1：新增 `components/chat/message-tool-group.tsx`，把连续的 `ToolCallCard` 聚合：

```typescript
// 借鉴 AionUi 的 normalizeToolGroup
// 连续同类型工具调用 → 一个 ToolGroup
// 组头显示："3 次文件写入 · 2 次成功 1 次失败"
// 组内可展开查看每个 ToolCallCard
```

Step 2：把 `confirmation-dialog.tsx` 从独立弹窗改为**消息流内联面板**（借鉴 `MessagePermission`），让用户在上下文中决策。

Step 3：新增 Agent 平台通用消息类型：
- `MessageAgentStatus` — 显示 Agent 当前状态（thinking/working/idle），pi-agent 的 `stream-emitter.ts` 已有事件，前端补 UI
- `MessagePlan` — 显示 Agent 推理计划（pi-agent 有 `reasoning-pipeline.ts`，前端缺展示）
- `MessageCronBadge` — 定时任务触发标识（pi-agent 有 `cron-plugin`，前端缺展示）
- `MessageSubagentSpawn` — 子 Agent 生成（pi-agent 有 subagent，前端缺可视化）
- `MessageTeamDispatch` — Team 任务分发（pi-agent 有 team，前端缺可视化）

**价值**：让 pi-agent 强大的后端能力（Gate/Subagent/Team/Cron/Reasoning）终于有前端可视化，这是 Agent 平台的核心交互。

---

### 7. 命令队列面板 + Slash 命令 + @ 引用

**AionUi 方案**：
- 命令队列：`packages/desktop/src/renderer/components/chat/CommandQueuePanel.tsx` + `useConversationCommandQueue.ts`
- Slash 命令：`packages/desktop/src/common/chat/slash/` + `SlashCommandMenu.tsx`
- @ 文件引用：`packages/desktop/src/renderer/components/chat/AtFileMenu/` + `atCommandParser.ts`
- 语音输入：`packages/desktop/src/renderer/components/chat/SpeechInputButton.tsx`

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/chat/slash-command-panel.tsx`（250 行）有 slash 命令
- `apps/desktop/src/renderer/src/components/chat/mention-panel.tsx`（173 行）有 @ 引用
- 无命令队列、无语音输入

**pi-agent 改造建议**：

Step 1：新增命令队列 `components/chat/command-queue-panel.tsx`
- pi-agent 的 Team 模式下，用户可能连续下达多个任务给不同成员
- 队列面板显示待执行任务，支持取消/重排
- 借鉴 AionUi 的 `useConversationCommandQueue`

Step 2：扩展 slash 命令集（pi-agent 的 Agent 平台需要）：
- `/team` — 创建 Team 任务
- `/subagent` — 派生子 Agent
- `/memory` — 查询/添加记忆
- `/cron` — 创建定时任务
- `/skill` — 调用技能
- `/runtime` — 切换 runtime

Step 3：@ 引用扩展到 Agent 平台资源：
- `@agent:director` — 引用 Agent
- `@fact:xxx` — 引用 Fact
- `@file:xxx` — 引用文件（已有）
- `@team:xxx` — 引用 Team

Step 4：新增语音输入（`SpeechInputButton`），任何 Agent 任务都受益。

---

## 四、Agent 平台视觉系统借鉴（P0）

### 8. 语义 Token + 主题引擎 + 字号控制

**AionUi 方案**：
- 主题应用：`packages/desktop/src/renderer/utils/theme/applyTheme.ts` — `tokensToCss` 把 token 转 CSS 变量
- 系统跟随：`packages/desktop/src/renderer/utils/theme/systemAppearance.ts` — `watchSystemPrefersDark`
- 自定义 CSS：`packages/desktop/src/renderer/utils/theme/customCssProcessor.ts` — `validateCss` + `wrapCustomCss`
- 9 种预设：`packages/desktop/src/renderer/pages/settings/AppearanceSettings/presets/`
  - `default`、`hello-kitty`、`misaka-mikoto`、`retro-windows`、`retroma-y2k`、`retroma-obsidian-book`、`discourse-horizon`、`glittering-input-field` 等
- CSS 主题编辑器：`packages/desktop/src/renderer/pages/settings/AppearanceSettings/CssThemeModal.tsx`
- 配置迁移：`packages/desktop/src/common/theme/migrateThemeConfig.ts`
- 字号控制：`packages/desktop/src/renderer/hooks/ui/useFontSizes.ts` + `useFontScale.ts` + `FontSizeStepper.tsx`

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/theme-provider.tsx`（79 行）仅 dark/light 切换
- 无预设皮肤，无 CSS 变量体系，无字号控制

**pi-agent 改造建议**：

Step 1：建立语义 token 系统，在 `tailwind.config.ts` 中定义：

```typescript
// 借鉴 AionUi 的 semantic tokens
colors: {
  bg: { primary: 'rgb(var(--bg-primary))', secondary: 'rgb(var(--bg-secondary))' },
  text: { primary: 'rgb(var(--text-primary))', secondary: 'rgb(var(--text-secondary))' },
  border: { default: 'rgb(var(--border-default))', strong: 'rgb(var(--border-strong))' },
  accent: { default: 'rgb(var(--accent))', hover: 'rgb(var(--accent-hover))' },
}
```

Step 2：新增 `utils/theme/` 目录，迁移 AionUi 的 `applyTheme` + `systemAppearance` + `customCssProcessor`。

Step 3：为 Agent 平台设计 3-4 种专业皮肤：
- `pro-dark`（深色专业，默认）
- `pro-light`（浅色专业）
- `focus-sepia`（护眼专注）
- `cyber-neon`（极客炫酷）

Step 4：新增字号控制（`hooks/ui/use-font-sizes.ts` + Titlebar 步进器），Agent 任务输出代码/文档，字号可调是基础需求。

**价值**：Agent 平台需要长时间使用，专业主题 + 字号控制是基础体验。

---

## 五、Agent 平台能力可视化借鉴（P1）

### 9. Subagent/Team/Cron 在消息流中的可视化

**AionUi 方案**：
- Team 成员消息有头像 + 颜色（`useTeamMemberColors`）
- Cron 触发有 `MessageCronBadge` + `MessageCronTrigger`
- Agent 状态有 `MessageAgentStatus`
- 文件变更有 `MessageFileChanges`

**pi-agent 现状**：pi-agent 后端有强大的 Subagent（深度隔离）、Team（pipeline/parallel + discussion）、Cron，但前端消息流无任何区分。

**pi-agent 改造建议**：

Step 1：Subagent 可视化
- 子 Agent 消息缩进显示 + 父子关系连线
- 显示 subagent 深度（childDepth）
- 显示 subagent 进度（onProgress 回调已有）

Step 2：Team 可视化
- Team 成员消息按颜色区分（借鉴 `useTeamMemberColors`）
- pipeline 模式：消息按顺序排列
- parallel 模式：消息并行显示（多列或折叠）
- discussion 模式：显示讨论轮次

Step 3：Cron 可视化
- Cron 触发的对话有 `CronBadge` 标识
- 显示 cron 任务名 + 触发时间
- 支持"查看 cron 任务详情"跳转

**价值**：让 pi-agent 的 Agent 编排能力（Subagent/Team/Cron）从"黑盒 API"变成"可视化工作流"。

---

### 10. Agent 配置页升级 + Runtime 配置

**AionUi 方案**：
- AgentSettings：`packages/desktop/src/renderer/pages/settings/AgentSettings/`
- LocalAgents：`packages/desktop/src/renderer/pages/settings/AgentSettings/LocalAgents.tsx` — 自动检测本地 Agent
- ModeSettings：`packages/desktop/src/renderer/pages/settings/ModeSettings.tsx` — 模型/平台配置（30+ 平台）
- OneClickImportModal：`packages/desktop/src/renderer/pages/settings/components/OneClickImportModal.tsx` — 一键导入
- 协议自动检测：`/api/providers/detect-protocol`

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/settings/agent-page.tsx` — Agent 配置
- `apps/desktop/src/renderer/src/components/settings/models-page.tsx` — 模型管理
- `apps/desktop/src/renderer/src/components/settings/provider-manager.tsx` — Provider 管理
- 无本地 Agent 自动检测、无协议自动检测、无一键导入

**pi-agent 改造建议**：

Step 1：在 `agent-page.tsx` 加"自动检测本地 Agent"功能：
- 检测 PATH 中的 `claude`/`codex`/`qwen`/`gemini` 等 CLI
- 检测已安装的 pi-agent 插件
- 列表展示 + 一键启用

Step 2：在 `provider-manager.tsx` 加协议自动检测：
- 用户输入 base URL，自动探测 `/v1/models`（OpenAI）/`/v1/messages`（Anthropic）/`/v1beta/models`（Gemini）
- 新增 `/api/providers/detect-protocol` 路由

Step 3：新增"一键导入"功能（借鉴 `OneClickImportModal`）：
- 粘贴 OpenAI/Anthropic/Google 的 API key + base URL
- 自动识别协议 + 拉取模型列表

**价值**：让 Agent 平台的接入门槛降到最低。

---

### 11. GuidPage 指令台首页

**AionUi 方案**：
- GuidPage：`packages/desktop/src/renderer/pages/guid/GuidPage.tsx`（744 行）
- GuidInputCard：`packages/desktop/src/renderer/pages/guid/components/GuidInputCard.tsx` — 中央大输入框
- GuidActionRow：`packages/desktop/src/renderer/pages/guid/components/GuidActionRow.tsx` — 助手选择 + 模式选择 + 模型选择
- QuickActionButtons：`packages/desktop/src/renderer/pages/guid/components/QuickActionButtons.tsx` — 预设场景一键启动
- useGuidInput：`packages/desktop/src/renderer/pages/guid/hooks/useGuidInput.ts` — 统一输入处理

**pi-agent 现状**：`apps/desktop/src/renderer/src/components/home/home-page.tsx` 是简单入口。

**pi-agent 改造建议**：升级为"Agent 指令台"：
1. **中央指令输入卡** — 直接输入任务"帮我写一个 Python 爬虫"、"分析这份数据"
2. **快捷操作行** — 助手选择 + runtime 选择 + 模型选择
3. **快捷场景按钮** — "新建对话"、"新建 Team"、"定时任务"、"导入插件"
4. **最近会话** — 横向卡片（不只是 chat session，还包括 team session、cron session）

**价值**：让用户一打开 pi-agent 就能直接下达 Agent 任务，而非先选菜单。

---

## 六、布局细节借鉴（P2）

### 12. Sider 拖拽排序 + 折叠 + 搜索 + 分组

**AionUi 方案**：`packages/desktop/src/renderer/components/layout/Sider/`
- `SortableSiderEntry.tsx` — 可拖拽排序
- `useStoredSiderOrder.ts` — 排序持久化
- `TeamSiderSection.tsx` — 团队模式分区
- `ConversationSearchPopover` — 搜索弹出
- `siderTooltip.ts` — 折叠时 tooltip
- `cleanupSiderTooltips` — 清理遗留 tooltip

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/chat/session-list.tsx`（284 行）用虚拟滚动 + `groupSessions` 分组
- 无拖拽排序、无折叠状态、无搜索弹出

**pi-agent 改造建议**：Agent 平台的 session 列表需要：
1. **拖拽排序** — 用户优先处理某些任务
2. **折叠状态** — 专注当前任务
3. **搜索弹出** — 快速查找历史任务
4. **按类型分组** — chat / team / cron / subagent 分区（借鉴 `TeamSiderSection`）

---

### 13. 工作区文件树 + VSCode 图标 + FileChangeList

**AionUi 方案**：
- useWorkspaceTree：`packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspaceTree.ts`
- treeHelpers：`packages/desktop/src/renderer/pages/conversation/Workspace/utils/treeHelpers.ts`
- VSCode 图标集：`packages/desktop/src/renderer/pages/conversation/Workspace/utils/vscodeIconsData.json` — 文件类型精准图标
- 拖拽导入：`packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspaceDragImport.ts`
- 粘贴上传：`packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspacePaste.ts`
- 文件变更追踪：`packages/desktop/src/renderer/pages/conversation/Workspace/components/FileChangeList.tsx`

**pi-agent 现状**：
- `apps/desktop/src/renderer/src/components/novel/sidebar/project-tree.tsx`（594 行）仅小说项目用
- 无 VSCode 图标集，无文件变更追踪，无通用文件树

**pi-agent 改造建议**：Agent 平台的任何任务都可能产出文件，需要通用工作区：
1. 迁移 AionUi 的 `vscodeIconsData.json`，让 `.py`/`.js`/`.md`/`.json` 等文件类型有精准图标
2. 新增 `FileChangeList` — 显示 Agent 修改了哪些文件（代码任务特别需要）
3. 拖拽导入 + 粘贴上传

---

### 14. 语音输入 + 选中文字快速回复

**AionUi 方案**：
- 语音输入：`packages/desktop/src/renderer/components/chat/SpeechInputButton.tsx` + `packages/desktop/src/renderer/hooks/system/useSpeechInput.ts`
- 选中文字快速回复：`packages/desktop/src/renderer/pages/conversation/Messages/components/SelectionReplyButton.tsx` + `packages/desktop/src/renderer/hooks/ui/useTextSelection.ts`
- 消息分组：连续同一 Agent 的消息合并，组内第一条 `compact=false`，后续 `compact=true`
- 自动滚动检测：距底部 50px 内才跟随

**pi-agent 现状**：无语音输入、无选中回复、无消息分组、无自动滚动阈值。

**pi-agent 改造建议**：
1. 新增 `SpeechInputButton` — 语音输入任务指令
2. 新增 `SelectionReplyButton` — 选中 Agent 输出文字，点击"引用回复"直接进入输入框带引用
3. 消息分组 — Team 协作时同 Agent 连续消息紧凑排列
4. 自动滚动 — 50px 阈值，用户上滚查看时不被打断

---

## 落地路线图

### 第一阶段（P0，2-3 周）

| 序号 | 借鉴项 | 改造位置 | 关键文件 |
|---|---|---|---|
| 1 | Team 模式专用 UI | 新增 `pages/team/` | TeamPage / TeamChatView / memberPicker / useTeamMemberColors |
| 2 | MessageToolGroup + Gate 内联 | 新增 `message-tool-group.tsx` + 改 `confirmation-dialog.tsx` | 借鉴 MessageToolGroup + MessagePermission |
| 3 | 多 Runtime 选择器 | 升级 `model-selector.tsx` + 新增 `runtime-selector-pill.tsx` | 借鉴 RuntimeSelectorPill + runtimeSelectorOptions |
| 4 | 三栏 ChatLayout + Preview | 重构 `chat-workspace.tsx` + 新增 `preview-panel/` | 借鉴 ChatLayout + useResizableSplit |
| 5 | 语义 Token + 主题引擎 | `tailwind.config.ts` + 新增 `utils/theme/` | 借鉴 applyTheme + systemAppearance + customCssProcessor |

### 第二阶段（P1，2-3 周）

| 序号 | 借鉴项 | 改造位置 | 关键文件 |
|---|---|---|---|
| 6 | Subagent/Team/Cron 消息可视化 | 新增多种 Message 组件 | MessageAgentStatus / MessageSubagentSpawn / MessageTeamDispatch / MessageCronBadge |
| 7 | 助手市场 + 三层技能 | 新增 `pages/settings/assistants/` | 借鉴 AssistantSettings + SkillsHubSettings |
| 8 | GuidPage 指令台 | 重构 `home-page.tsx` → `guid-page.tsx` | 借鉴 GuidPage + GuidInputCard + QuickActionButtons |
| 9 | 命令队列 + Slash 扩展 | 新增 `command-queue-panel.tsx` + 扩展 slash | 借鉴 CommandQueuePanel + useConversationCommandQueue |
| 10 | Agent 自动检测 + 协议探测 | 升级 `agent-page.tsx` + `provider-manager.tsx` | 借鉴 LocalAgents + OneClickImportModal |

### 第三阶段（P2，1-2 周）

| 序号 | 借鉴项 | 改造位置 | 关键文件 |
|---|---|---|---|
| 11 | 字号控制 | 新增 `use-font-sizes.ts` + Titlebar 步进器 | 借鉴 useFontSizes + FontSizeStepper |
| 12 | Sider 拖拽 + 搜索 + 分组 | 升级 `session-list.tsx` | 借鉴 SortableSiderEntry + useStoredSiderOrder |
| 13 | VSCode 图标 + FileChangeList | 新增通用工作区 | 借鉴 vscodeIconsData.json + FileChangeList |
| 14 | 语音输入 + 选中回复 | 新增 `SpeechInputButton` + `SelectionReplyButton` | 借鉴 SpeechInputButton + SelectionReplyButton |

---

## 最值得优先落地的 3 项

### 1. Team 模式专用 UI

pi-agent 后端 Team 能力（pipeline/parallel + discussion engine + moderator）已是核心，但前端完全缺失。这是 pi-agent 作为 Agent 平台最大的 UI 短板，必须最先补齐。

**改造要点**：
- 新增 `pages/team/` 路由，含 TeamPage / TeamChatView / memberPicker
- 复用后端 `TeamManager.executeParallel` / `executePipeline` / `TeamDiscussionEngine.invokeMember`
- 消息流支持 Team 成员头像 + 颜色区分（`useTeamMemberColors`）
- 在 `App.tsx` 的 RailButton 加 Team 入口

### 2. MessageToolGroup + Gate 内联面板

pi-agent 的 Gate（四级权限）+ Confirmation（approve/reject/revise/rewrite）+ Evidence Ledger 是 Agent 平台的安全基石，但当前用独立弹窗 `confirmation-dialog.tsx` 割裂上下文。

**改造要点**：
- 新增 `message-tool-group.tsx`，把连续 `ToolCallCard` 聚合
- 组头摘要："3 次文件写入 · 2 次成功 1 次失败"
- 组内集成 Gate 确认按钮（auto/manual/readonly 三模式）
- 把 `confirmation-dialog.tsx` 从独立弹窗改为消息流内联面板

### 3. 多 Runtime 选择器

pi-agent 当前只有 `model-selector.tsx`，无法区分"这是 Claude Code CLI 任务"vs"这是 GPT-4 API 任务"vs"这是 Novel-Director 插件任务"。

**改造要点**：
- 定义 `AgentRuntime = 'local-cli' | 'cloud-api' | 'plugin' | 'team'`
- 新增 `runtime-selector-pill.tsx` 显示当前 runtime
- 升级 `model-selector.tsx` 为二级菜单（runtime → model/agent）

---

## 附录：AionUi 关键参考文件清单

### 布局层
- `packages/desktop/src/renderer/components/layout/Layout.tsx`（488 行）— 主框架
- `packages/desktop/src/renderer/components/layout/Titlebar/index.tsx`（437 行）— 标题栏
- `packages/desktop/src/renderer/components/layout/Sider/` — 侧边栏
- `packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx`（357 行）— 聊天布局
- `packages/desktop/src/renderer/hooks/ui/useResizableSplit.tsx` — 可拖拽分割

### 消息流
- `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageToolGroup.tsx`（601 行）— 工具组
- `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageToolGroupSummary.tsx` — 工具组摘要
- `packages/desktop/src/renderer/pages/conversation/Messages/components/MessagePermission/` — 权限面板
- `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageAgentStatus.tsx` — Agent 状态
- `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageCronBadge.tsx` — Cron 标识
- `packages/desktop/src/renderer/pages/conversation/Messages/components/SelectionReplyButton.tsx` — 选中回复

### Agent 选择
- `packages/desktop/src/renderer/components/agent/RuntimeSelectorPill.tsx` — Runtime 药丸
- `packages/desktop/src/renderer/components/agent/runtimeSelectorOptions.tsx` — Runtime 选项
- `packages/desktop/src/renderer/components/agent/AcpModelSelector.tsx` — ACP 模型选择
- `packages/desktop/src/renderer/hooks/agent/useManagedAgents.ts` — Agent 管理
- `packages/desktop/src/renderer/hooks/agent/usePresetAssistantInfo.ts` — 预设助手

### Team 模式
- `packages/desktop/src/renderer/pages/team/TeamPage.tsx`（639 行）— Team 主页
- `packages/desktop/src/renderer/pages/team/components/TeamChatView.tsx` — Team 聊天
- `packages/desktop/src/renderer/pages/team/components/memberPicker/` — 成员选择
- `packages/desktop/src/renderer/pages/team/identity/useTeamMemberColors.ts` — 成员颜色
- `packages/desktop/src/renderer/pages/team/hooks/TeamPermissionContext.tsx` — 权限上下文

### 主题系统
- `packages/desktop/src/renderer/utils/theme/applyTheme.ts` — 主题应用
- `packages/desktop/src/renderer/utils/theme/systemAppearance.ts` — 系统跟随
- `packages/desktop/src/renderer/utils/theme/customCssProcessor.ts` — CSS 处理
- `packages/desktop/src/renderer/pages/settings/AppearanceSettings/presets/` — 9 种预设
- `packages/desktop/src/renderer/hooks/ui/useFontSizes.ts` — 字号控制

### 助手与技能
- `packages/desktop/src/renderer/pages/settings/AssistantSettings/` — 助手管理
- `packages/desktop/src/renderer/pages/settings/SkillsSettings/SkillsHubSettings.tsx` — 技能市场
- `packages/desktop/src/renderer/pages/conversation/components/ConversationSkillsIndicator.tsx` — 技能指示

### 工作区
- `packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspaceTree.ts` — 文件树
- `packages/desktop/src/renderer/pages/conversation/Workspace/utils/vscodeIconsData.json` — VSCode 图标
- `packages/desktop/src/renderer/pages/conversation/Workspace/components/FileChangeList.tsx` — 文件变更
- `packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspaceDragImport.ts` — 拖拽导入
- `packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspacePaste.ts` — 粘贴上传

### 预览面板
- `packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx` — 主面板
- `packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewTabs.tsx` — 多标签
- `packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/` — 10+ 格式查看器
- `packages/desktop/src/renderer/pages/conversation/Preview/components/editors/` — 编辑器

### 首页
- `packages/desktop/src/renderer/pages/guid/GuidPage.tsx`（744 行）— 指令台首页
- `packages/desktop/src/renderer/pages/guid/components/GuidInputCard.tsx` — 指令输入
- `packages/desktop/src/renderer/pages/guid/components/GuidActionRow.tsx` — 快捷操作
- `packages/desktop/src/renderer/pages/guid/components/QuickActionButtons.tsx` — 快捷按钮

### 聊天交互
- `packages/desktop/src/renderer/components/chat/CommandQueuePanel.tsx` — 命令队列
- `packages/desktop/src/renderer/components/chat/SlashCommandMenu.tsx` — Slash 命令
- `packages/desktop/src/renderer/components/chat/AtFileMenu/` — @ 文件引用
- `packages/desktop/src/renderer/components/chat/SpeechInputButton.tsx` — 语音输入
- `packages/desktop/src/renderer/components/chat/CollapsibleContent.tsx` — 可折叠内容

---

## 附录：pi-agent 改造对照表

| pi-agent 现有文件 | 改造方向 | 借鉴 AionUi |
|---|---|---|
| `apps/desktop/src/renderer/src/App.tsx` | 加 Team / Assistants 入口 | Layout.tsx + Router.tsx |
| `apps/desktop/src/renderer/src/components/home/home-page.tsx` | 升级为指令台 | GuidPage.tsx |
| `apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx` | 三栏重构 | ChatLayout/index.tsx |
| `apps/desktop/src/renderer/src/components/ui/resizable-splitter.tsx` | 加持久化 + 事件 | useResizableSplit.tsx |
| `apps/desktop/src/renderer/src/components/chat/model-selector.tsx` | 二级菜单 + runtime | runtimeSelectorOptions.tsx |
| `apps/desktop/src/renderer/src/components/chat/tool-call-card.tsx` | 聚合为工具组 | MessageToolGroup.tsx |
| `apps/desktop/src/renderer/src/components/chat/confirmation-dialog.tsx` | 改内联面板 | MessagePermission/ |
| `apps/desktop/src/renderer/src/components/chat/session-list.tsx` | 加拖拽 + 搜索 | Sider/ + SortableSiderEntry |
| `apps/desktop/src/renderer/src/components/chat/slash-command-panel.tsx` | 扩展命令集 | SlashCommandMenu.tsx |
| `apps/desktop/src/renderer/src/components/chat/mention-panel.tsx` | 扩展 @ 引用 | AtFileMenu/ |
| `apps/desktop/src/renderer/src/components/theme-provider.tsx` | 语义 token + 主题 | applyTheme.ts + presets/ |
| `apps/desktop/src/renderer/src/components/settings/agent-page.tsx` | 自动检测 | LocalAgents.tsx |
| `apps/desktop/src/renderer/src/components/settings/provider-manager.tsx` | 协议探测 | OneClickImportModal.tsx |
| `apps/desktop/src/renderer/src/components/novel/sidebar/project-tree.tsx` | 通用化 + VSCode 图标 | useWorkspaceTree.ts + vscodeIconsData.json |
| `apps/desktop/src/renderer/src/components/shared/conversation/conversation-stream.tsx` | 消息分组 + 自动滚动 | useProcessedMessages.ts |
| `apps/desktop/src/renderer/src/components/shared/conversation/message-bubble.tsx` | Team 成员颜色 | useTeamMemberColors.ts |
| `apps/desktop/tailwind.config.ts` | 语义 token | uno.config.ts |

---

**报告说明**：
- 所有 AionUi 文件路径基于 `d:/WebWork/AI/AionUi/` 根目录
- 所有 pi-agent 文件路径基于 `d:/WebWork/AI/pi-agent/` 根目录
- 改造优先级基于"Agent 平台通用价值"评估，非小说场景专属
- 落地路线图按依赖关系排序（如 Team UI 依赖 Runtime 选择器）
