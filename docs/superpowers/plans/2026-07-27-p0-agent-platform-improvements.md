# P0 Agent 平台 Chat 翔实改造实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 参考 AionUi 的 UI 风格（用户确认很喜欢），把 pi-agent 的 chat 部分做翔实——消息流视觉层级、工具调用卡片、输入区交互、流式状态、设置页范式全部对齐 AionUi 设计模式；同时保留已设计的 Runtime 选择器、工具聚合+inline 确认、Team SSE 流式三个子系统。**主题切换 UI 暂缓**（用户指示需大量考核后再做），但先引入语义 token 体系打底。

**架构：** 在 pi-agent 现有 `useState<AppView>` 视图切换 + Zustand + TanStack Query + Tailwind v4 CSS-first + radix-ui shadcn 体系上，分 6 个 Stage 推进：Stage 1 引入 AionUi 风格语义 token 到 main.css（不做切换 UI）；Stage 2 翔实增强 chat 组件（message-bubble/tool-call-card/input-area/streaming-indicator）+ chat-workspace 改 flex-basis 共存（不动 resizable-splitter 组件）；Stage 3-5 保留原 Runtime/工具聚合/Team SSE 设计；Stage 6 设置页引入 SettingsPageHeader/PreferenceRow 范式 + 重写 Appearance tab。后端仅动已确认的 3 项（Team SSE/Confirmation 扩展/Team discussion 路由）。

**技术栈：** React 19 / Tailwind v4 / radix-ui (统一包) / Zustand v5 curried / TanStack Query / @xyflow/react / TipTap / lucide-react / framer-motion。**禁用** react-router、UnoCSS、Arco、@radix-ui/* 分包。

---

## 关键约束（必读）

### 严格禁止修改的文件（破坏 novel）

- `apps/agent-server/src/plugins/novel-plugin/**`
- `apps/desktop/src/renderer/src/components/novel/**`
- `apps/desktop/src/renderer/src/components/shared/conversation/**`（novel 前端独立消息流）
- `apps/desktop/src/renderer/src/stores/novel-*.ts`
- `apps/desktop/src/renderer/src/hooks/use-novel-*.ts` / `use-chapter-chat.ts`
- `apps/desktop/src/renderer/src/api/novel-*.ts`
- `apps/desktop/src/renderer/src/lib/novel-utils.ts` / `matrix-viewport.ts`
- **唯一耦合点**：`novel-conversation-panel.tsx` 第 19 行 `import { ErrorCard } from '@/components/chat/error-card'`——改造 chat 时**不得破坏 ErrorCard 导出签名**

### 严格禁止修改的组件（用户已确认）

- `apps/desktop/src/renderer/src/components/ui/resizable-splitter.tsx`——小说部分的分栏拖动组件已完善合理，**不动组件本身**；chat-workspace 如需分栏改用 flex-basis 共存模式（切换 Preview 不卸载 chat DOM），不依赖 resizable-splitter 改造
- `apps/desktop/src/renderer/src/hooks/ui/use-resizable-split.ts`——同上，不动

### 共享层只增不删不改签名

- `@repo/config` / `@repo/protocol` / `@repo/shared` 三个包的现有导出
- `apps/desktop/src/renderer/src/api/http-client.ts` / `api/index.ts`
- `apps/desktop/src/renderer/src/hooks/use-websocket.ts` / `use-realtime-events.ts` 的现有导出签名（只允许新增事件类型）
- `apps/desktop/src/renderer/src/components/ui/*` 的现有 variant 签名
- `apps/desktop/src/renderer/src/i18n/index.tsx` 的 `useTranslation` 返回值签名
- `apps/desktop/src/renderer/src/assets/main.css` 的现有 `--color-*` / `--radius-*` / `--shadow-*` / `--surface-*` / `--text-*` 变量——**Stage 1 只新增 `--bg-1..10` / `--t-primary` 等 AionUi 风格 token，不删不改现有变量**，新组件优先用新 token，旧组件保持原引用

### 后端改动范围（用户已确认 A/B/C 全选）

P0 允许动 `apps/agent-server/**`，但**仅限以下 3 项**，其他后端文件保持不变：

| # | 改动 | 涉及文件 | 原因 |
|---|---|---|---|
| A | Team execute 流式化 | `routes/teams.route.ts` / `core/agent/team-manager.ts` / `@repo/shared/agent/team.ts`（新增事件类型） | `POST /api/teams/:id/execute` 同步阻塞，前端无法显示进度 |
| B | 扩展 Confirmation API | `routes/confirmation.route.ts` / `core/tool/confirmation-manager.ts` / `@repo/shared/agent/team.ts` 或新增 `confirmation.ts` | `respond` 仅 `{ approved: boolean }`，不支持 revise/rewrite |
| C | 暴露 Team discussion 路由 | 新增 `routes/team-discussion.route.ts`；不动 `plugins/novel-plugin/core/novel-discussion-runner.ts` | `team-discussion-engine` 无独立 HTTP 路由，被 novel-plugin 内部独占 |

**禁止动**：
- `plugins/novel-plugin/**`（novel 主线隔离）
- `core/agent/team-discussion-engine.ts` 的现有签名（只在上方新增薄路由层调用其 `invokeMember`）
- `app.ts` 的现有插件注册顺序（只新增 register，不调整）
- 后端测试套件中 novel-* 的 fixture（避免破坏 novel）

### 现状关键事实（已核对）

| 报告描述 | 实际现状 |
|---|---|
| "tailwind.config.ts" | 不存在；Tailwind v4 CSS-first，全部在 `main.css` `@theme inline` |
| "需建立语义 token" | 已有完整 token（surface-1/2/3/4、text/subtle/hint、primary/success/danger/warning、场景色 titlebar-bg/chat-header-bg 等），**只需补主题引擎层** |
| "消息流是否已分组" | **已分组**（`conversation-stream.tsx` 的 `groupMessages()`），无需重做 |
| "ConfirmationDialog 是弹窗还是内联" | Modal 弹窗（shadcn Dialog），ESC 视为拒绝 |
| "ResizableSplitter 是否支持 storageKey" | **不支持**，无 dispatchEvent |
| "ModelSelector 是否支持二级菜单" | **不支持**，仅按 Provider 一级分组 |
| "pi-agent 是否有 runtime 抽象" | **没有**，0 匹配 |
| "team-discussion-engine 是否有 HTTP 路由" | **没有**，仅被 novel-plugin 内部调用 |
| "executeTeamSchema.strategy" | 后端 `routes/teams.route.ts` 仅允许 `'sequential' \| 'parallel' \| 'pipeline'`（无 `'coordinated'`），但 `defaultStrategy` 有 4 种 |

### 后端改动后的能力边界（修订后）

- `POST /api/teams/:id/execute` **立即返回 `{ executionId }`**，不阻塞 → 前端用 `GET /api/teams/executions/:eid/stream`（SSE）订阅实时进度
- `POST /api/confirmations/:id/respond` body 扩展为 `{ action: 'approve' \| 'reject' \| 'revise' \| 'rewrite', comment?: string, revisedContent?: string }`，旧 `{ approved: boolean }` 保留为兼容入口（approved=true → action='approve'）
- `POST /api/teams/:id/discuss` 启动 discussion 模式，返回 `{ executionId }`，复用同一 SSE 端点订阅 discussion 事件
- WebSocket 新增 `team_progress` / `team_member_status` / `team_discussion_message` 3 种事件类型（与 SSE 互补，SSE 用于 HTTP-only 客户端）
- `team-discussion-engine` 现有签名保持不变，新增路由层薄封装其 `invokeMember`

---

## 文件结构总览

### 新建文件

```
apps/desktop/src/renderer/src/
├── components/
│   ├── chat/
│   │   ├── code-block.tsx                       # Stage 2（带复制按钮的代码块，markdown 渲染复用）
│   │   ├── message-hover-toolbar.tsx           # Stage 2（消息 hover 工具栏：复制/重发/引用）
│   │   ├── tool-call-field.tsx                 # Stage 2（工具调用结构化字段渲染，替代裸 <pre>）
│   │   ├── at-file-menu.tsx                    # Stage 2（@文件 mention 菜单，扩展现有 mention-panel）
│   │   ├── message-tool-group.tsx              # Stage 4
│   │   ├── message-tool-group-summary.tsx      # Stage 4
│   │   ├── message-permission-inline.tsx        # Stage 4（替代 confirmation-dialog 的内联版）
│   │   ├── collapsible-content.tsx             # Stage 4
│   │   ├── command-queue-panel.tsx             # Stage 4
│   │   ├── runtime-selector-pill.tsx           # Stage 3
│   │   └── runtime-selector-menu.tsx            # Stage 3
│   ├── team/                                    # Stage 5
│   │   ├── team-page.tsx
│   │   ├── team-chat-view.tsx
│   │   ├── team-view-toggle.tsx
│   │   ├── team-chat-empty-state.tsx
│   │   ├── member-picker/
│   │   │   ├── team-add-member-popover.tsx
│   │   │   ├── team-assistant-picker.tsx
│   │   │   └── team-member-draft-list.tsx
│   │   └── identity/
│   │       ├── team-member-colors.ts            # 纯函数 + 8 色色板
│   │       ├── use-team-member-colors.ts        # Stage 5
│   │       └── team-identity-context.tsx
│   ├── settings/
│   │   ├── settings-page-header.tsx             # Stage 6（title/desc/actions 范式，借鉴 AionUi）
│   │   ├── preference-row.tsx                  # Stage 6（标签左控件右 + divide-y 标准行）
│   │   ├── appearance-page.tsx                  # Stage 6（重写：字号 stepper / 缩放 control / 主题预览画廊但不做切换逻辑）
│   │   ├── font-size-stepper.tsx               # Stage 6（- [值] + 重置，tabular-nums）
│   │   └── scale-control.tsx                   # Stage 6（滑块 + ± + 百分比，拖动/落盘分离）
│   └── ui/
│       └── dropdown-menu.tsx                    # Stage 3 (shadcn add)
├── hooks/
│   └── ui/
│       └── use-font-sizes.ts                    # Stage 6（字号阶梯 + localStorage 持久化）
├── stores/
│   ├── team-store.ts                            # Stage 5
│   └── runtime-store.ts                         # Stage 3
├── utils/
│   ├── agent/
│   │   ├── runtime-types.ts                    # Stage 3
│   │   └── runtime-registry.ts                 # Stage 3
│   └── team/
│       └── team-mapper.ts                      # Stage 5（前后端字段映射）
├── api/
│   └── team-client.ts                          # Stage 5
└── types/
    ├── runtime.ts                              # Stage 3
    └── team.ts                                 # Stage 5
```

### 后端新建文件（Stage 4/5，用户已确认 A/B/C）

```
apps/agent-server/src/
├── routes/
│   └── team-discussion.route.ts                # Stage 5 任务 5.0（薄封装 team-discussion-engine，不动 engine 签名）
└── __tests__/
    └── team-execute-stream.test.ts             # Stage 5 任务 5.0（SSE 流式化集成测试）
```

### 修改文件

| 文件 | Stage | 改动概要 |
|---|---|---|
| `apps/desktop/src/renderer/src/assets/main.css` | 1 | 新增 `--bg-1..10` / `--t-primary/secondary/tertiary` / `--fill-0..3` 语义 token（AionUi 风格），不删现有 `--surface-*` / `--text-*` / `--color-*` |
| `apps/desktop/src/renderer/src/App.tsx` | 2/3/5 | 新增 `AppView = 'team'`，加 RailButton，加 Team 视图分支 |
| `apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx` | 2 | 改为 flex-basis 共存（切换 Preview 不卸载 chat DOM，保留滚动位置），header 整合 runtime pill |
| `apps/desktop/src/renderer/src/components/chat/message-bubble.tsx` | 2 | 新增 hover 工具栏（复制/重发/引用）+ 代码块复制按钮；user 气泡圆角缺角对齐 AionUi |
| `apps/desktop/src/renderer/src/components/chat/tool-call-card.tsx` | 2/4 | Stage 2：结构化字段渲染（tool-call-field）+ `badge-breathing` 呼吸动画；Stage 4：添加 `groupId` prop |
| `apps/desktop/src/renderer/src/components/chat/input-area.tsx` | 2 | @mention 扩展支持文件（at-file-menu），slash command overlay 互斥管理 |
| `apps/desktop/src/renderer/src/components/chat/streaming-indicator.tsx` | 2 | 接入真实 step/tool 状态（替代硬编码"正在分析你的需求…"） |
| `apps/desktop/src/renderer/src/components/chat/model-selector.tsx` | 3 | 改为二级菜单：第一级 runtime，第二级 model/agent |
| `apps/desktop/src/renderer/src/components/chat/confirmation-dialog.tsx` | 4 | 标记 deprecated，保留向后兼容；实际渲染迁移到 `message-permission-inline.tsx` |
| `apps/desktop/src/renderer/src/components/chat/message-stream.tsx` | 4 | 在 ToolCall 序列化前调用 `normalizeToolGroups` 聚合 |
| `apps/desktop/src/renderer/src/components/settings/settings-page.tsx` | 6 | 引入 SettingsPageHeader + PreferenceRow 范式，重写 Appearance tab |
| `apps/desktop/src/renderer/src/stores/index.ts` | 3/5/6 | 新增 `runtime-store` / `team-store` 导出 |
| `apps/desktop/src/renderer/src/i18n/locales/zh-CN.json` | 1-6 | 新增 key（不删现有） |
| `apps/desktop/src/renderer/src/i18n/locales/en-US.json` | 1-6 | 同步新增 key |
| `apps/desktop/src/renderer/src/hooks/use-websocket.ts` | 5 | 新增 `team_progress` / `team_member_status` 事件类型（向后兼容） |
| `apps/agent-server/src/core/agent/team-manager.ts` | 5 | 新增 `executeAsync`（不阻塞，返回 executionId + eventBus 推进度）+ `discussAsync`（薄封装 discussion-engine）；`execute()` 旧同步 API 保留兼容 |
| `apps/agent-server/src/routes/teams.route.ts` | 5 | `POST /:id/execute` 改为立即返回 `{ executionId, teamId }`；新增 `GET /api/teams/executions/:eid/stream`（SSE）端点 |
| `apps/agent-server/src/app.ts` | 5 | 注册 `teamDiscussionRoute`（只新增 register，不调整现有顺序） |
| `apps/agent-server/src/routes/confirmation.route.ts` | 4 | `POST /:id/respond` 自动嗅探 V1/V2 schema；V2 支持 `action: approve\|reject\|revise\|rewrite` + `comment` + `revisedContent`，V1 `{ approved }` 保留兼容 |
| `apps/agent-server/src/core/tool/confirmation-manager.ts` | 4 | 新增 `respondDecisionWithMeta(id, decision, meta?)` 透传 `comment` / `revisedContent`；现有 `requestDecision` / `respondDecision` / `requestConfirmation` / `respond` 签名不变 |

---

## 共享类型定义

### `types/font-sizes.ts`（Stage 6）

> 注：原 `types/theme.ts` 已随主题引擎一起砍掉（用户指示主题切换暂缓）。仅保留字号控制所需类型，移至 `types/font-sizes.ts`。

```typescript
export type FontSizeKey = 'display' | 'heading' | 'body' | 'caption' | 'micro'

export interface FontSizes {
  display: number
  heading: number
  body: number
  caption: number
  micro: number
}
```

### `types/runtime.ts`（Stage 3）

```typescript
export type AgentRuntimeType = 'chat-api' | 'team' | 'agent-plugin'

export interface RuntimeModel {
  id: string
  label?: string
  description?: string
}

export interface RuntimeModelGroup {
  key: string
  title: string
  models: RuntimeModel[]
}

export interface AgentRuntime {
  type: AgentRuntimeType
  label: string
  icon: string                        // lucide icon name
  description: string
  listModels: () => Promise<RuntimeModel[] | RuntimeModelGroup[]>
  defaultModel?: string
}

export interface RuntimeSelection {
  runtime: AgentRuntimeType
  modelId?: string                    // chat-api / agent-plugin 时填
  teamId?: string                     // team 时填
}
```

### `types/team.ts`（Stage 5）

**约束：** `@repo/shared` 已在 `packages/shared/src/agent/team.ts` 定义了完整 Team 类型（`TeamConfig` / `TeamMemberConfig` / `TeamMemberResult` / `TeamResult` / `TeamExecution` / `ExecutionStrategy` / `TeamMemberRole`），并通过 `@repo/shared/agent` 子路径导出（见 `packages/shared/package.json` 的 `exports['./agent']`）。前端**只重导出**，不重复定义，避免类型漂移。

```typescript
// apps/desktop/src/renderer/src/types/team.ts
export type {
  ExecutionStrategy as TeamStrategy,
  TeamMemberRole,
  TeamMemberConfig as TeamMember,
  TeamConfig,
  TeamMemberResult,
  TeamResult,
  TeamExecution,
  TeamExecutionPhase,
} from '@repo/shared/agent'
```

**关键字段（来自 `packages/shared/src/agent/team.ts`，已核对）：**

| 类型 | 字段 | 备注 |
|---|---|---|
| `TeamConfig` | `id` / `name` / `description` / `leadAgentId` / `members: TeamMemberConfig[]` / `defaultStrategy: ExecutionStrategy` / `maxParallel` | description 必填 |
| `TeamMemberConfig` | `agentId` / `role: TeamMemberRole` / `roleDescription?` / `sortOrder?` | 无 subtask 字段 |
| `TeamMemberResult` | `agentId` / `result: string` / `success` / `error?` / `durationMs` | **字段名是 `result` 不是 `output`** |
| `TeamResult` | `executionId` / `teamId` / `task` / `success` / `memberResults: Record<string, TeamMemberResult>` / `summary: string` / `durationMs` | **memberResults 是 Record 不是数组**；summary 必填 |
| `TeamExecution` | `executionId` / `teamId` / `task` / `strategy` / `phase: TeamExecutionPhase` / `memberResults` / `startedAt` / `finishedAt?` / `summary?` / `error?` | **状态字段叫 `phase` 不是 `status`** |
| `TeamExecutionPhase` | `'planning' \| 'executing' \| 'summarizing' \| 'completed' \| 'failed'` | 无 `pending` / `running` / `cancelled` |

---

## Stage 1：语义 token 体系引入（P0-6）

**目标：** 在 `main.css` 引入 AionUi 风格的语义 token（`--bg-1..10` / `--t-primary/secondary/tertiary` / `--fill-0..3`），为后续 Stage 2-6 的新组件提供统一视觉语言。**不做主题切换 UI**（用户指示暂缓，需大量考核后再做），不动 `ThemeProvider`。

**约束：** 只新增 CSS 变量，不删不改现有 `--surface-*` / `--text-*` / `--color-*`。新组件优先用新 token，旧组件保持原引用。

### 任务 1.1：main.css 新增 AionUi 风格语义 token

**文件：**
- 修改：`apps/desktop/src/renderer/src/assets/main.css`

- [ ] **步骤 1：在 `@theme inline` 块末尾新增语义 token**

在 `@theme inline { ... }` 块内，现有 `--surface-*` / `--text-*` 之后，新增以下 token（值映射到现有变量，保证视觉一致）：

```css
/* === AionUi 风格语义 token（Stage 1 引入，主题切换 UI 暂缓） === */
/* 背景层级：bg-1 最浅（基础底色）→ bg-10 最深，数字越大分隔越强 */
--bg-1: var(--surface-1);
--bg-2: var(--surface-2);
--bg-3: var(--surface-3);
--bg-4: var(--surface-4);
--bg-5: color-mix(in srgb, var(--surface-3) 80%, var(--color-border));
--bg-6: color-mix(in srgb, var(--surface-3) 60%, var(--color-border));
--bg-7: color-mix(in srgb, var(--surface-2) 70%, var(--color-border));
--bg-8: color-mix(in srgb, var(--surface-2) 50%, var(--color-border));
--bg-9: color-mix(in srgb, var(--surface-1) 70%, var(--color-border));
--bg-10: var(--color-border);
/* border 映射到 bg-3，与 AionUi 一致 */
--border-1: var(--bg-3);

/* 文字层级：t-primary 最强 → t-disabled 最弱 */
--t-primary: var(--text);
--t-secondary: var(--text-secondary);
--t-tertiary: var(--text-tertiary, var(--text-secondary));
--t-disabled: color-mix(in srgb, var(--text) 40%, transparent);
--t-quaternary: color-mix(in srgb, var(--text) 25%, transparent);

/* 填充层级：fill-0 透明 → fill-3 最强（hover/active 态） */
--fill-0: transparent;
--fill-1: color-mix(in srgb, var(--color-primary) 8%, transparent);
--fill-2: color-mix(in srgb, var(--color-primary) 16%, transparent);
--fill-3: color-mix(in srgb, var(--color-primary) 24%, transparent);

/* 消息专用 */
--message-user-bg: var(--bg-2);
--message-tips-bg: color-mix(in srgb, var(--bg-1) 50%, transparent);
```

- [ ] **步骤 2：在 `:root` / `.dark` 中也补上对应映射**

如果 `@theme inline` 之外的 `:root { }` 或 `.dark { }` 也定义了变量，在对应块末尾补上相同的 `--bg-*` / `--t-*` / `--fill-*` 映射，确保暗色模式下 token 也生效。

- [ ] **步骤 3：验证 token 生效**

启动 dev server，打开浏览器 DevTools → Elements → 在 `<html>` 上检查 `--bg-1` 等 CSS 变量是否定义。在 Console 执行：
```js
getComputedStyle(document.documentElement).getPropertyValue('--bg-3')
```
预期返回一个颜色值（非空字符串）。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/assets/main.css
git commit -m "feat(stage1): add AionUi-style semantic tokens to main.css"
```

---

## Stage 2：Chat 翔实增强（P0-2）

**目标：** 参考 AionUi 的 chat UI 风格，翔实增强 pi-agent 的 chat 部分——消息流视觉层级、工具调用卡片、输入区交互、流式状态、chat-workspace 布局。**不动 `resizable-splitter` 组件**（小说分栏已完善），chat 与 Preview 共存用 flex-basis 实现（切换 Preview 不卸载 chat DOM）。

**关键参考（AionUi，已用 codebase-memory-mcp 索引）：**
- 消息渲染：`packages/desktop/src/renderer/pages/conversation/Messages/components/MessageText.tsx`（hover-reveal copy + 时间戳行）
- 工具调用：`MessageToolCall.tsx` / `MessageToolGroupSummary.tsx`（`badge-breathing` 呼吸动画 + 结构化字段）
- 输入区：`components/chat/SendBox/index.tsx`（三套 overlay 互斥：slash / @file / btw）
- 代码块：`packages/desktop/src/renderer/components/Markdown/CodeBlock.tsx`（复制按钮 + 语言标签）

### 任务 2.1：code-block.tsx（带复制按钮的代码块）

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/code-block.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/message-bubble.tsx`（markdown `code` 渲染复用 CodeBlock）

- [ ] **步骤 1：编写 `code-block.tsx`**

```typescript
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

interface CodeBlockProps {
  language: string
  code: string
  /** 标题栏显示的文件名（可选） */
  filename?: string
}

