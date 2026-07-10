# Phase 1：插件重构（后端）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将小说系统从 Fastify 静态注册插件重构为 PluginManager 动态插件，扩展 PluginContext 接口支持数据库迁移、Session 工具注入、Fastify 服务装饰、提示词模板目录注册，并补全 Store CRUD 和新增创建类工具。

**架构：** 扩展现有 PluginContext 新增 4 种能力（registerMigration/registerSessionTools/registerService/registerPromptTemplates），调整 PluginManager 初始化时序使其在 database 之后、session factory 之前执行，将 novel 模块从 `core/novel/` + `plugins/novel.plugin.ts` + `routes/novel.route.ts` 三处迁移为 `plugins/novel-plugin/` 独立目录。

**技术栈：** TypeScript、Fastify、better-sqlite3、TypeBox、Zod、Pi SDK（@earendil-works/pi-coding-agent）

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `apps/agent-server/src/plugins/novel-plugin/index.ts` | Plugin 入口，实现 Plugin 接口 |
| `apps/agent-server/src/plugins/novel-plugin/manifest.json` | 插件清单 |
| `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts` | 数据库迁移定义 |
| `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` | REST API 路由定义（从 novel.route.ts 迁移） |
| `apps/agent-server/src/plugins/novel-plugin/novel-services.ts` | 服务初始化（从 novel.plugin.ts 迁移） |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `apps/agent-server/src/core/plugin/plugin-types.ts` | 新增 MigrationDefinition 类型 + PluginContext 扩展 4 方法 + PluginEntry 扩展字段 |
| `apps/agent-server/src/core/plugin/plugin-manager.ts` | 实现新能力收集 + 初始化时序调整 + getAllSessionTools/getAllMigrations 方法 |
| `apps/agent-server/src/plugins/plugin-loader.plugin.ts` | 传入 novel 插件为内置插件 + 执行迁移 + 装饰 Fastify + 注入 session tools |
| `apps/agent-server/src/app.ts` | 移除 novelPlugin/novelRoute 静态注册 + 移除 novelTools 注入 |
| `apps/agent-server/src/core/agent/pi-session.ts` | 移除 novelTools 依赖 + 改为从 pluginManager 获取 |
| `apps/agent-server/src/types/fastify.d.ts` | 移除 novel 相关类型声明（改为插件动态注册） |
| `apps/agent-server/src/core/novel/novel-store.ts` | 补全 CRUD 方法 |
| `apps/agent-server/src/core/novel/novel-tools.ts` | 新增创建类工具 |

### 移动文件（内容不变，路径变更）

| 原路径 | 新路径 |
|--------|--------|
| `apps/agent-server/src/core/novel/*.ts` | `apps/agent-server/src/plugins/novel-plugin/core/*.ts` |
| `apps/agent-server/src/core/novel/prompts/*.md` | `apps/agent-server/src/plugins/novel-plugin/prompts/*.md` |

### 删除文件

| 文件 | 原因 |
|------|------|
| `apps/agent-server/src/plugins/novel.plugin.ts` | 被 novel-plugin/index.ts 取代 |
| `apps/agent-server/src/routes/novel.route.ts` | 被 novel-plugin/novel-routes.ts 取代 |

---

## 任务 1：扩展 PluginContext 类型定义

**文件：**
- 修改：`apps/agent-server/src/core/plugin/plugin-types.ts`

- [ ] **步骤 1：在 plugin-types.ts 中新增 MigrationDefinition 类型**

在 `PluginManifest` 接口之前添加：

```typescript
/** 数据库迁移定义：插件可注册的数据库表创建/变更 */
export interface MigrationDefinition {
  /** 迁移 ID（全局唯一，建议用数字前缀，如 '013_create_novel_projects'） */
  id: string
  /** SQL 语句（必须幂等，使用 IF NOT EXISTS） */
  sql: string
}
```

- [ ] **步骤 2：扩展 PluginContext 接口**

在 `PluginContext` 接口中，在 `registerPanel` 之后添加 4 个新方法：

```typescript
export interface PluginContext {
  /** 当前插件名 */
  readonly pluginName: string
  /** 模块级日志器（已绑定 pluginName） */
  readonly logger: FastifyBaseLogger
  /** 注册工具 */
  registerTool(tool: ToolDefinition): void
  /** 注册 HTTP 路由（路径自动加 /api/plugins/:pluginName 前缀） */
  registerRoute(route: RouteDefinition): void
  /** 监听事件 */
  onEvent(type: string, handler: EventHandler): void
  /** 注册 UI 面板 */
  registerPanel(panel: PanelDefinition): void
  /** 注册数据库迁移（在 database 插件之后、session factory 之前执行） */
  registerMigration(migration: MigrationDefinition): void
  /** 注入 Pi Session customTools（每次创建 session 时注入） */
  registerSessionTools(tools: ToolDefinition[]): void
  /** 装饰 Fastify 实例（挂载服务供路由和其他插件使用） */
  registerService(name: string, service: unknown): void
  /** 注册提示词模板目录（三级覆盖中的默认文件目录） */
  registerPromptTemplates(dir: string): void
}
```

- [ ] **步骤 3：扩展 PluginEntry 接口**

在 `PluginEntry` 接口中添加新字段：

```typescript
export interface PluginEntry {
  manifest: PluginManifest
  plugin: Plugin
  status: PluginStatus
  error?: string
  source: 'builtin' | 'local' | 'npm'
  filePath?: string
  tools: ToolDefinition[]
  routes: RouteDefinition[]
  panels: PanelDefinition[]
  eventHandlers: Array<{ type: string; handler: EventHandler }>
  /** 已注册的数据库迁移 */
  migrations: MigrationDefinition[]
  /** 已注册的 Session 工具（注入到 Pi Session customTools） */
  sessionTools: ToolDefinition[]
  /** 已注册的 Fastify 服务 */
  services: Array<{ name: string; service: unknown }>
  /** 已注册的提示词模板目录 */
  promptTemplateDirs: string[]
}
```

- [ ] **步骤 4：扩展 PluginListItem 接口**

在 `PluginListItem` 中添加：

