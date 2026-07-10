# M7：ALTER TABLE 迁移幂等防御方案

> **状态**：方案记录，暂不实施
> **优先级**：中（规范要求，但当前迁移系统已提供基础幂等保证）
> **创建时间**：2026-07-06

## 一、问题描述

项目硬约束规定：「All database migrations must use `IF NOT EXISTS` to ensure idempotency」（所有数据库迁移必须使用 IF NOT EXISTS 保证幂等）。

但 SQLite **不支持** `ALTER TABLE ADD COLUMN IF NOT EXISTS` 语法，导致 `novel-migrations.ts` 中 31 条 `ALTER TABLE ADD COLUMN` 语句无法满足该规范。

### 1.1 涉及的迁移语句

| 迁移 ID | 表 | 新增列 | 行号 |
|---------|-----|--------|------|
| 013 | novel_conflicts | first_chapter, last_chapter, tier | 465-467 |
| 014 | novel_factions | first_chapter, last_chapter | 472-473 |
| 015 | novel_locations | appear_chapters | 478 |
| 016 | novel_characters | is_protagonist | 483 |
| 019 | novel_markers | entity_type, entity_id | 505-506 |
| 020 | novel_projects | outline | 511 |
| 022 | novel_chapters | outline, volume_id | 529-530 |
| 032 | novel_conflicts, novel_factions | chapter_spans | 558-559 |
| 034 | novel_projects | deleted_at | 573 |
| 035 | novel_chapters | tension | 579 |
| 036 | novel_characters | long_term_desire, plot_role, removal_impact | 587-589 |
| 037 | novel_relationships | dynamic_role, alignment, trend, chapter_hint, last_updated_chapter | 599-603 |
| 038 | novel_characters | participating_conflicts | 610 |
| 039 | novel_conflicts | plot_function, progression_mode | 620-621 |
| 040 | novel_foreshadowing | plant_method, recover_method | 630-631 |
| 042 | novel_foreshadowing, novel_information_layers | linked_info_layers, linked_foreshadows | 646-647 |

### 1.2 当前幂等机制

迁移系统通过 `migrations` 表按 `id` 跟踪已执行的迁移，每个迁移只执行一次。**正常流程下不会重复执行**。

### 1.3 风险场景

| 场景 | 触发条件 | 后果 |
|------|----------|------|
| migrations 表损坏 | 数据库文件被部分覆盖、手动删除 migrations 表 | 重新执行迁移 → "duplicate column name" 错误 → 启动失败 |
| 手动修复数据库 | 开发者手动添加列后重置 migrations 状态 | 同上 |
| 多实例并发启动 | 两个 agent-server 实例同时首次启动 | 迁移并发执行（现有锁机制可能已覆盖，但未验证） |

## 二、方案对比

### 方案 A：PRAGMA table_info 预检查（推荐）

在每条 `ALTER TABLE ADD COLUMN` 前用 `PRAGMA table_info(table)` 检查列是否已存在，存在则跳过。

**实现**：
```typescript
function addColumnIfNotExists(db: Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (columns.some((c) => c.name === column)) {
    return // 列已存在，跳过
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
```

**优点**：
- 纯 SQL 实现，无异常开销
- 语义清晰，符合"检查后执行"模式
- 表名通过 `PRAGMA table_info(?)` 参数化（但 SQLite PRAGMA 不支持参数绑定，需字符串拼接——已在 chapter-renumber.ts 的 IDENT_RE 校验模式中验证安全）

**缺点**：
- 需要为每条 ALTER 写一行检查代码，改动量大
- PRAGMA table_info 不支持参数绑定（SQLite 限制）

### 方案 B：TRY-CATCH 异常捕获

用事务包裹每条 ALTER，捕获 "duplicate column name" 异常。

**实现**：
```typescript
function safeAddColumn(db: Database, sql: string) {
  try {
    db.exec(sql)
  } catch (err) {
    if (!String(err).includes('duplicate column name')) {
      throw err // 非"列已存在"错误，重新抛出
    }
    // 列已存在，静默跳过
  }
}
```

