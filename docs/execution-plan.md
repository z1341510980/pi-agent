# Pi SDK + DSH 插件化升级：完整执行计划（当前版）

> 基于 docs/pi-sdk-dsh-upgrade-research.md 与当前源码复盘。
> 状态：执行基线。
> 目标：先把可信后端插件、Pi Hook 管道、Session 生命周期和桌面 Slot 做稳，再评估 P3 动态 UI。

## 0. 已确认的产品边界

1. 插件代码、插件集合和配置变更不在运行时加载；变更标记为 restart-required，重启后生效。
2. Worker 用于执行隔离、取消、超时和消息边界；不是安全沙箱。强安全边界使用独立进程。
3. Hook 配置使用自有格式（PiHookConfig），不兼容 DSH/Codex/Claude 外部配置；直接解析为内部 HookDefinition，无降级诊断层。
4. 动态 UI/工具需求成立，但只放在 P3，以不可变 package、approval、Host/Client run、Worker/进程隔离和撤销 ledger 实现。
5. 管理 API 是单用户本地 trusted-local API：默认仅监听 127.0.0.1，不引入 JWT/RBAC/账户；禁止远程暴露。
6. 插件 capability grant 与会话 Gate/Confirmation 分离。local/npm 的 manifest.permissions 只是请求，不能自动变成实际 grants。

## 1. 执行原则

- 每个垂直切片：先写一个能复现问题的测试（RED），再实现（GREEN），最后重构。
- 不做热加载：任何涉及新代码、路由、service、tool 集的修改都返回 restartRequired: true。
- 运行状态不说谎：setup 失败、Worker death、Host/Client 任一失败、旧 run 迟到回执都必须有明确状态和诊断。
- 所有 effect 必须可枚举、可幂等 dispose、可审计；失败回滚不能留下 listener/service/route。
- 每个阶段结束必须通过服务端类型检查、桌面端类型检查、相关 Vitest 和 git diff --check。

## 2. 当前已完成基线

