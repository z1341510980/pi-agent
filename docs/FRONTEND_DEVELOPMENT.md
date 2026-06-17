# pi-agent 前端功能开发文档

> 本文档基于 [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) 与 [`PROJECT_SPEC.md`](../PROJECT_SPEC.md) 编写，
> 定义 pi-agent 桌面应用**渲染进程（Renderer）**的完整功能规格、界面设计、交互规范与实施路线。
> 面向角色：前端工程师 / UI 工程师 / 全栈工程师。

---

## 0. 阅读地图

| 你是 | 先看 |
|------|------|
| 想快速了解整体结构 | §1 概述 → §2 信息架构 → §3 全局布局 |
| 要做对话主界面 | §4 对话工作台 → §10 动画规范 |
| 要做设置页 | §5 设置中心 |
| 要接后端数据 | §7 状态管理 → §8 通信层 |
| 要搭组件库 | §9 组件库规范 |
| 要排期 | §13 开发路线图 |

---

## 1. 概述

### 1.1 产品定位

pi-agent 是一个 **AI Agent 桌面应用**，用户通过自然语言与 Agent 对话，Agent 可调用工具（读写文件、执行命令、搜索网页）、拥有跨会话记忆、支持多 Agent 协作。前端是用户与 Agent 交互的唯一入口，承担：**对话、工具确认、配置、用量感知、记忆管理**五大职责。

### 1.2 设计目标

| 目标 | 衡量标准 |
|------|----------|
| **可感知的实时性** | 流式输出首 token < 200ms 出现；工具执行状态即时反馈 |
| **可信任的操作** | 危险操作必经确认；权限模式一目了然；操作可追溯 |
| **可掌控的成本** | token 用量/成本实时可见；超阈值预警 |
| **流畅的体感** | 60fps 动画；会话切换 < 100ms；长列表虚拟化 |
| **包容的可用性** | 键盘可达全功能；屏幕阅读器友好；中文优先 |

### 1.3 技术栈选型

> 遵循 ARCHITECTURE.md §12「Zustand + TanStack Query，CopilotKit 仅做 UI 组件」的决策。
> 在现有 React 19 + TanStack Query 基础上补齐 UI 层。

| 层 | 技术 | 版本 | 选型理由 |
|----|------|------|----------|
| 框架 | React | ^19.2.7 | 已有，并发特性支持流式渲染 |
| 语言 | TypeScript | ^5.9.3 | strict: true，与后端共享 `@repo/protocol` 类型 |
| 构建 | electron-vite + Vite | ^7.2.6 | 已有，HMR + ESM |
| 样式 | Tailwind CSS | ^4.x | utility-first，与 shadcn/ui 同源；CSS 变量驱动主题 |
| 组件库 | shadcn/ui + Radix UI | latest | 可定制、无运行时 license 风险、a11y 内置 |
| 图标 | Lucide React | latest | 与 shadcn/ui 默认搭配，tree-shakeable |
| 客户端状态 | Zustand | ^5.x | ARCHITECTURE §12 指定；轻量、无 Provider |
| 服务端状态 | TanStack Query | ^5.101.0 | 已有；SSE/WS 数据缓存与同步 |
| 动画 | Framer Motion | ^11.x | 声明式动画，layout 动画，跨平台一致 |
| Markdown | react-markdown + remark-gfm + rehype-highlight | latest | Agent 输出渲染 |
| 代码高亮 | shiki | latest | 与后端同源高亮，VS Code 级别 |
| 表单 | react-hook-form + zod | latest | 与后端 Zod schema 复用 |
| 图表 | Recharts | ^2.x | 用量面板折线/柱状图 |
| 虚拟列表 | @tanstack/react-virtual | ^3.x | 会话列表/消息流长列表 |
| 日期 | date-fns | ^3.x | 轻量日期处理 |
| 快捷键 | react-hotkeys-hook | latest | 全局快捷键 |
| 拖拽 | @dnd-kit/core | latest | 会话排序、面板拖拽 |

> **CopilotKit 降级为可选**：ARCHITECTURE 指定 CopilotKit 仅做 UI 组件。鉴于我们自建完整对话 UI，
> CopilotKit 的 `CopilotSidebar` 将被自研对话组件替代，仅保留其 `useCoAgent` 等 hook 用于与 AG-UI 协议对接（如需）。
> 详见 §8.2。

### 1.4 设计原则

1. **流式优先**：一切来自 Agent 的内容默认按流式渲染，不要"等完整再显示"
2. **状态三态必做**：每个数据驱动组件必须有 `loading` / `error` / `empty` 三态，不接受"能跑就行"
3. **确认不打断流**：工具确认弹窗以非阻塞浮层出现，不切断正在进行的流式输出
4. **权限可见**：当前权限模式（Auto/Plan/Read-only）始终在输入区显眼位置可见
5. **成本可感**：每次对话结束在输入区下方轻量显示本轮 token/成本
6. **键盘优先**：所有核心操作有快捷键（`Cmd/Ctrl+K` 命令面板、`Cmd/Ctrl+N` 新会话、`Esc` 中断等）
7. **中文优先**：默认中文界面，i18n 预留英文（ARCHITECTURE §19）

---

## 2. 信息架构（IA）

### 2.1 顶层结构

```
pi-agent 桌面应用
│
├─ 🏠 对话工作台 (Chat Workspace)          ← 默认首页，占 80% 使用时长
│   ├─ 左栏：会话列表 + Agent 切换
│   ├─ 中栏：消息流 + 输入区
│   └─ 右栏：上下文面板（可折叠）
│
├─ ⚙️ 设置中心 (Settings)                  ← Cmd/Ctrl+,
│   ├─ 通用（语言/主题/代理/数据目录）
│   ├─ Provider 管理
│   ├─ 模型管理
│   ├─ Agent 管理
│   ├─ 权限与安全
│   ├─ 用量
│   ├─ 记忆
│   ├─ 自动化（Cron）
│   └─ 关于（版本/更新）
│
├─ 🔔 浮层系统 (Overlays)                  ← 全局
│   ├─ 工具确认对话框
│   ├─ 通知中心
│   ├─ DevLog 面板（开发者）
│   ├─ 命令面板（Cmd/Ctrl+K）
│   └─ 更新提示
│
└─ 🖥️ 系统托盘 (Tray)                      ← 最小化时
    ├─ 快速新建会话
    ├─ 最近会话
    └─ 退出
```

### 2.2 路由设计

采用 `react-router` v6（或自建轻量 hash 路由，Electron 内单页足够）：

| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | 对话工作台 | 默认重定向到最近会话 |
| `/chat/:sessionId` | 对话工作台（指定会话） | 恢复历史会话 |
| `/chat/:sessionId/:branchId` | 对话工作台（分支） | 会话分支（Pi SDK 树结构） |
| `/settings` | 设置中心 | 默认重定向到「通用」 |
| `/settings/:section` | 设置子页 | `general` / `providers` / `models` / `agents` / `security` / `usage` / `memory` / `cron` / `about` |

> Electron 单页应用，路由仅用于状态区分与浏览器历史栈，不涉及真实 URL 加载。

### 2.3 与后端能力的映射

| 前端模块 | 后端能力（ARCHITECTURE 章节） | 通信方式 |
|----------|------------------------------|----------|
| 消息流 | §3.5 Agent Loop / §3.8 端到端数据流 | SSE (AG-UI) |
| 工具确认 | §11.3 确认机制 / §22.7 Gate | WebSocket |
| 中途引导 (steer) | §22.11 Mid-turn Steer | SSE (POST) / WebSocket |
| 会话管理 | §3.5 / §20 SessionFileRegistry | HTTP REST |
| Compaction 状态 | §13 Session Compaction | WebSocket |
| 记忆状态 | §6 记忆系统 / §22.9 Memory Reflection | WebSocket |
| Provider/模型配置 | §8 三层配置 / §21 ProviderRegistry | Electron IPC → Main |
| API Key | §16 CredentialStore (safeStorage) | Electron IPC → Main |
| 用量 | §14 Usage Ledger | HTTP REST + WebSocket |
| 权限模式 | §11 / §22.7 Gate | HTTP REST |
| 出站代理 | §24.5 OutboundProxy | Electron IPC → Main |
| 自动更新 | §18 auto-updater | Electron IPC |
| Cron | §24.8 CronScheduler | HTTP REST |
| DevLog | §23.2 DevLog | WebSocket |
| 通知 | §7.5 EventBus → WebSocket | WebSocket |

---

## 3. 全局布局

### 3.1 应用外壳（App Shell）

桌面应用采用**自定义标题栏 + 三栏工作台**结构，遵循原生应用体感而非 Web 体感。

```
┌─────────────────────────────────────────────────────────────┐
│ 自定义标题栏（拖拽区）  [app]   [会话名]      [最小][最大][关]│  ← -webkit-app-region: drag
├──────┬──────────────────────────────────────────────┬───────┤
│      │                                              │       │
│ 左栏 │              中栏（消息流）                  │ 右栏  │
│ 260  │                                              │ 320   │
│ px   │                                              │ px    │
│      │                                              │(可折叠)│
│      ├──────────────────────────────────────────────┤       │
│      │              输入区                          │       │
├──────┴──────────────────────────────────────────────┴───────┤
│ 状态栏：连接状态 · 当前 Agent · 权限模式 · token 计数        │
└─────────────────────────────────────────────────────────────┘
```

**关键尺寸规范**：

