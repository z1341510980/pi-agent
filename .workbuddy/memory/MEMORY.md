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
- `docs/FRONTEND_DEVELOPMENT.md` — 前端完整规格（14 章节）
- `PROJECT_SPEC.md` — 项目规范（命名/代码规范/构建）

## 前端开发路线
- F0 脚手架 → F1 对话可用 → F2 工具卡+确认 → F3 会话持久化 → F4 压缩 → F5 记忆 → F6 用量 → F7 实时推送 → F8 设置 → F9 打磨
- 与后端 P4-P10 并行，约 10 周

## 通信架构
- SSE (AG-UI)：流式对话
- WebSocket：确认请求/通知/记忆/压缩推送
- Electron IPC：Provider/API Key/代理（安全敏感，走 Main）
- HTTP REST：会话/用量/配置查询
