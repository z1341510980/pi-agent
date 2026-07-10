# 小说右栏对话模式改造设计

> 日期：2026-07-10
> 状态：设计完成，待审查

## 背景与目标

当前小说模块的编排流程、创作流程、反推流程、团队流程（群聊）四个流程的 UI 展示方式不统一：
- 编排/群聊：右栏 `ChapterLivePanel`（创作时间线 + 章节内容 + 检查点）
- 反推：仅 Toast 通知，无实时面板
- AI编排：入口被隐藏

用户希望将这四个流程统一为**对话工作台的对话模式**——用消息气泡流替换当前的创作时间线，放在小说右栏。

## 设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 核心方案 | 方案A：复用 chat 组件，适配 novel 上下文 | 视觉一致、组件复用、维护成本低 |
| 流程范围 | 全部四流程（编排/群聊/反推/AI编排） | 统一体验 |
| 消息粒度 | 每个 Agent 输出 = 1 条消息 | 与当前时间线粒度一致 |
| 检查点 | 作为特殊消息卡片 | 决策记录在对话流中 |
| 章节正文 | 保留在主内容区 ChapterContentEditor | 已有编辑/反推功能，不重复 |
| 组件结构 | 提取通用组件到 shared/conversation/ | chat 和 novel 共用 |

## 架构设计

### 组件结构

```
components/shared/conversation/
├── conversation-stream.tsx     # 消息流（从 message-stream.tsx 提取）
├── message-bubble.tsx          # 消息气泡（从 message-bubble.tsx 提取）
├── conversation-input.tsx      # 输入区（从 input-area.tsx 提取，简化）
├── checkpoint-message.tsx      # 检查点消息卡片（新增）
├── system-message.tsx          # 系统消息（新增）
└── types.ts                    # 统一消息类型

components/novel/
└── novel-conversation-panel.tsx  # novel 右栏对话面板（替换 ChapterLivePanel）
```

### 统一消息类型

```typescript
// components/shared/conversation/types.ts

interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'checkpoint'
  // assistant: Agent 消息
  agentName?: string
  agentType?: NovelAgentType  // director/writer/reviewer/reviser/memory/arranger/extractor/moderator
  // 内容
  content: string
  streamingBuffer?: string      // 流式缓冲
  status: 'complete' | 'streaming' | 'error'
  timestamp: number
  // checkpoint 专用
  checkpointType?: 'narrative' | 'review'
  checkpointOptions?: Array<{ label: string; action: string }>
  checkpointResolved?: string   // 用户已选的决策
  // system 专用
  systemAction?: Array<{ label: string; action: string }>
}
```

### 数据流映射

novel 创作流程状态 → 对话消息映射规则（在 `novel-conversation-panel.tsx` 内用 `useMemo`）：

| 源数据 | 映射为 | 说明 |
|---|---|---|
| `AgentOutput` | assistant 消息 | agentName + agentType 颜色 + 流式内容 |
| 用户输入 (`userMessages`) | user 消息 | 右对齐主色气泡 |
| `checkpoint_narrative` | checkpoint 消息 | 内嵌 [确认/重写/取消] 按钮 |
| `checkpoint_review` | checkpoint 消息 | 内嵌 [通过/修订/重写] 按钮 |
| 反推进度（SSE progress） | system 消息 | "正在提取角色实体..." 等 |
| 流程完成 | system 消息 + 操作 | [保存到章节] [丢弃] |

合并排序规则：按 timestamp 升序合并 agentOutputs + userMessages + checkpoints。

### 右栏状态切换

修改 `novel-workspace.tsx` 右栏切换逻辑：

```
isConversationActive（任一流程运行中或已有对话记录）→ NovelConversationPanel
scanPhase !== 'idle'                                → SimilarityScanPanel
默认                                                → NovelDetailPanel
```

## 四流程统一入口

### 右栏对话面板布局

```
┌─────────────────────────────────┐
│ [编排] [群聊] [反推] [AI编排]    │  ← 流程 Tab
├─────────────────────────────────┤
│ 第 5 章 · 等待开始              │  ← 状态栏
├─────────────────────────────────┤
│        MessageStream            │
│  ...消息气泡...                 │
├─────────────────────────────────┤
│ [输入补充意见...] [开始/停止]   │  ← InputArea
└─────────────────────────────────┘
```

