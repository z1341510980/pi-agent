# pi-agent v1.0 开发状态与后续计划

> 本文档供 AI Agent 接续开发使用，包含：已完成工作、未来计划、每项计划对应的文档行号引用。
> 最后更新：2026-06-18

---

## 1. 项目概述

pi-agent 是一个 AI Agent 桌面应用，用户通过自然语言与 Agent 对话，Agent 可调用工具（读写文件、执行命令、搜索网页）、拥有跨会话记忆、支持多 Agent 协作。

**技术栈**：TypeScript / Fastify / Pi SDK / AG-UI 协议 / Electron / React 19 / Tailwind CSS / shadcn/ui

**仓库结构**：
- `apps/agent-server/` — 后端（Fastify + Pi SDK）
- `apps/desktop/` — 前端（Electron + React）
- `packages/shared/` — 共享类型（AgentMessage、AgentRunInput 等）
- `packages/protocol/` — AG-UI 协议类型（BaseEvent、EventType 等，重导出 @ag-ui/core）
- `packages/config/` — 配置包（BrowserConfig 等）

---

## 2. 已完成工作

### S0: 稳定基线 ✅

- 修复根验证脚本
- P0-P4 后端 SDK 集成（35 测试通过）
- `@repo/protocol`（16 测试通过）、`@repo/shared`（25 测试通过）
- Desktop typecheck 通过

**提交**：`cfb97ce` `c5e8bca` `cda6146` `93fa31f` `01cf10f` 等

### S1: Desktop Shell + Provider Bootstrap ✅

- F0 应用外壳：Tailwind/shadcn 设置、自定义标题栏、三栏布局
- F8a Provider Bootstrap：Provider/API Key 表单、本地设置持久化
- 移除 CopilotSidebar，自建 ChatWorkspace 占位

**提交**：`d356467` `bfbd08c`

### S2: 工具执行与确认骨干 ✅

**后端**：
- P5 Gate 集成（权限模式 Auto/Plan/Read-only）
- Evidence Ledger 最小记录
- P10a 最小 WebSocket：auth、confirmation_request/response、连接生命周期
- SSE 心跳（15s keepalive）

**前端**：
- F2 基础：权限模式切换器（PermissionModeSwitch）、确认对话框（ConfirmationDialog）、通用工具卡片状态机（ToolCardList + useToolExecutions）
- WebSocket 客户端 hook（useWebSocket）

**提交**：`1bde33f` `4f6e9f0` `5122f89`

**验证**：6 个 gate-route 测试 + 5 个端到端场景测试通过

### S3-1: AG-UI run/steer/follow-up 稳定性 + 事件顺序契约测试 ✅

**后端修复**：
- abort 契约：abort 时发射 RUN_FINISHED（reason='aborted'）而非 RUN_ERROR
- RUN_FINISHED/RUN_ERROR 互斥性：`terminated` 守卫 + `emitTermination` 确保只发射一次终止事件
- 同线程 run 互斥：`tryAcquireRun`/`releaseRun` 防止并发 run
- PiSessionStore 竞态修复：`pendingPromises` Map 复用进行中的创建 Promise
- steer/follow-up 错误处理：包裹 try/catch，抛出 AppError

**测试**：25 个契约测试（s3-1-agui-contract.test.ts）+ 6 个 session-store 测试

**提交**：`bd24f29`

### S3-2: F1 流式聊天 ✅

