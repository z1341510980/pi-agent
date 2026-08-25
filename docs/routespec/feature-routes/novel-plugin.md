# novel 业务插件

> 插件路径：`apps/agent-server/src/plugins/novel-plugin/`，API 前缀 `/api/plugins/novel`。

### 插件入口与服务组装

- 描述：插件 setup 7 步流程：服务初始化 → Fastify decoration（store/promptManager/promptBuilder/sessionFactory/engine/orchestrator）→ 注册 4 个 Novel Agent → 注册 Team → Session 工具 → REST 路由 → 前端面板。
- 入口：`apps/agent-server/src/plugins/novel-plugin/index.ts`（createNovelPlugin）、`manifest.json`
- 核心：
  - `novel-services.ts`（createNovelServices 服务依赖图）
  - `core/novel-store.ts`（跨域 Store facade 与事务收口）
  - `core/novel-engine.ts` / `core/novel-orchestrator.ts`（创作状态机与多 Agent 编排）
  - `novel-migrations.ts`（唯一 schema 迁移来源）
- 测试：`apps/agent-server/src/plugins/novel-plugin/__tests__/`
- 备注：**详细架构与数据流见同目录 `ARCHITECTURE.md`**（含数据模型、提示词三层缓存、17 个工具、编排流程图、API 清单），改 novel 功能先读它。
- 覆盖：partial
- last-updated: 2026-08-25

### 章节创作流程（SSE）

- 描述：三条触发路径——`create-flow`（手动编排矩阵）、`ai-arrange`（AI 编排后确认再创作）、`create-team`（同步兼容入口）；Director → Writer → 质量门 → 盲审/Reviewer → 检查点 → Reviser/Memory。
- 入口：HTTP `POST /api/plugins/novel/projects/:projectId/chapters/:chapterNumber/create-flow` 等
- 核心：`routes/creation-flow-routes.ts`（SSE 与检查点决策）、`core/novel-orchestrator.ts`（createChapterWithFlow）
- 测试：`apps/agent-server/src/plugins/novel-plugin/__tests__/creation-flow-routes.test.ts`
- 备注：检查点决策经 `POST .../checkpoint/:type/decision` + EventEmitter 传递；群聊演绎链路诊断见 `docs/novel/2026-08-24-群聊演绎链路诊断与修复方案.md`。
- 覆盖：partial
- last-updated: 2026-08-25

### REST 子路由（按域拆分）

- 描述：项目/回收站、卷、章节、角色、剧情轨道、画布图谱、记忆事件、提示词模板、实体维护、缓存诊断、观测等。
- 入口：`novel-routes.ts`（聚合器，前缀 `/api/plugins/novel`）
- 核心：`routes/` 子目录（project-routes、volume-routes、chapter-routes、character-routes、narrative-routes、graph-routes、memory-routes、prompt-routes、entity-delete-routes、entity-maintenance-routes、cache-routes、observability-routes）
- 覆盖：partial
- last-updated: 2026-08-25

### 领域子模块（core/ 分域）

- 描述：stores（实体 CRUD/版本链/事务）、chapters（章节聊天/版本/场景计划）、prompting（三层缓存 PromptManager/Builder）、memory（长期记忆/账本）、entities（准入/编排/相似度）、quality（文风质量/陈词检测）、analysis（矩阵投影/一致性）、discussion（群聊）、generation（角色/实体生成）。
- 核心：`apps/agent-server/src/plugins/novel-plugin/core/`
- 备注：各分域细节以 `ARCHITECTURE.md` 为准，本次未逐一展开。
- 覆盖：partial
- last-updated: 2026-08-25
