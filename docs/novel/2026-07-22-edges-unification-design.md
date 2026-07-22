# 小说实体关联关系统一设计

> 日期：2026-07-22
> 主题：将 8 类小说要素（角色/冲突/伏笔/线索/物品/地点/信息差/势力）的关联关系统一到 `novel_edges` 表，删除实体表上的 JSON 关联字段与单 ID 字段，补齐物品维度，修正工具查询的状态倒灌漏洞。

## 背景与问题

### 现状：3 种关联存储方式并存

1. **实体字段 JSON 数组**（7 处）：`novel_foreshadowing.linked_characters`、`linked_clues`、`linked_info_layers`；`novel_information_layers.linked_foreshadows`；`novel_characters.participating_conflicts` 等
2. **实体字段单 ID**（5 处）：`novel_clues.linked_foreshadow`；`novel_hooks.linked_foreshadow_id`、`linked_conflict_id` 等
3. **通用 edges 表**（migration 033 已建）：`novel_edges`，含 15 种 edgeType，但仅有 2 处实现双向同步

### 3 类系统性问题

1. **类型-DB 严重不一致**：`NovelConflict` 接口有 10 个字段在 DB 无列，`ConflictStore.createConflict` 静默丢弃；`NovelForeshadow.resolutionPoints` 未持久化
2. **关联双向同步覆盖不全**：只有 `conflict↔character`（`syncConflictParticipantsToCharacters`）和 `foreshadow↔infoLayer`（`linkForeshadowToInfoLayer`）两处实现自动双向同步，其他关联单向存储，删除实体不清理引用
3. **JSON 字段查询性能差**：`pruneForeshadowFromInfoLayers` 用 `LIKE '%id%'` 模糊匹配，id="a1" 会误匹配 "a10"

### 状态倒灌漏洞

`novel_ask_story` 工具读取当前全局状态（`store.listCharacters(projectId)`），重写中间章节时如果 Writer 调用工具，会读到未来章节状态，与 prompt 注入的历史快照矛盾。Writer agent 无 `maxToolCalls` 限制，理论上可无限调用工具导致 token 翻倍。

## 设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 关联存储统一方向 | 统一到 edges 表 | 多对多结构天然适合边表，消除 3 种存储方式并存 |
| 迁移策略 | 硬切换：删字段 | 迁移数据到 edges 后 ALTER TABLE DROP COLUMN，不留兼容层 |
| edgeType 粒度 | 通用 `edge_type='related'` + `label` 语义描述 | 任意要素间可关联，用 label 区分性质（"参与冲突"/"关联伏笔"等） |
| 关联时间维度 | edges 存现状 + 账本记变化 | edges 表记录当前关联状态，novel_memory_events 账本记录关联变化历史 |
| UNIQUE 约束 | 加在 075 migration | 074 先搬数据（允许重复），075 删字段时同时加 UNIQUE，搬完后可先验证去重 |
| 实体删除级联 | 代码层 | 在各 store 的 delete 方法中调 `edgeStore.removeEdgesByEntity(id)`，便于测试调试 |
| 工具查询改造 | 走账本反推 + maxToolCalls:2 | `novel_ask_story` 改用 `getChapterStoryContext`，Writer agent 加工具调用上限 |
| 前端改造 | 纳入本轮 | 删字段后 TS 接口必须同步，否则编译报错 |

## 第 1 节：edges 表统一存储

### 1.1 表结构（migration 033 已建，本次不修改 schema）

```sql
CREATE TABLE novel_edges (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  source_type     TEXT NOT NULL,   -- character/conflict/foreshadow/clue/item/location/info_layer/faction/hook
  target_id       TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  edge_type       TEXT NOT NULL,   -- 统一用 'related'，保留旧枚举兼容
  label           TEXT NOT NULL DEFAULT '',  -- 语义描述："参与冲突"/"关联伏笔"/"承载信息差"等
  auto            INTEGER NOT NULL DEFAULT 0,  -- 0=手动, 1=迁移/自动生成
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE
);
```

### 1.2 UNIQUE 约束（migration 075 新增）

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_edges_unique
  ON novel_edges(project_id, source_id, target_id, edge_type);