| 区域 | 默认宽度 | 最小 | 最大 | 说明 |
|------|----------|------|------|------|
| 左栏 | 260px | 220px | 360px | 可拖拽调宽，可折叠至 0 |
| 中栏 | 自适应 | 480px | — | 主区域 |
| 右栏 | 320px | 280px | 420px | 可折叠至 0 |
| 输入区 | 自适应高度 | 56px | 240px | 自动撑高，超过滚动 |

**响应式断点**（窗口宽度）：

| 宽度 | 布局 | 说明 |
|------|------|------|
| ≥ 1280px | 三栏全显 | 桌面默认 |
| 960–1279px | 左栏 + 中栏，右栏折叠为抽屉 | 中等屏 |
| < 960px | 单栏，左/右栏为抽屉式覆盖层 | 小窗/分屏 |

### 3.2 主题系统

内置 **Light / Dark / System** 三种主题，Tailwind v4 CSS 变量驱动。

```css
:root {
  --background: 0 0% 100%;
  --foreground: 222 47% 11%;
  --primary: 221 83% 53%;
  --muted: 210 40% 96%;
  --border: 214 32% 91%;
  --radius: 0.5rem;
  /* pi-agent 语义色 */
  --token-user: 221 83% 53%;      /* 用户消息 */
  --token-assistant: 142 71% 45%;  /* 助手消息 */
  --token-thinking: 280 65% 60%;   /* 思考块 */
  --token-tool: 38 92% 50%;        /* 工具调用 */
  --token-danger: 0 84% 60%;       /* 危险操作 */
}
```

主题切换持久化到 `preferences.yaml`，并跟随系统 (`prefers-color-scheme`)。

### 3.3 全局状态栏（底部）

始终可见的 32px 状态栏，聚合运行时状态：

```
[● online] Agent: pi · claude-sonnet-4 · [Auto] · 本轮 1.2k/$0.012 · 今日 48k/$0.42
```

| 区段 | 内容 | 点击行为 |
|------|------|----------|
| 连接状态 | ● online / ● offline / ● connecting | 点击重连 |
| 当前 Agent | Agent 名称 | 切换 Agent |
| 当前模型 | provider/model | 切换模型（快速） |
| 权限模式 | Auto / Plan / Read-only | 切换权限模式 |
| 本轮用量 | token / 成本 | 展开本轮详情 |
| 今日用量 | token / 成本 | 跳转用量面板 |

---

## 4. 对话工作台（核心模块）

对话工作台是用户 80% 时长所在，是整个应用的灵魂。设计目标：**让用户忘记自己在用工具，专注于与 Agent 协作**。

### 4.1 左栏：会话列表 + Agent 切换

#### 4.1.1 结构

```
┌──────────────────────────┐
│ [🤖 pi ▾]  [+ 新建]      │  ← Agent 切换器 + 新建会话
├──────────────────────────┤
│ 🔍 搜索会话...           │  ← 搜索框（实时过滤）
├──────────────────────────┤
│ 📌 置顶                   │  ← 分组：置顶
│  · 重构认证模块           │
│  · 周报撰写               │
├──────────────────────────┤
│ 今天                      │  ← 分组：按日期
│  · 读取 package.json 14:32│  ← 标题 + 末轮时间
│  · 调试 SSE 连接    11:08 │
│  · (无标题)         09:15 │  ← 未生成标题的会话
├──────────────────────────┤
│ 昨天                      │
│  · 设计记忆系统     18:44 │
│  · ...                    │
├──────────────────────────┤
│ 本周                      │
│  · ...                    │
└──────────────────────────┘
```

#### 4.1.2 会话项（Session Item）

每个会话项显示：

| 元素 | 内容 | 说明 |
|------|------|------|
| 标题 | LLM 自动生成（§24.10） | 未生成时显示"新会话"或首条消息截断 |
| 末轮时间 | 相对时间（14:32 / 昨天 / 3天前） | date-fns `formatDistanceToNow` |
| 状态指示 | 进行中（脉冲点）/ 已完成 / 出错 | 右侧小圆点 |
| 预览 | 末条消息前 40 字 | 灰色辅助文字 |
| 未读 | 未读消息数 badge | 多 Agent 协作时 |

**交互**：
- 单击：切换会话（带过渡动画，详见 §10.3）
- 右键：上下文菜单（重命名 / 置顶 / 导出 / 复制 / 删除 / 分支）
- 拖拽：调整顺序 / 置顶
- 悬停：显示操作按钮（重命名、删除）

#### 4.1.3 Agent 切换器

点击顶部 Agent 头像展开下拉：

```
┌────────────────────────────┐
│ 当前: pi                    │
│  代码助手 · claude-sonnet-4 │
├────────────────────────────┤
│ 切换 Agent                  │
│  🤖 pi      (活跃)  ●      │
│  📝 writer   写作助手       │
│  🔬 researcher 研究员       │
│  ➕ 创建新 Agent...         │
└────────────────────────────┘
```

v1.0 仅支持单 Agent 手动切换（ARCHITECTURE §9.1），多 Agent 协作（subagent/频道）为 v1.1+。

### 4.2 中栏：消息流

#### 4.2.1 消息类型矩阵

pi-agent 的消息流比普通聊天复杂得多，需要支持 AG-UI 协议的全部事件类型：

| 消息类型 | AG-UI 事件 | 视觉形态 | 渲染时机 |
|----------|-----------|----------|----------|
| **用户消息** | (前端发送) | 右对齐气泡，蓝色 | 立即 |
| **助手文本** | TEXT_MESSAGE_* | 左对齐，Markdown 渲染 | 流式逐字 |
| **思考块** | THINKING_* / REASONING_* | 折叠卡片，紫色边框 | 流式，默认折叠 |
| **工具调用** | TOOL_CALL_* | 可展开卡片，橙色 | 调用开始 |
| **工具执行** | STEP_* / ACTIVITY_* | 工具卡片内进度 | 实时更新 |
| **工具结果** | (tool_execution_end) | 工具卡片内结果区 | 完成时 |
| **确认请求** | (WS confirmation_request) | 浮层卡片，红色强调 | WS 推送 |
| **情绪标记** | (mood parser) | 助手头像微表情 | 流式 |
| **卡片数据** | (card parser) | 结构化卡片 | 流式解析 |
| **Compaction** | STATE_SNAPSHOT | 顶部横幅通知 | WS 推送 |
| **状态快照** | STATE_SNAPSHOT | 进度条/状态文本 | 实时 |
| **错误** | RUN_ERROR | 红色卡片 + 重试 | 错误时 |
| **系统通知** | (WS notification) | 居中横幅 | WS 推送 |

#### 4.2.2 消息流布局

```
┌──────────────────────────────────────────┐
│ ▸ 上下文已压缩（compaction）  [查看详情]  │  ← 压缩横幅（可选）
├──────────────────────────────────────────┤
│                                          │
│        🤖 pi · claude-sonnet-4            │  ← 助手消息头
│        ┌─────────────────────────┐       │
│        │ 我来帮你读取文件。        │       │  ← 文本气泡
│        └─────────────────────────┘       │
│                                          │
│        ┌─ 🔧 read ──────────▸ ──┐       │  ← 工具调用卡片
│        │ 📄 package.json         │       │
│        │ ⏳ 读取中...            │       │  ← 执行中
│        └─────────────────────────┘       │
│                                          │
│        ┌─ 🔧 read ──────────✓ ──┐       │  ← 工具完成
│        │ 📄 package.json · 2.1KB │       │
│        │ ▾ 查看结果 (12 行)      │       │  ← 可展开
│        └─────────────────────────┘       │
│                                          │
│        ┌─────────────────────────┐       │
│        │ 这个项目是 pnpm monorepo │       │  ← 续文本
│        │ ...                      │       │
│        └─────────────────────────┘       │
│                                          │
│                              ┌─────────┐ │
│                              │ 帮我总结 │ │  ← 用户消息（右对齐）
│                              └─────────┘ │
│                                          │
│        ●●● (正在思考)                     │  ← 流式占位
│                                          │
└──────────────────────────────────────────┘
```

#### 4.2.3 助手消息渲染管线

助手的流式输出需要经过解析器链（ARCHITECTURE §3.6），前端要对应处理：

```
SSE TEXT_MESSAGE_CONTENT 事件
  │
  ▼
React 状态追加到 currentMessage.buffer
  │
  ▼
解析器链（前端镜像后端）：
  ├─ <thinking>...</thinking> → 思考块（实时折叠/展开）
  ├─ <mood>...</mood>         → 情绪标记（头像微表情）
  ├─ <card>...</card>         → 结构化卡片
  └─ 纯文本                   → Markdown 增量渲染
  │
  ▼
react-markdown 增量渲染（code block 用 Shiki 高亮）
```

**关键实现**：
- 使用 `useDeferredValue` 让流式追加不阻塞主线程
- 代码块流式时先显示纯文本，完成后高亮（防抖）
- 思考块默认折叠，点击展开；流式时若展开则实时滚动

#### 4.2.4 工具调用卡片

工具调用是 pi-agent 区别于普通聊天的核心，需要精心设计：

**状态机**：

```
pending → running → success / error / blocked / denied
```

**卡片形态**（按工具类型差异化）：

| 工具 | 卡片形态 | 说明 |
|------|----------|------|
| `read` / `ls` / `find` | 文件预览卡 | 显示文件路径、行数、可展开内容 |
| `bash` | 终端卡 | 等宽字体、黑底绿字、可滚动输出 |
| `edit` / `write` | Diff 卡 | 类似 Git diff，红绿对比 |
| `grep` | 搜索结果卡 | 匹配行高亮、文件分组 |
| `web_search` | 搜索结果卡 | 标题 + 摘要 + URL |
| `web_fetch` | 网页预览卡 | 标题 + 正文摘要 |
| `memory_search` | 记忆卡 | 匹配事实列表 |

