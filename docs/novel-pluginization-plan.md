# 小说模块真插件化改造方案

> 基于 docs/pi-sdk-dsh-upgrade-research.md 与 docs/execution-plan.md 的当前基线。
> 状态：执行方案稿 v2（经源码逐条复核修订）。本文只写已核对的源码事实与可执行切片，不含未验证的设想。
> 定位：小说是插件架构的第一个真实消费者（dogfooding）。它跑通 P0 effect/grant 语义和 P2 Slot 契约，比任何示例插件都更有说服力。

## 1. 现状结论：小说"名义上是插件"，实际存在两层破格

### 1.1 后端已经是标准 Plugin 形态的部分（保留不动）

`apps/agent-server/src/plugins/novel-plugin/index.ts` 已按 `Plugin` 接口实现：

| 注册物 | 方式 | 数量 |
| --- | --- | --- |
| Fastify services | `context.registerService()` | 5（novelStore / promptManager / novelPromptBuilder / novelEngine / novelOrchestrator） |
| Agent | `context.subagentManager.registerAgent()` | 4（director / writer / reviewer / memory） |
| Team | `context.teamManager.registerTeam()` | 1（novel-team，仅内存） |
| Pi Session 工具 | `context.registerSessionTools()` | 17 |
| REST 路由 | `context.registerRoute()` | `/api/plugins/novel` 前缀全部路由 |
| UI 面板 | `context.registerPanel()` | 1（novel-canvas） |
| 数据库迁移 | 静态 `migrations` 属性 | 013-026 共 14 张表 |

catalogId `novel-plugin` 与 pluginId `novel` 的身份分离、依赖拓扑、effect ledger、宿主挂载边界等 P0 基础设施对小说已生效。

### 1.2 破格一：import 级反向依赖（core/app → novel-plugin）

插件化方向必须是 plugin → core；以下三处反向 import 已逐一在源码核实：

| 位置 | 反向引用 | 后果 |
| --- | --- | --- |
| `src/core/agent/chapter-finalizer.ts`（2151 行） | import 约 10 个 `plugins/novel-plugin/core/*` 模块（novel-store / prompt-builder / novel-memory-store / types / novel-agents / llm-error-policy / agent-run-utils）；对 core 的依赖仅 `PluginContext` 类型、`@repo/protocol/events`、`@repo/shared/novel` | 小说领域核心逻辑住在 core 里；禁用 novel 插件后这段代码仍在进程内，且被 novel-orchestrator 和 novel-discussion-runner 双向依赖 |
| `src/core/plugin/plugin-manager.ts:29` | `import { cancelDebug } from '../../plugins/novel-plugin/utils/cancel-debug-log.js'` | 插件管理器依赖某个插件的调试工具；任何插件都不应出现在这条路径上 |
| `src/app.ts:42,181` | `activeNovelChapterTasks`（novel-plugin/utils/chapter-task-registry.js）直接喂给 pi-subagents 桥 | 宿主启动代码硬编码读取插件内部模块级状态；novel 未加载时该 import 仍然生效 |

### 1.3 破格二：core 内的语义级 novel 耦合（import 扫描不可见）

以下文件住在 core，但内容硬编码了 novel 领域概念。它们不产生 `plugins/novel-plugin` 的 import 路径，却是同等的边界破坏：

| 文件 | 耦合事实（行号已核实） | 消费方 |
| --- | --- | --- |
| `core/agent/discussion-settings-store.ts:25,27` | SQL 直接读写 **`novel_discussion_settings` 表**——该表由 novel 插件的迁移创建；core 模块在数据层依赖插件 schema | 仅 novel-services.ts 与 novel-discussion-runner.ts |
| `core/agent/team-discussion-engine.ts` | 硬编码成员 id `novel-writer` / `novel-reviewer` / `novel-reviser` / `novel-director`（:539,568,1057,1152,1478,1569,1640），工具名 `novel_submit_review` / `novel_apply_revision`（:1006,1518,1526,1540,1572,1579） | 仅 novel-discussion-runner.ts 与自身测试 |
| `core/agent/moderator.ts` | 硬编码 `novel-director` / `novel-writer`（:227,258,295），prompt 正文写死小说编排示例（:150,168-170） | 仅 novel-discussion-runner.ts、chapter-chat-runner.ts 与自身测试 |
| `core/agent/pi-session.ts:314-356` | `extraTools` 豁免机制的注释与设计自述为 novel 闭包工具（`novel_submit_narrative_task` 等）定制；机制本身通用，属注释级耦合 | — |

**附带事实（须写入认知，不是缺陷）**：`PluginManager.getLoadedMigrations()` 收集 `loaded` 或 `enabled` 状态的迁移（plugin-manager.ts:724-732），因此 novel 即使 `enabled: false`，其 14 张表仍会在启动期创建。discussion-settings-store 正是靠这一事实"恰好能跑"——这是巧合不是设计。若未来把迁移执行收紧到仅 enabled 插件，core 的这张表读取会当场断裂。

### 1.4 测试归位欠账