### 各流程交互差异

| 流程 | 触发方式 | 输入框作用 | 消息流内容 |
|---|---|---|---|
| 编排 | 选 Tab + 点"开始" | 创作中补充意见 | 导演→检查点→作者→审稿→检查点→修订→记忆 |
| 群聊 | 选 Tab + 点"开始" | 创作中补充意见 | 主持人调度多 Agent 讨论 |
| 反推 | 选 Tab + 点"开始" | 禁用（单次操作） | 提取器 Agent 进度消息 |
| AI编排 | 选 Tab + 点"开始" | 禁用（自动编排） | arranger Agent 编排步骤 |

### Header 变化

移除 header 中的：
- 编排/群聊切换按钮组（移到右栏 Tab）
- "生成第N章"按钮（移到右栏"开始"按钮）

## Agent 颜色与视觉规范

### Agent 颜色映射

| Agent | 头像色 | 气泡边框色 | Badge 文案 |
|---|---|---|---|
| director（导演） | 蓝色 #3b82f6 | rgba(59,130,246,0.3) | 导演 |
| writer（写作） | 绿色 #22c55e | rgba(34,197,94,0.3) | 写作 |
| reviewer（审稿） | 橙色 #f97316 | rgba(249,115,22,0.3) | 审稿 |
| reviser（修订） | 紫色 #a855f7 | rgba(168,85,247,0.3) | 修订 |
| memory（记忆） | 灰色 #6b7280 | rgba(107,114,128,0.3) | 记忆 |
| arranger（编排） | 青色 #06b6d4 | rgba(6,182,212,0.3) | 编排 |
| extractor（反推） | 琥珀色 #f59e0b | rgba(245,158,11,0.3) | 反推 |
| moderator（主持人） | 玫红 #ec4899 | rgba(236,72,153,0.3) | 主持人 |

### 气泡布局

- **用户消息**：右对齐，主色背景，白字
- **Agent 消息**：左对齐，头像 + 名称 + Badge + 气泡（浅灰背景）
- **检查点消息**：居中，卡片样式（黄色边框警示色）
- **系统消息**：居中，灰色小字 + 操作按钮

### 流式指示

Agent 消息流式时，名称旁显示 `animate-pulse` 圆点 + "正在生成..."文案。

## 与现有功能的兼容性

### 保留不动的功能

1. **`ChapterContentEditor`（主内容区上半部分）**：章节正文仍在这里展示和编辑，流式写作时通过现有机制同步更新。反推按钮也保留在这里（输入是正文）。
2. **`NovelDetailPanel`（右栏默认态）**：非创作时右栏仍显示节点详情。
3. **`CreationProgressOverlay`（画布视图浮层）**：画布视图仍用浮层显示进度。
4. **`AgentLogPanel`（Dialog 弹窗）**：日志面板作为诊断工具保留，与对话面板并存。

### 需要修改的代码

1. **`novel-workspace.tsx`**：
   - 右栏切换逻辑增加 `isConversationActive` 判断
   - 移除 header 中的编排/群聊切换按钮和"生成第N章"按钮
   
2. **`use-novel-creation-flow.ts`**：
   - `agentOutputs` 数据结构不变，渲染方改为 `MessageBubble`
   - 新增 `reverseArrange` 流程的状态管理（当前反推不在 creationFlow 内，需纳入）
   - checkpoint 数据结构不变，渲染方改为 `CheckpointMessage`

### 需要删除的代码

- `chapter-live-view.tsx` 中的 `AgentOutputCard`、`UserMessageBubble`、`CreationTimeline`
- `chapter-live-view.tsx` 中的检查点卡片
- header 中的编排/群聊切换按钮

## 实施步骤概述

1. 提取 chat 通用组件到 `shared/conversation/`
2. 实现 `ConversationMessage` 类型与映射逻辑
3. 实现 `NovelConversationPanel`（含 Tab 切换、消息流、输入区）
4. 实现 `CheckpointMessage` 和 `SystemMessage` 特殊消息
5. 修改 `novel-workspace.tsx` 右栏切换逻辑和 header
6. 将反推流程纳入 `use-novel-creation-flow.ts`
7. 删除 `chapter-live-view.tsx` 中被替代的代码
8. 类型检查与测试