```typescript
export interface PluginListItem {
  name: string
  version: string
  description?: string
  author?: string
  status: PluginStatus
  source: 'builtin' | 'local' | 'npm'
  error?: string
  toolCount: number
  routeCount: number
  panelCount: number
  eventHandlerCount: number
  migrationCount: number
  sessionToolCount: number
  serviceCount: number
}
```

- [ ] **步骤 5：验证类型编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：可能有 plugin-manager.ts 的类型错误（因为 PluginEntry 新增了必填字段），这是预期的，将在任务 2 修复。

- [ ] **步骤 6：Commit**

```bash
git add apps/agent-server/src/core/plugin/plugin-types.ts
git commit -m "refactor(plugin): 扩展 PluginContext 新增 4 种能力（迁移/Session工具/服务/模板目录）"
```

---

## 任务 2：实现 PluginManager 新能力

**文件：**
- 修改：`apps/agent-server/src/core/plugin/plugin-manager.ts`

- [ ] **步骤 1：在 PluginManager 中添加新能力的收集存储**

在 `PluginManager` 类的私有字段中添加：

```typescript
private readonly entries = new Map<string, PluginEntry>()
private readonly logger: FastifyBaseLogger
private readonly eventBus: EventBus
private readonly options: PluginManagerOptions
private initialized = false
```

在 `loadPluginEntry` 方法中，初始化 PluginEntry 时添加新字段：

```typescript
private async loadPluginEntry(plugin: Plugin, source: 'builtin' | 'local' | 'npm', filePath?: string): Promise<void> {
  const name = plugin.manifest.name
  if (this.entries.has(name)) {
    this.logger.warn({ name, source }, '插件已存在，跳过重复加载')
    return
  }

  const entry: PluginEntry = {
    manifest: plugin.manifest,
    plugin,
    status: 'loaded',
    source,
    filePath,
    tools: [],
    routes: [],
    panels: [],
    eventHandlers: [],
    migrations: [],
    sessionTools: [],
    services: [],
    promptTemplateDirs: [],
  }

  this.entries.set(name, entry)
  this.logger.info({ name, version: plugin.manifest.version, source }, '插件已加载')
}
```

- [ ] **步骤 2：在 createPluginContext 中实现新方法**

找到 `createPluginContext` 方法（或等效的创建上下文逻辑），添加 4 个新方法的实现：

```typescript
private createPluginContext(entry: PluginEntry): PluginContext {
  const logger = this.logger.child({ plugin: entry.manifest.name })

  return {
    pluginName: entry.manifest.name,
    logger,

    registerTool: (tool) => {
      entry.tools.push(tool)
      logger.debug({ toolName: tool.name }, '已注册工具')
    },

    registerRoute: (route) => {
      entry.routes.push(route)
      logger.debug({ method: route.method, path: route.path }, '已注册路由')
    },

    onEvent: (type, handler) => {
      this.eventBus.on(type, handler)
      entry.eventHandlers.push({ type, handler })
      logger.debug({ eventType: type }, '已注册事件监听')
    },

    registerPanel: (panel) => {
      entry.panels.push(panel)
      logger.debug({ panelId: panel.id }, '已注册面板')
    },

    registerMigration: (migration) => {
      entry.migrations.push(migration)
      logger.debug({ migrationId: migration.id }, '已注册数据库迁移')
    },

    registerSessionTools: (tools) => {
      entry.sessionTools.push(...tools)
      logger.debug({ count: tools.length }, '已注册 Session 工具')
    },

    registerService: (name, service) => {
      entry.services.push({ name, service })
      logger.debug({ serviceName: name }, '已注册 Fastify 服务')
    },

    registerPromptTemplates: (dir) => {
      entry.promptTemplateDirs.push(dir)
      logger.debug({ dir }, '已注册提示词模板目录')
    },
  }
}
```

- [ ] **步骤 3：添加 getAllMigrations 方法**

在 `PluginManager` 类中添加：

```typescript
/** 获取所有已启用插件的数据库迁移（按 id 排序） */
getAllMigrations(): MigrationDefinition[] {
  const all: MigrationDefinition[] = []
  for (const entry of this.entries.values()) {
    if (entry.status === 'enabled') {
      all.push(...entry.migrations)
    }
  }
  return all.sort((a, b) => a.id.localeCompare(b.id))
}
```

- [ ] **步骤 4：添加 getAllSessionTools 方法**

```typescript
/** 获取所有已启用插件注入的 Pi Session 工具 */
getAllSessionTools(): ToolDefinition[] {
  const all: ToolDefinition[] = []
  for (const entry of this.entries.values()) {
    if (entry.status === 'enabled') {
      all.push(...entry.sessionTools)
    }
  }
  return all
}
```

- [ ] **步骤 5：添加 getAllServices 方法**

```typescript
/** 获取所有已启用插件注册的 Fastify 服务 */
getAllServices(): Array<{ pluginName: string; name: string; service: unknown }> {
  const all: Array<{ pluginName: string; name: string; service: unknown }> = []
  for (const entry of this.entries.values()) {
    if (entry.status === 'enabled') {
      for (const { name, service } of entry.services) {
        all.push({ pluginName: entry.manifest.name, name, service })
      }
    }
  }
  return all
}
```

- [ ] **步骤 6：添加 getAllPromptTemplateDirs 方法**

```typescript
/** 获取所有已启用插件注册的提示词模板目录 */
getAllPromptTemplateDirs(): string[] {
  const all: string[] = []
  for (const entry of this.entries.values()) {
    if (entry.status === 'enabled') {
      all.push(...entry.promptTemplateDirs)
    }
  }
  return all
}
```

- [ ] **步骤 7：更新 list 方法返回新字段**

在 `list()` 方法中，为每个返回项添加新字段：

```typescript
list(): PluginListItem[] {
  return Array.from(this.entries.values()).map((entry) => ({
    name: entry.manifest.name,
    version: entry.manifest.version,
    description: entry.manifest.description,
    author: entry.manifest.author,
    status: entry.status,
    source: entry.source,
    error: entry.error,
    toolCount: entry.tools.length,
    routeCount: entry.routes.length,
    panelCount: entry.panels.length,
    eventHandlerCount: entry.eventHandlers.length,
    migrationCount: entry.migrations.length,
    sessionToolCount: entry.sessionTools.length,
    serviceCount: entry.services.length,
  }))
}
```

