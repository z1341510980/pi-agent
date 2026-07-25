# 新手引导（Onboarding Tour）设计文档

- 日期：2026-07-24
- 状态：已批准，待编写实现计划
- 作者：TRAE 助手
- 关联：brainstorming 流程产物

## 1. 目标与范围

### 目标
让新用户首次打开 PI Agent 时，5 分钟内理解四大模块的核心交互，并能独立完成一次小说创作或对话。

### 覆盖范围
- 首页 + 三大入口（基线）
- 小说创作工作区（核心，优先实施）
- 对话工作台
- 设置页
- 快捷键教学（独立 tour）

### 非目标
不引导次要功能（命令面板内部命令、DevLog 详情、用量明细 Dialog、Cron 任务详情、Provider 表单字段），避免拖沓。

## 2. 技术选型

| 维度 | 选择 | 理由 |
|---|---|---|
| 引导库 | `driver.js@1.x` | 零依赖、~5KB、React 19 兼容、现代 popover |
| 状态管理 | zustand（项目已用） | 复用 `stores/` 模式，不引入新依赖 |
| 持久化 | localStorage + 版本号 key | 桌面端 Electron 持久化足够 |
| 触发控制 | App.tsx 启动后判断 + rail 导航栏按钮手动重看 | 符合确认策略 |
| 视觉风格 | 沿用 Tailwind 4 + shadcn token（`--app-bg`/`--surface-1`/`--primary`/`--text`） | 与现有 UI 无缝融合 |
| selector | `data-tour="<id>"` 属性 | 不依赖易变 className |
| 跨 view 切换 | 步骤定义里声明 `view`，driver `onNext` 回调中调用 `setView` | 让引导能在 home → novel → chat → settings 间穿行 |

## 3. 整体架构

```
OnboardingProvider（顶层，App.tsx 内挂载）
├─ OnboardingStore（zustand）
│   ├─ activeTour: string | null
│   ├─ stepIndex: number
│   ├─ completedVersion: string | null
│   └─ actions: { start, next, prev, skip, complete, reset }
│
├─ tours registry（静态配置）
│   ├─ home-tour       // 5 步
│   ├─ novel-tour      // 9 步
│   ├─ chat-tour       // 7 步
│   ├─ settings-tour   // 5 步
│   └─ shortcuts-tour  // 8 步
│
├─ DriverHost（内部组件）
│   └─ 实例化 driver.js，监听 onNext/onPrev/onClose，应用项目主题样式
│
└─ entry points
    ├─ App.tsx useEffect：检测 completedVersion，自动启动 home-tour
    └─ 左侧 rail 导航栏「新手引导」按钮：单击弹菜单选具体 tour
```

## 4. 文件清单

### 新增文件
```
apps/desktop/src/renderer/src/onboarding/
├─ index.ts                       # 公共 API 导出
├─ onboarding-provider.tsx        # 顶层 Provider + DriverHost
├─ onboarding-store.ts             # zustand store
├─ use-onboarding.ts                # 公共 hook（startTour/reset 等）
├─ tours/
│   ├─ index.ts                    # 汇总导出 tours
│   ├─ home-tour.ts                 # 首页 5 步
│   ├─ novel-tour.ts               # 小说 9 步
│   ├─ chat-tour.ts                 # 对话 7 步
│   ├─ settings-tour.ts             # 设置 5 步
│   └─ shortcuts-tour.ts            # 快捷键 8 步
├─ driver-theme.ts                  # driver.js popover 样式覆写（Tailwind token）
└─ types.ts                         # TourStep / Tour 类型
```

