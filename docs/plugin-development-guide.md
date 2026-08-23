# pi-agent 插件开发指南

> 面向插件作者。所有 API 签名以 `apps/agent-server/src/core/plugin/plugin-types.ts` 为准；
> 加载与授权行为以 `plugin-manager.ts` / `plugin-catalog.ts` / `plugins/plugin-loader.plugin.ts` 为准。
> 配置文件示例见 `config/plugins.yml`；最小完整示例见 `apps/agent-server/src/plugins/examples/hello-plugin/index.ts`。

***

## 1. 心智模型

写插件前先建立四个概念，它们贯穿全文：

| 概念                 | 是什么                                                                                          | 由谁决定                                |
| ------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| **身份**             | `catalogId`（plugins.yml 里的 `id`，安装记录主键）与 `pluginId`（manifest 的 `name`，运行时身份）。两者可以不同，API 同时返回 | 你声明 manifest；宿主在 YAML 里登记 catalogId |
| **来源**             | `builtin` / `local` / `npm` 三种。决定代码何时被 import、disabled 的语义、默认权限                              | plugins.yml 的 `source`              |
| **能力（capability）** | 插件能做什么。manifest 的 `permissions` 只是**请求**，实际能力完全来自 YAML 的 `grants` 列表                         | 用户授权                                |
| **生命周期边界**         | 哪些注册物 disable 后立即消失，哪些要重启才消失。插件代码不加载两次：任何代码/集合变更都必须重启                                        | 宿主固定，见 §10                          |

两条铁律：

1. **不做热加载**。插件代码、插件集合、route、service、tool 集的任何变更都要求重启服务。运行期 enable/disable 只改变"后续聚合读取能不能看到它"。
2. **运行状态不说谎**。setup 失败、effect 回滚失败、route 未挂载，都会如实出现在 status / inspect / diagnostics 里。你的插件也应该这样：失败就抛错，不要静默降级。

***

## 2. 最小可用插件

一个插件就是一个实现了 `Plugin` 接口的对象，通常由工厂函数导出。

### 2.1 类型从哪来

`agent-server` **不是发布包**，外部插件无法 `import` 它的内部模块。三种取型方式：

| 场景                         | 做法                                                                 |
| -------------------------- | ------------------------------------------------------------------ |
| 仓库内插件（builtin / 仓库内 local） | `import type { Plugin } from '<相对路径>/core/plugin/plugin-types.js'` |
| 外部 local / npm 插件          | **自己声明最小结构类型**（下面示例），或干脆不标类型                                       |
| 想要完整类型                     | 把 `plugin-types.ts` 的相关 interface 复制一份到你的项目，作为契约副本自行维护             |

同理，`hello-plugin` 里的 `import { success } from '../../../lib/api-response.js'` 只对仓库内文件成立。外部插件的路由**直接返回普通对象即可**——`success()` 只是给响应包一层 `{ ok, data, meta: { traceId, timestamp } }`，不是宿主要求的格式。

### 2.2 自包含的最小插件

这份代码不依赖宿主任何模块，可直接作为外部 local 插件使用：

```ts
// my-plugin/index.js（或 .ts 自行编译）

/**
 * 最小契约副本：只声明用得到的部分。
 * 宿主的完整定义见 agent-server 的 core/plugin/plugin-types.ts。
 */
export default {
  manifest: {
    name: 'my-plugin',       // pluginId：kebab-case，全局唯一
    version: '1.0.0',
    description: '做什么的一句话说明',
    permissions: ['tools.register']   // 仅声明"请求"，不构成授权
  },

  async setup(context) {
    context.logger.info('my-plugin 启动')

    context.registerTool({
      name: 'my.hello',
      description: '向 LLM 解释清楚这个工具什么时候该用',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '问候对象' }
        },
        required: ['target']
      },
      async execute(args, ctx) {
        // 尊重取消信号
        if (ctx.signal?.aborted) return { ok: false, error: 'aborted' }
        return { ok: true, data: `你好，${String(args.target ?? 'world')}` }
      }
    })
  },

  async teardown() {
    // 只重置内存态；不要在这里删数据
  }
}
```

接入见 §5——**三种交付形态的步骤不同**，请按对应清单操作，不要凭直觉。

> ⚠️ **`.ts`** **入口只在开发模式可用。** `pnpm dev` 走 tsx（能 import `.ts`），但生产入口是 `node dist/index.js`，只能 import 编译后的 ESM `.js`。外部插件请发布 `.js`。

***

## 3. 插件结构

```ts
interface Plugin {
  readonly manifest: PluginManifest
  readonly migrations?: MigrationDefinition[]   // 可选：静态迁移，setup 之前执行
  setup(context: PluginContext): void | Promise<void>
  teardown?(): void | Promise<void>
}
```

### 3.1 manifest

| 字段                       | 必填 | 说明                                                                         |
| ------------------------ | -- | -------------------------------------------------------------------------- |
| `name`                   | ✅  | pluginId。依赖声明里引用的就是它                                                       |
| `version`                | ✅  | 语义化版本。npm 锁定时与 package.json 精确比对                                           |
| `description` / `author` | —  | 展示用                                                                        |
| `main`                   | —  | 入口相对路径（local/npm 场景由 resolvePluginEntry 解析，优先级 main > index.js > index.ts） |
| `dependencies`           | —  | 依赖的其他插件的 `name` 数组，参与拓扑排序（§12.2）                                           |
| `permissions`            | —  | 能力**请求**清单。注意：这只影响 UI 展示"请求了什么"，不构成任何授权                                    |
| `builtin`                | —  | 标记位，仅供展示                                                                   |

### 3.2 setup(context)

宿主按依赖顺序调用，成功后 entry 变为 `enabled`。setup 里做的事：

- 调用各种 `register*()` 登记能力；
- 用 `context.effect()` / `registerDisposable()` 登记 setup 造成的旁路副作用（§8.9）。

**setup 抛错 = 插件失败**。宿主会反向回收本次 activation 已登记的全部 effect，entry 标为 `error` 并保留错误信息——不会留下半可用的插件，也不会累积幽灵 handler。

### 3.3 teardown()

**三种时机都会执行**：运行期 disable、reload（stop 阶段）、以及**服务正常关闭**（Fastify `onClose` → `PluginManager.stop()`）。也就是说它不只是"用户点了停用"，正常退出也会走一遍。