- [ ] **步骤 8：更新 stopPlugin 方法清理新资源**

在 `stopPlugin` 方法中，在清理 eventHandlers 之后，添加新资源的清理：

```typescript
// 清理新资源
entry.migrations = []
entry.sessionTools = []
entry.services = []
entry.promptTemplateDirs = []
```

- [ ] **步骤 9：验证类型编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS（plugin-types.ts 和 plugin-manager.ts 类型一致）

- [ ] **步骤 10：Commit**

```bash
git add apps/agent-server/src/core/plugin/plugin-manager.ts
git commit -m "feat(plugin): PluginManager 实现迁移/Session工具/服务/模板目录收集"
```

---

## 任务 3：调整 plugin-loader.plugin.ts 集成新能力

**文件：**
- 修改：`apps/agent-server/src/plugins/plugin-loader.plugin.ts`

- [ ] **步骤 1：导入 novel 插件和迁移执行依赖**

在文件顶部添加导入：

```typescript
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { createModuleLogger } from '../lib/logger.js'
import { PluginManager } from '../core/plugin/plugin-manager.js'
import { createHelloPlugin } from './examples/hello-plugin/index.js'
import { createNovelPlugin } from './novel-plugin/index.js'
```

- [ ] **步骤 2：将 novel 插件加入内置插件列表**

在 `pluginLoaderPlugin` 函数中，修改 `builtinPlugins`：

```typescript
const builtinPlugins = [
  ...(enableExamples ? [{ plugin: createHelloPlugin() }] : []),
  { plugin: createNovelPlugin() },
]
```

- [ ] **步骤 3：在 start() 之后执行迁移**

在 `await manager.start()` 之后，添加迁移执行逻辑：

```typescript
await manager.start()

// 执行插件注册的数据库迁移
const migrations = manager.getAllMigrations()
if (migrations.length > 0) {
  log.info({ count: migrations.length }, '开始执行插件数据库迁移')
  for (const migration of migrations) {
    // 检查是否已执行
    const applied = app.db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migration.id)
    if (applied) {
      log.debug({ id: migration.id }, '迁移已应用，跳过')
      continue
    }
    try {
      app.db.exec(migration.sql)
      app.db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id)
      log.info({ id: migration.id }, '迁移已执行')
    } catch (err) {
      log.error({ id: migration.id, err }, '迁移执行失败')
    }
  }
}
```

- [ ] **步骤 4：装饰 Fastify 实例**

在迁移执行之后，添加服务装饰：

```typescript
// 装饰 Fastify 实例（插件注册的服务）
const services = manager.getAllServices()
for (const { pluginName, name, service } of services) {
  try {
    app.decorate(name, service)
    log.info({ pluginName, serviceName: name }, '已装饰 Fastify 服务')
  } catch (err) {
    log.error({ pluginName, serviceName: name, err }, '装饰 Fastify 服务失败')
  }
}
```

- [ ] **步骤 5：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：可能有错误，因为 `createNovelPlugin` 尚未创建，将在任务 4 创建。

- [ ] **步骤 6：Commit**

```bash
git add apps/agent-server/src/plugins/plugin-loader.plugin.ts
git commit -m "feat(plugin): plugin-loader 集成迁移执行和服务装饰"
```

---

## 任务 4：创建 novel-plugin 目录和入口

**文件：**
- 创建：`apps/agent-server/src/plugins/novel-plugin/index.ts`
- 创建：`apps/agent-server/src/plugins/novel-plugin/manifest.json`
- 创建：`apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`
- 创建：`apps/agent-server/src/plugins/novel-plugin/novel-services.ts`
- 创建：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`

- [ ] **步骤 1：创建 manifest.json**

```json
{
  "name": "novel",
  "version": "1.0.0",
  "description": "AI 小说创作工作台",
  "builtin": true
}
```

- [ ] **步骤 2：创建 novel-migrations.ts**

从 `apps/agent-server/src/core/db/migrations.ts` 中提取迁移 ID 为 `013_*` 到 `026_*` 的所有迁移，组装为 `MigrationDefinition[]` 数组：

```typescript
import type { MigrationDefinition } from '../../core/plugin/plugin-types.js'

export const novelMigrations: MigrationDefinition[] = [
  {
    id: '013_create_novel_projects',
    sql: `CREATE TABLE IF NOT EXISTS novel_projects (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      genre           TEXT NOT NULL,
      synopsis        TEXT NOT NULL DEFAULT '',
      target_words    INTEGER NOT NULL DEFAULT 0,
      current_volume  INTEGER NOT NULL DEFAULT 1,
      current_chapter INTEGER NOT NULL DEFAULT 0,
      current_stage   TEXT NOT NULL DEFAULT 'setup',
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );`,
  },
  {
    id: '014_create_novel_chapters',
    sql: `CREATE TABLE IF NOT EXISTS novel_chapters (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL,
      volume           INTEGER NOT NULL,
      chapter_number   INTEGER NOT NULL,
      title            TEXT NOT NULL,
      content          TEXT NOT NULL DEFAULT '',
      word_count       INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'draft',
      narrative_task   TEXT NOT NULL DEFAULT '',
      acceptance_result TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_chapters_project_chapter ON novel_chapters(project_id, chapter_number);`,
  },
  // ... 015-026 的迁移，从现有 migrations.ts 中复制
]
```

注意：需要从 `apps/agent-server/src/core/db/migrations.ts` 中找到所有 `013_*` 到 `026_*` 的迁移，将它们的 `id` 和 `sql` 复制到这个数组中。

- [ ] **步骤 3：创建 novel-services.ts**

从 `novel.plugin.ts` 迁移服务初始化逻辑：

```typescript
import { NovelStore } from '../../core/novel/novel-store.js'
import { PromptManager } from '../../core/novel/prompt-manager.js'
import { NovelPromptBuilder } from '../../core/novel/prompt-builder.js'
import { NovelSessionFactory } from '../../core/novel/novel-session.js'
import { NovelEngine } from '../../core/novel/novel-engine.js'
import { createNovelTools } from '../../core/novel/novel-tools.js'
import type Database from 'better-sqlite3'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