### 修改文件
```
apps/desktop/package.json           # + driver.js 依赖
apps/desktop/src/renderer/src/App.tsx
   ├─ 引入 OnboardingProvider 包裹根 div
   ├─ 在 nav 内、设置按钮上方新增「新手引导」RailButton + DropdownMenu
   ├─ 设置按钮去掉 mt-auto，由引导按钮承担 mt-auto
   └─ useEffect：检测首次启动调用 startTour('home-tour')

apps/desktop/src/renderer/src/components/home/home-page.tsx
   └─ 关键节点加 data-tour（home-entries / entry-chat / entry-novel / entry-settings）

apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx
   ├─ 关键节点加 data-tour（novel-header / mode-switcher / view-switcher / right-tab-*）
   └─ novel-tour 启动前在 onStart 中检查项目列表，空则 fallback

apps/desktop/src/renderer/src/components/novel/novel-sidebar.tsx
   └─ data-tour: project-list / project-tree / trash-button

apps/desktop/src/renderer/src/components/novel/novel-canvas.tsx
   └─ data-tour: canvas / canvas-minimap / canvas-toolbar

apps/desktop/src/renderer/src/components/novel/matrix/matrix-workspace.tsx
   └─ data-tour: matrix-toolbar / matrix-legend / matrix-view

apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx
   └─ data-tour: editor / editor-toolbar / chapter-nav / reverse-arrange

apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx
   └─ data-tour: chat-workspace / workspace-grid / sidebar / chat-header / status-bar / devlog-panel / command-palette

apps/desktop/src/renderer/src/components/chat/session-list.tsx
   └─ data-tour: session-list / session-item

apps/desktop/src/renderer/src/components/chat/input-area.tsx
   └─ data-tour: input-card / input-toolbar

apps/desktop/src/renderer/src/components/chat/permission-mode-switch.tsx
   └─ data-tour: permission-switch

apps/desktop/src/renderer/src/components/chat/model-selector.tsx
   └─ data-tour: model-selector

apps/desktop/src/renderer/src/components/chat/tool-call-card.tsx
   └─ data-tour: tool-call-card

apps/desktop/src/renderer/src/components/settings/settings-page.tsx
   └─ data-tour: settings-body / settings-content / nav-providers / nav-models / nav-agents / nav-security / nav-cron / nav-general / nav-about
```

## 5. 引导步骤详细设计

### 5.1 首页引导（home-tour，5 步）

| 步骤 | target | 说明 |
|---|---|---|
| 1 欢迎 | 根 div 居中卡片 | "欢迎使用 PI Agent，5 分钟带你熟悉四大模块" |
| 2 三大入口 | `[data-tour="home-entries"]` | "对话工作台 / 小说创作 / 设置 三个入口" |
| 3 对话工作台 | `[data-tour="entry-chat"]` | "多轮对话，处理编码与分析" |
| 4 小说创作 | `[data-tour="entry-novel"]` | "多 Agent 协作的长篇小说创作工作台" |
| 5 设置 | `[data-tour="entry-settings"]` | "配置 Provider、Agent 人格、模型与安全。即将进入小说工作台 →" |

最后一步 `onNext`：自动 `setView('novel')` + 启动 `novel-tour`。

### 5.2 小说创作引导（novel-tour，9 步）

| 步骤 | target | 说明 |
|---|---|---|
| 1 项目树 sidebar | `[data-tour="project-list"]` | "创建、切换、删除小说项目" |
| 2 工作区模式切换 | `[data-tour="mode-switcher"]` | "切换写作 / 分屏 / 矩阵三种模式" |
| 3 视图切换 | `[data-tour="view-switcher"]` | "画布看关系图，矩阵看时间线" |
| 4 画布 | `[data-tour="canvas"]` | "节点 = 实体，连线 = 关系" |
| 5 画布工具栏 | `[data-tour="canvas-toolbar"]` | "切换布局、过滤关系、查找路径、缩放" |
| 6 矩阵视图 | `[data-tour="matrix-view"]` | "实体行 × 章节列，追踪角色出场与伏笔" |
| 7 章节编辑器 | `[data-tour="editor"]` | "Tiptap 富文本，上一章/下一章快速跳转" |
| 8 反推实体按钮 | `[data-tour="reverse-arrange"]` | "从正文自动提取角色/冲突/伏笔到矩阵" |
| 9 右侧面板 | `[data-tour="right-tab-conversation"]` | "对话：与多 Agent 讨论；详情：修改属性；审计：检查一致性 →" |

最后一步 `onNext`：自动 `setView('chat')` + 启动 `chat-tour`。

**无项目 fallback**：novel-tour 启动前在 `onStart` 检查 `projectsQuery.data`，若为空则跳过画布/矩阵/编辑器步骤（步骤 4-8），仅引导 sidebar + toolbar + 右侧面板。

**专注模式保护**：novel-tour `onStart` 调用 `useNovelWorkspaceLayoutStore.getState().setFocusMode(false)`，避免专注模式浮层遮挡。