**通用工具卡结构**：

```
┌─ 🔧 {toolName} ─────── {status icon} ──┐
│ {摘要：文件路径 / 命令 / 查询词}        │
│ ─────────────────────────────────────  │
│ {执行状态 / 进度}                       │
│ ▾ 展开查看详情                          │  ← 折叠区
│   ┌─ 输入参数 ─────────────────────┐   │
│   │ {JSON}                          │   │
│   └─────────────────────────────────┘   │
│   ┌─ 输出结果 ─────────────────────┐   │
│   │ {内容，可滚动}                  │   │
│   └─────────────────────────────────┘   │
│   ⏱ 1.2s · 2.1KB                        │  ← 元信息
└─────────────────────────────────────────┘
```

**交互**：
- 默认折叠（只显示摘要 + 状态）
- 点击展开查看完整输入/输出
- `bash` 工具可"复制命令"
- `edit` 工具可"应用/回滚"（本地预览）
- 错误状态显示红色边框 + 错误信息
- 被拒绝（denied）显示灰色 + "已拒绝"

#### 4.2.5 思考块（Thinking）

支持 extended thinking 的模型（如 Claude）会输出推理过程：

```
┌─ 💭 思考过程 ──────────── 2.3s ──┐
│ ▸ 展开查看 (480 字)               │  ← 默认折叠
└───────────────────────────────────┘
```

展开后：

```
┌─ 💭 思考过程 ──────────── 2.3s ──┐
│ ▾ 收起                            │
│ ─────────────────────────────────│
│ 用户想要读取 package.json，我需要 │  ← 紫色辅助文字
│ 先确认文件路径...                  │
│                                   │
│ 这是一个 pnpm monorepo，我应该...  │
└───────────────────────────────────┘
```

**设计考量**：
- 默认折叠，避免干扰主对话，但让用户知道"Agent 在思考"
- 流式时若用户展开，则实时滚动
- 折叠状态显示字数和耗时
- 紫色系区分于正文

#### 4.2.6 流式占位与打字指示

Agent 思考/调用的间隙需要明确的"正在进行"反馈：

| 状态 | 占位形态 |
|------|----------|
| 等待首个 token | 三点呼吸动画 + "正在思考..." |
| 思考中 | "💭 深度思考中..." + 紫色脉冲 |
| 工具调用中 | 工具卡显示 spinner + "执行中..." |
| 多工具并行 | 多个工具卡同时显示 spinner |
| 网络重试 | "网络抖动，重试中 (2/3)..." |

**绝不允许出现"无反馈的卡顿"**——任何超过 500ms 的等待都要有视觉反馈。

### 4.3 输入区

#### 4.3.1 结构

```
┌──────────────────────────────────────────┐
│ ┌──────────────────────────────────────┐ │
│ │ 帮我重构这个函数，要求...              │ │  ← 多行输入（自动撑高）
│ │                                      │ │
│ │                                      │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ [📎 附件] [⌘ 引用文件]   [Auto ▾] [⏎发送]│  ← 工具栏
│                          权限模式  快捷键提示
└──────────────────────────────────────────┘
```

#### 4.3.2 功能点

| 功能 | 实现 | 说明 |
|------|------|------|
| 多行输入 | `<textarea>` + 自动撑高 | Shift+Enter 换行，Enter 发送 |
| 文件引用 | `@` 触发文件选择器 | 类似 VS Code，引用文件路径注入消息 |
| 附件 | 拖拽 / 点击 | 图片直接预览，文件显示卡片 |
| 权限模式切换 | 下拉 | Auto / Plan / Read-only（§11） |
| 模型快速切换 | 下拉 | 临时覆盖本会话模型 |
| 中途引导 (steer) | 运行中时输入框变为"追加指令" | §22.11 |
| 中断 | 运行中显示"停止"按钮 | 发送 abort steer |
| 草稿持久化 | 未发送内容存 localStorage | 切换会话不丢失 |
| 历史输入 | ↑ / ↓ 翻阅 | 类似终端 |
| Markdown 预览 | `Cmd/Ctrl+P` 切换预览 | 长消息时有用 |

#### 4.3.3 中途引导（Steer）模式

当 Agent 正在运行时，输入区切换为 steer 模式（ARCHITECTURE §22.11）：

```
┌──────────────────────────────────────────┐
│ ⚡ Agent 运行中 — 你可以追加指令          │  ← 提示横幅
│ ┌──────────────────────────────────────┐ │
│ │ 顺便也检查一下 test 目录              │ │  ← 输入框
│ └──────────────────────────────────────┘ │
│ [⏹ 停止运行]              [⏎ 追加指令]   │
└──────────────────────────────────────────┘
```

steer 消息以**特殊样式**追加到消息流（区别于普通用户消息）：

```
        ┌──────────────────────────┐
        │ ⚡ 追加：顺便也检查 test 目录│  ← 黄色边框 + ⚡ 图标
        └──────────────────────────┘
```

#### 4.3.4 输入区下方用量提示

每轮对话结束后，输入区下方轻量显示本轮成本：

```
└─ 本轮 1,247 tokens · $0.012 · 缓存命中 78% ─┘
```

鼠标悬停展开详情（输入/输出/缓存/模型）。点击跳转用量面板。

### 4.4 顶部栏

```
┌──────────────────────────────────────────┐
│ ◂ 返回   重构认证模块   [claude-sonnet-4 ▾] [⋯] │
└──────────────────────────────────────────┘
```

| 元素 | 功能 |
|------|------|
| 会话标题 | 可点击重命名 |
| 模型切换 | 快速切换本会话模型（临时覆盖） |
| 更多菜单 `⋯` | 重命名 / 复制 / 导出 / 分支 / 手动压缩 / 删除 |

**手动压缩**（ARCHITECTURE §13）：触发 `POST /ag-ui/agent/:id/compact`，显示确认弹窗说明压缩影响。

### 4.5 右栏：上下文面板

可折叠的右侧面板，展示当前会话的"上下文健康度"，让用户理解 Agent "看到了什么"：

#### 4.5.1 标签页

```
┌──────────────────────────┐
│ [上下文] [文件] [记忆]    │  ← 标签切换
├──────────────────────────┤
│                          │
│  (标签内容)              │
│                          │
└──────────────────────────┘
```

#### 4.5.2 上下文标签

显示 context window 使用情况（ARCHITECTURE §13）：

```
上下文窗口
┌──────────────────────────┐
│ ████████████░░░░░░ 62%   │  ← 进度条
│ 98k / 200k tokens         │
└──────────────────────────┘

┌─ 阈值状态 ────────────────┐
│ ● 50% 软阈值  (已过)      │
│ ● 80% 压缩阈值 (未到)     │
│ ● 90% 强制阈值 (未到)     │
└──────────────────────────┘

┌─ 缓存诊断 ────────────────┐
│ 缓存命中: 78%             │
│ system hash: a3f2...      │
│ tools hash:  b8c1...      │
│ 前缀变化: 无              │
└──────────────────────────┘

[手动压缩]
```

#### 4.5.3 文件标签

当前会话工具产出文件（ARCHITECTURE §20 SessionFileRegistry）：

```
会话文件 (3)
┌──────────────────────────┐
│ 📄 summary.md   2.1KB    │  ← 点击打开
│ 🖼 screenshot.png        │
│ 📦 artifact.zip  15KB    │
└──────────────────────────┘
[在文件管理器中打开]
```

#### 4.5.4 记忆标签

当前 Agent 的记忆概览（ARCHITECTURE §6）：

```
Agent 记忆
┌──────────────────────────┐
│ ● 编译状态: 健康          │
│ ● 上次编译: 2 小时前      │
│ ● 事实数: 142            │
└──────────────────────────┘

置顶记忆
┌──────────────────────────┐
│ 📌 用户偏好 TypeScript    │
│ 📌 工作目录 D:\Projects   │
└──────────────────────────┘

[管理记忆] [立即编译]
```

---

## 5. 设置中心

设置中心采用**左侧导航 + 右侧内容**的经典布局，`Cmd/Ctrl+,` 打开。

### 5.1 设置导航结构

```
┌────────────┬─────────────────────────────────┐
│ 设置       │                                 │
│            │       (子页面内容)               │
│ ▸ 通用     │                                 │
│ ▸ Provider │                                 │
│ ▸ 模型     │                                 │
│ ▸ Agent    │                                 │
│ ▸ 权限安全 │                                 │
│ ▸ 用量     │                                 │
│ ▸ 记忆     │                                 │
│ ▸ 自动化   │                                 │
│ ▸ 关于     │                                 │
└────────────┴─────────────────────────────────┘
```

### 5.2 通用设置

| 配置项 | 控件 | 说明 |
|--------|------|------|
| 语言 | Select | 中文 / English（跟随系统） |
| 主题 | Radio | 浅色 / 深色 / 跟随系统 |
| 字体大小 | Slider | 12-18px |
| 数据目录 | 路径选择器 | 显示当前 `{appData}/pi-agent`，可迁移 |
| 启动时打开 | Select | 最近会话 / 新会话 / 欢迎页 |
| 关闭按钮行为 | Radio | 退出 / 最小化到托盘 |
| 开机自启 | Switch | 登录时启动 |
| 出站代理 | 见 §5.2.1 | 网络代理配置 |

#### 5.2.1 出站代理配置（ARCHITECTURE §24.5）

