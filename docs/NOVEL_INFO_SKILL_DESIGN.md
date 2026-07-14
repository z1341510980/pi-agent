# 小说信息查询能力设计方案

## 1. 背景与问题

当前 create-flow / discussion-flow 里的 Agent 主要依赖 SEMI 层一次性注入的 `chapterContext` 获取故事信息。这带来两个限制：

1. **上下文有边界**：SEMI 层虽然包含角色、冲突、伏笔、势力、地点等快照，但 Agent 在生成过程中若想追问某个细节（如"角色 A 在第 3 章时的状态是什么"、"伏笔 B 是否已经回收"），无法主动获取。
2. **工具实际被禁用**：`novel-tools.ts` 已经定义了 `novel_query_state`、`novel_query_factions`、`novel_query_locations` 等查询工具，并注册到 Pi Session 的 `customTools`；但 `novel-agents.ts` 中 Director/Writer/Reviewer/Reviser 的 `tools: []` 会触发 `pi-session.ts` 的工具白名单过滤，把这些查询工具全部清空。

因此，"让 Agent 方便调用它想要的信息"需要同时解决：
- **工具可用**：把查询工具重新交还给需要的 Agent。
- **接口友好**：原始 `novel_query_state` 要求 Agent 知道 `queryType`（characters/relationships/...），不够自然；可以补充一个语义化查询工具/Skill，让 Agent 用自然语言提问。

## 2. 现状盘点

| 组件 | 状态 | 说明 |
|------|------|------|
| `novel-tools.ts` | 已存在 | 提供 `novel_query_state` 等 19 个工具，已排序以优化 prompt cache |
| `context.registerSessionTools` | 已注册 | 在 `novel-plugin/index.ts` 第 178 行注入 Pi Session customTools |
| `pi-session.ts` 工具过滤 | 生效 | 按 `AgentConfig.tools` 白名单过滤；`tools: []` 会清空全部 customTools |
| `novel-agents.ts` | 查询工具被清空 | Director/Writer/Reviewer/Reviser 的 `tools: []`；仅 Memory Agent 有完整工具 |
| MCP/Skill 集成 | 未接入 | 项目代码中无 `mcp` 或 `ModelContextProtocol` 相关实现 |

## 3. 可选方案

### 方案 A：恢复 Pi SDK 查询工具权限（最小改动）

把 `novel_query_state`（只读）重新开放给需要查资料的 Agent：

| Agent | 允许工具 | 理由 |
|-------|----------|------|
| Director | `novel_query_state` | 规划前可能想补充确认当前故事状态 |
| Writer | `novel_query_state` | 写作中想确认角色/伏笔/冲突细节 |
| Reviewer | `novel_query_state` | 审稿中想核对一致性 |
| Reviser | `novel_query_state` | 修订时想确认上下文 |
| Memory | 保持现有写工具 + 查询工具 | 状态更新前后需要读旧状态 |

**实现**：修改 `novel-agents.ts` 中对应 Agent 的 `tools` 数组。

**优点**：
- 无新增依赖，无新增架构。
- 直接复用 `novel-tools.ts` 已实现的查询能力。
- 工具结果以 tool message 追加到对话末尾，不破坏 SEMI 层缓存前缀。

**缺点**：
- Agent 仍需理解 `queryType` 枚举，不够自然。
- 如果 Agent 滥用工具，会增加 LLM 调用次数和 token。

### 方案 B：新增语义化查询工具 `novel_ask_story`

在 `novel-tools.ts` 中新增一个工具：

```ts
name: 'novel_ask_story'
parameters: {
  projectId: string
  question: string  // 自然语言问题，例如："主角当前的目标是什么？"
}
```

内部实现：
1. 用一个小型 LLM（或规则解析器）解析问题意图。
2. 调用 `NovelStore` 的相关查询方法。
3. 返回精简后的自然语言答案。

**优点**：
- Agent 可以用自然语言提问，门槛低。
- 返回结果已经过整理，避免直接 dump JSON。

**缺点**：
- 每次查询增加一次 LLM 调用（意图解析）。
- 需要额外维护意图解析 prompt。

### 方案 C：小说信息 MCP 服务器

独立实现一个 MCP Server，暴露如下工具：

```ts
// 查询类
novel_query_state
novel_query_factions
novel_query_locations
novel_query_character_detail
novel_query_plot_summary

// 写类（可选）
novel_update_character
novel_update_foreshadow
...
```

然后在 Pi SDK 层接入 MCP Client，把 MCP 工具动态转换为 Pi SDK 的 `ToolDefinition`。

**优点**：
- 标准化，可与其他 MCP 兼容的 Agent/IDE 集成。
- 查询逻辑与主进程解耦，可独立部署/扩展。

**缺点**：
- 需要引入 `@modelcontextprotocol/sdk` 等依赖。
- 需要实现 MCP Client 适配层（Pi SDK 当前不原生支持 MCP）。
- 工作量大，短期内不适合作为第一选择。

### 方案 D：WorkBuddy Skill（小说创作助手）

把小说信息查询封装为一个 WorkBuddy Skill：