**前端实现**：
- 重写 `agui-client.ts`：修复端点（`/ag-ui/agent/${agentId}/run`）、runId、AbortController、BaseEvent 类型 + SSE 流解析（parseSseStream/parseSseChunk）
- `use-streaming-run.ts` hook：状态机（idle→streaming→finished/aborted/error）+ AbortController 中断
- 消息流组件：`applyEvent` reducer 将 AG-UI 事件映射为 ChatMessage 状态更新
- 消息气泡：用户右对齐/助手左对齐，react-markdown + remark-gfm 渲染
- 思考块（ThinkingBlock）：可折叠，流式时展开，完成后折叠
- 工具调用卡（ToolCallCard）：工具名/参数/状态/部分结果，状态图标
- 输入区（InputArea）：Enter 发送/Shift+Enter 换行，运行时发送→中断切换，IME 组合输入支持
- 空状态（EmptyState）/错误卡片（ErrorCard）/流式指示器（StreamingIndicator）
- chat-workspace.tsx 集成所有组件

**验证**：typecheck:web + typecheck:node 通过，App.test.tsx 通过

**提交**：`559a279`（14 files, +1259/-176）

---

## 3. 未完成/待修复项

### 3.1 Git Push 未完成

代理 127.0.0.1:10808 无法连接，本地提交未推送到远程。需要启动代理后执行 `git push`。

### 3.2 ESLint 配置问题

`apps/desktop/eslint.config.mjs` 引用了 `eslint-plugin-vue` 但未安装。这是预存问题，不影响 S3-2 代码。

---

## 4. 后续开发计划

### S3 验证：桌面端到端流式对话验证

**目标**：桌面用户发送消息、接收流式文本、看到工具卡、中断运行

**验收标准**（参考 `ARCHITECTURE.md` L3979-3992 F1 验收标准）：
- 用户可在输入区输入消息并发送
- 助手消息流式逐字显示
- 工具调用显示为卡片
- 可中断正在运行的 Agent
- 刷新后可重新对话

**测试方式**：启动 agent-server + desktop dev，手动发送消息验证

---

### S4: Session 可靠性

**计划文档**：`docs/superpowers/plans/2026-06-17-v1-development-sequence-review.md` L159-178

**后端（P6 SessionManager）**：
- SessionManager 验证 — 参考 `ARCHITECTURE.md` L3516-3529（阶段 6：Session 管理）
- Session Health 和孤儿 toolResult 修复 — 参考 `ARCHITECTURE.md` L1851-1906（§15 Session 健康检查 + 孤儿修复）
- SessionFileRegistry — 参考 `ARCHITECTURE.md` L2186-2229（§20 会话文件管理）
- 修复 L5/L6 问题：deep config merge 和 navigate 封装

**前端（F3 会话持久化）**：
- 会话恢复（重开应用） — 参考 `ARCHITECTURE.md` L4006-4015（F3 任务清单）
- 会话搜索、重命名/删除/导出
- 会话分支（Pi SDK 树结构）
- 会话列表虚拟化（@tanstack/react-virtual）
- 草稿持久化

**前端详细设计**：`FRONTEND_DEVELOPMENT.md` L1839-1848（§13.5 F3 会话持久化）

**Zustand Store 设计**：`FRONTEND_DEVELOPMENT.md` L1171-1205（§7.2.1 sessionStore）

**验收标准**（`v1-development-sequence-review.md` L175-178）：
- 重启应用保留可用会话
- Navigation/fork/compact 端点通过 PiAgUiAgent 而非直接 session 内部

---

### S5: 上下文与记忆

**计划文档**：`v1-development-sequence-review.md` L179-196

**后端**：
- P7 Compaction 验证、Storm Breaker、工具输出截断 — 参考 `ARCHITECTURE.md` L3530-3544（阶段 7）、L1469-1771（§13 Session Compaction）
- P8 FactStore、SessionSummary、MemoryTicker、Memory Reflection、memory_search — 参考 `ARCHITECTURE.md` L3545-3560（阶段 8）、L711-902（§6 记忆系统）、L2654-2696（§22.9 记忆反思）

**前端**：
- F4 压缩状态 — 参考 `ARCHITECTURE.md` L4017-4024（F4 任务清单）、`FRONTEND_DEVELOPMENT.md` L1850-1858（§13.6）
  - 压缩横幅（compaction 事件触发）
  - 上下文面板（右栏）：token 用量、阈值、缓存诊断 — `FRONTEND_DEVELOPMENT.md` L572-597（§4.5.2）
  - 手动压缩按钮
