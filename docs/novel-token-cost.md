# 小说创作的 token 成本：诊断、修复与复测方法

> 记录时间：2026-08-01
> 这份文档记录的是一次**完整的实测诊断**：从「一章太贵」到定位出具体浪费源、改掉、量出降幅。
> 所有数字都来自真实项目「我在古代开咸货铺」的 agent 日志与 `usage_records`，不是估算。

---

## 0. 结论先行

一章创作的 token 里，**超过一半付给了与小说无关的东西** —— pi-coding-agent 的内置编码工具（bash/edit/read/write…）及其使用说明，被无条件塞进每一次 LLM 请求。

改法是按 threadId 前缀分流：`plugin:*` 会话不加载编码 agent 的那套底座。实测同一章降幅：

| Agent | 挂载工具数 | 工具 schema 字符 | 实发字符 |
|---|---|---|---|
| writer | 5 → **1** | 6,946 → **521** | 51,618 → **9,937**（−81%） |
| 文字编辑 | 4 → **0** | 2,953 → **0** | 21,847 → **6,733**（−69%） |
| 审稿 | 6 → **2** | 17,445 → **8,589** | 94,632 → **49,653**（−48%） |

业务工具（`novel_*`）不受影响：director 照常提交叙事任务、审稿照常提交结构化报告、writer 照常写出 3,884 字。

---

## 1. 为什么一开始查不出来

原来的 agent 日志只记三个长度：`systemPromptLength` / `userMessageLength` / `resultLength`。
用它们去解释 token 消耗，会得到荒谬的结果：

```
第 2 章 writer：systemPrompt 225 字符 + userMessage 26 字符 = 251 字符
                inputTokens = 36,528
```

**差 100 倍以上。** 中文 1 字符通常 ≤ 1 token，所以差额一定是"没被记录的内容"。

漏掉的有三块，缺一块都算不平：

1. **SEMI 层**（`chapterContext` = shared + identity + suffix）—— 一直存在 `novel_agent_logs.chapter_context` 列里，只是没在列表接口暴露长度
2. **LLM 往返次数** —— 一次「Agent 调用」在日志里是一行，实际可能是 2–4 次请求，每次重发完整历史
3. **真正发往 provider 的 payload** —— 包括 SDK 附加的系统提示词与工具定义

所以第一步不是优化，是**先能看见**。

---

## 2. 加了什么观测点

### 2.1 `PluginPayloadStats`（`core/plugin/plugin-types.ts`）

在 `PluginSessionOptions` 上加 `onPayloadStats` 回调，`plugin-manager` 的 `onPayload` 钩子里对**最终 payload**（注入参数、打完 cache 断点之后）做序列化计量：

```ts
{ messagesChars, toolsChars, toolCount, totalChars }
```

三个设计决定：

- **只记字符数，不换算 token。** 换算比随 tokenizer 与语言变化，会引入假精度。
- **计量放在所有改写之后、return 之前**，且只读不改 —— 那才是真正发出去的东西。
- **`messages` 与 `tools` 分开计。** 前者是提示词与历史，后者是工具 schema，两者的优化手段完全不同。

一个必须处理的细节：`onPayload` 钩子原本只在 `hasInjectables || stripStreamOptions` 时才安装。加了 `needsPayloadHook`，否则没有注入项的调用永远测不到。

### 2.2 按往返累加，而不是取最后一次

回调每次 LLM 往返触发一次。调用方**累加**，并数出 `llmRoundTrips`：

```ts
payloadStats.roundTrips += 1
payloadStats.messagesChars += stats.messagesChars
payloadStats.toolCount = Math.max(payloadStats.toolCount, stats.toolCount) // 工具是同一套，取最大
```

累加值才是这次调用真正送出去的总量 —— 也正是 `inputTokens` 的来源。

### 2.3 持久化与展示

- 迁移 **077** 给 `novel_agent_logs` 加 5 列：`payload_messages_chars` / `payload_tools_chars` / `payload_tool_count` / `payload_total_chars` / `llm_round_trips`
- `NovelAgentLogSummary` 补 `chapterContextLength`（零迁移 —— 数据一直在，只是没暴露）
- `agent-log-panel` 列表行显示三个数字：`↑三层字符` / `实发 Nk字`（琥珀色）/ `×N 往返`（红色，>1 才显示）

**「↑三层」与「实发」的差额就是答案。**