```
出站网络代理
┌──────────────────────────────────────┐
│ 模式                                  │
│ ○ 不使用代理                          │
│ ● 使用系统代理                         │
│ ○ 手动配置                            │
│                                      │
│ (手动配置时显示)                      │
│ 代理地址 [http://127.0.0.1:7890     ] │
│                                      │
│ 不走代理的域名                         │
│ ┌──────────────────────────────────┐ │
│ │ 127.0.0.1                        │ │
│ │ localhost                        │ │
│ │ + 添加域名                        │ │
│ └──────────────────────────────────┘ │
│                                      │
│ [测试连通性]                          │
└──────────────────────────────────────┘
```

### 5.3 Provider 管理（关键页面）

ARCHITECTURE §8.2 的核心前端实现——用户在这里配置 LLM 服务商。

#### 5.3.1 Provider 列表

```
Provider 管理                                    [+ 添加 Provider]
┌──────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────┐  │
│ │ ● OpenAI                          [已验证] [编辑][删]│  │
│ │   api: openai-completions                          │  │
│ │   https://api.openai.com/v1                        │  │
│ │   模型: gpt-4o, gpt-4o-mini, o1 (3)                │  │
│ └────────────────────────────────────────────────────┘  │
│ ┌────────────────────────────────────────────────────┐  │
│ │ ● Anthropic                       [已验证] [编辑][删]│  │
│ │   api: anthropic-messages                          │  │
│ │   https://api.anthropic.com                        │  │
│ │   模型: claude-sonnet-4, claude-opus-4 (2)         │  │
│ └────────────────────────────────────────────────────┘  │
│ ┌────────────────────────────────────────────────────┐  │
│ │ ○ 本地 Ollama                     [未验证] [编辑][删]│  │
│ │   api: openai-completions                          │  │
│ │   http://127.0.0.1:11434                           │  │
│ └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

#### 5.3.2 添加/编辑 Provider 表单

```
添加 Provider
┌────────────────────────────────────────────────┐
│ 名称        [OpenAI                          ] │
│ API 类型    [openai-completions        ▾]      │
│             ○ openai-completions                │
│             ○ anthropic-messages                │
│             ○ google-generative-ai              │
│ Base URL    [https://api.openai.com/v1       ] │
│                                                │
│ ── API Key ──────────────────────────────────  │
│ [sk-•••••••••••••••••••••••••••••] [显示][测试]│
│ ✓ 连通性验证通过，发现 12 个模型                │
│                                                │
│ ── 模型声明 ──────────────────────────────────  │
│ (自动从 /models 拉取，可手动添加)               │
│ ┌──────────────────────────────────────────┐  │
│ │ ✓ gpt-4o      context: 128k  thinking: ✗ │  │
│ │ ✓ gpt-4o-mini context: 128k  thinking: ✗ │  │
│ │ ✓ o1          context: 200k  thinking: ✓ │  │
│ │ [+ 手动添加模型]                          │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│                          [取消]  [保存]         │
└────────────────────────────────────────────────┘
```

**关键交互**：
- 输入 API Key 后点击"测试"，调用 `testApiKey`（§8.4），显示连通性结果
- 测试成功自动拉取模型列表，用户勾选启用的模型
- 每个模型可声明能力（input: text/image, thinking, contextWindow）
- API Key 通过 IPC 存入 safeStorage（§16），不明文落盘
- 保存后通知 agent-server 刷新 ProviderRegistry

### 5.4 模型管理

管理用户自定义模型（ARCHITECTURE §21 `added-models.yaml`）：

```
自定义模型                            [+ 添加自定义模型]
┌────────────────────────────────────────────────┐
│ deepseek-r1 (Ollama)                           │
│   provider: 本地 Ollama                         │
│   context: 64k · thinking: ✓                   │
│   [编辑] [删除]                                 │
├────────────────────────────────────────────────┤
│ qwen-max (DashScope)                           │
│   provider: 阿里云                              │
│   context: 32k · thinking: ✗                   │
│   [编辑] [删除]                                 │
└────────────────────────────────────────────────┘
```

### 5.5 Agent 管理

#### 5.5.1 Agent 列表

```
Agent 管理                            [+ 创建 Agent]
┌────────────────────────────────────────────────┐
│ 🤖 pi (活跃)                                   │
│    代码助手 · claude-sonnet-4                   │
│    会话: 23 · 记忆: 142 事实                    │
│    [编辑] [复制] [导出] [删除]                  │
├────────────────────────────────────────────────┤
│ 📝 writer                                      │
│    写作助手 · gpt-4o                            │
│    会话: 8 · 记忆: 31 事实                      │
│    [编辑] [复制] [导出] [删除]                  │
└────────────────────────────────────────────────┘
```

#### 5.5.2 Agent 编辑表单

```
编辑 Agent: pi
┌─────────────────────────────────────────────────┐
│ ┌── 基础 ──────────────────────────────────┐   │
│ │ 名称       [pi                          ] │   │
│ │ 头像       [🤖] (emoji 选择器)            │   │
│ │ 描述       [代码助手                     ] │   │
│ └──────────────────────────────────────────┘   │
│                                                 │
│ ┌── 模型 ──────────────────────────────────┐   │
│ │ Chat 模型     [claude-sonnet-4 (Anthropic)▾]│  │
│ │ Utility 模型  [gpt-4o-mini (OpenAI)    ▾]│   │
│ │ Utility Large [o1 (OpenAI)              ▾]│   │
│ └──────────────────────────────────────────┘   │
│                                                 │
│ ┌── 人格 ──────────────────────────────────┐   │
│ │ 身份模板  [编辑 identity.md]              │   │
│ │ 人格模板  [编辑 personality.md]           │   │
│ └──────────────────────────────────────────┘   │
│                                                 │
│ ┌── 能力开关 ──────────────────────────────┐   │
│ │ 记忆系统    [● 开启]                      │   │
│ │ 工具        [✓ read] [✓ bash] [✓ edit]   │   │
│ │             [✓ write] [✓ grep] [✓ find]  │   │
│ │             [✓ ls] [✓ web_search]        │   │
│ │             [✓ web_fetch] [✓ memory_search]│  │
│ │ Home 目录   [D:\Projects                 ]│   │
│ └──────────────────────────────────────────┘   │
│                                                 │
│                          [取消]  [保存]          │
└─────────────────────────────────────────────────┘
```

**人格模板编辑器**：点击"编辑 identity.md"打开全屏 Markdown 编辑器（带预览），编辑后存入 `{agentDir}/identity.md`。

### 5.6 权限与安全

#### 5.6.1 默认权限模式

```
默认权限模式
┌────────────────────────────────────────────────┐
│ ○ Auto (自动)    推荐                          │
│   读操作自动，写操作/Shell 弹确认               │
│                                                │
│ ● Plan (计划)    审慎                          │
│   先输出计划，用户确认后执行写操作              │
│                                                │
│ ○ Read-only (只读) 安全                        │
│   仅允许读操作，禁止写和 Shell                  │
└────────────────────────────────────────────────┘
```

#### 5.6.2 工作目录白名单

```
工作目录（Agent 可写入的目录）
┌────────────────────────────────────────────────┐
│ 📁 D:\Projects\pi-agent        [默认] [移除]   │
│ 📁 D:\WebWork                   [移除]          │
│ [+ 添加目录]                                   │
└────────────────────────────────────────────────┘

外部只读路径（Agent 可读取但不可写）
┌────────────────────────────────────────────────┐
│ 📁 D:\Projects\other-project    [移除]         │
│ [+ 添加只读路径]                               │
└────────────────────────────────────────────────┘
```

### 5.7 用量面板

ARCHITECTURE §14 Usage Ledger 的可视化。这是用户感知成本的核心页面。

#### 5.7.1 概览

```
用量概览                           [今日][本周][本月][全部]
┌──────────────────────────────────────────────────────────┐
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│ │ 总 token │ │  总成本  │ │  调用数  │ │ 缓存命中 │    │
│ │  1.2M    │ │  $12.34  │ │   847    │ │   78%    │    │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘    │
│                                                          │
│ ┌─ 成本趋势（折线图）─────────────────────────────────┐ │
│ │     $                                                  │ │
│ │  2 ┤        ╱╲                                         │ │
│ │  1 ┤  ╱╲  ╱  ╲  ╱╲                                     │ │
│ │  0 ┤─╱──╲╱────╲╱──╲────                               │ │
│ │      周一 周二 周三 周四 周五 周六 周日                 │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─ 按 Agent 归因（饼图）──────────────────────────────┐ │
│ │           pi 68%                                      │ │
│ │      writer 22%    researcher 10%                     │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─ 按模型明细（柱状图）────────────────────────────────┐ │
│ │ claude-sonnet-4  ████████████  $8.20                 │ │
│ │ gpt-4o           ██████        $3.10                  │ │
│ │ o1               ██             $1.04                 │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ [导出 CSV]  [清空记录]                                    │
└──────────────────────────────────────────────────────────┘
```

#### 5.7.2 明细列表

可分页的调用明细：

```
┌──────────────────────────────────────────────────────────────┐
│ 时间         Agent    模型             token   成本    状态   │
│ 14:32:01     pi       claude-sonnet-4  1,247   $0.012  ✓    │
│ 14:30:15     pi       claude-sonnet-4  3,402   $0.034  ✓    │
│ 14:28:03     pi       gpt-4o-mini        892   $0.001  ✓    │
│ ...                                                          │
│ [上一页] 1 2 3 ... 42 [下一页]                               │
└──────────────────────────────────────────────────────────────┘
```

### 5.8 记忆面板

ARCHITECTURE §6 记忆系统的管理界面。

#### 5.8.1 编译状态

```
记忆编译状态
┌────────────────────────────────────────────────┐
│ Agent: pi                                      │
│                                                │
│ 编译流水线                                     │
│  ✓ compileSession   2 小时前   成功            │
│  ✓ compileWeek      2 小时前   成功            │
│  ✓ compileLongterm  2 小时前   成功            │
│  ✗ compileFacts     2 小时前   失败 (重试)     │  ← 红色
│  ✓ assemble         2 小时前   成功            │
│  ○ deepMemory       跳过                       │
│                                                │
│ [立即编译]  [反思验证]                          │
└────────────────────────────────────────────────┘
```

#### 5.8.2 事实库浏览

```
事实库 (142 条)
┌────────────────────────────────────────────────┐
│ 🔍 [搜索事实...]    [按标签] [按时间]           │
├────────────────────────────────────────────────┤
│ # 用户偏好 TypeScript                          │
│   标签: preference, language                   │
│   创建: 2026-06-10                             │
│   [编辑] [删除]                                │
├────────────────────────────────────────────────┤
│ # 工作目录 D:\Projects                         │
│   标签: environment                            │
│   ...                                          │
└────────────────────────────────────────────────┘
```

### 5.9 自动化（Cron）

ARCHITECTURE §24.8 CronScheduler 的管理界面（v1.2，v1.0 预留入口）。

```
定时任务                        [+ 新建任务]
┌────────────────────────────────────────────────┐
│ ☑ 每日晨报                                     │
│   cron: 0 9 * * *    Agent: pi                  │
│   "总结昨天的工作进展"                          │
│   上次运行: 今天 09:00 ✓                        │
│   [编辑] [暂停] [立即运行] [删除]               │
├────────────────────────────────────────────────┤
│ ☐ 周报草稿                                     │
│   cron: 0 18 * * 5   Agent: writer             │
│   "生成本周工作周报草稿"                        │
│   已暂停                                        │
│   [编辑] [启用] [立即运行] [删除]               │
└────────────────────────────────────────────────┘
```

### 5.10 关于

```
关于 pi-agent
┌────────────────────────────────────────────────┐
│                                                │
│                  🤖 pi-agent                    │
│                                                │
│                v1.0.0                          │
│                                                │
│  [检查更新]                                    │
│                                                │
│  Electron 39 · React 19 · Node 22              │
│  数据目录: D:\...\pi-agent                     │
│  [打开数据目录]                                │
│                                                │
│  ── 鸣谢 ──                                    │
│  Pi SDK · AG-UI · Fastify · shadcn/ui          │
│                                                │
│  [查看许可证]  [报告问题]                       │
└────────────────────────────────────────────────┘
```

---

## 6. 浮层与弹窗系统

### 6.1 工具确认对话框（关键交互）

ARCHITECTURE §11.3 的核心前端实现——危险操作必须经用户确认。

#### 6.1.1 确认弹窗形态

**不是模态阻塞弹窗**，而是**消息流内的嵌入式确认卡 + 顶部通知**双通道：

```
┌─ 顶部通知条（不阻塞）─────────────────────────────┐
│ ⚠️ Agent 请求执行危险操作  [查看] [批准] [拒绝]  × │
└──────────────────────────────────────────────────┘
```

消息流内对应位置：

```
        ┌─ ⚠️ 需要确认 ─────────────────────┐
        │ 🔧 bash                           │
        │ 命令: rm -rf node_modules          │
        │                                    │
        │ 风险等级: ● 危险                    │
        │ 原因: Shell 操作始终需要确认         │
        │                                    │
        │ [拒绝]  [批准执行]                  │
        └────────────────────────────────────┘
```

#### 6.1.2 风险等级视觉

| 等级 | 颜色 | 图标 | 说明 |
|------|------|------|------|
| safe | 绿色 | ✓ | 自动执行，无确认 |
| moderate | 橙色 | ⚠️ | Auto 模式自动执行，Plan 模式需确认 |
| dangerous | 红色 | ⚠️ | 始终需确认 |

#### 6.1.3 确认交互流程

```
Agent 调用危险工具
  → WebSocket 推送 confirmation_request
  → 前端：顶部通知 + 消息流确认卡（双通道）
  → 工具执行暂停（后端等待）
  → 用户点击 [批准] / [拒绝]
  → WebSocket 发送 confirm 事件
  → 后端继续执行 or 返回 GATE_DENIED
  → 前端更新确认卡状态
```

**超时处理**：确认请求 5 分钟未响应，自动拒绝并通知用户。

### 6.2 通知系统

全局通知中心，右上角通知图标 + 下拉面板：

```
通知 (3)                        [全部已读] [清空]
┌────────────────────────────────────────────────┐
│ ● 记忆编译完成                    2 分钟前     │
│   Agent pi 的记忆已更新                         │
├────────────────────────────────────────────────┤
│ ● 上下文已压缩                    10 分钟前    │
│   会话"重构认证模块"已自动压缩                  │
├────────────────────────────────────────────────┤
│ ● 用量预警                        1 小时前     │
│   今日成本已达 $5（阈值 $10 的 50%）           │
└────────────────────────────────────────────────┘
```

通知来源（ARCHITECTURE §7.3 WS 事件）：
- `memory_updated`
- `agent_status`
- `notification`
- `compaction` 完成
- `usage` 预警

### 6.3 DevLog 面板（开发者）

底部可抽屉式展开的开发者日志（ARCHITECTURE §23.2）：

```
┌─ DevLog (开发者日志) ──────────────────────────── [▾ 收起] ─┐
│ [全部] [info] [warn] [error]            [🔍 筛选] [导出]    │
├─────────────────────────────────────────────────────────────┤
│ 15:03:22 [info]  agent-server started on :3900              │
│ 15:03:23 [info]  provider registry loaded: 3 providers      │
│ 15:03:45 [warn]  cache miss: system hash changed            │
│ 15:04:12 [error] llm call failed: LLM_TIMEOUT (retry 1/2)   │
│ 15:04:15 [info]  llm call succeeded on retry                │
└─────────────────────────────────────────────────────────────┘
```

**快捷键**：`Cmd/Ctrl+D` 切换 DevLog 面板。

### 6.4 命令面板（Cmd/Ctrl+K）

全局命令面板，类 VS Code / Raycast：

```
┌────────────────────────────────────────────────┐
│ 🔍 输入命令或搜索...                            │
├────────────────────────────────────────────────┤
│ > 新建会话                          ⌘N         │
│ > 切换 Agent                                    │
│ > 切换模型                                      │
│ > 切换权限模式 (Auto/Plan/Read-only)            │
│ > 打开设置                          ⌘,         │
│ > 手动压缩当前会话                              │
│ > 立即编译记忆                                  │
│ > 导出当前会话                                  │
│ > 切换主题 (浅色/深色)                          │
│ > 查看用量                                      │
└────────────────────────────────────────────────┘
```

### 6.5 更新提示

ARCHITECTURE §18 auto-updater 的前端：

```
┌─ 🎉 发现新版本 v1.1.0 ───────────────────────┐
│                                              │
│ 更新内容:                                    │
│  • 新增记忆反思功能                          │
│  • 修复 SSE 断连问题                         │
│  • 性能优化                                  │
│                                              │
│              [稍后提醒]  [立即下载]           │
└──────────────────────────────────────────────┘
```

下载进度显示在状态栏，下载完成提示"退出时安装"。

---

## 7. 状态管理设计

遵循 ARCHITECTURE §12「Zustand + TanStack Query」分层。

### 7.1 状态分层

```
┌─────────────────────────────────────────────┐
│ TanStack Query (服务端状态)                  │
│  · 会话列表、Agent 列表、Provider 列表        │
│  · 用量数据、记忆数据                         │
│  · 自动缓存、重试、后台刷新                   │
├─────────────────────────────────────────────┤
│ Zustand (客户端状态)                         │
│  · 当前会话、当前 Agent、当前模型             │
│  · UI 状态（面板折叠、主题、权限模式）         │
│  · 流式状态（正在运行、steer 队列）           │
├─────────────────────────────────────────────┤
│ React 组件 state (局部状态)                  │
│  · 输入框内容、折叠展开、悬停                 │
└─────────────────────────────────────────────┘
```

### 7.2 Zustand Store 设计

#### 7.2.1 sessionStore（会话状态）

```typescript
interface SessionStore {
  // 当前会话
  currentSessionId: string | null
  currentAgentId: string
  currentModelRef: { id: string; provider: string } | null

  // 会话列表（来自 TanStack Query 的快照）
  sessions: SessionSummary[]

  // 运行状态
  isRunning: boolean
  currentRunId: string | null
  steerQueue: SteerMessage[]

  // 权限
  permissionMode: 'auto' | 'plan' | 'readonly'

  // 消息流（流式累积）
  messages: Message[]           // 已完成的消息
  streamingMessage: StreamingMessage | null  // 正在流式的消息

  // Actions
  switchSession: (id: string) => void
  switchAgent: (id: string) => void
  switchModel: (ref: ModelRef) => void
  setPermissionMode: (mode: PermissionMode) => void
  appendStreamEvent: (event: AguiAnyEvent) => void
  finalizeStreaming: () => void
  injectSteer: (msg: SteerMessage) => void
  abortRun: () => void
}
```

#### 7.2.2 uiStore（UI 状态）

```typescript
interface UIStore {
  // 布局
  leftPanelWidth: number
  rightPanelWidth: number
  leftPanelCollapsed: boolean
  rightPanelCollapsed: boolean

  // 主题
  theme: 'light' | 'dark' | 'system'

  // 浮层
  commandPaletteOpen: boolean
  devLogOpen: boolean
  settingsOpen: boolean
  settingsSection: SettingsSection

  // 通知
  notifications: Notification[]

  // 确认请求队列
  pendingConfirmations: ConfirmationRequest[]

  // Actions
  togglePanel: (side: 'left' | 'right') => void
  setTheme: (theme: Theme) => void
  openCommandPalette: () => void
  addNotification: (n: Notification) => void
  dismissNotification: (id: string) => void
  addConfirmation: (req: ConfirmationRequest) => void
  resolveConfirmation: (id: string, action: 'approve' | 'deny') => void
}
```

#### 7.2.3 connectionStore（连接状态）

```typescript
interface ConnectionStore {
  serverStatus: 'online' | 'offline' | 'connecting'
  wsStatus: 'connected' | 'disconnected' | 'reconnecting'
  sseStatus: 'idle' | 'streaming' | 'error'

  reconnect: () => void
  connectWs: () => void
}
```

### 7.3 TanStack Query 使用规范

#### 7.3.1 Query Key 约定

```typescript
// 层级化 key，便于失效
const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: string) => ['sessions', id] as const,
  agents: ['agents'] as const,
  agent: (id: string) => ['agents', id] as const,
  providers: ['providers'] as const,
  models: ['models'] as const,
  usage: (filter: UsageFilter) => ['usage', filter] as const,
  memory: (agentId: string) => ['memory', agentId] as const,
  facts: (agentId: string, query: string) => ['memory', agentId, 'facts', query] as const,
}
```

#### 7.3.2 与 Zustand 的同步

会话列表既在 TanStack Query（服务端真值）又在 Zustand（当前选中），通过 `useQuery` + `useEffect` 同步：

```typescript
function useSessions() {
  const query = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => api.listSessions(),
  })

  const setSessions = useSessionStore((s) => s.setSessions)
  useEffect(() => {
    if (query.data) setSessions(query.data)
  }, [query.data, setSessions])

  return query
}
```

---

## 8. 通信层设计

ARCHITECTURE §24.2 定义了三条通信路径，前端需统一封装。

### 8.1 通信层架构

```
┌─────────────────────────────────────────────┐
│ React 组件                                   │
│   useStreamingRun()  useWebSocket()  useIpc()│
├─────────────────────────────────────────────┤
│ 通信 Hooks 层                                │
│  · useStreamingRun  — SSE 流式对话           │
│  · useWebSocket     — WS 推送 + 确认          │
│  · useIpc           — Electron IPC（配置）    │
│  · useApi           — HTTP REST（TanStack）   │
├─────────────────────────────────────────────┤
│ 底层客户端                                    │
│  · aguiClient (SSE)  · wsClient  · ipcBridge │
│  · httpClient (fetch)                        │
└─────────────────────────────────────────────┘
```

### 8.2 SSE 流式对话（useStreamingRun）

封装 AG-UI SSE 流，对接 §3.8 端到端数据流：

```typescript
function useStreamingRun() {
  const appendEvent = useSessionStore((s) => s.appendStreamEvent)
  const abortControllerRef = useRef<AbortController | null>(null)

  const run = useCallback(async (input: RunAgentInput) => {
    abortControllerRef.current = new AbortController()

    await aguiClient.streamRun({
      ...input,
      signal: abortControllerRef.current.signal,
      onEvent: (event) => {
        switch (event.type) {
          case 'RUN_STARTED':
            useSessionStore.getState().setRunning(true, event.runId)
            break
          case 'TEXT_MESSAGE_CONTENT':
            appendEvent(event)  // 流式追加
            break
          case 'TOOL_CALL_START':
            appendEvent(event)  // 新建工具卡
            break
          case 'TOOL_EXECUTION_UPDATE':
            appendEvent(event)  // 更新工具卡进度
            break
          case 'STATE_SNAPSHOT':
            appendEvent(event)  // compaction 状态
            break
          case 'RUN_FINISHED':
            useSessionStore.getState().finalizeStreaming()
            break
          case 'RUN_ERROR':
            useSessionStore.getState().setError(event.error)
            break
        }
      },
    })
  }, [appendEvent])

  const abort = useCallback(() => {
    abortControllerRef.current?.abort()
    // 通过 WebSocket 发送 abort steer
    wsClient.send({ type: 'steer', message: { type: 'abort', content: '' } })
  }, [])

  return { run, abort }
}
```

### 8.3 WebSocket 客户端（useWebSocket）

处理服务端推送（确认请求、记忆更新、通知等）：

```typescript
function useWebSocket() {
  const addConfirmation = useUIStore((s) => s.addConfirmation)
  const addNotification = useUIStore((s) => s.addNotification)

  useEffect(() => {
    const ws = wsClient.connect(browserConfig.wsUrl, token)

    ws.onMessage((event: WsServerEvent) => {
      switch (event.type) {
        case 'confirmation_request':
          addConfirmation(event)  // 弹出确认卡
          break
        case 'memory_updated':
          queryClient.invalidateQueries({ queryKey: ['memory'] })
          addNotification({ title: '记忆已更新', ... })
          break
        case 'agent_status':
          // 更新 Agent 状态
          break
        case 'notification':
          addNotification(event)
          break
        case 'devlog':
          devLogStore.append(event)
          break
        case 'session:compacted':
          addNotification({ title: '上下文已压缩', ... })
          queryClient.invalidateQueries({ queryKey: ['sessions'] })
          break
      }
    })

    ws.onStatus((status) => {
      useConnectionStore.getState().setWsStatus(status)
    })

    return () => ws.disconnect()
  }, [])
}
```

**重连策略**：指数退避（1s → 2s → 4s → ... → 30s 上限），重连成功后重新订阅。

### 8.4 Electron IPC（useIpc）

安全敏感操作走 Main 进程（ARCHITECTURE §8.2、§16）：

```typescript
// 封装 window.electronAPI（preload 暴露）
function useIpc() {
  return {
    // Provider 配置
    listProviders: () => ipc.invoke('provider:list'),
    saveProvider: (p: ProviderConfig) => ipc.invoke('provider:save', p),
    deleteProvider: (id: string) => ipc.invoke('provider:delete', id),

    // API Key（safeStorage）
    setApiKey: (providerId: string, key: string) =>
      ipc.invoke('credential:set', providerId, key),
    testApiKey: (providerId: string) =>
      ipc.invoke('credential:test', providerId),

    // 出站代理
    getProxy: () => ipc.invoke('proxy:get'),
    setProxy: (config: ProxyConfig) => ipc.invoke('proxy:set', config),
    testProxy: () => ipc.invoke('proxy:test'),

    // 数据目录
    openDataDir: () => ipc.invoke('shell:openPath', getDataDir()),
    chooseDirectory: () => ipc.invoke('dialog:openDirectory'),

    // 自动更新
    checkUpdate: () => ipc.invoke('updater:check'),
    downloadUpdate: () => ipc.invoke('updater:download'),
    installUpdate: () => ipc.invoke('updater:install'),
  }
}
```

### 8.5 CopilotKit 的去留

ARCHITECTURE §12 指定 CopilotKit 仅做 UI 组件。当前 `App.tsx` 使用了 `CopilotSidebar`。

**决策**：v1.0 自建完整对话 UI 后**移除 CopilotKit**，原因：
1. CopilotKit 的 Sidebar UI 无法满足 pi-agent 的工具卡/思考块/确认卡等复杂需求
2. 自研 UI 更好对接 AG-UI 协议的细粒度事件
3. 减少依赖体积

**迁移路径**：P13a 阶段先用自研 `ChatWorkspace` 替代 `CopilotSidebar`，保留 `CopilotKit` Provider 用于 `useCoAgent` 等 hook（如需），最终在 v1.0 RC 前完全移除。

---

## 9. 组件库规范

### 9.1 目录结构

```
apps/desktop/src/renderer/src/
├── components/
│   ├── ui/                    # shadcn/ui 基础组件（generated）
│   │   ├── button.tsx
│   │   ├── dialog.tsx
│   │   ├── dropdown-menu.tsx
│   │   ├── input.tsx
│   │   └── ...
│   ├── chat/                  # 对话专用
│   │   ├── chat-workspace.tsx
│   │   ├── session-list.tsx
│   │   ├── session-item.tsx
│   │   ├── message-stream.tsx
│   │   ├── message-bubble.tsx
│   │   ├── thinking-block.tsx
│   │   ├── tool-call-card.tsx
│   │   ├── confirmation-card.tsx
│   │   ├── input-area.tsx
│   │   └── steer-indicator.tsx
│   ├── settings/              # 设置专用
│   │   ├── settings-layout.tsx
│   │   ├── provider-form.tsx
│   │   ├── agent-form.tsx
│   │   ├── usage-panel.tsx
│   │   ├── memory-panel.tsx
│   │   └── ...
│   ├── overlays/              # 浮层
│   │   ├── command-palette.tsx
│   │   ├── notification-center.tsx
│   │   ├── dev-log-panel.tsx
│   │   └── update-dialog.tsx
│   └── shared/                # 通用业务组件
│       ├── markdown-renderer.tsx
│       ├── code-block.tsx
│       ├── status-bar.tsx
│       ├── title-bar.tsx
│       └── empty-state.tsx
├── hooks/                     # 自定义 hooks
│   ├── use-streaming-run.ts
│   ├── use-websocket.ts
│   ├── use-ipc.ts
│   ├── use-shortcut.ts
│   └── use-virtual-messages.ts
├── stores/                    # Zustand stores
│   ├── session-store.ts
│   ├── ui-store.ts
│   ├── connection-store.ts
│   └── dev-log-store.ts
├── lib/                       # 工具函数
│   ├── api-client.ts
│   ├── ws-client.ts
│   ├── ipc-bridge.ts
│   ├── stream-parsers.ts      # 前端镜像后端解析器链
│   └── markdown-plugins.ts
├── routes/                    # 路由
│   ├── chat-route.tsx
│   └── settings-route.tsx
├── types/                     # 前端专用类型
└── App.tsx
```

### 9.2 组件设计规范

#### 9.2.1 三态组件模式

每个数据驱动组件必须实现三态：

```tsx
function SessionList() {
  const { data, isLoading, isError, error } = useSessions()

  if (isLoading) return <SessionListSkeleton />
  if (isError) return <ErrorState error={error} onRetry={refetch} />
  if (!data?.length) return <EmptyState
    icon="inbox"
    title="还没有会话"
    description="点击新建开始第一次对话"
    action={<Button onClick={newSession}>新建会话</Button>}
  />

  return <VirtualList items={data} renderItem={SessionItem} />
}
```

#### 9.2.2 状态组件清单

| 组件 | 用途 |
|------|------|
| `<Skeleton>` | 加载占位（shadcn/ui） |
| `<EmptyState>` | 空状态（图标+标题+描述+操作） |
| `<ErrorState>` | 错误状态（错误信息+重试） |
| `<LoadingDots>` | 流式占位三点动画 |
| `<ProgressIndicator>` | 工具执行进度 |

### 9.3 设计 Token

| Token | 值 | 用途 |
|-------|-----|------|
| 间距单位 | 4px | 所有间距为 4 的倍数 |
| 圆角 | 0.5rem (8px) | 卡片默认 |
| 阴影 | sm / md / lg | 悬浮卡片递进 |
| 字号 | 12 / 13 / 14 / 16 / 20 / 24 / 32 | 辅助/小/正文/大/标题/H1 |
| 行高 | 1.5（正文）/ 1.25（标题） | |
| 过渡 | 150ms ease (默认) / 250ms (面板) | |

---

## 10. 交互动画规范

「动画流畅」是本项目的硬性要求。所有动画遵循以下原则。

### 10.1 动画原则

1. **有意义**：每个动画传达状态变化，不为动而动
2. **快速**：微交互 100-200ms，过渡 200-350ms，绝不超过 500ms（除进度类）
3. **自然**：使用 `cubic-bezier(0.4, 0, 0.2, 1)` 缓动，模拟物理惯性
4. **可中断**：所有动画可被打断重置，不锁死
5. **可降级**：`prefers-reduced-motion` 时关闭装饰性动画

### 10.2 关键动画清单

| 场景 | 动画 | 时长 | 实现 |
|------|------|------|------|
| 流式文本出现 | 逐字淡入 | 0ms（即时） | 直接追加，靠打字节奏自然 |
| 思考块展开/折叠 | 高度过渡 | 250ms | Framer Motion `AnimatePresence` |
| 工具卡状态变化 | 边框色 + 图标 | 200ms | CSS transition |
| 工具卡展开详情 | 高度 + 淡入 | 200ms | `layout` 动画 |
| 会话切换 | 消息流淡入淡出 | 200ms | `AnimatePresence` mode="wait" |
| 面板折叠 | 宽度过渡 | 250ms | `layout` 动画 |
| 确认卡出现 | 从顶部滑入 + 淡入 | 250ms | `initial/animate/exit` |
| 通知出现 | 从右侧滑入 | 300ms | Toast 模式 |
| 命令面板 | 缩放 + 淡入 | 150ms | Radix Dialog 内置 |
| 打字指示 | 三点呼吸 | 1200ms loop | keyframes |
| 进度条 | 宽度过渡 | 300ms | CSS transition |
| 列表项 hover | 背景色 | 100ms | CSS |
| 按钮 press | 缩放 0.97 | 100ms | `whileTap` |
| Agent 切换 | 头像旋转 + 淡入 | 300ms | keyframes |

### 10.3 会话切换过渡

切换会话是高频操作，过渡必须顺滑：

```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={currentSessionId}
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -8 }}
    transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
  >
    <MessageStream messages={messages} />
  </motion.div>