- F5 记忆面板 — 参考 `ARCHITECTURE.md` L4026-4034（F5 任务清单）、`FRONTEND_DEVELOPMENT.md` L1859-1867（§13.7）
  - 记忆编译状态页 — `FRONTEND_DEVELOPMENT.md` L928-943（§5.8.1）
  - 事实库浏览 — `FRONTEND_DEVELOPMENT.md` L947-961（§5.8.2）
  - 记忆标签页（右栏） — `FRONTEND_DEVELOPMENT.md` L614-632（§4.5.4）
  - 反思验证入口（shadow/write 模式）

**验收标准**（`v1-development-sequence-review.md` L194-196）：
- 长对话安全压缩并继续
- 用户可见记忆可检查和刷新

---

### S6: 用量与全量实时推送

**计划文档**：`v1-development-sequence-review.md` L198-215

**后端**：
- P9 Usage Ledger — 参考 `ARCHITECTURE.md` L3561-3575（支线 P9）、L1771-1850（§14 Usage Ledger）
- P10b 通知、DevLog、memory update、usage update WebSocket 事件 — 参考 `ARCHITECTURE.md` L3576-3590（支线 P10）

**前端**：
- F6 用量面板 — 参考 `ARCHITECTURE.md` L4036-4050（F6 任务清单）、`FRONTEND_DEVELOPMENT.md` L1869-1880（§13.8）
  - 用量概览卡片、成本趋势折线图（Recharts）
  - Agent 归因饼图、模型明细柱状图
  - 明细列表分页
  - 本轮用量提示（输入区下方） — `FRONTEND_DEVELOPMENT.md` L530-538（§4.3.4）
  - 状态栏用量实时更新 — `FRONTEND_DEVELOPMENT.md` L213-229（§3.3）
- F7 实时推送 — 参考 `ARCHITECTURE.md` L4051-4062（F7 任务清单）、`FRONTEND_DEVELOPMENT.md` L1882-1890（§13.9）
  - WebSocket 重连（指数退避）
  - 通知中心 — `FRONTEND_DEVELOPMENT.md` L1062-1086（§6.2）
  - DevLog 面板 — `FRONTEND_DEVELOPMENT.md` L1087-1103（§6.3）、`ARCHITECTURE.md` L2841-2850（§23.2）
  - 实时用量更新

**验收标准**（`v1-development-sequence-review.md` L213-215）：
- 每次运行和每日用量可见
- WebSocket 重连和通知处理稳定

---

### S7: RC 设置与打磨

**计划文档**：`v1-development-sequence-review.md` L217-232

**前端**：
- F8b 完整设置 — 参考 `ARCHITECTURE.md` L4063-4086（F8 任务清单）、`FRONTEND_DEVELOPMENT.md` L1892-1904（§13.10）
  - 设置布局（左导航+右内容） — `FRONTEND_DEVELOPMENT.md` L640-656（§5.1）
  - Provider 管理完整流程 — `FRONTEND_DEVELOPMENT.md` L695-758（§5.3）
  - 模型管理 — `FRONTEND_DEVELOPMENT.md` L760-777（§5.4）、`ARCHITECTURE.md` L2231-2278（§21 模型注册表）
  - Agent 管理 — `FRONTEND_DEVELOPMENT.md` L779-833（§5.5）
  - 权限与安全 — `FRONTEND_DEVELOPMENT.md` L835-868（§5.6）
  - 通用设置 — `FRONTEND_DEVELOPMENT.md` L658-693（§5.2）
  - 出站代理配置 — `FRONTEND_DEVELOPMENT.md` L670-693（§5.2.1）、`ARCHITECTURE.md` L2888-2951（§24.5）
  - 关于页 — `FRONTEND_DEVELOPMENT.md` L984-1005（§5.10）
  - 表单校验（react-hook-form + zod）