- Hook matcher：支持 token 管道和正则，RegExp 复用不受 lastIndex 影响。
- Hook timeout/cancel、exit code、事件名守卫、decision/context 合并。
- Hook 执行安全边界：默认无 shell（argv + 引号感知分词）、环境变量白名单、cwd 存在性校验、stdout/stderr 字节上限、timeout/cancelled/spawn-failed 三种终止原因如实区分。
- Hook 配置解析统一走 hook-adapter：非法 point/command/args/timeoutSec 被拒绝并在启动日志列出；`security.trusted` 是唯一的 shell 与完整环境提权开关。解析只有一个入口 `parsePiHookConfigDetailed`。
- Catalog 身份与状态分离（研究文档 §10.2）：`catalogId`（plugins.yml 的 id）与 `pluginId`（manifest.name）全链路透传；`desiredEnabled` 与 `status` 分开投影，`enabled: false` 的 builtin 仍可见且可运行期 enable。
- plugins.yml 环境变量引用真实实现：只支持整值 `${NAME}`，缺失变量置 undefined 并报 error，混合写法/小写名拒绝并诊断，不再把字面量当密钥。注意混合写法目前只产生 error 诊断，条目不被丢弃。
- 依赖拓扑（§10.2）：manifest.dependencies 参与拓扑排序，依赖先于消费方 setup；缺失依赖、循环依赖和被上游阻断的插件不 setup，标记 error 并写入 dependencyDiagnostics。
- reload 预检前置（§10.11）：builtin/无 filePath 在 stop 与 entries.delete 之前就被拒绝，拒绝不再是破坏性的。
- 宿主挂载边界（§10.11）：`markHostMounted()` 区分启动期与运行期 activation。运行期 enable 的插件返回 `effectiveAfterRestart: true`，list/inspect/enable 三处一致报告"route/service 需重启才生效"，effect 的 `hostAttached` 如实为 false。
- enable/disable/config/grants 变更统一写回 plugins.yml，重启后期望状态保留，响应统一带 `restartRequired`。
- 版本与完整性锁定（§6.3）：local/npm 条目支持 `resolvedVersion` + `integrity`（SRI，仅 sha256）。加载侧在 import 之前校验包目录摘要；篡改、版本不匹配、锁格式非法都拒绝加载且不降级；catalog 回写保留锁定字段。`scripts/seal-plugin.ts` 生成锁定信息。无锁的 local/npm 仍可加载但标记 `integrityStatus: 'unverified'`，启动日志告警、inspect 诊断和桌面端徽章都如实呈现。目录扫描路径（`PI_PLUGINS_DIR` / `PI_PLUGINS_ENABLE_NPM`）走同一套判定。
- disabled 的 local/npm 插件运行期 enable 返回 `pending-restart`（记录期望状态并写回 YAML），不再谎报 404 未发现。
- PreToolUse updatedInput 合并、Pi 二次 schema 校验、失败阻断。
- SessionStart Hook signal、systemMessages 和 additionalContext 注入系统提示词。
- PluginManager setup 失败回滚 EventBus/service；disable 清理 serviceRegistry。
- Capability 门禁覆盖全部受控入口：`registerTool`/`registerRoute`/`registerService`/`registerMigration`/`registerPanel`/`onEvent`/`registerSessionTools` 之外，`createSession`/`createAgUiSession` 需 `session.create`；`db` 需 `storage.plugin`；`process`/`network` 分别需 `process.exec`/`network.outbound`；`subagentManager`/`teamManager`/`agentCallLogger` 需 `agent.orchestrate`；`confirmationManager` 需 `confirmation.request`。未授予的宿主管理器一律注入 undefined 而非交出原始引用。
- local/npm 默认不从 manifest 自动授予任何 capability；manifest.permissions 只是请求，实际能力全部来自 plugins.yml 的 grants。
- `context.resolvePath()` 把插件路径钉在自身 dataDir 内，越界抛错。这是约定辅助，不是沙箱（插件仍可直接 `node:fs`，强制边界属 P3）。
- npm sourceRef 路径约束。
- 插件 API 契约恢复；插件详情/tools/panels/inspect/ui-contributions 接口测试通过。
- SessionStore 生命周期：`invalidate({ scope, reason })` 是唯一失效入口（旧 `clear()` 已删除），idle/LRU eviction 与 app close 都经 `retireSession` 单一漏斗 abort/dispose，epoch 防止旧异步创建回写缓存。
- Session 隔离（研究文档 §10.12-1）：每个线程首次创建都新建独立 SessionManager；共享实例只用于取 sessionDir，不再作为会话本体。仅 resumePath 命中时 open 既有 JSONL。
- Session 失效语义（§10.12-2/4）：空闲会话立即 dispose+移除；活跃 run 只标 stale 并保留 lease，run 结束后由 getOrCreate 重建；`abortActive` 仅用于 Provider 删除和应用关闭。
- Run payload 桥（§10.12-5）：`agent.onPayload` 每个 session 只包一层（Symbol 幂等），本次 run 参数在 lease 下设置、finally 清除，不再叠加 wrapper。
- server 默认 loopback-only。
- 桌面 Slot Registry：single/list/keyed/chain、priority shadow、children 声明树、disposer 幂等、ledger snapshot、渲染错误隔离；ledger 支持同一 effectId 的多代历史行（撤销后重新注册取当前行）。
- 桌面 Slot 接线：10 个内置 slot 全部有渲染点 —— `sidebar.navigation`（App rail）、`workspace.main`（keyed，`plugin:<id>` 视图）、`right-panel.tab`（右栏 tab registry）、5 个 `chat.*`（标题栏动作、composer 左/右/dock、消息动作）、`chat.tool.detail`（keyed，按工具名）、`plugin-page.top`。插件变更后经 `requestSlotRevalidation()` 重新拉取并做增量 diff：消失即撤销、换代即替换、未变则保留。