</AnimatePresence>
```

**优化**：切换时先显示骨架屏（100ms 内），数据就绪后淡入，避免白屏。

### 10.4 流式输出优化

流式输出是性能敏感场景，每秒可能追加数十次：

1. **批量更新**：用 `useDeferredValue` 或 `startTransition` 把高频追加降优先级
2. **虚拟化**：消息超过 50 条启用 `@tanstack/react-virtual`
3. **代码块防抖**：流式时纯文本显示，停止输入 300ms 后再 Shiki 高亮
4. **避免重渲染**：消息项用 `React.memo` + 稳定引用
5. **滚动锚定**：用户在底部时自动跟随，上滚时锁定（显示"新消息"按钮）

```tsx
// 流式追加用 ref + requestAnimationFrame 节流
const bufferRef = useRef<string>('')
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

### 10.5 微交互清单

| 触发 | 反馈 |
|------|------|
| 按钮 hover | 背景色 + 轻微上移 (translateY -1px) |
| 按钮 press | 缩放 0.97 + 阴影收缩 |
| 卡片 hover | 边框色加深 + 阴影增强 |
| 输入框 focus | 边框色变 primary + 轻微发光 |
| 链接 hover | 下划线滑入 |
| 复制成功 | 图标从 📋 变 ✓ 200ms 后恢复 |
| 危险操作 hover | 红色背景脉冲 |
| 权限模式切换 | 图标旋转 + 颜色过渡 |