注意三点：

1. teardown 不等于完整回收。EventBus handler、你通过受控 API 注册的工具/面板会被宿主清理；但 Fastify route 和 decoration 在进程内不可撤销，只能等重启（§10）。
2. 不要在 teardown 里删除可能含用户数据的持久化资源（数据库表、磁盘数据）。迁移和数据是 `persistent`，卸载需走显式备份流程。**因为正常关机也会调用它**——在这里删数据等于每次重启都清一次。
3. 推荐模式：状态封装在工厂闭包里（参考 hello-plugin 的 `greetCount`），teardown 只重置闭包状态。

### 3.4 migrations（可选）

```ts
migrations: [
  {
    id: '001_create_my_table',           // 全局唯一，建议数字前缀
    sql: 'CREATE TABLE IF NOT EXISTS my_table (...)'
    // beforeApply?/afterApply?: 同事务内的兼容准备/回填钩子
  }
]
```

静态迁移在 setup **之前**执行，保证 setup 时表已存在。运行期动态迁移用 `context.registerMigration()`，它在 start 之后执行。SQL 必须幂等（`IF NOT EXISTS`）。

***

## 4. 三种来源与加载语义

| <br />               | builtin                                   | local                                                                   | npm                 |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------------------- | ------------------- |
| 代码位置                 | 随应用编译                                     | `sourceRef` 指向入口文件                                                      | node\_modules 包目录   |
| import 时机            | 应用构建                                      | 服务启动期（enabled 时）                                                        | 服务启动期（enabled 时）    |
| `enabled: false` 的含义 | 仍实例化并进入 catalog（可见、可运行期 enable），只是不 setup | **不 import 模块**，只出现在 `/api/plugins/catalog`；enable 返回 `pending-restart` | 同 local             |
| 默认能力                 | 全部 12 项                                   | 零（看 grants）                                                             | 零（看 grants）         |
| 完整性锁定                | 不适用（`not-applicable`）                     | 可选；无锁标 `unverified`                                                     | 可选；无锁标 `unverified` |
| 额外注册步骤               | **必须登记进工厂映射表**（§5.1）                      | 无                                                                       | 需先自行 npm install    |

**目录扫描路径**（不走 plugins.yml 的旁路）：设置环境变量 `PI_PLUGINS_DIR`（扫本地目录）或 `PI_PLUGINS_ENABLE_NPM`（扫 node\_modules 中 `wenlang-agent-plugin-*` 前缀的包）也会发现插件。这些插件同样受完整性判定约束：catalog 里有锁则校验，失败拒绝加载；无锁则以 `unverified` 状态加载并告警。生产环境建议只用 plugins.yml 这一条路。

***

## 5. 三种交付形态：完整步骤

三种来源的接入步骤**实质不同**，按对应清单操作。

### 5.1 builtin（随应用编译）

需要改**两处**，且键名有硬约束：

**第 1 步**：在 `apps/agent-server/src/plugins/plugin-loader.plugin.ts` 顶部 import 你的工厂。

**第 2 步**：加入 `pluginFactories` 映射表（约 line 59）。**这个键必须等于 plugins.yml 里的** **`id`（catalogId），不是 manifest.name**：

```ts
const pluginFactories: Record<string, () => Plugin> = {
  'hello-plugin': createHelloPlugin,
  'novel-plugin': createNovelPlugin,
  'web-search-plugin': createWebSearchPlugin,
  'my-plugin': createMyPlugin        // ← catalogId
}
```

**第 3 步**（可选）：如果希望在**没有 plugins.yml** 时也默认加载，再加入 `defaultBuiltinPlugins`（约 line 66）。这是兜底列表，与上面那张表用途不同。

**第 4 步**：plugins.yml 加条目，`id` 必须与映射表键一致：

```yaml
  - id: my-plugin        # 必须命中 pluginFactories
    source: builtin
    enabled: true
```

**第 5 步**：重启。

> 只做第 3 步不做第 2 步：一旦 plugins.yml 存在，加载走的是 YAML 驱动路径，找不到工厂就记 `未找到内置插件工厂，跳过` 然后静默跳过。这是最容易踩的坑。

### 5.2 仓库内 local（开发调试最快）

```yaml
  - id: my-plugin
    source: local
    sourceRef: "./plugins-dev/my-plugin/index.ts"   # 相对 PI_CWD 解析
    enabled: true
```

- `sourceRef` 相对路径的基准是 **`PI_CWD ?? process.cwd()`**，不是 config 目录、不是插件自身位置。不确定就写绝对路径。
- 仓库内文件可以 `import type { Plugin } from '../../src/core/plugin/plugin-types.js'`。
- `.ts` 入口仅 `pnpm dev` 可用。
- 重启生效。

### 5.3 外部 local / npm（发布形态）

**第 1 步**：项目结构。入口必须是 ESM `.js`：

```
my-plugin/
  package.json     { "name": "...", "version": "1.0.0", "type": "module", "main": "index.js" }
  index.js         export default { manifest, setup, teardown }
```

npm 形态的包必须**先自行安装**到宿主的 `node_modules`（`PI_CWD/node_modules`），宿主不会替你下载。

**第 2 步**：生成锁定信息：

```bash
pnpm --filter agent-server exec tsx --tsconfig tsconfig.tsx.json scripts/seal-plugin.ts <包目录>
```

**第 3 步**：plugins.yml 加条目：

```yaml
  # local
  - id: my-plugin
    source: local
    sourceRef: "/abs/path/my-plugin/index.js"
    enabled: true
    resolvedVersion: "1.0.0"
    integrity: "sha256-..."
    grants: [tools.register]

  # npm（sourceRef 是包名，不是路径）
  - id: vendor-plugin
    source: npm
    sourceRef: "@vendor/agent-plugin"
    enabled: true
    resolvedVersion: "2.1.0"
    integrity: "sha256-..."
    grants: [tools.register, network.outbound]
```

npm 包名约束：`^(@scope/)?[A-Za-z0-9._-]+$`，且解析结果必须落在 `node_modules` 内。**`wenlang-agent-plugin-`** **前缀只约束目录扫描发现（`PI_PLUGINS_ENABLE_NPM`），YAML 显式声明不需要前缀。**

**第 4 步**：重启并核对：