export interface NovelServices {
  store: NovelStore
  promptManager: PromptManager
  promptBuilder: NovelPromptBuilder
  sessionFactory: NovelSessionFactory
  engine: NovelEngine
  tools: ToolDefinition[]
}

/** 初始化小说系统所有服务（在插件 setup 中调用） */
export function createNovelServices(db: Database.Database, cwd: string): NovelServices {
  const store = new NovelStore(db)
  const promptManager = new PromptManager(db, cwd)
  const promptBuilder = new NovelPromptBuilder(promptManager, store)
  const sessionFactory = new NovelSessionFactory(store, promptManager)
  const engine = new NovelEngine(store, sessionFactory)
  const tools = createNovelTools(store)

  return { store, promptManager, promptBuilder, sessionFactory, engine, tools }
}
```

- [ ] **步骤 4：创建 novel-routes.ts**

从 `routes/novel.route.ts` 迁移路由定义，改为返回 `RouteDefinition[]` 数组：

```typescript
import type { RouteDefinition } from '../../core/plugin/plugin-types.js'
import type { NovelServices } from './novel-services.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

/** 创建小说系统 REST API 路由 */
export function createNovelRoutes(services: NovelServices): RouteDefinition[] {
  const { store, promptManager, engine } = services

  const routes: RouteDefinition[] = []

  // 项目管理
  routes.push({
    method: 'POST',
    path: '/projects',
    handler: (req: any, reply: any) => {
      const schema = z.object({
        title: z.string().min(1).max(200),
        genre: z.string().min(1).max(50),
        synopsis: z.string().max(5000).default(''),
        targetWords: z.number().int().min(0).default(0),
      })
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
      }
      const project = store.createProject({
        id: randomUUID(),
        ...parsed.data,
        currentVolume: 1,
        currentChapter: 0,
        currentStage: 'setup',
        status: 'active',
      })
      return { ok: true, data: project, meta: { traceId: req.traceId, timestamp: Date.now() } }
    },
  })

  routes.push({
    method: 'GET',
    path: '/projects',
    handler: (req: any) => {
      return { ok: true, data: store.listProjects(), meta: { traceId: req.traceId, timestamp: Date.now() } }
    },
  })

  // ... 其余路由从 novel.route.ts 迁移，path 去掉 /api/novel 前缀（因为插件路由自动加 /api/plugins/novel 前缀）

  return routes
}
```

注意：需要从 `novel.route.ts` 中迁移所有路由，将路径从 `/api/novel/xxx` 改为 `/xxx`（插件路由自动加 `/api/plugins/novel` 前缀）。

- [ ] **步骤 5：创建 index.ts（Plugin 入口）**

```typescript
import { join } from 'node:path'
import type { Plugin, PluginContext } from '../../core/plugin/plugin-types.js'
import { novelMigrations } from './novel-migrations.js'
import { createNovelServices } from './novel-services.js'
import { createNovelRoutes } from './novel-routes.js'

export function createNovelPlugin(): Plugin {
  return {
    manifest: {
      name: 'novel',
      version: '1.0.0',
      description: 'AI 小说创作工作台',
      builtin: true,
    },

    async setup(context: PluginContext) {
      // 1. 注册数据库迁移
      context.registerMigration(novelMigrations[0])
      // 注意：如果迁移有多个，需要逐个注册或修改 registerMigration 支持数组
      // 这里改为循环注册
      for (const migration of novelMigrations) {
        context.registerMigration(migration)
      }

      // 2. 初始化服务（需要 app.db，通过 context 获取）
      // 注意：PluginContext 当前没有直接暴露 app.db
      // 需要通过 registerService 装饰后，路由通过 app.xxx 访问
      // 但服务初始化需要 db，所以需要扩展 PluginContext 或通过其他方式获取
      // 解决方案：在 plugin-loader.plugin.ts 中先执行迁移，再调用 setup
      // setup 中通过 context 获取 db

      // ⚠️ 需要扩展 PluginContext 添加 getDb() 方法或类似机制
      // 暂时通过 registerService 的方式，在 plugin-loader 中先装饰 db
      // 但这违反了插件隔离原则

      // 实际方案：在 PluginContext 中添加 readonly app: FastifyInstance
      // 或更安全的方式：添加 getDb(): Database.Database 方法

      // 为简化实现，在 context 中添加 db 引用
      const db = (context as any).db as Database.Database
      const cwd = (context as any).cwd as string

      const services = createNovelServices(db, cwd)

      // 3. 装饰 Fastify 实例
      context.registerService('novelStore', services.store)
      context.registerService('promptManager', services.promptManager)
      context.registerService('novelPromptBuilder', services.promptBuilder)
      context.registerService('novelSessionFactory', services.sessionFactory)
      context.registerService('novelEngine', services.engine)

      // 4. 注册 Pi Session 工具
      context.registerSessionTools(services.tools)

      // 5. 注册提示词模板目录
      context.registerPromptTemplates(join(__dirname, 'prompts'))

      // 6. 注册 REST API 路由
      const routes = createNovelRoutes(services)
      for (const route of routes) {
        context.registerRoute(route)
      }

      // 7. 注册前端面板
      context.registerPanel({
        id: 'novel-canvas',
        title: '小说工作台',
        component: 'NovelCanvas',
        position: 'main',
      })

      context.logger.info('小说创作系统插件已初始化')
    },
  }
}

export default createNovelPlugin
```

注意：这里发现 PluginContext 需要访问 `db` 和 `cwd`。需要在任务 1 的 PluginContext 扩展中添加这些。回到任务 1 补充。

- [ ] **步骤 6：补充 PluginContext 添加 db 和 cwd**

回到 `plugin-types.ts`，在 PluginContext 中添加：

```typescript
export interface PluginContext {
  readonly pluginName: string
  readonly logger: FastifyBaseLogger
  /** SQLite 数据库连接（由 databasePlugin 提供） */
  readonly db: import('better-sqlite3').Database
  /** 当前工作目录 */
  readonly cwd: string
  /** 数据目录 */
  readonly dataDir: string

