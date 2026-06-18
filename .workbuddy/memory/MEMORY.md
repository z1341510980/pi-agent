# pi-agent 项目长期记忆

## 项目概况
- **类型**：AI Agent 桌面应用（Electron + React + Pi SDK）
- **结构**：pnpm monorepo
  - `apps/agent-server/` — Fastify 后端（AG-UI 协议 + CopilotKit Runtime）
  - `apps/desktop/` — Electron 客户端（React + TypeScript）
  - `packages/config/` — 共享配置（Zod Schema，browser/node/shared）
  - `packages/shared/` — 共享类型与工具
- **技术栈**：React 19 / TypeScript 5.9 / Fastify 5 / Zod 4 / TanStack Query 5 / electron-vite 7

## 前端技术栈决策（2026-06-17 确定）
- 样式：Tailwind CSS v4 + shadcn/ui + Radix UI
- 图标：Lucide React
- 客户端状态：Zustand（ARCHITECTURE §12 指定）
- 动画：Framer Motion
- Markdown：react-markdown + Shiki
- 图表：Recharts
- 虚拟列表：@tanstack/react-virtual
- 决策：v1.0 移除 CopilotKit，自建对话 UI

## 关键文档
- `docs/ARCHITECTURE.md` — 47 项架构决策（后端为主）
- `docs/FRONTEND_DESIGN_SYSTEM.md` — 前端设计体系（设计语言/布局/组件/交互/状态/动画/路线图，11 章，2026-06-18 重构）
- `docs/FRONTEND_DEVELOPMENT.md` — 前端旧版规格（已废，保留参考）
- `docs/frontend-design-system-overview.md` — 重构概览
- `PROJECT_SPEC.md` — 项目规范（命名/代码规范/构建）

## 前端开发路线
- F0 脚手架 → F1 对话可用 → F2 工具卡+确认 → F3 会话持久化 → F4 压缩 → F5 记忆 → F6 用量 → F7 实时推送 → F8 设置 → F9 打磨
- 与后端 P4-P10 并行，约 10 周

## 前端设计体系（2026-06-18）
- CSS 变量体系：main.css 定义完整语义色（**light-first 设计，默认浅色**），含 app-bg/surface-1/2/3/titlebar/statusbar
- 主题切换：浅色（默认） ↔ 深色，通过 `data-theme` 属性 + prefers-color-scheme 媒体查询
- 布局：grid-cols-[272px_minmax(480px,1fr)_328px]，三栏 Grid
- 标题栏：40px，-webkit-app-region，自定义窗口控件
- 状态栏：32px，底部固定，连接状态圆点统一规范（绿/黄/红 + 阴影发光）
- 输入区：textarea 自适应高度（上限 200px），Enter 发送/Shift+Enter 换行，运行中切中断按钮
- 消息流：max-w-[720px] 居中，自动滚动策略（用户手动滚动后停止跟随）
- 状态三态：每个数据组件需要 loading/error/empty 三态（强制性）
- F1 正在进行中（SSE 流式对话已通，工具调用/思考块等消息类型已实现）

## 通信架构
- SSE (AG-UI)：流式对话
- WebSocket：确认请求/通知/记忆/压缩推送
- Electron IPC：Provider/API Key/代理（安全敏感，走 Main）
- HTTP REST：会话/用量/配置查询

## 用户偏好 · 跨项目

- **禁用 emoji 表情**:后续任何产出(文案、UI 文案、icon 字符、设计稿中的装饰符号)都不使用 unicode emoji 表情符号(例如 ✦、↧、↥、⌒、▼、▲、✓、◆、★、☆、→、←、↑、↓ 等符号化字符如果充当"emoji 角色"也需谨慎)。需要图标时优先用纯文本字符(字母/数字/几何符号)、或说明文字 + 几何形状组合。设计稿中已用 ⌕ / ↧ / ✓ 等的需逐步替换为 Lucide/SF Symbols 风格的 line icon 占位。
- **设计稿字号补充**:Plus Jakarta Sans 没有 `Semi Bold` 风格,模糊匹配为 `SemiBold`(单字)。