```bash
curl localhost:<port>/api/plugins/my-plugin | jq '.data.status, .data.integrityStatus, .data.grants'
```

期望 `enabled` / `verified` / 你授予的能力。若插件没出现，先看启动日志——所有拒绝原因都会记 warn/error。

***

## 6. plugins.yml 配置参考

> ⚠️ **这个文件会被程序整体重写。** 任何 enable / disable / grants / config 的 API 操作都会触发 `persistCatalog()`：整个文件被重新生成，头部替换为 `# Generated plugin catalog state. Changes require restart.`，`config` 压成单行 JSON，`grants` 变成 inline 数组，**你手写的注释与格式全部丢失**。锁定字段（`resolvedVersion` / `integrity`）会被保留。
> 需要长期维护的说明写在别处，或接受它被覆盖。

```yaml
plugins:
  - id: my-plugin                # catalogId，安装记录主键，可与 manifest.name 不同
    source: local                # builtin | local | npm
    sourceRef: "./plugins/my-plugin/index.js"   # local=路径（相对 PI_CWD）；npm=包名
    enabled: true                # 期望状态，与实际状态分开
    isolate: false               # 仅记录意图，当前无隔离效果（P3 才实现）
    resolvedVersion: "1.0.0"     # 可选锁定：与包 version 精确比对
    integrity: "sha256-..."      # 可选锁定：SRI 格式，仅 sha256
    grants:                      # 实际授予的能力（全量替换语义）
      - tools.register
      - session.create
    config:                      # 透传给 context.config
      dataDir: ./data/my-plugin
      apiKey: ${MY_API_KEY}      # 整值环境变量引用
```

字段细则：

- **id**：必填。改 id 等于换了一个安装记录。builtin 还必须命中工厂映射表（§5.1）。
- **config**：任意 JSON。`${NAME}` 引用规则见 §12.1。
- **grants**：写错 capability 名的后果是**整条插件条目被丢弃**（只有启动日志说明原因），不是"忽略这一项"。见 §7.2。
- **grants / integrity / enabled 的变更**都经管理 API 写回本文件，重启后期望状态保留。
- **integrity 校验失败**（文件被篡改、版本不符、格式非法）：拒绝加载、不降级，但 catalog 条目仍可见——用户需要知道"装了个过不了校验的东西"。

生成锁定信息：

```bash
pnpm --filter agent-server exec tsx --tsconfig tsconfig.tsx.json scripts/seal-plugin.ts <插件包目录>
# 输出 resolvedVersion 与 integrity，直接粘贴到对应条目下。
# 摘要覆盖包内除 node_modules/.git 外全部文件；改动代码或装依赖后必须重新 seal。
```

### 环境变量速查

| 变量                           | 作用                                                                    |
| ---------------------------- | --------------------------------------------------------------------- |
| `PI_CWD`                     | 工作目录基准。local `sourceRef` 相对路径、npm 的 `node_modules` 都以它为准              |
| `PI_DATA_DIR`                | 数据根目录。插件 dataDir = `<PI_DATA_DIR>/plugins/<pluginId>`；未设置时回退到 `~/.pi` |
| `PI_CONFIG_DIR`              | 配置根目录，默认 `<PI_CWD>/config`。plugins.yml 从这里读写                          |
| `PI_PLUGINS_DIR`             | 启用本地目录扫描（plugins.yml 之外的旁路）                                           |
| `PI_PLUGINS_ENABLE_NPM`      | `true`/`1` 启用 node\_modules 扫描，只认 `wenlang-agent-plugin-` 前缀          |
| `PI_PLUGINS_ENABLE_EXAMPLES` | `false`/`0` 关闭示例插件（hello）。默认开启                                        |
| `PI_PLUGINS_HOT_RELOAD`      | `true`/`1` 启用 local/npm 插件热更新：文件变更后自动重载。默认关闭                          |

### 热更新（PI_PLUGINS_HOT_RELOAD）

启用后，local/npm 插件包目录内的文件变更会自动触发重载，语义与
`POST /api/plugins/:pluginId/reload` 一致，并遵循同一套安全契约：

- **候选先行**：先把磁盘上的新模块完整导入并校验出 Plugin 实例，成功后才卸载旧实例。
  编辑出语法错误、导出缺失或工厂抛错时只记录告警，旧插件继续运行 —— 热更新不会把
  活着的插件打成不可用状态。
- **setup 失败的边界**：候选先行只保护"导入/校验"阶段；新代码 setup 抛错时旧实例已
  卸载，插件进入 error 态。修复文件后再次存盘会自动重试（期望状态为启用时，重载会
  重新执行 setup）。
- **完整性锁复验**：plugins.yml 里带 `resolvedVersion`/`integrity` 锁的插件在重载前
  重新校验；磁盘代码一旦变更摘要必然不匹配，此时拒绝重载并提示重新 seal。热更新不能
  绕过封存校验。
- **生效范围**：工具 / Session 工具 / 事件监听即时生效；路由与 Fastify 服务装饰只在启动期
  挂载，重载后的新路由要等重启（inspect 的 `effectiveAfterRestart` 如实上报）。
- **去抖与串行**：编辑器一次保存的多次写入合并为一次重载（默认 500ms）；上一次重载未结束
  时再次变更会顺延重试，不会并发进入。
- **关闭排空**：进程 onClose 先关闭 watcher 并等待在途重载结算，再停止插件系统。

注意：开发模式 `pnpm dev` 使用 tsx watch，src 下任何变更都会重启整个进程；
热更新主要服务于生产运行时（`node dist/index.js`）和 PI_PLUGINS_DIR 外置插件的迭代。


***

## 7. Capability 与授权

### 7.1 全部 12 项 capability

