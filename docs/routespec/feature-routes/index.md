# 功能路由图 · 索引

## 项目概览

- 应用类型：AI Agent 桌面应用（Electron + Fastify，AG-UI 协议 + CopilotKit），pnpm monorepo
- 主入口：
  - 服务端：`apps/agent-server/src/index.ts`（启动 Fastify，默认 127.0.0.1:3900）
  - 桌面端：`apps/desktop/src/main/index.ts`
- 核心目录：`apps/agent-server/src/core/`、`apps/agent-server/src/plugins/`、`apps/desktop/src/renderer/src/`
- 测试入口：根目录 `pnpm test`；服务端 `apps/agent-server/src/__tests__/`（vitest）；插件测试在各插件 `__tests__/`；桌面端 `apps/desktop/src/test/`

## 模块索引

| 模块 | 路由文件 | 内容 |
| --- | --- | --- |
| agent-server 骨架与 Agent 运行时 | [agent-server-runtime.md](agent-server-runtime.md) | createApp 组装、Pi Agent 会话运行时 |
| 插件系统 | [plugin-system.md](plugin-system.md) | 宿主插件机制、生命周期、capability 门禁 |
| REST/SSE API 路由层 | [api-routes.md](api-routes.md) | `/api/*` 各业务路由文件 |
| novel 业务插件 | [novel-plugin.md](novel-plugin.md) | 小说创作全链路（编排、章节、群聊演绎、账本等） |
| 桌面宿主 | [desktop-app.md](desktop-app.md) | Electron 主进程、嵌入 server、renderer |
| workspace 共享包 | [packages.md](packages.md) | shared / protocol / config |
| infinite-canvas 插件 | [api-routes.md](api-routes.md) | 画布项目、媒体配置、图片生成与编辑 |

---

last-updated: 2026-08-28（novel-plugin 补入群聊共创演绎链路条目）
覆盖状态：partial —— 仅记录首次扫描确认的定位信息，各条目待后续任务触碰时回填。