- F9 打磨 — 参考 `ARCHITECTURE.md` L4087-4096（F9 任务清单）、`FRONTEND_DEVELOPMENT.md` L1906-1918（§13.11）
  - 命令面板（Cmd+K） — `FRONTEND_DEVELOPMENT.md` L1105-1124（§6.4）
  - 全套快捷键 — `FRONTEND_DEVELOPMENT.md` L1715-1733（§11.3）
  - 动画打磨 — `FRONTEND_DEVELOPMENT.md` L1582-1681（§10）
  - a11y 审计 — `FRONTEND_DEVELOPMENT.md` L1701-1713（§11.2）
  - 性能优化 — `FRONTEND_DEVELOPMENT.md` L1736-1777（§12）
  - 系统托盘 — `FRONTEND_DEVELOPMENT.md` L109-113（§2.1）
  - 自动更新 UI — `FRONTEND_DEVELOPMENT.md` L1126-1143（§6.5）、`ARCHITECTURE.md` L2107-2145（§18）
  - 错误边界

**验收标准**（`v1-development-sequence-review.md` L230-232）：
- v1.0 发布清单可从干净机器运行

---

## 5. 关键文档索引

| 文档 | 路径 | 用途 |
|------|------|------|
| 开发顺序审查 | `docs/superpowers/plans/2026-06-17-v1-development-sequence-review.md` | S0-S7 阶段定义、验收标准 |
| 架构设计 | `docs/ARCHITECTURE.md` | 全部后端设计、P0-P13 阶段、F0-F9 任务清单 |
| 前端开发 | `docs/FRONTEND_DEVELOPMENT.md` | 前端完整功能规格、UI 设计、组件规范 |

### ARCHITECTURE.md 关键章节行号

| 章节 | 行号 | 内容 |
|------|------|------|
| §1 架构决策总览 | L8-59 | 47 个架构决策 |
| §3.5 Agent Loop | L172-224 | Pi SDK 内置 Agent Loop + 定制点 |
| §3.8 端到端数据流 | L405-476 | SSE 流完整数据流 |
| §6 记忆系统 | L711-902 | FactStore/SessionSummary/MemoryTicker |
| §7 通信协议 | L903-940 | SSE + WebSocket 分工 |
| §7.2 AG-UI 事件顺序 | L912-920 | RUN_STARTED → ... → RUN_FINISHED |
| §7.5 Event Bus | L942-1031 | 事件总线设计 |
| §8 三层配置 | L1032-1203 | Global → Agent → Session |
| §8.2 LLM 动态配置 | L1080-1118 | ProviderRegistry 架构 |
| §11 权限模式 | L1367-1397 | Auto/Plan/Read-only + 确认机制 |
| §13 Compaction | L1469-1771 | 上下文溢出处理、三级阈值 |
| §14 Usage Ledger | L1771-1850 | 用量追踪 |
| §15 Session 健康 | L1851-1906 | 健康检查 + 孤儿修复 |
| §16 API Key 安全 | L1906-2010 | safeStorage + CredentialBridge |
| §20 SessionFileRegistry | L2186-2229 | 会话文件管理 |
| §21 ProviderRegistry | L2231-2278 | 模型注册表 |
| §22.7 Gate 接口 | L2451-2594 | 权限控制 + 工具包装 |
| §22.8 Evidence Ledger | L2594-2654 | 任务验证 |
| §22.9 Memory Reflection | L2654-2696 | 记忆反思 |
| §22.11 Mid-turn Steer | L2764-2825 | 中途引导 + Abort |
| §24.5 出站代理 | L2888-2951 | 网络代理配置 |
| §28 实施路线图 | L3378-3686 | P0-P13 阶段详细定义 |
| §30 前端实施计划 | L3870-4158 | F0-F9 详细任务清单 |
| §30.5 F1 任务清单 | L3979-3992 | F1 对话最小可用验收标准 |
| §30.5 F2 任务清单 | L3994-4004 | F2 工具卡+确认验收标准 |
| §30.5 F3-F9 任务清单 | L4006-4096 | 各前端阶段验收标准 |