## 3. P0：可信后端插件可控化（优先）

### P0-1 插件发现、身份和配置
**交付**：统一 catalogId/pluginId/source/sourceRef；配置根目录；YAML schema；disabled 可见；依赖拓扑和明确诊断；配置变更持久化为 restart-pending。
**已完成**：catalogId 全链路透传（含默认内置列表）；plugin-catalog 统一做结构校验、`${NAME}` 环境变量解析与未知 capability 拒绝；`desiredEnabled` 与 status 分离；依赖拓扑排序 + 缺失/循环/传递阻断诊断；enable/disable/config 写回 YAML。
**测试**：身份不同、缺失依赖、循环依赖、重复插件、配置解析失败、环境变量缺失、重启后状态恢复（plugin-catalog.test.ts 32 个 + plugin-catalog-roundtrip.test.ts 6 个 + plugin-manager.test.ts 依赖/desiredState/reload 预检分组）。

### P0-2 Capability Grant 宿主策略
**交付**：builtin/local/npm 默认策略分开；manifest permissions 仅 request；high-risk capability（process.exec、network.outbound、provider.transform、storage.plugin）默认拒绝；grants 更新写入 catalog/config；未授权调用统一抛出可审计错误。
**已完成**：local/npm 默认零 capability（manifest.permissions 不参与授权）；capability 集合扩到 12 项，新增 `session.create`、`agent.orchestrate`、`confirmation.request` 覆盖此前无门禁的 `createSession` 与四个原始宿主管理器；grants 经 `PUT /api/plugins/:id/grants` 校验后写回 plugins.yml 并标 restartRequired；路由与 catalog 共用同一份 `ALL_PLUGIN_CAPABILITIES`，桌面端授权弹窗同集合并带风险说明。
**测试**：未授权 registerTool/registerRoute/registerService/createSession；未授权时宿主管理器为 undefined；grant 更新后只在重启后生效；未知 capability 拒绝（INVALID_CAPABILITY）；新增三项 capability 可被接受。

### P0-3 PluginContext 最小权限视图
**交付**：不再向所有插件直接暴露原始 db、manager、cwd、dataDir、confirmationManager；按 capability 提供受限 facade；路径限制在插件 dataDir；DB 使用受控 query/repository facade。
**已完成**：`process.exec`（无 shell、30s、256KB、cwd 锁 dataDir）与 `network.fetch`（仅 HTTP(S)、30s）是真正的受限 facade；`db` 按 `storage.plugin` 门禁；`subagentManager`/`teamManager`/`agentCallLogger`/`confirmationManager` 改为按 capability 条件注入，未授予即 undefined；`context.resolvePath()` 提供 dataDir 内的路径解析并拒绝越界。
**尚未完成（明确记录，不含糊）**：`db` 在授权后交出的仍是原始 better-sqlite3 handle，不是 query/repository facade；没有 fs facade，路径约束是约定而非强制（插件可直接 `node:fs`）。强制文件边界需要 Worker/独立进程，属 P3。
**测试**：无 storage 不能访问 DB；无 process 不能执行；无 network 不能请求；无 agent.orchestrate/confirmation.request 拿不到宿主管理器；resolvePath 越界抛错。

### P0-4 生命周期和 effect ledger
**交付**：setup/teardown effect 统一登记；失败自动回滚；disable/restart 幂等；serviceRegistry、EventBus、tool、panel 清理；Fastify route/service 变更统一 restart-required；API 状态与真实状态一致。
**已完成**：effect ledger 与 disposer；setup 失败回滚；`markHostMounted()` 划分启动期/运行期 activation，`effectiveAfterRestart` 与 effect `hostAttached` 在 list/inspect/enable 三处一致；集成测试用真实 inject 验证运行期 enable 的 route 仍是 404、disable 后旧 route 仍存活、重启后两者才真正生效。
**测试**：setup 中途失败、重复 enable/disable、teardown 抛错、旧 service proxy 失效、旧 route 只能在重启后消失（plugin-host-mount.test.ts 7 个）。