**优点**：
- 改动最小，只需包裹现有 SQL 执行
- 不需要解析表结构

**缺点**：
- 用异常控制流程，性能略差（但迁移只执行一次，可忽略）
- 异常匹配字符串 "duplicate column name"，依赖 SQLite 错误消息格式（跨版本风险低，SQLite 错误消息稳定）

### 方案 C：迁移版本号校验增强

在迁移系统层面增加"迁移前校验"，对比数据库实际 schema 与预期 schema，自动跳过已应用的变更。

**优点**：通用性好，适用于所有迁移类型

**缺点**：
- 实现复杂度高，需要维护 schema 预期快照
- 过度设计，当前问题只需解决 ALTER TABLE 幂等

## 三、推荐方案

**推荐方案 B（TRY-CATCH 异常捕获）**，原因：
1. 改动最小，风险最低
2. SQLite 错误消息 "duplicate column name" 在所有版本中稳定
3. 不影响现有迁移系统的 id 跟踪机制
4. 可渐进式应用：只包裹 ALTER TABLE，其他 DDL 不变

## 四、实施细节

### 4.1 新增辅助函数

在 `novel-migrations.ts` 顶部新增：

```typescript
/**
 * 安全执行 ALTER TABLE ADD COLUMN：列已存在时静默跳过
 * 用于弥补 SQLite 不支持 ADD COLUMN IF NOT EXISTS 的限制
 */
function safeAlterTable(db: Database, sql: string): void {
  try {
    db.exec(sql)
  } catch (err) {
    const msg = String(err)
    // SQLite 错误码 1 (SQLITE_ERROR) + "duplicate column name"
    if (msg.includes('duplicate column name')) {
      return // 列已存在，幂等跳过
    }
    throw err
  }
}
```

### 4.2 改造迁移执行器

当前迁移执行逻辑（伪代码）：
```typescript
for (const migration of pendingMigrations) {
  db.exec(migration.sql)  // 直接执行
  db.prepare('INSERT INTO migrations (id) VALUES (?)').run(migration.id)
}
```

改造后：
```typescript
for (const migration of pendingMigrations) {
  if (migration.sql.includes('ALTER TABLE')) {
    // 逐条执行 ALTER，跳过已存在的列
    const statements = migration.sql.split(';').map(s => s.trim()).filter(Boolean)
    for (const stmt of statements) {
      safeAlterTable(db, stmt + ';')
    }
  } else {
    db.exec(migration.sql)
  }
  db.prepare('INSERT INTO migrations (id) VALUES (?)').run(migration.id)
}
```

### 4.3 测试方案

1. **正常流程测试**：全新数据库，执行所有迁移，验证 schema 正确
2. **幂等测试**：手动删除 migrations 表记录后重新启动，验证不报错
3. **部分应用测试**：手动添加某列后重置 migrations，验证跳过该列

## 五、决策建议

**建议暂不实施**，原因：
1. 当前迁移系统按 id 跟踪已提供基础幂等保证
2. migrations 表损坏是极端场景，概率极低
3. 实施风险虽低，但需要完整回归测试所有迁移

**触发条件**：当满足以下任一条件时启动实施：
- 出现 migrations 表损坏导致启动失败的实际案例
- 需要支持数据库手动修复后自动恢复
- 多实例并发启动场景上线（需配合迁移锁）

## 六、附录：其他数据库的兼容性参考

| 数据库 | 支持 ADD COLUMN IF NOT EXISTS |
|--------|------------------------------|
| PostgreSQL | ✅ 9.6+ |
| MySQL | ✅ 8.0+ |
| SQLite | ❌ 不支持 |
| SQL Server | ❌ 不支持（需 IF COL_LENGTH 检查） |

若未来迁移到 PostgreSQL/MySQL，可直接改回 `IF NOT EXISTS` 语法，移除 safeAlterTable。