  registerTool(tool: ToolDefinition): void
  registerRoute(route: RouteDefinition): void
  onEvent(type: string, handler: EventHandler): void
  registerPanel(panel: PanelDefinition): void
  registerMigration(migration: MigrationDefinition): void
  registerSessionTools(tools: ToolDefinition[]): void
  registerService(name: string, service: unknown): void
  registerPromptTemplates(dir: string): void
}
```

- [ ] **步骤 7：更新 plugin-loader.plugin.ts 传递 db/cwd/dataDir**

在 `createPluginContext` 调用处，传入 db/cwd/dataDir。由于 `createPluginContext` 是 PluginManager 的私有方法，需要修改其签名或通过构造函数传入。

修改 PluginManager 构造函数，新增 `db`、`cwd`、`dataDir` 参数：

```typescript
export class PluginManager {
  private readonly entries = new Map<string, PluginEntry>()
  private readonly logger: FastifyBaseLogger
  private readonly eventBus: EventBus
  private readonly options: PluginManagerOptions
  private readonly db: Database.Database
  private readonly cwd: string
  private readonly dataDir: string
  private initialized = false

  constructor(
    logger: FastifyBaseLogger,
    eventBus: EventBus,
    db: Database.Database,
    cwd: string,
    dataDir: string,
    options: PluginManagerOptions = {},
  ) {
    this.logger = logger
    this.eventBus = eventBus
    this.db = db
    this.cwd = cwd
    this.dataDir = dataDir
    this.options = options
  }
}
```

在 `createPluginContext` 中使用：

```typescript
private createPluginContext(entry: PluginEntry): PluginContext {
  const logger = this.logger.child({ plugin: entry.manifest.name })

  return {
    pluginName: entry.manifest.name,
    logger,
    db: this.db,
    cwd: this.cwd,
    dataDir: this.dataDir,

    registerTool: (tool) => { entry.tools.push(tool) },
    registerRoute: (route) => { entry.routes.push(route) },
    onEvent: (type, handler) => {
      this.eventBus.on(type, handler)
      entry.eventHandlers.push({ type, handler })
    },
    registerPanel: (panel) => { entry.panels.push(panel) },
    registerMigration: (migration) => { entry.migrations.push(migration) },
    registerSessionTools: (tools) => { entry.sessionTools.push(...tools) },
    registerService: (name, service) => { entry.services.push({ name, service }) },
    registerPromptTemplates: (dir) => { entry.promptTemplateDirs.push(dir) },
  }
}
```

- [ ] **步骤 8：更新 plugin-loader.plugin.ts 传递 db/cwd/dataDir**

```typescript
const cwd = process.env.PI_CWD ?? process.cwd()
const dataDir = process.env.PI_DATA_DIR ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pi`

const manager = new PluginManager(log, app.eventBus, app.db, cwd, dataDir, {
  localPluginsDir,
  enableNpmPlugins,
  builtinPlugins,
})
```

- [ ] **步骤 9：更新 index.ts 使用 context.db**

```typescript
async setup(context: PluginContext) {
  for (const migration of novelMigrations) {
    context.registerMigration(migration)
  }

  const services = createNovelServices(context.db, context.cwd)
  // ... 其余不变
}
```

- [ ] **步骤 10：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：可能有 app.ts 中的错误（novelPlugin/novelRoute 已移除但 app.ts 仍引用），将在任务 5 修复。

- [ ] **步骤 11：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/
git commit -m "feat(novel): 创建 novel-plugin 目录和 Plugin 入口"
```

---

## 任务 5：从 app.ts 移除 novel 静态注册

**文件：**
- 修改：`apps/agent-server/src/app.ts`
- 修改：`apps/agent-server/src/core/agent/pi-session.ts`
- 修改：`apps/agent-server/src/types/fastify.d.ts`

- [ ] **步骤 1：从 app.ts 移除 novelPlugin 和 novelRoute 导入和注册**

移除以下行：

```typescript
// 移除导入
import { novelPlugin } from './plugins/novel.plugin.js'
import { novelRoute } from './routes/novel.route.js'

// 移除注册（约第 73 行）
await app.register(novelPlugin)

// 移除路由注册（约第 149 行）
await app.register(novelRoute)
```

- [ ] **步骤 2：从 app.ts 移除 novelTools 注入**

在 `sessionStore.setSessionFactory` 中，移除 `novelTools` 行：

```typescript
sessionStore.setSessionFactory(async (threadId) => {
  return createPiSession({
    threadId,
    authStorage: app.authStorage,
    modelRegistry: app.modelRegistry,
    sessionManager: app.sessionManager,
    credentialBridge,
    providerConfigStore: app.providerConfigStore,
    gate,
    confirmationManager,
    eventBus: app.eventBus,
    getApiKey: app.getApiKey,
    factStore: app.factStore,
    subagentManager: app.subagentManager,
    teamManager: app.teamManager,
    // 移除：novelTools: app.novelSessionFactory.getNovelTools(),
    // 改为从 pluginManager 获取
    pluginSessionTools: app.pluginManager?.getAllSessionTools() ?? [],
    db: app.db,
    config: { cwd, dataDir },
  })
})
```

注意：`pluginLoaderPlugin` 在 `sessionStore.setSessionFactory` 之后注册（第 125 行），但 `setSessionFactory` 是闭包，运行时才执行，所以 `app.pluginManager` 在运行时已存在。但需要确保 `pluginLoaderPlugin` 在 `setSessionFactory` 调用之前注册。

查看 app.ts 的注册顺序：
- 第 73 行：`await app.register(novelPlugin)` ← 移除
- 第 88 行：`sessionStore.setSessionFactory(...)` ← 闭包
- 第 125 行：`await app.register(pluginLoaderPlugin)` ← 需要提前到 setSessionFactory 之前

需要将 `pluginLoaderPlugin` 的注册提前到 `sessionStore.setSessionFactory` 之前。

- [ ] **步骤 3：调整 pluginLoaderPlugin 注册顺序**

将 `await app.register(pluginLoaderPlugin)` 从第 125 行移到 `sessionStore.setSessionFactory` 之前（约第 75 行，在 novelPlugin 原来的位置）：

```typescript
// 移除 novelPlugin 后，在 sessionStore.setSessionFactory 之前注册 pluginLoader
await app.register(pluginLoaderPlugin)