### P0-5 SessionStore 生命周期
**交付**：active run 不允许被普通 eviction；invalidate/dispose abort active run；idle/LRU 淘汰 dispose；异步 factory epoch 防 stale session 回写；pending creation 在关闭时被拒绝并释放完成对象；dispose 幂等。
**追加交付（研究文档 §10.12）**：每线程独立 SessionManager；`invalidate({ scope, reason })` 区分全局与单线程失效，活跃 run 标 stale 而非删除 lease；`onPayload` 单次安装 + per-run 参数；每次退休发射产品级 `session:retired`（不冒充 SDK 的 `session_shutdown`）。
**测试**：invalidate race、factory reject、active run、pending tool、idle/LRU、重复 dispose、两线程 SessionManager 不同、stale 重建时机、thread 级失效不影响其他线程的异步创建、连续 run 不叠加 payload 参数、四条退休路径的事件载荷。

### P0-6 本地服务边界
**交付**：loopback-only 启动校验、配置错误快速失败、文档声明 trusted-local、远程部署显式阻断。
**测试**：允许三种 loopback；拒绝 0.0.0.0、局域网地址和任意公网地址。

## 4. P1：Hook 协议完整化

### P1-1 Hook 配置解析
实现自有配置格式（PiHookConfig）解析，直接转换为内部 HookDefinition；不需要兼容 DSH/Codex/Claude 外部格式，不输出诊断报告。

### P1-2 Hook 安全执行
默认不使用完整 shell 环境；明确受信配置；限制 cwd、环境变量、命令来源和输出大小；保留 timeout、AbortSignal、exit 2 block、审计事件。

### P1-3 Pi 生命周期桥接
补齐 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop；统一 Hook、native Extension、Gate、Confirmation、tool 执行顺序；上下文注入有 token 预算和来源标识。

### P1-4 Hook 测试矩阵
matcher、事件名不匹配、exit 2、timeout、abort、updatedInput 二次校验、上下文注入、命令失败、输出截断和并发 run。

## 5. P2：桌面 Slot 与插件管理

### P2-1 Slot Registry
完成 single/list/keyed/chain、priority、scope、声明树、disposer、冲突、active projection、ledger snapshot 和渲染错误隔离。

### P2-2 Desktop 管理界面
插件列表、详情、状态、restart-required、requested/granted capability、配置预检、错误诊断；授权弹窗必须读取真实 grants，禁止空集合覆盖。列表额外显示 `integrityStatus`（未校验的 local/npm 必须可见）。

### P2-3 前后端契约
统一 /api/plugins 返回结构、错误码、版本化 schema；增加 API contract tests。list/detail/inspect/ui-contributions 均带 `schemaVersion: 1`。

### P2-4 Inspect
展示 pluginId、catalogId、package/version、integrityStatus、run/effect 状态、Slot occupants、失败原因和最后 stop 结果。

## 6. P3：动态 UI/工具（独立安全项目）

前置条件：P0-P2 稳定、明确需求、完成安全评审。

交付顺序：
1. immutable package + integrity/signature metadata。
2. approvalRequestId + pluginRunId first-answer-wins。
3. Host/Client handshake 和 active commit。
4. Worker；需要强安全时独立进程。
5. JSON/schema UI model，renderer 不执行远程源码。
6. effect ledger、撤销、迟到回执隔离、Worker death 回收。

## 7. 每个切片的验收模板

- RED 测试能复现问题。
- GREEN 实现只覆盖当前行为。
- 类型检查通过。
- 相关单元/集成测试通过。
- 失败路径有诊断和状态投影。
- dispose/retry/restart 幂等。
- 未引入运行时热加载。
- 文档、API schema 和 UI 文案一致。