### 10.6 Reduced Motion 适配

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

Framer Motion 自动尊重此媒体查询。

---

## 11. 响应式与无障碍

### 11.1 响应式策略

Electron 窗口可调整大小，需适配：

| 窗口宽度 | 布局 | 断点类 |
|----------|------|--------|
| ≥ 1280px | 三栏 | 默认 |
| 960-1279px | 双栏（右栏折叠为抽屉） | `md:` |
| < 960px | 单栏（左右栏为覆盖抽屉） | `sm:` |

Tailwind v4 断点：`sm: 640 / md: 768 / lg: 1024 / xl: 1280`

### 11.2 无障碍（a11y）清单

| 维度 | 要求 |
|------|------|
| 语义化 | 用 `<nav>`/`<main>`/`<aside>`/`<article>` 而非全 div |
| 键盘导航 | 所有交互元素 `tabindex` 合理，可见 focus ring |
| ARIA | 动态区域 `aria-live="polite"`（消息流）/ `aria-busy`（加载） |
| 颜色对比 | WCAG AA（正文 4.5:1，大字 3:1） |
| 图标 | 装饰性 `aria-hidden`，功能性配 `aria-label` |
| 快捷键 | 不与系统/读屏冲突，可配置 |
| 动画 | `prefers-reduced-motion` 降级 |
| 表单 | `<label>` 关联，错误 `aria-describedby` |
| 对话框 | focus trap，Esc 关闭，返回焦点 |