### FRONTEND_DEVELOPMENT.md 关键章节行号

| 章节 | 行号 | 内容 |
|------|------|------|
| §1 概述 | L22-76 | 产品定位、设计目标、技术栈、设计原则 |
| §2 信息架构 | L79-148 | 顶层结构、路由设计、后端映射 |
| §3 全局布局 | L151-229 | 三栏布局、主题系统、状态栏 |
| §4 对话工作台 | L232-633 | 消息流、工具卡、思考块、输入区、上下文面板 |
| §4.2 消息类型矩阵 | L304-321 | AG-UI 事件 → UI 映射 |
| §4.2.4 工具调用卡片 | L385-432 | 工具卡状态机 + 差异化形态 |
| §4.3 输入区 | L476-538 | 多行输入、steer 模式、用量提示 |
| §5 设置中心 | L636-1005 | Provider/模型/Agent/权限/用量/记忆/自动化/关于 |
| §6 浮层系统 | L1009-1143 | 确认对话框、通知、DevLog、命令面板、更新提示 |
| §7 状态管理 | L1146-1293 | Zustand + TanStack Query 分层 |
| §7.2 Zustand Store | L1169-1254 | sessionStore/uiStore/connectionStore |
| §8 通信层 | L1297-1467 | useStreamingRun/useWebSocket/useIpc |
| §8.2 useStreamingRun | L1320-1371 | SSE 流式对话 hook 设计 |
| §9 组件库规范 | L1470-1579 | 目录结构、三态组件、设计 Token |
| §10 动画规范 | L1582-1681 | 动画原则、关键动画清单、流式优化 |
| §11 响应式与无障碍 | L1687-1733 | 断点策略、a11y 清单、快捷键全表 |
| §12 性能优化 | L1736-1777 | 渲染/数据/包体积优化、性能基线 |
| §13 开发路线图 | L1780-1930 | F0-F9 阶段映射与详细任务 |
| §14 附录 | L1934-1997 | AG-UI 事件映射速查、WS 事件映射、文件清单 |

---

## 6. 当前代码关键文件

### 后端（apps/agent-server/）

| 文件 | 说明 |
|------|------|
| `src/core/agent/pi-agui-agent.ts` | AG-UI Agent 核心：run/steer/follow-up + abort 契约 + 互斥 |
| `src/core/agent/session-store.ts` | Session 存储：getOrCreate 竞态修复 + tryAcquireRun/releaseRun |
| `src/routes/agui.route.ts` | AG-UI SSE 路由 + 心跳 + steer/follow-up |
| `src/routes/gate.route.ts` | 权限模式 GET/PUT API |
| `src/__tests__/s3-1-agui-contract.test.ts` | 25 个 AG-UI 契约测试 |
| `src/__tests__/session-store.test.ts` | 6 个 session-store 测试 |

### 前端（apps/desktop/）