## 8. 当前下一步（严格顺序）

1. **已完成**：SessionStore 生命周期切片（clear race、dispose 幂等、factory 完成后释放对象、idle/LRU 淘汰）。
2. **已完成**：PluginContext facade 覆盖 db、process.exec、network.fetch 的最小受控视图；process 无 shell/超时/输出上限，network 仅 HTTP(S)/超时；db 与迁移、服务注册共用 storage.plugin grant。
3. **已完成**：grants/config 更新同步回 catalog 投影、写回 plugins.yml，并标记 restartRequired。
4. **已完成**：P1-2 Hook 安全执行与 P1-4 Hook 测试矩阵（policy 目录 91 个测试）；hooks.yml 迁移为 argv 形式并新增 security 块。
5. **已完成**：研究文档 §10.12 的 Session 生命周期三项（每线程独立 SessionManager、invalidate scope、run payload 桥），provider/settings/thinking-level 路由已按各自 scope 接入。
6. **已完成**：P0-1 全部交付项（catalogId 身份、环境变量插值、disabled 可见、依赖拓扑、reload 预检前置、catalog 往返与重启恢复测试）。
7. **已完成**：P0-4 的宿主挂载边界（effectiveAfterRestart / hostAttached 投影 + Fastify 侧集成验证）。
8. **已完成**：local/npm 插件的版本与完整性锁定（resolvedVersion + integrity SRI、加载前校验、seal 脚本、pending-restart enable 语义）。npm 包的自动下载/安装编排仍为手动（用户自行 npm install 后 seal），属安装器后续项。
9. **已完成**：§10.12 剩余项按产品决定落地——会话退休时发射产品级 `session:retired` 事件（idle/LRU/配置失效/关闭均带原因；payload 不含 session 引用）。明确边界：这是本仓库自己的通知，不是 Pi SDK 的 `session_shutdown`，也不冒充 SDK 生命周期回调。
10. **已完成**：P2 renderer contract 测试——服务端 `/api/plugins` 系列（list/detail/inspect/ui-contributions/toggle）统一带 `schemaVersion: 1` 并钉死响应形状（必选键 + 可选白名单，disposer 绝不下发）；桌面端 Slot 白名单解析（未知 rendererKey 跳过、非 active 跳过、注册冲突隔离、卸载撤销、服务端不可用保留宿主 UI）与渲染错误隔离。

## 8.1 迁移过渡代码清理（已完成）

- 删除死文件 `routes/plugins.route.ts`（app.ts 已改由 plugin-loader 提供 API，文件无任何引用）。
- 删除 `PluginManager.getServiceProxy/getService/getServiceNamesForPlugin/isHostMounted`——零调用方的迁移期设计残留；serviceRegistry 本体保留（registerService/stopPlugin 仍在使用）。
- 删除 `PiSessionStore.clear()` 与 `dropActive` 选项——生产调用方已全部迁移到 `invalidate({ scope, reason })`，保留旧入口只会诱导绕过 lease 保护。
- 合并 `hook-adapter.parsePiHookConfig` 到 `parsePiHookConfigDetailed(...).hooks`——同一解析只保留一个入口。
- 重写 `pi-session-extension.test.ts` 的两个 "[RED]" 测试：原断言"创建会话后原生回调未被调用"是无效断言（回调只在工具执行窗口触发）；现改为真正发起工具调用并断言原生管道经编排器被保留。
- 删除 grants 路由里手写的第二份 capability 清单，改为复用 `ALL_PLUGIN_CAPABILITIES`。

## 8.2 复核后补齐的缺口（已完成）

对着本文件与研究文档逐条核对源码后发现并修复的问题：