`src/__tests__/` 下有 **50 个**文件直接 import `plugins/novel-plugin` 内部模块（chapter-budget、memory-ledger-handoff、novel-agent-*、story-ledger-*、moderator/team-discussion-engine 等）。这是历史演化的结果：小说测试一直放在根测试目录。批量归位是独立切片（见 N0-8），不与其他改动混在同一 diff。

### 1.5 破格三：桌面端硬编码，Slot 系统绕过小说

P2 Slot Registry 已交付（`ui/plugin-ui-registry.ts` + `components/slot/SlotRenderer.tsx` + `slot-context.tsx` 消费 `/api/plugins/ui-contributions`），但：

1. `App.tsx` 的 `AppView` 联合类型硬编码 `'novel'`，rail 按钮、视图分支、`<NovelWorkspace>` 全部显式 import 渲染。
2. novel 插件注册的 panel 是 `{ id: 'novel-canvas', component: 'NovelCanvas', position: 'main' }`——没有 `rendererKey`，经 plugin-manager 投影后 uiContribution state 为 **`invalid`**（plugin-manager.ts:1485 要求 rendererKey 且 slot 合法才 active）。
3. desktop 白名单 `RENDERERS` 目前只有 `'builtin.hello-panel'`（hello-plugin 已用 `rendererKey + slot + priority` 跑通全链路，是现成参照）；没有任何小说 rendererKey。
4. 结论：后端面板协议对小说从未真正生效，桌面是编译期特例（研究文档 §10.13 的判断至今成立）。
5. **Slot 基础设施还有一个缺口**：`workspace.main` 是 keyed slot，但 `SlotRenderer` 把 `entriesOfSlot(name)` 的全部条目无差别渲染，没有按 key 选择的能力——"多插件工作区单激活"需要先补宿主原语（见 N1-0）。

### 1.6 破格四：生命周期义务缺失（研究文档 §10.10 已点名）

- novel 没有 `teardown()`：停用后 4 个 `novel-*` Agent 仍留在 AgentManager 内存中可被 subagent 路径发现；novel-team 同样残留（TeamManager 只有会写 store 的 `deleteTeam()`，没有内存注销方法——subagent-tool.ts:200 的 `unregisterAgent` 存在，team 侧缺失）。
- Agent/Team 注册走 `context.subagentManager` / `context.teamManager` 直引用，未经 `context.effect()` 登记，effect ledger 看不到这些副作用。
- **在飞任务无人中止**：`activeNovelChapterTasks` 是模块级 Map，持有各创作流程的 AbortController。禁用插件既不注销观测 provider 也不 abort 这些任务，SSE 连接和 LLM 调用会继续跑完。
- manifest 未声明 `permissions`。注意：builtin 来源在 plugin-manager.ts:959-961 被**无条件授予全部 capability**，manifest.permissions 与 plugins.yml 的 grants 对 builtin 均不参与加载期判定——声明 permissions 目前只是文档与 API 展示（详见 N0-5 的口径）。
- 好的一面：`createSession/createAgUiSession` 的调用点已有 `finally { dispose() }` 纪律；迁移数据按 `persistent` 语义处理是正确的。

## 2. 目标与非目标

**目标**：
1. import 级反向依赖清零，并由架构守卫测试固化（含标识符扫描维度）；
2. core 内语义级 novel 耦合有明确处置：能整体归位的归位（N0-7），暂留 core 的列入白名单并记录理由；
3. novel 禁用后满足研究文档 §10.10 的回收语义：Agent/Team 注销、在飞任务 abort + 有上限 drain、观测 provider 注销、route/service 如实报 restartRequired、数据保留；
4. 桌面入口和工作区由 Slot 投影驱动，宿主补齐 keyed 选择与导航原语（N1-0）。

**非目标**：
- 不把 novel 改成 local/npm 外置包。它保持 builtin 来源，随仓库编译——本方案解决的是"边界与生命周期"，不是"分发形态"。
- 不搬迁 `@repo/shared/novel`。它是前后端共享类型库，不是插件代码，留在 packages/shared 是正确位置。
- 不做运行时热卸载。route/service 残留继续按 `restart-required` 如实报告。
- 不在本方案内修改 builtin 全能力授予的宿主策略（那是影响所有 builtin 插件的 P0-2 策略决策，见 N0-5 口径）。
- 不在本方案内处理 novel-module-analysis.md 中的单体拆分（MatrixWorkspace 等），那是独立的重构线。

## 3. 分期切片

每个切片沿用 execution-plan 的验收模板：RED 测试先行、类型检查通过、失败路径有诊断、dispose/retry 幂等、无运行时热加载。

### N0-1 架构边界测试先行（RED 守卫，两个维度）

**交付**：新增架构守卫测试（如 `src/__tests__/architecture-boundaries.test.ts`）：

1. **import 维度**：扫描 `src/core/**`、`src/app.ts`、`src/routes/**`、`src/lib/**` 的静态 import，断言不包含 `plugins/novel-plugin`；
2. **标识符维度**：对同一范围做 `novel[-_][a-z]` 标识符扫描（覆盖硬编码 agent id、工具名、表名），命中项进入显式白名单；白名单每项必须带注释说明归属切片（N0-7 或"接受并记录理由"）。初始白名单即 §1.3 的四个文件，N0-7 完成后应清空。