| 文件 | 说明 |
|------|------|
| `src/renderer/src/api/agui-client.ts` | AG-UI SSE 客户端（runAgent + parseSseStream） |
| `src/renderer/src/hooks/use-streaming-run.ts` | 流式 run 状态机 hook |
| `src/renderer/src/hooks/use-websocket.ts` | WebSocket 客户端 hook |
| `src/renderer/src/hooks/use-tool-executions.ts` | 工具执行状态机 hook |
| `src/renderer/src/components/chat/chat-workspace.tsx` | 主工作台（集成所有组件） |
| `src/renderer/src/components/chat/message-stream.tsx` | 消息流 + applyEvent reducer |
| `src/renderer/src/components/chat/message-bubble.tsx` | 消息气泡（react-markdown） |
| `src/renderer/src/components/chat/input-area.tsx` | 输入区（发送/中断切换） |
| `src/renderer/src/components/chat/types.ts` | ChatMessage/ToolCallInfo/ThinkingBlock 类型 |
| `src/renderer/src/components/chat/thinking-block.tsx` | 可折叠思考块 |
| `src/renderer/src/components/chat/tool-call-card.tsx` | 工具调用卡片 |
| `src/renderer/src/components/chat/streaming-indicator.tsx` | 流式占位指示器 |
| `src/renderer/src/components/chat/error-card.tsx` | 错误卡片 |
| `src/renderer/src/components/chat/empty-state.tsx` | 空状态引导 |
| `src/renderer/src/components/chat/confirmation-dialog.tsx` | 确认对话框 |
| `src/renderer/src/components/chat/permission-mode-switch.tsx` | 权限模式切换器 |
| `src/renderer/src/components/chat/tool-card.tsx` | 工具卡片列表 |
| `src/renderer/src/components/settings/provider-bootstrap.tsx` | Provider 设置 |

---

## 7. AG-UI 协议关键约定

### 事件顺序（ARCHITECTURE.md L912-920）

```
RUN_STARTED → MESSAGES_SNAPSHOT → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT (×N) → TEXT_MESSAGE_END
→ STEP_STARTED → TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END → STEP_FINISHED
→ TEXT_MESSAGE_START → ... → RUN_FINISHED
```

### Abort 契约

- abort 时后端发射 `RUN_FINISHED`（reason='aborted'），**不是** `RUN_ERROR`
- `RUN_FINISHED` 和 `RUN_ERROR` 互斥：一次 streamRun 恰好发射一个终止事件

### 同线程 Run 互斥

- `tryAcquireRun(threadId, runId)` 占用 activeRunId
- 并发 run 返回 `RUN_ERROR`（code: RUN_ALREADY_IN_PROGRESS）

### SSE 心跳

- 每 15s 发送 `: keepalive\n\n` SSE 注释

---

## 8. 前端状态管理现状与规划

### 现状（S3-2 完成后）

当前使用 React `useState` 管理 MessageStreamState，尚未引入 Zustand。

### 规划（FRONTEND_DEVELOPMENT.md L1169-1254）

需要迁移到 Zustand 的 Store：
- **sessionStore**（L1171-1205）：currentSessionId、isRunning、messages、streamingMessage、permissionMode、steerQueue
- **uiStore**（L1207-1241）：面板布局、主题、浮层状态、通知、确认队列
- **connectionStore**（L1243-1254）：serverStatus、wsStatus、sseStatus

---

## 9. v1.0 范围与延期项

### 保留在 v1.0（v1-development-sequence-review.md L238-249）

- 单 Agent 日常使用桌面体验
- Provider/API Key 设置
- 流式聊天
- 工具卡和确认
- 会话持久化
- Compaction
- 基本记忆
- 用量可见性
- 最小通知

### 延期到 v1.1+（v1-development-sequence-review.md L251-257）

- 插件系统
- 多 Agent/subagent 协作 UI
- Cron 自动化
- 完整 i18n（超出中文优先脚手架）
- 高级每工具可视化打磨

---

## 10. 验证命令

```bash
# 后端测试
pnpm --filter agent-server test

# 后端 typecheck
pnpm --filter agent-server exec tsc --noEmit

# 前端 typecheck
cd apps/desktop && npx tsc --noEmit -p tsconfig.web.json --composite false
cd apps/desktop && npx tsc --noEmit -p tsconfig.node.json --composite false

# 前端测试
cd apps/desktop && npx vitest run --environment jsdom

# 启动开发
pnpm --filter agent-server dev    # 后端 :3900
cd apps/desktop && pnpm dev       # Electron 桌面
```