### 5.3 对话工作台引导（chat-tour，7 步）

| 步骤 | target | 说明 |
|---|---|---|
| 1 会话列表 | `[data-tour="session-list"]` | "新建、切换、删除对话会话" |
| 2 消息流 | `[aria-label="消息流"]`（已有） | "对话流，工具调用会折叠成卡片" |
| 3 输入区 | `[data-tour="input-card"]` | "Enter 发送，Shift+Enter 换行。@ 引用会话，/ 触发斜杠指令" |
| 4 模型选择器 | `[data-tour="model-selector"]` | "选择当前会话使用的 LLM 模型" |
| 5 权限模式 | `[data-tour="permission-switch"]` | "Auto/Plan/Read-only/Full 四种权限模式" |
| 6 右侧上下文面板 | `[aria-label="上下文状态"]`（已有） | "token 占用、关联文件、记忆摘要、活动日志" |
| 7 状态栏 | `[data-tour="status-bar"]` | "在线状态、延迟、模型与权限模式 →" |

最后一步 `onNext`：自动 `setView('settings')` + 启动 `settings-tour`。

### 5.4 设置页引导（settings-tour，5 步）

| 步骤 | target | 说明 |
|---|---|---|
| 1 设置导航 | `[aria-label="设置导航"]`（已有） | "7 个设置项，重点看 3 个" |
| 2 Provider 管理 | `[data-tour="nav-providers"]` | "管理 LLM 服务商" |
| 3 模型管理 | `[data-tour="nav-models"]` | "查看每个 Provider 的可用模型" |
| 4 Agent 管理 | `[data-tour="nav-agents"]` | "Agent 人格配置，含系统提示词与温度" |
| 5 权限与安全 | `[data-tour="nav-security"]` | "全局权限模式 + 工作目录白名单。新手建议先选 Plan 模式 →" |

最后一步 `onNext`：自动 `setView('home')` + 启动 `shortcuts-tour`（也可让用户选择跳过快捷键教学）。

### 5.5 快捷键教学引导（shortcuts-tour，8 步）

基于代码核实，项目已有完整快捷键体系（`use-shortcut.ts` 全局 12 个 + `use-novel-workspace-shortcuts.ts` 小说专属 7 个）。

**设计决策**：shortcuts-tour 全部使用居中 popover（不绑定具体 DOM 元素），因为快捷键是全局概念，无需依赖特定 view 的元素渲染。这样无论用户从哪个 view 启动该 tour 都能正常工作，也避免了跨 view 切换的复杂性。