1. **`createSession` 无 capability 门禁**（P0-2 明文要求但缺失）：新增 `session.create`，`createSession`/`createAgUiSession` 共用这条 grant。
2. **四个原始宿主管理器裸露**：`confirmationManager`/`subagentManager`/`teamManager`/`agentCallLogger` 此前无条件注入。新增 `agent.orchestrate` 与 `confirmation.request`，改为与 process/network 一致的条件注入；类型相应改为可选，novel（builtin）在装配缺失时早失败而非静默拿 undefined。
3. **integrity 的 sha384/sha512 是死分支**：解析层接受但校验层硬要求 sha256，写这两种算法的锁会永久失败。改为解析层与 catalog 校验层都只接受 sha256，错误信息直接说明。
4. **目录扫描路径不做完整性校验**：`PI_PLUGINS_DIR` / `PI_PLUGINS_ENABLE_NPM` 发现的插件此前直接 import。改为有锁则校验（失败拒绝加载）、无锁则加载但标记 `integrityStatus: 'unverified'` 并告警；新增该字段贯通 entry / list / detail / inspect / 桌面端徽章。
5. **运行期 disable 不撤销 UI 贡献**：`useRemoteContributions` 只在挂载时拉一次，registry 不读 query 缓存，被禁用插件的贡献会挂到重启。改为按 `pluginId + activationGeneration + contributionId` 做增量 diff，插件页的 enable/disable/reload/grants 成功后调用 `requestSlotRevalidation()`；重新拉取失败时保留既有贡献（网络抖动不该让界面塌掉）。
6. **8 个 slot 只有声明没有渲染点**：补齐 `workspace.main`（App 主区，keyed 按 `plugin:<id>` 视图）、`right-panel.tab`（新增 `RightPanelTabs`，宿主 Context 固定为第一个 tab，选中项消失时自动回落）、5 个 `chat.*`（标题栏动作、composer 左/右/dock、消息动作）、`chat.tool.detail`（keyed 按工具名）。`SlotRenderer` 相应支持 `entryKey`/`entryId`/`chainOwner`。
7. **`useSlotRegistry` 硬依赖 Provider**：渲染点深入到消息气泡和工具卡后，会迫使所有局部挂载和单测都套 Provider。新增 `useOptionalSlotRegistry`，无 Provider 时渲染 fallback；context 值拆到 `slot-context-value.ts`，避免深层组件经 barrel 拉进 API client 与全部 renderer（实测会让无关单测超时）。
8. **`GET /api/plugins` 与 detail 缺 schemaVersion**：此前只有 inspect 与 ui-contributions 带版本号，contract 测试的标题却写着 schemaVersion=1。已补齐两处并加断言。
9. **ledger 无法表达"撤销后重新注册"**：`ledgers.find` 取的是首行，导致同 effectId 重建后被旧的 disposed 行判成已撤销。改为 `currentLedger()` 取最后一行，历史行保留为审计记录。
10. **桌面端 vitest 默认 5s 超时偏紧**：58 个文件并行 transform 时，若干与被测逻辑无关的用例随机卡在 import 阶段超时。放宽到 20s（只改等待预算，不动任何断言）。

## 8.3 已知仍未闭环（不当作已完成）

- `db` 授权后交出的是原始 better-sqlite3 handle，不是受控 query/repository facade。
- 没有 fs facade，`resolvePath()` 是约定而非强制边界；插件仍可直接 `node:fs` 越界。真正的文件隔离需要 Worker/独立进程（P3）。
- capability 拒绝没有独立审计事件，目前只有描述性错误消息 + setup 失败日志。
- 唯一进入白名单的 renderer 仍来自默认禁用的 hello-plugin；slot 运行时的正确性由测试保证，开箱构建下看不到插件贡献（这是产品决定，不是缺陷）。

## 9. 明确不做

- 不做远程管理 API 登录系统。
- 不做运行时 import 新插件代码。
- 不把 Worker、guard、new Function 宣传成安全沙箱。
- 不把会话 Gate/Confirmation 当成插件安装权限。
- 不在 P0-P2 实现模型生成 JavaScript 的 renderer 执行。