```

同一对实体同一 edge_type 只能有一条边。label 变化走 `UPDATE` 而非 `INSERT`。

### 1.3 关联变化记录到账本

关联的建立/解除/性质变化，通过 `novel_memory_events` 账本记录，dimension 使用：

| dimension | valueType | 语义 |
|---|---|---|
| `edge.label` | enum | 关联性质变化（如"敌对→同盟"） |
| `edge.created` | reference | 关联建立 |
| `edge.removed` | reference | 关联解除 |

## 第 2 节：状态时间线感知

### 2.1 工具查询改造

`novel_ask_story` 工具不再读全局状态，改为走 `getChapterStoryContext`（账本反推）：

- **现状**：`answerCharacter`/`answerConflicts`/`answerForeshadows`/`answerClues` 调用 `store.listCharacters(projectId)` 等读取当前全局状态
- **改造后**：调用 `memoryStore.getChapterStoryContext(projectId, chapterNumber)`，从 `listChangeRecords({ beforeChapter: chapterNumber })` 反推章前状态
- **机制**：按 stateKey 去重保留最后值，构建 `stateBeforeChapter`，与 prompt 注入的历史快照一致

### 2.2 Writer agent 工具调用限制

```typescript
// novel-agents.ts Writer 配置
writer: {
  type: 'writer',
  tools: ['novel_ask_story'],
  roleTemplate: 'role-writer',
  temperature: 0.9,
  maxToolCalls: 2,  // 新增：限制工具调用次数，防止 token 翻倍
}
```

### 2.3 状态回退机制（已存在，无需修改）

- `getStoryState`（prompt-builder.ts L2316-2385）：重写中间章节时读第 N-1 章快照
- `historicalRewrite`（chapter-finalizer.ts L137-171）：跳过 Memory Agent + 实体状态写入 + 快照保存

## 第 3 节：子轨道维度覆盖

### 3.1 实体维度表（8 类实体）

| 实体 | 维度数 | 维度列表（中文 / 标识符 · valueType） |
|---|---|---|
| 角色 character | 7 | 弧光阶段 `arc_stage`·enum ｜ 当前目标 `goal`·text ｜ 当前压力 `pressure`·level ｜ 当前状态 `state`·text ｜ 认知转变 `cognition`·text ｜ 关联冲突 `conflict_link`·set ｜ 登场 `created`·reference |
| 冲突 conflict | 5 | 冲突阶段 `stage`·enum ｜ 张力强度 `intensity`·level ｜ 剧情功能 `plot_function`·enum ｜ 推进模式 `progression_mode`·enum ｜ 建立 `created`·reference |
| 伏笔 foreshadow | 5 | 事件链节点 `beat`·enum ｜ 回收章节 `payoff_chapter`·number ｜ 埋设手法 `plant_method`·text ｜ 回收手法 `recover_method`·text ｜ 埋设 `created`·reference |
| 线索 clue | 5 | 推进进度 `progress`·number ｜ 发现步骤 `step`·text ｜ 指向 `points_to`·text ｜ 误导性 `misleading`·enum ｜ 发现 `created`·reference |
| 势力 faction | 3 | 势力状态 `status`·enum ｜ 活动区间 `activity`·text ｜ 成立 `created`·reference |
| 地点 location | 3 | 场景状态 `status`·enum ｜ 场景出现 `appear`·set ｜ 首次出现 `created`·reference |
| 信息差 info_layer | 5 | 读者已知 `reader_knows`·enum ｜ 揭示状态 `revealed`·enum ｜ 揭示章节 `reveal_chapter`·number ｜ 关联线索 `links`·set ｜ 建立 `created`·reference |
| 物品 item（新增） | 5 | 持有者 `holder`·reference ｜ 物品状态 `status`·enum ｜ 功能定位 `function`·enum ｜ 出现记录 `appear`·set ｜ 首次出现 `created`·reference |

### 3.2 关系维度表（角色间关系的特化）

| 实体 | 维度数 | 维度列表 |
|---|---|---|
| 关系 relationship | 7 | 关系阶段 `stage`·enum ｜ 角色定位 `role`·text ｜ 阵营归属 `alignment`·enum ｜ 关系走向 `trend`·enum ｜ 关系提示 `hint`·text ｜ 关系更新 `updated`·number ｜ 建立 `created`·reference |

### 3.3 本次修复的 3 处不一致

1. **`item_change` 规则为空** → 新增 5 条规则到 `DIMENSION_RULES.item_change`
2. **`character.state` 标签缺失** → 前端 `DIMENSION_LABELS` 补齐 `'character.state': '当前状态'`
3. **`info_layer.revealed` 语义歧义** → 标签修正为"揭示状态"（enum），新增 `info_layer.reveal_chapter`·number（匹配 `revealChapter` 字段）

### 3.4 DIMENSION_RULES 新增内容

```typescript
// novel-memory-store.ts DIMENSION_RULES
item_change: [
  { dimension: 'item.holder', valueType: 'reference', matchFields: ['holder'] },
  { dimension: 'item.status', valueType: 'enum', matchFields: ['status'] },
  { dimension: 'item.function', valueType: 'enum', matchFields: ['function'] },
  { dimension: 'item.appear', valueType: 'set', matchFields: ['appearChapters'] },
  { dimension: 'item.created', valueType: 'reference', matchFields: ['name', 'holder', 'status'], isCreate: true },
],
// info_layer_change 新增：
{ dimension: 'info_layer.reveal_chapter', valueType: 'number', matchFields: ['revealChapter'] },
```

### 3.5 DIMENSION_LABELS 新增内容

```typescript
// inline-subtracks.tsx DIMENSION_LABELS
'character.state': '当前状态',
'info_layer.reveal_chapter': '揭示章节',
// item（新增）
'item.holder': '持有者',
'item.status': '物品状态',
'item.function': '功能定位',
'item.appear': '出现记录',
'item.created': '首次出现',
```

## 第 4 节：迁移脚本与数据搬运

### 4.1 需要迁移的字段清单

#### A. 实体间关联字段（迁移到 edges，迁移后删除）

| 来源表.字段 | 类型 | 目标 edges 行 |
|---|---|---|
| `novel_foreshadowing.linked_characters` | JSON 数组 | foreshadow → character, edge_type='related', label='关联角色' |
| `novel_foreshadowing.linked_clues` | JSON 数组 | foreshadow → clue, edge_type='related', label='关联线索' |
| `novel_foreshadowing.linked_info_layers` | JSON 数组 | foreshadow → info_layer, edge_type='related', label='承载信息差' |
| `novel_information_layers.linked_foreshadows` | JSON 数组 | **跳过**（与 foreshadow 侧互为镜像，只从 foreshadow 侧迁移避免重复） |
| `novel_characters.participating_conflicts` | JSON 数组 | character → conflict, edge_type='related', label='参与冲突' |
| `novel_clues.linked_foreshadow` | 单 ID | clue → foreshadow, edge_type='related', label='关联伏笔' |
| `novel_hooks.linked_foreshadow_id` | 单 ID | hook → foreshadow, edge_type='related', label='关联伏笔' |
| `novel_hooks.linked_conflict_id` | 单 ID | hook → conflict, edge_type='related', label='关联冲突' |

#### B. 章节出场/区间字段（不迁移，保留为实体属性）

| 字段 | 保留理由 |
|---|---|
| `novel_locations.appear_chapters` | location 自身出场章节列表，是实体属性 |
| `novel_conflicts.chapter_spans` / `first_chapter` / `last_chapter` | 冲突活跃区间 |
| `novel_factions.chapter_spans` / `first_chapter` / `last_chapter` | 势力活跃区间 |
| `novel_foreshadowing.chapter_spans` / `first_chapter` / `last_chapter` | 伏笔埋设/回收区间 |
| `novel_clues.chapter_spans` | 线索发现区间 |
| `novel_foreshadowing.beats` | 伏笔事件链节点（自身属性） |

### 4.2 Migration 074：数据搬运（纯 SQL + json_each）

`MigrationDefinition` 接口仅支持 `sql: string`，不支持 JS 函数。用 SQLite 的 `json_each` 表值函数实现纯 SQL 搬运，`lower(hex(randomblob(16)))` 生成唯一 ID。

```sql
-- 1. foreshadow → character（linked_characters JSON 数组）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), f.project_id, f.id, 'foreshadow', je.value, 'character', 'related', '关联角色', 1
FROM novel_foreshadowing f, json_each(f.linked_characters) je
WHERE f.linked_characters IS NOT NULL AND f.linked_characters != '[]';