### 2.4 未接入的两条链路

- **arranger**：把 `planEntities` + 批量生成等多次 LLM 调用聚合成一条日志（这正是"一次编排 59,396 token"的来源 —— 不是单次请求大，是多次被记成了一次）
- **memory**：走 `NovelMemoryGenerator` 自己的 session

两处都写 0 并注释说明，**没有填假数据**。它们合计约占 27%，仍是盲区。

---

## 3. 诊断过程

### 3.1 第一层：往返次数

查 `usage_records` 按 `session_id` 分组，直接数出往返：

```sql
SELECT input_tokens, output_tokens, cache_read_tokens
FROM usage_records WHERE session_id = ? ORDER BY timestamp ASC
```

| session | 往返 | 明细 |
|---|---|---|
| director | **2** | #1 in=18,956 cR=0 → #2 in=2,663 **cR=17,920**（命中） |
| writer | **2** | #1 in=18,226 cR=0 → #2 in=18,302 **cR=0**（没命中） |
| 审稿 | **2** | #1 in=21,125 cR=0 → #2 in=22,027 **cR=0**（没命中） |

两个发现：

1. **一次 Agent 调用付两遍 prompt。** 模型先调工具，再把 prompt + 工具结果整份重发。
2. **`cacheWrite` 恒为 0 不是 bug** —— director 第二次 `cacheRead=17,920` 而 `cacheWrite=0`，说明缓存生效了，只是这个网关不上报 cache_write 字段。（`cache-layer-diagnostics.ts:15` 记的「155 条日志 cache_write 全为 0」是采集口径问题，可以从怀疑清单划掉。）

### 3.2 第二层：拆账

有了 payload 计量后，第 3 章 7 次调用 / 11 次往返 / 实发 317,835 字符 / in 271,145 token：

| agent | 三层字符 | 实发 | messages | tools | 工具数 | 往返 |
|---|---|---|---|---|---|---|
| director | 10,290 | 97,465 | 76,432 | 20,700 | **6** | 3 |
| writer | 7,996 | 51,618 | 44,448 | 6,946 | **5** | 2 |
| 文字编辑 | 4,907 | 21,847 | 18,783 | 2,953 | **4** | 1 |
| 审稿 | 10,511 | 94,632 | 76,854 | 17,445 | **6** | 3 |
| reviser | 6,980 | 52,273 | 43,795 | 8,254 | **6** | 2 |
| **合计** | **40,684** | **317,835** | 260,312 | 56,298 | | **11** |

实发 / in ≈ **1.17**，是正常的中文比例 —— **说明计量准确，token 从来没算错**，是我们之前只数了三层提示词。

**决定性观察：业务层挂载 vs 实发工具数，每一个都恰好多 4 个。**

| agent | 业务挂载 | 实发 |
|---|---|---|
| director | 2 | 6 |
| writer | 1 | 5 |
| 文字编辑 | **0**（`identity_only`） | **4** |
| 审稿 | 2 | 6 |
| reviser | 2 | 6 |

文字编辑那次是最干净的对照组：业务层挂 0 个工具，实发 4 个、2,953 字符、单次往返。**这只能是 SDK 默认挂的。**

### 3.3 第三层：用 JSONL 反查

session JSONL 记录真实对话消息（注意：`prefixUserMessage` 是直接注入 `agent.state.messages` 的，**绕过 `appendMessage`，不写 JSONL**，要单独加回来）：

```
可解释 = (sysLen + ctxLen) × 往返 + JSONL 消息内容
```

| agent | 往返 | 可解释 | 实测 messages | 未解释 | 每往返 |
|---|---|---|---|---|---|
| 文字编辑 | 1 | 5,284 | 18,783 | 13,499 | **13,499** |
| writer | 2 | 19,221 | 44,448 | 25,227 | **12,614** |
| director | 3 | 32,864 | 76,432 | 43,568 | **14,523** |
| reviser | 2 | 10,848 | 43,795 | 32,947 | **16,474** |
| 审稿 | 3 | 25,045 | 76,854 | 51,809 | **17,270** |

**每往返稳定 1.26–1.73 万字符**，与 agent 类型、上下文大小基本无关，且与工具数正相关（4 个工具 → 1.35 万，6 个 → 1.73 万）。典型的固定底座开销。

### 3.4 排除法

逐个排掉了看起来更像的候选：

