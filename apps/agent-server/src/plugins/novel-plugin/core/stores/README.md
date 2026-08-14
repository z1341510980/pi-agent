# Novel Store Boundary

`core/stores` 保留领域层的稳定门面（Store API、领域对象转换和跨实体规则）。
数据库访问逐步迁移到 `../infrastructure/sqlite`：

- `schema/`：Drizzle SQLite 表映射。属性使用 camelCase，参数使用真实的 snake_case 列名。
- `repositories/`：查询、写入和 Row 映射；不处理边清理、章节投影等领域副作用。
- `client.ts`：把现有 `better-sqlite3` 连接适配成 Drizzle，连接生命周期仍由插件数据库层管理。

当前已迁移：`ProjectStore`、`entity-stores.ts` 中的 `ConflictStore` / `ItemStore` / `NarrativeStore`、`FactionStore`、`CharacterStore`（含 Relationship CRUD）、`ForeshadowStore`（含 Clue/InfoLayer CRUD）、`WorldStore`，`GraphStore` 的节点位置/标记/边/上下文指标/作者意图/章节审查基础 CRUD，`ChapterStore` 的章节查询/卷/钩子/角色弧光/正文版本行 CRUD，`EntityAppearanceStore` 的基础出场 CRUD，`EntityCandidateStore` 的候选/审核/晋升基础写入，`NarrativeLedgerStore` 的 Storyline/Progress 基础 CRUD，以及 `ScenePlanStore` 的计划/场景/场景版本/Cast 基础 CRUD。
`GraphStore` 的 AgentLog、压缩 payload 仍保留同步 SQL；这些操作涉及压缩冷热分离，不适合简单单表 Repository。

迁移完成后不直接删除仍有领域职责的 Store facade；基础 CRUD facade 可以按 bounded context 合并。例如冲突、物品和剧情轨道现在集中在 `entity-stores.ts`，但仍保留三个独立类和原有接口。删除目标是 Store 内已经被 Repository 替代的重复 SQL，而不是删除仍有领域职责的 facade。
其余 Store 仍使用现有同步 SQL，后续按垂直切片迁移，避免引入第二套迁移账本。

## Mapping contract

持久化映射遵循以下约定：

1. SQLite 表名、列名和现有 `novel-migrations.ts` 保持一致，不改动线上 schema。
2. Repository 返回现有 `row-types.ts` 的 snake_case 行，Store 再负责 JSON、布尔值和枚举的领域规范化。
3. 事务仍由 `NovelStore.withTransaction()` 使用原始连接控制；Drizzle 与 better-sqlite3 共享同一连接和事务边界。
4. 多态 edges、章节投影和账本引用继续由 Store/Facade 处理，不伪造数据库外键。

## Migration order

优先迁移 CRUD 密集且边界清晰的实体（项目、物品、冲突、势力/地点），再迁移章节/图/世界观等高耦合 Store。每个切片必须通过 `tsc` 和 NovelStore 回归测试后再继续。