-- 2. foreshadow → clue（linked_clues JSON 数组）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), f.project_id, f.id, 'foreshadow', je.value, 'clue', 'related', '关联线索', 1
FROM novel_foreshadowing f, json_each(f.linked_clues) je
WHERE f.linked_clues IS NOT NULL AND f.linked_clues != '[]';

-- 3. foreshadow → info_layer（linked_info_layers JSON 数组）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), f.project_id, f.id, 'foreshadow', je.value, 'info_layer', 'related', '承载信息差', 1
FROM novel_foreshadowing f, json_each(f.linked_info_layers) je
WHERE f.linked_info_layers IS NOT NULL AND f.linked_info_layers != '[]';

-- 4. character → conflict（participating_conflicts JSON 数组）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), c.project_id, c.id, 'character', je.value, 'conflict', 'related', '参与冲突', 1
FROM novel_characters c, json_each(c.participating_conflicts) je
WHERE c.participating_conflicts IS NOT NULL AND c.participating_conflicts != '[]';

-- 5. clue → foreshadow（linked_foreshadow 单 ID）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), cl.project_id, cl.id, 'clue', cl.linked_foreshadow, 'foreshadow', 'related', '关联伏笔', 1
FROM novel_clues cl
WHERE cl.linked_foreshadow IS NOT NULL AND cl.linked_foreshadow != '';