| 候选 | 实测 |
|---|---|
| `.pi/instructions.md`（项目指令） | **不存在**（`InstructionLoader` 返回 null） |
| `AGENTS.md` / `CLAUDE.md` / `README.md` | 真实 cwd（`apps/agent-server`，取自 session JSONL 的 `cwd` 字段）下**都不存在** |
| skills 清单 | `apps/agent-server/.pi/skills` 与 `~/.pi/skills` **都不存在** |
| novel 的 role 模板 | `PromptManager` 是 novel 自己的（依赖 db + cwd），**不走** pi-coding-agent 的 prompt templates |
| `buildSystemPrompt(deps)` 自身 | 固定部分仅约 **250 字符**（"你是 Pi Agent" + 运行环境 + `## 当前角色`） |

剩下的只有一个：**SDK 为内置工具生成的定义与使用说明。**

---

## 4. 修复

`pi-session.ts` 里 `DefaultResourceLoaderOptions` 实际提供了一组开关，**原来一个都没传**。`createAgentSession` 也接受 `excludeTools`（原来只用于 gate 禁用列表）。

判断依据沿用文件里已有的那条（原本写了两遍，已合并为一个变量）：

```ts
const isPluginThread = deps.threadId.startsWith('plugin:')

// ResourceLoader
...(isPluginThread ? {
  noSkills: true, noContextFiles: true, noExtensions: true, noPromptTemplates: true,
} : {}),

// createAgentSession
const excludeTools = isPluginThread
  ? [...gateDeniedTools, ...CODING_AGENT_BUILTIN_TOOLS]
  : gateDeniedTools
```

`CODING_AGENT_BUILTIN_TOOLS = ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']`

**前提**：插件侧 Agent 只用 `novel_*` 业务工具 —— 这在 `novel-agents.ts` 的工具白名单里成立（5 个 Agent 挂的全是 `novel_*`）。若将来有插件 Agent 需要读文件，应该给它一个业务工具，而不是把整套编码工具放回来。

**SDK 升级新增内置工具时这个名单要同步** —— 漏掉只会少省一点，不会出错。

chat 会话完全不受影响：它恰恰要靠这些工具干活。

---

## 5. 其余成本项（未修，按嫌疑排序）

### 5.1 arranger 是最大单项，也最不可观测

两章合计按 agent 分（928k prompt token）：

| agent | 次数 | input | cacheRead | 占比 |
|---|---|---|---|---|
| **arranger（编排）** | 6 | **202,948** | 35,584 | **26%** |
| reviewer | 6 | 127,915 | 33,792 | 17% |
| director | 8 | 88,780 | 55,296 | 16% |
| reviser | 2 | 49,555 | 85,504 | 15% |
| writer | 9 | 75,010 | 23,552 | 11% |
| character（群聊角色） | 11 | 73,695 | 21,504 | 10% |
| memory | 3 | 55,183 | 0 | 6% |

它在每章开头跑，单次 41,898–59,396 token，`sessionId` 为空（usage 走订阅路径），payload 计量未接入。**占比最高却最看不清。**

### 5.2 缓存命中率随分发器路由波动

`plugin-manager.ts` 的注释解释了机制：`gpt-5.6-*` 这类 OpenAI 兼容中转走**自动前缀缓存**，要求前缀逐字节稳定，所以代码刻意**不给它们打 `cache_control` 断点**（改写成 content blocks 数组反而会破坏自动缓存）。

实测命中率在 0% 和 51% 之间跳。第 3 章那次 director 前面吃了 3 次 `503 No available channel` —— `codex-plus` 是多账号分发器，成功那次很可能被路由到另一个上游，缓存不在那台机器上。**这一项不完全由代码控制。**

### 5.3 失败不是网络抖动，是模型配置

```
503 No available channel for model gpt-5.6-luna under group codex-plus
404 Model "gpt-5.4" is not supported by any configured account in this group
401 "Invalid API key"
LLM 调用超时（300s）
```

第 1 章 10 次失败、第 2 章 4 次。404/401 按 `llm-error-policy` 属 `account` 类应当立即失败不重试，但实测出现连续 7 次失败序列 —— 说明分类没生效，或是多模型轮换在逐个试。

### 5.4 重写次数的总闸门是漏的

