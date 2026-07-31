# Chat 模块完整改进方案

> 创建时间：2026-07-27
> 目标：将 pi-agent 的 Chat 模块对齐 AionUi 的视觉风格、交互密度与功能完整度
> 范围：仅 Chat 部分；Novel 部分保持不动
> 技术栈：维持现有 shadcn/ui + Tailwind + radix-ui，不引入 ArcoDesign

---

## 0. 决策记录

| 决策项 | 选择 | 说明 |
|---|---|---|
| 主题切换 | 暂缓 | 需大量考核后再做；Stage 1 已落地语义 Token 作为前置 |
| Novel 分栏拖动组件 | 不动 | 当前实现已合理完善 |
| Chat 改造范围 | 全量对齐 AionUi | 视觉、布局、交互、设置均参考 AionUi |
| 组件库 | 不引入 ArcoDesign | 维持 shadcn/ui + radix-ui |
| 会话搜索 | 先做分页，不做搜索 | Stage 1.4 后端搜索 API 暂缓，后续视需求再评估 |
| 执行节奏 | 分阶段执行，每阶段 review | 用户明确要求分阶段确认 |

---

## 1. 总体阶段划分

| 阶段 | 名称 | 状态 | 核心产出 |
|---|---|---|---|
| Stage 0 | 语义 Token 系统 | ✅ 已完成 | main.css 中 AionUi 风格语义 Token |
| Stage 2.5 | AionUi 风格对齐（初版） | ✅ 已完成 | 消息气泡、输入区、Header 玻璃效果 |
| Stage 3.3 | 标题内联重命名 | ✅ 已完成 | ChatTitleEditor + 双击重命名 |
| Stage 1 | 基础设施准备 | 🚧 进行中 | 依赖、分页 API、http-client 方法 |
| Stage 2 | 消息流编排与视觉 | ⏳ 待做 | 消息合并、工具调用卡、思考块、流式指示器 |
| Stage 3 | Agent 身份系统完整化 | ⏳ 待做 | PresetAssistant 体系、Agent 切换器、详情卡 |
| Stage 4 | 设置页对齐 AionUi | ⏳ 待做 | settings-page 重写、Provider/Model 配置升级 |
| Stage 5 | 会话管理增强 | ⏳ 待做 | 消息分页加载、置顶拖拽排序 |
| Stage 6 | 交互密度补强 | ⏳ 待做 | CommandPalette、快捷键、通知系统 |

---

## 2. 已完成阶段回顾

### Stage 0：语义 Token 系统 ✅

- 在 `apps/desktop/src/renderer/src/assets/main.css` 引入 AionUi 风格语义 Token
- 显式在 `.dark` block 重申映射
- 未修改既有色彩变量，仅做增量补充

### Stage 2.5：AionUi 风格对齐（初版）✅

**消息气泡**（[message-bubble.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/message-bubble.tsx)）：
- 移除 AI avatar 与 "Craft" 名称
- 用户气泡：浅灰背景 + 非对称圆角 `[border-radius:8px_0_8px_8px]`
- 内联 CopyButton：hover 显示，复制后切换 Check icon 2 秒
- 固定 hover 行高度，避免布局抖动

**输入区**（[input-area.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/input-area.tsx)）：
- 圆角、边框、focus 状态、背景与过渡

**Header**：
- 玻璃效果 `backdrop-filter` + 渐变阴影

**消息流间距**（[message-stream.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/message-stream.tsx)）：
- 容器内边距与消息间距调整

### Stage 3.3：标题内联重命名 ✅

- 新增 [chat-title-editor.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/chat-title-editor.tsx)
- 修改 [chat-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx) 替换静态 h1
- 修改 [session-list.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/session-list.tsx) 支持双击触发重命名
- 行为：双击激活、Enter 提交、Escape 取消、失焦自动提交

---

## 3. Stage 1：基础设施准备 🚧

### 1.1 补装 @dnd-kit 依赖 ✅

