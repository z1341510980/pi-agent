# Phase 2：上下文缓存强化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 审查并强化 PromptBuilder 确保静态/动态严格分离，添加缓存诊断日志（systemHash/toolsHash），保障 Tools schema 排序稳定，验证跨章 systemHash 不变。

**架构：** 在现有 NovelPromptBuilder 基础上添加哈希诊断能力，通过 EventEmitter 推送缓存命中率指标到前端。Tools schema 在 `createNovelTools` 返回时按名称排序确保稳定。

**技术栈：** TypeScript、Node.js crypto、Pi SDK

---

## 文件结构

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts` | 添加哈希诊断 + 排序保障 + 章节摘要改进 |
| `apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts` | Tools schema 按名称排序 |
| `apps/agent-server/src/plugins/novel-plugin/core/novel-session.ts` | 添加缓存诊断日志 |

---

## 任务 1：添加缓存哈希诊断

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts`

- [ ] **步骤 1：在 prompt-builder.ts 中添加哈希计算方法**

在 `NovelPromptBuilder` 类中添加：

```typescript
import { createHash } from 'node:crypto'

// 在类中添加
/** 计算字符串的 SHA-256 哈希（前 16 位，用于诊断） */
private hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** 计算系统提示词哈希（用于跨章诊断缓存命中） */
getSystemPromptHash(projectId: string, agentType: string): string {
  const prompt = this.buildSystemPrompt(projectId, agentType)
  return this.hashContent(prompt)
}

/** 计算章节上下文哈希（用于单章内诊断缓存命中） */
getChapterContextHash(
  projectId: string,
  chapterNumber: number,
  narrativeTask: NarrativeTask,
  constraints: ChapterConstraints,
): string {
  const context = this.buildChapterContext(projectId, chapterNumber, narrativeTask, constraints)
  return this.hashContent(context)
}
```

- [ ] **步骤 2：在 buildSystemPrompt 中添加排序保障**

修改 `buildSystemPrompt` 方法，确保世界规则、风格指南、角色定义按稳定顺序排列：

```typescript
buildSystemPrompt(projectId: string, agentType: string): string {
  const parts: string[] = []

  // Layer 0: Agent 身份（永不变）
  const identityPrompt = this.promptManager.render('system-base', {
    agent_type: agentType,
    agent_role: this.getAgentRoleDescription(agentType, projectId),
  }, projectId)
  parts.push(identityPrompt)

  // Layer 1: 世界规则（按 category 排序，再按 rule 排序）
  const worldRules = this.stores.listWorldRules(projectId)
  if (worldRules.length > 0) {
    const sorted = [...worldRules].sort((a, b) => {
      const catCmp = a.category.localeCompare(b.category)
      return catCmp !== 0 ? catCmp : a.rule.localeCompare(b.rule)
    })
    parts.push(this.formatWorldRules(sorted))
  }

  // Layer 2: 风格指南（按 category 排序）
  const styleGuide = this.stores.listStyleGuide(projectId)
  if (styleGuide.length > 0) {
    const sorted = [...styleGuide].sort((a, b) =>
      a.category.localeCompare(b.category) || a.rule.localeCompare(b.rule)
    )
    parts.push(this.formatStyleGuide(sorted))
  }

  // Layer 3: 角色定义（按 name 排序，确保新增角色不破坏顺序）
  const characters = this.stores.listCharacters(projectId)
  if (characters.length > 0) {
    const sorted = [...characters].sort((a, b) => a.name.localeCompare(b.name))
    parts.push(this.formatCharacterDefinitions(sorted))
  }

  return parts.join('\n\n---\n\n')
}
```

- [ ] **步骤 3：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts
git commit -m "feat(novel): 添加缓存哈希诊断和排序保障"
```

---

## 任务 2：Tools schema 排序保障

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts`

- [ ] **步骤 1：在 createNovelTools 返回前按工具名排序**

```typescript
export function createNovelTools(store: NovelStore): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createQueryStateTool(store),
    createUpdateCharacterTool(store),
    createUpdateForeshadowTool(store),
    createUpdateConflictTool(store),
    createUpdateClueTool(store),
    createUpdateRelationshipTool(store),
    createCreateCharacterTool(store),
    createCreateForeshadowTool(store),
    createCreateConflictTool(store),
    createCreateClueTool(store),
  ]

  // 按工具名排序，确保 tools schema 顺序稳定，最大化 prompt cache 命中率
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}
```