`MAX_GUARD_REWRITE = 2` 只管 Guard 触发的原地重写。用户在 `review` / `guard_degraded` 选 rewrite 会递归 `createChapterWithFlow` 且**不传 `guardRewriteCount`**，计数归零。第 1 章因此跑了 3 遍（38 次调用）。真正的兜底只剩 `chapter_budget` 检查点 —— 而它的「尽快收尾」选项是空操作（后端只对 `reject` 抛错）。

### 5.5 `novel_ask_story` 是两次往返的直接原因

director / writer / reviewer / reviser 都挂了它。摘掉能把往返从 2–3 次降到 1 次，直接省掉约一半的 prompt 付费。`novel-agents.ts:60-63` 已经为 Director 走过一次这条路（注释说省了约 18K），但这个工具还留着。

---

## 6. 顺带修掉的两个 bug

### 6.1 验收检查点的按钮在表达态度，不在表达后果

现象：用户以为自己选了「修订」，Reviser 从不运行，正文一直是 Writer 初稿。

真相（从 chat 记录查出）：用户点的是 `approve`。因为检查点卡片展示的是审稿结论原文 **「验收已提交，结论为需修订」**，而按钮写「通过」—— 被读成"通过这个需修订的结论"，实际语义是"接受当前正文、跳过 Reviser 直接落库"。

改法：按钮说后果。

| 旧 | 新 |
|---|---|
| 通过 | **接受这一版** —— 不再修订，直接落库进入记忆提取 |
| 修订 | **交给 Reviser 修订** —— 按审稿意见局部修改正文（正文会变） |
| 重写 | **退回重写** —— 整章退回 Writer 重新创作（成本最高） |

同时 `decisionLabels` 必须**按检查点类型分别映射**（`describeDecision()`）：同一个 action 在不同检查点是不同的事 —— 在 `narrative_task` 上 `approve` 是"确认叙事任务"，在 `review` 上是"跳过修订"。用一张全局表会把前者记成后者，事后翻记录直接误判用户意图。（这一点是我第一版改错、第二版才修对的。）

另外补了 fail-open 兜底：`novel-orchestrator.ts` 的 review 分支原来只判 `reject`/`revise`/`rewrite`，**没有 else** —— 任何非预期决策值都会静默沿用原正文落库，表现和"接受"一模一样。在会花钱、会覆盖正文的分支上"不认识就当同意"是危险的默认。现在 `approve` 走显式分支并推进度消息，未知值 `logger.warn` + 进度事件留痕（不抛错，否则整章白跑）。

### 6.2 记忆回退路径拿不到 projectId

现象：memory 输出「无法调用记忆工具：当前请求未提供 projectId」，一条状态变更都没写入，白烧 16,985 token。

事件链：
1. generator（结构化 JSON 调用）撞上 `503 No available channel` 失败
2. 回退到 memory Agent 工具循环（18 个工具、4 次往返、78,424 字符工具 schema、123,984 字符实发）
3. 工具循环第一次又 503，重试成功，但 Agent 只能罢工

根因：`runAgentFallback` 两个调用点原来只传 `{ task, content }`，而 **memory 的 18 个写工具全部把 `projectId` 列为必填**。这条路平时不走（generator 正常时就返回了），所以缺陷一直藏着。

改法：`projectId` 既进 JSON 字段也写进任务描述文本。

同时改了回退时机：**瞬时故障先重试结构化提取一次，仍失败才换贵路。**

这里有个值得记下的取舍 —— 初版想用 `LLM_MAX_RETRIES`（3 次，1s→4s→12s），写完发现不对：回退路径本身走 `orchestrator.runAgent`，那里**已经有一整套 3 次退避重试**。在这里再排一个阶梯，等于把同一次瞬时故障的等待时间翻倍（最坏 +17s）却不增加成功概率。定成 `MEMORY_STRUCTURED_RETRIES = 1`。

---

## 7. 怎么复测

### 7.1 看面板

生成一章后打开 Agent 日志面板，每行看三个数字：

- `↑Nk字` —— 提示词三层（hover 看静态/上下文/指令拆分）
- `实发 Nk字` —— 真正发出去的 payload（hover 看 messages / tools 分项与工具个数）
- `×N 往返` —— 一次调用内部的 LLM 往返次数

**最直接的验收指标是「工具数」**：文字编辑那个 Agent 业务层挂 0 个工具，改动生效后应该显示 **0**；还是 4 就说明 `excludeTools` 没起作用。