| capability             | 解锁什么                                                   | 门禁点               | 风险级别                |
| ---------------------- | ------------------------------------------------------ | ----------------- | ------------------- |
| `tools.register`       | `registerTool()`、`registerSessionTools()`              | 抛错                | 中：工具进入模型可用集         |
| `routes.register`      | `registerRoute()`                                      | 抛错                | 中：新增 HTTP 面         |
| `agent.hooks`          | `onEvent()`                                            | 抛错                | 低                   |
| `ui.contribute`        | `registerPanel()`                                      | 抛错                | 低                   |
| `storage.plugin`       | `context.db`、`registerMigration()`、`registerService()` | 抛错 / getter 抛错    | **高**：直接读写宿主 SQLite |
| `process.exec`         | `context.process.exec()`                               | 无则字段为 undefined   | **高**：子进程执行         |
| `network.outbound`     | `context.network.fetch()`                              | 无则字段为 undefined   | **高**：外联            |
| `session.create`       | `createSession()`、`createAgUiSession()`                | 抛错                | **高**：消耗模型额度        |
| `agent.orchestrate`    | `subagentManager` / `teamManager` / `agentCallLogger`  | 无则三个字段为 undefined | 高：操作 Agent 编排层      |
| `confirmation.request` | `confirmationManager`                                  | 无则字段为 undefined   | 低                   |
| `provider.transform`   | Provider 请求/响应改写通道                                     | —                 | **高**               |
| `provider.observe`     | Provider 只读观察                                          | —                 | 低                   |

### 7.2 规则

- **builtin 默认持有全部能力**；**local/npm 默认零能力**，哪怕 manifest 写满 permissions。
- 授权入口：`PUT /api/plugins/:pluginId/grants`，body `{ grants: string[] }`，**全量替换**。未知 capability 返回 400 `INVALID_CAPABILITY`。变更写回 plugins.yml 并标记 `restartRequired`——grants 在下次 activation 生效。
- 桌面端插件管理页的授权弹窗读取的是真实 grants，每个能力带一句风险说明。
- 门禁失败抛出的错误包含插件名 + capability + 资源名，会随 setup 失败进入 entry.error；setup 之后的延迟访问（如路由 handler 里读 `ctx.db`）则以调用方异常形式暴露。

> ⚠️ **在 plugins.yml 里写错 capability 名，整条插件条目会被丢弃。**
> catalog 解析遇到未知 capability 时记一条 error 诊断然后 `return`——该插件根本不进 catalog，
> 表现为"插件凭空消失"而不是"这一项授权被忽略"。启动日志里有
> `未知 capability: xxx`，但 API 和 UI 都看不到它。改配置前对照 §7.1 表核名字。
> 走 grants API 则安全得多：返回 400 且明确列出非法项。

***

## 8. PluginContext API 参考

### 8.1 基础字段（无需 capability）

| 字段                         | 说明                                                                          |
| -------------------------- | --------------------------------------------------------------------------- |
| `pluginName`               | manifest.name                                                               |
| `config`                   | plugins.yml 该条目的 `config` 对象（已做环境变量解析）                                      |
| `logger`                   | 已绑定 pluginName 的 pino logger，用 `logger.info({k:v}, 'msg')` 风格               |
| `cwd`                      | builtin 为宿主 cwd；local/npm 为插件 dataDir                                       |
| `dataDir`                  | `<PI_DATA_DIR>/plugins/<pluginId>`，你的文件应写在这里                                |
| `resolvePath(...segments)` | 把相对路径解析到 dataDir 内并返回绝对路径；越界抛错。**约定辅助而非沙箱**——强制文件边界需要 P3 的进程隔离。写文件的统一入口应该是它 |
| `modelRegistry`            | getter。按 provider+modelId 查询模型元信息（如 baseUrl），与路由判定同源                        |

### 8.2 存储：db / registerMigration —— `storage.plugin`

授权后 `context.db` 是原始 better-sqlite3 连接（**目前不是**受限 facade，这是已知未闭环项，见 §14）。用它建自己的表，配合迁移：

- 静态迁移放 `Plugin.migrations`（setup 前）；运行期迁移用 `context.registerMigration({ id, sql })`。
- 表是 `persistent` 的：disable 不回滚 schema，删数据要走显式产品流程。

### 8.3 工具：registerTool —— `tools.register`

```ts
registerTool({
  name: 'my.search',              // 建议插件名前缀，避免撞名
  description: '给 LLM 看的用途说明，写清楚何时该用',
  parameters: { /* JSON Schema */ },
  async execute(args, ctx) {
    // ctx: { threadId?, runId?, signal? } —— 尊重 ctx.signal，及时中止
    return { ok: true, data: ... }   // 或 { ok: false, error: '...' }
  }
})
```

新注册的会话工具对**新建 session** 生效；已存在的 session 持有旧工具集，这是 `new-session-only` 边界。

`registerSessionTools(tools)` 注入 Pi SDK 原生 ToolDefinition（五参数签名），同样需要 `tools.register`。区别：session tools 只进入插件创建的 Pi 会话上下文，不进入主聊天工具集。

### 8.4 路由：registerRoute —— `routes.register`

```ts
registerRoute({
  method: 'GET',                  // GET | POST | PUT | DELETE | PATCH
  path: '/status',                // 实际路径 /api/plugins/<pluginName>/status
  bodyLimit: 1024 * 1024,         // 可选，单路由请求体上限
  async handler(request, reply) {
    // request / reply 是 Fastify 原生对象，但类型为 any —— 自行校验入参
    // 返回任意可序列化对象即可；宿主不强制响应格式
    return { ok: true, data: { status: 'running' } }
  }
})
```

> 仓库内插件可以用 `import { success } from '../lib/api-response.js'` 统一包装成
> `{ ok, data, meta: { traceId, timestamp } }`。外部插件拿不到这个 helper，
> 直接返回普通对象就行，不是宿主要求。

**关键限制**：Fastify 不支持运行期注销路由。宿主只在**启动期**挂载 route——运行期 enable 的插件即使 setup 成功，它的 route 也打不到，inspect/list 如实报告 `effectiveAfterRestart: true`。disable 后旧 route 仍然存活到重启。不要在文档或 UI 里宣称"停用即刻生效"。

### 8.5 服务：registerService —— `storage.plugin`

```ts
registerService('myStore', storeInstance)   // (name: string, service: unknown)
```

同 route：只在启动期 `app.decorate` 挂到 Fastify。其他插件可在 setup 里从 Fastify 实例取到（仅限启动期加载者）。运行期 enable 的 service 要重启才真正挂上。

另有 `registerPromptTemplates(dir)`（无需 capability）登记提示词模板目录，参与三级覆盖中的默认层。

### 8.6 事件：onEvent —— `agent.hooks`

```ts
onEvent('agent:run:started', (data) => { ... })
```

这是唯一做到完全可逆清理的注册物：disable 时宿主逐个 `off()`。适合观察类逻辑；不要在这里做安全决策（Hook 协议见 §13）。