**已完成**：将 `@dnd-kit/core`、`@dnd-kit/utilities` 从 devDependencies 迁到 dependencies，并新增 `@dnd-kit/sortable@^8.0.0`。三个包已在 `apps/desktop/node_modules/@dnd-kit/` 下安装到位。`tsc --noEmit` 通过。

**修改文件**：[apps/desktop/package.json](file:///d:/WebWork/AI/pi-agent/apps/desktop/package.json)

### 1.2 SessionSummary 接口扩展 ⏸ 暂缓

暂缓原因：当前 SessionSummary 的 title/preview 由前端维护，扩展 `extra`/`agentId` 字段需要后端同步返回，依赖 Stage 1.3 的接口设计。等分页 API 落地后再回头扩展。

### 1.3 后端消息分页 API

**新增端点**：`GET /api/sessions/:threadId/messages`

**请求参数**（query）：
| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `before` | number | - | 游标：返回 `createdAt < before` 的消息；缺省时从最新开始 |
| `limit` | number | 30 | 单次返回上限（最大 100） |

**响应**：
```ts
interface PaginatedMessages {
  messages: SessionEntry[]
  nextCursor: number | null  // 下一页游标，null 表示已到顶部
  hasMore: boolean
}
```

**实现要点**：
1. 在 [session-health.ts](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/core/session/session-health.ts) 中提取 `readSessionEntries` 为独立导出函数（或新建 `session-reader.ts`）
2. 读取 `{dataDir}/agent/sessions/{threadId}.jsonl`（路径来源：[session.route.ts:48](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/routes/session.route.ts#L48)）
3. 按 `createdAt` 倒序，取 `before` 之前的 `limit` 条
4. 文件不存在返回空数组 + `hasMore: false`

**修改文件**：
- 新增 `apps/agent-server/src/core/session/session-reader.ts`
- 修改 `apps/agent-server/src/routes/session.route.ts` 注册新路由

### 1.4 后端搜索 API ❌ 取消

按用户决策 B（子方案：先做分页不做搜索），本阶段取消。后续如需搜索，再评估"前端本地搜索"或"后端全文搜索"二选一。

### 1.5 前端 http-client 补 getSessionMessages

**新增方法**（[http-client.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/api/http-client.ts)）：

```ts
export interface SessionMessageEntry {
  id?: string
  role?: string
  content?: unknown
  createdAt?: number
  stopReason?: string
  toolCallId?: string
  toolCalls?: Array<{ id?: string }>
  [key: string]: unknown
}

export interface PaginatedMessages {
  messages: SessionMessageEntry[]
  nextCursor: number | null
  hasMore: boolean
}

export async function getSessionMessages(
  threadId: string,
  options?: { before?: number; limit?: number }
): Promise<PaginatedMessages> {
  const params = new URLSearchParams()
  if (options?.before) params.set('before', String(options.before))
  if (options?.limit) params.set('limit', String(options.limit))
  const qs = params.toString()
  return getApi<PaginatedMessages>(
    `/api/sessions/${encodeURIComponent(threadId)}/messages${qs ? `?${qs}` : ''}`
  )
}
```

**不新增 `searchSessions`**（按 1.4 决策）。

### Stage 1 验证

- `bunx tsc --noEmit` 在 `apps/desktop` 与 `apps/agent-server` 均通过
- 启动后端，`curl "http://localhost:<port>/api/sessions/<threadId>/messages?limit=10"` 返回正确 JSON
- 文件不存在场景返回空数组

---

## 4. Stage 2：消息流编排与视觉 ⏳

### 2.1 消息合并编排

**目标**：连续的 tool_call 合并为 `tool_summary`，连续的文件操作合并为 `file_summary`，减少视觉噪声。

**新增组件**：
- `apps/desktop/src/renderer/src/components/chat/message-group.tsx`
  - 识别连续 tool 角色消息，合并为单个 Group 节点
  - 默认折叠，展开显示明细
- `apps/desktop/src/renderer/src/components/chat/tool-summary-card.tsx`
  - 折叠态：显示 "调用了 3 个工具" + 工具图标
  - 展开态：列出每个 tool_call 的名称、参数摘要、结果状态

**修改**：[message-stream.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/message-stream.tsx)
- 在渲染前用 `groupMessages(messages)` 预处理
- 保持消息顺序与时间轴

### 2.2 工具调用卡片视觉

**修改**：[tool-call-card.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/tool-call-card.tsx)
- 借鉴 AionUi：左侧色条标识工具类型（read=蓝、write=橙、bash=绿、search=紫）
- 折叠/展开动画使用 framer-motion
- 工具名 + 关键参数预览 + 耗时
- 失败状态用 destructive 色调

### 2.3 思考块

**修改**：[thinking-block.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/thinking-block.tsx)
- 默认折叠，可点击展开
- 折叠态显示首行摘要 + "展开"
- 展开态用等宽字体显示完整推理
- 加上耗时标识

### 2.4 流式指示器优化

**修改**：[streaming-indicator.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/streaming-indicator.tsx)
- 已完成：步骤驱动（思考中、调用工具、生成回复）
- 待做：
  - 当前步骤的高亮 + 进度条
  - 取消按钮（点击停止流式）
  - 步骤耗时记录

### 2.5 消息 hover 工具栏（轻量）

AionUi 风格的轻量 hover 工具栏，集成在消息气泡上：
- 复制（已有）
- 重新生成（仅 assistant 消息）
- 引用（插入到输入框）
- 删除（仅自己消息）

**新增**：`apps/desktop/src/renderer/src/components/chat/message-hover-actions.tsx`

---

## 5. Stage 3：Agent 身份系统完整化 ⏳

### 3.1 已完成部分

- [agent-logo-icon.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/agent-logo-icon.tsx)：emoji 或首字母 + 基于 ID hash 的稳定背景色
- [use-active-agent.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/hooks/use-active-agent.ts)：合并后端 AgentInfo 与内置预设
- 集成到 chat-workspace Header

### 3.2 PresetAssistant 配置体系

**新增**：`apps/desktop/src/renderer/src/config/preset-assistants.ts`
- 内置预设列表（写作助手、代码助手、研究助手等）
- 每个预设包含：id、name、emoji、description、defaultModel、systemPrompt 模板
- 与后端 `AgentInfo` 解耦，前端可独立扩展

### 3.3 Agent 切换器

**新增**：`apps/desktop/src/renderer/src/components/chat/agent-switcher.tsx`
- Header 中 AgentLogoIcon 点击触发
- 下拉显示所有可用 Agent（内置预设 + 后端注册）
- 分组：内置、自定义、插件
- 选中后切换 `activeAgentId`

### 3.4 Agent 详情卡片

**新增**：`apps/desktop/src/renderer/src/components/chat/agent-detail-card.tsx`
- Hover AgentLogoIcon 时显示气泡卡片
- 内容：name、description、当前模型、工具列表、最近对话数
- 借鉴 AionUi 的气泡卡片样式

---

## 6. Stage 4：设置页对齐 AionUi ⏳

### 4.1 settings-page 重写

**修改**：[settings-page.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/settings/settings-page.tsx)
- 借鉴 AionUi 的左侧 Tab + 右侧内容布局
- Tab 分组：通用、外观、Agent、模型、Provider、技能、安全、关于
- 每个 Tab 独立组件，懒加载

### 4.2 AssistantSettings 抽象

**新增**：`apps/desktop/src/renderer/src/components/settings/assistant-settings.tsx`
- 管理内置预设 + 自定义 Agent
- 字段：name、emoji、description、systemPrompt、defaultModel、tools
- CRUD 操作对接 `/api/agents`

### 4.3 SkillsSettings 抽象

**新增**：`apps/desktop/src/renderer/src/components/settings/skills-settings.tsx`
- 管理插件 Agent（来自 plugin-loader）
- 显示插件提供的 Agent 列表
- 启用/禁用开关

### 4.4 Provider/Model 配置升级

**修改**：[provider-manager.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/settings/provider-manager.tsx)
- 借鉴 AionUi 的卡片式 Provider 配置
- 每个 Provider 一张卡：logo、状态、模型列表、API Key 输入
- 支持自动检测可用模型（调用 `/api/providers/:id/models`）

### 4.5 通用设置优化

**修改**：[general-settings.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/settings/general-settings.tsx)
- 语言、字体大小、会话保留策略、数据目录
- 借鉴 AionUi 的分组卡片布局

---

## 7. Stage 5：会话管理增强 ⏳

### 5.1 消息分页加载

**修改**：[message-stream.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/message-stream.tsx)
- 滚动到顶部时触发加载更多
- 调用 `getSessionMessages(threadId, { before: cursor, limit: 30 })`
- 加载中显示骨架屏，加载完毕无感插入
- 维护 `hasMore` 状态，避免越界请求

**新增 Hook**：`apps/desktop/src/renderer/src/hooks/use-paginated-messages.ts`
- 管理 messages 数组、cursor、hasMore、loading 状态
- 提供 `loadMore()` 方法
- 与 session-store 协同：新消息追加到末尾，历史消息前插到头部

### 5.2 置顶会话拖拽排序

**修改**：[session-list.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/chat/session-list.tsx)
- 新增"置顶"分组（依赖 Stage 1.2 的 `extra.pinned` 字段）
- 置顶分组内的会话支持拖拽排序
- 使用 `@dnd-kit/sortable` 的 `SortableContext` + `useSortable`
- 排序结果持久化到 localStorage（暂不入后端）

**新增 Hook**：`apps/desktop/src/renderer/src/hooks/use-pinned-sessions.ts`
- 管理置顶列表与排序
- 提供 `togglePin(id)`、`reorderPinned(ids)`

### 5.3 会话搜索（暂缓）

按 Stage 1.4 决策，搜索功能整体暂缓。后续如需启用，最小成本方案：
- 前端拉取所有 SessionSummary
- 按 title + preview 本地过滤
- 不依赖后端 API

---

## 8. Stage 6：交互密度补强 ⏳

### 6.1 CommandPalette 增强

**修改**：[command-palette.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/overlays/command-palette.tsx)
- 新增命令：新建会话、切换 Agent、搜索会话、打开设置
- 借鉴 AionUi 的分组命令列表
- 快捷键 `Cmd/Ctrl + K`

### 6.2 快捷键体系

**新增**：`apps/desktop/src/renderer/src/hooks/use-chat-shortcuts.ts`
- `Cmd/Ctrl + N`：新建会话
- `Cmd/Ctrl + K`：打开命令面板
- `Cmd/Ctrl + /`：聚焦输入框
- `Cmd/Ctrl + Shift + S`：搜索会话
- `Esc`：关闭弹层 / 退出编辑

### 6.3 通知系统

**修改**：[toaster.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/ui/toaster.tsx)
- 借鉴 AionUi 的 toast 样式
- 操作反馈：复制成功、设置已保存、会话已删除等
- 堆叠展示 + 自动消失

---

## 9. 文件清单总览

### 9.1 已修改文件

| 文件 | 涉及阶段 |
|---|---|
| `apps/desktop/package.json` | Stage 1.1 |
| `apps/desktop/src/renderer/src/assets/main.css` | Stage 0 |
| `apps/desktop/src/renderer/src/components/chat/message-bubble.tsx` | Stage 2.5 |
| `apps/desktop/src/renderer/src/components/chat/input-area.tsx` | Stage 2.5 |
| `apps/desktop/src/renderer/src/components/chat/message-stream.tsx` | Stage 2.5, 5.1 |
| `apps/desktop/src/renderer/src/components/chat/chat-workspace.tsx` | Stage 3.3 |
| `apps/desktop/src/renderer/src/components/chat/session-list.tsx` | Stage 3.3, 5.2 |

### 9.2 已新增文件

| 文件 | 涉及阶段 |
|---|---|
| `apps/desktop/src/renderer/src/components/chat/agent-logo-icon.tsx` | Stage 3 |
| `apps/desktop/src/renderer/src/components/chat/chat-title-editor.tsx` | Stage 3.3 |
| `apps/desktop/src/renderer/src/hooks/use-active-agent.ts` | Stage 3 |

### 9.3 待新增文件

| 文件 | 涉及阶段 |
|---|---|
| `apps/agent-server/src/core/session/session-reader.ts` | Stage 1.3 |
| `apps/desktop/src/renderer/src/components/chat/message-group.tsx` | Stage 2.1 |
| `apps/desktop/src/renderer/src/components/chat/tool-summary-card.tsx` | Stage 2.1 |
| `apps/desktop/src/renderer/src/components/chat/message-hover-actions.tsx` | Stage 2.5 |
| `apps/desktop/src/renderer/src/config/preset-assistants.ts` | Stage 3.2 |
| `apps/desktop/src/renderer/src/components/chat/agent-switcher.tsx` | Stage 3.3 |
| `apps/desktop/src/renderer/src/components/chat/agent-detail-card.tsx` | Stage 3.4 |
| `apps/desktop/src/renderer/src/components/settings/assistant-settings.tsx` | Stage 4.2 |
| `apps/desktop/src/renderer/src/components/settings/skills-settings.tsx` | Stage 4.3 |
| `apps/desktop/src/renderer/src/hooks/use-paginated-messages.ts` | Stage 5.1 |
| `apps/desktop/src/renderer/src/hooks/use-pinned-sessions.ts` | Stage 5.2 |
| `apps/desktop/src/renderer/src/hooks/use-chat-shortcuts.ts` | Stage 6.2 |

---

## 10. 验收标准

### Stage 1 验收
- [ ] `bunx tsc --noEmit` 在 desktop 与 agent-server 均通过
- [ ] `curl GET /api/sessions/:threadId/messages?limit=10` 返回 PaginatedMessages
- [ ] 文件不存在的 threadId 返回空数组 + hasMore:false
- [ ] http-client.getSessionMessages 类型导出正确

### Stage 2 验收
- [ ] 连续 tool_call 合并为可展开的 summary 卡片
- [ ] 工具调用卡有类型色条 + 折叠动画
- [ ] 思考块默认折叠，可展开
- [ ] 流式指示器显示当前步骤 + 取消按钮

### Stage 3 验收
- [ ] Agent 切换器可切换 activeAgentId
- [ ] 切换后 Header 立即更新 logo + name
- [ ] Hover logo 显示详情卡片
- [ ] 内置预设与后端 Agent 都出现在切换器中

### Stage 4 验收
- [ ] 设置页左侧 Tab + 右侧内容布局
- [ ] AssistantSettings 可 CRUD Agent
- [ ] SkillsSettings 可启用/禁用插件 Agent
- [ ] Provider 卡片式布局 + 自动检测模型

### Stage 5 验收
- [ ] 滚动到顶部自动加载历史消息
- [ ] 加载过程无视觉抖动
- [ ] 置顶会话分组显示
- [ ] 置顶分组内可拖拽排序，结果持久化

### Stage 6 验收
- [ ] Cmd/Ctrl+K 打开命令面板
- [ ] 快捷键全部生效
- [ ] 操作反馈 toast 正常显示

---

## 11. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 后端 JSONL 读取性能 | 大文件会话加载慢 | 限制 limit 上限 100，流式读取 |
| 消息合并破坏现有交互 | 用户可能依赖原始顺序 | 保留时间轴，仅视觉合并 |
| Agent 切换影响会话上下文 | 切换后历史消息可能错位 | 切换时清空当前 session，新会话用新 agentId |
| 拖拽排序与虚拟列表冲突 | 排序后位置错乱 | 置顶分组单独脱离虚拟列表，用普通列表渲染 |
| 设置页重写破坏既有配置 | 用户配置丢失 | 保留 localStorage 兼容层，新结构 fallback 旧字段 |

回滚策略：每个 Stage 独立 commit，发现问题直接 revert 对应 commit。

---

## 12. 下一步执行计划

按用户决策，立即执行：
1. **Stage 1.3**：新增 `session-reader.ts` + 注册 `/api/sessions/:threadId/messages` 路由
2. **Stage 1.5**：http-client 补 `getSessionMessages` 方法
3. **Stage 1 验证**：tsc + curl 测试

Stage 1.2（SessionSummary 扩展）暂缓，等 Stage 1.3 落地后再回头评估。
