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
- 测试：`apps/agent-server/src/__tests__/gate-route.test.ts`、`confirmation-route.test.ts`、`provider-route.test.ts`、`provider-route-model-mapping.test.ts`、`apps/desktop/src/renderer/src/components/settings/__tests__/provider-manager-id.test.ts`
- 备注：Provider 创建由后端或桌面端分配与名称无关的唯一 ID；桌面端 Provider 管理还负责旧 localStorage 缓存与后端记录合并。
- 覆盖：sufficient
- last-updated: 2026-08-27

### 观测 / 用量 / 其他

- 描述：链路追踪 trace、用量 ledger、记忆、cron、i18n、workspace、skills、搜索、websocket、health。
- 核心：`apps/agent-server/src/routes/trace.route.ts`、`usage.route.ts`、`memory.route.ts`、`cron.route.ts`、`i18n.route.ts`、`workspace.route.ts`、`skills.route.ts`、`search.route.ts`、`websocket.route.ts`、`health.route.ts`
- 测试：`apps/agent-server/src/__tests__/websocket-route.test.ts`、`usage-ledger.test.ts`、`trace 相关 model-call-telemetry.test.ts` 等
- 备注：web-search-plugin 与 infinite-canvas-plugin 位于 `apps/agent-server/src/plugins/`，各自携带路由，本次未深入展开。
- 覆盖：partial
- last-updated: 2026-08-25

### Infinite Canvas 图片生成

- 描述：无限画布项目的文本生成、图片生成与图片编辑路由；图片 Provider 支持同步图片响应以及 xKiro 风格的异步任务提交与轮询。
- 入口：`POST /api/plugins/infinite-canvas/projects/:projectId/generate-image`、`POST /api/plugins/infinite-canvas/projects/:projectId/edit-image`、`GET/PUT /api/plugins/infinite-canvas/media-config`
- 核心：`apps/agent-server/src/plugins/infinite-canvas-plugin/routes.ts`、`apps/agent-server/src/plugins/infinite-canvas-plugin/index.ts`、`apps/agent-server/src/core/config/media-generator.ts`
- 客户端：`apps/desktop/src/renderer/src/api/infinite-canvas-client.ts`、`apps/desktop/src/renderer/src/components/infinite-canvas/infinite-canvas-workspace.tsx`、`apps/desktop/src/renderer/src/components/infinite-canvas/media-config-dialog.tsx`
- 测试：`apps/agent-server/src/core/config/media-generator.test.ts`、`apps/agent-server/src/plugins/infinite-canvas-plugin/agent-ops.test.ts`
- 备注：xKiro 使用 `POST /v1/images/generations` 返回 job ID，再轮询 `GET /v1/images/generations/{id}`；编辑使用 multipart `/v1/images/edits`，同样轮询任务结果。画布上游图片通过 `references` 单独传递，有参考图时切换到编辑接口；旧版 `context` 中的 data URL 也会兼容提取。
- 覆盖：sufficient
- last-updated: 2026-08-27
