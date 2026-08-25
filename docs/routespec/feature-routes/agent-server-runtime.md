# agent-server 骨架与 Agent 运行时

### 服务端组装（createApp）

- 描述：Fastify 应用组装，按序注册全部宿主插件与 API 路由，构建 Pi Agent 运行时依赖。
- 入口：`apps/agent-server/src/index.ts`（读取 dotenv → createApp → listen）
- 核心：`apps/agent-server/src/app.ts`（import 顺序即装配顺序：cors → rate-limit → error-handler → request-context → event-bus → websocket-support → pi-sdk → usage-ledger → memory-store → subagent → team → database → plugin-loader → cron，随后挂载 routes/ 下各路由）
- 测试：`apps/agent-server/src/__tests__/architecture-boundaries.test.ts`
- 覆盖：partial
- last-updated: 2026-08-25

### Pi Agent 会话运行时

- 描述：基于 pi-agent-core SDK 的会话创建、存储、身份注册、后台任务与子代理桥接。
- 入口：AG-UI run 端点（见 api-routes.md）
- 核心：
  - `apps/agent-server/src/core/agent/pi-session.ts`（createPiSession）
  - `apps/agent-server/src/core/agent/pi-agui-agent.ts`（PiAgUiAgent）
  - `apps/agent-server/src/core/agent/session-store.ts`（PiSessionStore）
  - `apps/agent-server/src/core/agent/session-identity-registry.ts`
  - `apps/agent-server/src/core/agent/runtime-run-registry.ts` / `background-work-registry.ts`
  - `apps/agent-server/src/core/agent/pi-subagents-host.ts` / `pi-subagents-bridge.ts` / `pi-actors-kernel.ts`
- 测试：`apps/agent-server/src/__tests__/agent-runtime.test.ts`、`agent-persistence.test.ts`、`session-store.test.ts`、`pi-subagents-host.test.ts` 等（同目录多个 agent/session 前缀测试）
- 备注：core/ 下还有 config、cron、db、i18n、memory、observability、plugin、policy、session、tool、tracer、usage 子模块，本次未逐一展开。
- 覆盖：partial
- last-updated: 2026-08-25

### 工具门禁与确认（Gate / Confirmation）

- 描述：Agent 工具调用的 Gate 门禁与人机确认管理。
- 核心：`apps/agent-server/src/core/tool/gate.ts`、`apps/agent-server/src/core/tool/confirmation-manager.ts`
- 测试：`apps/agent-server/src/__tests__/gate.test.ts`、`confirmation-manager.test.ts`、`confirmation-tools.test.ts`、`s2-confirmation-e2e.test.ts`
- 覆盖：partial
- last-updated: 2026-08-25