| 步骤 | target | 说明 | 快捷键 |
|---|---|---|---|
| 1 命令面板 | 居中 popover（无 element） | "打开命令面板，快速跳转任何功能" | `Ctrl/Cmd+K` |
| 2 新建会话 | 居中 popover | "新建对话会话" | `Ctrl/Cmd+N` |
| 3 打开设置 | 居中 popover | "打开设置" | `Ctrl/Cmd+,` |
| 4 切换 DevLog | 居中 popover | "切换底部开发日志面板" | `Ctrl/Cmd+D` |
| 5 对话切栏 | 居中 popover | "切换左侧会话列表 / 右侧上下文" | `Ctrl/Cmd+\` / `Ctrl/Cmd+Shift+\` |
| 6 会话跳转 | 居中 popover | "上一会话 / 下一会话" | `Ctrl/Cmd+[` / `Ctrl/Cmd+]` |
| 7 小说模式 | 居中 popover | "写作 / 矩阵 / 分屏 / 专注模式" | `Ctrl/Cmd+1/2/3` / `Ctrl/Cmd+Shift+F` |
| 8 小说侧栏 | 居中 popover | "切左栏 / 切右栏。完成全部引导 →" | `Ctrl/Cmd+B` / `Ctrl/Cmd+J` |

shortcuts-tour 每步在 popover 中用 kbd 元素展示快捷键（复用 CommandPalette 中 `cmd.shortcut` 的展示样式）。

driver.js 居中 popover 配置：步骤定义中 `element` 留空或设为 `document.body`，配合 `popover.position: 'center'`（或 driver.js 等价的居中展示配置）。

最后一步 `onNext`：`completeTour('shortcuts-tour')`，写 `completedVersion = CURRENT_VERSION` 到 localStorage，关闭引导。若当前不在 home view 则 `setView('home')` 回到首页。

## 6. selector 标注清单

### 首页
`home-entries`、`entry-chat`、`entry-novel`、`entry-settings`

### 小说
`novel-header`、`mode-switcher`、`view-switcher`、`canvas`、`canvas-minimap`、`canvas-toolbar`、`matrix-toolbar`、`matrix-legend`、`matrix-view`、`editor`、`editor-toolbar`、`chapter-nav`、`reverse-arrange`、`right-tab-conversation`、`right-tab-detail`、`right-tab-audit`、`project-list`、`project-tree`、`trash-button`

### 对话
`chat-workspace`、`workspace-grid`、`sidebar`、`session-list`、`session-item`、`chat-header`、`input-card`、`input-toolbar`、`permission-switch`、`model-selector`、`tool-call-card`、`status-bar`、`devlog-panel`、`command-palette`

### 设置
`settings-body`、`settings-content`、`nav-providers`、`nav-models`、`nav-agents`、`nav-security`、`nav-cron`、`nav-general`、`nav-about`

### 复用已有 selector（无需新增）
`aria-label="会话"`、`aria-label="消息流"`、`aria-label="PI Agent 工作台"`、`aria-label="发送消息"`、`aria-label="设置中心"`、`aria-label="设置导航"`、`aria-label="上下文状态"`

driver.js 配置示例：
```typescript
{ element: '[data-tour="canvas"]', popover: { title, description } }
```

## 7. 持久化与触发逻辑

### localStorage Schema
```typescript
// key: 'pi-agent.onboarding'
interface OnboardingState {
  completedVersion: string | null   // 例如 "v1"
  skippedTours: string[]            // 用户跳过的 tour id
  lastSeenAt: number               // 时间戳
}
```

### 首次启动自动触发
```typescript
const CURRENT_VERSION = 'v1'

useEffect(() => {
  if (ready) {
    const state = loadOnboardingState()
    if (state.completedVersion !== CURRENT_VERSION && !state.skippedTours.includes('home-tour')) {
      const timer = setTimeout(() => startTour('home-tour'), 500)
      return () => clearTimeout(timer)
    }
  }
}, [ready])
```

### 跨 tour 自动衔接
每个 tour 的最后一步 `onNext`：
```typescript
onNext: () => {
  completeTour('home-tour')
  setView('novel')
  startTour('novel-tour')  // 内部已有 waitForElement 机制
}
```

### 手动重看入口（rail 导航栏）
位置：左侧 rail nav，设置按钮上方。

实现：
```tsx
{/* 新增：新手引导按钮，承担 mt-auto（贴底） */}
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <RailButton
      icon={HelpCircle}
      label="新手引导"
      className="mt-auto"
    />
  </DropdownMenuTrigger>
  <DropdownMenuContent side="right" align="end">
    <DropdownMenuItem onClick={() => startTour('home-tour')}>首页引导</DropdownMenuItem>
    <DropdownMenuItem onClick={() => startTour('novel-tour')}>小说创作</DropdownMenuItem>
    <DropdownMenuItem onClick={() => startTour('chat-tour')}>对话工作台</DropdownMenuItem>
    <DropdownMenuItem onClick={() => startTour('settings-tour')}>设置页</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onClick={() => startTour('shortcuts-tour')}>快捷键教学</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>