### 7.2 拉接口

```
GET /api/plugins/novel/projects/{projectId}/agent-logs?chapterNumber=N&limit=100
```

返回的 summary 含 `chapterContextLength` / `payloadTotalChars` / `payloadMessagesChars` / `payloadToolsChars` / `payloadToolCount` / `llmRoundTrips`。

### 7.3 查往返明细（需要 DB 只读访问）

```js
const Database = require('<agent-server>/node_modules/better-sqlite3')
const db = new Database('<~/.pi>/wenlang-agent.db', { readonly: true })
db.prepare(`SELECT input_tokens, output_tokens, cache_read_tokens, model
  FROM usage_records WHERE session_id = ? ORDER BY timestamp ASC`).all(sessionId)
```

`sessionId` 从单条日志详情 `GET /api/plugins/novel/agent-logs/{id}` 取。

### 7.4 用 JSONL 反查真实消息量

session 文件在 `<dataDir>/agent/sessions/`，文件名形如
`2026-08-01T05-20-29-489Z_{sessionUuid}.jsonl` —— **文件名嵌的是 session uuid，与 threadId 无关**。

统计 `type: 'message'` 条目的 `message.content[].text` 长度即真实对话内容量。
**记得 `prefixUserMessage` 不在里面**（直接注入内存 state，绕过 `appendMessage`）。

---

## 8. 基线数字（供后续对比）

「我在古代开咸货铺」：

| 章 | 调用 | 往返 | input | cacheRead | 实发字符 | 失败 | 耗时 | 正文 | 每字成本 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 38 | — | 465,080 | 237,312（34%） | 未计量 | 10 | 22.8 min | — | — |
| 2（一轮） | 7 | — | 208,006 | 17,920（7.9%） | 未计量 | 1 | 5.8 min | 3,213 字 | ~70 token |
| 2（二轮） | 8 | — | 150,320 | 0 | 未计量 | 3 | — | 2,546 字 | ~59 token |
| **3（改动前）** | 7 | **11** | 271,145 | 37,888（14%） | **317,835** | 0 | 6.0 min | ~3,000 字 | ~90 token |

第 1 章 38 次调用是因为跑了 3 遍：工作流第 1 轮 → 一段失败重试 → 群聊完整第 2 轮。

---

## 9. 相关文件

| 文件 | 作用 |
|---|---|
`core/agent/pi-session.ts` | **本次主修复**：插件会话不加载编码 agent 底座 |
`core/plugin/plugin-types.ts` | `onPayloadStats` / `PluginPayloadStats` |
`core/plugin/plugin-manager.ts` | `measurePayload()` + `needsPayloadHook` |
`core/agent/chapter-finalizer.ts` | 记忆回退补 projectId + `retryStructuredMemory()` |
`plugins/novel-plugin/novel-migrations.ts` | 迁移 077（payload 计量 5 列） |
`plugins/novel-plugin/core/novel-orchestrator.ts` | review 分支兜底 + payloadStats 累加 |
`plugins/novel-plugin/routes/creation-flow-routes.ts` | `describeDecision()` 按检查点分文案 |
`plugins/novel-plugin/core/llm-error-policy.ts` | 失败分类与退避（本次复用，未改） |
`plugins/novel-plugin/core/cache-layer-diagnostics.ts` | 缓存分层诊断（自述"从未验证是否生效"） |
`components/novel/agent-log-panel.tsx` | 面板展示三个数字 |

---

## 10. 待办

1. **摘掉 `novel_ask_story`**，把 director / 审稿的 2–3 次往返压到 1 次（见 §5.5）
2. **给 arranger 接入 payload 计量**，补上占比最高（26%）的盲区（见 §5.1）
3. **给 memory 接入 payload 计量**
4. **重试尝试补 `novel_agent_logs` 行** —— 目前 `retryStructuredMemory` 只走 logger + 进度事件，重试消耗的 token 不进面板
5. 修「修订 Agent 在对话流里是空气泡」的显示缺陷（日志有 3,035 字符输出，界面看不到）
6. `chapter_budget` 检查点的「尽快收尾」是空操作，需要真实实现或去掉
7. 考虑第二步激进方案：`appendSystemPromptOverride: () => []`。**风险是可能连工具使用说明一起砍掉**，导致模型不会正确调用 `novel_submit_*` 工具，必须实测后再定