先让它 RED（§1.2 三处 + §1.3 白名单外若有新增命中都会失败），后续切片逐项转 GREEN。此测试是防止两类反向依赖复发的永久闸门。

**不做**：不守卫 `src/__tests__`（50 个存量文件的归位走 N0-8，守卫它会让 RED 噪声淹没信号）。

### N0-2 chapter-finalizer 归位插件

**交付**：
1. `src/core/agent/chapter-finalizer.ts` → `src/plugins/novel-plugin/core/chapter-finalizer.ts`。已核实其对 core 的依赖仅为 `PluginContext`/`PluginSessionOptions` 类型（core/plugin/plugin-types.js）、`@repo/protocol/events`、`@repo/shared/novel`，移动后 import 方向全部合法。
2. 更新消费方 import：`novel-orchestrator.ts`、`core/discussion/novel-discussion-runner.ts`（均在插件内）。
3. 随迁测试：`chapter-finalizer.test.ts` 及 `novel-orchestrator-{interject,reviser-context,revision-loop,retry,run-context,skill-path}.test.ts`、`novel-discussion-runner.test.ts` 中因本次移动需要改 import 的部分同步修正（完整归位见 N0-8）。

**测试**：N0-1 守卫 import 维度对 chapter-finalizer 的命中消除；移动后相关 Vitest 通过（纯移动，无行为变更）。

### N0-3 cancelDebug 出核

**交付**：`cancel-debug-log.ts` 是通用文件追加日志工具，移到 `src/lib/cancel-debug-log.ts`；更新 `plugin-manager.ts`、novel 侧 `creation-flow-routes.ts`、`novel-orchestrator.ts` 三处 import。

**测试**：N0-1 守卫对 plugin-manager 的命中消除；现有 policy/session 测试不受影响。

### N0-4 app.ts 与章节任务注册表解耦

**交付**：
1. core 新增通用 `BackgroundWorkRegistry`（建议放 `src/core/agent/background-work-registry.ts`）：接口仅 `register(name, provider): () => void` 与 `listActive()`，provider 形状沿用 pi-subagents-bridge 已有的 `ChapterTaskBridgeSource` 最小结构并泛化为 `{ listActive(): Array<{ id: string; [k: string]: unknown }> }`。
2. `PluginContext` 新增受控注册方法 `registerBackgroundWork(name, provider)`：登记为 effect（kind `background-work`，unloadScope `immediate`，disposer 注销 provider），不需要新 capability——它是只读观测供给侧，不产生执行权。
3. **注入时机**：registry 必须在 `app.register(pluginLoaderPlugin)`（app.ts:92）之前 decorate 到 app 并注入 PluginManager（与 setAgentManager 同一批 setter），否则 novel setup 执行时拿不到注册方法。
4. novel setup 中把 `activeNovelChapterTasks` 适配为 provider 注册；app.ts 的 pi-subagents 桥改读 registry，删除对 novel 模块的 import。桥本身零改动，仅换数据源。
5. 注意：本切片只解决**观测**解耦。provider 注销不会中止在飞任务——abort 义务在 N0-6 的 teardown 中履行。

**测试**：注册/注销幂等；禁用后 `listActive()` 为空；bridge dispose 不影响 registry 其他 provider；N0-1 守卫对 app.ts 的命中消除。

### N0-5 manifest permissions 声明（口径：文档化，非强制）

**既有事实（本切片的前提）**：plugin-manager.ts:959-967 的加载期策略是——builtin 无条件授予全部 9 项 capability，`manifest.permissions` 与 plugins.yml 的 `grants` 对 builtin 均**不参与**判定；只有 local/npm 读配置 grants。运行期 `PUT /grants` 经 `updateCatalogConfig` 可改 entry.grants，但下次重启加载又回到全授。

**交付**：
1. novel manifest 声明 `permissions: ['tools.register', 'routes.register', 'storage.plugin', 'ui.contribute']`——作为自我文档与插件管理页的请求侧展示，**不声称有强制力**。
2. 契约测试锁定：`GET /api/plugins/novel` 返回 permissions 字段等于上述声明、grants 为全集（builtin 现状）、uiContributions 含 novel 条目（N1-2 落地前允许 state=invalid，字段必须存在）。
3. 明确不做：不改 builtin 授权策略。"builtin 是否也应尊重显式 grants（最小授权）"是影响 hello/web-search/novel 全部内置插件的宿主策略变更，若要做应作为 execution-plan P0-2 的独立决策项，不在小说切片内夹带。

### N0-6 teardown 与 effect ledger 合规（含在飞任务收尾）

**交付**（对应研究文档 §10.10 的 novel 行项）：
1. novel 增加 `teardown()`，顺序固定：
   a. **先收任务**：遍历 `activeNovelChapterTasks`，对每个 task 调 `controller.abort()`，随后有上限 drain（等待退出，超时上限复用编排器现有的取消语义）；无法及时停止的 run 记入诊断（lastStop.errors），不无限等待；
   b. 按 setup 时记录的 agent id 列表逐一 `unregisterAgent()`（只注销自己注册的 id，不碰用户持久化 Agent）；
   c. TeamManager 新增 `unregisterEphemeralTeam(id)`（仅删内存注册、带 owner 校验，不复用可能写 store 的 `deleteTeam()`），teardown 调用它注销 novel-team；
   d. 迁移与数据不做任何回滚（`persistent` 语义）。