### 8.7 UI：registerPanel —— `ui.contribute`

这是 UI 贡献的**服务端声明入口**。完整落地还需要桌面端配合，全流程（字段语义、渲染点明细、白名单接入三步、撤销与错误隔离）见 **§9 插件 UI 开发**——写任何 UI 贡献前先读那一章。

```ts
registerPanel({
  id: 'my-panel',                 // 全局唯一，建议插件名前缀
  title: '我的面板',               // → label：tab 标签等位置的显示名
  component: 'MyPanel',           // 仅旧协议描述性字段，不会被执行
  rendererKey: 'builtin.my-panel',// 关键：必须命中桌面白名单
  slot: 'app.navigation',
  scope: 'app',
  priority: 100,
  entryKey: undefined,            // keyed slot（workspace.main/tool.detail）必填
  props: { initialXyz: 0 }
})
```

> 🚩 **P2 阶段第三方插件无法自带 UI。**
> rendererKey 必须命中桌面构建产物里的白名单（`slot-context.tsx` 的 `RENDERERS`），
> 登记新组件只有宿主维护者能做且要重新构建 Electron 应用。
> 外部插件的 `registerPanel` 只进 catalog 投影，界面上不出现也不报错——未命中白名单就是静默跳过。
> 动态 bundle / 远程组件属 P3。



### 8.8 受控 IO —— `process.exec` / `network.outbound`

```ts
await context.process.exec('node script.js arg')   // 仅当授予 process.exec
const res = await context.network.fetch('https://...')  // 仅当授予 network.outbound
```

两者都是受限 facade，不是裸 API：

- `process.exec`：无 shell（argv 解析）、30s 超时、stdout 上限 256KB、cwd 锁定在插件 dataDir。命令形状不符合白名单正则直接抛错。**参数里传路径也要小心**——只有可执行名做形状校验，参数不做路径约束。
- `network.fetch`：仅 HTTP(S)，30s 超时自动 abort。

未授予时这两个字段是 `undefined`（可选注入），而不是拿到再抛错——可以用 `'process' in context` 探测。

### 8.9 Effect ledger：effect / registerDisposable / trackSession

宿主要求所有可回收副作用显式登记，否则 disable 时无法回收：

```ts
// 方式一：effect() 把"注册动作 + disposer"一起登记
context.effect('my.watcher', { resourceId: 'watch-1', unloadScope: 'immediate' }, () => {
  const watcher = fs.watch(dir)
  return () => watcher.close()   // 幂等 disposer
})

// 方式二：已经创建好的外部资源
context.registerDisposable(disposeFn, { resourceId: 'conn-1' })

// 方式三：插件创建的 Session（推荐每次 createSession 都登记）
context.trackSession(handle)   // disable 时自动 handle.abort() + handle.dispose()
```

`unloadScope` 四个值，如实选择：

| 值                  | 含义                | 典型例子                                        |
| ------------------ | ----------------- | ------------------------------------------- |
| `immediate`        | disable 即消失       | EventBus handler、内存 watcher、tracked session |
| `new-session-only` | 新建会话才生效，旧会话残留到其消亡 | registerTool/registerSessionTools           |
| `restart-required` | 进程内不可撤销，需重启       | route、service decoration                    |
| `persistent`       | 不随插件生命周期回滚        | 数据库 schema 与数据                              |

setup 失败时，宿主按登记逆序 dispose 本次 activation 的全部 effect；dispose 抛错的 effect 记为 `residual`/`failed` 并进入 lastStop 结果，不会假装干净。

### 8.10 创建 Session —— `session.create`

插件内跑 LLM 的标准方式。两种工厂：

**`createSession(options)`** —— 裸 Pi Session，自己编排：

```ts
const handle = await context.createSession({
  systemPrompt: '...',
  userMessage: '第一章发生了什么？',
  prefixUserMessage: ['共享背景'],   // string | string[]；每条独立打 prompt-cache 断点
  promptCacheScope: 'novel:p1:c3',   // 让同前缀的一组调用命中同一份服务端缓存
  modelId: { provider: 'deepseek', modelId: 'deepseek-chat', thinkingLevel: null },
  temperature: 0.7,
  maxTokens: 8000,
  timeoutMs: 300_000,                // 默认 120s；长文本写作建议 300s+
  responseFormat: 'json',            // 强制 JSON 输出（不移除工具定义）
  tools: [],                         // [] 显式禁用工具；undefined 用默认；数组为白名单
  skill: { name: 'review', path: '/abs/path/SKILL.md' },  // 显式授权的单个 Skill
  extraSkills: [...],                // 与主 skill 确定性组合
  skillRead: { roots: ['/abs/dir'] },// 受限只读 skill_read 工具
  signal: controller.signal,
  trace: { sessionId, runId },       // 可观测性归属
  onPayloadStats: (stats) => {...}   // 每次 provider 往返的真实 payload 计量
})
const text = await handle.prompt()          // 完整 assistant 文本
// handle.promptStream(onDelta)             // 流式
// handle.subscribe(handler)                // 订阅原始事件流，返回 unsubscribe
// handle.abort() / handle.dispose()
```

**`createAgUiSession(options & { emit, emitRaw? })`** —— 封装 StreamEmitter + ReasoningPipeline + 事件订阅，适合要把过程实时推给前端 AG-UI 流的场景。额外提供 `onFirstText` 回调（首 token 通知）。返回 `{ session, streamEmitter, messageId, sessionId, dispose }`。

纪律：

1. **每次创建都要么** **`trackSession(handle)`** **要么自己** **`finally { handle.dispose() }`**。未登记的活动句柄会让 disable 无法中止 in-flight run。
2. threadId 形如 `plugin:<pluginName>:<uuid>`，与用户聊天线程天然隔离，不会污染主对话历史。
3. Session 创建即消耗模型额度——这就是它需要独立 capability 的原因。

### 8.11 编排与确认 —— `agent.orchestrate` / `confirmation.request`

```ts
// agent.orchestrate（三者同一条 grant）
context.subagentManager?.registerAgent(config)   // Agent 注册/注销
context.teamManager?.registerTeam(...)            // 内存 Team
context.agentCallLogger?.record({...})            // Agent 调用日志

// confirmation.request
const answer = await context.confirmationManager?.requestConfirmation({...})
```

