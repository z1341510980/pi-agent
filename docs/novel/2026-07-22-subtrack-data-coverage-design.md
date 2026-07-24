# 子轨道数据覆盖修复方案（方案 C 混合）

日期：2026-07-22
状态：已批准，实施中
关联：`2026-07-22-matrix-redesign-spec.md`、`2026-07-22-subtrack-compact-design.md`

---

## 1. 问题

矩阵展开子轨道时，只有"角色"实体数据完整，其他实体（冲突/线索/伏笔/势力/地点/物品/世界要素/信息差）子轨道稀疏或为空。

## 2. 根因

系统无独立"变化记录表"，ChangeRecord = `novel_memory_events` 中 `dimension` 非空的行。
一条记录进入账本须闯三关，任一关漏掉该实体/字段即无数据：

1. **快照捕获** `captureEntityState`：只拍 8 类实体，`item / world_element` 从未被捕获
2. **字段 diff** `recordMemoryEvents`：每类只比对部分字段，`faction.strength` 等变了也静默丢弃
3. **dimension 推断** `inferDimension`：推不出存 null，被 `listChangeRecords` 的 `dimension IS NOT NULL` 过滤

角色"完整"因：diff 字段覆盖最全（7 字段 6 命中）+ 独享 `novel_character_history` 逐章打点。

缺口分三档：
- 完全缺失：`item`、`world_element`（规则是死代码）
- 字段不全：`faction.strength`、`conflict.currentStep/nextStep`
- Bug：`info_layer` 事件 entityType 误写成 `'relationship'`，按 info_layer 永查不到

## 3. 方案 C（混合）

前端投影做保底基线（存量立即生效），后端选择性修复高性价比缺口（未来数据逐步变丰富）。
合并策略：账本 ChangeRecord 优先（含前→后变化语义），实体字段补缺（同 dimension key 去重）。

### 3.1 前端（已实现）

`matrix-model.ts` 的 `buildSubtracksFromEntity`：从 MatrixEntity 自身透传字段构建保底子轨道，
覆盖全部实体类型。`buildSubtracksForEntity` 合并 changeTracks + entityTracks，key 去重、changes 优先。

| 实体 | 子轨道 | 编码 | 数据源字段 |
|---|---|---|---|
| 冲突 | 张力强度/关键转折/解决进度 | sparkline/圆点/sparkline | intensityPoints/turningPoints/resolutionProgress |
| 伏笔 | 事件链节点/回收进度 | 四态圆点/圆点 | foreshadowBeats/resolutionPoints |
| 线索/势力/物品 | 步骤/活动/持有 | enum 色块 | chapterSpans |
| 地点 | 出场记录 | 圆点 | appearChapters |
| 世界要素 | 常驻 | 色带 | alwaysStart..alwaysEnd |
| 角色 | 出场区间 | 色带 | characterSpans |

### 3.2 后端修复（本次实施，全部三处）

**修复 1 — info_layer entityType bug（零风险）**
`chapter-finalizer.ts` 第 929/942/953/966 行，4 处 `entityType: 'relationship'` → `'info_layer'`。
历史记录不回填，新章节正确。

**修复 2 — faction.strength 补 diff（极低风险）**
`chapter-finalizer.ts` faction.status diff 块后追加：`beforeFac.strength !== afterFac.strength`
时写一条 `faction_change` 事件，字段名 `strength`，命中 `DIMENSION_RULES` 的 `faction.strength`。

**修复 3 — item / world_element 纳入快照（低风险）**
1. `captureEntityState` 返回类型增加 `items` / `worldElements` Map + 快照逻辑
2. `recordMemoryEvents` 加两个 diff 循环：
   - item：diff `status` / `holder`（命中 item.status / item.holder）
   - world_element：仅记录"创建"事件（world_change 规则为空，暂不扩字段）

不改 memory-generator，不改 LLM 工具契约。

## 4. 验证

- typecheck（desktop + agent-server）
- 后端 chapter-finalizer 相关测试
- 人工验证：新建/推进各实体后展开子轨道有数据