2. setup 中 Agent/Team 注册改经 `context.effect('agent.registration' | 'team.registration', { resourceId: config.id }, ...)` 登记，disposer 即上述注销调用；effect ledger 从此能回答"novel 有哪些活注册物"。
3. 核验 `createSession/createAgUiSession` 工厂已自动 trackSession（P0 已交付项）；若核验发现 novel 内部 session 有绕过工厂的创建点，改为工厂路径。

**测试**（研究文档 §10.10 验收原文 + 本方案补充）：停用 novel 后 `subagentManager.getAgent('novel-director')` 等为空、team 不可见；**禁用时在飞创作流的 AbortController 被触发、SSE 以取消收尾、超时未退出的 run 留下诊断**；重复 disable/enable 幂等；teardown 抛错时 lastStop 记录 partial 且剩余 effect 继续回收；effect ledger 中 agent/team 条目状态流转 active → released。

### N0-7 discussion 子系统归位（语义耦合的主处置）

**决策依据（已核实）**：`moderator.ts`、`team-discussion-engine.ts`、`discussion-types.ts`、`discussion-settings-store.ts` 四个文件在引擎移动后的非 novel 消费者为**零**；它们唯一的宿主侧依赖是 `AgentChannel`（core/agent/agent-channel.ts），而 AgentChannel 被 subagent-tool / team-manager / subagent-plugin / team-plugin 消费，必须留在 core。plugin → core 的 import 方向合法。

**交付**：
1. 四个文件整体移入 `plugins/novel-plugin/core/discussion/engine/`（moderator / team-discussion-engine / discussion-types / discussion-settings-store），engine 保持对 `core/agent/agent-channel.js` 的 import；
2. 更新插件内消费方 import（novel-discussion-runner、chapter-chat-runner、chapter-scene-plan-adapter、discussion-history、discussion-run-store、novel-character-discussion-context、creation-flow-routes、novel-services）；
3. 随迁测试：`moderator.test.ts`、`team-discussion-engine.test.ts` 移入插件 `__tests__/`（`agent-channel.test.ts` 留在根目录，AgentChannel 不动）；
4. N0-1 标识符白名单中这四项随之清空。

**备选方案（不采用，记录理由）**：把角色 id 映射改为配置注入、将引擎泛化为真正的 core 通用件。放弃原因：当前没有任何第二消费者，泛化是为想象中的需求付重构成本；待真实第二消费者出现时再从插件内提取，届时以 discussion-types 为契约边界。

**测试**：N0-1 两个维度对这批文件的命中全部消除；discussion 相关 Vitest（runner/engine/moderator/history/channel）全量通过。

### N0-8 存量测试批量归位

**交付**：`src/__tests__/` 下 50 个 import novel-plugin 的测试文件移入 `plugins/novel-plugin/__tests__/`（保持相对 import 结构，vitest 配置如需加 include 路径一并调整）。纯移动 + import 路径修正，不改断言。

**验收**：根测试目录不再有 novel-plugin import（此条并入 N0-1 守卫的白名单清空检查）；全量 Vitest 通过。

### N0 验收汇总

- N0-1 守卫测试 GREEN 且进入 CI（import 维度零命中；标识符维度白名单清空或每项带理由）；
- `grep -r "novel-plugin" src/core src/app.ts src/routes src/lib` 零命中；
- 停用 novel：在飞任务被 abort 且有诊断、Agent/Team 立即不可见、session 工具对新 session 不再注入、route/service 如实报 restartRequired、pi-subagents 观测列表清空、SQLite 数据保留；
- 已知并接受的现状：novel 处于 disabled 时启动，其迁移仍会执行（getLoadedMigrations 收 loaded），14 张表存在——此事实写入 plugins.yml 注释（N2）；
- 现有 novel 功能（创作流/矩阵/画布/群聊）回归通过。

## 4. 桌面 Slot 化（N1）

### N1-0 宿主原语补齐（Slot 化的前置缺口）

现状核实出的三个基础设施缺口，必须在 App 改造前交付：

1. **keyed slot 单激活选择**：`SlotRenderer` 当前渲染 `entriesOfSlot(name)` 全部条目，无法只渲染激活 key。交付二者之一：
   - `SlotRenderer` 增加 `entryKey?: string` prop（提供时只渲染该 key 的胜者条目）；或
   - registry 暴露 `resolveKeyed(name, key): StoredEntry | undefined`，App 自行渲染。
   推荐前者，保持渲染职责内聚。配套测试：多 key 注册时只渲染指定 key；key 不存在时返回 fallback；禁用贡献后该 key 消失。