未授予时它们是 `undefined`——用可选链访问。注意注销 Agent/Team 时**只删自己本次注册的 id**，不要碰同名用户持久化实体；Team 的 `deleteTeam()` 可能写存储，插件不要调它。

***

## 9. 插件 UI 开发（服务端声明 + 桌面白名单）

UI 贡献横跨两个进程侧：**服务端**只声明"在哪个位置放什么 key"，**桌面端**把 key 解析成本地编译的 React 组件并渲染。这一章是写 UI 贡献的完整操作手册；API 入口本身见 §8.7。

### 9.1 数据流与角色分工

```text
插件 setup()                     服务端                          桌面端
─────────────                  ──────────────                 ─────────────
registerPanel({rendererKey, ──▶ entry.uiContributions ──▶ GET /api/plugins/ui-contributions
 slot, priority, props, title})        │                         │
                                       │                  RENDERERS[key] 白名单解析
                                       │                  ├ 命中 → 注册进 PluginUiRegistry
                                       │                  └ 未命中/非 active → 静默跳过
                                       │                         │
                                       ▼                         ▼
                          inspect / ui-contributions 投影   SlotRenderer 渲染点（§9.4）
```

| 工作 | 插件作者 | 宿主维护者 |
| --- | --- | --- |
| 声明 contribution（slot/priority/props/title） | ✅ | |
| 实现 renderer 组件 + 登记白名单 | | ✅（改桌面代码、重新构建） |
| 新增渲染点（slot 没有宿主消费位时） | | ✅ |

### 9.2 服务端声明的字段语义

`registerPanel` 的参数映射到 `PluginUiContribution`，规则如下：

| 字段 | 映射规则 |
| --- | --- |
| `id` | → `contributionId`。同一 slot 内区分席位的身份 |
| `title` | → `label`。tab 标签等人类可读位置使用；不下发则界面只能显示技术 id |
| `slot` | 显式指定优先。缺省按 `position` 推导：`sidebar→app.navigation`、`main→workspace.main`、其余→`right-panel.tab` |
| `scope` | 缺省：`workspace.main` / `right-panel.tab` → `page`，其他 → `app`。当前仅作投影字段，桌面端不据此过滤 |
| `priority` | 缺省 0。同席位遮蔽规则见 §9.5 |
| `rendererKey` | **不设则回退用 `component` 字符串充当**——那几乎必然不在白名单里。始终显式传 rendererKey |
| `entryKey` | keyed slot 的席位键。`workspace.main` 必填（=contributionId 时可不填）；`chat.tool.detail` 语义是工具名 |
| `props` | 初始属性。必须 JSON 可序列化（走 HTTP 下发） |

服务端计算的 `state`：

- `active`：rendererKey 非空 **且** slot 在 allowedSlots（六个声明位）内；
- `invalid`：以上任一不满足——比如 slot 拼错。
- 只有 `active` 的贡献会被桌面注册；`disabled` / `restart-required` / `invalid` 一律跳过。

> ⚠️ `allowedSlots` 里还有 `tool.detail` 和 `trace.detail` 两个旧名。桌面端目前只接了 `tool.detail`；`trace.detail` 会标 active 但没有渲染点——别用它。

### 9.3 桌面端三步接入（宿主维护者操作）

**第 1 步：实现组件**。加到 `apps/desktop/src/renderer/src/components/slot/trusted-renderers.tsx`：

```tsx
/** 签名约定：接收一个 props 包，返回 React 元素 */
export function MyPluginView(props: Record<string, unknown>): ReactElement {
  const title = typeof props.title === 'string' ? props.title : '默认标题'
  return <div>{title}</div>
}
```

props 是三层合并的结果：`contribution.props`（服务端声明）→ `inject()`（本插件未用时为空）→ **渲染点 extraProps**（最后注入，如 threadId/message）。对未知类型做防御式取值，不要假设一定存在。

**第 2 步：登记白名单**。在 `core/slot-context.tsx` 的 `RENDERERS` 加一行：

```ts
const RENDERERS = {
  'builtin.hello-panel': HelloPanelContribution,
  'my-plugin.view': MyPluginView   // ← key 与服务端 rendererKey 完全一致
}
```

命名建议 `<来源>.<名称>`；builtin 前缀保留给随应用构建的示例/内置贡献。

**第 3 步**：重新构建桌面应用。P2 不执行任何远程组件，所以这一步不可省略。

### 9.4 渲染点明细

| slot | kind | 渲染位置 | extraProps 注入 | 行为要点 |
| --- | --- | --- | --- | --- |
| `app.navigation` | list | App 左侧导航 rail | `onNavigate(view)`、`currentView` | 导航项应调用 `onNavigate('plugin:<你的contributionId>')` 打开自己的工作区页；用 `currentView` 高亮自身 |
| `workspace.main` | keyed | 主工作区整页 | — | 视图标识即 `plugin:<contributionId>`；席位键=contributionId。key 无对应席位时显示"该插件页面已不可用"兜底文案。宿主固定页（home/chat/settings/novel/plugins）不受插件影响 |
| `right-panel.tab` | list | 聊天右栏 tab 栏 | `threadId`、`activeTabId` | `label`（来自 title）作为 tab 文案；宿主「上下文」永远第一位且不可移除；选中项消失（禁用/换代）自动回落宿主 tab；文件预览仍是临时覆盖层 |
| `chat.header.actions` | list | 聊天标题栏动作区 | `threadId` | 宿主按钮之前 |
| `chat.composer.left` | list | 输入框工具栏左侧（附件按钮后） | `threadId` | 单行/多行模式都注入 |
| `chat.composer.right` | list | 输入框工具栏右侧（模型选择前） | `threadId` | 同上 |
| `chat.composer.dock` | list | 输入框上方停靠区 | `threadId` | 待发队列面板同层 |
| `chat.message.actions` | list | 消息悬停动作条 | `message` | 即使宿主三个动作都不可用容器也渲染，插件动作不会因宿主动作缺失而消失 |
| `chat.tool.detail` | keyed（键=工具名） | 工具卡展开体顶部 | `toolCall` | 只有展开且存在匹配 key 的席位才占空间 |
| `plugin-page.top` | list | 插件管理页顶部 | — | |

### 9.5 priority 与席位规则