// 创建 CredentialBridge、Gate、SessionStore
const credentialBridge = new CredentialBridge()
// ...
sessionStore.setSessionFactory(async (threadId) => {
  return createPiSession({
    // ...
    pluginSessionTools: app.pluginManager?.getAllSessionTools() ?? [],
    // ...
  })
})
```

- [ ] **步骤 4：修改 pi-session.ts 接受 pluginSessionTools**

在 `PiSessionDeps` 接口中，将 `novelTools` 改为 `pluginSessionTools`：

```typescript
export interface PiSessionDeps {
  // ... 其他字段不变

  /** 插件注入的 Session 工具（由 PluginManager.getAllSessionTools() 提供） */
  pluginSessionTools?: ToolDefinition[]

  // 移除：novelTools?: ToolDefinition[]
}
```

在 `createPiSession` 函数中，将 `deps.novelTools` 改为 `deps.pluginSessionTools`：

```typescript
// 5. 构建 customTools
const customTools: ToolDefinition[] = []
if (deps.subagentManager) {
  customTools.push(
    createSubagentTool(deps.subagentManager),
    createSubagentReplyTool(deps.subagentManager),
    createSubagentCloseTool(deps.subagentManager),
  )
}
if (deps.teamManager) {
  customTools.push(createTeamExecuteTool(deps.teamManager))
}
if (deps.pluginSessionTools && deps.pluginSessionTools.length > 0) {
  customTools.push(...deps.pluginSessionTools)
}
```

- [ ] **步骤 5：更新 fastify.d.ts**

移除 novel 相关的类型声明（这些服务现在由插件动态注册，不再静态声明）：

```typescript
// 移除以下导入和声明
// import type { NovelStore } from '../core/novel/novel-store.js'
// import type { PromptManager } from '../core/novel/prompt-manager.js'
// import type { NovelPromptBuilder } from '../core/novel/prompt-builder.js'
// import type { NovelSessionFactory } from '../core/novel/novel-session.js'
// import type { NovelEngine } from '../core/novel/novel-engine.js'

// 在 FastifyInstance 接口中移除：
// novelStore: NovelStore
// promptManager: PromptManager
// novelPromptBuilder: NovelPromptBuilder
// novelSessionFactory: NovelSessionFactory
// novelEngine: NovelEngine
```

注意：这会导致 `novel-routes.ts` 中的 `app.novelStore` 等访问报类型错误。由于路由现在通过 `createNovelRoutes(services)` 闭包捕获 services，不再通过 `app.xxx` 访问，所以不需要类型声明。

- [ ] **步骤 6：删除旧的 novel.plugin.ts 和 novel.route.ts**

```bash
rm apps/agent-server/src/plugins/novel.plugin.ts
rm apps/agent-server/src/routes/novel.route.ts
```

- [ ] **步骤 7：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 8：验证启动**

运行：`cd apps/agent-server && npm run dev`
预期：服务正常启动，日志显示 novel 插件已加载

- [ ] **步骤 9：验证 API 可用**

```bash
curl http://localhost:3900/api/plugins/novel/projects
```
预期：返回 `{ ok: true, data: [] }`

- [ ] **步骤 10：Commit**

```bash
git add apps/agent-server/src/app.ts apps/agent-server/src/core/agent/pi-session.ts apps/agent-server/src/types/fastify.d.ts
git rm apps/agent-server/src/plugins/novel.plugin.ts apps/agent-server/src/routes/novel.route.ts
git commit -m "refactor(novel): 从 app.ts 移除静态注册，改为 PluginManager 动态加载"
```

---

## 任务 6：补全 NovelStore CRUD 方法

**文件：**
- 修改：`apps/agent-server/src/core/novel/novel-store.ts`（或迁移后的 `plugins/novel-plugin/core/novel-store.ts`）

- [ ] **步骤 1：为 characters 添加 update/delete/getById**

```typescript
getCharacterById(id: string): NovelCharacter | null {
  const row = this.db.prepare('SELECT * FROM novel_characters WHERE id = ?').get(id) as CharacterRow | undefined
  return row ? this.mapCharacterRow(row) : null
}

updateCharacter(id: string, updates: Partial<Omit<NovelCharacter, 'id' | 'projectId' | 'createdAt'>>): NovelCharacter | null {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return this.getCharacterById(id)
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_characters SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return this.getCharacterById(id)
}