### 11.3 键盘快捷键全表

| 快捷键 | 功能 | 上下文 |
|--------|------|--------|
| `Cmd/Ctrl+K` | 命令面板 | 全局 |
| `Cmd/Ctrl+N` | 新建会话 | 全局 |
| `Cmd/Ctrl+,` | 打开设置 | 全局 |
| `Cmd/Ctrl+D` | 切换 DevLog | 全局 |
| `Cmd/Ctrl+\` | 切换左栏 | 对话 |
| `Cmd/Ctrl+Shift+\` | 切换右栏 | 对话 |
| `Cmd/Ctrl+[` | 上一会话 | 对话 |
| `Cmd/Ctrl+]` | 下一会话 | 对话 |
| `Enter` | 发送 | 输入框 |
| `Shift+Enter` | 换行 | 输入框 |
| `↑` / `↓` | 历史输入 | 输入框 |
| `Esc` | 中断运行 / 关闭浮层 | 全局 |
| `Cmd/Ctrl+L` | 聚焦输入框 | 对话 |
| `Cmd/Ctrl+M` | 切换权限模式 | 对话 |

---

## 12. 性能优化策略

### 12.1 渲染性能

| 策略 | 场景 | 实现 |
|------|------|------|
| 虚拟列表 | 会话列表 / 消息流 | `@tanstack/react-virtual` |
| React.memo | 消息项 / 工具卡 | 稳定 props 引用 |
| useDeferredValue | 流式文本 | 不阻塞高优先级更新 |
| 代码分割 | 设置页 / DevLog | `React.lazy` + Suspense |
| 防抖高亮 | 代码块流式 | 300ms 防抖 |
| 批量更新 | SSE 高频事件 | `requestAnimationFrame` 节流 |

### 12.2 数据性能

| 策略 | 场景 | 实现 |
|------|------|------|
| TanStack Query 缓存 | 所有 REST 请求 | staleTime 合理配置 |
| 按需加载 | 会话消息 | 切换时加载，不预加载全部 |
| 分页 | 用量明细 / 事实库 | 服务端分页 |
| 增量更新 | 会话列表 | WebSocket 推送 + 局部更新 |

### 12.3 包体积

| 策略 | 实现 |
|------|------|
| Tree shaking | ESM 依赖，sideEffects 标注 |
| 按需引入 | Lucide 图标按需，shiki 语言按需 |
| 移除 CopilotKit | v1.0 RC 前移除（减重） |
| 分析 | `rollup-plugin-visualizer` 定期检查 |

### 12.4 性能基线（v1.0 验收）

| 指标 | 目标 |
|------|------|
| 首屏渲染 | < 500ms |
| 会话切换 | < 100ms（数据就绪后） |
| 流式首 token 显示 | < 200ms（收到事件后） |
| 长会话滚动 | 60fps（1000+ 消息） |
| 设置页打开 | < 300ms |
| 内存占用 | < 300MB（10 个会话） |

---

## 13. 开发路线图

对齐 ARCHITECTURE §28 实施路线图，前端工作映射如下。

### 13.1 阶段映射

| 后端阶段 | 前端对应 | 交付物 |
|----------|----------|--------|
| P0-P3 | **F0 脚手架** | Tailwind + shadcn/ui 接入，基础布局，主题系统 |
| P4 LLM 接入 | **F1 对话最小可用** | 消息流（纯文本流式）、输入区、会话列表 |
| P5 工具系统 | **F2 工具卡 + 确认** | 工具调用卡、确认弹窗、权限模式切换 |
| P6 Session | **F3 会话持久化** | 会话恢复、分支、搜索、重命名 |
| P7 Compaction | **F4 压缩状态** | 压缩横幅、上下文面板、手动压缩 |
| P8 Memory | **F5 记忆面板** | 记忆状态、事实浏览、立即编译 |
| P9 Usage | **F6 用量面板** | 用量图表、成本统计、本轮提示 |
| P10 WebSocket | **F7 实时推送** | WS 连接、通知中心、DevLog |
| P13a 前端最小集 | **F8 设置中心** | Provider/模型/API Key/Agent/权限设置 |
| — | **F9 打磨** | 动画、a11y、性能、命令面板、快捷键 |

### 13.2 F0 脚手架（1 周）

| 任务 | 验收 |
|------|------|
| 接入 Tailwind v4 + shadcn/ui CLI | `pnpm dlx shadcn@latest init` 可用 |
| 安装 Lucide / Framer Motion / Zustand | 依赖就位 |
| 自定义标题栏组件 | 可拖拽，最小/最大/关闭可用 |
| 三栏布局骨架 | 左/中/右栏可折叠 |
| 主题系统（Light/Dark/System） | 切换生效并持久化 |
| 路由骨架（react-router） | `/` 与 `/settings` 可切 |
| 移除 CopilotSidebar，自建空壳 | 编译通过 |
| 全局状态栏 | 显示占位状态 |

### 13.3 F1 对话最小可用（1.5 周）

| 任务 | 验收 |
|------|------|
| `useStreamingRun` hook | SSE 流接入，事件接收 |
| `MessageStream` 组件 | 流式文本逐字显示 |
| `MessageBubble` 用户/助手气泡 | Markdown 渲染 |
| `InputArea` 组件 | 多行输入，Enter 发送 |
| `SessionList` 组件 | 列表显示，新建会话 |
| `sessionStore` | 当前会话/消息状态 |
| 流式占位（打字指示） | 思考中有反馈 |
| 中断按钮 | 可中断运行 |
| 会话标题自动生成 | 首轮后显示标题 |
| 三态（loading/error/empty） | 全覆盖 |

### 13.4 F2 工具卡 + 确认（1 周）

| 任务 | 验收 |
|------|------|
| `ToolCallCard` 通用组件 | 状态机：pending→running→success/error |
| 工具类型差异化（read/bash/edit/grep/web_search） | 各类型专属展示 |
| `ConfirmationCard` 确认卡 | 嵌入消息流 |
| 顶部确认通知条 | 不阻塞 |
| WebSocket 客户端 | 接收 confirmation_request |
| 权限模式切换器 | Auto/Plan/Read-only 切换生效 |
| 危险操作红色强调 | 视觉区分 |

### 13.5 F3 会话持久化（1 周）

| 任务 | 验收 |
|------|------|
| 会话恢复（重开应用） | 历史会话可见 |
| 会话搜索 | 实时过滤 |
| 会话重命名/删除/导出 | 右键菜单 |
| 会话分支（Pi SDK 树结构） | 分支切换 |
| 会话列表虚拟化 | 1000+ 会话流畅 |
| 草稿持久化 | 切换不丢失输入 |

### 13.6 F4 压缩状态（0.5 周）

| 任务 | 验收 |
|------|------|
| 压缩横幅 | compaction 事件触发 |
| 上下文面板（右栏） | token 用量、阈值、缓存诊断 |
| 手动压缩按钮 | 确认弹窗 + 执行 |
| 压缩完成通知 | WebSocket 推送 |

### 13.7 F5 记忆面板（1 周）

| 任务 | 验收 |
|------|------|
| 记忆编译状态页 | 流水线步骤状态 |
| 事实库浏览 | 搜索/标签筛选 |
| 立即编译按钮 | 触发并反馈 |
| 记忆标签页（右栏） | 置顶记忆概览 |
| 反思验证入口 | shadow/write 模式 |

### 13.8 F6 用量面板（1 周）

| 任务 | 验收 |
|------|------|
| 用量概览卡片 | 总 token/成本/调用/缓存 |
| 成本趋势折线图 | Recharts |
| Agent 归因饼图 | Recharts |
| 模型明细柱状图 | Recharts |
| 明细列表分页 | 服务端分页 |
| 本轮用量提示 | 输入区下方 |
| 状态栏用量 | 实时更新 |
| 用量预警通知 | 阈值可配 |

### 13.9 F7 实时推送（0.5 周）

| 任务 | 验收 |
|------|------|
| WebSocket 重连 | 指数退避 |
| 通知中心 | 右上角下拉 |
| DevLog 面板 | 底部抽屉 |
| 通知分类与已读 | 按类型筛选 |
| 实时用量更新 | WS 推送刷新 |

### 13.10 F8 设置中心（1.5 周）

| 任务 | 验收 |
|------|------|
| 设置布局（左导航+右内容） | 导航切换 |
| Provider 管理完整流程 | 增删改查 + API Key 测试 |
| 模型管理 | 自定义模型增删 |
| Agent 管理 | 编辑/人格模板编辑器 |
| 权限与安全 | 模式切换 + 目录白名单 |
| 通用设置 | 语言/主题/代理/数据目录 |
| 出站代理配置 | 系统代理/手动/测试 |
| 关于页 | 版本 + 检查更新 |
| 表单校验 | react-hook-form + zod |

### 13.11 F9 打磨（1 周）

| 任务 | 验收 |
|------|------|
| 命令面板（Cmd+K） | 全局搜索命令 |
| 全套快捷键 | 见 §11.3 |
| 动画打磨 | 60fps，自然过渡 |
| a11y 审计 | 键盘全可达，对比度达标 |
| 性能优化 | 虚拟化、防抖、memo |
| 系统托盘 | 最小化、快速操作 |
| 自动更新 UI | 发现/下载/安装 |
| 错误边界 | 优雅降级 |
| 空状态设计 | 每个空状态有引导 |

### 13.12 里程碑

| 里程碑 | 前端阶段 | 能力 |
|--------|----------|------|
| **F0-F1** | 对话可用 | 能和 Agent 流式对话 |
| **F2-F3** | 工具+持久化 | 工具卡、确认、会话恢复 |
| **F4-F5** | 上下文+记忆 | 压缩感知、记忆管理 |
| **F6-F7** | 用量+实时 | 成本可视、实时推送 |
| **F8-F9** | 完整体验 | 设置完整、交互打磨 |

总工期约 **10 周**（单人），可与后端 P4-P10 并行推进。

---

## 14. 附录

### 14.1 AG-UI 事件到 UI 映射速查

| AG-UI 事件 | UI 组件 | Zustand action |
|-----------|---------|----------------|
| RUN_STARTED | 输入区切 steer 模式 | setRunning(true) |
| TEXT_MESSAGE_START | 新建助手气泡 | startStreaming() |
| TEXT_MESSAGE_CONTENT | 气泡内容追加 | appendStreamChunk() |
| TEXT_MESSAGE_END | 气泡完成 | finalizeMessage() |
| TOOL_CALL_START | 新建工具卡 | addToolCall() |
| TOOL_CALL_ARGS | 工具卡参数 | updateToolCall() |
| TOOL_CALL_END | 工具卡就绪 | finalizeToolCall() |
| STEP_STARTED | 工具卡执行中 | setToolRunning() |
| STEP_FINISHED | 工具卡完成 | setToolDone() |
| ACTIVITY_SNAPSHOT | 工具卡进度 | updateActivity() |
| STATE_SNAPSHOT | 上下文面板/压缩横幅 | updateState() |
| RUN_FINISHED | 输入区恢复 | setRunning(false) |
| RUN_ERROR | 错误卡 | setError() |

### 14.2 WebSocket 事件到 UI 映射

| WS 事件 | UI 反应 |
|---------|---------|
| confirmation_request | 顶部通知 + 消息流确认卡 |
| memory_updated | 通知 + 刷新记忆 query |
| agent_status | 状态栏更新 |
| notification | 通知中心 |
| devlog | DevLog 面板 |
| session:compacted | 横幅 + 通知 + 刷新会话 |
| usage_update | 状态栏 + 用量面板 |

### 14.3 文件清单（待实现）

```
components/ui/                    # shadcn/ui 生成（约 20 个）
components/chat/                  # 11 个
components/settings/              # 10 个
components/overlays/              # 4 个
components/shared/                # 6 个
hooks/                            # 6 个
stores/                           # 4 个
lib/                              # 6 个
routes/                           # 2 个
```

预估组件总数：**约 70 个文件**。

### 14.4 与后端契约的对应

前端所有 API 调用与 WS 事件的类型，必须从 `@repo/protocol` 导入，确保前后端类型一致：

```typescript
import type {
  AguiAnyEvent,
  RunAgentInput,
  WsServerEvent,
  WsClientEvent,
} from '@repo/protocol'
```

---

> 本文档随实现迭代更新。每个 F 阶段完成后，补充「实际实现与设计差异」章节。