-- 6. hook → foreshadow（linked_foreshadow_id 单 ID）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), h.project_id, h.id, 'hook', h.linked_foreshadow_id, 'foreshadow', 'related', '关联伏笔', 1
FROM novel_hooks h
WHERE h.linked_foreshadow_id IS NOT NULL AND h.linked_foreshadow_id != '';

-- 7. hook → conflict（linked_conflict_id 单 ID）
INSERT OR IGNORE INTO novel_edges (id, project_id, source_id, source_type, target_id, target_type, edge_type, label, auto)
SELECT lower(hex(randomblob(16))), h.project_id, h.id, 'hook', h.linked_conflict_id, 'conflict', 'related', '关联冲突', 1
FROM novel_hooks h
WHERE h.linked_conflict_id IS NOT NULL AND h.linked_conflict_id != '';
```

**注意**：`info_layer.linked_foreshadows` 跳过（与 foreshadow 侧互为镜像，只从 foreshadow 侧迁移避免重复）。`INSERT OR IGNORE` 防止意外重复。`randomblob(16)` 生成 32 字符十六进制 ID，碰撞概率极低。

### 4.3 Migration 075：删字段 + UNIQUE 约束

```typescript
{
  id: '075_drop_relation_fields_add_unique',
  sql: `
    -- 删除实体间关联字段
    ALTER TABLE novel_foreshadowing DROP COLUMN linked_characters;
    ALTER TABLE novel_foreshadowing DROP COLUMN linked_clues;
    ALTER TABLE novel_foreshadowing DROP COLUMN linked_info_layers;
    ALTER TABLE novel_information_layers DROP COLUMN linked_foreshadows;
    ALTER TABLE novel_characters DROP COLUMN participating_conflicts;
    ALTER TABLE novel_clues DROP COLUMN linked_foreshadow;
    ALTER TABLE novel_hooks DROP COLUMN linked_foreshadow_id;
    ALTER TABLE novel_hooks DROP COLUMN linked_conflict_id;

    -- 添加 UNIQUE 约束
    CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_edges_unique
      ON novel_edges(project_id, source_id, target_id, edge_type);
  `
}
```

### 4.4 迁移安全策略

- **分 2 个 migration**：074 搬数据（不加约束，允许重复）→ 验证 → 075 删字段 + 加 UNIQUE
- **空数据处理**：JSON 字段为 `'[]'` 或 NULL 时跳过；单 ID 字段为 NULL 时跳过
- **auto 标记**：迁移产生的 edges 行 `auto=1`，区别于手动创建的边
- **回滚兜底**：074 执行后可检查 edges 行数是否合理，确认后再执行 075

## 第 5 节：edges CRUD API + 实体删除级联

### 5.1 新建 `edge-store.ts`

文件路径：`apps/agent-server/src/plugins/novel-plugin/core/stores/edge-store.ts`

```typescript
export class EdgeStore {
  constructor(private db: Database) {}

