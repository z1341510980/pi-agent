# pi-agent 前端设计体系

> 本文档定义 pi-agent 桌面应用的**完整前端设计体系**，涵盖设计语言、布局系统、组件体系、
> 交互设计、状态管理、通信层、动画规范、无障碍、性能策略与开发路线图。
>
> 面向角色：前端工程师 / UI 设计师 / 全栈工程师。
>
> **参考风格**：WorkBuddy · Cursor · VS Code · 主流 AI 桌面助手
>
> **前置文档**：[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) · [`PROJECT_SPEC.md`](../PROJECT_SPEC.md)
> **旧版参考**：[`docs/FRONTEND_DEVELOPMENT.md`](./FRONTEND_DEVELOPMENT.md)（已被本文替代）

---

## 目录

- [第一章 设计语言](#第一章-设计语言)
- [第二章 布局系统](#第二章-布局系统)
- [第三章 组件体系](#第三章-组件体系)
- [第四章 页面设计](#第四章-页面设计)
- [第五章 交互设计](#第五章-交互设计)
- [第六章 状态管理](#第六章-状态管理)
- [第七章 通信层](#第七章-通信层)
- [第八章 交互动画规范](#第八章-交互动画规范)
- [第九章 无障碍](#第九章-无障碍)
- [第十章 性能策略](#第十章-性能策略)
- [第十一章 开发路线图](#第十一章-开发路线图)
- [附录](#附录)

---

## 第一章 设计语言

### 1.1 设计理念

pi-agent 的视觉设计遵循 **"专注、可信、流畅"** 三原则：

| 原则 | 含义 | 体现 |
|------|------|------|
| **专注** | 用户注意力在 Agent 对话，UI 不抢戏 | 低视觉噪点、克制配色、大面积留白 |
| **可信** | 用户需要对 Agent 的操作有掌控感 | 状态可见、权限模式常驻、操作可追溯 |
| **流畅** | 交互节奏自然、无突兀跳跃 | 细腻动效、流式渲染、即时反馈 |

### 1.2 参考风格

主流 AI 桌面助手的共有特征：

```
┌─────────────────────────────────────────────────────────────┐
│                       主流 AI 助手设计趋势                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  • 浅色主题优先：默认浅色，提供深色切换（AI 工具通常长时间使用，浅色下可读性更好）  │
│  • 三栏布局：导航栏 | 主内容 | 上下文面板                    │
│  • 自定义标题栏：macOS 风格图标 + 拖拽区                    │
│  • 底部状态栏：连接状态 · Agent/模型 · 权限模式 · token 计数 │
│  • 流式消息气泡：逐字渲染，打字指示器可见                   │
│  • 思考/推理块：默认折叠，可展开（Claude-style）            │
│  • 工具调用卡片：实时状态，可展开详情                       │
│  • 命令面板：Cmd+K 全局搜索/执行                            │
│  • 确认浮层：不打断流式输出的非阻塞模式                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

pi-agent 在此基础上形成自己的设计语言：**更克制、更透明、更具桌面原生感**。

### 1.3 色彩系统

#### 1.3.1 基础色板

采用 Tailwind v4 CSS 变量体系，**light-first 设计**（默认浅色）：

```css
/* ── 核心语义色（默认浅色） ── */
:root {
  --color-background: #ffffff;      /* 应用根背景 */
  --color-foreground: #1a1d23;      /* 正文主色 */

  --color-primary: #3b82f6;          /* 主色（消息/按钮/链接） */
  --color-primary-foreground: #ffffff;

  --color-secondary: #f5f6f8;       /* 次要背景 */
  --color-secondary-foreground: #1a1d23;

  --color-muted: #f5f6f8;           /* 弱化背景 */
  --color-muted-foreground: #7e8794; /* 弱化文字 */

  --color-accent: #eef0f3;          /* 强调背景 */
  --color-accent-foreground: #1a1d23;

  --color-destructive: #dc2626;     /* 危险/错误 */
  --color-destructive-foreground: #ffffff;

  --color-border: #e2e5eb;          /* 边框 */
  --color-input: #dce0e6;           /* 输入框边框 */
  --color-ring: #3b82f6;            /* focus ring */
}
```

#### 1.3.2 应用语义色

```css
/* ── 应用语义色（默认浅色） ── */
--color-app-bg: #fafbfc;          /* 应用背景 */
--color-surface-1: #f5f6f8;       /* 面板基底（侧栏/副面板） */
--color-surface-2: #eef0f3;       /* 卡片/区块背景 */
--color-surface-3: #e2e5eb;       /* 悬停/高亮 */
--color-border-strong: #c9cfd8;   /* 强边框 */
--color-text: #1a1d23;            /* 正文 */
--color-subtle: #7e8794;          /* 辅助文字 */
--color-primary-strong: #2563eb;  /* 强主色 */
--color-success: #16a34a;         /* 成功（连接状态/工具完成） */
--color-danger: #dc2626;          /* 危险/错误 */
```

#### 1.3.3 标题栏语义色

```css
/* ── 标题栏语义色（默认浅色） ── */
--color-titlebar-bg: #f0f1f4;       /* 标题栏背景 */
--color-titlebar-border: #dce0e6;  /* 标题栏边框 */
```

#### 1.3.4 状态栏语义色

```css
/* ── 状态栏语义色（默认浅色） ── */
--color-statusbar-bg: #f0f1f4;     /* 状态栏背景 */
--color-statusbar-border: #dce0e6; /* 状态栏边框 */
```

#### 1.3.5 消息语义色

| 语义 | CSS 变量 / 值 | 用途 |
|------|--------------|------|
| 用户消息 | `--color-primary` #3b82f6 | 用户气泡背景 |
| 用户文字 | `--color-primary-foreground` #ffffff | 用户气泡文字 |
| 助手消息 | `--color-surface-2` | 助手气泡背景 |
| 思考块 | `--color-border-strong` 边框 + 紫色强调 | 推理过程 |
| 工具调用 | `--color-accent` 背景 + 橙色标志 | 工具执行卡片 |
| 危险操作 | `--color-destructive` #ff6b6b | 确认弹窗/错误 |
| 成功状态 | `--color-success` #2fd17c | 连接正常/工具完成 |
| 连接状态 | 绿/黄/红点 | 连接健康度 |

#### 1.3.6 Dark 主题切换

默认浅色，通过 `data-theme` 属性或系统偏好切换为深色：

```css
/* ── Dark 主题语义映射 ── */
[data-theme="dark"],
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-background: #101216;
    --color-foreground: #eef1f5;
    --color-app-bg: #101216;
    --color-surface-1: #171a20;
    --color-surface-2: #1d222b;
    --color-surface-3: #242a35;
    --color-border: #303744;
    --color-border-strong: #485162;
    --color-input: #303744;
    --color-text: #eef1f5;
    --color-subtle: #768294;
    --color-secondary: #1d222b;
    --color-secondary-foreground: #eef1f5;
    --color-muted: #1d222b;
    --color-muted-foreground: #a9b2c1;
    --color-accent: #1d222b;
    --color-accent-foreground: #eef1f5;
    --color-destructive: #ff6b6b;
    --color-destructive-foreground: #ffffff;
    --color-success: #2fd17c;
    --color-titlebar-bg: #0d0f13;
    --color-titlebar-border: #202630;
    --color-statusbar-bg: #0d0f13;
    --color-statusbar-border: #202630;
  }
}

/* ── 显式切换（通过 UI 切换按钮） ── */
[data-theme="dark"] {
  /* 同上所有 dark 值，覆盖默认 light */
}
[data-theme="light"] {
  /* 恢复默认浅色值 */
}
```

### 1.4 排版系统

#### 1.4.1 字体族

```css
--font-sans: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI',
             Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans',
             'Droid Sans', 'Helvetica Neue', sans-serif;

--font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code',
             'SF Mono', Consolas, 'Courier New', monospace;
```

- **Inter**：主字体，无衬线，屏幕阅读优化
- **等宽字体**：代码块/命令行/工具参数

#### 1.4.2 字号阶

| 名称 | 值 | 用途 |
|------|-----|------|
| `text-[11px]` | 11px | 辅助信息（时间戳/元数据/标签） |
| `text-xs` | 12px | 次要文字（状态栏/说明/小标签） |
| `text-sm` | 13px | 正文/消息气泡 |
| `text-base` | 14px | 大正文/表单 |
| `text-lg` | 16px | 强调文字 |
| `text-xl` | 20px | 二级标题 |
| `text-[22px]` | 22px | 页面大标题（工作台头部） |
| `text-3xl` | 32px | 空状态/大数字 |

#### 1.4.3 字重映射

```css
/* 字重规范（Inter 支持） */
--font-weight-regular: 400;    /* 正文 */
--font-weight-medium: 500;     /* 强调 */
--font-weight-bold: 700;       /* 小标题 */
--font-weight-extrabold: 800;  /* 大标题/徽标 */

/* Tailwind 中常用 */
font-[760]  /* Font weight 760 — 主标题 */
font-[780]  /* Font weight 780 — 大标题/Logo */
```

#### 1.4.4 行高

| 场景 | 行高 |
|------|------|
| 正文/消息 | 1.6 |
| 标题/卡片标题 | 1.3 |
| 密集信息（侧栏） | 1.4 |
| 代码块 | 1.5 |

### 1.5 间距与布局网格

采用 **4px 原子单位**（Tailwind 默认）：

| 间距名 | 值 | 场景 |
|--------|-----|------|
| `gap-1` / `gap-1.5` | 4px / 6px | 微小间距（图标旁/标签内） |
| `gap-2` / `gap-2.5` | 8px / 10px | 组件内间距 |
| `gap-3` / `gap-3.5` | 12px / 14px | 组件间间距 |
| `gap-4` | 16px | 区域间距 |
| `gap-5` | 20px | 大区块间距 |
| `p-3` / `p-3.5` | 12px / 14px | 卡片内边距 |
| `p-4` / `p-5` | 16px / 20px | 面板内边距 |
| `px-5` | 20px | 消息流/输入区水平边距 |

### 1.6 圆角体系

```css
--radius-sm: 6px;     /* 小型圆角（按钮/标签） */
--radius-md: 8px;     /* 默认圆角（卡片/输入框） */
--radius-lg: 10px;    /* 大型圆角（弹窗/面板） */
--radius-xl: 14px;    /* 消息气泡用户侧 */
```

### 1.7 阴影体系

| 层级 | 阴影 | 用途 |
|------|------|------|
| 基础 | 无阴影 | 平面卡片 |
| 抬高 | 1px 边框 | 卡片/面板 |
| 浮层 | `shadow-lg` + 边框 | 弹窗/命令面板 |
| 强调 | `shadow-[0_0_0_4px_rgba(...)]` | 连接状态圆点 |

### 1.8 图标系统

- **Lucide React**（tree-shakeable，与 shadcn/ui 同源）
- 图标规格：`h-3.5 w-3.5`（14px）用于按钮内联；`h-4 w-4`（16px）用于独立图标
- 所有图标必须配 `aria-label`（功能性）或 `aria-hidden`（装饰性）
- Agent 头像用首字母或 emoji，自主设计风格

---

## 第二章 布局系统

### 2.1 应用壳层（App Shell）

```
┌─────────────────────────────────────────────────────────────────┐
│ 自定义标题栏（40px）[draggable]    [π] pi-agent  [─][□][×]     │
├──────┬──────────────────────────────────────────────┬──────────┤
│      │  运行状态栏（44px）                            │          │
│      │  [●] Agent Server online · [●] WS 已连接      │          │
│      │──────────────────────────────────────────────│          │
│      │                                              │          │
│ 侧栏  │                                              │  上下文  │
│ 272px │          消息流（MessageStream）              │  328px   │
│ (可   │                                              │  (可     │
│ 折叠) │  ┌──────────────────────────────────────┐   │  折叠)   │
│       │  │ 输入区 / Steer 模式 / 用量提示        │   │          │
│       │  └──────────────────────────────────────┘   │          │
├──────┴──────────────────────────────────────────────┴──────────┤
│ 状态栏（32px）[●] online · Agent: pi · claude-sonnet-4 · [Auto]  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 自定义标题栏

桌面原生体感而非 Web 体感：

| 特性 | 实现 |
|------|------|
| 高度 | 40px（`--titlebar-height: 40px`） |
| 背景 | `--color-titlebar-bg: #0d0f13` |
| 拖拽区 | `-webkit-app-region: drag`（除窗口控件外） |
| 窗口控件 | 自定义三个按钮（最小化/最大化/关闭），`-webkit-app-region: no-drag` |
| Logo | 16px 圆角框 + π 符号 |
| 会话名 | 居中的当前会话标题或应用名 |

参考：WorkBuddy 标题栏 · VS Code 自定义标题栏 · macOS 风格交通灯

### 2.3 三栏工作台布局

```css
/* 核心 Grid 定义（chat-workspace.tsx） */
.grid-cols-[var(--sidebar-width)_minmax(480px,1fr)_var(--context-width)]

--sidebar-width: 272px;    /* 侧栏 */
--context-width: 328px;    /* 上下文面板 */
```

| 区域 | 宽度 | 最小 | 特性 |
|------|------|------|------|
| 侧栏（Sidebar） | 272px | — | 可折叠到 0，带边框分割 |
| 中栏（Main） | `minmax(480px, 1fr)` | 480px | 自适应撑满 |
| 上下文面板（Context） | 328px | — | 可折叠到 0，带边框分割 |

### 2.4 响应式适配

| 窗口宽度 | 布局 | CSS 规则 |
|----------|------|----------|
| ≥ 1100px | 三栏全显 | 默认 |
| 760-1100px | 双栏（侧栏 + 中栏，上下文面板隐藏） | `.context-panel { display: none }` `.workspace-grid: grid-cols-[236px_minmax(0,1fr)]` |
| < 760px | 单栏（侧栏隐藏） | `.sidebar { display: none }` `.workspace-grid: grid-cols-[minmax(0,1fr)]` |

### 2.5 全局状态栏

32px 底部状态栏，始终可见，聚合运行时状态：

```typescript
// 状态栏构成（chat-workspace.tsx）
// [连接状态] · Agent: pi · claude-sonnet-4 · [Auto] · WS: 已连接 · provider
```

| 区段 | 实现 | 数据源 |
|------|------|--------|
| 连接状态圆点 | `size-[9px] rounded-full bg-success/bg-danger` + 阴影发光 | `healthQuery` (TanStack Query) |
| Server 状态 | `health.status` / 错误信息 | `GET /api/health` (10s 轮询) |
| 权限模式 | `<PermissionModeSwitch compact />` | Zustand 状态 |
| WS 状态 | '已连接' / '连接中' / '已断开' | `useWebSocket` hook |
| 模型摘要 | 'provider · model' | localStorage 配置 |

### 2.6 状态指示器规范

连接状态圆点统一规范（通过 CSS 变量自动适配浅色/深色主题）：

| 状态 | 颜色 | 阴影 |
|------|------|------|
| online / connected | `bg-[var(--color-success)]`#16a34a(dark: #2fd17c) | `shadow-[0_0_0_4px_var(--color-success)_at_16%]` |
| connecting / checking | `bg-[#f2c14e]` 琥珀色 | `shadow-[0_0_0_4px_rgba(242,193,78,0.16)]` |
| offline / error | `bg-[var(--color-danger)]` #dc2626(dark: #ff6b6b) | `shadow-[0_0_0_4px_var(--color-danger)_at_16%]` |
| idle / not running | `bg-[var(--color-muted-foreground)]` | 无阴影 |

---

## 第三章 组件体系

### 3.1 组件分层

```
apps/desktop/src/renderer/src/
├── components/
│   ├── ui/            # shadcn/ui 基础组件（generated，不可手动编辑）
│   ├── chat/          # 对话工作台专用组件
│   ├── settings/      # 设置中心专用组件
│   ├── overlays/      # 浮层系统组件（命令面板/通知/DevLog）
│   └── shared/        # 跨模块通用业务组件
├── hooks/             # 自定义 React Hooks（通信/流式/快捷键）
├── stores/            # Zustand stores
├── lib/               # 工具函数（API 客户端/WS 客户端/解析器）
├── api/               # HTTP API 客户端层
├── routes/            # 路由组件
└── types/             # 前端专用类型
```

### 3.2 基础组件（shadcn/ui）

通过 `pnpm dlx shadcn@latest add` 安装，不可手动编辑。当前已安装：

| 组件 | 路径 | 用途 |
|------|------|------|
| `Button` | `ui/button.tsx` | 按钮系统（默认/secondary/ghost/destructive/size 变体） |
| `Input` | `ui/input.tsx` | 文本输入 |
| `Label` | `ui/label.tsx` | 表单标签 |
| `Select` | `ui/select.tsx` | 下拉选择 |
| `Dialog` | `ui/dialog.tsx` | 模态对话框（用途：确认/警告） |
| `Tabs` | `ui/tabs.tsx` | 标签页切换（用途：上下文面板/设置） |
| `Badge` | `ui/badge.tsx` | 徽章（用途：未读/状态） |
| `Alert` | `ui/alert.tsx` | 提示条（用途：错误/警告/成功） |

**使用规约**：
- 不允许在 ui/ 下直接修改生成的组件；定制通过 className 注入
- 所有 shadcn button 统一使用 `cn()` 工具合并 className

### 3.3 对话组件

#### 3.3.1 ChatWorkspace（工作台壳层）

```
路径: components/chat/chat-workspace.tsx
职责: 整个工作台的编排容器（标题栏+侧栏+消息流+输入区+上下文面板+状态栏）
```

**Props**:
```typescript
interface ChatWorkspaceProps {
  appName: string
  config: BrowserConfig
}
```

**内部状态**：
- 侧栏：会话列表（localStorage 持久化）、Agent 切换
- 中栏：消息流状态（`MessageStreamState`）、流式运行
- 右栏：`'context' | 'provider'` 标签切换
- 全局：`healthQuery`（10s 轮询）、`wsStatus`、`isRunning`

**CSS Grid 结构**：
```tsx
<div className="grid grid-rows-[var(--titlebar-height)_minmax(0,1fr)_var(--statusbar-height)]">
  <header> {/* Title bar */} </header>
  <div className="grid grid-cols-[var(--sidebar-width)_minmax(480px,1fr)_var(--context-width)]">
    <nav>    {/* Sidebar */} </nav>
    <main>   {/* Message stream + Input */} </main>
    <aside>  {/* Context panel */} </aside>
  </div>
  <footer>  {/* Status bar */} </footer>
</div>
```

#### 3.3.2 MessageStream（消息流）

```
路径: components/chat/message-stream.tsx
职责: 渲染消息列表 + 流式指示器 + 错误卡片 + 空状态
```

**Props**:
```typescript
interface MessageStreamProps {
  messages: ChatMessage[]
  isStreaming: boolean
  streamError: string | null
  onRetry?: () => void
  onDismissError?: () => void
}
```

**三态实现**：
- **Loading**：`isStreaming && isEmpty` → `<StreamingIndicator />`（三点呼吸动画）
- **Error**：`streamError !== null` → `<ErrorCard message={...} onRetry={...} />`
- **Empty**：`messages.length === 0 && !isStreaming && !streamError` → `<EmptyState />`

**自动滚动策略**：
```typescript
// 用户手动滚动后停止跟随，仅在底部时持续跟随
const [autoScroll, setAutoScroll] = useState(true)
useEffect(() => { if (autoScroll) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [messages, isStreaming, autoScroll])
```

**消息宽度**：`max-w-[720px] mx-auto`（保证可读行宽）

#### 3.3.3 MessageBubble（消息气泡）

```
路径: components/chat/message-bubble.tsx
职责: 单条消息渲染——区分用户/助手/思考块/工具调用
```

**用户消息**：右对齐，`bg-primary` 蓝色气泡，`border-radius: 14px 14px 4px 14px`
**助手消息**：左对齐，带 Agent 头像，`bg-surface-2` 灰色气泡，Markdown 渲染
**思考块**：默认折叠，紫色边框，显示字数和耗时
**工具调用**：橙色状态卡，三态显示（pending/running/success/error）

**消息类型矩阵**：

| 消息类型 | 视觉形态 | 渲染组件 |
|----------|----------|----------|
| 用户消息 | 右对齐蓝色气泡 | inline in `MessageBubble` |
| 助手文本 | 左对齐 + 头像 | `react-markdown` 渲染 |
| 思考块 | 折叠卡片，紫色边框 | `<ThinkingBlock>` |
| 工具调用 | 可展开卡片，橙色标志 | `<ToolCallCard>` |
| 确认请求 | 红色边框嵌入式卡片 | `<ConfirmationDialog>` |
| 中途引导 | 黄色边框 + ⚡ 图标 | inline in `MessageBubble` |
| 压缩通知 | 顶部横幅 | inline in `ChatWorkspace` |
| 错误卡片 | 红色边框 + 重试按钮 | `<ErrorCard>` |

#### 3.3.4 ThinkingBlock（思考块）

```
路径: components/chat/thinking-block.tsx
```

**设计**：
- 默认折叠，只显示 `💭 思考过程 · 2.3s · 480 字 ▸ 展开查看`
- 展开后显示完整推理文本，紫色辅助文字
- 流式时若用户已展开，实时滚动追加
- `prefers-reduced-motion` 时无动画展开/折叠

#### 3.3.5 ToolCallCard（工具调用卡）

```
路径: components/chat/tool-call-card.tsx
```

**状态机**：`pending → running → success / error / blocked / denied`

**通用结构**：
```
┌─ 🔧 {toolName} ─────── {status icon} ──┐
│ {摘要：文件路径/命令/查询词}              │
│ ──────────────────────────────────────  │
│ {执行状态/进度}                          │
│ ▾ 展开查看详情                            │
└──────────────────────────────────────────┘
```

**工具类型差异化**：

| 工具类型 | 卡片形态 | 差异点 |
|----------|----------|--------|
| read | 文件预览卡 | 文件路径 + 行数 + 可展开内容 |
| bash | 终端卡 | 等宽字体 + 可滚动输出 |
| edit/write | Diff 卡 | 红绿对比（规划） |
| grep | 搜索结果卡 | 匹配行高亮 + 文件分组 |
| web_search | 搜索结果卡 | 标题 + 摘要 + URL |
| web_fetch | 网页预览卡 | 标题 + 正文摘要 |
| memory_search | 记忆卡 | 匹配事实列表 |

#### 3.3.6 InputArea（输入区）

```
路径: components/chat/input-area.tsx
```

**Props**:
```typescript
interface InputAreaProps {
  onSend: (text: string) => void
  onAbort: () => void
  isRunning: boolean
  disabled?: boolean
  placeholder?: string
  value?: string    // 受控（支持草稿持久化）
  onChange?: (text: string) => void
}
```

**交互**：
- `Enter` 发送，`Shift+Enter` 换行
- 运行中：发送按钮变为中断按钮（destructive 变体 + Square 图标）
- 空消息禁用发送
- 自适应高度（`scrollHeight` 自动撑高，上限 200px）
- 草稿持久化：通过受控 `value`/`onChange` 对接 localStorage

**Steer 模式**（规划）：
- Agent 运行中，输入区提示横幅 `⚡ Agent 运行中 — 你可以追加指令`
- 输入框 placeholder 变为"追加指令..."
- 发送的消息以黄色边框 + ⚡ 图标显示在消息流

#### 3.3.7 StreamingIndicator（流式指示器）

```
路径: components/chat/streaming-indicator.tsx
```

- 三点呼吸动画，CSS keyframes loop（1200ms），实现 `@keyframes pulse-opacity`
- 文字：`正在思考...`
- 位于消息流末尾，新消息到达时被顶替
- 绝不允许"无反馈的卡顿"——任何超过 500ms 的等待都要有视觉反馈

### 3.4 状态组件（规划）

| 组件 | 用途 | 状态覆盖 |
|------|------|----------|
| `<Skeleton>` | 加载占位（shadcn/ui） | 列表/卡片加载 |
| `<EmptyState>` | 空状态 | 无会话/无消息/无工具 |
| `<ErrorState>` | 错误+重试 | API 错误 |
| `<LoadingDots>` | 流式占位 | 思考中/等待中 |
| `<ProgressIndicator>` | 工具执行进度 | 运行中/完成 |

**三态组件模式**（强制遵守）：
```tsx
function ExampleList() {
  const { data, isLoading, isError, error, refetch } = useQuery(...)

  if (isLoading) return <Skeleton className="..." />
  if (isError) return <ErrorState error={error} onRetry={refetch} />
  if (!data?.length) return <EmptyState
    icon="inbox"
    title="还没有数据"
    description="开始使用后这里会显示..."
    action={<Button onClick={handleStart}>开始</Button>}
  />

  return <List items={data} />
}
```

### 3.5 设置组件（规划）

| 组件 | 用途 |
|------|------|
| `SettingsLayout` | 左侧导航 + 右侧内容 |
| `ProviderForm` | Provider 增删改查 + API Key 测试 |
| `AgentForm` | Agent 编辑（模型/人格/工具开关） |
| `UsagePanel` | 用量图表（Recharts） |
| `MemoryPanel` | 记忆编译状态 + 事实库 |

---

## 第四章 页面设计

### 4.1 对话工作台

#### 4.1.1 侧栏（Sidebar）

**结构**：
```
Agent 切换器 [pi ▾]              [+ 新建]
搜索框 🔍
──────────────────────────
今天
  · 重构认证模块   14:32  ●
  · 调试 SSE       11:08
  · (无标题)       09:15
──────────────────────────
昨天
  · 设计记忆系统   18:44
```

**技术要点**：
- 搜索框实时过滤（`filter + toLowerCase().includes()`）
- 活跃会话蓝色左边框（`border-l-2 border-primary`）
- 会话项三部分：标题（font-[760]）+ 预览（text-muted）+ 时间（text-subtle text-[11px]）
- localStorage 持久化（`pi-agent.sessions`）

#### 4.1.2 运行状态栏

位于消息流上方 44px 区域，聚合连接状态：

```
[●] Agent Server online · [●] WS: 已连接 · [●] AG-UI: {baseUrl}
```

三个状态指示器并列，统一圆点 + 阴影规范。

#### 4.1.3 上下文面板（Context Panel）

右侧 328px 面板，Tabs 切换：

| 标签 | 内容 |
|------|------|
| 上下文 | 模型摘要 · 权限模式 · 工具调用列表 · 里程碑 |
| Provider | ProviderBootstrap 配置表单 |

**工具调用列表（规划）**：实时显示当前会话的工具执行记录，支持清空。

---

## 第五章 交互设计

### 5.1 流式输出体验

流式输出的核心目标是**让用户忘记自己在等**。

```
用户发送消息
  → 消息立即出现在消息流（用户气泡）
  → SSE 连接建立（POST /ag-ui/runs）
  → RUN_STARTED → 创建空 assistant 消息 + 三点指示器
  → TEXT_MESSAGE_CONTENT (delta) → streamingBuffer 追加 → 实时渲染
  → TOOL_CALL_START → 新建工具调用卡（running 状态）
  → STEP_STARTED → 工具卡状态变 running + spinner
  → STEP_FINISHED → 工具卡 ✓ 成功
  → RUN_FINISHED → 消息标记 complete
```

**关键实现**（`applyEvent` in message-stream.tsx）：
- 所有 AG-UI 事件通过 `MessageStreamState.applyEvent()` 纯函数处理
- `streamingBuffer` 累积 TEXT_MESSAGE_CONTENT 的 delta
- `THINKING_TEXT_MESSAGE_CONTENT` / `REASONING_MESSAGE_CONTENT` 追加到 `thinking.content`
- `STEP_STARTED` / `STEP_FINISHED` 管理工具的 running/success 状态
- `RUN_FINISHED` 将 `streamingBuffer` 写入 `content`

### 5.2 工具确认流程

```
Agent 调用危险工具
  → WebSocket 推送 confirmation_request
  → 前端顶部通知 + ConfirmationDialog 浮层（双通道）
  → 工具执行暂停（后端等待）
  → 用户点击 [批准] / [拒绝]
  → WebSocket 发送 confirm 事件
  → 后端继续执行或返回 GATE_DENIED
```

**设计要点**：
- **非阻塞**：确认浮层不切断正在进行的流式输出
- **风险分级**：safe（绿色/自动）/ moderate（橙色/Plan 模式需确认）/ dangerous（红色/始终确认）
- **超时处理**：5 分钟无响应自动拒绝

### 5.3 中途引导（Steer）

Agent 正在运行时，输入区切换为 steer 模式：

状态变化：
1. 输入区顶部出现提示横幅 `⚡ Agent 运行中 — 你可以追加指令`
2. 输入框 placeholder 变为"追加指令..."
3. 发送按钮变为"追加指令"文本
4. 发送的消息以黄色边框 + ⚡ 图标标记（区别于普通用户消息）
5. 通过 Pi SDK `session.steer()` 注入消息（不中断流式）

### 5.4 上下文压缩

当 token 用量达到 80% context window 时触发：

1. 后端触发 compaction，通过 WebSocket 推送 `session:compacted` 事件
2. 前端显示压缩横幅（紫色，嵌入消息流顶部）
3. 上下文面板实时更新 token 用量
4. 压缩完成后显示 `98k → 42k tokens · 缓存已重置`
5. 用户可点击"查看详情"了解压缩影响

### 5.5 键盘导航

所有核心操作有快捷键（§9.3 快捷键全表）。

关键模式：
- `Cmd/Ctrl+K` — 命令面板（类似 VS Code/Raycast）
- `Cmd/Ctrl+N` — 新建会话
- `Cmd/Ctrl+,` — 设置
- `Esc` — 中断/关闭浮层
- `Enter` — 发送（输入框焦点时）
- `Shift+Enter` — 换行

### 5.6 微交互清单

| 触发 | 反馈 |
|------|------|
| 按钮 hover | 背景色变化 + 轻微上移 (translateY -1px) |
| 按钮 press | 缩放 0.97（`whileTap`） |
| 卡片 hover | 边框色加深 |
| 输入框 focus | 边框 + `ring-[3px] ring-primary/20` |
| 复制成功 | 图标变化（规划） |
| 连接状态变化 | 圆点颜色 + 阴影切换 |
| 发送按钮 → 中断按钮 | 图标 + 颜色 + 文字同步切换 |

---

## 第六章 状态管理

### 6.1 状态分层

```
TanStack Query (服务端状态)
├── 会话列表、Agent 列表、Provider 列表
├── 用量数据、记忆数据
├── 健康检查（10s 轮询）
└── 自动缓存、重试、后台刷新

Zustand (客户端状态) [规划]
├── sessionStore: 当前会话/Agent/模型/消息流/运行状态
├── uiStore: 面板折叠/主题/浮层/通知/确认队列
└── connectionStore: 连接状态/WS/SSE

React 组件 state (局部状态) [已实现]
├── 输入框内容、折叠展开、悬停
├── 会话列表（localStorage 持久化）
├── 消息流状态（MessageStreamState）
└── 草稿（localStorage 持久化）
```

### 6.2 当前实现状态

当前处于 **F1 阶段**，状态管理以 React `useState` + `useCallback` 为主：

```typescript
// chat-workspace.tsx 中的状态：
const [sessions, setSessions] = useState<SessionSummary[]>(() => loadSessions())
const [activeThreadId, setActiveThreadId] = useState<string>(...)
const [sessionSearch, setSessionSearch] = useState('')
const [sessionMessages, setSessionMessages] = useState<Record<string, MessageStreamState>>(...)
const [drafts, setDrafts] = useState<Record<string, string>>(...)
const [rightPanel, setRightPanel] = useState<'context' | 'provider'>('context')
```

### 6.3 规划：Zustand Store

**sessionStore**：
```typescript
interface SessionStore {
  currentSessionId: string | null
  currentAgentId: string
  currentModelRef: { id: string; provider: string } | null
  sessions: SessionSummary[]
  isRunning: boolean
  currentRunId: string | null
  steerQueue: SteerMessage[]
  permissionMode: 'auto' | 'plan' | 'readonly'
  messages: Message[]
  streamingMessage: StreamingMessage | null
}
```

### 6.4 规划：TanStack Query Key 约定

```typescript
const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: string) => ['sessions', id] as const,
  agents: ['agents'] as const,
  providers: ['providers'] as const,
  models: ['models'] as const,
  usage: (filter: UsageFilter) => ['usage', filter] as const,
  memory: (agentId: string) => ['memory', agentId] as const,
}
```

---

## 第七章 通信层

### 7.1 三层通信架构

```
┌─────────────────────────────────────────────────┐
│ React 组件层                                    │
│   useStreamingRun()  useWebSocket()  useIpc()   │
├─────────────────────────────────────────────────┤
│ 通信 Hooks 层                                   │
│  · useStreamingRun  — SSE 流式对话（AG-UI）     │
│  · useWebSocket     — WS 推送 + 确认           │
│  · useIpc           — Electron IPC（配置）      │
│  · useApi           — HTTP REST（TanStack）     │
├─────────────────────────────────────────────────┤
│ 底层客户端                                      │
│  · aguiClient (SSE) · wsClient · ipcBridge     │
│  · httpClient (fetch)                          │
└─────────────────────────────────────────────────┘
```

### 7.2 SSE 流式对话（useStreamingRun）

```
路径: hooks/use-streaming-run.ts
```

```typescript
function useStreamingRun(opts: {
  threadId: string
  onEvent: (event: BaseEvent) => void
}): {
  run: (messages: ChatMessage[]) => Promise<void>
  abort: () => void
  isRunning: boolean
  error: Error | null
}
```

**事件流**：
```
RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT (×N) → TEXT_MESSAGE_END
→ TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END
→ (工具执行) → STEP_STARTED → ACTIVITY_SNAPSHOT → STEP_FINISHED
→ TEXT_MESSAGE_START → ... → RUN_FINISHED / RUN_ERROR
```

### 7.3 WebSocket（useWebSocket）

```
路径: hooks/use-websocket.ts
```

```typescript
function useWebSocket(opts: {
  threadId: string
  onMessage: (event: WsServerEvent) => void
}): {
  status: 'connected' | 'connecting' | 'disconnected'
  pendingConfirmation: ConfirmationRequest | null
  respondConfirmation: (id: string, action: 'approve' | 'deny') => void
}
```

**服务端推送事件**：
```typescript
type WsServerEvent =
  | { type: 'confirmation_request'; confirmId: string; tool: string; params: any }
  | { type: 'memory_updated'; agentId: string }
  | { type: 'agent_status'; agentId: string; status: string }
  | { type: 'notification'; title: string; body: string }
  | { type: 'devlog'; text: string; level: string }
```

**重连策略**：指数退避（1s → 2s → 4s → ... → 30s 上限）

### 7.4 Electron IPC（useIpc）

安全敏感操作走 Main 进程（API Key / Provider / 代理）：

```typescript
interface IPCAPI {
  // Provider 配置
  listProviders: () => Promise<ProviderConfig[]>
  saveProvider: (p: ProviderConfig) => Promise<void>
  // API Key（safeStorage）
  setApiKey: (providerId: string, key: string) => Promise<void>
  testApiKey: (providerId: string) => Promise<TestResult>
  // 代理
  getProxy: () => Promise<ProxyConfig>
  setProxy: (config: ProxyConfig) => Promise<void>
  // 自动更新
  checkUpdate: () => Promise<UpdateInfo>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
}
```

---

## 第八章 交互动画规范

### 8.1 动画原则

1. **有意义**：每个动画传达状态变化，不为动而动
2. **快速**：微交互 100-200ms，过渡 200-350ms，绝不超过 500ms
3. **自然**：使用 `cubic-bezier(0.4, 0, 0.2, 1)` 缓动
4. **可中断**：所有动画可被打断重置，不锁死
5. **可降级**：`prefers-reduced-motion` 时关闭装饰性动画

### 8.2 关键动画清单

| 场景 | 动画 | 时长 | 实现 |
|------|------|------|------|
| 流式文本出现 | 直接追加 | 0ms | 纯 text delta 追加 |
| 思考块展开/折叠 | 高度过渡 | 250ms | Framer Motion `AnimatePresence` |
| 工具卡状态变化 | 边框色 + 图标 | 200ms | CSS transition |
| 会话切换 | 消息流淡入 | 200ms | `AnimatePresence mode="wait"` |
| 面板折叠 | 宽度过渡 | 250ms | CSS Grid transition |
| 确认卡出现 | 从顶部滑入 | 250ms | Framer Motion |
| 通知出现 | 从右侧滑入 | 300ms | Toast 模式 |
| 打字指示 | 三点呼吸 | 1200ms loop | CSS keyframes |
| 按钮 press | 缩放 0.97 | 100ms | `whileTap` |
| 列表项 hover | 背景色 | 100ms | CSS transition |

### 8.3 流式输出优化

```typescript
// requestAnimationFrame 节流（高频 SSE 事件不阻塞主线程）
const rafRef = useRef<number>()
function appendChunk(chunk: string) {
  bufferRef.current += chunk
  if (!rafRef.current) {
    rafRef.current = requestAnimationFrame(() => {
      setContent(bufferRef.current)
      rafRef.current = undefined
    })
  }
}
```

### 8.4 Reduced Motion 适配

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 第九章 无障碍

### 9.1 语义化结构

```tsx
<main aria-label="PI Agent 工作台">
<nav aria-label="会话">
<aside aria-label="上下文">
<section aria-label="消息流">
<form aria-label="发送消息">
```

### 9.2 ARIA 规范

| 场景 | 属性 |
|------|------|
| 动态消息流 | `aria-live="polite"` |
| 加载状态 | `aria-busy="true"` |
| 装饰性图标 | `aria-hidden="true"` |
| 功能性图标 | `aria-label="描述"` |
| 关闭按钮 | `aria-label="关闭"` |
| 手风琴/折叠 | `aria-expanded` / `aria-controls` |

### 9.3 快捷键全表

| 快捷键 | 功能 | 上下文 |
|--------|------|--------|
| `Cmd/Ctrl+K` | 命令面板 | 全局 |
| `Cmd/Ctrl+N` | 新建会话 | 全局 |
| `Cmd/Ctrl+,` | 打开设置 | 全局 |
| `Cmd/Ctrl+D` | 切换 DevLog | 全局 |
| `Cmd/Ctrl+\` | 切换左栏 | 对话 |
| `Cmd/Ctrl+Shift+\` | 切换右栏 | 对话 |
| `Cmd/Ctrl+[` / `]` | 上/下一会话 | 对话 |
| `Enter` | 发送 | 输入框 |
| `Shift+Enter` | 换行 | 输入框 |
| `↑` / `↓` | 历史输入 | 输入框 |
| `Esc` | 中断 / 关闭浮层 | 全局 |
| `Cmd/Ctrl+L` | 聚焦输入框 | 对话 |
| `Cmd/Ctrl+M` | 切换权限模式 | 对话 |

### 9.4 键盘操作要求

- 所有交互元素有可见 focus ring（`focus-visible:ring-1 focus-visible:ring-ring`）
- focus ring 仅 keyboard navigation 时显示（`focus-visible:`）
- 对话框必须 focus trap，返回焦点到触发元素
- 所有表单 label 关联

---

## 第十章 性能策略

### 10.1 渲染性能策略

| 策略 | 场景 | 当前状态 |
|------|------|----------|
| 消息数量少时直接渲染 | < 100 条 | ✅ 已实现 |
| `React.memo` | 消息项/工具卡 | ⬜ 规划 |
| `requestAnimationFrame` 节流 | 流式高频追加 | ⬜ 规划 |
| 虚拟列表 (`@tanstack/react-virtual`) | 1000+ 消息 | ⬜ F3 |
| 代码分割 (`React.lazy`) | 设置页/DevLog | ⬜ F8 |
| 防抖高亮 (300ms) | 代码块流式 Shiki | ⬜ 规划 |

### 10.2 数据性能策略

| 策略 | 实现 |
|------|------|
| TanStack Query 缓存 | `staleTime: 5000`, `refetchOnWindowFocus: false` |
| 断连降级 | `retry: 1` 查询重试 |
| 轮询 | `refetchInterval: 10_000` 健康检查 |
| 持久化 | localStorage 会话/草稿（< 100KB） |

### 10.3 性能基线（v1.0 验收）

| 指标 | 目标 | 当前 |
|------|------|------|
| 首屏渲染 | < 500ms | ~200ms（Vite HMR） |
| 会话切换 | < 100ms | ~50ms（localStorage） |
| 流式首 token 显示 | < 200ms | ~150ms（SSE） |
| 长消息滚动 | 60fps | 60fps（当前规模） |
| 设置页打开 | < 300ms | ⬜ 待测 |
| 内存占用 | < 300MB | ~80MB（当前） |

---

## 第十一章 开发路线图

### 11.1 阶段总览

| 阶段 | 名称 | 交付物 | 后端依赖 | 工期 |
|------|------|--------|----------|------|
| **F0** | 脚手架 | Tailwind + shadcn/ui 接入、基础布局、主题系统 | 无 | 1 周 |
| **F1** | 对话最小可用 | 消息流（纯文本流式）、输入区、会话列表 | P4-P6 | 1.5 周 |
| **F2** | 工具卡 + 确认 | 工具调用卡、确认弹窗、权限模式切换 | P5 | 1 周 |
| **F3** | 会话持久化 | 会话恢复、搜索、重命名、分支 | P6 | 1 周 |
| **F4** | 压缩状态 | 压缩横幅、上下文面板、手动压缩 | P7 | 0.5 周 |
| **F5** | 记忆面板 | 记忆状态、事实浏览、立即编译 | P8 | 1 周 |
| **F6** | 用量面板 | 用量图表、成本统计、本轮提示 | P9 | 1 周 |
| **F7** | 实时推送 | WS 重连、通知中心、DevLog | P10 | 0.5 周 |
| **F8** | 设置中心 | Provider/模型/API Key/Agent/权限设置 | P13a | 1.5 周 |
| **F9** | 打磨 | 动画、a11y、性能、命令面板、快捷键 | — | 1 周 |

### 11.2 F0 当前状态（已完成）

| 交付物 | 状态 | 备注 |
|--------|------|------|
| Tailwind v4 + shadcn/ui CLI | ✅ | `@import 'tailwindcss'` 已配置 |
| Lucide React | ✅ | `Send`, `Square` 图标使用中 |
| 自定义标题栏 | ✅ | 40px，带拖拽区和窗口控件 |
| 三栏布局 Grid | ✅ | `grid-cols-[272px_minmax(480px,1fr)_328px]` |
| 主题系统 | ⬜ 规划 | 仅深色模式，Light 待实现 |
| 全局状态栏 | ✅ | 32px，连接+WS+模型状态 |
| CSS 变量体系 | ✅ | 完整语义色定义（main.css） |

### 11.3 F1 当前状态（进行中）

| 交付物 | 状态 | 备注 |
|--------|------|------|
| `useStreamingRun` hook | ✅ | AG-UI SSE 流接入 |
| `MessageStream` 组件 | ✅ | 三态（空/流式/错误） |
| `MessageBubble` | ✅ | 用户/助手/思考块/工具 |
| `applyEvent` 状态机 | ✅ | 8 种 AG-UI 事件映射 |
| `InputArea` 组件 | ✅ | 发送/中断/空禁用/自适应高度 |
| 会话列表 | ✅ | localStorage 持久化 |
| 流式指示器 | ✅ | 三点呼吸动画 |
| 中断按钮 | ✅ | 运行中显示 |
| 三态覆盖 | ⬜ 部分完成 | EmptyState 已实现 |

### 11.4 里程碑

| 里程碑 | 涵盖阶段 | 能力 |
|--------|----------|------|
| **F0-F1** | 脚手架 + 对话 | 能和 Agent 流式对话 |
| **F2-F3** | 工具 + 持久化 | 工具卡、确认、会话恢复 |
| **F4-F5** | 上下文 + 记忆 | 压缩感知、记忆管理 |
| **F6-F7** | 用量 + 实时 | 成本可视、实时推送 |
| **F8-F9** | 完整体验 | 设置完整、交互打磨 |

总工期约 **10 周**（单人），与后端 P4-P10 并行推进。

---

## 附录

### A. AG-UI 事件到 UI 映射速查

| AG-UI 事件 | UI 组件 | applyEvent 处理 |
|-----------|---------|----------------|
| RUN_STARTED | 创建空助手消息 | `createAssistantMessage(runId)` |
| TEXT_MESSAGE_START | 准备渲染 | 确认活跃消息存在 |
| TEXT_MESSAGE_CONTENT | 气泡内容追加 | `streamingBuffer += delta` |
| TEXT_MESSAGE_END | 气泡完成 | `content = streamingBuffer` |
| THINKING_* | 思考块 | `thinking.content += delta` |
| STEP_STARTED | 新建工具卡（running） | `toolCalls.push({status:'running'})` |
| STEP_FINISHED | 工具卡 ✓ | `toolCall.status = 'success'` |
| CUSTOM (PI_TOOL_EXECUTION_UPDATE) | 工具卡参数更新 | `args/partialResult` |
| RUN_FINISHED | 回复完成 | `status='complete'` |
| RUN_ERROR | 错误卡片 | `streamError = message` |

### B. WebSocket 事件到 UI 映射

| WS 事件 | UI 反应 |
|---------|---------|
| confirmation_request | ConfirmationDialog 显示 |
| memory_updated | 通知 + 刷新记忆（规划） |
| notification | 通知中心（规划） |
| devlog | DevLog 面板（规划） |
| session:compacted | 压缩横幅 + 刷新会话（规划） |

### C. 文件清单

```
components/ui/                    # shadcn/ui 已安装 8 个
components/chat/                  # 10 个文件（已实现）
  ├── chat-workspace.tsx          ✅ 工作台壳层
  ├── input-area.tsx              ✅ 输入区
  ├── message-stream.tsx          ✅ 消息流
  ├── message-bubble.tsx          ✅ 消息气泡
  ├── thinking-block.tsx          ✅ 思考块
  ├── tool-call-card.tsx          ✅ 工具调用卡
  ├── tool-card.tsx               ✅ 工具卡列表
  ├── confirmation-dialog.tsx     ✅ 确认对话框
  ├── empty-state.tsx             ✅ 空状态
  ├── error-card.tsx              ✅ 错误卡片
  ├── streaming-indicator.tsx     ✅ 流式指示器
  ├── permission-mode-switch.tsx  ✅ 权限模式切换
  └── types.ts                    ✅ 类型定义
hooks/                            # 3 个文件（已实现）
  ├── use-streaming-run.ts        ✅ SSE 流式
  ├── use-websocket.ts            ✅ WS 客户端
  └── use-tool-executions.ts      ✅ 工具执行追踪
api/                              # 2 个文件
  ├── http-client.ts              ✅ HTTP 客户端
  └── agui-client.ts              ✅ AG-UI 客户端
```

### D. 与后端契约

前端所有 API 调用与 WS 事件的类型，必须从 `@repo/protocol` 和 `@repo/shared` 导入：

```typescript
import type { BaseEvent, EventType } from '@repo/protocol/events'
import type { AgentMessage } from '@repo/shared/agent'
import type { BrowserConfig } from '@repo/config/shared'
```

---

> 本文档随实现迭代更新。每个 F 阶段完成后，补充「实际实现与设计差异」章节。
>
> 设计决策记录在 [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)（后端）与本文档（前端）中。