2. **导航上下文**：contribution props 是服务端下发的静态 JSON，装不了 onClick/active 态。新增 `ViewNavigationContext`（App 提供 `{ activeView, activePluginId, navigate(view) }`），插件 renderer 组件经 `useContext` 消费。这是新的宿主 primitive，属于 desktop 代码契约的一部分。
3. **contributions 刷新途径**：`useRemoteContributions` 是 useEffect 里裸调 `getPluginUiContributions()`，只在挂载时拉一次，没有失效机制。改造为 react-query query（`queryKey: ['plugin-ui-contributions']`），使插件管理页 enable/disable 成功后可以 `invalidateQueries` 触发重投影。SlotProvider 已在 QueryClientProvider 之内，无层次障碍。

### N1-1 trusted renderer 注册

**交付**：
1. desktop 新增 `components/novel/trusted-renderers.tsx`（或并入现有 trusted-renderers 模块）：注册 `novel.workspace`（工作区包装组件）与 `novel.navigation`（rail 按钮组件，经 ViewNavigationContext 取回调与 active 态）。ErrorBoundary 语义由 SlotRenderer 的 EntryBoundary 已覆盖，包装层不重复造。
2. 物理目录 `components/novel/**`、`hooks/use-novel-*.ts`、stores、api client **原地保留**——P2 原则是"只能经白名单 rendererKey 解析到本地编译产物"，不要求源码搬家。可选后续项：把 novel 前端整体迁到独立 workspace 包并用 React.lazy 动态 import 做 code-splitting，让纯对话用户的首屏不承担小说 bundle；此项独立评估，不阻塞本方案。

### N1-2 novel panel 声明升级

**交付**：`novel-plugin/index.ts` 第 7 步改为两条 contribution：

```ts
// 工作区（keyed，entryKey 即激活键）
context.registerPanel({
  id: 'novel-workspace',
  title: '小说创作',
  component: 'NovelWorkspace',        // 旧协议兼容字段
  slot: 'workspace.main',
  scope: 'page',
  priority: 10,
  rendererKey: 'novel.workspace',
  entryKey: 'novel',
})
// 导航入口（list）
context.registerPanel({
  id: 'novel-navigation',
  title: '小说创作',
  component: 'NovelNavigation',
  slot: 'app.navigation',
  scope: 'app',
  priority: 20,
  rendererKey: 'novel.navigation',
})
```

投影后 uiContribution state 变为 `active`，desktop `useRemoteContributions` 经白名单解析注册进对应槽位。list slot 的 cell 按 `id`（contributionId）区分，与 hello-panel（id `hello-panel`）天然不冲突，priority 只需在同 cell 内唯一。

### N1-3 App.tsx 改为宿主固定页 + 插件页混合

**交付**：
1. `AppView` 收敛为宿主固定页 `'home' | 'chat' | 'settings' | 'plugins'`，新增 `pluginView: string | null`；中央区在固定页之外渲染 `<SlotRenderer name="workspace.main" entryKey={pluginView} />`（N1-0 的 keyed 选择），`pluginView` 为 null 时不渲染该 SlotRenderer。
2. rail 上宿主固定按钮（首页/对话/插件/设置）保留硬编码，插件按钮来自 `sidebar.navigation` list slot（`<SlotRenderer name="sidebar.navigation" />` 已存在于 App.tsx:100，无需新增）。
3. `HomePage.onOpenNovel`、`OnboardingRailButton` 的 view 联合中的 `'novel'` 移除；首页"小说创作"卡片改为仅在 novel navigation contribution 存在时显示（读 registry entries 判断）。
4. 快捷键确认：undo/redo 与工作台快捷键已在 `novel-workspace.tsx` 内部绑定（`useNovelWorkspaceShortcuts`），App 级无 novel 残留，无需额外处理。

**测试**：
- 无 novel（禁用或 API 不可达）：rail 无小说按钮、首页无入口、chat/settings 全功能正常；
- 有 novel：rail 出现按钮、点击进入 workspace.main 渲染 NovelWorkspace、再切回 chat 后 workspace 卸载（disposer 触发、store 状态按现有 persist 语义保留）;
- EntryBoundary：向 NovelWorkspaceEntry 注入抛错 props，仅该 contribution 消失且 ledger 记录 renderError，其余页面不受影响。

### N1-4 禁用语义的前端投影

**交付**：
1. 基于 N1-0 第 3 项：插件管理页 enable/disable 成功后 `invalidateQueries(['plugin-ui-contributions'])`，使"禁用 novel → 导航与工作区即时消失"成为现实；route/service 残留继续由后端 restartRequired 字段如实表达。
2. **运行期 enable 的诚实性**：novel 若在宿主挂载后经 `POST /enable` 启用，其 REST 路由要重启才可达（effectiveAfterRestart=true），此时导航贡献照常出现但工作区内所有请求会 404。前端处理：workspace 包装组件启动时探测一次 API 可达性（或读取插件详情的 effectiveAfterRestart），不可达时显示"需重启服务后可用"空态，而非放任报错。
3. 插件详情页展示 novel 的 effects（agent/team/background-work/panel 各条）与 unloadScope，验证 §10.11 的"不把聚合移除说成进程卸载"。

