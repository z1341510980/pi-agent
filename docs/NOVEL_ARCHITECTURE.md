# AI 小说创作工作台 - 架构与实现文档

> 基于 `docs/ai_novel_creation_workbench_core_systems.md` 设计文档，结合 pi-agent 底座实现。

## 目录

1. [设计目标](#1-设计目标)
2. [架构总览](#2-架构总览)
3. [缓存优化策略（核心）](#3-缓存优化策略核心)
4. [模块清单](#4-模块清单)
5. [数据库设计](#5-数据库设计)
6. [提示词模板系统](#6-提示词模板系统)
7. [工具调用与缓存命中](#7-工具调用与缓存命中)
8. [多 Agent 协作](#8-多-agent-协作)
9. [API 路由](#9-api-路由)
10. [与设计文档的映射](#10-与设计文档的映射)
11. [已知限制与后续工作](#11-已知限制与后续工作)

---

## 1. 设计目标

- **长期创作不崩**：通过故事状态系统维护运行时状态，避免设定漂移
- **缓存命中率最大化**：提示词分层（STATIC/SEMI/DYNAMIC），降低长篇创作成本
- **提示词可配置**：不写死在代码中，支持三级覆盖（默认文件 → 项目文件 → SQLite）
- **职责隔离**：多 Agent 协作，每个 Agent 只负责一件事
- **与底座集成**：复用 pi-agent 的 Pi SDK、AG-UI、Plugin、Store 模式

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     Desktop (React + Zustand)                │
│   novel-store.ts (前端)  ←────────────→  novel API           │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / SSE
┌──────────────────────────▼──────────────────────────────────┐
│                    agent-server (Fastify)                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  novel.route.ts  ←→  novel.plugin.ts (Fastify 装饰器)  │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│  ┌──────────────────────────▼─────────────────────────────┐  │
│  │              NovelEngine (流程编排)                      │  │
│  │  createChapter → completeChapter → publishChapter       │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│  ┌──────────────────────────▼─────────────────────────────┐  │
│  │           NovelSessionFactory (Session 工厂)            │  │
│  │  buildSystemPrompt  +  buildChapterContext  +  tools    │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│  ┌──────────────────┬───────┴────────┬────────────────────┐  │
│  │  PromptManager  │ NovelPromptBuilder │  NovelStore     │  │
│  │  (模板三级覆盖)  │ (缓存分层构建)    │  (SQLite CRUD)   │  │
│  └──────────────────┴────────────────┴────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              novel-tools.ts (6 个工具)                  │  │
│  │  query_state / update_character / update_foreshadow     │  │
│  │  update_conflict / update_clue / update_relationship    │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 缓存优化策略（核心）

### 3.1 三层缓存模型

| 层级 | 位置 | 内容 | 缓存周期 |
|------|------|------|----------|
| **STATIC** | 系统提示词 | Agent 身份、世界规则、风格指南、角色定义（静态部分） | 跨章节命中 |
| **SEMI** | 首条用户消息 | 章节信息、约束、故事状态、信息差、摘要、指令 | 单章内命中 |
| **DYNAMIC** | 对话消息 | 工具调用结果、生成内容 | 不缓存 |

### 3.2 提示词结构

```
[系统提示词] STATIC  ← 跨章节缓存命中
├── Layer 0: Agent 身份（永不变）
├── Layer 1: 世界规则（项目级，极少变）
├── Layer 2: 风格指南（项目级，极少变）
└── Layer 3: 角色定义（仅静态部分：身份/性格/外貌/说话风格）

[首条用户消息] SEMI  ← 单章内缓存命中
├── 章节信息（卷/章/叙事任务/约束）
├── 当前故事状态（角色动态状态/冲突/伏笔/线索）
├── 信息差（谁知道什么）
├── 最近章节摘要
└── 创作指令

[对话消息] DYNAMIC  ← 不缓存
├── 工具调用 + 结果（追加到末尾，不破坏前缀缓存）
├── 生成内容
└── 用户引导
```

### 3.3 关键设计决策

1. **系统提示词只含静态数据**：角色定义只包含身份/性格/外貌/说话风格，不包含动态状态（情绪/目标/压力/秘密/弧光阶段）
2. **章节上下文作为首条消息**：动态状态放在 SEMI 层，单章内不变
3. **工具结果追加到末尾**：不修改已发送的系统提示词和章节上下文
4. **状态更新延迟生效**：工具更新立即写入 DB，但当前章节的提示词不变，下一章新 Session 才体现

---

## 4. 模块清单

### 4.1 核心模块 (`apps/agent-server/src/core/novel/`)

| 文件 | 职责 |
|------|------|
| `types.ts` | 15 大系统的 TypeScript 类型定义 + `CacheLayer` |
| `prompt-manager.ts` | 提示词模板管理器（三级覆盖 + `{{variable}}` 占位符） |
| `prompt-builder.ts` | 缓存优化的提示词构建器（STATIC/SEMI/DYNAMIC 分层） |
| `novel-store.ts` | 统一存储，实现 `NovelPromptStores` 接口 + 全部 CRUD |
| `novel-tools.ts` | 6 个小说工具（查询/更新角色/伏笔/冲突/线索/关系） |
| `novel-session.ts` | Session 工厂，集成 Pi SDK |
| `novel-engine.ts` | 核心引擎，编排章节创作流程 |
| `index.ts` | 公共导出 |

### 4.2 提示词模板 (`prompts/`)

| 文件 | 用途 |
|------|------|
| `system-base.md` | 基础系统提示词（`{{agent_type}}` + `{{agent_role}}`） |
| `chapter-instruction.md` | 章节创作指令 |
| `role-director.md` | 导演 Agent 角色描述 |
| `role-settings.md` | 设定 Agent 角色描述 |
| `role-character.md` | 角色 Agent 角色描述 |
| `role-clue.md` | 线索 Agent 角色描述 |
| `role-writer.md` | 写作 Agent 角色描述 |
| `role-reviewer.md` | 审稿 Agent 角色描述 |
| `role-reviser.md` | 修订 Agent 角色描述 |
| `role-memory.md` | 记忆 Agent 角色描述 |

---

## 5. 数据库设计

### 5.1 迁移版本 013-026

| 迁移 ID | 表名 | 说明 |
|---------|------|------|
| 013 | `novel_projects` | 小说项目 |
| 014 | `novel_chapters` | 章节 |
| 015 | `novel_characters` | 角色 |
| 016 | `novel_relationships` | 角色关系 |
| 017 | `novel_foreshadowing` | 伏笔 |
| 018 | `novel_clues` | 线索 |
| 019 | `novel_conflicts` | 冲突 |
| 020 | `novel_world_rules` | 世界规则 |
| 021 | `novel_constraints` | 创作约束 |
| 022 | `novel_information_layers` | 信息差 |
| 023 | `novel_style_guides` | 风格指南 |
| 024 | `novel_author_intents` | 作者意图 |
| 025 | `novel_chapter_reviews` | 章节验收 |
| 026 | `novel_prompt_templates` | 提示词模板（运行时覆盖） |

### 5.2 设计要点

- 所有表以 `project_id` 作为外键，级联删除
- `novel_chapters` 有 `(project_id, chapter_number)` 唯一索引
- 布尔字段以 `INTEGER 0/1` 存储
- JSON 字段以 `TEXT` 存储（如 `arc_history`、`participants`）
- 时间戳使用 `unixepoch()` 秒级

---

## 6. 提示词模板系统

### 6.1 三级覆盖

```
优先级：SQLite 运行时 > 项目文件 > 默认文件
```

1. **默认文件**：`apps/agent-server/src/core/novel/prompts/*.md`
2. **项目文件**：`${cwd}/.pi/novel/prompts/*.md`
3. **SQLite 运行时**：`novel_prompt_templates` 表

### 6.2 占位符

模板支持 `{{variable}}` 和 `{{ variable }}` 两种格式，通过 `PromptManager.render()` 替换。

### 6.3 缓存

- 默认模板在构造时加载到内存
- 已解析模板缓存到内存，避免重复 IO
- `saveTemplate()` 后自动清除对应缓存

---

## 7. 工具调用与缓存命中

### 7.1 问题

工具调用后上下文变化，导致 LLM 提供商的 prompt cache 失效。

### 7.2 解决方案

```
[系统提示词] ← STATIC，工具更新状态不影响
[章节上下文] ← SEMI，已作为首条消息发送，不可变
[用户消息1] ← DYNAMIC
[助手消息1] ← DYNAMIC
[工具调用1] ← DYNAMIC（追加到末尾）
[工具结果1] ← DYNAMIC
[助手消息2] ← DYNAMIC
```

- **读工具**：查询 DB 最新状态，结果作为 tool message 追加
- **写工具**：更新 DB，返回确认信息作为 tool message 追加
- **前缀**（系统提示词 + 章节上下文）保持不变 → 缓存命中

### 7.3 工具列表

| 工具 | 类型 | 说明 |
|------|------|------|
| `novel_query_state` | 读 | 查询故事状态（角色/关系/冲突/伏笔/线索/规则/约束/信息差/风格） |
| `novel_update_character` | 写 | 更新角色动态状态 |
| `novel_update_foreshadow` | 写 | 更新伏笔状态 |
| `novel_update_conflict` | 写 | 更新冲突阶段和强度 |
| `novel_update_clue` | 写 | 更新线索进度 |
| `novel_update_relationship` | 写 | 更新关系阶段 |

---

## 8. 多 Agent 协作

### 8.1 Agent 职责划分

| Agent | 职责 | 对应设计文档系统 |
|-------|------|------------------|
| `director` | 判断章节任务和剧情阶段 | 叙事任务系统、节奏控制系统 |
| `settings` | 维护世界观和规则 | 世界规则系统 |
| `character` | 维护人物弧光和关系 | 角色弧光系统 |
| `clue` | 维护伏笔、线索、叙事债务 | 伏笔与回收系统、线索推进系统 |
| `writer` | 负责正文生成 | - |
| `reviewer` | 检查一致性和可读性 | 章节验收系统 |
| `reviser` | 根据审稿问题重写局部 | - |
| `memory` | 沉淀新状态，更新故事状态系统 | 长期记忆分层系统 |

### 8.2 创作流程

```
1. Director：分析故事状态 → 生成叙事任务和约束
2. Writer：根据任务和约束 → 创作章节正文
3. Reviewer：检查章节 → 生成验收报告
4. Reviser（可选）：根据审稿问题 → 重写局部
5. Memory：从章节中提取状态变更 → 更新故事状态系统
```

---

## 9. API 路由

### 9.1 项目管理

- `POST /api/novel/projects` - 创建项目
- `GET /api/novel/projects` - 列出项目
- `GET /api/novel/projects/:id` - 获取项目
- `PATCH /api/novel/projects/:id` - 更新项目
- `DELETE /api/novel/projects/:id` - 删除项目

### 9.2 章节管理

- `POST /api/novel/projects/:projectId/chapters` - 创建章节
- `GET /api/novel/projects/:projectId/chapters` - 列出章节
- `GET /api/novel/chapters/:id` - 获取章节
- `PATCH /api/novel/chapters/:id` - 更新章节
- `POST /api/novel/chapters/:id/publish` - 发布章节

### 9.3 故事元素

- `POST /api/novel/projects/:projectId/characters` - 创建角色
- `GET /api/novel/projects/:projectId/characters` - 列出角色
- `PATCH /api/novel/characters/:id` - 更新角色
- （伏笔/线索/冲突/关系/世界规则/风格/约束/信息差/意图 同理）

### 9.4 提示词模板

- `GET /api/novel/prompts` - 列出模板名称
- `GET /api/novel/prompts/:name` - 获取模板内容
- `PUT /api/novel/prompts/:name` - 保存模板

---

## 10. 与设计文档的映射

| 设计文档系统 | 实现位置 | 状态 |
|-------------|----------|------|
| 故事状态系统 | `novel-store.ts` + `novel_query_state` 工具 | ✅ 已实现 |
| 创作约束系统 | `novel_constraints` 表 + `ChapterConstraints` 类型 | ✅ 已实现 |
| 叙事任务系统 | `NarrativeTask` 类型 + `NovelEngine.createChapter` | ✅ 已实现 |
| 角色弧光系统 | `novel_characters` 表 + `novel_update_character` 工具 | ✅ 已实现 |
| 信息差系统 | `novel_information_layers` 表 + `formatInfoLayers` | ✅ 已实现 |
| 伏笔与回收系统 | `novel_foreshadowing` 表 + `novel_update_foreshadow` 工具 | ✅ 已实现 |
| 线索推进系统 | `novel_clues` 表 + `novel_update_clue` 工具 | ✅ 已实现 |
| 冲突升级系统 | `novel_conflicts` 表 + `novel_update_conflict` 工具 | ✅ 已实现 |
| 节奏控制系统 | `StoryStage` 类型 + 章节约束 | ⚠️ 基础实现 |
| 世界规则系统 | `novel_world_rules` 表 + `formatWorldRules` | ✅ 已实现 |
| 读者体验系统 | 章节验收评分维度 | ⚠️ 基础实现 |
| 章节验收系统 | `novel_chapter_reviews` 表 + `NovelEngine.saveReview` | ✅ 已实现 |
| 风格与文体系统 | `novel_style_guides` 表 + `formatStyleGuide` | ✅ 已实现 |
| 长期记忆分层系统 | `CacheLayer` 类型 + 提示词分层 | ⚠️ 基础实现 |
| 作者意图系统 | `novel_author_intents` 表 | ✅ 已实现 |
| 多 Agent 协作系统 | 8 个角色模板 + `NovelSessionFactory` | ⚠️ 基础实现 |

---

## 11. 已知限制与后续工作

### 11.1 当前限制

1. **NovelEngine 未直接调用 LLM**：`createChapter` 返回系统提示词和上下文，实际 LLM 调用由调用方通过 Pi SDK session 完成
2. **多 Agent 编排未自动化**：Agent 间的调度流程需要手动编排，未集成到 TeamManager
3. **节奏控制系统简化**：仅通过 `StoryStage` 枚举表示，未实现完整的节奏模型
4. **长期记忆分层未完整**：仅通过 `CacheLayer` 标记，未实现独立的记忆分层存储
5. **前端未实现**：当前只有后端 API，前端 novel-store 和 UI 组件未创建
6. **Store CRUD 不完整**：多数实体缺少 Update/Delete/Get(by id) 方法
7. **创建类工具缺失**：LLM 无法在创作过程中创建新伏笔/冲突/线索/角色
8. **章节摘要简化**：使用 content.slice(0, 200) 代替真正摘要

### 11.2 已修复的关键问题

1. ✅ **NovelSessionFactory 重复实例化**：已改为接收外部传入的 store 和 promptManager
2. ✅ **小说工具注入 Pi Session**：已通过 `novelTools` 参数注入 `createPiSession` 的 `customTools`
3. ✅ **novel-engine.ts bug**：`getChapter('', 0)` 调用错误已修复为 `getChapterById`
4. ✅ **novel-tools.ts bug**：`listForeshadowing('')` 查询错误已修复为 `getForeshadow`

### 11.3 后续工作

1. 集成 NovelEngine 与 Pi SDK session，实现端到端章节生成
2. 将多 Agent 编排集成到 TeamManager，实现自动化创作流程
3. 实现完整的节奏控制系统（章节节奏类型 + 节奏模型）
4. 实现独立的长期记忆分层存储
5. 补全 Store 的 Update/Delete/Get(by id) 方法
6. 补全 API 路由的 DELETE/PATCH/GET(by id) 端点
7. 新增创建类工具（让 LLM 能创建新伏笔/冲突/线索）
8. 创建前端 novel-store 和 UI 组件
9. 添加单元测试和集成测试