  addEdge(input: {
    projectId: string
    sourceId: string
    sourceType: NovelEntityType
    targetId: string
    targetType: NovelEntityType
    edgeType?: string        // 默认 'related'
    label?: string           // 语义描述
    auto?: boolean           // 默认 false
  }): NovelEdge {
    // INSERT OR IGNORE（UNIQUE 约束保护）
    // 若已存在，UPDATE label
  }

  removeEdge(edgeId: string): void

  updateEdgeLabel(edgeId: string, label: string): void

  listEdgesByEntity(entityId: string, opts?: {
    direction?: 'source' | 'target' | 'both'  // 默认 'both'
    edgeType?: string
  }): NovelEdge[]

  listEdgesByProject(projectId: string, opts?: {
    edgeType?: string
    sourceType?: string
    targetType?: string
  }): NovelEdge[]

  removeEdgesByEntity(entityId: string): void {
    // DELETE FROM novel_edges WHERE source_id = ? OR target_id = ?
  }
}
```

### 5.2 实体删除级联（代码层）

在各实体 store 的 `deleteXxx` 方法中调用 `edgeStore.removeEdgesByEntity(id)`：

```typescript
// conflict-store.ts
deleteConflict(projectId: string, conflictId: string): void {
  this.db.prepare('DELETE FROM novel_conflicts WHERE id = ?').run(conflictId)
  this.edgeStore.removeEdgesByEntity(conflictId)  // 新增：级联清理 edges
}
```

所有实体 store（character/conflict/foreshadow/clue/item/location/info_layer/faction/hook）的 delete 方法均需添加此调用。

### 5.3 删除旧的同步函数

| 文件 | 删除的函数 |
|---|---|
| `conflict-store.ts` | `syncConflictParticipantsToCharacters` |
| `foreshadow-store.ts` | `linkForeshadowToInfoLayer` |
| `foreshadow-store.ts` | `pruneForeshadowFromInfoLayers` |

### 5.4 edges REST API

新增路由（`novel-routes.ts`）：

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/projects/:projectId/edges` | 创建边 |
| DELETE | `/edges/:edgeId` | 删除边 |
| PATCH | `/edges/:edgeId` | 更新 label |
| GET | `/projects/:projectId/edges` | 查询关联边（支持 `?entityId=xxx` 或 `?edgeType=xxx` 过滤） |

## 第 6 节：工具查询改造 + 前端适配

### 6.1 后端工具改造

**`novel-tools.ts` 改造**：

```typescript
// 现状：读全局状态
function answerCharacter(store, projectId, keyword) {
  const characters = store.listCharacters(projectId)  // 当前全局状态
  // ...
}

// 改造后：走账本反推
function answerCharacter(memoryStore, projectId, chapterNumber, keyword) {
  const ctx = memoryStore.getChapterStoryContext(projectId, chapterNumber)
  const characters = ctx.stateBeforeChapter.characters  // 章前状态
  // ...
}
```

`answerCharacter`/`answerConflicts`/`answerForeshadows`/`answerClues` 均改为接收 `chapterNumber` 参数，走 `getChapterStoryContext`。

**`novel-orchestrator.ts` 改造**：

Writer agent 调用时传入 `chapterNumber`，工具可读取当前章节的章前状态。

**`novel-agents.ts` 改造**：

Writer 配置新增 `maxToolCalls: 2`。

### 6.2 后端字段读取改造（6 处）

| 文件 | 改造内容 |
|---|---|
| `novel-tools.ts` | 工具查询走账本反推（见 6.1） |
| `novel-store.ts` | 聚合查询方法改为读 edges |
| `chapter-finalizer.ts` | 写章节时的关联读取改为读 edges |
| `conflict-store.ts` | 删除 `syncConflictParticipantsToCharacters`，关联走 edges |
| `foreshadow-store.ts` | 删除 `linkForeshadowToInfoLayer`/`pruneForeshadowFromInfoLayers`，关联走 edges |
| `novel-routes.ts` | API 路由响应不再返回 linkedCharacters 等字段，改为返回 edges |

### 6.3 前端适配

**`novel-client.ts` 改造**：