### N1-5 契约测试（衔接 execution-plan 待办第 10 项)

以 novel 为真实夹具落地 P2 renderer contract tests：
- `/api/plugins/ui-contributions` schema 版本化快照（含 novel.workspace / novel.navigation 条目）；
- desktop 白名单拒绝未知 rendererKey（注册一个假 key 的 contribution，断言不渲染且有诊断）；
- panels/all 兼容端点仍返回旧 PanelDefinition 形态。

## 5. N2：配置、文档与收尾

1. `config/plugins.yml` 注释更新：novel 条目注明"builtin 加载期全能力授予，grants 字段当前不影响 builtin"；注明"disabled 的 builtin 迁移仍会执行（getLoadedMigrations 语义），禁用不清数据，卸载数据另走显式产品流程"。
2. `docs/novel-module-analysis.md` 增补一节记录本次边界变更；ARCHITECTURE.md 对账（顺带清理其已滞后的模块条目，即分析报告 P2-1）。
3. e2e（apps/agent-server/scripts/e2e-test）：novel enabled 全流程冒烟 + disabled 启动冒烟（含"禁用后在飞任务被取消"场景）。
4. 回归清单：创作流 SSE、检查点决策、矩阵拖拽、画布、群聊、参考小说分析、lengdu skill 路径（`skillRead` 授权链路不受影响）。

## 6. 实施顺序与工作量预估

| 切片 | 依赖 | 规模 | 性质 |
| --- | --- | --- | --- |
| N0-1 守卫测试 | 无 | 小 | 先行 RED（两维度） |
| N0-2 finalizer 归位 | N0-1 | 中（2151 行移动 + 消费方/测试 import 修正） | 纯重构 |
| N0-3 cancelDebug | N0-1 | 小 | 纯重构 |
| N0-4 BackgroundWorkRegistry | N0-1 | 中（新接口 + PluginContext 方法 + app.ts 改造 + 注入时机） | 行为等价改造 |
| N0-5 permissions 声明 | 无 | 小 | 文档化 + 契约测试 |
| N0-6 teardown/effect | N0-4 | 中（在飞 abort/drain + TeamManager 新方法 + effect 登记 + 测试） | 生命周期补全 |
| N0-7 discussion 归位 | N0-1 | 大（4 文件 + 8 消费方 + 2 测试文件移动；engine 约 1800 行） | 纯重构 |
| N0-8 测试批量归位 | N0-2/7 完成 | 大（50 文件纯移动） | 机械整理 |
| N1-0 宿主原语 | 无（可与 N0 并行） | 中（SlotRenderer keyed 选择 + NavigationContext + query 化） | 基础设施补齐 |
| N1-1/N1-2 renderer + panel | N0、N1-0 | 小 | 声明升级 |
| N1-3 App 改造 | N1-0/N1-1 | 中（App/onboarding/home） | UI 结构调整 |
| N1-4/N1-5 投影与契约 | N1-3 | 中 | 含 execution-plan 待办第 10 项 |

建议顺序：N0-1 → N0-2 → N0-3 → N0-4 → N0-5 → N0-6 → N0-7 → N0-8 → N1-0 → N1-1 → N1-2 → N1-3 → N1-4 → N1-5。N1-0 可提前与 N0 并行（纯 desktop 侧，无后端依赖）。N0 全部完成后 novel 才有资格作为 N1 契约测试的夹具。

## 7. 风险与缓解

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| finalizer/discussion 移动波及面广 | 2151 行 + 约 1800 行引擎 + 多测试文件 type import | 纯移动不改逻辑；tsc + 既有 Vitest 全量回归；N0-1 守卫防复发；N0-2 与 N0-7 分开成独立 diff 保证可审性 |
| discussion 引擎未来出现非 novel 消费者 | 归位后若 chat 群聊等场景想复用引擎，需再提取 | discussion-types 作为契约边界留在插件内导出；提取时以它为准拆公共层（N0-7 已记录备选方案） |
| onboarding 流程引用 novel 视图 | `OnboardingRailButton` 的 view 联合含 'novel' | N1-3 一并收敛；引导步骤若指向小说页需同步更新 tour 定义 |
| 禁用后前端缓存残留 | react-query staleTime 5s + persist store | N1-0 query 化 + N1-4 invalidate；切换 pluginView 时卸载组件树；localStorage 持久化属 UI 偏好，不禁用 |
| unregisterAgent 误删同名用户 Agent | 用户可能自建同名 id | teardown 只注销 setup 时记录的本插件注册 id 列表，带 owner 校验（§10.10 原则） |
| teardown 中止在飞任务的用户感知 | 用户正在看的创作流被取消 | 属预期语义（插件停用即停止其工作）；SSE 以取消事件收尾并在 UI 呈现，drain 上限防悬挂 |
| pi-subagents 桥行为变化 | app.ts 直读改为 registry 中转 | provider 注册时机在 novel setup（早于桥的首个查询）；桥本身零改动，仅换数据源 |
| 运行期 enable 后路由不可达 | effectiveAfterRestart=true 时工作区请求 404 | N1-4 第 2 项的可达性探测 + "需重启"空态 |