export function CodeBlock({ language, code, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast({ title: '复制失败', variant: 'destructive' })
    }
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-[var(--border-1)] bg-[var(--bg-2)]">
      <div className="flex items-center justify-between border-b border-[var(--border-1)] bg-[var(--bg-3)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-[var(--t-secondary)]">{language}</span>
          {filename && <span className="text-[11px] text-[var(--t-tertiary)]">{filename}</span>}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--t-tertiary)] opacity-0 transition-opacity hover:bg-[var(--fill-2)] hover:text-[var(--t-primary)] group-hover:opacity-100"
          title="复制代码"
        >
          {copied ? <><Check className="h-3 w-3" /><span>已复制</span></> : <><Copy className="h-3 w-3" /><span>复制</span></>}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  )
}
```

- [ ] **步骤 2：在 `message-bubble.tsx` 的 markdown 渲染中复用 CodeBlock**

找到 `react-markdown` 的 `components` prop，替换 `code` 渲染：

```typescript
components={{
  code({ inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const code = String(children).replace(/\n$/, '')
    if (!inline && match) {
      return <CodeBlock language={match[1]} code={code} />
    }
    return <code className={className} {...props}>{children}</code>
  }
}}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/code-block.tsx apps/desktop/src/renderer/src/components/chat/message-bubble.tsx
git commit -m "feat(stage2): add CodeBlock with copy button, reuse in message-bubble"
```

### 任务 2.2：message-hover-toolbar.tsx + 改 message-bubble.tsx（hover 工具栏 + 圆角缺角）

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/message-hover-toolbar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/message-bubble.tsx`

**参考 AionUi：** `MessageText` 静态时干净，悬停给操作（copy / 时间戳行）。user 气泡圆角 `8px 0 8px 8px`（右上缺角）。

- [ ] **步骤 1：编写 `message-hover-toolbar.tsx`**

```typescript
import { Copy, RefreshCw, Reply } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

interface MessageHoverToolbarProps {
  messageId: string
  content: string
  onRetry?: (id: string) => void
  onQuote?: (id: string) => void
}

export function MessageHoverToolbar({ messageId, content, onRetry, onQuote }: MessageHoverToolbarProps) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      toast({ title: '已复制' })
    } catch {
      toast({ title: '复制失败', variant: 'destructive' })
    }
  }

  return (
    <div className="absolute -top-3 right-2 flex items-center gap-0.5 rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] p-0.5 opacity-0 shadow-md transition-opacity group-hover:opacity-100">
      <button onClick={handleCopy} className="rounded p-1 hover:bg-[var(--fill-2)]" title="复制">
        <Copy className="h-3 w-3 text-[var(--t-secondary)]" />
      </button>
      {onRetry && (
        <button onClick={() => onRetry(messageId)} className="rounded p-1 hover:bg-[var(--fill-2)]" title="重发">
          <RefreshCw className="h-3 w-3 text-[var(--t-secondary)]" />
        </button>
      )}
      {onQuote && (
        <button onClick={() => onQuote(messageId)} className="rounded p-1 hover:bg-[var(--fill-2)]" title="引用">
          <Reply className="h-3 w-3 text-[var(--t-secondary)]" />
        </button>
      )}
    </div>
  )
}
```

- [ ] **步骤 2：在 `message-bubble.tsx` 中接入 hover 工具栏 + user 圆角缺角**

找到 user 消息的渲染分支，包裹一层 `group` 并接入工具栏：

```typescript
// user 消息：圆角缺角对齐 AionUi（右上缺角）
<div className="group relative flex justify-end">
  <div className="max-w-[80%] rounded-lg bg-[var(--message-user-bg)] px-3 py-2 text-sm" style={{ borderRadius: '8px 0 8px 8px' }}>
    {/* ...existing content... */}
  </div>
  <MessageHoverToolbar messageId={msg.id} content={msg.content} onRetry={handleRetry} onQuote={handleQuote} />
</div>

// assistant 消息：无气泡背景，hover 出工具栏
<div className="group relative w-full">
  {/* ...existing markdown content... */}
  <MessageHoverToolbar messageId={msg.id} content={msg.content} />
</div>
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/message-hover-toolbar.tsx apps/desktop/src/renderer/src/components/chat/message-bubble.tsx
git commit -m "feat(stage2): add message hover toolbar + user bubble rounded corner"
```

### 任务 2.3：tool-call-field.tsx + 改 tool-call-card.tsx（结构化字段 + breathing 动画）

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/tool-call-field.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/tool-call-card.tsx`
- 修改：`apps/desktop/src/renderer/src/assets/main.css`（新增 `badge-breathing` 动画）

**参考 AionUi：** `MessageToolCall` 对 `replace/Edit` 工具走 diff 直渲；其他用 `Input/Output` 两段。`badge-breathing` 呼吸动画比 spinner 更轻量。

- [ ] **步骤 1：在 main.css 新增 `badge-breathing` 动画**

```css
/* === Stage 2: badge-breathing 呼吸动画（工具调用 running 态） === */
@keyframes badge-breathing {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.badge-breathing {
  animation: badge-breathing 1.6s ease-in-out infinite;
}
```

- [ ] **步骤 2：编写 `tool-call-field.tsx`（结构化字段渲染，替代裸 `<pre>`）**

```typescript
interface ToolCallFieldProps {
  label: 'Input' | 'Output'
  value: unknown
  /** 是否截断长文本 */
  maxLength?: number
}

export function ToolCallField({ label, value, maxLength = 500 }: ToolCallFieldProps) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const displayText = text.length > maxLength ? text.slice(0, maxLength) + '\n... (截断)' : text

  return (
    <div className="mt-1.5">
      <div className="mb-0.5 text-[10px] font-medium uppercase text-[var(--t-tertiary)]">{label}</div>
      <pre className="overflow-x-auto rounded bg-[var(--bg-2)] p-2 text-[11px] leading-relaxed text-[var(--t-secondary)]">
        <code>{displayText}</code>
      </pre>
    </div>
  )
}
```

- [ ] **步骤 3：改造 `tool-call-card.tsx`——用 ToolCallField 替代裸 `<pre>` + running 态加 breathing**

找到 `tool-call-card.tsx` 中参数和结果的渲染部分，替换为：

```typescript
// 状态 Badge：running 时加 badge-breathing
<Badge className={status === 'running' ? 'badge-breathing bg-[var(--fill-3)]' : ''}>
  {statusLabel}
</Badge>

// 参数 + 结果：用 ToolCallField 结构化渲染
<ToolCallField label="Input" value={args} />
{partialResult !== undefined && <ToolCallField label="Output" value={partialResult} />}
```

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/tool-call-field.tsx apps/desktop/src/renderer/src/components/chat/tool-call-card.tsx apps/desktop/src/renderer/src/assets/main.css
git commit -m "feat(stage2): structured tool-call fields + breathing animation"
```

### 任务 2.4：at-file-menu.tsx + 改 input-area.tsx（@文件 mention + overlay 互斥）

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/at-file-menu.tsx`
- 修改：`apps/desktop/src/renderer/src/components/chat/input-area.tsx`

**参考 AionUi：** `AtFileMenu` + `SendBox` 三套 overlay 互斥（slash / @file / btw），`isOverlayOpen` 统一管理。

- [ ] **步骤 1：编写 `at-file-menu.tsx`（@文件 mention 菜单）**

```typescript
import { useEffect, useState } from 'react'
import { FileText, Folder } from 'lucide-react'
import { getApi } from '@/api/http-client'

interface AtFileMenuProps {
  query: string
  onSelect: (item: { type: 'file' | 'session' | 'agent'; id: string; label: string }) => void
  onClose: () => void
}

export function AtFileMenu({ query, onSelect, onClose }: AtFileMenuProps) {
  const [items, setItems] = useState<Array<{ type: 'file' | 'session' | 'agent'; id: string; label: string }>>([])

  useEffect(() => {
    // 调用 /api/files/search 或复用现有 session/agent 查询
    const fetchItems = async () => {
      const [files, sessions] = await Promise.all([
        getApi<Array<{ id: string; name: string }>>('/files/search?q=' + encodeURIComponent(query)).catch(() => []),
        getApi<Array<{ id: string; title: string }>>('/sessions?q=' + encodeURIComponent(query)).catch(() => []),
      ])
      setItems([
        ...files.map(f => ({ type: 'file' as const, id: f.id, label: f.name })),
        ...sessions.map(s => ({ type: 'session' as const, id: s.id, label: s.title })),
      ])
    }
    if (query) fetchItems()
  }, [query])

  if (items.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 mb-1 max-h-60 w-64 overflow-auto rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] shadow-lg">
      {items.map((item) => (
        <button
          key={`${item.type}-${item.id}`}
          onClick={() => { onSelect(item); onClose() }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--fill-1)]"
        >
          {item.type === 'file' ? <FileText className="h-3 w-3 text-[var(--t-tertiary)]" /> : <Folder className="h-3 w-3 text-[var(--t-tertiary)]" />}
          <span className="truncate text-[var(--t-primary)]">{item.label}</span>
        </button>
      ))}
    </div>
  )
}
```

- [ ] **步骤 2：改造 `input-area.tsx`——overlay 互斥管理**

找到 `input-area.tsx` 中 slash command 和 mention 的触发逻辑，引入 `activeOverlay` 统一管理：

```typescript
type ActiveOverlay = 'slash' | 'at-file' | null
const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null)

// 输入 / 时开 slash，输入 @ 时开 at-file，互斥
const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
  const value = e.target.value
  // ...existing logic...
  if (value.endsWith('/') && activeOverlay !== 'slash') setActiveOverlay('slash')
  else if (value.endsWith('@') && activeOverlay !== 'at-file') setActiveOverlay('at-file')
  // 其他情况关闭 overlay
}

// 渲染时根据 activeOverlay 决定显示哪个面板
{activeOverlay === 'slash' && <SlashCommandPanel ... />}
{activeOverlay === 'at-file' && <AtFileMenu query={atQuery} onSelect={handleAtSelect} onClose={() => setActiveOverlay(null)} />}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/at-file-menu.tsx apps/desktop/src/renderer/src/components/chat/input-area.tsx
git commit -m "feat(stage2): add @file mention menu + overlay mutual exclusion"
```

### 任务 2.5：改 streaming-indicator.tsx（接入真实 step 状态）

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/chat/streaming-indicator.tsx`

**现状：** 硬编码"正在分析你的需求…"文案，未接入真实状态。**改造：** 从消息流的 tool call / thinking 事件提取真实 step，动态显示。

- [ ] **步骤 1：改造 streaming-indicator 接收 step prop**

```typescript
interface StreamingIndicatorProps {
  /** 当前执行的真实步骤（从 message-stream 的 applyEvent 提取） */
  step?: {
    type: 'thinking' | 'tool_call' | 'tool_result' | 'text'
    label: string
  }
}

export function StreamingIndicator({ step }: StreamingIndicatorProps) {
  const label = step?.label ?? '准备中...'
  const iconClass = step?.type === 'tool_call' ? 'badge-breathing' : 'animate-pulse'

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs text-[var(--t-tertiary)]">
      <span className={`h-1.5 w-1.5 rounded-full bg-[var(--color-primary)] ${iconClass}`} />
      <span>{label}</span>
    </div>
  )
}
```

- [ ] **步骤 2：在 `message-stream.tsx` 中提取当前 step 传给 StreamingIndicator**

找到 `message-stream.tsx` 中渲染 `StreamingIndicator` 的位置，从最新消息的 `toolCalls` / `thinking` 状态提取 step：

```typescript
const currentStep = useMemo(() => {
  const lastMsg = messages[messages.length - 1]
  if (!lastMsg) return undefined
  if (lastMsg.toolCalls?.some(tc => tc.status === 'running')) {
    const running = lastMsg.toolCalls.find(tc => tc.status === 'running')
    return { type: 'tool_call' as const, label: `调用工具: ${running?.name ?? ''}` }
  }
  if (lastMsg.thinking && !lastMsg.thinking.done) {
    return { type: 'thinking' as const, label: '思考中...' }
  }
  return { type: 'text' as const, label: '生成回复...' }
}, [messages])

<StreamingIndicator step={currentStep} />
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/streaming-indicator.tsx apps/desktop/src/renderer/src/components/chat/message-stream.tsx
git commit -m "feat(stage2): streaming indicator with real step status"
```

### 任务 2.6：改 chat-workspace.tsx（flex-basis 共存，不动 resizable-splitter）

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx`

**约束：** 不动 `resizable-splitter.tsx` 组件和 `use-resizable-split.ts` hook（小说分栏已完善）。chat 与 Preview 的共存用 CSS `flex-basis` 实现——切换 Preview 时调 flex-basis 不卸载 chat DOM，保留滚动位置与输入态。

**参考 AionUi：** `ChatLayout` 切换 Preview 时 chat 区只调 flex-basis 不卸载 DOM，避免子组件 remount 丢状态。

- [ ] **步骤 1：改造 chat-workspace 的 chat ↔ Preview 共存逻辑**

找到 `chat-workspace.tsx` 中 Preview 面板的渲染逻辑，从条件渲染改为 flex-basis 控制：

```typescript
// 旧：条件渲染（卸载 chat DOM）
// {showPreview ? <PreviewPanel /> : null}

// 新：flex-basis 共存（不卸载 chat DOM）
const [previewVisible, setPreviewVisible] = useState(false)

<div className="flex h-full overflow-hidden">
  {/* chat 主区：previewVisible 时 flex-basis 60%，否则 100% */}
  <div
    className="flex flex-col overflow-hidden transition-[flex-basis] duration-200"
    style={{ flexBasis: previewVisible ? '60%' : '100%' }}
  >
    {/* chat 内容保持挂载，不卸载 */}
    <MessageStream ... />
    <InputArea ... />
  </div>
  {/* Preview 面板：previewVisible 时 flex-basis 40%，否则 flex-basis 0 + overflow hidden（DOM 保留但不占空间） */}
  <div
    className="flex flex-col overflow-hidden border-l border-[var(--border-1)] transition-[flex-basis] duration-200"
    style={{ flexBasis: previewVisible ? '40%' : '0%' }}
  >
    {previewVisible && <FilePreviewPanel ... />}
  </div>
</div>
```

- [ ] **步骤 2：在 header 加 Preview 切换按钮**

```typescript
<Button variant="ghost" size="sm" onClick={() => setPreviewVisible(v => !v)} title="切换预览面板">
  <PanelRight className={`h-4 w-4 ${previewVisible ? 'text-[var(--color-primary)]' : 'text-[var(--t-tertiary)]'}`} />
</Button>
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx
git commit -m "feat(stage2): chat-workspace flex-basis coexistence (no resizable-splitter change)"
```

### 任务 2.7：Stage 2 验收清单

- [ ] markdown 代码块显示语言标签 + 复制按钮（hover 出现，点击后变"已复制"1.5s）
- [ ] user 消息气泡右上圆角缺角（`8px 0 8px 8px`），assistant 消息无气泡背景
- [ ] 消息 hover 时顶部出现工具栏（复制/重发/引用），离开后消失
- [ ] 工具调用卡片：running 态 Badge 有呼吸动画（`badge-breathing`），参数/结果用结构化 ToolCallField 渲染
- [ ] 输入 `@` 弹出文件/会话 mention 菜单，输入 `/` 弹出 slash 命令，二者互斥
- [ ] 流式时 StreamingIndicator 显示真实步骤（"调用工具: xxx" / "思考中..." / "生成回复..."）
- [ ] 切换 Preview 面板时 chat 区不卸载（滚动位置、输入内容保留）
- [ ] 新组件全部用 `--bg-*` / `--t-*` / `--fill-*` 语义 token，无硬编码颜色
- [ ] 不修改 `resizable-splitter.tsx` / `use-resizable-split.ts`
- [ ] 不修改 `components/novel/**` / `components/shared/conversation/**`
- [ ] `chat/error-card.tsx` 导出签名不变（novel 唯一耦合点）

---

## ~~Stage 1（已废弃）：主题引擎 + 字号控制~~

> **本 Stage 已废弃**（用户指示：主题切换功能不重要，需大量考核后再做）。字号控制移至 Stage 6。以下内容仅作存档参考，**不要执行**。

**目标：** 在已有语义 token 基础上，新增主题预设系统、CSS 自定义样式处理、字号控制。保留 `dark/light/system` 兼容入口。

**关键文件参考：**
- AionUi: `packages/desktop/src/renderer/utils/theme/applyTheme.ts`（53 行，可直接照搬）
- AionUi: `packages/desktop/src/renderer/utils/theme/systemAppearance.ts`（26 行，可直接照搬）
- AionUi: `packages/desktop/src/renderer/utils/theme/customCssProcessor.ts`（96 行，可直接照搬）
- AionUi: `packages/desktop/src/renderer/utils/theme/applyFontSizes.ts`（18 行）
- AionUi: `packages/desktop/src/renderer/hooks/ui/useFontSizes.ts`（89 行）
- AionUi: `packages/desktop/src/renderer/components/settings/FontSizeStepper.tsx`（72 行）

### 任务 1.1：主题工具函数（纯函数，TDD）

**文件：**
- 创建：`apps/desktop/src/renderer/src/utils/theme/custom-css-processor.ts`
- 创建：`apps/desktop/src/renderer/src/utils/theme/system-appearance.ts`
- 创建：`apps/desktop/src/renderer/src/utils/theme/apply-theme.ts`
- 测试：`apps/desktop/src/renderer/src/utils/theme/__tests__/custom-css-processor.test.ts`
- 测试：`apps/desktop/src/renderer/src/utils/theme/__tests__/apply-theme.test.ts`

- [ ] **步骤 1：编写 `custom-css-processor.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { addImportantToAll, wrapCustomCss, processCustomCss, validateCss } from '../custom-css-processor'

describe('custom-css-processor', () => {
  it('addImportantToAll 给每个声明加 !important', () => {
    expect(addImportantToAll(':root { --a: 1px; }')).toBe(':root { --a: 1px !important; }')
  })

  it('addImportantToAll 跳过已含 !important 的声明', () => {
    expect(addImportantToAll('a { color: red !important; }')).toBe('a { color: red !important; }')
  })

  it('wrapCustomCss 加注释头', () => {
    expect(wrapCustomCss('a{}')).toContain('用户自定义样式')
  })

  it('processCustomCss = wrap(addImportant())', () => {
    const result = processCustomCss('a { color: red; }')
    expect(result).toContain('!important')
    expect(result).toContain('用户自定义样式')
  })

  it('validateCss 检测大括号配对', () => {
    expect(validateCss('a { color: red; }').valid).toBe(true)
    expect(validateCss('a { color: red; ').valid).toBe(false)
  })

  it('validateCss 检测冒号存在', () => {
    expect(validateCss('a { nodcolonor }').valid).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter desktop test -- src/utils/theme/__tests__/custom-css-processor.test.ts
```
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 `custom-css-processor.ts`**

完整实现（参考 AionUi `customCssProcessor.ts` 96 行）：

```typescript
/**
 * 用户自定义 CSS 处理器
 * 1. addImportantToAll：给每个声明加 !important（已含则跳过）
 * 2. wrapCustomCss：加注释头
 * 3. processCustomCss = wrapCustomCss(addImportantToAll(css))
 * 4. validateCss：仅大括号配对 + 冒号存在检查（非真实 CSS 解析）
 */

export function addImportantToAll(css: string): string {
  return css.replace(/([a-zA-Z-]+)\s*:\s*([^;!}]+);/g, (match, prop, value) => {
    if (value.trim().endsWith('!important')) return match
    return `${prop}: ${value} !important;`
  })
}

export function wrapCustomCss(css: string): string {
  return `/* 用户自定义样式 - 由 pi-agent 注入 */\n${css}`
}

export function processCustomCss(css: string): string {
  return wrapCustomCss(addImportantToAll(css))
}

export function validateCss(css: string): { valid: boolean; error?: string } {
  if (!css.trim()) return { valid: true }
  const opens = (css.match(/{/g) || []).length
  const closes = (css.match(/}/g) || []).length
  if (opens !== closes) return { valid: false, error: `大括号不配对：${opens} 个 { vs ${closes} 个 }` }
  if (!/:\s*[^{}]+;?/g.test(css)) return { valid: false, error: '未检测到 CSS 声明（需要 property: value; 形式）' }
  return { valid: true }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm --filter desktop test -- src/utils/theme/__tests__/custom-css-processor.test.ts
```
预期：PASS

- [ ] **步骤 5：实现 `system-appearance.ts`**

```typescript
/**
 * 系统外观（深色/浅色）监听
 * 与 AionUi systemAppearance.ts 一致，纯 DOM API
 */

export function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches ?? false
}