- Skill 名：`novel-info-assistant`
- 入口：通过自然语言提问，返回故事信息。
- 能力：
  - 查询角色、冲突、伏笔、势力、地点、世界规则。
  - 按章节查询历史状态。
  - 检查伏笔回收状态。
  - 检索风格指南。

Agent 通过调用 Skill 的函数接口获取信息。

**优点**：
- 与 WorkBuddy 生态一致。
- 可复用 Skill 的权限/生命周期管理。

**缺点**：
- 当前 Agent 调用 Skill 需要额外集成机制（Skill 调用协议）。
- 不如直接 Pi SDK 工具原生。

## 4. 推荐方案

**推荐：方案 A + 方案 B 组合**

1. **第一阶段**：先恢复 `novel_query_state` 给 Director/Writer/Reviewer/Reviser（方案 A）。这是收益最大、改动最小的修复，能让 Agent 立即获得查询能力。
2. **第二阶段**：在 `novel_query_state` 可用之后，补充 `novel_ask_story` 语义查询工具（方案 B），进一步降低 Agent 使用门槛。

**不推荐当前直接上 MCP/Skill 的原因**：
- 项目内无 MCP 基础设施，需要额外架构工作。
- WorkBuddy Skill 与当前 Pi SDK Agent 的集成路径不明确，容易变成"为了 Skill 而 Skill"。
- 现有 `novel-tools.ts` 已经覆盖了 80% 需求，优先让已有工具真正可用。

## 5. 实施步骤（若确认执行）

### 5.1 恢复查询工具权限

修改 `apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts`：

```ts
director: {
  ...
  tools: ['novel_query_state', 'novel_query_factions', 'novel_query_locations'],
  ...
},
writer: {
  ...
  tools: ['novel_query_state'],
  ...
},
reviewer: {
  ...
  tools: ['novel_query_state'],
  ...
},
reviser: {
  ...
  tools: ['novel_query_state'],
  ...
},
```

同时给 `novel_query_state` 的 description 增加引导语，明确「当你需要确认故事状态细节时调用」。

### 5.2 优化查询工具返回格式

`novel_query_state` 当前返回 JSON 字符串。可以在返回前做：
- 截断：如果结果过长，只返回关键字段（名称/状态/阶段）。
- 摘要：对 `all` 查询做按类型汇总，避免直接 dump 全表。

### 5.3 新增 `novel_ask_story`（可选第二阶段）

在 `novel-tools.ts` 新增：

```ts
const AskStoryParams = Type.Object({
  projectId: Type.String(),
  question: Type.String({ description: '自然语言问题，例如：主角现在的目标是什么？' }),
})

export function createNovelAskStoryTool(store: NovelStore): ToolDefinition {
  return defineTool({
    name: 'novel_ask_story',
    label: '询问小说故事信息',
    description: '用自然语言提问，获取当前项目的角色、冲突、伏笔、势力、地点、风格等信息。',
    parameters: AskStoryParams,
    async execute(toolCallId, params) {
      // 意图解析 + 数据查询 + 答案生成
    },
  })
}
```

实现方式有两种：
- **轻量版**：规则匹配关键词（角色/冲突/伏笔/...），直接调用对应 store 方法，返回自然语言摘要。
- **LLM 版**：把问题 + 项目数据摘要交给一个小模型生成答案。

建议先做轻量版，避免额外 LLM 开销。

### 5.4 验证

- 类型检查：`pnpm --filter agent-server exec tsc --noEmit`
- 运行 create-flow / create-discussion，观察 Agent 是否会调用 `novel_query_state`。
- 检查工具调用是否正确返回，不会导致 messages 历史不一致（400 错误）。

## 6. 风险与收益

| 风险 | 缓解 |
|------|------|
| Agent 滥用工具，反复查询导致 token 激增 | 只开放只读工具；在工具描述中强调"仅当需要确认细节时调用" |
| 工具返回数据过大，撑爆上下文 | 对 `novel_query_state` 增加摘要/截断；`all` 查询返回汇总而非全量 |
| 工具调用导致 messages 不一致（400） | 沿用现有独立 SessionManager 机制（plugin 线程隔离），确保 tool 消息不跨 Agent 泄漏 |

| 收益 | 说明 |
|------|------|
| Agent 获得主动查询能力 | 不再完全依赖 SEMI 层快照 |
| 减少幻觉 | 写作/审稿时可直接查状态，减少记忆偏差 |
| 为更智能的查询工具打基础 | `novel_ask_story` 可在此之上扩展 |

## 7. 决策建议

建议按以下顺序推进：

1. **立即执行**：修复方案 A（恢复 `novel_query_state` 给 Director/Writer/Reviewer/Reviser）。
2. **观察效果**：跑几章 create-flow / create-discussion，看 Agent 是否主动使用、是否有滥用。
3. **按需升级**：如果 `queryType` 枚举对 Agent 不够友好，再实现 `novel_ask_story`（方案 B）。
4. **长期考虑**：如果未来需要把小说能力开放给外部 Agent/IDE，再评估 MCP 服务器（方案 C）。
