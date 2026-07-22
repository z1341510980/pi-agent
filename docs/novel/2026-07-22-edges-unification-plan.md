# 实体关联关系统一 - 实现计划

> 设计文档：`docs/novel/2026-07-22-edges-unification-design.md`
> 现状基础：GraphStore 已有 edges CRUD + 所有实体 store 已注入 deleteEdgesByEntity + REST API 已有基础路由

**目标：** 将 8 类小说要素的关联关系统一到 novel_edges 表，删除实体表 JSON 关联字段，补齐物品维度，修正工具查询状态倒灌漏洞。

**架构：** GraphStore 管理 edges 表（已存在），补充 listEdgesByEntity/updateEdgeLabel 方法。migration 074 搬数据，075 删字段+UNIQUE。删除旧的双向同步函数，工具查询走账本反推。

---

## 阶段 1：数据搬运 + GraphStore 扩展

### 任务 1.1：migration 074 数据搬运

**文件：** `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`

新增 migration 074，用 `json_each` + `INSERT OR IGNORE` 纯 SQL 搬运 7 类关联字段到 novel_edges。

### 任务 1.2：GraphStore 补充方法

**文件：** `apps/agent-server/src/plugins/novel-plugin/core/stores/graph-store.ts`

- `listEdgesByEntity(entityId, opts?)` — 按实体查边（双向）
- `updateEdgeLabel(edgeId, label)` — 更新 label

### 任务 1.3：novel-store.ts 暴露新方法 + REST API 扩展

**文件：**
- `apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts` — 暴露 listEdgesByEntity/updateEdgeLabel
- `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` — 扩展枚举（加 related/clue/item/info_layer/hook）+ 新增 PATCH /edges/:id + GET 支持 entityId 过滤

---

## 阶段 2：删除旧同步函数

### 任务 2.1：删除 conflict-store 同步函数

**文件：** `apps/agent-server/src/plugins/novel-plugin/core/stores/conflict-store.ts`

删除 `syncConflictParticipantsToCharacters`，createConflict/updateConflict/deleteConflict 中移除对 participatingConflicts 的同步。

### 任务 2.2：删除 foreshadow-store 同步函数

**文件：** `apps/agent-server/src/plugins/novel-plugin/core/stores/foreshadow-store.ts`

删除 `linkForeshadowToInfoLayer` / `pruneForeshadowFromInfoLayers` / `unlinkForeshadowFromInfoLayer` / `pruneInfoLayerFromForeshadows`。

---

## 阶段 3：后端字段读取改造

### 任务 3.1：移除后端对旧关联字段的读写

**文件：**
- `conflict-store.ts` — createConflict/updateConflict 的 SQL 移除 participants 字段（但保留 DB 列直到 075）
- `foreshadow-store.ts` — createForeshadow/updateForeshadow 的 SQL 移除 linked_characters/linked_clues/linked_info_layers
- `chapter-finalizer.ts` — 关联读取改为读 edges
- `novel-store.ts` — 聚合查询改为读 edges
- `novel-routes.ts` — 响应不再返回旧字段
- `novel-tools.ts` — 工具查询走账本反推

---

## 阶段 4：工具查询改造 + 维度补齐

### 任务 4.1：novel_ask_story 走账本反推

**文件：** `apps/agent-server/src/plugins/novel-plugin/core/novel-tools.ts`

answerCharacter/answerConflicts/answerForeshadows/answerClues 改为接收 chapterNumber，调用 getChapterStoryContext。

### 任务 4.2：Writer agent 加 maxToolCalls

**文件：** `apps/agent-server/src/plugins/novel-plugin/core/novel-agents.ts`

Writer 配置新增 maxToolCalls: 2。

### 任务 4.3：维度补齐

**文件：**
- `apps/agent-server/src/plugins/novel-plugin/core/novel-memory-store.ts` — DIMENSION_RULES 补齐 item_change + info_layer.reveal_chapter
- `apps/desktop/src/renderer/src/components/novel/matrix/inline-subtracks.tsx` — DIMENSION_LABELS 补齐

---

## 阶段 5：前端适配

### 任务 5.1：novel-client.ts 接口更新

**文件：** `apps/desktop/src/renderer/src/api/novel-client.ts`

删除关联字段，新增 NovelEdge 接口和 edges API 方法。

### 任务 5.2：shared 接口更新

**文件：** `packages/shared/src/novel/index.ts`

删除关联字段接口。

---

## 阶段 6：migration 075 删字段 + UNIQUE

### 任务 6.1：migration 075

**文件：** `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`

DROP COLUMN 所有关联字段 + 创建 UNIQUE INDEX。

---

## 验证

- `pnpm typecheck` 通过
- `pnpm test` 通过（更新涉及旧字段的测试）
- migration 074/075 幂等可执行