export function watchSystemPrefersDark(onChange: (isDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => onChange(e.matches)
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
```

- [ ] **步骤 6：实现 `apply-theme.ts`**

```typescript
import type { Theme } from '@/types/theme'

/**
 * 把 token 对象转 CSS 字符串
 * 与 AionUi tokensToCss 一致
 */
function tokensToCss(tokens?: Record<string, string>): string | null {
  if (!tokens || Object.keys(tokens).length === 0) return null
  const body = Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  return `:root {\n${body}\n}`
}

function upsertStyle(id: string, content: string | null): void {
  if (typeof document === 'undefined') return
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!content) {
    if (el) el.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = content
}

/**
 * 应用主题
 * 1. 设置 html data-theme 属性
 * 2. 设置 body class（.dark / .light）— 与现有 main.css @custom-variant dark 兼容
 * 3. 写入 <style id="theme-tokens">（结构化 token）
 * 4. 写入 <style id="theme-decoration">（自定义 CSS）
 */
export function applyTheme(theme: Theme, root: Document = document): void {
  const appearance = theme.appearance === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme.appearance

  root.documentElement.setAttribute('data-theme', appearance)
  root.documentElement.classList.toggle('dark', appearance === 'dark')

  upsertStyle('theme-tokens', tokensToCss(theme.tokens))
  upsertStyle('theme-decoration', theme.css ? processCustomCss(theme.css) : null)
}
```

- [ ] **步骤 7：编写 `apply-theme.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { applyTheme } from '../apply-theme'
import type { Theme } from '@/types/theme'

describe('apply-theme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
    document.getElementById('theme-tokens')?.remove()
    document.getElementById('theme-decoration')?.remove()
  })

  it('dark 主题加 .dark class + data-theme=dark', () => {
    applyTheme({ id: 'test', name: 'Test', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0 })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('light 主题不加 .dark class', () => {
    applyTheme({ id: 'test', name: 'Test', appearance: 'light', builtin: true, created_at: 0, updated_at: 0 })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('tokens 写入 <style id="theme-tokens">', () => {
    applyTheme({
      id: 'test', name: 'Test', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0,
      tokens: { '--color-primary': '#ff0000' }
    })
    const el = document.getElementById('theme-tokens')
    expect(el?.textContent).toContain('--color-primary: #ff0000')
  })

  it('css 经 processCustomCss 处理后写入 theme-decoration', () => {
    applyTheme({
      id: 'test', name: 'Test', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0,
      css: 'a { color: red; }'
    })
    const el = document.getElementById('theme-decoration')
    expect(el?.textContent).toContain('!important')
    expect(el?.textContent).toContain('用户自定义样式')
  })

  it('css 为空时不创建 theme-decoration', () => {
    applyTheme({ id: 'test', name: 'Test', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0 })
    expect(document.getElementById('theme-decoration')).toBeNull()
  })
})
```

- [ ] **步骤 8：运行测试验证通过**

```bash
pnpm --filter desktop test -- src/utils/theme/__tests__/apply-theme.test.ts
```

- [ ] **步骤 9：Commit**

```bash
git add apps/desktop/src/renderer/src/utils/theme/ apps/desktop/src/renderer/src/types/theme.ts
git commit -m "feat(theme): add theme engine utilities (applyTheme/customCssProcessor/systemAppearance)"
```

### 任务 1.2：主题预设（4 套专业皮肤）

**文件：**
- 创建：`apps/desktop/src/renderer/src/utils/theme/builtin-themes.ts`
- 创建：`apps/desktop/src/renderer/src/utils/theme/presets/pro-dark.css`
- 创建：`apps/desktop/src/renderer/src/utils/theme/presets/pro-light.css`
- 创建：`apps/desktop/src/renderer/src/utils/theme/presets/focus-sepia.css`
- 创建：`apps/desktop/src/renderer/src/utils/theme/presets/cyber-neon.css`

- [ ] **步骤 1：编写 4 个 CSS 预设**

`pro-dark.css`（默认深色，与现有 main.css .dark 块对齐，仅微调 primary）：

```css
:root {
  --color-primary: #6a6fff;
  --color-primary-strong: #8e8eff;
  --color-app-bg: #0a0a0b;
  --color-app-bg-alt: #131316;
  --color-surface-1: #16161a;
  --color-surface-2: #1c1c22;
  --color-surface-3: #232329;
  --color-surface-4: #2a2a32;
}
```

`pro-light.css`：

```css
:root {
  --color-primary: #4b3fe3;
  --color-primary-strong: #3a2fc4;
  --color-app-bg: #ffffff;
  --color-app-bg-alt: #f8f8fa;
  --color-surface-1: #f3f3f5;
  --color-surface-2: #e9e9ec;
  --color-surface-3: #dcdce0;
  --color-surface-4: #cfcfd4;
}
```

`focus-sepia.css`（护眼专注，暖色调）：

```css
:root {
  --color-primary: #8b6f47;
  --color-primary-strong: #6b5535;
  --color-app-bg: #f5ecd9;
  --color-app-bg-alt: #efe4cb;
  --color-surface-1: #ebe0c0;
  --color-surface-2: #ddd0a8;
  --color-surface-3: #cdbf95;
  --color-surface-4: #b8a87c;
  --color-text: #3d2f1f;
  --color-text-secondary: #6b5535;
  --color-border-default: #b8a87c;
}
```

`cyber-neon.css`（极客炫酷，霓虹色）：

```css
:root {
  --color-primary: #00f0ff;
  --color-primary-strong: #00c8d6;
  --color-app-bg: #0d0014;
  --color-app-bg-alt: #160028;
  --color-surface-1: #1a0030;
  --color-surface-2: #240048;
  --color-surface-3: #2e0060;
  --color-surface-4: #380078;
  --color-text: #e0d4ff;
  --color-text-secondary: #a896d6;
  --color-border-default: #4a0096;
  --color-success: #00ff88;
  --color-danger: #ff3366;
  --color-warning: #ffaa00;
}
```

- [ ] **步骤 2：实现 `builtin-themes.ts`**

```typescript
import type { Theme } from '@/types/theme'
import proDarkCss from './presets/pro-dark.css?raw'
import proLightCss from './presets/pro-light.css?raw'
import focusSepiaCss from './presets/focus-sepia.css?raw'
import cyberNeonCss from './presets/cyber-neon.css?raw'

function decorative(
  id: string,
  name: string,
  appearance: Theme['appearance'],
  css: string
): Theme {
  return {
    id,
    name,
    appearance,
    css,
    builtin: true,
    created_at: 0,
    updated_at: 0,
  }
}

export const BUILTIN_THEMES: Theme[] = [
  decorative('pro-dark', '深色专业', 'dark', proDarkCss),
  decorative('pro-light', '浅色专业', 'light', proLightCss),
  decorative('focus-sepia', '护眼专注', 'light', focusSepiaCss),
  decorative('cyber-neon', '赛博霓虹', 'dark', cyberNeonCss),
]

export const DEFAULT_THEME_ID = 'pro-dark'

export function resolveActiveTheme(
  activeId: string | undefined,
  themes: Theme[],
  prefersDark: boolean
): Theme {
  if (!activeId || activeId === 'system') {
    // system 模式：根据 prefersDark 选 pro-dark / pro-light
    const id = prefersDark ? 'pro-dark' : 'pro-light'
    return themes.find(t => t.id === id) ?? BUILTIN_THEMES[0]
  }
  return themes.find(t => t.id === activeId) ?? BUILTIN_THEMES[0]
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/utils/theme/builtin-themes.ts apps/desktop/src/renderer/src/utils/theme/presets/
git commit -m "feat(theme): add 4 builtin theme presets (pro-dark/pro-light/focus-sepia/cyber-neon)"
```

### 任务 1.3：主题 Store + Provider 升级

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/theme-store.ts`
- 修改：`apps/desktop/src/renderer/src/components/theme-provider.tsx`
- 修改：`apps/desktop/src/renderer/src/stores/index.ts`

- [ ] **步骤 1：编写 `theme-store.ts`**

```typescript
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Theme, ThemeAppearance } from '@/types/theme'
import { BUILTIN_THEMES, DEFAULT_THEME_ID, resolveActiveTheme } from '@/utils/theme/builtin-themes'
import { applyTheme } from '@/utils/theme/apply-theme'
import { getSystemPrefersDark, watchSystemPrefersDark } from '@/utils/theme/system-appearance'

interface ThemeStoreState {
  activeThemeId: string | undefined                // undefined = system
  customThemes: Theme[]
  _unwatchSystem: (() => void) | null
  setActiveTheme: (id: string | undefined) => void
  addCustomTheme: (theme: Theme) => void
  removeCustomTheme: (id: string) => void
  applyCurrentTheme: () => void
  startWatchingSystem: () => void
  stopWatchingSystem: () => void
}

export const useThemeStore = create<ThemeStoreState>()(
  persist(
    (set, get) => ({
      activeThemeId: DEFAULT_THEME_ID,
      customThemes: [],
      _unwatchSystem: null,

      setActiveTheme: (id) => {
        set({ activeThemeId: id })
        get().applyCurrentTheme()
      },

      addCustomTheme: (theme) => {
        set(state => ({ customThemes: [...state.customThemes, theme] }))
        get().applyCurrentTheme()
      },

      removeCustomTheme: (id) => {
        set(state => ({ customThemes: state.customThemes.filter(t => t.id !== id) }))
      },

      applyCurrentTheme: () => {
        const { activeThemeId, customThemes } = get()
        const allThemes = [...BUILTIN_THEMES, ...customThemes]
        const theme = resolveActiveTheme(activeThemeId, allThemes, getSystemPrefersDark())
        applyTheme(theme)
      },

      startWatchingSystem: () => {
        const state = get()
        if (state._unwatchSystem) return
        const unwatch = watchSystemPrefersDark(() => {
          if (state.activeThemeId === undefined) get().applyCurrentTheme()
        })
        set({ _unwatchSystem: unwatch })
      },

      stopWatchingSystem: () => {
        const { _unwatchSystem } = get()
        if (_unwatchSystem) {
          _unwatchSystem()
          set({ _unwatchSystem: null })
        }
      },
    }),
    {
      name: 'wenlang-agent.theme-v2',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ activeThemeId: state.activeThemeId, customThemes: state.customThemes }),
    }
  )
)
```

- [ ] **步骤 2：升级 `theme-provider.tsx`**

替换现有的 79 行实现，但保留 `useTheme` 返回值兼容性（现有调用方仍可用 `theme: 'dark' | 'light' | 'system'`）：

```typescript
import { useEffect } from 'react'
import { useThemeStore } from '@/stores/theme-store'
import { BUILTIN_THEMES } from '@/utils/theme/builtin-themes'

interface ThemeProviderProps {
  children: React.ReactNode
  defaultTheme?: 'dark' | 'light' | 'system'
}

/**
 * 兼容旧 API：把 'dark' | 'light' | 'system' 映射到 theme store
 * - 'dark' → activeThemeId = 'pro-dark'
 * - 'light' → activeThemeId = 'pro-light'
 * - 'system' → activeThemeId = undefined
 */
const LEGACY_THEME_MAP: Record<'dark' | 'light' | 'system', string | undefined> = {
  dark: 'pro-dark',
  light: 'pro-light',
  system: undefined,
}

export function ThemeProvider({ children, defaultTheme = 'system' }: ThemeProviderProps) {
  const setActiveTheme = useThemeStore(s => s.setActiveTheme)
  const applyCurrentTheme = useThemeStore(s => s.applyCurrentTheme)
  const startWatchingSystem = useThemeStore(s => s.startWatchingSystem)
  const stopWatchingSystem = useThemeStore(s => s.stopWatchingSystem)
  const activeThemeId = useThemeStore(s => s.activeThemeId)

  // 首次挂载：迁移旧主题 + 应用 + 启动系统监听
  useEffect(() => {
    const stored = localStorage.getItem('wenlang-agent.theme') // 旧 key
    if (stored && !localStorage.getItem('wenlang-agent.theme-v2')) {
      const legacy = stored.replace(/^"|"$/g, '') as 'dark' | 'light' | 'system'
      setActiveTheme(LEGACY_THEME_MAP[legacy] ?? defaultTheme === 'system' ? undefined : LEGACY_THEME_MAP[defaultTheme])
    } else if (activeThemeId === undefined && !localStorage.getItem('wenlang-agent.theme-v2')) {
      setActiveTheme(LEGACY_THEME_MAP[defaultTheme])
    }
    applyCurrentTheme()
    startWatchingSystem()
    return () => stopWatchingSystem()
  }, [])

  return <>{children}</>
}

export function useTheme() {
  const activeThemeId = useThemeStore(s => s.activeThemeId)
  const setActiveTheme = useThemeStore(s => s.setActiveTheme)
  const customThemes = useThemeStore(s => s.customThemes)
  const allThemes = [...BUILTIN_THEMES, ...customThemes]
  const active = allThemes.find(t => t.id === activeThemeId)

  // 兼容旧 API
  const theme: 'dark' | 'light' | 'system' = activeThemeId === undefined
    ? 'system'
    : (active?.appearance ?? 'dark')

  return {
    theme,
    setTheme: (t: 'dark' | 'light' | 'system') => setActiveTheme(LEGACY_THEME_MAP[t]),
    // 新 API
    activeThemeId,
    activeTheme: active,
    allThemes,
    setActiveThemeId: setActiveTheme,
  }
}
```

- [ ] **步骤 3：更新 `stores/index.ts`**

```typescript
// 在现有导出末尾追加（不删现有导出）
export { useThemeStore } from './theme-store'
```

- [ ] **步骤 4：运行 typecheck**

```bash
pnpm --filter desktop typecheck:web
```
预期：无新增 error（注意 novel 不依赖 useTheme，但 chat-workspace 用了 useTheme 的 `theme: 'dark' | 'light' | 'system'` 字段，需保证兼容）

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/stores/theme-store.ts apps/desktop/src/renderer/src/components/theme-provider.tsx apps/desktop/src/renderer/src/stores/index.ts
git commit -m "feat(theme): upgrade ThemeProvider with multi-theme store (backward compatible)"
```

### 任务 1.4：字号控制

**文件：**
- 创建：`apps/desktop/src/renderer/src/hooks/ui/use-font-sizes.ts`
- 创建：`apps/desktop/src/renderer/src/components/settings/font-size-stepper.tsx`
- 修改：`apps/desktop/src/renderer/src/assets/main.css`（仅追加 `--font-size-*` 变量）

- [ ] **步骤 1：在 `main.css` 追加字号变量**

在文件末尾追加（不修改现有内容）：

```css
/* === Stage 1: Font size control === */
:root {
  --font-size-display: 32px;
  --font-size-heading: 20px;
  --font-size-body: 14px;
  --font-size-caption: 12px;
  --font-size-micro: 11px;
}
```

- [ ] **步骤 2：编写 `use-font-sizes.ts`**

```typescript
import { useEffect } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { FontSizes, FontSizeKey } from '@/types/theme'

const DEFAULTS: FontSizes = {
  display: 32,
  heading: 20,
  body: 14,
  caption: 12,
  micro: 11,
}

const MIN_PX = 10
const MAX_PX = 48
const STEP = 1

export function clampFontSize(px: number): number {
  return Math.max(MIN_PX, Math.min(MAX_PX, Math.round(px)))
}

interface FontSizeStoreState {
  sizes: FontSizes
  setFontSize: (key: FontSizeKey, px: number) => void
  resetFontSize: (key: FontSizeKey) => void
  resetAll: () => void
}

export const useFontSizeStore = create<FontSizeStoreState>()(
  persist(
    (set) => ({
      sizes: DEFAULTS,
      setFontSize: (key, px) => set(state => ({
        sizes: { ...state.sizes, [key]: clampFontSize(px) }
      })),
      resetFontSize: (key) => set(state => ({
        sizes: { ...state.sizes, [key]: DEFAULTS[key] }
      })),
      resetAll: () => set({ sizes: DEFAULTS }),
    }),
    {
      name: 'wenlang-agent.font-sizes',
      storage: createJSONStorage(() => localStorage),
    }
  )
)

export function applyFontSizes(sizes: FontSizes): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--font-size-display', `${sizes.display}px`)
  root.style.setProperty('--font-size-heading', `${sizes.heading}px`)
  root.style.setProperty('--font-size-body', `${sizes.body}px`)
  root.style.setProperty('--font-size-caption', `${sizes.caption}px`)
  root.style.setProperty('--font-size-micro', `${sizes.micro}px`)
}

export function useFontSizes() {
  const sizes = useFontSizeStore(s => s.sizes)
  const setFontSize = useFontSizeStore(s => s.setFontSize)
  const resetFontSize = useFontSizeStore(s => s.resetFontSize)
  const resetAll = useFontSizeStore(s => s.resetAll)

  useEffect(() => {
    applyFontSizes(sizes)
  }, [sizes])

  return {
    sizes,
    setFontSize: (key: FontSizeKey, px: number) => setFontSize(key, clampFontSize(px)),
    resetFontSize,
    resetAll,
    increment: (key: FontSizeKey) => setFontSize(key, sizes[key] + STEP),
    decrement: (key: FontSizeKey) => setFontSize(key, sizes[key] - STEP),
    range: { min: MIN_PX, max: MAX_PX, step: STEP },
  }
}
```

- [ ] **步骤 3：编写 `font-size-stepper.tsx`**

```typescript
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFontSizes } from '@/hooks/ui/use-font-sizes'
import type { FontSizeKey } from '@/types/theme'
import { useTranslation } from '@/i18n'

interface FontSizeStepperProps {
  fontKey: FontSizeKey
  label: string
}

export function FontSizeStepper({ fontKey, label }: FontSizeStepperProps) {
  const { sizes, increment, decrement, resetFontSize, range } = useFontSizes()
  const { t } = useTranslation()
  const value = sizes[fontKey]

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => decrement(fontKey)}
          disabled={value <= range.min}
          aria-label={t('common.decrease')}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span
          className="min-w-[3ch] text-center text-sm tabular-nums"
          aria-label={t('settings.fontSize.current', { value })}
        >
          {value}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => increment(fontKey)}
          disabled={value >= range.max}
          aria-label={t('common.increase')}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => resetFontSize(fontKey)}
          aria-label={t('common.reset')}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **步骤 4：新增 i18n 翻译键**

在 `zh-CN.json` 追加（不删现有 key）：

```json
{
  "settings": {
    "fontSize": {
      "current": "当前字号 {value}px",
      "display": "标题字号",
      "heading": "标题字号",
      "body": "正文字号",
      "caption": "说明字号",
      "micro": "微字号"
    },
    "appearance": {
      "title": "外观",
      "theme": "主题",
      "customCss": "自定义 CSS",
      "validateCss": "校验",
      "customTheme": "自定义主题",
      "presetThemes": "预设主题"
    }
  },
  "common": {
    "decrease": "减小",
    "increase": "增大",
    "reset": "重置"
  }
}
```

`en-US.json` 同步追加对应英文。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/ui/use-font-sizes.ts apps/desktop/src/renderer/src/components/settings/font-size-stepper.tsx apps/desktop/src/renderer/src/assets/main.css apps/desktop/src/renderer/src/i18n/locales/zh-CN.json apps/desktop/src/renderer/src/i18n/locales/en-US.json
git commit -m "feat(theme): add font size control (5-level with persistence)"
```

### 任务 1.5：外观设置页

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/settings/appearance-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/settings/settings-page.tsx`

- [ ] **步骤 1：编写 `appearance-page.tsx`**

完整组件结构：
1. 预设主题列表（4 套卡片，点击切换）
2. 字号控制（5 个 `FontSizeStepper`）
3. 自定义 CSS 编辑器（`<textarea>` + 校验按钮 + 应用按钮）

```typescript
import { useState } from 'react'
import { useThemeStore } from '@/stores/theme-store'
import { BUILTIN_THEMES } from '@/utils/theme/builtin-themes'
import { validateCss, processCustomCss } from '@/utils/theme/custom-css-processor'
import { FontSizeStepper } from './font-size-stepper'
import { useFontSizes } from '@/hooks/ui/use-font-sizes'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/i18n'
import type { FontSizeKey } from '@/types/theme'

export function AppearancePage() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { activeThemeId, setActiveTheme, customThemes, addCustomTheme } = useThemeStore()
  const { sizes } = useFontSizes()

  const [customCss, setCustomCss] = useState('')
  const [customName, setCustomName] = useState('')
  const [cssError, setCssError] = useState<string | null>(null)

  const allThemes = [...BUILTIN_THEMES, ...customThemes]

  const handleApplyCustomCss = () => {
    const validation = validateCss(customCss)
    if (!validation.valid) {
      setCssError(validation.error ?? 'CSS 无效')
      toast({ title: t('settings.appearance.validateCss'), description: validation.error, variant: 'destructive' })
      return
    }
    setCssError(null)
    addCustomTheme({
      id: `custom-${Date.now()}`,
      name: customName || `自定义 ${customThemes.length + 1}`,
      appearance: 'dark',
      css: customCss,
      builtin: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    toast({ title: t('common.saved') })
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-lg font-medium">{t('settings.appearance.presetThemes')}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {allThemes.map(theme => (
            <Card
              key={theme.id}
              className={`cursor-pointer p-3 transition hover:shadow-md ${activeThemeId === theme.id ? 'ring-2 ring-primary' : ''}`}
              onClick={() => setActiveTheme(theme.id)}
            >
              <div className="mb-2 h-16 rounded-md" style={{ background: `var(--color-app-bg, #fff)` }} />
              <p className="text-sm font-medium">{theme.name}</p>
              <p className="text-xs text-muted-foreground">{theme.appearance}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">{t('settings.fontSize.body')}</h2>
        <Card className="p-4">
          <FontSizeStepper fontKey="display" label={t('settings.fontSize.display')} />
          <FontSizeStepper fontKey="heading" label={t('settings.fontSize.heading')} />
          <FontSizeStepper fontKey="body" label={t('settings.fontSize.body')} />
          <FontSizeStepper fontKey="caption" label={t('settings.fontSize.caption')} />
          <FontSizeStepper fontKey="micro" label={t('settings.fontSize.micro')} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">{t('settings.appearance.customCss')}</h2>
        <Card className="p-4 space-y-3">
          <Input
            placeholder={t('settings.appearance.customTheme')}
            value={customName}
            onChange={e => setCustomName(e.target.value)}
          />
          <textarea
            className="w-full min-h-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            placeholder=":root { --color-primary: #ff0000; }"
            value={customCss}
            onChange={e => setCustomCss(e.target.value)}
          />
          {cssError && <p className="text-sm text-destructive">{cssError}</p>}
          <Button onClick={handleApplyCustomCss} disabled={!customCss.trim()}>
            {t('common.save')}
          </Button>
        </Card>
      </section>
    </div>
  )
}
```

- [ ] **步骤 2：在 `settings-page.tsx` 加 Appearance 入口**

在 `SettingsPage` 的 tab/section 列表中加新条目（不破坏现有）：

```typescript
import { AppearancePage } from './appearance-page'

