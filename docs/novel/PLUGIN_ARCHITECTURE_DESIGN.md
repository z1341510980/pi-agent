# AI 小说创作工作台 - 插件化架构设计

> 基于 pi-agent 底座，将小说创作系统重构为 PluginManager 动态插件，支持未来其他工具以同样模式开发。

## 目录

1. [设计决策](#1-设计决策)
2. [插件系统扩展](#2-插件系统扩展)
3. [小说插件架构](#3-小说插件架构)
4. [上下文缓存优化](#4-上下文缓存优化)
5. [前端无限画布](#5-前端无限画布)
6. [多 Agent 编排](#6-多-agent-编排)
7. [工具补全与实现路线图](#7-工具补全与实现路线图)

---

## 1. 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 插件架构 | PluginManager 动态插件 | 统一插件模式、真正动态加载、未来工具复用同一模式 |
| 前端布局 | 无限画布为主 | 角色关系可视化、创作全局视角、节点自由布局 |
| Agent 编排 | 自动流程 + 检查点 | 兼顾自动化效率和用户可控性 |
| 设计范围 | 全覆盖 + 分阶段实现 | 完整设计确保一致性，分阶段降低风险 |

---

## 2. 插件系统扩展

### 2.1 扩展 PluginContext 接口

在现有 4 种能力（tool/route/event/panel）基础上新增 4 种：

```typescript
interface PluginContext {
  // ── 现有能力 ──
  readonly pluginName: string
  readonly logger: FastifyBaseLogger
  registerTool(tool: ToolDefinition): void
  registerRoute(route: RouteDefinition): void
  onEvent(type: string, handler: EventHandler): void
  registerPanel(panel: PanelDefinition): void

  // ── 新增能力 ──
  /** 注册数据库迁移 */
  registerMigration(migration: MigrationDefinition): void
  /** 注入 Pi Session customTools（每次创建 session 时注入） */
  registerSessionTools(tools: ToolDefinition[]): void
  /** 装饰 Fastify 实例（挂载服务） */
  registerService(name: string, service: unknown): void
  /** 注册提示词模板目录 */
  registerPromptTemplates(dir: string): void
}
```

### 2.2 初始化时序

关键变化：PluginManager.start() 需要在 database 之后、session factory 之前执行：

```
① 核心插件：requestContext → cors → auth → rateLimit → errorHandler → eventBus
② 数据库：database plugin → DB 就绪
③ PluginManager.start()：
   ├─ 调用所有插件的 setup()，收集注册项
   ├─ 执行收集到的数据库迁移
   ├─ 装饰 Fastify 实例（registerService）
   ├─ 收集 session tools → 存入全局 ToolRegistry
   └─ 注册路由
④ 核心对象：CredentialBridge / Gate / ConfirmationManager
   sessionStore.setSessionFactory() ← 从 ToolRegistry 获取插件工具
⑤ 路由注册
```

### 2.3 MigrationDefinition 接口

```typescript
interface MigrationDefinition {
  id: number
  name: string
  sql: string
}
```

PluginManager 收集所有插件的迁移，按 id 排序后统一执行，与现有 `schema_migrations` 表兼容。

### 2.4 Session Tools 注入机制

PluginManager 维护一个 `pluginSessionTools: ToolDefinition[]` 数组。`createPiSession` 的 `customTools` 参数从该数组获取插件工具：

```typescript
// pi-session.ts 改造
const customTools = [
  ...subagentTools,
  ...teamTools,
  ...app.pluginManager.getAllSessionTools(),  // 新增
]
```

### 2.5 插件目录结构约定

```
plugins/
├── novel-plugin/           # 小说插件
│   ├── index.ts            # Plugin 入口
│   ├── manifest.json       # 插件清单
│   ├── core/               # 核心逻辑
│   ├── migrations/         # 数据库迁移
│   ├── prompts/            # 提示词模板
│   └── frontend/           # 前端组件
├── hello-plugin/           # 示例插件
└── [未来其他插件]/
```

---

## 3. 小说插件架构

### 3.1 插件目录结构

```
plugins/novel-plugin/
├── index.ts                  # Plugin 入口（setup 注册所有能力）
├── manifest.json             # 插件清单
├── core/
│   ├── types.ts              # 15 大系统类型定义
│   ├── novel-store.ts        # SQLite CRUD（从 core/novel/ 迁移）
│   ├── novel-engine.ts       # 章节创作流程编排
│   ├── novel-session.ts      # Session 工厂
│   ├── novel-tools.ts        # 工具定义（现有 6 + 新增创建类）
│   ├── prompt-builder.ts     # 缓存分层构建器
│   ├── prompt-manager.ts     # 三级覆盖模板管理
│   └── novel-agents.ts       # 5 个 Agent 配置定义
├── migrations/
│   └── 013-027_novel.sql     # 15 张表的迁移
├── prompts/
│   ├── system-base.md
│   ├── chapter-instruction.md
│   ├── role-director.md
│   ├── role-writer.md
│   ├── role-reviewer.md
│   ├── role-reviser.md
│   └── role-memory.md
├── routes/
│   └── novel-routes.ts       # REST API 路由定义
└── frontend/
    ├── index.ts              # 前端组件注册入口
    ├── canvas/               # 无限画布组件
    ├── panels/               # 侧边面板组件
    └── stores/               # Zustand store
```

### 3.2 Plugin 入口

```typescript
// plugins/novel-plugin/index.ts
export default function createPlugin(): Plugin {
  return {
    manifest: {
      name: 'novel',
      version: '1.0.0',
      description: 'AI 小说创作工作台',
      builtin: true,
    },

    async setup(context: PluginContext) {
      // 1. 注册数据库迁移（15 张表）
      context.registerMigration(novelMigrations)

      // 2. 装饰 Fastify 实例
      const store = new NovelStore(app.db)
      const promptManager = new PromptManager(/* 三级覆盖配置 */)
      const promptBuilder = new NovelPromptBuilder(store, promptManager)
      const sessionFactory = new NovelSessionFactory(store, promptManager, promptBuilder)
      const engine = new NovelEngine(store, sessionFactory)

      context.registerService('novelStore', store)
      context.registerService('novelEngine', engine)
      context.registerService('novelSessionFactory', sessionFactory)

      // 3. 注册 Pi Session 工具
      context.registerSessionTools(novelTools)

      // 4. 注册提示词模板目录
      context.registerPromptTemplates(path.join(__dirname, 'prompts'))

      // 5. 注册 REST API 路由
      for (const route of novelRoutes) {
        context.registerRoute(route)
      }

      // 6. 注册前端面板
      context.registerPanel({
        id: 'novel-canvas',
        title: '小说工作台',
        component: 'NovelCanvas',
        position: 'main',
      })

      // 7. 订阅事件
      context.onEvent('agent:run:finished', handleRunFinished)
    },
  }
}
```

### 3.3 从 app.ts 移除的代码

现有 `app.ts` 中的以下代码将被移除（由插件 setup 取代）：
- `await app.register(novelPlugin)` → 插件 setup
- `await app.register(novelRoute)` → 插件 registerRoute
- `novelTools: app.novelSessionFactory.getNovelTools()` → 插件 registerSessionTools
- 所有 `app.decorate('novelStore', ...)` → 插件 registerService

---

## 4. 上下文缓存优化

### 4.1 三层缓存模型

```
[系统提示词] STATIC  ← 跨章节缓存命中
├── Layer 0: Agent 身份（永不变）
├── Layer 1: 世界规则（项目级，极少变）
├── Layer 2: 风格指南（项目级，极少变）
└── Layer 3: 角色静态定义（身份/性格/外貌/说话风格，不含动态状态）

[首条用户消息] SEMI  ← 单章内缓存命中
├── 章节信息（卷/章/叙事任务/约束）
├── 当前故事状态快照（角色动态状态/冲突/伏笔/线索）
├── 信息差（谁知道什么）
├── 最近 3 章摘要
└── 创作指令

[对话消息] DYNAMIC  ← 不缓存
├── 用户引导消息
├── 助手生成内容
├── 工具调用 + 结果（追加到末尾）
└── 检查点确认消息
```

### 4.2 缓存命中率保障规则

| 规则 | 说明 | 违反后果 |
|------|------|----------|
| 系统提示词只含静态数据 | 角色定义不含情绪/目标/压力等动态状态 | 跨章缓存失效，成本翻倍 |
| 章节上下文作为首条消息 | 动态状态放在 SEMI 层 | 单章内缓存失效 |
| 工具结果只追加不修改前缀 | 不修改已发送的 system + first message | 前缀缓存断裂 |
| 状态更新延迟生效 | 工具更新立即写 DB，但当前章节提示词不变 | 当前章缓存失效 |
| Tools schema 按名称排序 | 确保工具列表顺序稳定 | tools_hash 变化触发缓存失效 |
| 章节切换才重建 Session | 同一章内所有对话复用同一 Session | 每次对话重建 Session |

### 4.3 PromptBuilder 强化

```typescript
class NovelPromptBuilder {
  /**
   * 构建 STATIC 层系统提示词
   * 关键：拼接顺序固定，静态数据在前
   */
  buildSystemPrompt(projectId: string, agentType: AgentType): string {
    // 顺序固定：身份 → 世界规则 → 风格指南 → 角色静态定义
    // 每个部分内部按 ID 排序确保稳定
    return [
      this.renderTemplate('system-base', { agentType, agentRole }),
      this.formatWorldRules(worldRules),    // 按 sort_order 排序
      this.formatStyleGuide(styleGuide),
      this.formatCharacterStatic(characters), // 只含静态字段
    ].join('\n\n')
  }

  /**
   * 构建 SEMI 层章节上下文（首条用户消息）
   * 关键：单章内不变，工具更新延迟到下一章
   */
  buildChapterContext(projectId: string, chapterId: string): string {
    return [
      this.formatChapterInfo(chapter),
      this.formatStoryState(state),        // 角色动态状态快照
      this.formatInfoLayers(infoLayers),
      this.formatRecentSummaries(chapters), // 最近 3 章
      this.renderTemplate('chapter-instruction', { task, constraints }),
    ].join('\n\n---\n\n')
  }
}
```

### 4.4 缓存诊断

复用项目的 PrefixShape 诊断机制，每次 LLM 调用后记录：
- `systemHash`：系统提示词哈希（跨章应不变）
- `toolsHash`：工具列表哈希（应稳定）
- `chapterHash`：章节上下文哈希（单章内应不变）

异常时告警：`systemHash` 跨章变化 → 检查是否有动态数据泄漏到系统提示词。

---

## 5. 前端无限画布

### 5.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  顶栏：项目切换 | 章节导航 | 模式切换 | 模型选择            │
├──────────┬──────────────────────────┬──────────────────────┤
│          │                          │                      │
│  左侧栏   │     无限画布（主区域）    │    右侧栏             │
│  项目树   │  ┌──────────────────┐   │  属性面板 /          │
│  章节列表 │  │  角色节点          │   │  Agent 对话 /        │
│  工具栏   │  │    ├──关系连线──→  │   │  章节预览            │
│          │  │  伏笔节点          │   │                      │
│          │  │  冲突节点          │   │                      │
│          │  │  线索节点          │   │                      │
│          │  │  章节节点          │   │                      │
│          │  └──────────────────┘   │                      │
│          │  缩放/平移/框选/连线      │                      │
├──────────┴──────────────────────────┴──────────────────────┤
│  底栏：状态 | 缓存命中率 | Agent 执行状态 | Token 用量      │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 画布节点类型

| 节点类型 | 视觉 | 数据来源 | 交互 |
|----------|------|----------|------|
| **角色节点** | 圆形头像 + 名字 + 当前情绪图标 | novel_characters | 点击查看详情、拖拽调整位置 |
| **关系连线** | 带标签的箭头（盟友/敌对/师徒等） | novel_relationships | 点击编辑关系阶段 |
| **伏笔节点** | 菱形 + 状态色（计划/已埋/已回收） | novel_foreshadowing | 点击查看回收链路 |
| **线索节点** | 六边形 + 进度条 | novel_clues | 点击查看推理链 |
| **冲突节点** | 闪电图标 + 强度色 | novel_conflicts | 点击查看升级历史 |
| **章节节点** | 矩形卡片 + 章节号 + 状态 | novel_chapters | 点击进入章节编辑 |
| **场景节点** | 云朵形 + 场景描述 | novel_scenes（新增） | 点击查看场景详情 |

### 5.3 画布交互

```
基础操作：
  - 鼠标滚轮：缩放（0.25x ~ 4x）
  - 空格+拖拽 / 中键拖拽：平移画布
  - 单击节点：选中，右侧栏显示属性
  - 双击节点：展开详情面板
  - 拖拽节点：移动位置（位置持久化到 novel_canvas_positions 表）
  - 框选：多选后批量操作

高级操作：
  - 从角色节点拖出连线到另一角色：创建关系
  - 右键节点：上下文菜单（编辑/删除/聚焦/创建关联）
  - 右键空白：创建新节点
  - Cmd/Ctrl+G：按类型分组排列
  - Cmd/Ctrl+F：画布内搜索节点
```

### 5.4 画布布局算法

提供 3 种自动布局：
1. **力导向布局**：角色关系网自然展开，关系紧密的聚集
2. **时间线布局**：按章节顺序水平排列，伏笔/线索纵向展开
3. **分组布局**：按类型分组（角色区/伏笔区/冲突区）

### 5.5 右侧栏模式切换

| 模式 | 触发条件 | 内容 |
|------|----------|------|
| **属性面板** | 选中画布节点 | 节点详情编辑表单 |
| **Agent 对话** | 点击"创作"按钮 | 聊天界面 + Agent 执行进度 |
| **章节预览** | 双击章节节点 | Markdown 渲染的章节正文 |
| **检查点确认** | Agent 流程暂停 | Director 任务确认 / Reviewer 验收报告 |

### 5.6 前端技术选型

| 技术 | 用途 | 理由 |
|------|------|------|
| **React Flow** | 无限画布核心 | 成熟、React 原生、支持自定义节点/边、缩放平移 |
| **Zustand** | 状态管理 | 与现有项目一致 |
| **TanStack Query** | API 数据获取 | 与现有项目一致 |
| **Tailwind CSS** | 样式 | 与现有项目一致 |
| **Framer Motion** | 动画 | 与现有项目一致 |

### 5.7 前端 Store 结构

```typescript
// stores/novel-store.ts
interface NovelStore {
  // ── 项目状态 ──
  currentProject: NovelProject | null
  projects: NovelProject[]

  // ── 画布状态 ──
  canvasNodes: CanvasNode[]
  canvasEdges: CanvasEdge[]
  selectedNodeId: string | null
  canvasMode: 'force' | 'timeline' | 'group'

  // ── 章节状态 ──
  chapters: NovelChapter[]
  currentChapter: NovelChapter | null

  // ── Agent 执行 ──
  agentExecution: {
    phase: 'idle' | 'directing' | 'writing' | 'reviewing' | 'revising' | 'memory'
    status: 'running' | 'paused' | 'completed' | 'error'
    checkpoint: CheckpointData | null
    messages: ChatMessage[]
  }

  // ── 右侧栏 ──
  rightPanelMode: 'properties' | 'chat' | 'preview' | 'checkpoint'
  selectedEntity: NovelEntity | null
}
```

### 5.8 画布位置持久化

新增 `novel_canvas_positions` 表：

```sql
CREATE TABLE IF NOT EXISTS novel_canvas_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- character/foreshadowing/clue/conflict/chapter
  entity_id TEXT NOT NULL,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, entity_type, entity_id)
);
```

---

## 6. 多 Agent 编排

### 6.1 创作流程（自动 + 检查点）

```
用户点击"创作第 N 章"
        │
        ▼
┌─ Director Agent ──────────────────────────┐
│  输入：故事状态 + 前章摘要 + 章节约束       │
│  输出：叙事任务 + 节奏类型 + 信息差分配     │
└──────────────────┬────────────────────────┘
                   │
          ╔═══════▼═══════╗
          ║  检查点 1     ║ ← 用户确认/修改叙事任务
          ║  叙事任务确认 ║   确认后继续
          ╚═══════┬═══════╝
                  │
                  ▼
┌─ Writer Agent ────────────────────────────┐
│  输入：系统提示词 + 章节上下文 + 叙事任务  │
│  工具：novel_query_state（查询最新状态）   │
│  输出：章节正文（流式输出到前端）           │
└──────────────────┬────────────────────────┘
                   │
                   ▼
┌─ Reviewer Agent ─────────────────────────┐
│  输入：章节正文 + 故事状态 + 创作约束      │
│  输出：验收报告（多维度评分 + 问题列表）   │
└──────────────────┬────────────────────────┘
                   │
          ╔═══════▼═══════╗
          ║  检查点 2     ║ ← 用户查看验收报告
          ║  验收确认     ║   选择：通过 / 修订 / 重写
          ╚═══════┬═══════╝
                  │
         ┌────────┼────────┐
         │        │        │
     通过 │    修订 │     重写 │
         │        │        │
         │        ▼        │
         │  ┌─ Reviser ─┐ │
         │  │ 局部重写   │ │
         │  └─────┬─────┘ │
         │        │       │
         ▼        ▼       ▼
┌─ Memory Agent ───────────────────────────┐
│  输入：最终章节正文 + 当前故事状态         │
│  工具：novel_update_character/foreshadow   │
│        /conflict/clue/relationship         │
│  输出：状态变更摘要（展示到画布上）         │
└──────────────────┬────────────────────────┘
                   │
                   ▼
              章节完成
              画布节点更新
              下一章就绪
```

### 6.2 Agent 配置

每个 Agent 通过 `AgentConfig` 定义，注入到 `createPiSession` 的 `systemPromptOverride`：

```typescript
const NOVEL_AGENTS = {
  director: {
    id: 'novel-director',
    name: '导演 Agent',
    systemPrompt: promptBuilder.buildSystemPrompt(projectId, 'director'),
    tools: ['novel_query_state'],  // 只读
    identity: '你是一个专业的小说导演，负责分析故事状态并规划章节叙事任务。',
  },
  writer: {
    id: 'novel-writer',
    name: '写作 Agent',
    systemPrompt: promptBuilder.buildSystemPrompt(projectId, 'writer'),
    tools: ['novel_query_state'],  // 只读，不直接更新状态
    identity: '你是一个专业的小说作家，根据叙事任务和约束创作章节正文。',
  },
  reviewer: {
    id: 'novel-reviewer',
    name: '审稿 Agent',
    systemPrompt: promptBuilder.buildSystemPrompt(projectId, 'reviewer'),
    tools: ['novel_query_state'],
    identity: '你是一个严格的审稿编辑，检查章节的一致性、节奏和可读性。',
  },
  reviser: {
    id: 'novel-reviser',
    name: '修订 Agent',
    systemPrompt: promptBuilder.buildSystemPrompt(projectId, 'reviser'),
    tools: ['novel_query_state'],
    identity: '你是一个修订专家，根据审稿问题重写章节局部内容。',
  },
  memory: {
    id: 'novel-memory',
    name: '记忆 Agent',
    systemPrompt: promptBuilder.buildSystemPrompt(projectId, 'memory'),
    tools: [
      'novel_update_character',
      'novel_update_foreshadow',
      'novel_update_conflict',
      'novel_update_clue',
      'novel_update_relationship',
    ],  // 写工具，更新故事状态
    identity: '你是一个记忆管理 Agent，负责从章节中提取状态变更并更新故事状态系统。',
  },
}
```

### 6.3 NovelEngine 编排实现

```typescript
class NovelEngine {
  /**
   * 创作章节（自动流程 + 检查点）
   * 使用 EventEmitter 推送阶段进展到前端
   */
  async createChapter(
    projectId: string,
    chapterNumber: number,
    options: {
      onCheckpoint: (type: CheckpointType, data: unknown) => Promise<boolean | string>
      onProgress: (phase: string, event: BaseEvent) => void
    }
  ): Promise<ChapterResult> {
    // Phase 1: Director
    this.emit('phase:change', { phase: 'directing' })
    const directorResult = await this.runAgent('director', projectId, {
      task: `规划第 ${chapterNumber} 章的叙事任务`,
    })
    const narrativeTask = directorResult.content

    // 检查点 1：用户确认叙事任务
    const approved = await options.onCheckpoint('narrative_task', narrativeTask)
    if (!approved) return { status: 'cancelled' }

    // Phase 2: Writer
    this.emit('phase:change', { phase: 'writing' })
    const chapterContext = this.promptBuilder.buildChapterContext(projectId, chapterId)
    const writerResult = await this.runAgent('writer', projectId, {
      task: chapterContext,
      narrativeTask,
    })

    // Phase 3: Reviewer
    this.emit('phase:change', { phase: 'reviewing' })
    const reviewResult = await this.runAgent('reviewer', projectId, {
      task: `验收第 ${chapterNumber} 章`,
      content: writerResult.content,
    })

    // 检查点 2：用户查看验收报告
    const decision = await options.onCheckpoint('review', reviewResult)

    let finalContent = writerResult.content
    if (decision === 'revise') {
      // Phase 4a: Reviser
      this.emit('phase:change', { phase: 'revising' })
      const reviseResult = await this.runAgent('reviser', projectId, {
        task: `修订第 ${chapterNumber} 章`,
        content: writerResult.content,
        issues: reviewResult.issues,
      })
      finalContent = reviseResult.content
    } else if (decision === 'rewrite') {
      // Phase 4b: 重写（回到 Writer）
      return this.createChapter(projectId, chapterNumber, options)
    }

    // Phase 5: Memory
    this.emit('phase:change', { phase: 'memory' })
    const memoryResult = await this.runAgent('memory', projectId, {
      task: `从第 ${chapterNumber} 章提取状态变更`,
      content: finalContent,
    })

    // 完成
    this.emit('phase:change', { phase: 'completed' })
    return { status: 'success', content: finalContent, stateChanges: memoryResult.changes }
  }

  /** 运行单个 Agent（通过 Pi SDK Session） */
  private async runAgent(agentType: string, projectId: string, input: unknown) {
    const agentConfig = NOVEL_AGENTS[agentType]
    const session = await this.sessionFactory.createSession({
      agentConfig,
      projectId,
    })
    // 通过 AG-UI SSE 流式输出到前端
    return await session.run(input, { onEvent: (e) => this.emit('agent:event', e) })
  }
}
```

### 6.4 前端检查点交互

检查点通过 WebSocket 推送到前端，用户在右侧栏确认：

```
┌─────────────────────────────┐
│  📋 叙事任务确认              │
├─────────────────────────────┤
│  章节：第 12 章               │
│  叙事任务：                    │
│  • 推进主线：揭示主角身世      │
│  • 制造冲突：师徒对立升级      │
│  • 回收伏笔：玉佩来历          │
│  节奏类型：转折               │
│  信息差分配：                  │
│  • 读者知道：玉佩是信物        │
│  • 主角不知道：师父是敌国间谍   │
├─────────────────────────────┤
│  [修改任务]    [确认开始]     │
└─────────────────────────────┘
```

---

## 7. 工具补全与实现路线图

### 7.1 新增工具清单

现有 6 个工具（1 读 + 5 写），新增 7 个工具补全缺口：

| 工具名 | 类型 | 说明 | 优先级 |
|--------|------|------|--------|
| `novel_create_character` | 写 | 创建新角色（含静态+动态状态） | P0 |
| `novel_create_foreshadow` | 写 | 创建新伏笔 | P0 |
| `novel_create_conflict` | 写 | 创建新冲突 | P0 |
| `novel_create_clue` | 写 | 创建新线索 | P1 |
| `novel_create_relationship` | 写 | 创建新关系 | P1 |
| `novel_update_chapter_summary` | 写 | 更新章节摘要（替代 slice 200） | P1 |
| `novel_query_history` | 读 | 查询指定实体的变更历史 | P2 |

### 7.2 Store CRUD 补全

| 实体 | 缺失方法 | 补全后 |
|------|----------|--------|
| characters | update/delete/getById | ✅ 全 CRUD |
| relationships | update/delete/getById | ✅ 全 CRUD |
| foreshadowing | update/delete/getById | ✅ 全 CRUD |
| clues | update/delete/getById | ✅ 全 CRUD |
| conflicts | update/delete/getById | ✅ 全 CRUD |
| chapters | getById/updateContent | ✅ 全 CRUD |
| world_rules | update/delete | ✅ 全 CRUD |
| constraints | update/delete | ✅ 全 CRUD |
| info_layers | update/delete | ✅ 全 CRUD |
| style_guides | update/delete | ✅ 全 CRUD |

### 7.3 新增数据库迁移

Phase 1 新增 1 张表（画布位置）：

| 迁移 ID | 表名 | 说明 |
|---------|------|------|
| 027 | `novel_canvas_positions` | 画布节点位置持久化 |

### 7.4 实现阶段路线图

```
Phase 1：插件重构（后端）
├── 1.1 扩展 PluginContext（4 种新能力）
├── 1.2 修改 PluginManager 初始化时序
├── 1.3 将 novel 模块迁移为 novel-plugin
├── 1.4 从 app.ts 移除 novel 静态注册
├── 1.5 补全 Store CRUD
├── 1.6 新增创建类工具（4 个 P0）
└── 1.7 验证：现有 API + 工具调用正常

Phase 2：上下文缓存强化
├── 2.1 审查 PromptBuilder 确保静态/动态分离
├── 2.2 添加缓存诊断日志（systemHash/toolsHash）
├── 2.3 Tools schema 排序保障
└── 2.4 验证：跨章 systemHash 不变

Phase 3：多 Agent 编排
├── 3.1 定义 5 个 AgentConfig
├── 3.2 NovelEngine.createChapter 实现
├── 3.3 检查点机制（WebSocket 推送）
├── 3.4 Agent 间 Session 隔离
└── 3.5 验证：端到端创作流程

Phase 4：前端无限画布
├── 4.1 安装 React Flow + 依赖
├── 4.2 创建 novel-store（Zustand）
├── 4.3 画布主界面 + 自定义节点
├── 4.4 关系连线 + 布局算法
├── 4.5 右侧栏模式切换
├── 4.6 画布位置持久化
└── 4.7 验证：画布交互 + 数据同步

Phase 5：集成与优化
├── 5.1 Agent 执行进度可视化到画布
├── 5.2 章节正文实时渲染
├── 5.3 缓存命中率监控面板
├── 5.4 性能优化（大项目节点数 > 100）
└── 5.5 端到端测试
```

### 7.5 插件化对未来的意义

重构完成后，创建新工具插件的步骤：

```
1. 创建 plugins/xxx-plugin/ 目录
2. 编写 index.ts（实现 Plugin 接口）
3. 在 setup() 中注册需要的能力
4. PluginManager 自动发现并加载
```

未来可能的插件示例：
- `code-review-plugin`：代码审查工作台
- `data-analysis-plugin`：数据分析工作台
- `research-plugin`：研究助手工作台

每个插件都可以：注册自己的数据库表、Pi Session 工具、REST API 路由、前端面板，互不干扰。