{/* 设置按钮去掉 mt-auto，紧贴引导按钮上方 */}
<RailButton icon={SettingsIcon} label="设置" ... />
```

### 跳过逻辑
driver.js popover 右上角 ✕ 关闭按钮 → 触发 `onClose` → 调用 `skipTour(tourId)` → 写入 `skippedTours` → 不再自动触发该 tour，但保留手动重看入口。

## 8. 错误处理与边界

| 场景 | 处理 |
|---|---|
| 步骤目标元素找不到 | driver.js `onPopoverRender` 前轮询 200ms×5 次；仍找不到则自动 `next()` 跳过，记 warning |
| 小说工作区无项目 | novel-tour `onStart` 检查 `projectsQuery.data`，若空则跳过画布/矩阵/编辑器步骤（4-8），仅引导 sidebar + 右侧面板 |
| 用户中途切换 view | 监听 `view` 变化，若与当前 tour 期望 view 不符则暂停 driver，提示「返回 X 视图继续引导」 |
| 用户按 Esc | driver 默认 Esc 关闭 → 触发 `onClose` → 走 skip 流程 |
| 多个 tour 同时启动 | store 里 `activeTour` 为单值，后启动的覆盖前者并报 warning |
| 引导途中后端断连 | 不影响引导，元素仍在 DOM |
| 小说专注模式开启 | novel-tour `onStart` 强制 `setFocusMode(false)` |

## 9. 测试策略

### 单元测试（vitest + jsdom）
```
onboarding/__tests__/
├─ onboarding-store.test.ts        # store 状态机：start/next/prev/skip/complete/reset
├─ persistence.test.ts             # localStorage 读写 + 版本号比对
└─ tours.test.ts                   # 5 个 tour 配置完整性（每步必须有 element 或 target）
```

### 集成测试
```
__tests__/
└─ onboarding-flow.test.tsx        # 模拟首次启动 → home-tour 自动播放 → 完成 → completedVersion 写入
```

### E2E（Playwright，可选，后续阶段）
- 首次启动到完成全流程
- rail 导航栏按钮 → 选具体 tour → 启动

## 10. 实施阶段划分

按用户偏好「分阶段执行 + 每阶段审查」，且小说优先：

| 阶段 | 内容 | 说明 |
|---|---|---|
| 1 基础设施 | driver.js 接入 + Provider + Store + 持久化 + driver-theme | 骨架，单元测试 |
| 2 小说创作工作区 | novel-tour 9 步 + 全部 novel 组件 data-tour 标注 + 无项目 fallback + 专注模式保护 | **优先实施** |
| 3 首页 | home-tour 5 步 + home-page data-tour + 首次启动自动触发链路 + rail 导航栏「新手引导」按钮 | 顺位下调，但仍是首次启动入口 |
| 4 对话工作台 | chat-tour 7 步 + chat 各组件 data-tour + 跨 view 衔接（home → chat） | |
| 5 设置页 | settings-tour 5 步 + settings-page data-tour | |
| 6 快捷键教学 | shortcuts-tour 8 步 + popover 中 kbd 元素展示 | |
| 7 收尾 | 完整测试覆盖 + 性能优化（懒加载 driver.js） + 文档更新 | |

每阶段完成后同步进度并请用户审查，审查通过再进入下一阶段。

## 11. 代码事实核实记录

通过翻阅代码确认的关键事实：

1. **快捷键 hook 已就位**
   - `apps/desktop/src/renderer/src/hooks/use-shortcut.ts`：全局 12 个快捷键（K/N/,/D/\/Shift+\//[ / ]/Esc/L/M/Z/Shift+Z/Y）
   - `apps/desktop/src/renderer/src/hooks/use-novel-workspace-shortcuts.ts`：小说专属 7 个（B/J/1/2/3/Shift+F/Esc）
   - 引导步骤只需展示提示，无需 mock 系统。

2. **CommandPalette 已有 shortcut 字段**
   - `apps/desktop/src/renderer/src/components/overlays/command-palette.tsx:21` 定义 `shortcut?: string`
   - shortcuts-tour 复用此展示样式（kbd 元素）

3. **小说工作区 stores 已就位**
   - `apps/desktop/src/renderer/src/stores/novel-workspace-layout-store.ts`：侧栏/右栏/模式/专注模式状态
   - novel-tour `onStart` 可调用 `useNovelWorkspaceLayoutStore.getState()` 检查并强制非专注模式

4. **RailButton 组件签名兼容**
   - `apps/desktop/src/renderer/src/App.tsx:132-164` 已有 `className` 参数
   - 新增「新手引导」按钮无需改组件

5. **App.tsx 导航结构**
   - `apps/desktop/src/renderer/src/App.tsx:60-89`：`<nav>` 内 4 个 RailButton，设置按钮在 `mt-auto` 位置
   - 新增按钮位置：设置按钮之前，承担 `mt-auto`

6. **DropdownMenu 组件可用**
   - 项目 radix-ui 已集成，`@/components/ui/dropdown-menu` 可直接使用

## 12. 待办

- [ ] 调用 writing-plans 技能，制定阶段 1-7 的详细实现计划
- [ ] 实现阶段 1：基础设施
- [ ] 实现阶段 2：小说创作工作区（优先）
- [ ] 实现阶段 3-7