- **数值小者先渲染**，并在 single/keyed/list 的同一席位上遮蔽数值大者；
- 同一席位上 **priority 相同的两个注册直接抛冲突错误**——但冲突只影响这一个贡献（被 catch 后跳过），不影响其他贡献或宿主页面；
- list slot 用 `options.id`（=contributionId）区分席位；keyed slot 用 `options.key`。

### 9.6 运行期撤销与错误隔离

- 插件 disable/reload/grants 变更后，插件管理页触发重新拉取 ui-contributions 并做增量 diff：身份是 `pluginId::activationGeneration::contributionId`，消失即撤销、generation 变化即"撤旧注新"、指纹未变则原样保留；
- 重新拉取失败（网络抖动）**保留**既有贡献，不让界面塌掉；
- 单个贡献渲染抛错由 per-entry ErrorBoundary 捕获：只把自己标记 ledger `failed` 并让出位置，页面其余部分照常工作；错误可在 `/inspect` 的 effects 里看到 `renderError`。

### 9.7 已知限制（如实）

1. 第三方插件不能自带 UI（重复 §8.7 的红字）：新增可见贡献必须由宿主维护者改三处代码。
2. `label` 目前只有右栏 tab 消费；其他位置不显示名称。
3. `trace.detail` 声明合法但没有渲染点（§9.2）。
4. `props` 必须 JSON 可序列化；函数、Date、循环引用都会在下发时丢失或报错。
5. 没有"插件卸载动画/过渡"；撤销是同步从投影里移除。

### 9.8 测试指引

| 层 | 测试文件 | 学什么 |
| --- | --- | --- |
| registry 纯逻辑 | `apps/desktop/src/renderer/src/ui/plugin-ui-registry.test.ts` | 四种 slot、遮蔽、children 树、ledger |
| 服务端清单 → 注册 | `apps/desktop/src/renderer/src/core/slot-context.test.tsx` | 白名单跳过、增量 diff、label 下发、服务端不可用降级 |
| 渲染点行为 | `apps/desktop/src/renderer/src/core/slot-render-points.test.tsx` | entryKey/entryId 过滤、chain select、无 Provider 降级 |
| API 形状 | `apps/agent-server/src/__tests__/plugin-api-contract.test.ts` | ui-contributions 契约（label/entryKey 可选、component 不下发） |

---

## 10. 生命周期与重启边界速查

| 事件                                                    | 发生什么                                               | 你会看到                                      |
| ----------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| 启动期 setup                                             | route/service 正常挂载                                 | `effectiveAfterRestart: false`            |
| 运行期 `POST /enable`（已在 catalog 且 disabled 的 local/npm） | 不 import 代码，只翻转期望状态并写回 YAML                        | `200 { status: 'pending-restart' }`       |
| 运行期 enable（builtin 或已 import 但未启用）                    | 正常 setup，但 route/service 打不到                       | `effectiveAfterRestart: true`，inspect 有诊断 |
| disable                                               | teardown + effect 逆序回收；route/service/decoration 残留 | `restartRequired: true`（有残留时）             |
| reload（local/npm）                                     | stop → 重新 import → setup；旧 route 仍在，新 route 打不到    | inspect 显示双重真相诊断                          |
| reload（builtin）                                       | **预检直接拒绝**（在 stop/delete 之前），entry 不受损             | 400，文案「内置插件 X 不支持重载，请重启服务」                |
| setup 中途抛错                                            | 已登记 effect 反向回收，entry = error                      | 详情 error + lastStop                       |
| 服务正常关闭                                                | `onClose` → `manager.stop()` → 每个插件的 teardown      | 无 API 可观测；日志有记录                           |

***

## 11. 测试你的插件

仓库内可直接参考的测试范式：

- 单元级（mock context）：`src/__tests__/novel-plugin-session.test.ts` —— 手工构造 PluginContext mock，测编排逻辑。
- 集成级（真实宿主）：`src/__tests__/plugin-integrity-load.test.ts`、`plugin-npm-path.test.ts` —— 用临时目录 + 真实 `createApp()` 验证加载/校验/API。这套写法值得照抄：`PI_CONFIG_DIR` / `PI_DATA_DIR` / `PI_CWD` 三个环境变量指向临时目录，然后写 plugins.yml 启动。
- 门禁断言：`src/__tests__/plugin-manager.test.ts` —— 未授权时各入口的行为。
- 纯函数：`src/core/plugin/__tests__/path-guard.test.ts` —— 平台无关断言的范例。

最低限度应覆盖：setup 成功注册了声明的工具/路由；未授予 capability 时对应入口抛错或为 undefined；teardown 后自建资源被释放；配置缺失时的失败路径。

**跨平台注意**：不要用字符串前缀比较判断路径包含关系，也不要在断言里硬编码 `/` 或 `\`。宿主提供 `core/plugin/path-guard.ts` 的 `isInsideDir()` / `resolveWithin()`，插件侧同理应该用 `node:path` 的 `relative()` 而不是自己拼分隔符——这个仓库刚修过一个正是如此的 bug（硬编码 `'\\'` 让 npm 插件在 posix 上全部加载失败，而在 Windows 上测试全绿）。

验收命令：

```bash
pnpm --filter agent-server exec vitest run <你的测试文件>
pnpm typecheck        # 三段全过
git diff --check
```

***

## 12. 配置细则

### 12.1 环境变量引用

只支持**整个值就是一个引用**：`apiKey: ${MY_API_KEY}`。变量名须为大写字母/数字/下划线。

- 缺失变量 → 该配置项为 `undefined`，启动日志报 error。**不会**把字面量 `${MY_API_KEY}` 当值传给插件。
- 混合写法（`https://${HOST}/api`）和小写名 → 产生 error 诊断（条目仍加载，字面量原样传递）——看到日志就要改配置，别依赖它。
- 日志只打变量名，不打值。

### 12.2 依赖拓扑

`manifest.dependencies: ['other-plugin']` 引用的是对方的 **name**。启动时拓扑排序，依赖先 setup；三种失败都会阻止你 setup 并标记 error + dependencyDiagnostics：

- 依赖不存在；
- 循环依赖（含自依赖）；
- 依赖链上游被禁用或失败（传递阻断）。

运行期 enable 也一样：依赖未满足返回 409 `PLUGIN_DEPENDENCY_UNMET`。

### 12.3 isolate