// 在现有 tabs 数组中追加：
{ id: 'appearance', label: t('settings.appearance.title'), component: <AppearancePage /> }
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/appearance-page.tsx apps/desktop/src/renderer/src/components/settings/settings-page.tsx
git commit -m "feat(theme): add appearance settings page (presets + font sizes + custom CSS)"
```

### 任务 1.6：Stage 1 集成验证

- [ ] **步骤 1：运行 typecheck**

```bash
pnpm --filter desktop typecheck
```

- [ ] **步骤 2：运行全部测试**

```bash
pnpm --filter desktop test
```
预期：现有所有测试通过；新测试通过

- [ ] **步骤 3：手动启动 dev 验证**

```bash
pnpm dev:desktop
```
验证项：
- 设置 → 外观：4 套预设主题可切换，切换后立即生效
- 字号步进器加减重置可用
- 自定义 CSS：输入 `:root { --color-primary: #ff0000; }` 校验通过、应用生效
- 暗色/亮色切换不影响 novel 工作台

- [ ] **步骤 4：Commit + 标记 Stage 1 完成**

```bash
git tag stage-1-theme-engine
```

---

## Stage 2：三栏 ChatLayout + ResizableSplitter 升级（P0-4）

**目标：** 重构 `chat-workspace.tsx` 为三栏布局（Sider | Chat | Preview）；升级 `ResizableSplitter` 支持 storageKey 持久化 + 自定义事件；新增独立 `PreviewPanel` 多标签预览区。

**关键文件参考：**
- AionUi: `packages/desktop/src/renderer/hooks/ui/useResizableSplit.tsx`（280 行，可直接照搬核心逻辑）
- AionUi: `packages/desktop/src/renderer/pages/conversation/hooks/useWorkspaceCollapse.ts`（206 行）
- AionUi: `packages/desktop/src/renderer/pages/conversation/hooks/useLayoutConstraints.ts`（90 行）
- AionUi: `packages/desktop/src/renderer/pages/conversation/components/ChatLayout/MobileWorkspaceOverlay.tsx`（96 行）

**约束：** 不动 `novel-workspace.tsx`（它有自己的布局），只重构 chat-workspace。

### 任务 2.1：useResizableSplit hook（核心 hook，TDD）

**文件：**
- 创建：`apps/desktop/src/renderer/src/hooks/ui/use-resizable-split.ts`
- 测试：`apps/desktop/src/renderer/src/hooks/ui/__tests__/use-resizable-split.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResizableSplit } from '../use-resizable-split'

describe('useResizableSplit', () => {
  beforeEach(() => {
    localStorage.clear()
    window.dispatchEvent = vi.fn()
  })

  it('初始化使用 defaultWidth', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, unit: 'ratio' }))
    expect(result.current.splitRatio).toBe(50)
  })

  it('从 storageKey 恢复持久化值', () => {
    localStorage.setItem('test-split', '70')
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, storageKey: 'test-split', unit: 'ratio' }))
    expect(result.current.splitRatio).toBe(70)
  })

  it('setSplitRatio 更新值并持久化', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, storageKey: 'test-split', unit: 'ratio' }))
    act(() => result.current.setSplitRatio(80))
    expect(result.current.splitRatio).toBe(80)
    expect(localStorage.getItem('test-split')).toBe('80')
  })

  it('unit=px 时按像素工作', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 400, unit: 'px', storageKey: 'test-px' }))
    expect(result.current.splitRatio).toBe(400)
  })

  it('setSplitRatio 钳制在 [minWidth, maxWidth]', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, minWidth: 20, maxWidth: 80, unit: 'ratio' }))
    act(() => result.current.setSplitRatio(10))
    expect(result.current.splitRatio).toBe(20)
    act(() => result.current.setSplitRatio(100))
    expect(result.current.splitRatio).toBe(80)
  })

  it('返回 dragHandle React 元素', () => {
    const { result } = renderHook(() => useResizableSplit({ defaultWidth: 50, unit: 'ratio' }))
    expect(result.current.dragHandle).toBeDefined()
    expect(result.current.dragHandle.type).toBe('div')
  })
})
```

- [ ] **步骤 2：实现 `use-resizable-split.ts`**

```typescript
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { cn } from '@/lib/utils'

export interface UseResizableSplitOptions {
  defaultWidth?: number                  // ratio: 0-100；px: 像素
  minWidth?: number                       // 默认 0
  maxWidth?: number                       // 默认 Number.MAX_SAFE_INTEGER
  storageKey?: string                     // localStorage 持久化
  unit?: 'ratio' | 'px'                  // 默认 'ratio'
  onResize?: (ratio: number) => void     // 拖动时回调
}

export function useResizableSplit(options: UseResizableSplitOptions) {
  const {
    defaultWidth = 50,
    minWidth = 0,
    maxWidth = Number.MAX_SAFE_INTEGER,
    storageKey,
    unit = 'ratio',
    onResize,
  } = options

  const [splitRatio, setSplitRatioState] = useState<number>(() => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey)
      if (stored !== null) {
        const n = Number(stored)
        if (!Number.isNaN(n)) return Math.max(minWidth, Math.min(maxWidth, n))
      }
    }
    return defaultWidth
  })

  const draggingRef = useRef(false)
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const setSplitRatio = useCallback((next: number) => {
    const clamped = Math.max(minWidth, Math.min(maxWidth, next))
    setSplitRatioState(clamped)
    if (storageKey) localStorage.setItem(storageKey, String(clamped))
    onResizeRef.current?.(clamped)
    // 广播事件（AionUi 兼容）
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('preview-panel-resize', { detail: { ratio: clamped } }))
    }
  }, [minWidth, maxWidth, storageKey])

  // 拖动处理
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleMove = (e: PointerEvent) => {
      if (!draggingRef.current) return
      const parent = (dragHandleRef.current?.parentElement) as HTMLElement | null
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      if (unit === 'px') {
        const newWidth = rect.right - e.clientX
        setSplitRatio(newWidth)
      } else {
        const ratio = ((rect.right - e.clientX) / rect.width) * 100
        setSplitRatio(ratio)
      }
    }

    const handleUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    window.addEventListener('blur', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      window.removeEventListener('blur', handleUp)
    }
  }, [setSplitRatio, unit])

  const dragHandleRef = useRef<HTMLDivElement>(null)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    try {
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } catch {}
  }, [])

  const handleDoubleClick = useCallback(() => {
    setSplitRatio(defaultWidth)
  }, [defaultWidth, setSplitRatio])

  const dragHandle = (
    <div
      ref={dragHandleRef}
      data-slot="resize-handle"
      className={cn(
        'group relative flex w-1 cursor-col-resize items-center justify-center',
        'hover:bg-primary/30 transition-colors',
        draggingRef.current && 'bg-primary/50'
      )}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={splitRatio}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
    >
      <div className="h-8 w-0.5 rounded-full bg-border group-hover:bg-primary" />
    </div>
  ) as unknown as ReactElement

  return {
    splitRatio,
    setSplitRatio,
    dragHandle,
    dragHandleRef,
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

```bash
pnpm --filter desktop test -- src/hooks/ui/__tests__/use-resizable-split.test.ts
```

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/ui/use-resizable-split.ts apps/desktop/src/renderer/src/hooks/ui/__tests__/
git commit -m "feat(layout): add useResizableSplit hook with storageKey + event dispatch"
```

### 任务 2.2：useWorkspaceCollapse + useLayoutConstraints

**文件：**
- 创建：`apps/desktop/src/renderer/src/hooks/ui/use-workspace-collapse.ts`
- 创建：`apps/desktop/src/renderer/src/hooks/ui/use-layout-constraints.ts`

- [ ] **步骤 1：编写 `use-workspace-collapse.ts`**

```typescript
import { useCallback, useEffect, useState } from 'react'

const WORKSPACE_TOGGLE_EVENT = 'pi-workspace-toggle'
const WORKSPACE_HAS_FILES_EVENT = 'pi-workspace-has-files'

interface UseWorkspaceCollapseOptions {
  preferenceKey: string                  // 通常是 conversation_id 或 team_id
  isTemporaryWorkspace?: boolean
  defaultCollapsed?: boolean             // 默认 true
}

export function useWorkspaceCollapse(options: UseWorkspaceCollapseOptions) {
  const { preferenceKey, isTemporaryWorkspace = false, defaultCollapsed = true } = options
  const storageKey = `pi-workspace-preference-${preferenceKey}`
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem(storageKey)
    if (stored === 'expanded') return false
    if (stored === 'collapsed') return true
    return defaultCollapsed
  })

  const persist = useCallback((next: boolean) => {
    setCollapsed(next)
    localStorage.setItem(storageKey, next ? 'collapsed' : 'expanded')
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(WORKSPACE_TOGGLE_EVENT, { detail: { collapsed: next, preferenceKey } }))
    }
  }, [storageKey, preferenceKey])

  // 监听 hasFiles 事件：自动展开/折叠
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { hasFiles: boolean; isInitial: boolean }
      if (!detail) return
      // 临时工作区忽略初始种子，只在会话中触发
      if (isTemporaryWorkspace && detail.isInitial) return
      if (detail.hasFiles && collapsed) persist(false)
    }
    window.addEventListener(WORKSPACE_HAS_FILES_EVENT, handler)
    return () => window.removeEventListener(WORKSPACE_HAS_FILES_EVENT, handler)
  }, [collapsed, isTemporaryWorkspace, persist])

  const toggle = useCallback(() => persist(!collapsed), [collapsed, persist])

  return { collapsed, setCollapsed: persist, toggle }
}

// 工具函数：广播 hasFiles 事件
export function dispatchWorkspaceHasFiles(hasFiles: boolean, isInitial: boolean = false) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(WORKSPACE_HAS_FILES_EVENT, { detail: { hasFiles, isInitial } }))
}
```

- [ ] **步骤 2：编写 `use-layout-constraints.ts`**

```typescript
import { useEffect, useState } from 'react'

export const MIN_CHAT_PANEL_PX = 320
export const MIN_PREVIEW_PANEL_PX = 200
export const MIN_WORKSPACE_PANEL_PX = 240
export const MAX_WORKSPACE_PANEL_PX = 720

interface UseLayoutConstraintsOptions {
  containerRef: React.RefObject<HTMLElement>
  workspaceWidth: number                     // px
  onWorkspaceOverflow: () => void            // 触发自动折叠
  chatSplitRatio: number                     // 0-100
  onChatSplitClamp: (ratio: number) => void
}

export function useLayoutConstraints(options: UseLayoutConstraintsOptions) {
  const { containerRef, workspaceWidth, onWorkspaceOverflow, chatSplitRatio, onChatSplitClamp } = options
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [containerRef])

  useEffect(() => {
    if (containerWidth === 0) return
    // 1. workspace 超限自动收窄
    const maxAllowedWorkspace = containerWidth - MIN_CHAT_PANEL_PX - MIN_PREVIEW_PANEL_PX
    if (workspaceWidth > maxAllowedWorkspace) {
      onWorkspaceOverflow()
    }
    // 2. 强制折叠：当宽度不足以容纳三个最小宽度
    if (containerWidth < MIN_CHAT_PANEL_PX + MIN_PREVIEW_PANEL_PX + MIN_WORKSPACE_PANEL_PX) {
      onWorkspaceOverflow()
    }
    // 3. chat split ratio 钳制
    const minRatio = (MIN_CHAT_PANEL_PX / containerWidth) * 100
    const maxRatio = 100 - (MIN_PREVIEW_PANEL_PX / containerWidth) * 100
    if (chatSplitRatio < minRatio) onChatSplitClamp(minRatio)
    else if (chatSplitRatio > maxRatio) onChatSplitClamp(maxRatio)
  }, [containerWidth, workspaceWidth, chatSplitRatio, onWorkspaceOverflow, onChatSplitClamp])

  return { containerWidth }
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/ui/use-workspace-collapse.ts apps/desktop/src/renderer/src/hooks/ui/use-layout-constraints.ts
git commit -m "feat(layout): add useWorkspaceCollapse + useLayoutConstraints hooks"
```

### 任务 2.3：ResizableSplitter 升级（保持向后兼容）

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/ui/resizable-splitter.tsx`

- [ ] **步骤 1：在现有组件基础上添加 storageKey + 事件支持**

```typescript
import { useResizableSplit } from '@/hooks/ui/use-resizable-split'
import { cn } from '@/lib/utils'

interface ResizableSplitterProps {
  direction: 'horizontal' | 'vertical'
  size: number
  minSize?: number
  maxSize?: number
  onSizeChange: (size: number) => void
  collapsed?: boolean
  side?: 'left' | 'right' | 'top' | 'bottom'
  className?: string
  // 新增：可选 storageKey + unit
  storageKey?: string
  unit?: 'ratio' | 'px'
}

export function ResizableSplitter(props: ResizableSplitterProps) {
  const { direction, size, minSize = 200, maxSize = 600, onSizeChange, collapsed = false, side = 'right', className, storageKey, unit = 'px' } = props

  // 如果传 storageKey，启用 useResizableSplit（自动持久化 + 事件）
  // 否则保留原有逻辑（向后兼容 chat-workspace.tsx 现有调用）
  const split = useResizableSplit({
    defaultWidth: size,
    minWidth: minSize,
    maxWidth: maxSize,
    storageKey,
    unit,
    onResize: onSizeChange,
  })

  // 使用 split.dragHandle 渲染（替换原 mousemove 监听逻辑）
  // 当 storageKey 未传时，仍通过 split.onResize 同步给调用方 state
  // 完整实现略（保留原 ResizableSplitter 的 visual shell，仅替换拖动逻辑核心）
  return (
    <div
      className={cn('group relative flex items-center justify-center', className)}
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      data-slot="resizable-splitter"
      data-collapsed={collapsed}
      data-side={side}
    >
      {split.dragHandle}
    </div>
  )
}
```

> 注意：原 112 行实现的 `document.addEventListener('mousemove', ...)` 逻辑被 `useResizableSplit` 内部接管。`onSizeChange` 在 storageKey 模式下不再需要调用方持久化（hook 内部已持久化），但仍会触发以保持调用方 state 同步。

- [ ] **步骤 2：运行 typecheck**

```bash
pnpm --filter desktop typecheck:web
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/components/ui/resizable-splitter.tsx
git commit -m "feat(layout): upgrade ResizableSplitter with storageKey + event dispatch (backward compatible)"
```

### 任务 2.4：PreviewPanel 多标签预览区

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/preview-panel/preview-panel.tsx`
- 创建：`apps/desktop/src/renderer/src/components/chat/preview-panel/preview-tabs.tsx`
- 创建：`apps/desktop/src/renderer/src/components/chat/preview-panel/viewers/markdown-viewer.tsx`
- 创建：`apps/desktop/src/renderer/src/components/chat/preview-panel/viewers/code-viewer.tsx`
- 创建：`apps/desktop/src/renderer/src/components/chat/preview-panel/viewers/image-viewer.tsx`
- 创建：`apps/desktop/src/renderer/src/components/chat/preview-panel/viewers/url-viewer.tsx`

- [ ] **步骤 1：定义 PreviewTab 类型 + PreviewPanel 组件**

```typescript
// preview-panel.tsx
import { useState, useCallback } from 'react'
import { X } from 'lucide-react'
import { PreviewTabs } from './preview-tabs'
import { MarkdownViewer } from './viewers/markdown-viewer'
import { CodeViewer } from './viewers/code-viewer'
import { ImageViewer } from './viewers/image-viewer'
import { UrlViewer } from './viewers/url-viewer'
import { Button } from '@/components/ui/button'

export type PreviewContentType = 'markdown' | 'code' | 'image' | 'url'

export interface PreviewTab {
  id: string
  title: string
  contentType: PreviewContentType
  data: string                       // markdown 文本 / code 文本 / image dataURL / URL
  language?: string                  // code 时
  closable?: boolean                 // 默认 true
}

export interface PreviewPanelProps {
  tabs: PreviewTab[]
  activeTabId?: string
  onTabClose?: (id: string) => void
  onTabActivate?: (id: string) => void
  emptyHint?: string
}

export function PreviewPanel(props: PreviewPanelProps) {
  const { tabs, activeTabId, onTabClose, onTabActivate, emptyHint = '无预览内容' } = props
  const [internalActive, setInternalActive] = useState<string | undefined>(activeTabId ?? tabs[0]?.id)

  const activeId = activeTabId ?? internalActive ?? tabs[0]?.id
  const activeTab = tabs.find(t => t.id === activeId)

  const handleActivate = useCallback((id: string) => {
    setInternalActive(id)
    onTabActivate?.(id)
  }, [onTabActivate])

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {emptyHint}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PreviewTabs
        tabs={tabs}
        activeId={activeId!}
        onActivate={handleActivate}
        onClose={onTabClose}
      />
      <div className="flex-1 overflow-auto">
        {!activeTab && <div className="p-4 text-sm text-muted-foreground">{emptyHint}</div>}
        {activeTab && activeTab.contentType === 'markdown' && <MarkdownViewer content={activeTab.data} />}
        {activeTab && activeTab.contentType === 'code' && <CodeViewer code={activeTab.data} language={activeTab.language} />}
        {activeTab && activeTab.contentType === 'image' && <ImageViewer src={activeTab.data} />}
        {activeTab && activeTab.contentType === 'url' && <UrlViewer url={activeTab.data} />}
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：实现 4 个 viewer（精简版，复用现有 react-markdown / 代码渲染）**

`markdown-viewer.tsx`：
```typescript
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

export function MarkdownViewer({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none p-4', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
```

`code-viewer.tsx`：
```typescript
import { cn } from '@/lib/utils'

export function CodeViewer({ code, language, className }: { code: string; language?: string; className?: string }) {
  return (
    <pre className={cn('p-4 text-xs overflow-auto', className)}>
      <code className={`language-${language ?? 'text'}`}>{code}</code>
    </pre>
  )
}
```

`image-viewer.tsx`：
```typescript
export function ImageViewer({ src, alt }: { src: string; alt?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <img src={src} alt={alt ?? 'preview'} className="max-h-full max-w-full object-contain" />
    </div>
  )
}
```

`url-viewer.tsx`：
```typescript
export function UrlViewer({ url }: { url: string }) {
  return (
    <iframe src={url} className="h-full w-full border-0" sandbox="allow-same-origin allow-scripts" />
  )
}
```

- [ ] **步骤 3：实现 PreviewTabs（基础 tab 栏）**

```typescript
// preview-tabs.tsx
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PreviewTab } from './preview-panel'

interface PreviewTabsProps {
  tabs: PreviewTab[]
  activeId: string
  onActivate: (id: string) => void
  onClose?: (id: string) => void
}

export function PreviewTabs({ tabs, activeId, onActivate, onClose }: PreviewTabsProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-surface-1 px-2 py-1 overflow-x-auto">
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={cn(
            'group flex items-center gap-1 rounded-md px-2 py-1 text-xs cursor-pointer',
            tab.id === activeId ? 'bg-surface-3 text-foreground' : 'text-muted-foreground hover:bg-surface-2'
          )}
          onClick={() => onActivate(tab.id)}
        >
          <span className="truncate max-w-[120px]">{tab.title}</span>
          {tab.closable !== false && onClose && (
            <button
              className="opacity-0 group-hover:opacity-100 hover:text-destructive"
              onClick={e => { e.stopPropagation(); onClose(tab.id) }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/preview-panel/
git commit -m "feat(layout): add PreviewPanel with multi-tab support (markdown/code/image/url viewers)"
```

### 任务 2.5：重构 chat-workspace.tsx 为三栏布局

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx`
- 创建：`apps/desktop/src/renderer/src/components/layout/titlebar/index.tsx`

- [ ] **步骤 1：编写 `titlebar/index.tsx`**

```typescript
import { PanelRightClose, PanelRightOpen, Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/ui-store'
import { useToast } from '@/hooks/use-toast'

interface TitlebarProps {
  title?: string
  onWorkspaceToggle?: () => void
  workspaceCollapsed?: boolean
  rightExtra?: React.ReactNode
}

export function Titlebar({ title, onWorkspaceToggle, workspaceCollapsed, rightExtra }: TitlebarProps) {
  return (
    <header className="flex h-10 items-center justify-between border-b border-border bg-titlebar-bg px-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-1">
        {rightExtra}
        {onWorkspaceToggle && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onWorkspaceToggle}>
            {workspaceCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
          </Button>
        )}
      </div>
    </header>
  )
}
```

- [ ] **步骤 2：重构 `chat-workspace.tsx`（保留所有现有功能，仅改布局结构）**

关键改动：
1. 把现有 `FilePreviewPanel` 升级为 `PreviewPanel`（多标签）
2. 使用 `useResizableSplit`（带 storageKey）替代现有 `useState(260)` / `useState(320)`
3. 使用 `useWorkspaceCollapse` 控制右侧 Preview 折叠
4. 加 `Titlebar`（含 workspace 开关按钮）
5. 添加 `useLayoutConstraints` 自动折叠逻辑

> **重要**：不要删现有 `<ContextPanel>` / `<FilePreviewPanel>` 渲染逻辑，而是包装在新 `PreviewPanel` 内或并存。先保留向后兼容入口，新 `PreviewPanel` 作为可选增强（通过 feature flag 或视图切换）。

实际重构思路（不破坏现有调用）：
- 现有 `useState(260)` for siderWidth → 替换为 `useResizableSplit({ defaultWidth: 260, storageKey: 'pi-chat-sider-width', unit: 'px' })`
- 现有 `useState(320)` for contextWidth → 替换为 `useResizableSplit({ defaultWidth: 320, storageKey: 'pi-chat-context-width', unit: 'px' })`
- 现有 `<ResizableSplitter size={...} onSizeChange={...} />` → 改为 `split.dragHandle`
- 现有 `<FilePreviewPanel>` → 包装在 `<PreviewPanel>` 内（创建 1 个 tab：`{ id: 'file-preview', title: '文件', contentType: 'url', data: ... }` 或保留原组件直接渲染）

最小破坏性改动：保持现有结构骨架，仅替换 splitter + 加 Titlebar header。PreviewPanel 在 P1 阶段完整接入（P0 仅引入组件 + 持久化 + 事件）。

- [ ] **步骤 3：运行 typecheck + test**

```bash
pnpm --filter desktop typecheck
pnpm --filter desktop test
```

- [ ] **步骤 4：手动验证**

```bash
pnpm dev:desktop
```
验证项：
- 拖动 sider 分割线，刷新后宽度保持
- 拖动 context 分割线，刷新后宽度保持
- Titlebar 工作区开关按钮可用
- novel 工作台不受影响

- [ ] **步骤 5：Commit + 标记 Stage 2 完成**

```bash
git add apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx apps/desktop/src/renderer/src/components/layout/titlebar/
git commit -m "refactor(chat): upgrade chat-workspace to three-column layout with persisted splitters + Titlebar"
git tag stage-2-chat-layout
```

---

## Stage 3：多 Runtime 选择器（P0-3）

**目标：** 引入 `AgentRuntime` 概念（前端类型层），升级 `model-selector.tsx` 为二级菜单，新增 `runtime-selector-pill.tsx` 显示当前 runtime。

**关键文件参考：**
- AionUi: `packages/desktop/src/renderer/components/agent/RuntimeSelectorPill.tsx`（69 行）
- AionUi: `packages/desktop/src/renderer/components/agent/runtimeSelectorOptions.tsx`（173 行）

**约束：** pi-agent 后端无 runtime 抽象，P0 仅在前端建立 runtime 概念，对应到现有后端 API：
- `chat-api` runtime → 现有 chat 模式（`/ag-ui/agent/default`）+ `provider-config-store` 模型
- `team` runtime → `/api/teams/:id/execute` + `/api/agents` 列表
- `agent-plugin` runtime → `/api/agents` 列表（含 novel-plugin 注册的 director/writer 等）

### 任务 3.1：Runtime 类型 + Registry

**文件：**
- 创建：`apps/desktop/src/renderer/src/types/runtime.ts`（已在共享类型中定义）
- 创建：`apps/desktop/src/renderer/src/utils/agent/runtime-types.ts`
- 创建：`apps/desktop/src/renderer/src/utils/agent/runtime-registry.ts`
- 创建：`apps/desktop/src/renderer/src/stores/runtime-store.ts`

- [ ] **步骤 1：编写 `runtime-types.ts`**

```typescript
import type { AgentRuntime, AgentRuntimeType, RuntimeModel, RuntimeModelGroup } from '@/types/runtime'

export const RUNTIME_LABELS: Record<AgentRuntimeType, { label: string; icon: string; description: string }> = {
  'chat-api': { label: 'API 模型', icon: 'Cloud', description: 'OpenAI / Anthropic / Gemini 等 API 直连' },
  'team': { label: 'Team 协作', icon: 'Users', description: '多 Agent 并行 / 流水线 / 协调执行' },
  'agent-plugin': { label: '插件 Agent', icon: 'Bot', description: 'novel-plugin 等注册的 Agent' },
}

export function describeRuntime(type: AgentRuntimeType): { label: string; icon: string; description: string } {
  return RUNTIME_LABELS[type]
}
```

- [ ] **步骤 2：编写 `runtime-registry.ts`**

```typescript
import { getApi } from '@/api/http-client'
import type { AgentRuntime, AgentRuntimeType, RuntimeModel, RuntimeModelGroup } from '@/types/runtime'

// 后端 Agent 类型（从 /api/agents 获取）
interface BackendAgent {
  id: string
  name: string
  type?: string                  // 'novel-director' / 'novel-writer' 等
  description?: string
}

interface BackendProvider {
  id: string
  name: string
  models: Array<{ id: string; name?: string; contextWindow?: number }>
}

export const chatApiRuntime: AgentRuntime = {
  type: 'chat-api',
  label: 'API 模型',
  icon: 'Cloud',
  description: 'OpenAI / Anthropic / Gemini 等 API 直连',
  async listModels(): Promise<RuntimeModelGroup[]> {
    const providers = await getApi<BackendProvider[]>('/providers')
    return providers.map(p => ({
      key: p.id,
      title: p.name,
      models: p.models.map(m => ({ id: `${p.id}:${m.id}`, label: m.name ?? m.id, description: m.contextWindow ? `${m.contextWindow} tokens` : undefined })),
    }))
  },
}

export const teamRuntime: AgentRuntime = {
  type: 'team',
  label: 'Team 协作',
  icon: 'Users',
  description: '多 Agent 并行 / 流水线 / 协调执行',
  async listModels(): Promise<RuntimeModel[]> {
    const teams = await getApi<Array<{ id: string; name: string; description?: string }>>('/teams')
    return teams.map(t => ({ id: t.id, label: t.name, description: t.description }))
  },
}

export const agentPluginRuntime: AgentRuntime = {
  type: 'agent-plugin',
  label: '插件 Agent',
  icon: 'Bot',
  description: 'novel-plugin 等注册的 Agent',
  async listModels(): Promise<RuntimeModel[]> {
    const agents = await getApi<BackendAgent[]>('/agents')
    return agents.map(a => ({ id: a.id, label: a.name, description: a.description ?? a.type }))
  },
}

export const ALL_RUNTIMES: AgentRuntime[] = [chatApiRuntime, teamRuntime, agentPluginRuntime]

export function getRuntime(type: AgentRuntimeType): AgentRuntime | undefined {
  return ALL_RUNTIMES.find(r => r.type === type)
}
```

- [ ] **步骤 3：编写 `runtime-store.ts`**

```typescript
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AgentRuntimeType, RuntimeSelection } from '@/types/runtime'

interface RuntimeStoreState extends RuntimeSelection {
  setRuntime: (type: AgentRuntimeType) => void
  setModel: (modelId: string) => void
  setTeam: (teamId: string) => void
  reset: () => void
}

export const useRuntimeStore = create<RuntimeStoreState>()(
  persist(
    (set) => ({
      runtime: 'chat-api',
      modelId: undefined,
      teamId: undefined,
      setRuntime: (type) => set({ runtime: type, modelId: undefined, teamId: undefined }),
      setModel: (modelId) => set({ modelId }),
      setTeam: (teamId) => set({ teamId }),
      reset: () => set({ runtime: 'chat-api', modelId: undefined, teamId: undefined }),
    }),
    {
      name: 'wenlang-agent.runtime-selection',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
```

- [ ] **步骤 4：更新 `stores/index.ts`**

```typescript
export { useRuntimeStore } from './runtime-store'
```

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/types/runtime.ts apps/desktop/src/renderer/src/utils/agent/ apps/desktop/src/renderer/src/stores/runtime-store.ts apps/desktop/src/renderer/src/stores/index.ts
git commit -m "feat(runtime): add AgentRuntime type system + registry + Zustand store"
```

### 任务 3.2：RuntimeSelectorPill 组件

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/runtime-selector-pill.tsx`
- 创建：`apps/desktop/src/renderer/src/components/chat/runtime-selector-menu.tsx`

- [ ] **步骤 1：添加 shadcn `dropdown-menu` 组件**

```bash
cd apps/desktop && npx shadcn@latest add dropdown-menu
```
（这会在 `components/ui/dropdown-menu.tsx` 生成）

- [ ] **步骤 2：编写 `runtime-selector-pill.tsx`**

```typescript
import { ChevronDown, Cloud, Users, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useRuntimeStore } from '@/stores/runtime-store'
import { ALL_RUNTIMES } from '@/utils/agent/runtime-registry'
import { RUNTIME_LABELS } from '@/utils/agent/runtime-types'
import type { AgentRuntimeType } from '@/types/runtime'

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Cloud, Users, Bot,
}

interface RuntimeSelectorPillProps {
  compact?: boolean
  className?: string
}

export function RuntimeSelectorPill({ compact = false, className }: RuntimeSelectorPillProps) {
  const { runtime, setRuntime } = useRuntimeStore()
  const meta = RUNTIME_LABELS[runtime]
  const Icon = ICONS[meta.icon] ?? Cloud

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={`h-7 gap-1 rounded-full px-2 text-xs ${className ?? ''}`}>
          <Icon className="h-3.5 w-3.5" />
          {!compact && <span className="truncate max-w-[100px]">{meta.label}</span>}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Runtime</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALL_RUNTIMES.map(r => {
          const Icon = ICONS[r.icon] ?? Cloud
          return (
            <DropdownMenuItem
              key={r.type}
              onClick={() => setRuntime(r.type as AgentRuntimeType)}
              className={runtime === r.type ? 'bg-accent' : ''}
            >
              <Icon className="h-4 w-4 mr-2" />
              <div className="flex flex-col">
                <span className="text-sm">{r.label}</span>
                <span className="text-xs text-muted-foreground">{r.description}</span>
              </div>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

- [ ] **步骤 3：编写 `runtime-selector-menu.tsx`（二级菜单：runtime → model/agent）**

```typescript
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useRuntimeStore } from '@/stores/runtime-store'
import { getRuntime } from '@/utils/agent/runtime-registry'
import type { RuntimeModel, RuntimeModelGroup } from '@/types/runtime'

interface RuntimeSelectorMenuProps {
  className?: string
}

export function RuntimeSelectorMenu({ className }: RuntimeSelectorMenuProps) {
  const { runtime, modelId, teamId, setModel, setTeam } = useRuntimeStore()
  const [groups, setGroups] = useState<RuntimeModel[] | RuntimeModelGroup[]>([])

  useEffect(() => {
    const rt = getRuntime(runtime)
    if (!rt) return
    rt.listModels().then(setGroups).catch(() => setGroups([]))
  }, [runtime])

  const isGrouped = (g: typeof groups): g is RuntimeModelGroup[] => Array.isArray(g) && g.length > 0 && 'models' in g[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={`gap-1 text-xs ${className ?? ''}`}>
          <span className="truncate max-w-[160px]">{getCurrentLabel(runtime, modelId, teamId, groups)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>选择 {runtime === 'team' ? 'Team' : '模型 / Agent'}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {runtime === 'team' && (
          <div className="max-h-64 overflow-auto">
            {(groups as RuntimeModel[]).map(m => (
              <DropdownMenuItem key={m.id} onClick={() => setTeam(m.id)}>
                {teamId === m.id && <Check className="h-4 w-4 mr-2" />}
                <div className="flex flex-col">
                  <span className="text-sm">{m.label ?? m.id}</span>
                  {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
                </div>
              </DropdownMenuItem>
            ))}
          </div>
        )}
        {runtime !== 'team' && isGrouped(groups) && (
          <div className="max-h-64 overflow-auto">
            {groups.map(g => (
              <DropdownMenuSub key={g.key}>
                <DropdownMenuSubTrigger>{g.title}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  {g.models.map(m => (
                    <DropdownMenuItem key={m.id} onClick={() => setModel(m.id)}>
                      {modelId === m.id && <Check className="h-4 w-4 mr-2" />}
                      <div className="flex flex-col">
                        <span className="text-sm">{m.label ?? m.id}</span>
                        {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </div>
        )}
        {runtime !== 'team' && !isGrouped(groups) && (
          <div className="max-h-64 overflow-auto">
            {(groups as RuntimeModel[]).map(m => (
              <DropdownMenuItem key={m.id} onClick={() => setModel(m.id)}>
                {modelId === m.id && <Check className="h-4 w-4 mr-2" />}
                <span className="text-sm">{m.label ?? m.id}</span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function getCurrentLabel(
  runtime: string,
  modelId: string | undefined,
  teamId: string | undefined,
  groups: RuntimeModel[] | RuntimeModelGroup[]
): string {
  if (runtime === 'team') {
    const list = groups as RuntimeModel[]
    return list.find(m => m.id === teamId)?.label ?? '选择 Team'
  }
  const flat = Array.isArray(groups) && groups.length > 0 && 'models' in groups[0]
    ? (groups as RuntimeModelGroup[]).flatMap(g => g.models)
    : (groups as RuntimeModel[])
  return flat.find(m => m.id === modelId)?.label ?? '选择模型'
}
```

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/ui/dropdown-menu.tsx apps/desktop/src/renderer/src/components/chat/runtime-selector-pill.tsx apps/desktop/src/renderer/src/components/chat/runtime-selector-menu.tsx
git commit -m "feat(runtime): add RuntimeSelectorPill + RuntimeSelectorMenu (二级菜单)"
```

### 任务 3.3：升级 model-selector.tsx 集成 Runtime

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/chat/model-selector.tsx`

- [ ] **步骤 1：在现有 ModelSelector 上叠加 Runtime 入口**

保留现有 `ModelSelector` 的 props（向后兼容），在内部组合 `RuntimeSelectorPill` + `RuntimeSelectorMenu`：

```typescript
// 在现有 ModelSelector 顶部加 Runtime 入口
import { RuntimeSelectorPill } from './runtime-selector-pill'
import { RuntimeSelectorMenu } from './runtime-selector-menu'
import { useRuntimeStore } from '@/stores/runtime-store'

export function ModelSelector(props: ModelSelectorProps) {
  const { runtime } = useRuntimeStore()

  // 当 runtime = 'chat-api' 时，保留原有 Provider 模型选择行为
  // 当 runtime = 'team' / 'agent-plugin' 时，使用 RuntimeSelectorMenu
  if (runtime === 'chat-api') {
    return (
      <div className="flex items-center gap-1">
        <RuntimeSelectorPill compact />
        {/* 原有 Select 实现 */}
        <OriginalModelSelector {...props} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <RuntimeSelectorPill compact />
      <RuntimeSelectorMenu />
    </div>
  )
}

// 把原 ModelSelector 实现重命名为 OriginalModelSelector
// （内部代码不变，仅改名）
```

- [ ] **步骤 2：运行 typecheck + 手动验证**

```bash
pnpm --filter desktop typecheck
pnpm dev:desktop
```

验证项：
- 默认 runtime = 'chat-api'，显示药丸 + 原 Provider 选择器
- 切换到 'team'，显示药丸 + Team 二级菜单
- 切换到 'agent-plugin'，显示药丸 + Agent 列表

- [ ] **步骤 3：Commit + 标记 Stage 3 完成**

```bash
git add apps/desktop/src/renderer/src/components/chat/model-selector.tsx
git commit -m "feat(runtime): upgrade ModelSelector to integrate Runtime selector (backward compatible)"
git tag stage-3-runtime-selector
```

---

## Stage 4：MessageToolGroup + Gate 内联面板（P0-2）

**目标：** 把连续的 `ToolCallCard` 聚合为可折叠组；把 `ConfirmationDialog` 从 Modal 弹窗改为消息流内联面板；后端 Confirmation API 扩展支持 `revise` / `rewrite` 决策（用户已确认后端改动 B）。

**关键文件参考：**
- AionUi: `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageToolGroup.tsx`（602 行，复杂度高，简化版）
- AionUi: `packages/desktop/src/renderer/pages/conversation/Messages/components/MessagePermission/index.tsx`（81 行）
- AionUi: `packages/desktop/src/renderer/components/chat/CollapsibleContent.tsx`（236 行）

**约束：** 后端 `confirmation-manager.ts` 已通过 `requestDecision` / `respondDecision` 支持任意 string 决策（含 `'approve' | 'reject' | 'revise' | 'rewrite'`），**缺口仅在 HTTP 路由层**。本 Stage 任务 4.0 补齐路由 + 共享类型，任务 4.3 前端内联面板即可调用全套决策。

### 任务 4.0：后端 Confirmation API 扩展（用户确认项 B）

**文件：**
- 修改：`apps/agent-server/src/routes/confirmation.route.ts`
- 修改：`apps/agent-server/src/core/tool/confirmation-manager.ts`（仅补充 `comment` / `revisedContent` 字段透传，**不改现有签名**）
- 创建：`packages/shared/src/agent/confirmation.ts`
- 修改：`packages/shared/src/agent/index.ts`（导出新增）

- [ ] **步骤 1：在 `@repo/shared` 新增 `confirmation.ts` 定义共享类型**

```typescript
// packages/shared/src/agent/confirmation.ts
/**
 * Confirmation 决策类型（与 confirmation-manager.ts 的 DECISION_* 常量对齐）
 */
export type ConfirmationAction = 'approve' | 'reject' | 'revise' | 'rewrite'

/**
 * 决策响应 payload（扩展后）
 * - action: 必填，4 种之一
 * - comment: 可选，用户对决策的说明
 * - revisedContent: action='revise'/'rewrite' 时必填，用户改写后的内容
 */
export interface ConfirmationResponse {
  action: ConfirmationAction
  comment?: string
  revisedContent?: string
}

/**
 * 旧 boolean 兼容 payload
 * - approved=true → action='approve'
 * - approved=false → action='reject'
 */
export interface LegacyConfirmationResponse {
  approved: boolean
}

/**
 * 决策结果（用于 eventBus 'confirmation:resolved' 事件）
 */
export interface ConfirmationResolvedEvent {
  id: string
  decision: ConfirmationAction
  approved: boolean  // 兼容字段：decision === 'approve'
  comment?: string
  revisedContent?: string
}
```

在 `packages/shared/src/agent/index.ts` 末尾追加：

```typescript
export * from './confirmation.js'
```

- [ ] **步骤 2：扩展 `confirmation-manager.ts` 透传 `comment` / `revisedContent`**

**约束：** `requestDecision` / `respondDecision` / `requestConfirmation` / `respond` 的现有签名**保持不变**。新增重载 `respondDecisionWithMeta(id, decision, meta?)`。

打开 `apps/agent-server/src/core/tool/confirmation-manager.ts`，在 `respondDecision` 之后新增方法：

```typescript
export interface DecisionMeta {
  comment?: string
  revisedContent?: string
}

/**
 * 响应决策请求 + 元数据（comment / revisedContent）
 *
 * 与 respondDecision 的区别：附加 meta 字段供 revise/rewrite 决策使用。
 * 旧 respondDecision 内部委托给此方法（meta 为 undefined）。
 */
respondDecisionWithMeta(id: string, decision: string, meta: DecisionMeta = {}): boolean {
  return this.resolveRequest(id, decision, meta)
}
```

修改 `resolveRequest` 签名（**仅新增可选第三参数，不改前两个**）：

```typescript
private resolveRequest(id: string, decision: string, meta: { comment?: string; revisedContent?: string } = {}): boolean {
  const pending = this.pending.get(id)
  if (!pending) return false

  if (pending.timer) clearTimeout(pending.timer)
  this.pending.delete(id)
  pending.resolve(decision)
  this.eventBus.emit('confirmation:resolved', {
    id,
    decision,
    approved: decision === DECISION_APPROVE,
    ...meta,  // 透传 comment / revisedContent
  })
  return true
}
```

将现有 `respondDecision` 改为委托：

```typescript
respondDecision(id: string, decision: string): boolean {
  return this.respondDecisionWithMeta(id, decision)
}
```

- [ ] **步骤 3：扩展 `confirmation.route.ts` 同时支持新旧 schema**

打开 `apps/agent-server/src/routes/confirmation.route.ts`，替换为：

```typescript
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode } from '@repo/shared/errors'
import { validateBody } from '../lib/validate.js'

// 新 schema：action + 可选 meta
const confirmationResponseSchemaV2 = z.object({
  action: z.enum(['approve', 'reject', 'revise', 'rewrite']),
  comment: z.string().max(2000).optional(),
  revisedContent: z.string().max(50_000).optional(),
}).refine(
  (data) => {
    // revise/rewrite 必须带 revisedContent
    if ((data.action === 'revise' || data.action === 'rewrite') && !data.revisedContent) {
      return false
    }
    return true
  },
  { message: 'revise/rewrite 必须提供 revisedContent' },
)

// 旧 schema：boolean（兼容入口）
const confirmationResponseSchemaV1 = z.object({
  approved: z.boolean(),
})

export const confirmationRoute: FastifyPluginAsync = async (app) => {
  app.get('/api/confirmations', async () => {
    return {
      ok: true,
      data: {
        pending: app.confirmationManager.listPending(),
      },
    }
  })

  // 新端点：V2（推荐）
  app.post('/api/confirmations/:id/respond', async (request, reply) => {
    const params = request.params as { id: string }
    const body = request.body as Record<string, unknown>

    // 自动嗅探 V1 / V2
    const isV2 = typeof body?.action === 'string'
    if (isV2) {
      const input = validateBody(confirmationResponseSchemaV2, request, reply)
      if (!input) return reply
      const accepted = app.confirmationManager.respondDecisionWithMeta(
        params.id,
        input.action,
        { comment: input.comment, revisedContent: input.revisedContent },
      )
      if (!accepted) {
        throw new AppError(ErrorCode.NOT_FOUND, '确认请求不存在或已处理', 404)
      }
      return { ok: true, data: { accepted, action: input.action } }
    }

    // V1 兼容
    const input = validateBody(confirmationResponseSchemaV1, request, reply)
    if (!input) return reply
    const decision = input.approved ? 'approve' : 'reject'
    const accepted = app.confirmationManager.respond(params.id, input.approved)
    if (!accepted) {
      throw new AppError(ErrorCode.NOT_FOUND, '确认请求不存在或已处理', 404)
    }
    return { ok: true, data: { accepted, action: decision } }
  })
}
```

- [ ] **步骤 4：编写后端测试**

新增 `apps/agent-server/src/__tests__/confirmation-route-v2.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'

describe('POST /api/confirmations/:id/respond (V2)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp()
    await app.ready()
  })

  it('V1 approved=true → action=approve', async () => {
    // 1. 先发起一个 pending confirmation（通过 manager 直接调）
    const cm = app.confirmationManager
    const promise = cm.requestConfirmation({
      threadId: 't1', toolCallId: 'tc1', toolName: 'bash', args: {}, reason: 'test',
    })
    const req = cm.listPending()[0]

    // 2. V1 响应
    const res = await app.inject({
      method: 'POST',
      url: `/api/confirmations/${req.id}/respond`,
      payload: { approved: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.action).toBe('approve')

    const decision = await promise
    expect(decision).toBe(true)
  })

  it('V2 action=revise 带 revisedContent 通过', async () => {
    const cm = app.confirmationManager
    const promise = cm.requestDecision({
      threadId: 't1', toolCallId: 'tc1', toolName: 'edit', args: {}, reason: 'test',
    })
    const req = cm.listPending()[0]

    const res = await app.inject({
      method: 'POST',
      url: `/api/confirmations/${req.id}/respond`,
      payload: { action: 'revise', revisedContent: '改写后的内容' },
    })
    expect(res.statusCode).toBe(200)

    const decision = await promise
    expect(decision).toBe('revise')
  })

  it('V2 action=revise 缺 revisedContent 报 400', async () => {
    const cm = app.confirmationManager
    cm.requestDecision({
      threadId: 't1', toolCallId: 'tc1', toolName: 'edit', args: {}, reason: 'test',
    })
    const req = cm.listPending()[0]

    const res = await app.inject({
      method: 'POST',
      url: `/api/confirmations/${req.id}/respond`,
      payload: { action: 'revise' },
    })
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **步骤 5：运行测试**

```bash
pnpm --filter agent-server test -- confirmation-route-v2
```

预期：3 个 case 全过

- [ ] **步骤 6：Commit**

```bash
git add packages/shared/src/agent/confirmation.ts \
        packages/shared/src/agent/index.ts \
        apps/agent-server/src/core/tool/confirmation-manager.ts \
        apps/agent-server/src/routes/confirmation.route.ts \
        apps/agent-server/src/__tests__/confirmation-route-v2.test.ts
git commit -m "feat(agent-server): extend Confirmation API with action/comment/revisedContent (V2 backward-compatible)"
```

### 任务 4.1：CollapsibleContent 通用折叠组件

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/collapsible-content.tsx`

- [ ] **步骤 1：实现 `collapsible-content.tsx`**

```typescript
import { useState, useEffect, useRef, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CollapsibleContentProps {
  children: ReactNode
  maxHeight?: number                  // 默认 240
  defaultCollapsed?: boolean           // 默认 true
  className?: string
  contentClassName?: string
  expandLabel?: string
  collapseLabel?: string
}

export function CollapsibleContent({
  children,
  maxHeight = 240,
  defaultCollapsed = true,
  className,
  contentClassName,
  expandLabel = '展开',
  collapseLabel = '收起',
}: CollapsibleContentProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [overflow, setOverflow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setOverflow(entry.contentRect.height > maxHeight)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [maxHeight])

  return (
    <div className={cn('relative', className)}>
      <div
        ref={ref}
        className={cn(
          'overflow-auto transition-all',
          collapsed && overflow && 'max-h-[240px]',
          contentClassName
        )}
        style={{ maxHeight: collapsed && overflow ? maxHeight : undefined }}
      >
        {children}
      </div>
      {overflow && (
        <button
          className="absolute bottom-0 left-0 right-0 flex h-8 w-full items-center justify-center bg-gradient-to-t from-background to-transparent text-xs hover:from-surface-2"
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', !collapsed && 'rotate-180')} />
          <span className="ml-1">{collapsed ? expandLabel : collapseLabel}</span>
        </button>
      )}
    </div>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/collapsible-content.tsx
git commit -m "feat(chat): add CollapsibleContent component (maxHeight overflow detection)"
```

### 任务 4.2：MessageToolGroup 工具组聚合

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/message-tool-group.tsx`
- 创建：`apps/desktop/src/renderer/src/components/chat/message-tool-group-summary.tsx`

- [ ] **步骤 1：编写 `message-tool-group-summary.tsx`**

```typescript
import { memo } from 'react'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { ToolCallInfo } from './types'  // 复用现有 types

interface MessageToolGroupSummaryProps {
  toolCalls: ToolCallInfo[]
  collapsed: boolean
  onToggle: () => void
}

export const MessageToolGroupSummary = memo(function MessageToolGroupSummary({
  toolCalls,
  collapsed,
  onToggle,
}: MessageToolGroupSummaryProps) {
  const total = toolCalls.length
  const success = toolCalls.filter(t => t.status === 'success').length
  const failed = toolCalls.filter(t => t.status === 'error').length
  const running = toolCalls.filter(t => t.status === 'running').length

  // 取首个 toolName 作为摘要
  const firstName = toolCalls[0]?.toolName ?? 'unknown'
  const isSameTool = toolCalls.every(t => t.toolName === firstName)

  const summary = isSameTool
    ? `${total} 次 ${firstName}`
    : `${total} 次工具调用`

  return (
    <button
      className="flex w-full items-center gap-2 rounded-md bg-surface-1 px-3 py-1.5 text-left text-xs hover:bg-surface-2"
      onClick={onToggle}
    >
      <span className="flex-1 truncate">{summary}</span>
      {success > 0 && <Badge variant="default" className="bg-success/20 text-success">{success} 成功</Badge>}
      {failed > 0 && <Badge variant="destructive">{failed} 失败</Badge>}
      {running > 0 && <Badge variant="secondary"><Loader2 className="h-3 w-3 animate-spin mr-1" />{running} 运行</Badge>}
      <ChevronDown className={`h-3 w-3 transition-transform ${!collapsed ? 'rotate-180' : ''}`} />
    </button>
  )
})
```

- [ ] **步骤 2：编写 `message-tool-group.tsx`**

```typescript
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ToolCallInfo } from './types'
import { ToolCallCard } from './tool-call-card'
import { MessageToolGroupSummary } from './message-tool-group-summary'
import { CollapsibleContent } from './collapsible-content'

interface MessageToolGroupProps {
  toolCalls: ToolCallInfo[]
  groupId: string
}

export function MessageToolGroup({ toolCalls, groupId }: MessageToolGroupProps) {
  const [collapsed, setCollapsed] = useState(true)
  const hasRunning = toolCalls.some(t => t.status === 'running')
  // 运行中默认展开
  const effectiveCollapsed = collapsed && !hasRunning

  return (
    <div className="my-1 space-y-1" data-tool-group={groupId}>
      <MessageToolGroupSummary
        toolCalls={toolCalls}
        collapsed={effectiveCollapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      {!effectiveCollapsed && (
        <CollapsibleContent defaultCollapsed={false} maxHeight={400}>
          <div className="space-y-1 pl-3 border-l border-border">
            {toolCalls.map((tc, idx) => (
              <ToolCallCard key={`${tc.toolCallId}-${idx}`} toolCall={tc} />
            ))}
          </div>
        </CollapsibleContent>
      )}
    </div>
  )
}
```

- [ ] **步骤 3：在 `message-stream.tsx` 中调用聚合算法**

修改 `message-stream.tsx`，在渲染 ToolCall 序列前调用 `normalizeToolGroups`：

```typescript
// 新增工具函数
function normalizeToolGroups(messages: Message[]): Array<Message | { type: 'tool-group'; groupId: string; toolCalls: ToolCallInfo[] }> {
  const result: Array<Message | { type: 'tool-group'; groupId: string; toolCalls: ToolCallInfo[] }> = []
  let currentGroup: ToolCallInfo[] = []
  let groupStartIdx = 0

  messages.forEach((msg, idx) => {
    if (msg.kind === 'tool_call') {
      if (currentGroup.length === 0) groupStartIdx = idx
      currentGroup.push(msg.toolCall)
    } else {
      if (currentGroup.length >= 2) {
        result.push({ type: 'tool-group', groupId: `group-${groupStartIdx}`, toolCalls: currentGroup })
      } else {
        currentGroup.forEach(tc => result.push({ kind: 'tool_call', toolCall: tc } as Message))
      }
      currentGroup = []
      result.push(msg)
    }
  })

  // 处理末尾的 group
  if (currentGroup.length >= 2) {
    result.push({ type: 'tool-group', groupId: `group-${groupStartIdx}`, toolCalls: currentGroup })
  } else {
    currentGroup.forEach(tc => result.push({ kind: 'tool_call', toolCall: tc } as Message))
  }

  return result
}

// 在 renderMessage 中处理 tool-group 类型
function renderMessage(item: ReturnType<typeof normalizeToolGroups>[number]) {
  if (typeof item === 'object' && 'type' in item && item.type === 'tool-group') {
    return <MessageToolGroup key={item.groupId} groupId={item.groupId} toolCalls={item.toolCalls} />
  }
  // ... 原有渲染逻辑
}
```

- [ ] **步骤 4：运行 typecheck + test + 手动验证**

```bash
pnpm --filter desktop typecheck
pnpm --filter desktop test
pnpm dev:desktop
```

验证项：
- 连续 2 个以上 ToolCall 自动聚合为可折叠组
- 组头摘要显示总数 + 成功/失败/运行中徽章
- 单个 ToolCall 仍走原 ToolCallCard 渲染

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/message-tool-group.tsx apps/desktop/src/renderer/src/components/chat/message-tool-group-summary.tsx apps/desktop/src/renderer/src/components/chat/message-stream.tsx
git commit -m "feat(chat): add MessageToolGroup with consecutive tool call aggregation"
```

### 任务 4.3：MessagePermissionInline 内联确认面板

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/chat/message-permission-inline.tsx`
- 修改：`apps/desktop/src/renderer/src/types/confirmation.ts`

**约束：** 后端 Confirmation API 已在任务 4.0 扩展，支持 `action: 'approve' | 'reject' | 'revise' | 'rewrite'` + `comment` + `revisedContent`。本面板调用 V2 schema。

- [ ] **步骤 1：实现 `message-permission-inline.tsx`**

```typescript
import { useState } from 'react'
import { Check, X, Shield, Pencil, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/i18n'
import { postApi } from '@/api/http-client'
import type { ConfirmationRequest } from '@/types/confirmation'
import type { ConfirmationAction } from '@repo/shared/agent'

interface MessagePermissionInlineProps {
  request: ConfirmationRequest
  onResolved?: (id: string, action: ConfirmationAction) => void
}

const RISK_META = {
  safe: { label: '安全', variant: 'default' as const },
  moderate: { label: '中等', variant: 'secondary' as const },
  dangerous: { label: '高风险', variant: 'destructive' as const },
}

type UIAction = ConfirmationAction

const ACTION_META: Record<UIAction, { icon: typeof Check; label: string; variant: 'default' | 'destructive' | 'outline' | 'secondary' }> = {
  approve: { icon: Check, label: 'chat.confirmation.approve', variant: 'default' },
  reject: { icon: X, label: 'chat.confirmation.reject', variant: 'destructive' },
  revise: { icon: Pencil, label: 'chat.confirmation.revise', variant: 'outline' },
  rewrite: { icon: RefreshCw, label: 'chat.confirmation.rewrite', variant: 'secondary' },
}

export function MessagePermissionInline({ request, onResolved }: MessagePermissionInlineProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [responding, setResponding] = useState(false)
  const [resolved, setResolved] = useState<{ action: UIAction } | null>(null)
  const [showReviseBox, setShowReviseBox] = useState<UIAction | null>(null)
  const [revisedContent, setRevisedContent] = useState('')
  const [comment, setComment] = useState('')

  const riskLevel = (request.riskLevel ?? 'moderate') as keyof typeof RISK_META
  const riskMeta = RISK_META[riskLevel]

  const callRespond = async (action: UIAction, payload: { revisedContent?: string } = {}) => {
    setResponding(true)
    try {
      const body: Record<string, unknown> = { action }
      if (payload.revisedContent) body.revisedContent = payload.revisedContent
      if (comment.trim()) body.comment = comment.trim()
      await postApi(`/confirmations/${request.id}/respond`, body)
      setResolved({ action })
      onResolved?.(request.id, action)
      toast({ title: t(`chat.confirmation.${action}Done` as never) })
    } catch (err) {
      toast({
        title: t('errors.internal'),
        description: String(err),
        variant: 'destructive',
      })
    } finally {
      setResponding(false)
    }
  }

  const handleSimple = (action: 'approve' | 'reject') => {
    if (comment.trim()) {
      callRespond(action)
    } else {
      callRespond(action)
    }
  }

  const handleReviseSubmit = () => {
    if (!revisedContent.trim() || !showReviseBox) return
    callRespond(showReviseBox, { revisedContent: revisedContent.trim() })
  }

  if (resolved) {
    const meta = ACTION_META[resolved.action]
    const Icon = meta.icon
    return (
      <div className="flex items-center gap-2 rounded-md bg-surface-1 px-3 py-2 text-xs text-muted-foreground">
        <Shield className="h-3.5 w-3.5" />
        <span>{request.toolName}</span>
        <Badge variant={meta.variant}>
          <Icon className="h-3 w-3 mr-1" />
          {t(`chat.confirmation.${resolved.action}Done` as never)}
        </Badge>
      </div>
    )
  }

  return (
    <div className="my-1 rounded-md border border-border bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Shield className="h-4 w-4" />
        <span className="text-sm font-medium">{request.toolName}</span>
        <Badge variant={riskMeta.variant}>{riskMeta.label}</Badge>
        {request.reason && <span className="text-xs text-muted-foreground">{request.reason}</span>}
      </div>

      {request.args && (
        <pre className="mb-2 max-h-32 overflow-auto rounded bg-surface-2 p-2 text-xs">
          {JSON.stringify(request.args, null, 2)}
        </pre>
      )}

      {/* 可选 comment（任何 action 都可附加） */}
      <details className="mb-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">添加备注</summary>
        <Textarea
          className="mt-1 text-xs"
          placeholder="决策备注（可选）..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
        />
      </details>

      {/* revise/rewrite 输入区 */}
      {showReviseBox && (
        <div className="mb-2 rounded border border-warning/40 bg-warning/5 p-2">
          <p className="mb-1 text-xs font-medium text-warning">
            {t(`chat.confirmation.${showReviseBox}Hint` as never)}
          </p>
          <Textarea
            placeholder="请输入改写后的内容..."
            value={revisedContent}
            onChange={(e) => setRevisedContent(e.target.value)}
            rows={4}
            className="text-xs"
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={handleReviseSubmit}
              disabled={responding || !revisedContent.trim()}
            >
              提交
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowReviseBox(null)} disabled={responding}>
              取消
            </Button>
          </div>
        </div>
      )}

      {!showReviseBox && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={() => handleSimple('approve')}
            disabled={responding}
          >
            <Check className="h-3.5 w-3.5 mr-1" />
            {t('chat.confirmation.approve')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => handleSimple('reject')}
            disabled={responding}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            {t('chat.confirmation.reject')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowReviseBox('revise')}
            disabled={responding}
          >
            <Pencil className="h-3.5 w-3.5 mr-1" />
            {t('chat.confirmation.revise')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowReviseBox('rewrite')}
            disabled={responding}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            {t('chat.confirmation.rewrite')}
          </Button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **步骤 2：定义 `types/confirmation.ts`**

```typescript
import type { ConfirmationAction } from '@repo/shared/agent'

export type { ConfirmationAction }

export type ConfirmationRiskLevel = 'safe' | 'moderate' | 'dangerous'

export interface ConfirmationRequest {
  id: string
  threadId?: string
  toolCallId?: string
  toolName: string
  args?: unknown
  reason?: string
  riskLevel?: ConfirmationRiskLevel
  createdAt: number
}
```

- [ ] **步骤 3：在 `message-stream.tsx` 中渲染内联确认面板**

把现有 `ConfirmationDialog` 的渲染逻辑改为：当 `confirmationRequests` 非空时，把每个 request 作为消息流中的一项内联渲染：

```typescript
// 在 message-stream.tsx 中
import { MessagePermissionInline } from './message-permission-inline'

// 在消息流末尾插入内联确认面板
{confirmationRequests.map(req => (
  <MessagePermissionInline key={req.id} request={req} />
))}
```

同时**保留** `ConfirmationDialog` 组件不删除（向后兼容 + fallback）。可以加一个 feature flag（localStorage `wenlang-agent.inline-confirmation = 'true'`）控制是否启用内联模式，默认启用。

- [ ] **步骤 4：添加 i18n 翻译**

`zh-CN.json` 追加：

```json
{
  "chat": {
    "confirmation": {
      "approve": "批准",
      "reject": "拒绝",
      "revise": "修订",
      "rewrite": "重写",
      "approveDone": "已批准",
      "rejectDone": "已拒绝",
      "reviseDone": "已修订",
      "rewriteDone": "已重写",
      "reviseHint": "请提供修订后的内容，将发回原 Agent 重新执行",
      "rewriteHint": "请提供重写后的内容，将作为新输入传给后续 Agent",
      "approved": "已批准",
      "rejected": "已拒绝"
    }
  }
}
```

`en-US.json` 同步追加（approve/reject/revise/rewrite + Done/Hint 后缀）。

- [ ] **步骤 5：运行 typecheck + 手动验证**

```bash
pnpm --filter desktop typecheck
pnpm dev:desktop
```

验证项：
- 触发 dangerous 工具调用（如 bash），消息流末尾出现内联面板
- 点击"批准"/"拒绝"调 `POST /api/confirmations/:id/respond` body `{ action: 'approve' | 'reject' }`
- 点击"修订"/"重写"展开 textarea，提交时 body 含 `revisedContent`
- 任何 action 都可附加 comment（展开"添加备注"）
- 操作后面板变为对应"已批准/已拒绝/已修订/已重写"状态
- novel 章节创作的确认流程不受影响（仍走原 ConfirmationDialog）

- [ ] **步骤 6：Commit + 标记 Stage 4 完成**

```bash
git add apps/desktop/src/renderer/src/components/chat/message-permission-inline.tsx apps/desktop/src/renderer/src/types/confirmation.ts apps/desktop/src/renderer/src/components/chat/message-stream.tsx apps/desktop/src/renderer/src/i18n/locales/
git commit -m "feat(chat): add MessagePermissionInline (inline approval panel in message stream)"
git tag stage-4-tool-group-confirmation
```

---

## Stage 5：Team 模式专用 UI（P0-1）

**目标：** 后端 Team execute 流式化（SSE）+ 暴露 discussion 路由；前端新增 `pages/team/` 路由 + TeamPage / TeamChatView / 成员选择器 + 颜色分配；在 `App.tsx` 加 Team 入口；TeamChatView 显示实时成员进度。

**关键文件参考：**
- AionUi: `packages/desktop/src/renderer/pages/team/TeamPage.tsx`（641 行）
- AionUi: `packages/desktop/src/renderer/pages/team/identity/teamMemberColors.ts`（92 行，纯函数）
- AionUi: `packages/desktop/src/renderer/pages/team/identity/useTeamMemberColors.ts`（79 行）
- AionUi: `packages/desktop/src/common/adapter/teamMapper.ts`（138 行，前后端字段映射）

**约束：** pi-agent 无 react-router，Team 视图通过 `useState<AppView>` 切换。后端 `TeamManager.execute()` 已有 `onProgress` 回调但同步阻塞，需要改异步 + SSE 推送。后端 `team-discussion-engine.ts` 的 `invokeMember` 签名保持不变，新增 `routes/team-discussion.route.ts` 薄封装。

### 任务 5.0：后端 Team execute 流式化 + discussion 路由（用户确认项 A + C）

**文件：**
- 修改：`apps/agent-server/src/core/agent/team-manager.ts`（新增 `executeAsync` 不阻塞）
- 修改：`apps/agent-server/src/routes/teams.route.ts`（修改 execute 返回 + 新增 SSE 端点）
- 创建：`apps/agent-server/src/routes/team-discussion.route.ts`
- 修改：`apps/agent-server/src/app.ts`（注册新路由）
- 创建：`apps/agent-server/src/__tests__/team-execute-stream.test.ts`

- [ ] **步骤 1：在 `TeamManager` 新增 `executeAsync`**

打开 `apps/agent-server/src/core/agent/team-manager.ts`，在 `execute()` 方法之后新增：

```typescript
/**
 * 异步启动 Team 执行，立即返回 executionId，不阻塞等待结果。
 *
 * 与 execute() 的区别：
 * - execute() 同步等待完成，返回 TeamResult（旧 API，保留兼容）
 * - executeAsync() 立即返回 executionId，过程通过 onProgress 回调 + eventBus 推送
 *
 * 进度事件类型（通过 eventBus 推送，topic = `team:progress:${executionId}`）：
 * - { type: 'phase', executionId, phase: 'planning' | 'executing' | 'summarizing' | 'completed' | 'failed' }
 * - { type: 'member_start', executionId, agentId, role? }
 * - { type: 'member_progress', executionId, agentId, text, phase: 'thinking' | 'output' }
 * - { type: 'member_done', executionId, agentId, success, durationMs }
 * - { type: 'summary', executionId, summary }
 * - { type: 'done', executionId, success, durationMs }
 */
executeAsync(teamId: string, task: string, options: TeamExecuteOptions = {}): string {
  const team = this.teams.get(teamId)
  if (!team) {
    throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${teamId}`, 404)
  }

  const executionId = randomUUID()
  const startedAt = Date.now()
  const strategy = options.strategy ?? team.defaultStrategy

  const execution: TeamExecution = {
    executionId,
    teamId,
    task,
    strategy,
    phase: 'planning',
    memberResults: {},
    startedAt,
  }
  this.activeExecutions.set(executionId, execution)

  const teamChannel = `team:${teamId}:${executionId}`
  for (const member of team.members) {
    this.channel.subscribe(teamChannel, member.agentId)
  }

  // 包装 onProgress，同时推 eventBus
  const wrappedProgress = (progress: SubagentProgress): void => {
    options.onProgress?.(progress)
    // SubagentProgress 没带 agentId，无法直接关联成员，需要在 dispatchToAgent 调用前后补充
    // 简化：只推 phase=executing 的事件，由调用方通过 channel.broadcast 推 member_start/done
  }

  // fire-and-forget，过程推事件
  void this.execute(teamId, task, {
    ...options,
    onProgress: wrappedProgress,
  })
    .then((result) => {
      execution.phase = 'completed'
      execution.memberResults = result.memberResults
      execution.summary = result.summary
      execution.finishedAt = Date.now()
      // 推 done 事件（具体 eventBus API 见 events/event-bus.ts）
      this.agentManager.getEventBus()?.emit(`team:progress:${executionId}`, {
        type: 'done',
        executionId,
        success: result.success,
        durationMs: result.durationMs,
      })
    })
    .catch((err) => {
      execution.phase = 'failed'
      execution.error = err instanceof Error ? err.message : String(err)
      execution.finishedAt = Date.now()
      this.agentManager.getEventBus()?.emit(`team:progress:${executionId}`, {
        type: 'done',
        executionId,
        success: false,
        error: execution.error,
        durationMs: Date.now() - startedAt,
      })
    })

  return executionId
}
```

**注意：** 上面用到了 `this.agentManager.getEventBus()`，需要先在 `AgentManager` 上确认是否暴露 `getEventBus()`。若无，可通过构造函数注入 `EventBus`：

```typescript
// TeamManager 构造函数扩展
constructor(
  private readonly agentManager: AgentManager,
  private readonly channel: AgentChannel,
  private readonly store?: TeamPersistenceStore,
  private readonly eventBus?: EventBus,  // 新增可选参数
) {}
```

在 `app.ts` 注入处补一个 `eventBus` 实参即可（不影响现有调用，因为是可选参数）。

- [ ] **步骤 2：修改 `routes/teams.route.ts` 让 execute 立即返回 executionId + 新增 SSE 端点**

打开 `apps/agent-server/src/routes/teams.route.ts`，将 `POST /api/teams/:id/execute` 改为：

```typescript
app.post<{ Params: { id: string } }>(
  '/api/teams/:id/execute',
  async (req, reply) => {
    const input = validateBody(executeTeamSchema, req, reply)
    if (!input) return reply

    const teamId = req.params.id
    if (!manager.getTeam(teamId)) {
      throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${teamId}`, 404)
    }

    // 异步启动，立即返回 executionId
    const executionId = manager.executeAsync(teamId, input.task, {
      members: input.members,
      strategy: input.strategy,
      timeoutMs: input.timeout,
    })
    return success({ executionId, teamId }, req.traceId)
  },
)
```

在文件末尾（最后一个路由之后）新增 SSE 端点：

```typescript
/**
 * GET /api/teams/executions/:eid/stream
 * SSE 流式订阅 Team 执行进度
 *
 * 事件格式（text/event-stream）：
 * - event: phase\ndata: {"executionId":"...","phase":"executing"}
 * - event: member_done\ndata: {"executionId":"...","agentId":"...","success":true,"durationMs":1234}
 * - event: done\ndata: {"executionId":"...","success":true,"durationMs":5678}
 */
app.get<{ Params: { eid: string } }>(
  '/api/teams/executions/:eid/stream',
  async (req, reply) => {
    const eid = req.params.eid
    const execution = manager.getExecution(eid)
    if (!execution) {
      throw new AppError(ErrorCode.NOT_FOUND, `执行不存在: ${eid}`, 404)
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.setHeader('X-Accel-Buffering', 'no')  // 禁用 nginx 缓冲
    reply.raw.flushHeaders?.()

    // 先推一个 snapshot（当前状态）
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(execution)}\n\n`)

    // 如果已终态，推 done 后关闭
    if (execution.phase === 'completed' || execution.phase === 'failed') {
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ executionId: eid, success: execution.phase === 'completed', durationMs: Date.now() - execution.startedAt })}\n\n`)
      reply.raw.end()
      return
    }

    // 订阅 eventBus 事件
    const topic = `team:progress:${eid}`
    const handler = (event: Record<string, unknown>) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      if (event.type === 'done') {
        reply.raw.end()
      }
    }
    manager.getEventBusForStream()?.on(topic, handler)

    // 客户端断开时清理
    req.raw.on('close', () => {
      manager.getEventBusForStream()?.off(topic, handler)
    })
  },
)
```

**注意：** `manager.getEventBusForStream()` 是新暴露的 getter（返回 `EventBus | undefined`）。在 `TeamManager` 上新增：

```typescript
/** SSE 路由专用：暴露 eventBus（可能为 undefined，调用方需判空） */
getEventBusForStream(): EventBus | undefined {
  return this.eventBus
}
```

- [ ] **步骤 3：新增 `routes/team-discussion.route.ts`**

```typescript
/**
 * Team Discussion API 路由（薄封装 team-discussion-engine）
 *
 * 端点：
 * - POST /api/teams/:id/discuss — 启动 discussion 模式，立即返回 executionId
 *
 * 约束：不修改 team-discussion-engine.ts 的现有签名，仅做 HTTP 层薄封装。
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { success } from '../lib/api-response.js'
import { validateBody } from '../lib/validate.js'
import { AppError, ErrorCode } from '@repo/shared/errors'

const discussSchema = z.object({
  topic: z.string().min(1).max(2000).describe('讨论主题'),
  rounds: z.number().int().min(1).max(10).default(3).describe('讨论轮次'),
  members: z.array(z.object({
    agentId: z.string().min(1),
    role: z.string().optional(),
  })).min(2).describe('参与讨论的成员（至少 2 人）'),
})

export const teamDiscussionRoute: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/teams/:id/discuss
   * 启动 Team discussion，立即返回 executionId
   */
  app.post<{ Params: { id: string } }>(
    '/api/teams/:id/discuss',
    async (req, reply) => {
      const input = validateBody(discussSchema, req, reply)
      if (!input) return reply

      const teamId = req.params.id
      const team = app.teamManager.getTeam(teamId)
      if (!team) {
        throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${teamId}`, 404)
      }

      // 委托给 TeamManager.discussAsync（新方法，封装 team-discussion-engine.invokeMember）
      const executionId = await app.teamManager.discussAsync(teamId, {
        topic: input.topic,
        rounds: input.rounds,
        members: input.members,
      })
      return success({ executionId, teamId }, req.traceId)
    },
  )
}
```

在 `TeamManager` 新增 `discussAsync` 方法（薄封装 `team-discussion-engine`）：

```typescript
import { TeamDiscussionEngine } from './team-discussion-engine.js'

/**
 * 启动 Team discussion 模式（异步，立即返回 executionId）
 *
 * 内部委托给 TeamDiscussionEngine.invokeMember，不修改其签名。
 * 讨论事件通过 eventBus topic `team:progress:${executionId}` 推送，
 * 与 executeAsync 共用同一 SSE 端点。
 */
async discussAsync(
  teamId: string,
  options: { topic: string; rounds: number; members: Array<{ agentId: string; role?: string }> },
): Promise<string> {
  const team = this.teams.get(teamId)
  if (!team) {
    throw new AppError(ErrorCode.NOT_FOUND, `Team 不存在: ${teamId}`, 404)
  }

  const executionId = randomUUID()
  const startedAt = Date.now()

  // 构造 discussion engine（如未注入则在内部 lazy 创建）
  const engine = new TeamDiscussionEngine({
    team,
    agentManager: this.agentManager,
    channel: this.channel,
    rounds: options.rounds,
  })

  // fire-and-forget
  void engine.runDiscussion(options.topic, options.members, {
    onMessage: (msg) => {
      this.eventBus?.emit(`team:progress:${executionId}`, {
        type: 'team_discussion_message',
        executionId,
        ...msg,
      })
    },
    onDone: (result) => {
      this.eventBus?.emit(`team:progress:${executionId}`, {
        type: 'done',
        executionId,
        success: true,
        durationMs: Date.now() - startedAt,
      })
    },
  })
    .catch((err) => {
      this.eventBus?.emit(`team:progress:${executionId}`, {
        type: 'done',
        executionId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
    })

  return executionId
}
```

**约束：** `TeamDiscussionEngine` 的构造参数 / `runDiscussion` 签名根据实际后端代码调整。如签名与上面假设不符，**优先以现有签名为准**，仅做参数透传，不修改 engine 本身。先 `Read` `apps/agent-server/src/core/agent/team-discussion-engine.ts` 确认签名再实现。

- [ ] **步骤 4：在 `app.ts` 注册新路由**

打开 `apps/agent-server/src/app.ts`，找到 `app.register(teamsRoute)` 或类似注册位置，在其后新增：

```typescript
import { teamDiscussionRoute } from './routes/team-discussion.route.js'
// ...
await app.register(teamDiscussionRoute)
```

- [ ] **步骤 5：编写后端测试**

新增 `apps/agent-server/src/__tests__/team-execute-stream.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'

describe('Team execute stream (SSE)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp()
    await app.ready()
    // 创建测试 Team + 注册 mock agent（fixture 略，参考 team-manager.test.ts）
  })

  afterEach(async () => {
    await app.close()
  })

  it('POST /api/teams/:id/execute 立即返回 executionId', async () => {
    // 跳过 fixture 创建细节，断言响应形如 { data: { executionId, teamId } }
  })

  it('GET /api/teams/executions/:eid/stream 推送 phase + done 事件', async () => {
    // 用 sse-stream 解析或手写 raw chunk 解析
  })
})
```

- [ ] **步骤 6：运行测试 + Commit**

```bash
pnpm --filter agent-server test -- team-execute-stream
```

```bash
git add apps/agent-server/src/core/agent/team-manager.ts \
        apps/agent-server/src/routes/teams.route.ts \
        apps/agent-server/src/routes/team-discussion.route.ts \
        apps/agent-server/src/app.ts \
        apps/agent-server/src/__tests__/team-execute-stream.test.ts
git commit -m "feat(agent-server): Team execute streaming via SSE + team-discussion route (A+C)"
```

### 任务 5.1：Team API 客户端

**文件：**
- 创建：`apps/desktop/src/renderer/src/api/team-client.ts`

**约束：** 后端 `POST /api/teams/:id/execute` 已在任务 5.0 改为立即返回 `{ executionId, teamId }`，进度通过 `GET /api/teams/executions/:eid/stream`（SSE）订阅。本客户端提供 `streamExecution()` 封装 EventSource，无需轮询。

- [ ] **步骤 1：编写 `team-client.ts`**

```typescript
import { getApi, postApi, putApi, deleteApi } from './http-client'
import type { TeamConfig, TeamResult, TeamExecution, TeamMember, TeamStrategy, TeamExecutionPhase } from '@/types/team'

// === 基础 CRUD ===
export async function listTeams(): Promise<TeamConfig[]> {
  return getApi<TeamConfig[]>('/teams')
}

export async function getTeam(id: string): Promise<TeamConfig> {
  return getApi<TeamConfig>(`/teams/${id}`)
}

export async function createTeam(input: Omit<TeamConfig, 'id'> & { id: string }): Promise<TeamConfig> {
  return postApi<TeamConfig>('/teams', input)
}

export async function updateTeam(id: string, patch: Partial<TeamConfig>): Promise<TeamConfig> {
  return putApi<TeamConfig>(`/teams/${id}`, patch)
}

export async function deleteTeam(id: string): Promise<{ id: string; deleted: boolean }> {
  return deleteApi<{ id: string; deleted: boolean }>(`/teams/${id}`)
}

// === 执行（流式） ===

/** execute 立即返回值（不阻塞） */
export interface TeamExecuteAck {
  executionId: string
  teamId: string
}

/** 启动 Team execute，立即返回 executionId（不阻塞） */
export async function executeTeam(
  id: string,
  input: { task: string; members?: TeamMember[]; strategy?: TeamStrategy; timeout?: number }
): Promise<TeamExecuteAck> {
  return postApi<TeamExecuteAck>(`/teams/${id}/execute`, input)
}

/** 启动 Team discussion，立即返回 executionId */
export async function discussTeam(
  id: string,
  input: { topic: string; rounds?: number; members: Array<{ agentId: string; role?: string }> }
): Promise<TeamExecuteAck> {
  return postApi<TeamExecuteAck>(`/teams/${id}/discuss`, input)
}

export async function listExecutions(): Promise<TeamExecution[]> {
  return getApi<TeamExecution[]>('/teams/executions')
}

export async function getExecution(eid: string): Promise<TeamExecution> {
  return getApi<TeamExecution>(`/teams/executions/${eid}`)
}

// === SSE 订阅 ===

/** SSE 事件类型（与后端 routes/teams.route.ts 对齐） */
export type TeamStreamEvent =
  | { type: 'snapshot'; execution: TeamExecution }
  | { type: 'phase'; executionId: string; phase: TeamExecutionPhase }
  | { type: 'member_start'; executionId: string; agentId: string; role?: string }
  | { type: 'member_progress'; executionId: string; agentId: string; text: string; phase: 'thinking' | 'output' }
  | { type: 'member_done'; executionId: string; agentId: string; success: boolean; durationMs: number; result?: string; error?: string }
  | { type: 'summary'; executionId: string; summary: string }
  | { type: 'team_discussion_message'; executionId: string; agentId: string; round: number; text: string }
  | { type: 'done'; executionId: string; success: boolean; durationMs: number; error?: string }

export interface StreamExecutionOptions {
  onEvent: (event: TeamStreamEvent) => void
  onError?: (err: Event) => void
  /** 可选：自定义 EventSource 构造（用于测试） */
  eventSourceFactory?: (url: string) => EventSource
}

/**
 * 订阅 Team 执行进度（SSE）。
 * 返回 unsubscribe 函数，调用后关闭 EventSource。
 *
 * 用法：
 * const unsubscribe = streamExecution(eid, { onEvent: e => ... })
 * // ...
 * unsubscribe()
 */
export function streamExecution(eid: string, options: StreamExecutionOptions): () => void {
  const url = `/api/teams/executions/${eid}/stream`
  const EventSourceCtor = options.eventSourceFactory ?? ((u: string) => new EventSource(u))
  const es = EventSourceCtor(url)

  const handler = (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as Record<string, unknown>
      const type = ev.type as TeamStreamEvent['type']
      // snapshot 事件 data 字段是整个 execution 对象
      if (type === 'snapshot') {
        options.onEvent({ type: 'snapshot', execution: data as unknown as TeamExecution } as TeamStreamEvent)
      } else {
        options.onEvent({ type, ...data } as TeamStreamEvent)
      }
    } catch (err) {
      console.error('Failed to parse SSE event', err)
    }
  }

  // 监听所有事件类型（SSE event: 字段）
  const EVENT_TYPES = ['snapshot', 'phase', 'member_start', 'member_progress', 'member_done', 'summary', 'team_discussion_message', 'done']
  for (const t of EVENT_TYPES) {
    es.addEventListener(t, handler as EventListener)
  }

  es.onerror = (err) => {
    options.onError?.(err)
  }

  return () => {
    for (const t of EVENT_TYPES) {
      es.removeEventListener(t, handler as EventListener)
    }
    es.close()
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/desktop/src/renderer/src/api/team-client.ts
git commit -m "feat(team): add team-client with SSE streaming (no polling)"
```

### 任务 5.2：TeamMemberColors 颜色分配算法

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/team/identity/team-member-colors.ts`
- 创建：`apps/desktop/src/renderer/src/components/team/identity/use-team-member-colors.ts`
- 创建：`apps/desktop/src/renderer/src/components/team/identity/team-identity-context.tsx`

- [ ] **步骤 1：编写 `team-member-colors.ts`（纯函数 + 测试）**

```typescript
// 8 色色板（与 AionUi 一致）
export const TEAM_MEMBER_PALETTE = [
  'var(--color-primary)',   // 0: Leader
  '#5c9ea4',                // 1: 雾青
  '#b58a5e',                // 2: 暖褐
  '#9481bf',                // 3: 藕紫
  '#c07d97',                // 4: 豆沙玫
  '#6ba07e',                // 5: 灰绿
  '#4f8ac9',                // 6: 雾蓝
  '#c99a4b',                // 7: 琥珀
] as const

export interface TeamAssistantLike {
  slot_id: string
  is_leader?: boolean
}

/**
 * 分配成员颜色
 * - Leader 固定色号 0
 * - 已分配成员保持原色号
 * - 新成员取未占用的最小非 0 色号
 * - 色板满后对长度取模循环（跳过 0）
 */
export function assignMemberColors<T extends TeamAssistantLike>(
  prev: Map<string, number>,
  assistants: T[]
): Map<string, number> {
  const next = new Map<string, number>()
  const usedSlots = new Set<number>()

  // 第一遍：Leader 钉死色号 0
  const leader = assistants.find(a => a.is_leader)
  if (leader) {
    next.set(leader.slot_id, 0)
    usedSlots.add(0)
  }

  // 第二遍：保留已有分配
  for (const a of assistants) {
    if (a.is_leader) continue
    const prevColor = prev.get(a.slot_id)
    if (prevColor !== undefined && !usedSlots.has(prevColor)) {
      next.set(a.slot_id, prevColor)
      usedSlots.add(prevColor)
    }
  }

  // 第三遍：新成员分配未占用色号
  let nextSlot = 1
  for (const a of assistants) {
    if (a.is_leader) continue
    if (next.has(a.slot_id)) continue
    while (usedSlots.has(nextSlot)) {
      nextSlot++
      if (nextSlot >= TEAM_MEMBER_PALETTE.length) {
        nextSlot = 1  // 跳过 0（Leader 专用）
        // 防死循环：如果 1-7 都用完了，强制重用
        if (usedSlots.has(nextSlot)) break
      }
    }
    next.set(a.slot_id, nextSlot)
    usedSlots.add(nextSlot)
    nextSlot++
  }

  return next
}
```

- [ ] **步骤 2：编写 `use-team-member-colors.ts`**

```typescript
import { useEffect, useState, useMemo } from 'react'
import { assignMemberColors, TEAM_MEMBER_PALETTE, type TeamAssistantLike } from './team-member-colors'

interface UseTeamMemberColorsOptions<T extends TeamAssistantLike> {
  teamId: string
  assistants: T[]
}

export function useTeamMemberColors<T extends TeamAssistantLike>({ teamId, assistants }: UseTeamMemberColorsOptions<T>) {
  const storageKey = `pi-team-colors-${teamId}`
  const [colorMap, setColorMap] = useState<Map<string, number>>(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) return new Map(JSON.parse(stored))
    } catch {}
    return new Map()
  })

  useEffect(() => {
    const next = assignMemberColors(colorMap, assistants)
    // 浅比较跳过未变更
    let changed = false
    if (next.size !== colorMap.size) changed = true
    else for (const [k, v] of next) if (colorMap.get(k) !== v) { changed = true; break }
    if (changed) {
      setColorMap(next)
      localStorage.setItem(storageKey, JSON.stringify(Array.from(next.entries())))
    }
  }, [assistants, colorMap, storageKey])

  const colorOf = useMemo(() => {
    return (slotId: string): string => {
      const idx = colorMap.get(slotId) ?? 0
      return TEAM_MEMBER_PALETTE[idx % TEAM_MEMBER_PALETTE.length]
    }
  }, [colorMap])

  return { colorOf, colorMap }
}
```

- [ ] **步骤 3：编写 `team-identity-context.tsx`**

```typescript
import { createContext, useContext, type ReactNode } from 'react'
import { useTeamMemberColors, type TeamAssistantLike } from './use-team-member-colors'

interface TeamIdentityContextValue<T extends TeamAssistantLike> {
  colorOf: (slotId: string) => string
  assistants: T[]
}

const TeamIdentityContext = createContext<TeamIdentityContextValue<any> | null>(null)

export function TeamIdentityProvider<T extends TeamAssistantLike>({
  teamId,
  assistants,
  children,
}: {
  teamId: string
  assistants: T[]
  children: ReactNode
}) {
  const { colorOf } = useTeamMemberColors<T>({ teamId, assistants })
  return (
    <TeamIdentityContext.Provider value={{ colorOf, assistants }}>
      {children}
    </TeamIdentityContext.Provider>
  )
}

export function useTeamIdentity() {
  const ctx = useContext(TeamIdentityContext)
  if (!ctx) throw new Error('useTeamIdentity must be used within TeamIdentityProvider')
  return ctx
}
```

- [ ] **步骤 4：编写颜色分配测试**

```typescript
// team-member-colors.test.ts
import { describe, it, expect } from 'vitest'
import { assignMemberColors, TEAM_MEMBER_PALETTE } from '../team-member-colors'

describe('assignMemberColors', () => {
  it('Leader 固定色号 0', () => {
    const result = assignMemberColors(new Map(), [
      { slot_id: 'a', is_leader: true },
      { slot_id: 'b' },
    ])
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(1)
  })

  it('已分配成员保持原色号', () => {
    const prev = new Map([['a', 3], ['b', 5]])
    const result = assignMemberColors(prev, [
      { slot_id: 'a' },
      { slot_id: 'b' },
      { slot_id: 'c' },
    ])
    expect(result.get('a')).toBe(3)
    expect(result.get('b')).toBe(5)
    expect(result.get('c')).toBe(1)
  })

  it('新成员取最小未占用色号（跳过 0）', () => {
    const result = assignMemberColors(new Map(), [
      { slot_id: 'leader', is_leader: true },
      { slot_id: 'a' },
      { slot_id: 'b' },
      { slot_id: 'c' },
    ])
    expect(result.get('a')).toBe(1)
    expect(result.get('b')).toBe(2)
    expect(result.get('c')).toBe(3)
  })
})
```

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/team/identity/ apps/desktop/src/renderer/src/components/team/__tests__/
git commit -m "feat(team): add team member colors algorithm (8-color palette + leader fixed)"
```

### 任务 5.3：TeamStore + 成员选择器

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/team-store.ts`
- 创建：`apps/desktop/src/renderer/src/components/team/member-picker/team-add-member-popover.tsx`
- 创建：`apps/desktop/src/renderer/src/components/team/member-picker/team-assistant-picker.tsx`
- 创建：`apps/desktop/src/renderer/src/components/team/member-picker/team-member-draft-list.tsx`

- [ ] **步骤 1：编写 `team-store.ts`**

**约束：** 后端 `executeTeam` 立即返回 `{ executionId, teamId }` 不阻塞，进度通过 `teamClient.streamExecution(eid)`（SSE）订阅。Store 持有 `activeExecution` / `memberProgress` / `discussionMessages` 三块实时状态，由 SSE 事件驱动更新；模块级 `unsubscribeStream` 句柄不进入 state（Zustand state 应保持可序列化）。

```typescript
import { create } from 'zustand'
import type { TeamConfig, TeamExecution, TeamMember, TeamStrategy } from '@/types/team'
import * as teamClient from '@/api/team-client'
import type { TeamStreamEvent } from '@/api/team-client'

/** 单个成员的实时进度（由 member_start / member_progress / member_done 事件累积） */
export interface TeamMemberProgress {
  agentId: string
  status: 'pending' | 'running' | 'done' | 'failed'
  lastText?: string
  result?: string
  error?: string
  durationMs?: number
}

/** 讨论消息（来自 team_discussion_message 事件） */
export interface TeamDiscussionMessage {
  agentId: string
  round: number
  text: string
}

interface TeamStoreState {
  teams: TeamConfig[]
  loading: boolean
  activeTeamId?: string
  // 实时执行状态（由 SSE 事件驱动）
  activeExecution?: TeamExecution
  memberProgress: Record<string, TeamMemberProgress>
  discussionMessages: TeamDiscussionMessage[]
  streaming: boolean
  // 流式动作
  startExecution: (teamId: string, task: string, options?: { members?: TeamMember[]; strategy?: TeamStrategy }) => Promise<string>
  startDiscussion: (teamId: string, topic: string, options: { rounds?: number; members: Array<{ agentId: string; role?: string }> }) => Promise<string>
  stopStream: () => void
  // 基础 CRUD
  loadTeams: () => Promise<void>
  setActiveTeam: (id: string | undefined) => void
  createTeam: (input: Omit<TeamConfig, 'id'> & { id: string }) => Promise<TeamConfig>
  removeTeam: (id: string) => Promise<void>
}

/** 当前未关闭的 SSE 订阅句柄（模块级，不在 state 内） */
let unsubscribeStream: (() => void) | null = null

export const useTeamStore = create<TeamStoreState>()((set, get) => ({
  teams: [],
  loading: false,
  memberProgress: {},
  discussionMessages: [],
  streaming: false,

  loadTeams: async () => {
    set({ loading: true })
    try {
      const teams = await teamClient.listTeams()
      set({ teams, loading: false })
    } catch (err) {
      set({ loading: false })
      throw err
    }
  },

  setActiveTeam: (id) => {
    // 切换 team 时先关闭上一次的 SSE 流，避免悬挂订阅
    get().stopStream()
    set({
      activeTeamId: id,
      activeExecution: undefined,
      memberProgress: {},
      discussionMessages: [],
      streaming: false,
    })
  },

  createTeam: async (input) => {
    const team = await teamClient.createTeam(input)
    set(state => ({ teams: [...state.teams, team] }))
    return team
  },

  removeTeam: async (id) => {
    await teamClient.deleteTeam(id)
    set(state => ({
      teams: state.teams.filter(t => t.id !== id),
      activeTeamId: state.activeTeamId === id ? undefined : state.activeTeamId,
    }))
  },

  startExecution: async (teamId, task, options) => {
    // 1. 先关闭上一次的流，避免多个 SSE 并发污染 state
    get().stopStream()
    // 2. 重置进度（保留 teams/activeTeamId）
    set({
      activeExecution: undefined,
      memberProgress: {},
      discussionMessages: [],
      streaming: true,
    })
    // 3. 发起 execute（后端立即返回 executionId，不阻塞）
    const ack = await teamClient.executeTeam(teamId, {
      task,
      members: options?.members,
      strategy: options?.strategy,
    })
    // 4. 订阅 SSE，事件投递到 applyStreamEvent
    subscribeStream(ack.executionId, set, get)
    return ack.executionId
  },

  startDiscussion: async (teamId, topic, options) => {
    get().stopStream()
    set({
      activeExecution: undefined,
      memberProgress: {},
      discussionMessages: [],
      streaming: true,
    })
    const ack = await teamClient.discussTeam(teamId, {
      topic,
      rounds: options.rounds,
      members: options.members,
    })
    subscribeStream(ack.executionId, set, get)
    return ack.executionId
  },

  stopStream: () => {
    if (unsubscribeStream) {
      unsubscribeStream()
      unsubscribeStream = null
    }
    set({ streaming: false })
  },
}))

/**
 * SSE 事件 → store 状态映射。
 * 拆成纯函数便于单元测试（mock event 直接断言 set 调用）。
 */
function applyStreamEvent(
  event: TeamStreamEvent,
  set: (partial: Partial<TeamStoreState>) => void,
  get: () => TeamStoreState,
): void {
  switch (event.type) {
    case 'snapshot':
      // 首个事件，整包覆盖 activeExecution
      set({ activeExecution: event.execution })
      break

    case 'phase':
      set(state => ({
        activeExecution: state.activeExecution
          ? { ...state.activeExecution, phase: event.phase }
          : state.activeExecution,
      }))
      break

    case 'member_start':
      set(state => ({
        memberProgress: {
          ...state.memberProgress,
          [event.agentId]: { agentId: event.agentId, status: 'running' },
        },
      }))
      break

    case 'member_progress':
      set(state => ({
        memberProgress: {
          ...state.memberProgress,
          [event.agentId]: {
            agentId: event.agentId,
            status: 'running',
            lastText: event.text,
          },
        },
      }))
      break

    case 'member_done':
      set(state => ({
        memberProgress: {
          ...state.memberProgress,
          [event.agentId]: {
            agentId: event.agentId,
            status: event.success ? 'done' : 'failed',
            result: event.result,
            error: event.error,
            durationMs: event.durationMs,
          },
        },
      }))
      break

    case 'summary':
      set(state => ({
        activeExecution: state.activeExecution
          ? { ...state.activeExecution, summary: event.summary }
          : state.activeExecution,
      }))
      break

    case 'team_discussion_message':
      set(state => ({
        discussionMessages: [
          ...state.discussionMessages,
          { agentId: event.agentId, round: event.round, text: event.text },
        ],
      }))
      break

    case 'done':
      set(state => ({
        streaming: false,
        activeExecution: state.activeExecution
          ? {
              ...state.activeExecution,
              phase: event.success ? 'completed' : 'failed',
              finishedAt: Date.now(),
            }
          : state.activeExecution,
      }))
      // 流结束，清理订阅句柄
      if (unsubscribeStream) {
        unsubscribeStream()
        unsubscribeStream = null
      }
      break
  }
}

/** 订阅 SSE 并把事件投递到 store（封装 streamExecution + applyStreamEvent） */
function subscribeStream(
  executionId: string,
  set: (partial: Partial<TeamStoreState>) => void,
  get: () => TeamStoreState,
): void {
  unsubscribeStream = teamClient.streamExecution(executionId, {
    onEvent: (event) => applyStreamEvent(event, set, get),
    onError: (err) => {
      console.error('Team SSE stream error', err)
      set({ streaming: false })
    },
  })
}
```

**关键设计点：**

1. `executeTask` 旧方法已删除——后端 execute 不再同步返回 `TeamResult`，改用 `startExecution` 返回 `executionId` 后由 SSE 推 `member_done` 事件补齐 `memberProgress`。
2. `memberProgress` 是 `Record<agentId, TeamMemberProgress>`，key 是 agentId，便于 O(1) 查找；`TeamResult.memberResults` 也是 Record，字段一致。
3. `unsubscribeStream` 是模块级变量（不在 Zustand state 内），因为订阅句柄不可序列化，放进 state 会被 devtools 序列化报错。
4. `setActiveTeam` / `startExecution` / `startDiscussion` 都先调 `stopStream()`，避免切 team 或重发起时残留多个 SSE 连接。
5. `applyStreamEvent` 拆成独立纯函数，方便单测（mock `TeamStreamEvent` 数组，断言最终 state）。

- [ ] **步骤 2：编写成员选择器组件**

简化版（基于现有 `popover` / `command` 模式，不引入新依赖）：

`team-assistant-picker.tsx`：

```typescript
import { useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { TeamMemberRole } from '@/types/team'

export interface TeamAssistantOption {
  agentId: string
  name: string
  description?: string
}

interface TeamAssistantPickerProps {
  assistants: TeamAssistantOption[]
  onSelect: (agentId: string, role: TeamMemberRole) => void
  disabled?: boolean
}

const ROLE_OPTIONS: TeamMemberRole[] = ['researcher', 'coder', 'reviewer', 'tester', 'writer', 'analyst', 'custom']

export function TeamAssistantPicker({ assistants, onSelect, disabled }: TeamAssistantPickerProps) {
  const [query, setQuery] = useState('')
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [role, setRole] = useState<TeamMemberRole>('researcher')

  const filtered = assistants.filter(a => a.name.toLowerCase().includes(query.toLowerCase()))

  const handleAdd = () => {
    if (!selectedAgent) return
    onSelect(selectedAgent, role)
    setSelectedAgent(null)
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="搜索 agent..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="pl-8"
        />
      </div>
      <div className="max-h-48 overflow-auto rounded-md border border-border">
        {filtered.map(a => (
          <button
            key={a.agentId}
            className={`flex w-full flex-col items-start px-3 py-2 text-left text-xs hover:bg-surface-2 ${selectedAgent === a.agentId ? 'bg-surface-3' : ''}`}
            onClick={() => setSelectedAgent(a.agentId)}
          >
            <span className="font-medium">{a.name}</span>
            {a.description && <span className="text-muted-foreground">{a.description}</span>}
          </button>
        ))}
      </div>
      {selectedAgent && (
        <div className="flex items-center gap-2">
          <select
            value={role}
            onChange={e => setRole(e.target.value as TeamMemberRole)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <Button size="sm" onClick={handleAdd} disabled={disabled}>添加</Button>
        </div>
      )}
    </div>
  )
}
```

`team-member-draft-list.tsx`：

```typescript
import { Crown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TeamMember } from '@/types/team'

interface TeamMemberDraft {
  agentId: string
  name: string
  role?: TeamMember['role']
  isLeader?: boolean
}

interface TeamMemberDraftListProps {
  members: TeamMemberDraft[]
  leaderAgentId?: string
  onLeaderChange: (agentId: string) => void
  onRemove: (agentId: string) => void
}

export function TeamMemberDraftList({ members, leaderAgentId, onLeaderChange, onRemove }: TeamMemberDraftListProps) {
  return (
    <div className="space-y-1">
      {members.map(m => (
        <div key={m.agentId} className="flex items-center gap-2 rounded-md bg-surface-1 px-3 py-1.5 text-xs">
          <span className="flex-1 truncate">{m.name}</span>
          {m.role && <span className="text-muted-foreground">{m.role}</span>}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onLeaderChange(m.agentId)}
            disabled={leaderAgentId === m.agentId}
          >
            <Crown className={`h-3 w-3 ${leaderAgentId === m.agentId ? 'text-primary' : 'text-muted-foreground'}`} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onRemove(m.agentId)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  )
}
```

`team-add-member-popover.tsx`：

```typescript
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { TeamAssistantPicker, type TeamAssistantOption } from './team-assistant-picker'
import type { TeamMemberRole } from '@/types/team'

interface TeamAddMemberPopoverProps {
  assistants: TeamAssistantOption[]
  onAdd: (agentId: string, role: TeamMemberRole) => void
  disabled?: boolean
}

export function TeamAddMemberPopover({ assistants, onAdd, disabled }: TeamAddMemberPopoverProps) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          添加成员
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>选择 Team 成员</DialogTitle>
        </DialogHeader>
        <TeamAssistantPicker
          assistants={assistants}
          onSelect={(agentId, role) => {
            onAdd(agentId, role)
            setOpen(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/stores/team-store.ts apps/desktop/src/renderer/src/components/team/member-picker/
git commit -m "feat(team): add TeamStore + member picker (assistant picker + draft list + add popover)"
```

### 任务 5.4：TeamPage + TeamChatView 主组件

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/team/team-page.tsx`
- 创建：`apps/desktop/src/renderer/src/components/team/team-chat-view.tsx`
- 创建：`apps/desktop/src/renderer/src/components/team/team-view-toggle.tsx`
- 创建：`apps/desktop/src/renderer/src/components/team/team-chat-empty-state.tsx`

- [ ] **步骤 1：编写 `team-page.tsx`（精简版）**

```typescript
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Users, Play, Loader2, MessageSquare, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useTeamStore } from '@/stores/team-store'
import { useToast } from '@/hooks/use-toast'
import { getApi } from '@/api/http-client'
import { TeamAddMemberPopover } from './member-picker/team-add-member-popover'
import { TeamMemberDraftList } from './member-picker/team-member-draft-list'
import { TeamIdentityProvider } from './identity/team-identity-context'
import { TeamChatView } from './team-chat-view'
import type { TeamMemberRole, TeamStrategy } from '@/types/team'

interface TeamMemberDraftExt {
  agentId: string
  name: string
  role?: TeamMemberRole
  isLeader?: boolean
}

const STRATEGIES: TeamStrategy[] = ['sequential', 'parallel', 'pipeline', 'coordinated']

/** Team 工作区模式：执行任务 / 圆桌讨论 */
type TeamMode = 'execute' | 'discuss'

interface TeamPageProps {
  onClose?: () => void  // 由 App.tsx 传入，用于返回 home 视图
}

export function TeamPage({ onClose }: TeamPageProps = {}) {
  const { toast } = useToast()
  // 从 store 取流式动作 + streaming 标志（替代旧 executeTask + executing）
  const {
    teams, loadTeams, createTeam, activeTeamId, setActiveTeam,
    startExecution, startDiscussion, streaming,
  } = useTeamStore()
  const [showCreate, setShowCreate] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftMembers, setDraftMembers] = useState<TeamMemberDraftExt[]>([])
  const [strategy, setStrategy] = useState<TeamStrategy>('parallel')
  const [taskInput, setTaskInput] = useState('')
  // 模式切换：execute = 派发任务，discuss = 圆桌讨论
  const [mode, setMode] = useState<TeamMode>('execute')

  // 加载 team 列表
  useEffect(() => { loadTeams().catch(() => {}) }, [loadTeams])

  // 加载 agents 列表（用于成员选择器）
  const { data: agents = [] } = useQuery({
    queryKey: ['agents-for-team'],
    queryFn: () => getApi<Array<{ id: string; name: string; description?: string }>>('/agents'),
  })

  const assistants = agents.map(a => ({ agentId: a.id, name: a.name, description: a.description }))

  const activeTeam = teams.find(t => t.id === activeTeamId)

  const handleCreateTeam = async () => {
    if (!draftName.trim() || draftMembers.length === 0) return
    const leader = draftMembers.find(m => m.isLeader) ?? draftMembers[0]
    const teamId = `team-${Date.now()}`
    await createTeam({
      id: teamId,
      name: draftName,
      description: '',  // 后端 TeamConfig.description 必填，P0 暂留空字符串
      leadAgentId: leader.agentId,
      members: draftMembers.map(m => ({ agentId: m.agentId, role: m.role ?? 'custom' })),
      defaultStrategy: strategy,
      maxParallel: 4,
    })
    setActiveTeam(teamId)
    setShowCreate(false)
    setDraftName('')
    setDraftMembers([])
    toast({ title: `Team ${draftName} 已创建` })
  }

  // 执行模式：调 startExecution，立即返回 executionId，SSE 推进度
  const handleExecute = async () => {
    if (!activeTeam || !taskInput.trim() || streaming) return
    try {
      await startExecution(activeTeam.id, taskInput)
      toast({ title: 'Team 任务已派发', description: '实时进度见上方面板' })
      setTaskInput('')
    } catch (err) {
      toast({ title: '派发失败', description: String(err), variant: 'destructive' })
    }
  }

  // 讨论模式：调 startDiscussion，立即返回 executionId，SSE 推讨论消息
  const handleDiscuss = async () => {
    if (!activeTeam || !taskInput.trim() || streaming) return
    try {
      await startDiscussion(activeTeam.id, taskInput, {
        rounds: 2,
        members: activeTeam.members.map(m => ({ agentId: m.agentId, role: m.role })),
      })
      toast({ title: '讨论已开始', description: `${activeTeam.members.length} 位成员将轮流发言` })
      setTaskInput('')
    } catch (err) {
      toast({ title: '讨论启动失败', description: String(err), variant: 'destructive' })
    }
  }

  // 统一提交入口：根据当前 mode 派发
  const handleSubmit = () => {
    if (mode === 'discuss') handleDiscuss()
    else handleExecute()
  }

  if (showCreate) {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        <h1 className="text-xl font-medium">创建新 Team</h1>
        <Input placeholder="Team 名称" value={draftName} onChange={e => setDraftName(e.target.value)} />
        <div>
          <label className="text-sm font-medium">执行策略</label>
          <select
            value={strategy}
            onChange={e => setStrategy(e.target.value as TeamStrategy)}
            className="ml-2 rounded-md border border-input bg-background px-2 py-1 text-sm"
          >
            {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">成员</label>
          <div className="mt-2">
            <TeamMemberDraftList
              members={draftMembers}
              leaderAgentId={draftMembers.find(m => m.isLeader)?.agentId}
              onLeaderChange={(aid) => setDraftMembers(prev => prev.map(m => ({ ...m, isLeader: m.agentId === aid })))}
              onRemove={(aid) => setDraftMembers(prev => prev.filter(m => m.agentId !== aid))}
            />
          </div>
          <div className="mt-2">
            <TeamAddMemberPopover
              assistants={assistants}
              onAdd={(agentId, role) => {
                const agent = agents.find(a => a.id === agentId)
                if (!agent) return
                setDraftMembers(prev => [...prev, { agentId, name: agent.name, role, isLeader: prev.length === 0 }])
              }}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleCreateTeam} disabled={!draftName.trim() || draftMembers.length === 0}>
            创建
          </Button>
          <Button variant="ghost" onClick={() => setShowCreate(false)}>取消</Button>
        </div>
      </div>
    )
  }

  if (!activeTeam) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-medium">Team 协作</h1>
          <Button onClick={() => setShowCreate(true)}>
            <Users className="h-4 w-4 mr-1" />
            新建 Team
          </Button>
        </div>
        {teams.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">
            暂无 Team，点击右上角创建
          </Card>
        ) : (
          <div className="space-y-2">
            {teams.map(t => (
              <Card
                key={t.id}
                className="cursor-pointer p-4 hover:bg-surface-2"
                onClick={() => setActiveTeam(t.id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.members.length} 个成员 · {t.defaultStrategy}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    )
  }

  // 进入具体 Team 工作区
  return (
    <TeamIdentityProvider
      teamId={activeTeam.id}
      assistants={activeTeam.members.map(m => ({ slot_id: m.agentId, is_leader: m.agentId === activeTeam.leadAgentId }))}
    >
      <div className="flex h-full flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-border bg-titlebar-bg px-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // 优先退出 Team 详情；若已在列表层则返回 home
              if (activeTeamId) setActiveTeam(undefined)
              else onClose?.()
            }}
          >
            ←
          </Button>
          <span className="font-medium">{activeTeam.name}</span>
          <span className="text-xs text-muted-foreground">{activeTeam.members.length} 成员 · {activeTeam.defaultStrategy}</span>
          {/* 模式切换：执行 / 讨论 —— streaming 时锁定，防止中途切换 */}
          <div className="ml-auto flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
            <Button
              variant="ghost"
              size="sm"
              className={`h-6 px-2 text-[11px] ${mode === 'execute' ? 'bg-surface-3' : ''}`}
              onClick={() => setMode('execute')}
              disabled={streaming}
              title="派发任务给成员并行/串行执行"
            >
              <Play className="h-3 w-3 mr-1" />
              执行
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`h-6 px-2 text-[11px] ${mode === 'discuss' ? 'bg-surface-3' : ''}`}
              onClick={() => setMode('discuss')}
              disabled={streaming}
              title="成员轮流发言讨论指定话题"
            >
              <MessageSquare className="h-3 w-3 mr-1" />
              讨论
            </Button>
          </div>
        </header>
        <div className="flex-1 overflow-hidden">
          {/* mode 透传：TeamChatView 据此决定渲染执行进度面板还是讨论消息流 */}
          <TeamChatView team={activeTeam} mode={mode} />
        </div>
        <footer className="flex items-center gap-2 border-t border-border bg-statusbar-bg px-4 py-2">
          <Input
            placeholder={mode === 'discuss' ? '输入讨论话题...' : '输入 Team 任务...'}
            value={taskInput}
            onChange={e => setTaskInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !streaming) handleSubmit() }}
            disabled={streaming}
          />
          {streaming ? (
            // 流式进行中：显示停止按钮（调 stopStream 关闭 SSE）
            <Button variant="destructive" size="sm" onClick={() => useTeamStore.getState().stopStream()}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={handleSubmit} disabled={!taskInput.trim()}>
              {mode === 'discuss' ? <MessageSquare className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
          )}
        </footer>
      </div>
    </TeamIdentityProvider>
  )
}
```

- [ ] **步骤 2：编写 `team-chat-view.tsx`（实时进度版）**

**约束：** 不再通过 props 接收 `result`/`executing`——改为直接从 `useTeamStore` 读 SSE 驱动的 `activeExecution` / `memberProgress` / `discussionMessages` / `streaming`。`mode` prop（由 TeamPage 传入）决定渲染执行进度面板还是讨论消息流。成员卡片以 `team.members` 为基准（保证未开始的成员也显示为 pending），与 `memberProgress` 合并出四态：pending / running / done / failed。

```typescript
import { useState } from 'react'
import { CheckCircle2, XCircle, Loader2, Clock, MessageSquare } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTeamIdentity } from './identity/team-identity-context'
import { useTeamStore } from '@/stores/team-store'
import { TeamChatEmptyState } from './team-chat-empty-state'
import { TeamViewToggle, type TeamViewMode } from './team-view-toggle'
import type { TeamConfig, TeamExecutionPhase } from '@/types/team'

/** 与 TeamPage 的 TeamMode 对齐 */
type TeamMode = 'execute' | 'discuss'

interface TeamChatViewProps {
  team: TeamConfig
  mode: TeamMode
}

/** phase → 中文标签（与后端 TeamExecutionPhase 枚举对齐） */
const PHASE_LABEL: Record<TeamExecutionPhase, string> = {
  planning: '规划中',
  executing: '执行中',
  summarizing: '汇总中',
  completed: '已完成',
  failed: '已失败',
}

export function TeamChatView({ team, mode }: TeamChatViewProps) {
  const { colorOf } = useTeamIdentity()
  // 从 store 读 SSE 驱动的实时状态（不再靠 props 传 result）
  const { activeExecution, memberProgress, discussionMessages, streaming } = useTeamStore()
  const [viewMode, setViewMode] = useState<TeamViewMode>('parallel')

  // ─── 讨论模式：渲染讨论消息流 ───
  if (mode === 'discuss') {
    if (discussionMessages.length === 0 && !streaming) {
      return <TeamChatEmptyState teamName={team.name} />
    }
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-surface-1 px-4 py-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">圆桌讨论</span>
          {streaming && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex-1 overflow-auto px-4 py-3">
          <div className="space-y-3">
            {discussionMessages.map((msg, idx) => {
              const color = colorOf(msg.agentId)
              const member = team.members.find(m => m.agentId === msg.agentId)
              const isLeader = msg.agentId === team.leadAgentId
              return (
                <div key={idx} className="flex gap-3">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs text-white"
                    style={{ backgroundColor: color }}
                  >
                    {(member?.agentId ?? '?').slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{member?.agentId ?? msg.agentId}</span>
                      {member?.role && <Badge variant="secondary" className="text-[10px]">{member.role}</Badge>}
                      {isLeader && <Badge variant="outline" className="border-primary text-primary text-[10px]">Leader</Badge>}
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">第 {msg.round} 轮</Badge>
                    </div>
                    <Card className="mt-1 px-3 py-2 text-xs">
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/90">{msg.text}</pre>
                    </Card>
                  </div>
                </div>
              )
            })}
            {streaming && (
              <div className="flex items-center gap-2 pl-11 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>等待下一位成员发言...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ─── 执行模式：渲染实时执行进度 ───
  // 无 execution 且未流式 → 空状态
  if (!activeExecution && !streaming) {
    return <TeamChatEmptyState teamName={team.name} />
  }

  const phase = activeExecution?.phase
  const isDone = phase === 'completed' || phase === 'failed'
  const isSuccess = phase === 'completed'

  // 成员列表：以 team.members 为基准（保证 pending 成员也显示），合并 memberProgress
  const members = team.members.map(m => ({
    member: m,
    progress: memberProgress[m.agentId],
  }))
  const summary = activeExecution?.summary
  const leader = team.members.find(m => m.agentId === team.leadAgentId)

  /** 渲染单个成员卡片内容（pending/running/done/failed 四态） */
  const renderMemberBody = (status: 'pending' | 'running' | 'done' | 'failed', progress?: { lastText?: string; result?: string; error?: string }) => {
    if (status === 'pending') return <p className="text-muted-foreground">等待中...</p>
    if (status === 'running' && progress?.lastText) {
      return <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/70">{progress.lastText}</pre>
    }
    if (status === 'done') {
      return <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/90">{progress?.result ?? '(无输出)'}</pre>
    }
    // failed
    return <p className="text-danger">{progress?.error ?? '执行失败'}</p>
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部状态条：phase + 实时耗时 */}
      <div className="flex items-center justify-between border-b border-border bg-surface-1 px-4 py-2">
        <div className="flex items-center gap-2">
          {streaming && !isDone ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : isSuccess ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : (
            <XCircle className="h-4 w-4 text-danger" />
          )}
          <span className="text-sm font-medium">{phase ? PHASE_LABEL[phase] : '准备中'}</span>
          {activeExecution?.startedAt && (
            <Badge variant="secondary" className="ml-2 text-xs">
              <Clock className="h-3 w-3 mr-1" />
              {(((activeExecution.finishedAt ?? Date.now()) - activeExecution.startedAt) / 1000).toFixed(1)}s
            </Badge>
          )}
        </div>
        <TeamViewToggle value={viewMode} onChange={setViewMode} />
      </div>

      {/* 成员进度流 */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {viewMode === 'parallel' ? (
          // 并行视图：每个成员一列，含 pending/running/done/failed 四态
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(members.length, 4)}, minmax(0, 1fr))` }}>
            {members.map(({ member, progress }) => {
              const color = colorOf(member.agentId)
              const isLeader = member.agentId === team.leadAgentId
              const status = progress?.status ?? 'pending'
              return (
                <Card key={member.agentId} className="overflow-hidden border-l-2" style={{ borderLeftColor: color }}>
                  <div className="flex items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full text-xs text-white" style={{ backgroundColor: color }}>
                      {member.agentId.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{member.agentId}</p>
                      {member.role && <p className="text-[10px] text-muted-foreground">{member.role}</p>}
                    </div>
                    {status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
                    {status === 'done' && <CheckCircle2 className="h-3 w-3 text-success" />}
                    {status === 'failed' && <XCircle className="h-3 w-3 text-danger" />}
                    {isLeader && <Badge variant="outline" className="border-primary text-primary text-[10px]">Leader</Badge>}
                  </div>
                  <div className="px-3 py-2 text-xs">
                    {renderMemberBody(status, progress)}
                  </div>
                </Card>
              )
            })}
          </div>
        ) : (
          // 单列视图：按 team.members 顺序
          <div className="space-y-3">
            {members.map(({ member, progress }) => {
              const color = colorOf(member.agentId)
              const isLeader = member.agentId === team.leadAgentId
              const status = progress?.status ?? 'pending'
              return (
                <div key={member.agentId} className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs text-white" style={{ backgroundColor: color }}>
                    {member.agentId.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{member.agentId}</span>
                      {member.role && <Badge variant="secondary" className="text-[10px]">{member.role}</Badge>}
                      {isLeader && <Badge variant="outline" className="border-primary text-primary text-[10px]">Leader</Badge>}
                      {status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
                      {status === 'done' && <CheckCircle2 className="h-3 w-3 text-success" />}
                      {status === 'failed' && <XCircle className="h-3 w-3 text-danger" />}
                    </div>
                    <Card className="mt-1 px-3 py-2 text-xs">
                      {renderMemberBody(status, progress)}
                    </Card>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Leader 综合结论（summary 事件到达后显示） */}
        {leader && summary && (
          <div className="mt-4 border-t border-border pt-3">
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs text-white" style={{ backgroundColor: colorOf(leader.agentId) }}>
                {leader.agentId.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{leader.agentId}</span>
                  <Badge variant="outline" className="border-primary text-primary text-[10px]">Leader · 综合</Badge>
                </div>
                <Card className="mt-1 bg-surface-1 px-3 py-2 text-xs">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{summary}</pre>
                </Card>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

**关键设计点：**

1. **不再依赖 props.result**——旧版等 `executeTask` 同步返回 `TeamResult` 才渲染；新版从 store 读 SSE 累积的 `memberProgress`，成员状态实时从 pending → running → done/failed 演进。
2. **成员列表以 `team.members` 为基准**——未收到 `member_start` 的成员显示为 `pending`（"等待中..."），避免空白；旧版用 `Object.values(result.memberResults)` 只显示已完成成员。
3. **讨论模式**独立分支——`mode === 'discuss'` 时渲染 `discussionMessages`（来自 `team_discussion_message` 事件），并显示轮次徽章和"等待下一位成员发言"的加载态。
4. **耗时实时计算**——用 `(activeExecution.finishedAt ?? Date.now()) - activeExecution.startedAt`，流式过程中持续增长，结束后冻结。
5. **renderMemberBody 抽出**——并行/单列视图共用同一四态渲染逻辑，避免重复（DRY）。

- [ ] **步骤 3：编写 `team-view-toggle.tsx`**

```typescript
import { Columns, Rows } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type TeamViewMode = 'parallel' | 'single'

interface TeamViewToggleProps {
  value: TeamViewMode
  onChange: (v: TeamViewMode) => void
}

export function TeamViewToggle({ value, onChange }: TeamViewToggleProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
      <Button
        variant="ghost"
        size="sm"
        className={`h-6 px-2 text-[11px] ${value === 'parallel' ? 'bg-surface-3' : ''}`}
        onClick={() => onChange('parallel')}
        title="并行视图"
      >
        <Columns className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={`h-6 px-2 text-[11px] ${value === 'single' ? 'bg-surface-3' : ''}`}
        onClick={() => onChange('single')}
        title="单列视图"
      >
        <Rows className="h-3 w-3" />
      </Button>
    </div>
  )
}
```

- [ ] **步骤 4：编写 `team-chat-empty-state.tsx`**

```typescript
import { Users } from 'lucide-react'

interface TeamChatEmptyStateProps {
  teamName: string
}

export function TeamChatEmptyState({ teamName }: TeamChatEmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Users className="h-10 w-10" />
      <div className="text-center">
        <p className="text-sm font-medium">{teamName} 已就绪</p>
        <p className="text-xs">在下方输入框中描述任务，按 Enter 或点击播放按钮开始执行</p>
      </div>
    </div>
  )
}
```

- [ ] **步骤 5：类型检查**

运行：`pnpm --filter desktop typecheck:web`
预期：通过（若报 `TeamResult.memberResults` 字段不存在，去 `apps/agent-server/src/types/team.ts` 后端类型确认字段名后回填 `apps/desktop/src/renderer/src/types/team.ts`，**不改后端**）

- [ ] **步骤 6：Commit + 标记 Stage 5 完成**

```bash
git add apps/desktop/src/renderer/src/components/team/team-page.tsx \
        apps/desktop/src/renderer/src/components/team/team-chat-view.tsx \
        apps/desktop/src/renderer/src/components/team/team-view-toggle.tsx \
        apps/desktop/src/renderer/src/components/team/team-chat-empty-state.tsx
git commit -m "feat(team): add TeamPage + TeamChatView with parallel/single view toggle"
```

### 任务 5.5：App.tsx 添加 Team 入口

**文件：**
- 修改：`apps/desktop/src/renderer/src/App.tsx`

**约束：** pi-agent 无 react-router，用现有 `AppView` 联合类型扩展；保持已有 home / chat / novel / settings 视图不变。**已核对** `App.tsx` 当前结构：`type AppView = 'home' | 'chat' | 'settings' | 'novel'`，RailButton 接收 `{ icon, label, active, onClick }`，视图切换是嵌套三元表达式。

- [ ] **步骤 1：扩展 `AppView` 类型并渲染 TeamPage**

打开 `apps/desktop/src/renderer/src/App.tsx`，在现有 `AppView` 类型定义中添加 `'team'`：

```typescript
type AppView = 'home' | 'chat' | 'settings' | 'novel' | 'team'  // ← 新增 'team'
```

import 顶部新增（注意 lucide-react 已用于其他 RailButton）：

```typescript
import { Users } from 'lucide-react'
import { TeamPage } from '@/components/team/team-page'
```

在 `<nav>` 的 `<RailButton icon={BookOpen} ... />`（小说创作）之后、`<OnboardingRailButton />` 之前，新增 Team 入口（保持 Novel 之后的位置，让 Team 与 Novel 同属"创作/协作"区）：

```typescript
<RailButton
  icon={Users}
  label="Team 协作"
  active={view === 'team'}
  onClick={() => setView('team')}
/>
```

在视图切换的嵌套三元表达式中，找到 `view === 'novel'` 分支之后、`view === 'chat'` 分支之前（或在最末尾的 `: null` 之前），新增 `team` 分支：

```typescript
) : view === 'team' ? (
  <TeamPage onClose={() => setView('home')} />
) : view === 'chat' ? (
```

**注意：** `TeamPage` 的签名已在任务 5.4 中定义为 `TeamPage({ onClose }: TeamPageProps = {})`，无需在此任务再次修改。返回按钮的逻辑是：若在 Team 详情层则退回列表层，若在列表层则调用 `onClose` 返回 home。

- [ ] **步骤 2：验证构建**

运行：`pnpm --filter desktop typecheck:web`
预期：通过

运行：`cd apps/desktop && pnpm dev`
预期：开发服务启动，左侧 Rail 在"小说创作"后出现"Team 协作"入口，点击进入 Team 列表空状态

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(team): wire TeamPage into App rail (no router)"
```

### 任务 5.6：Stage 5 验收清单

**后端（任务 5.0）：**

- [ ] `POST /api/teams/:id/execute` 立即返回 `{ executionId, teamId }`，不阻塞
- [ ] `GET /api/teams/executions/:eid/stream` 返回 `text/event-stream`，先推 `snapshot` 再推 `phase` / `member_start` / `member_progress` / `member_done` / `summary` / `done` 事件
- [ ] 客户端断开 SSE 时，后端 `eventBus.off(topic, handler)` 清理订阅（无悬挂监听器）
- [ ] `POST /api/teams/:id/discuss` 立即返回 `{ executionId, teamId }`，讨论消息通过同一 SSE 端点的 `team_discussion_message` 事件推送
- [ ] `team-discussion-engine.ts` 的现有签名未被修改（只新增薄路由层）
- [ ] `execute()` 旧同步 API 仍可被现有调用方使用（向后兼容）

**前端（任务 5.1-5.5）：**

- [ ] 点击 Rail 的 Team 入口，能进入 TeamPage 空状态
- [ ] 点击"新建 Team"，填写名称 / 策略 / 成员，能成功创建
- [ ] 点击 Team 卡片进入详情，能看到 header（名称 + 成员数 + 策略 + 执行/讨论切换）和 footer 输入栏
- [ ] 输入任务并点播放（执行模式），能实时看到成员卡片从 `pending`（等待中）→ `running`（spinner + 最新进度文本）→ `done`（✓ + 结果）/ `failed`（✗ + 错误）四态演进
- [ ] 顶部状态条显示当前 phase（规划中/执行中/汇总中/已完成/已失败）+ 实时耗时（秒数持续增长，结束后冻结）
- [ ] 流式进行中 footer 显示红色停止按钮，点击后 SSE 关闭、`streaming` 归 false
- [ ] 切换到并行视图，成员按多列网格展示；切换到单列视图，按 `team.members` 顺序展示
- [ ] `summary` 事件到达后，Leader 综合结论显示在底部
- [ ] 切换到讨论模式，输入话题并派发，能看到成员轮流发言（带轮次徽章），流式中显示"等待下一位成员发言..."
- [ ] 切换 Team 或重新派发时，上一次的 SSE 流被 `stopStream()` 关闭（无多个连接并发）
- [ ] 成员颜色在刷新页面后保持稳定（localStorage 持久化）
- [ ] 不修改任何 `novel-*` 文件、`plugins/novel-plugin/**` 文件

---
