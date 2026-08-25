# REST/SSE API 路由层

> 所有路由文件位于 `apps/agent-server/src/routes/`，在 `app.ts` 内统一挂载。响应封装见同目录 `api-response.ts`，SSE 工具见 `sse.ts`。

### AG-UI 协议端点

- 描述：AG-UI run/steer/follow-up/fork/navigate/reload/tree/models/tools，前缀 `/ag-ui/agent/default/*`。
- 入口：HTTP `/ag-ui/info`、`/ag-ui/agent/default/run` 等
- 核心：`apps/agent-server/src/routes/agui.route.ts`
- 测试：`apps/agent-server/src/__tests__/agui-route.test.ts`、`agui-thinking-level-route.test.ts`、`s3-1-agui-contract.test.ts`
- 覆盖：sufficient
- last-updated: 2026-08-25

### CopilotKit 兼容端点

- 描述：CopilotKit runtime 代理，`/copilotkit/*`。
- 核心：`apps/agent-server/src/routes/copilotkit.route.ts`
- 覆盖：partial
- last-updated: 2026-08-25

### 会话 / Agent / Team 管理

- 描述：会话 CRUD 与设置、Agent 配置、Team 编排。
- 核心：`apps/agent-server/src/routes/session.route.ts`、`agents.route.ts`、`teams.route.ts`
- 测试：`apps/agent-server/src/__tests__/session-*.test.ts`、`agents-route-temperature.test.ts`、`subagent-temperature.test.ts`
- 覆盖：partial
- last-updated: 2026-08-25

### 门禁 / 确认 / Provider / 设置

- 描述：gate 模式读写、确认请求、LLM provider 与全局设置。
- 核心：`apps/agent-server/src/routes/gate.route.ts`、`confirmation.route.ts`、`provider.route.ts`、`settings.route.ts`
- 测试：`apps/agent-server/src/__tests__/gate-route.test.ts`、`confirmation-route.test.ts`、`provider-route.test.ts`、`provider-route-model-mapping.test.ts`
- 覆盖：partial
- last-updated: 2026-08-25

### 观测 / 用量 / 其他

- 描述：链路追踪 trace、用量 ledger、记忆、cron、i18n、workspace、skills、搜索、websocket、health。
- 核心：`apps/agent-server/src/routes/trace.route.ts`、`usage.route.ts`、`memory.route.ts`、`cron.route.ts`、`i18n.route.ts`、`workspace.route.ts`、`skills.route.ts`、`search.route.ts`、`websocket.route.ts`、`health.route.ts`
- 测试：`apps/agent-server/src/__tests__/websocket-route.test.ts`、`usage-ledger.test.ts`、`trace 相关 model-call-telemetry.test.ts` 等
- 备注：web-search-plugin 与 infinite-canvas-plugin 位于 `apps/agent-server/src/plugins/`，各自携带路由，本次未深入展开。
- 覆盖：partial
- last-updated: 2026-08-25