## 8. 明确不做

- 不把 novel 改为 local/npm 分发或做安装器适配（execution-plan 待办第 8 项独立推进）。
- 不改 builtin 全能力授予的加载期策略（如需最小授权，走 execution-plan P0-2 的宿主策略决策）。
- 不在禁用时删除 SQLite 数据或回滚迁移。
- 不实现 workspace.main 的多插件同屏混排（keyed slot 经 N1-0 的选择原语做到单激活，切换即互斥）。
- 不动 `@repo/shared/novel` 的归属与内容。

## 9. 按插件开发指南收敛后的方案（v3）

### 9.1 交付形态与边界

小说继续作为随应用编译的 **builtin 插件**，不改成 local/npm。身份固定为：

| 项目 | 约定 |
| --- | --- |
| catalogId | `novel-plugin`，必须命中 `plugin-loader.plugin.ts` 的工厂映射 |
| pluginId | `novel`，等于 `manifest.name`，是运行期路由与依赖引用身份 |
| source | `builtin` |
| 入口 | `apps/agent-server/src/plugins/novel-plugin/index.ts` |
| 数据 | `context.db` + 静态迁移 013-026；表和用户数据是 `persistent` |
| HTTP 前缀 | `/api/plugins/novel`；插件内部路由只声明相对 path |

保持一个插件而不是拆成多个插件。创作编排、参考小说分析、文风档案、版本/账本和审计共享同一项目事实、事务和 Agent 生命周期，拆分会制造跨插件事务与版本同步问题。插件内部用 `core/chapters`、`core/analysis`、`core/prompting`、`core/observability`、`routes`、`infrastructure` 分域即可。

### 9.2 manifest 与 capability 请求

manifest 只声明插件实际使用的能力，作为自我描述；实际授权仍以宿主 `grants` 为准：

```ts
permissions: [
  'tools.register',
  'routes.register',
  'storage.plugin',
  'ui.contribute',
  'session.create',
  'agent.orchestrate',
  'confirmation.request',
]
```

小说当前未使用 `agent.hooks`、`network.outbound`、`process.exec`、`provider.transform`、`provider.observe`，不把这些能力写进请求清单。builtin 目前启动时会获得全部能力，这属于宿主级策略；小说方案不在局部修改该语义，最小授权另走宿主 P0-2 决策。

### 9.3 setup、teardown 与 effect 纪律

`setup(context)` 只做可审计的注册和初始化：静态迁移先由宿主执行，然后注册 5 个服务、4 个 Novel Agent、1 个内存 Team、Session 工具、REST routes、UI contributions。每个由插件创建的 Agent、Team、后台任务、Session 和观察 provider 都要通过 `context.effect()`、`registerDisposable()` 或 `trackSession()` 登记。

`teardown()` 按固定顺序执行：

1. 中止本插件所有在飞创作/分析任务，并在有限时间内 drain；超时写入 `lastStop.errors`，不无限等待。
2. 仅注销本次 activation 注册的 Agent 和临时 Team；不能删除用户持久化 Agent，也不能调用会写库的 Team `deleteTeam()`。
3. 释放 Session、事件订阅和后台观测 provider。
4. 不删除 SQLite 表、正文、版本、账本、参考源或模板。

必须如实标注卸载边界：Session/任务/Agent/Team/事件为 `immediate`，Session 工具为 `new-session-only`，route/service 为 `restart-required`，迁移和数据为 `persistent`。运行期 enable/disable 不得在 UI 或文档中宣称路由已即时挂载或已即时移除。

### 9.4 宿主反向依赖清零

插件只能依赖 core 的通用基础设施和 `@repo/shared/novel` 契约，core/app 不得 import `plugins/novel-plugin` 或硬编码小说标识。按现有 v2 切片执行：

- `chapter-finalizer` 归位到插件；
- 通用 `cancel-debug-log` 移到 `src/lib`；
- app 通过 `BackgroundWorkRegistry` 读取插件任务，不直接 import 小说注册表；
- discussion moderator/engine/settings/types 归位到插件；
- 小说测试随模块归位，架构守卫同时扫描 import 和 `novel_*`/`novel-` 标识符。

不得通过“保留迁移已执行”或“共享单例”绕过边界。插件 disabled 时迁移仍可能按当前宿主语义执行，但 core 不得因此读取小说表。

### 9.5 UI 贡献与桌面白名单

小说注册两个 contribution，而不是继续依赖 `App.tsx` 的 `novel` 特例：

| contribution | slot | rendererKey | entryKey | 作用 |
| --- | --- | --- | --- | --- |
| `novel-workspace` | `workspace.main` | `novel.workspace` | `novel` | 小说工作区整页，单激活 keyed slot |
| `novel-navigation` | `app.navigation` | `novel.navigation` | 无 | 左侧导航入口 |

桌面宿主负责实现可信 renderer、加入白名单、提供导航上下文和 keyed slot 选择；插件只声明 JSON 可序列化 props。插件禁用后 contribution 从投影消失，单个 renderer 出错由 EntryBoundary 隔离。运行期 enable 若 route 尚未挂载，工作区显示“需重启服务后可用”，不能把 404 当作插件逻辑错误。

