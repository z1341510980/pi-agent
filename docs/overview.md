# pi-agent 前端功能开发文档 — 工作概览

> 本文档由「速构构」基于 `docs/ARCHITECTURE.md` 编写，定义 pi-agent 桌面应用渲染进程的完整前端规格。

## 已完成交付物

| 文件 | 内容 |
|------|------|
| `docs/FRONTEND_DEVELOPMENT.md` | 完整前端功能开发文档（14 章节，约 1500 行） |
| `overview.md` | 本概览文档 |

## 文档核心内容

### 1. 技术栈选型（§1.3）
在现有 React 19 + TanStack Query 基础上补齐：
- **Tailwind CSS v4 + shadcn/ui + Radix UI** — 组件库
- **Lucide React** — 图标
- **Zustand** — 客户端状态（ARCHITECTURE §12 指定）
- **Framer Motion** — 动画（满足"动画流畅"要求）
- **react-markdown + Shiki** — Agent 输出渲染
- **Recharts** — 用量图表
- **@tanstack/react-virtual** — 长列表虚拟化
- 决策：v1.0 移除 CopilotKit（自建 UI 更好对接 AG-UI 细粒度事件）

### 2. 信息架构（§2）
四大顶层模块：
- **对话工作台**（80% 使用时长）— 三栏布局
- **设置中心** — 9 个子页面
- **浮层系统** — 确认/通知/命令面板/DevLog
- **系统托盘** — 最小化快速操作

### 3. 对话工作台（§4，核心）
- 左栏：会话列表 + Agent 切换器（按日期分组、虚拟化）
- 中栏：消息流（8 种消息类型）+ 输入区（含 steer 模式）
- 右栏：上下文面板（token 用量/缓存诊断/记忆概览）
- 消息类型矩阵：用户/助手文本/思考块/工具调用/确认请求/情绪/卡片/压缩通知/错误
- 工具卡按类型差异化（read/bash/edit/grep/web_search 等）

### 4. 设置中心（§5）
- Provider 管理（含 API Key 连通性测试 + safeStorage 加密）
- 模型管理 / Agent 管理（含人格模板编辑器）
- 权限与安全（Auto/Plan/Read-only + 工作目录白名单）
- 用量面板（折线/饼/柱状图 + 明细）
- 记忆面板（编译流水线状态 + 事实库浏览）
- 自动化（Cron）/ 通用（出站代理/主题/语言）

### 5. 状态管理（§7）
三层分离：
- **TanStack Query** — 服务端状态（会话/Agent/Provider/用量）
- **Zustand** — 客户端状态（sessionStore / uiStore / connectionStore）
- **React state** — 局部 UI

### 6. 通信层（§8）
四条通道封装为 hooks：
- `useStreamingRun` — SSE 流式对话（AG-UI 事件 → Zustand action）
- `useWebSocket` — WS 推送（确认/通知/记忆/压缩）+ 重连
- `useIpc` — Electron IPC（Provider/API Key/代理/更新）
- `useApi` — HTTP REST（TanStack Query）

### 7. 动画规范（§10）
- 原则：有意义/快速(100-350ms)/自然/可中断/可降级
- 关键动画清单 14 项（流式/思考块/工具卡/会话切换/面板/确认/通知等）
- 流式优化：useDeferredValue + requestAnimationFrame 节流 + 虚拟化 + 代码块防抖
- `prefers-reduced-motion` 适配

### 8. 无障碍与性能（§11-12）
- 响应式三档（≥1280 三栏 / 960-1279 双栏 / <960 单栏）
- a11y 清单（语义化/键盘/ARIA/对比度/focus trap）
- 14 个全局快捷键（Cmd+K 命令面板等）
- 性能基线：首屏 <500ms / 会话切换 <100ms / 流式首 token <200ms / 长会话 60fps

### 9. 开发路线图（§13）
9 个前端阶段（F0-F9），与后端 P4-P10 并行，总工期约 10 周：
- F0 脚手架 → F1 对话可用 → F2 工具卡+确认 → F3 会话持久化 → F4 压缩状态 → F5 记忆面板 → F6 用量面板 → F7 实时推送 → F8 设置中心 → F9 打磨

## 可视化设计（4 张）

1. **信息架构总览** — 四大模块树状结构
2. **主对话工作台线框** — 三栏完整布局实样
3. **消息类型卡片规范** — 8 种消息组件视觉
4. **实时交互时序流程** — 工具确认/引导/压缩三方时序

## 关键设计决策

| 决策 | 理由 |
|------|------|
| 移除 CopilotKit，自建对话 UI | CopilotKit Sidebar 无法满足工具卡/思考块/确认卡等复杂需求 |
| 确认弹窗用非阻塞浮层 | 不切断正在进行的流式输出 |
| 权限模式始终可见 | 让用户随时知道 Agent 能做什么 |
| 流式追加用 rAF 节流 | 高频 SSE 事件不阻塞主线程 |
| 上下文面板实时显示 token | 让用户感知"Agent 看到了什么" |
| 本轮成本输入区下方轻量显示 | 成本可感不打扰 |

## 后续建议

1. F0 阶段优先接入 Tailwind + shadcn/ui CLI，建立设计 token
2. F1 阶段先打通 SSE 流式渲染管线，验证 AG-UI 事件到 UI 的映射
3. 状态管理从开始就用 Zustand + TanStack Query 分层，避免后期重构
4. 组件库按 §9.1 目录结构组织，chat/settings/overlays 分离
5. 每个数据驱动组件从一开始就实现 loading/error/empty 三态