```typescript
// 删除 TS 接口中的关联字段
interface NovelForeshadow {
  // 删除：linkedCharacters?: string[]
  // 删除：linkedClues?: string[]
  // 删除：linkedInfoLayers?: string[]
}

interface NovelCharacter {
  // 删除：participatingConflicts?: string[]
}

interface NovelClue {
  // 删除：linkedForeshadow?: string
}

// 新增 edges API
interface NovelEdge {
  id: string
  projectId: string
  sourceId: string
  sourceType: string
  targetId: string
  targetType: string
  edgeType: string
  label: string
  auto: boolean
}

async getEdges(projectId: string, opts?: { entityId?: string }): Promise<NovelEdge[]>
async createEdge(projectId: string, input: Omit<NovelEdge, 'id' | 'projectId' | 'auto'>): Promise<NovelEdge>
async deleteEdge(edgeId: string): Promise<void>
async updateEdgeLabel(edgeId: string, label: string): Promise<void>
```

## 实施顺序

1. **migration 074**：数据搬运（先不删字段，先不加 UNIQUE）
2. **edge-store.ts**：新建 EdgeStore + CRUD 方法
3. **实体 store 改造**：各 delete 方法加级联清理，删除旧同步函数
4. **后端字段读取改造**：6 处文件改为读 edges
5. **工具查询改造**：`novel_ask_story` 走账本反推 + `maxToolCalls:2`
6. **维度补齐**：`DIMENSION_RULES` + `DIMENSION_LABELS` 补齐 item/character.state/info_layer.reveal_chapter
7. **前端适配**：`novel-client.ts` 删字段 + 新增 edges API
8. **edges REST API**：新增 4 个路由
9. **migration 075**：删字段 + UNIQUE 约束（最后执行，确保所有代码已不再依赖旧字段）

## 涉及文件清单

### 后端
- `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts` — 新增 migration 074、075
- `apps/agent-server/src/plugins/novel-plugin/core/stores/edge-store.ts` — **新建**
- `apps/agent-server/src/plugins/novel-plugin/core/stores/conflict-store.ts` — 删除同步函数，delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/stores/foreshadow-store.ts` — 删除同步函数，delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/stores/character-store.ts` — delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/stores/clue-store.ts` — delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/stores/location-store.ts` — delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/stores/faction-store.ts` — delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/stores/item-store.ts` — delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/stores/info-layer-store.ts` — delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/stores/hook-store.ts` — delete 加级联
- `apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts` — 聚合查询改为读 edges
- `apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts` — 工具查询走账本反推
- `apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts` — Writer 加 maxToolCalls:2
- `apps/agent-server/src/plugins/novel-plugin/core/novel-memory-store.ts` — DIMENSION_RULES 补齐 item/info_layer
- `apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts` — Writer 调用传 chapterNumber
- `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` — 新增 edges 路由，删除旧字段响应
- `apps/agent-server/src/core/agent/chapter-finalizer.ts` — 关联读取改为读 edges
- `apps/agent-server/src/__tests__/novel-store.test.ts` — 更新测试
- `apps/agent-server/src/__tests__/novel-memory-store.test.ts` — 新增 item 维度测试

### 前端
- `apps/desktop/src/renderer/src/api/novel-client.ts` — 删关联字段，新增 edges API
- `apps/desktop/src/renderer/src/components/novel/matrix/inline-subtracks.tsx` — DIMENSION_LABELS 补齐

### 共享
- `packages/shared/src/novel/index.ts` — 删除关联字段接口，新增 NovelEdge 接口

## 验收标准

1. migration 074 执行后，`novel_edges` 表包含所有原关联字段的数据，`auto=1`
2. migration 075 执行后，实体表不再有 linked_characters/linked_clues/linked_info_layers/participating_conflicts/linked_foreshadow/linked_foreshadow_id/linked_conflict_id 字段
3. UNIQUE 约束生效：同一对实体同一 edge_type 只能有一条边
4. 删除任意实体后，`novel_edges` 中相关边被清理
5. `novel_ask_story` 工具在重写中间章节时返回章前状态（非全局状态）
6. Writer agent 工具调用次数不超过 2
7. 物品实体有 5 个维度，子轨道可正常渲染
8. `character.state` 子轨道标签显示为"当前状态"
9. `info_layer.revealed` 子轨道标签显示为"揭示状态"（非"揭示章节"）
10. 前端编译通过，无 TS 类型错误