### 9.6 配置与数据目录

插件文件写入统一使用 `context.dataDir`/`context.resolvePath()`，不再把 `config.dataDir` 当作绕过宿主数据边界的路径。`plugins.yml` 只保留产品配置（默认模型、章节/token 限制等）；禁用、重启和卸载均不删除数据。若未来需要清理，单独设计备份、确认、审计和不可恢复删除流程。

## 10. 接口契约与需求覆盖基线

### 10.1 唯一接口基线

`docs/novel/2026-08-10-新增小说功能接口清单.md` 作为小说插件的页面级接口契约，所有接口均标注 `/api/plugins/novel` 省略前缀。每个页面必须保持独立接口清单；实现、重构或拆路由时先更新该文档，再更新代码和测试。

接口清单的状态语义必须保留：

- **已交付**：后端接口和可达桌面入口都存在；
- **仅后端**：只有接口，没有独立页面或页面未调用；
- **未交付**：仅需求/设计契约，不能在验收中冒充能力。

参考小说阶段 2 以后、顺序重建和 Storyline/Scene revision 等缺口，继续按清单写明“部分交付/未交付”，不因插件化而扩大承诺。

### 10.2 页面、字段、路径和外部系统验收

每个页面的接口小节必须同时覆盖：

1. 页面操作对应的 method/path、请求字段、响应字段和状态/错误边界；
2. 源需求与原型（如后续补充）展示的全部字段；当前没有原型图片时，在文档显式记录该事实；
3. 用户从入口到提交、等待、审核、回滚或刷新结果的操作路径；
4. 外部系统或内部设施调用、数据方向、失败边界和可复用结论；
5. 与相近模块复用的接口、状态机、存储或事件，并说明不能复用的原因；
6. 模糊描述、未决语义和阻塞条件，单独列入“模糊项与待确认决策”。

现有接口清单的 §23-§25 已覆盖外部系统、复用合理性和模糊项；后续新增页面不得只补 route 表，必须同步补这三部分。参考源导入尤其要保留 File API/Base64、SQLite、LLM Provider、AG-UI/SSE、PromptManager、React Flow/dnd-kit 和 HMAC/安全密钥的边界说明。

### 10.3 插件级接口注册目录

在接口清单之外增加一份可机器校验的注册摘要（可先作为文档附录，稳定后再转 JSON）：

| 注册类别 | 验收内容 |
| --- | --- |
| services | 5 个服务名、所属模块、消费者和 `storage.plugin` |
| agents/teams | 4 个 Agent、1 个 Team、owner、注销方式和 `agent.orchestrate` |
| session tools | 工具名、参数 schema、取消语义、所属页面和 `tools.register` |
| routes | 所有相对 path、页面归属、状态、鉴权/确认/模型依赖 |
| migrations | 013-026、表用途、数据保留和前置依赖 |
| UI contributions | slot、rendererKey、entryKey、priority、运行期撤销状态 |

注册摘要与 `createNovelPlugin()` 的实际注册结果做契约测试：新增注册物必须同时更新摘要和页面接口清单；删除注册物必须保留兼容或迁移说明。

## 11. 分阶段实施与验收门槛

| 阶段 | 主要交付 | 通过条件 |
| --- | --- | --- |
| P0 契约冻结 | 页面接口基线、插件注册摘要、需求/字段/外部系统/路径/复用/模糊项对账 | 每个页面有独立接口清单；所有字段可追溯；未交付能力不被标成已交付 |
| P1 边界归位 | core/app 解耦、测试归位、架构守卫 | core/app/routes/lib 对插件 import 零命中；白名单只剩有书面理由的暂留项 |
| P2 生命周期 | effect ledger、任务 abort/drain、Agent/Team 注销、Session 追踪 | disable 后立即资源不可见；route/service 诚实标 restart-required；数据保留；失败有 diagnostics |
| P3 Slot UI | keyed workspace、navigation contribution、trusted renderer、刷新和错误隔离 | 启用/禁用/切页行为可验证；未知 rendererKey 不渲染；单贡献错误不影响宿主 |
| P4 回归收口 | route/schema、注册摘要、页面流程、SSE/取消/重启/e2e | 创作流、群聊、矩阵、画布、参考分析、审计和文风链路回归通过 |

每阶段都使用“测试先行 -> 实现 -> 类型检查 -> 失败诊断 -> 回归”的小切片；不把路由重命名、数据库重构、UI Slot 化和参考小说新产品能力混成一个提交。

## 12. 方案范围外但必须保留的决策记录

- builtin 是否遵守显式 grants 是宿主级授权策略，不在小说插件内偷偷改变。
- Fastify route/service 的运行期挂载和撤销需要重启；前端必须展示这一事实。
- 已发布章节撤回/修订、`asOfRevision` 历史语义、顺序重建隔离重放、Storyline/Scene revision、Prompt 模板权限以及参考小说 P4-P9 阈值仍是产品决策，不由插件化方案替用户决定。
- 原型图片当前缺失；一旦补充，必须重新执行“页面字段 -> 接口字段”覆盖检查。
