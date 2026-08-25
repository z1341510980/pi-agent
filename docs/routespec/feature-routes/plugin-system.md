# 插件系统

### 宿主插件机制（PluginManager / plugin-loader）

- 描述：插件发现、catalog、enable/disable/reload 生命周期、capability 门禁、effect ledger 与启动期 Fastify route 挂载。运行期 enable 的 route/service 如实报 `effectiveAfterRestart` / `restartRequired`。
- 入口：`GET /api/plugins` 等 API（由 plugin-loader 提供，见 api-routes.md）
- 核心：
  - `apps/agent-server/src/plugins/plugin-loader.plugin.ts`（启动期挂载插件 route + 提供 plugins 管理 API；旧 `routes/plugins.route.ts` 已删除）
  - `apps/agent-server/src/core/plugin/`（PluginManager 及契约）
- 测试：
  - `apps/agent-server/src/__tests__/plugin-manager.test.ts`
  - `apps/agent-server/src/__tests__/plugin-host-mount.test.ts`（route 启动期/运行期挂载语义，7 个用例）
  - `apps/agent-server/src/__tests__/plugin-catalog*.test.ts`、`plugin-integrity*.test.ts`、`plugin-api-contract.test.ts`
- 备注：设计文档见 `docs/plugin-development-guide.md` 与 `docs/novel-pluginization-plan.md`；内置插件文件位于 `apps/agent-server/src/plugins/*.plugin.ts`（database、event-bus、memory-store、usage-ledger、subagent、team、cron、pi-sdk 等）。
- 覆盖：partial
- last-updated: 2026-08-25