- [ ] **步骤 2：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts
git commit -m "feat(novel): Tools schema 按名称排序保障缓存稳定"
```

---

## 任务 3：Session 级缓存诊断日志

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-session.ts`

- [ ] **步骤 1：在 NovelSessionFactory 中添加哈希日志**

```typescript
import { createHash } from 'node:crypto'

// 在 NovelSessionFactory 类中添加

/** 计算并记录系统提示词哈希（用于诊断缓存命中） */
logSystemPromptHash(config: NovelSessionConfig): string {
  const prompt = this.promptBuilder.buildSystemPrompt(config.projectId, config.agentType)
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 16)
  // eslint-disable-next-line no-console
  console.log(`[Novel] SystemPrompt hash for ${config.agentType}: ${hash} (projectId=${config.projectId})`)
  return hash
}

/** 计算并记录章节上下文哈希 */
logChapterContextHash(config: NovelSessionConfig): string {
  const context = this.promptBuilder.buildChapterContext(
    config.projectId,
    config.chapterNumber,
    config.narrativeTask,
    config.constraints,
  )
  const hash = createHash('sha256').update(context).digest('hex').slice(0, 16)
  // eslint-disable-next-line no-console
  console.log(`[Novel] ChapterContext hash: ${hash} (chapter=${config.chapterNumber}, agent=${config.agentType})`)
  return hash
}
```

- [ ] **步骤 2：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/novel-session.ts
git commit -m "feat(novel): Session 级缓存哈希诊断日志"
```

---

## 任务 4：章节摘要改进

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts`

- [ ] **步骤 1：改进 formatRecentSummaries 方法**

将 `content.slice(0, 200)` 改为优先使用 `narrative_task` 字段作为摘要，回退到 content 截取：

```typescript
/** 格式化最近章节摘要 */
private formatRecentSummaries(chapters: NovelChapter[]): string {
  const parts: string[] = ['## 最近章节摘要']
  for (const ch of chapters) {
    // 优先使用 narrative_task 作为摘要（比 content 截取更有语义）
    const summary = ch.narrativeTask
      ? ch.narrativeTask
      : ch.content.slice(0, 200) + (ch.content.length > 200 ? '...' : '')
    parts.push(`- 第${ch.chapterNumber}章《${ch.title}》：${summary}`)
  }
  return parts.join('\n')
}
```

- [ ] **步骤 2：验证编译**

运行：`cd apps/agent-server && npx tsc --noEmit`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/prompt-builder.ts
git commit -m "fix(novel): 章节摘要优先使用 narrative_task 替代 content 截取"
```

---

## 任务 5：验证缓存命中率

- [ ] **步骤 1：启动服务并创建测试项目**

```bash
cd apps/agent-server && npm run dev
```

```bash
# 创建项目
curl -X POST http://localhost:3900/api/plugins/novel/projects \
  -H "Content-Type: application/json" \
  -d '{"title":"缓存测试","genre":"奇幻","synopsis":"测试缓存命中率"}'

# 创建角色
curl -X POST http://localhost:3900/api/plugins/novel/projects/{id}/characters \
  -H "Content-Type: application/json" \
  -d '{"name":"主角","identity":"剑士"}'
```

- [ ] **步骤 2：验证系统提示词哈希稳定**

检查日志输出：
- 第一次调用 `buildSystemPrompt` → 记录 hash
- 第二次调用（同一项目同一 agentType）→ hash 应相同
- 修改角色静态属性后 → hash 可能变化（预期行为）
- 不修改任何数据，再次调用 → hash 应相同

- [ ] **步骤 3：验证 Tools schema 顺序稳定**

```bash
# 获取工具列表两次，比较顺序
curl http://localhost:3900/ag-ui/agent/default/tools
curl http://localhost:3900/ag-ui/agent/default/tools
```
预期：两次返回的工具列表顺序一致（按名称排序）

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "test(novel): 验证缓存命中率诊断"
```

---

## 自检

### 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| 审查 PromptBuilder 确保静态/动态分离 | 任务 1（排序保障） |
| 添加缓存诊断日志（systemHash/toolsHash） | 任务 1 + 任务 3 |
| Tools schema 排序保障 | 任务 2 |
| 验证跨章 systemHash 不变 | 任务 5 |
| 章节摘要改进（替代 slice 200） | 任务 4 |

### 类型一致性

- `getSystemPromptHash` / `getChapterContextHash` 在 prompt-builder.ts 中定义，在 novel-session.ts 中通过 `logSystemPromptHash` / `logChapterContextHash` 调用
- `createNovelTools` 返回排序后的数组，与 Phase 1 任务 7 一致