YAML 里可以写，宿主只记录不执行。真正的隔离（Worker/独立进程）属 P3，不要据此宣传安全边界。

***

## 13. Hook（与插件的关系）

插件的事件观察走 `onEvent()`（`agent.hooks`）。如果你要的是**策略 Hook**（PreToolUse 阻断、SessionStart 注入上下文等），那是另一套机制：`config/hooks.yml` 的 argv 命令行 Hook，由 PolicyHookRunner 执行，与插件系统完全解耦。参见 `docs/execution-plan.md` §4 与 `hooks.yml` 文件头注释。

***

## 14. 当前已知边界（写插件前须知）

如实列出，不含糊：

1. `context.db` 授权后是**原始连接**，不是 query facade——SQL 写错会影响宿主库。
2. 没有 fs facade：`resolvePath()` 是约定，插件仍可直接 `node:fs` 读写任何路径。强制隔离要等 P3 进程边界。
3. capability 拒绝目前只有描述性错误消息，没有独立审计事件流。
4. **第三方插件不能自带 UI**：rendererKey 必须在桌面构建产物的白名单里，需要宿主维护者改三处代码并重新构建。外部插件的 `registerPanel` 只进 catalog 投影，界面上不出现且不报错（§8.7）。
5. npm 包自动下载/安装尚未实现：先自行 `npm install`，再 seal 锁定。
6. `plugins.yml` 会被管理 API 整体重写，手写注释与格式会丢失（§6）。
7. route handler 的 `request` / `reply` 类型是 `any`，没有类型安全；请自行校验入参。
8. 运行时不加载新代码：插件集合与代码的任何变更都需要重启，运行期 enable/disable 只影响后续聚合读取。

***

## 附录 A. 发布前检查清单

代码：

- [ ] manifest.name kebab-case 且全局唯一；version 符合 semver
- [ ] 入口是 ESM `.js`（外部插件；`.ts` 只能在 dev 模式跑）
- [ ] 没有 import 宿主内部模块（外部插件自带类型副本，路由返回普通对象）
- [ ] 所有 `register*()` 调用对应的 capability 已列入 manifest.permissions（请求）并向用户申请 grants（授权）
- [ ] setup 的旁路副作用全部经 `effect()`/`registerDisposable()`/`trackSession()` 登记，disposer 幂等
- [ ] teardown 不删除持久化数据（正常关机也会调用它）；只清理内存态
- [ ] 文件写入统一走 `context.resolvePath()`；判断路径包含关系不拼分隔符字符串
- [ ] 长耗时 LLM 调用设置了合理 `timeoutMs`，并响应 `signal`
- [ ] 每次 `createSession` 都 `trackSession()` 或 `finally { dispose() }`

接入：

- [ ] （builtin）已登记进 `pluginFactories`，键名 == plugins.yml 的 `id`
- [ ] （local）`sourceRef` 相对路径的基准是 `PI_CWD`，不确定就写绝对路径
- [ ] （npm）包已安装进 `PI_CWD/node_modules`
- [ ] （local/npm）已 seal 并把 `resolvedVersion` + `integrity` 写入 plugins.yml
- [ ] grants 里的 capability 名逐个对照过 §7.1（写错会让整条条目消失）
- [ ] 重启后用 `GET /api/plugins/<id>` 核对 `status` / `integrityStatus` / `grants`

验证：

- [ ] `pnpm typecheck` 三段全过
- [ ] 相关 vitest 通过；`git diff --check` 干净
- [ ] README 说明需要哪些 grants、哪些 slot/rendererKey、配置项含义

## 附录 B. 常见错误信息对照

| 现象 / 错误                                 | 原因                                                                                                | 处理                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| **插件根本没出现在 API 里**                      | ① builtin 未登记进 `pluginFactories`；② plugins.yml 里 capability 名写错导致整条被丢弃；③ 完整性校验失败；④ sourceRef 解析不到 | **先看启动日志**，所有拒绝都有 warn/error |
| `未找到内置插件工厂，跳过`                          | plugins.yml 的 `id` 未命中 `pluginFactories` 键                                                        | 对齐两处键名（§5.1）                 |
| `未知 capability: ...`（启动日志）              | plugins.yml 的 grants 拼错                                                                           | 对照 §7.1；这条会丢弃整个插件条目          |
| `无效的能力: ...` (400 INVALID\_CAPABILITY)  | grants API 收到非法 capability                                                                        | 对照 §7.1 表                    |
| `插件 X 未获得 <cap> 能力，无法...`               | grants 未包含所需 capability                                                                           | 在插件管理页授权，或改 plugins.yml      |
| `拒绝逃逸 node_modules 的 npm 插件路径`          | sourceRef 含 `..` 或指向 node\_modules 外                                                              | npm 的 sourceRef 只能是包名        |
| `拒绝不安全的 npm 插件 sourceRef`               | 包名不符合 `^(@scope/)?[A-Za-z0-9._-]+$`                                                               | 用规范包名                        |
| `npm 包未找到`                              | 没有 `npm install`                                                                                  | 先安装到 `PI_CWD/node_modules`   |
| `插件完整性校验失败`                             | 代码变了但锁没更新                                                                                         | 重新 seal，更新 plugins.yml       |
| `integrity 必须是 SRI 格式（sha256-<base64>）` | 用了 sha384/sha512 或格式错                                                                             | 只支持 sha256                   |
| `Slot "..." 未声明` / `已有冲突注册`             | slot 名拼错；或同 slot 同 priority 冲突                                                                    | 改 priority 或核对 slot 名        |
| **UI 面板注册成功但界面没变化**                     | rendererKey 不在桌面白名单里（静默跳过）                                                                        | 见 §8.7，需要宿主侧改造               |
| `路径 ... 越出 dataDir 边界`                  | `resolvePath` 收到 `..` 逃逸或绝对路径片段                                                                   | 把文件放进 dataDir 相对结构           |
| `PLUGIN_DEPENDENCY_UNMET` (409)         | dependencies 里引用的插件未启用                                                                            | 先启用依赖方                       |
| `内置插件 X 不支持重载，请重启服务` (400)              | 对 builtin 调了 reload                                                                               | 重启服务                         |
| 路由 404 但插件显示 enabled                    | 运行期 enable 的插件 route 未挂载                                                                          | 看 `effectiveAfterRestart`，重启 |