deleteCharacter(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_characters WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 2：为 relationships 添加 update/delete/getById**

```typescript
getRelationshipById(id: string): NovelRelationship | null {
  const row = this.db.prepare('SELECT * FROM novel_relationships WHERE id = ?').get(id) as RelationshipRow | undefined
  return row ? this.mapRelationshipRow(row) : null
}

updateRelationship(id: string, updates: Partial<Omit<NovelRelationship, 'id' | 'projectId' | 'createdAt'>>): NovelRelationship | null {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return this.getRelationshipById(id)
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_relationships SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return this.getRelationshipById(id)
}

deleteRelationship(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_relationships WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 3：为 foreshadowing 添加 update/delete/getById**

```typescript
getForeshadowById(id: string): NovelForeshadow | null {
  const row = this.db.prepare('SELECT * FROM novel_foreshadowing WHERE id = ?').get(id) as ForeshadowRow | undefined
  return row ? this.mapForeshadowRow(row) : null
}

updateForeshadow(id: string, updates: Partial<Omit<NovelForeshadow, 'id' | 'projectId' | 'createdAt'>>): NovelForeshadow | null {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return this.getForeshadowById(id)
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_foreshadowing SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return this.getForeshadowById(id)
}

deleteForeshadow(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_foreshadowing WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 4：为 clues 添加 update/delete/getById**

```typescript
getClueById(id: string): NovelClue | null {
  const row = this.db.prepare('SELECT * FROM novel_clues WHERE id = ?').get(id) as ClueRow | undefined
  return row ? this.mapClueRow(row) : null
}

updateClue(id: string, updates: Partial<Omit<NovelClue, 'id' | 'projectId' | 'createdAt'>>): NovelClue | null {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return this.getClueById(id)
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_clues SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return this.getClueById(id)
}

deleteClue(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_clues WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 5：为 conflicts 添加 update/delete/getById**

```typescript
getConflictById(id: string): NovelConflict | null {
  const row = this.db.prepare('SELECT * FROM novel_conflicts WHERE id = ?').get(id) as ConflictRow | undefined
  return row ? this.mapConflictRow(row) : null
}

updateConflict(id: string, updates: Partial<Omit<NovelConflict, 'id' | 'projectId' | 'createdAt'>>): NovelConflict | null {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return this.getConflictById(id)
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_conflicts SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return this.getConflictById(id)
}

deleteConflict(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_conflicts WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 6：为 chapters 添加 getById/updateContent**

```typescript
getChapterById(id: string): NovelChapter | null {
  const row = this.db.prepare('SELECT * FROM novel_chapters WHERE id = ?').get(id) as ChapterRow | undefined
  return row ? this.mapChapterRow(row) : null
}

updateChapterContent(id: string, content: string, wordCount: number): NovelChapter | null {
  this.db.prepare('UPDATE novel_chapters SET content = ?, word_count = ?, updated_at = unixepoch() WHERE id = ?').run(content, wordCount, id)
  return this.getChapterById(id)
}
```

- [ ] **步骤 7：为 world_rules 添加 update/delete**

```typescript
updateWorldRule(id: string, updates: Partial<Omit<NovelWorldRule, 'id' | 'projectId' | 'createdAt'>>): void {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_world_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

deleteWorldRule(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_world_rules WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 8：为 constraints 添加 update/delete**

```typescript
updateConstraint(id: string, updates: Partial<Omit<NovelConstraint, 'id' | 'projectId' | 'createdAt'>>): void {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_constraints SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

deleteConstraint(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_constraints WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 9：为 info_layers 添加 update/delete**

```typescript
updateInfoLayer(id: string, updates: Partial<Omit<NovelInformationLayer, 'id' | 'projectId' | 'createdAt'>>): void {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_information_layers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

deleteInfoLayer(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_information_layers WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 10：为 style_guides 添加 update/delete**

```typescript
updateStyleGuide(id: string, updates: Partial<Omit<NovelStyleGuide, 'id' | 'projectId' | 'createdAt'>>): void {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = this.camelToSnake(key)
    fields.push(`${dbKey} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return
  fields.push('updated_at = unixepoch()')
  values.push(id)
  this.db.prepare(`UPDATE novel_style_guides SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

deleteStyleGuide(id: string): boolean {
  const result = this.db.prepare('DELETE FROM novel_style_guides WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **步骤 11：添加 camelToSnake 辅助方法**

在 NovelStore 类中添加：

```typescript
private camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}
```

- [ ] **步骤 12：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 13：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts
git commit -m "feat(novel): 补全 Store CRUD 方法（update/delete/getById）"
```

---

## 任务 7：新增创建类工具（P0）

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts`（迁移后路径）

- [ ] **步骤 1：添加 novel_create_character 工具**

在 `createNovelTools` 函数中，在现有工具之后添加：

```typescript
const CreateCharacterParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  name: Type.String({ description: '角色名' }),
  identity: Type.Optional(Type.String({ description: '身份' })),
  personality: Type.Optional(Type.String({ description: '性格' })),
  appearance: Type.Optional(Type.String({ description: '外貌' })),
  currentState: Type.Optional(Type.String({ description: '当前状态' })),
  currentGoal: Type.Optional(Type.String({ description: '当前目标' })),
  secret: Type.Optional(Type.String({ description: '秘密' })),
  arcStage: Type.Optional(Type.String({ description: '弧光阶段' })),
  speechStyle: Type.Optional(Type.String({ description: '说话风格' })),
})

function createCreateCharacterTool(store: NovelStore): ToolDefinition<typeof CreateCharacterParams> {
  return defineTool({
    name: 'novel_create_character',
    label: '创建角色',
    description: '在小说项目中创建一个新角色，包含静态设定和动态状态。',
    promptSnippet: '当需要引入新角色时使用此工具。',
    parameters: CreateCharacterParams,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<undefined>> {
      const character = store.createCharacter({
        id: randomUUID(),
        projectId: params.projectId,
        name: params.name,
        identity: params.identity ?? '',
        personality: params.personality ?? '',
        appearance: params.appearance ?? '',
        currentState: params.currentState ?? '',
        currentGoal: params.currentGoal ?? '',
        currentPressure: '',
        secret: params.secret ?? '',
        arcStage: params.arcStage ?? 'introduction',
        arcHistory: '[]',
        speechStyle: params.speechStyle ?? '',
      })
      return {
        content: [{ type: 'text', text: `已创建角色「${params.name}」，ID: ${character.id}` }],
        details: undefined,
      }
    },
  })
}
```

- [ ] **步骤 2：添加 novel_create_foreshadow 工具**

```typescript
const CreateForeshadowParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  description: Type.String({ description: '伏笔描述' }),
  category: Type.Optional(Type.String({ description: '分类' })),
  recoverByChapter: Type.Optional(Type.Number({ description: '回收截止章节' })),
})

function createCreateForeshadowTool(store: NovelStore): ToolDefinition<typeof CreateForeshadowParams> {
  return defineTool({
    name: 'novel_create_foreshadow',
    label: '创建伏笔',
    description: '在小说项目中创建一个新伏笔，状态默认为 planned。',
    promptSnippet: '当需要埋下新伏笔时使用此工具。',
    parameters: CreateForeshadowParams,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<undefined>> {
      const foreshadow = store.createForeshadow({
        id: randomUUID(),
        projectId: params.projectId,
        description: params.description,
        category: params.category ?? 'plot',
        status: 'planned',
        firstChapter: null,
        lastChapter: null,
        recoverByChapter: params.recoverByChapter ?? null,
        linkedCharacters: '[]',
        linkedClues: '[]',
      })
      return {
        content: [{ type: 'text', text: `已创建伏笔，ID: ${foreshadow.id}` }],
        details: undefined,
      }
    },
  })
}
```

- [ ] **步骤 3：添加 novel_create_conflict 工具**

```typescript
const CreateConflictParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  description: Type.String({ description: '冲突描述' }),
  type: Type.Optional(Type.String({ description: '冲突类型（inner/relationship/faction/interest/moral/identity/emotional/world_rule/survival）' })),
  intensity: Type.Optional(Type.Number({ description: '强度 0-100', minimum: 0, maximum: 100 })),
  participants: Type.Optional(Type.Array(Type.String(), { description: '参与方' })),
})

function createCreateConflictTool(store: NovelStore): ToolDefinition<typeof CreateConflictParams> {
  return defineTool({
    name: 'novel_create_conflict',
    label: '创建冲突',
    description: '在小说项目中创建一个新冲突。',
    promptSnippet: '当需要引入新冲突时使用此工具。',
    parameters: CreateConflictParams,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<undefined>> {
      const conflict = store.createConflict({
        id: randomUUID(),
        projectId: params.projectId,
        description: params.description,
        type: params.type ?? 'relationship',
        intensity: params.intensity ?? 30,
        stage: 'latent',
        participants: JSON.stringify(params.participants ?? []),
      })
      return {
        content: [{ type: 'text', text: `已创建冲突，ID: ${conflict.id}` }],
        details: undefined,
      }
    },
  })
}
```

- [ ] **步骤 4：添加 novel_create_clue 工具**

```typescript
const CreateClueParams = Type.Object({
  projectId: Type.String({ description: '项目 ID' }),
  description: Type.String({ description: '线索描述' }),
  pointsTo: Type.String({ description: '线索指向的真相' }),
  isMisleading: Type.Optional(Type.Boolean({ description: '是否为误导线索' })),
  linkedForeshadow: Type.Optional(Type.String({ description: '关联伏笔 ID' })),
})

function createCreateClueTool(store: NovelStore): ToolDefinition<typeof CreateClueParams> {
  return defineTool({
    name: 'novel_create_clue',
    label: '创建线索',
    description: '在小说项目中创建一个新线索。',
    promptSnippet: '当需要引入新线索时使用此工具。',
    parameters: CreateClueParams,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<undefined>> {
      const clue = store.createClue({
        id: randomUUID(),
        projectId: params.projectId,
        description: params.description,
        pointsTo: params.pointsTo,
        progress: 0,
        currentStep: '',
        nextStep: '',
        isMisleading: params.isMisleading ?? false,
        linkedForeshadow: params.linkedForeshadow ?? null,
      })
      return {
        content: [{ type: 'text', text: `已创建线索，ID: ${clue.id}` }],
        details: undefined,
      }
    },
  })
}
```

- [ ] **步骤 5：在 createNovelTools 中注册新工具**

```typescript
export function createNovelTools(store: NovelStore): ToolDefinition[] {
  return [
    createQueryStateTool(store),
    createUpdateCharacterTool(store),
    createUpdateForeshadowTool(store),
    createUpdateConflictTool(store),
    createUpdateClueTool(store),
    createUpdateRelationshipTool(store),
    // 新增创建类工具
    createCreateCharacterTool(store),
    createCreateForeshadowTool(store),
    createCreateConflictTool(store),
    createCreateClueTool(store),
  ]
}
```

- [ ] **步骤 6：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts
git commit -m "feat(novel): 新增 4 个创建类工具（character/foreshadow/conflict/clue）"
```

---

## 任务 8：端到端验证

- [ ] **步骤 1：启动服务**

运行：`cd apps/agent-server && npm run dev`
预期：服务正常启动，日志显示：
- `插件已加载: novel v1.0.0 (builtin)`
- `迁移已执行: 013_create_novel_projects` ... `026_create_novel_prompt_templates`
- `已装饰 Fastify 服务: novelStore` 等
- `已注册 Session 工具: 10`

- [ ] **步骤 2：验证 API 端点**

```bash
# 创建项目
curl -X POST http://localhost:3900/api/plugins/novel/projects \
  -H "Content-Type: application/json" \
  -d '{"title":"测试小说","genre":"奇幻","synopsis":"测试"}'

# 列出项目
curl http://localhost:3900/api/plugins/novel/projects

# 创建角色
curl -X POST http://localhost:3900/api/plugins/novel/projects/{projectId}/characters \
  -H "Content-Type: application/json" \
  -d '{"name":"主角","identity":"剑士"}'
```
预期：所有 API 返回 `{ ok: true, data: ... }`

- [ ] **步骤 3：验证工具注入**

```bash
# 获取工具列表（通过 AG-UI 端点）
curl http://localhost:3900/ag-ui/agent/default/tools
```
预期：工具列表包含 `novel_query_state`、`novel_create_character` 等 10 个 novel 工具

- [ ] **步骤 4：验证现有功能不受影响**

```bash
# 健康检查
curl http://localhost:3900/health

# 插件列表
curl http://localhost:3900/api/plugins
```
预期：健康检查正常，插件列表包含 novel 插件

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "test(novel): 端到端验证通过"
```

---

## 自检

### 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| 扩展 PluginContext（4 种新能力） | 任务 1 |
| 修改 PluginManager 初始化时序 | 任务 2 + 任务 3 |
| 将 novel 模块迁移为 novel-plugin | 任务 4 |
| 从 app.ts 移除 novel 静态注册 | 任务 5 |
| 补全 Store CRUD | 任务 6 |
| 新增创建类工具（4 个 P0） | 任务 7 |
| 验证现有 API + 工具调用正常 | 任务 8 |

### 占位符扫描

- 任务 4 步骤 2 的迁移 SQL 需要从现有 `migrations.ts` 中复制完整内容，不能留 `// ...` 占位
- 任务 4 步骤 4 的路由迁移需要从现有 `novel.route.ts` 中迁移所有路由，不能留 `// ...` 占位

### 类型一致性

- `MigrationDefinition` 在任务 1 定义，在任务 2/3/4 使用，名称一致
- `NovelServices` 在任务 4 定义，在 `novel-routes.ts` 和 `index.ts` 使用，名称一致
- `pluginSessionTools` 在任务 5 的 `pi-session.ts` 和 `app.ts` 中使用，名称一致
- `createNovelPlugin` 在任务 4 定义，在任务 3 的 `plugin-loader.plugin.ts` 中导入，名称一致
