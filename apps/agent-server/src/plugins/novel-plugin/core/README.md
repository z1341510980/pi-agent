# Novel Core 分区

`core/` 按职责组织实现；顶层只保留跨域入口和事务编排器，不再保留迁移后的重复出口。

| 分区 | 责任 |
| --- | --- |
| `domain/` | 领域策略、Agent 配置、模型引用与契约 |
| `stores/` | 领域 Store facade；事务、跨表规则和对账仍在这里 |
| `chapters/` | 章节边界、版本链、场景计划、预算与章节聊天 |
| `prompting/` | Prompt 构建、上下文分块、预算、缓存与指标 |
| `memory/` | 记忆账本、变更应用、回填与清理 |
| `entities/` | 实体准入、编排、声音、相似度与策略 |
| `quality/` | 文本质量、陈词扫描、质量门与 LLM 错误策略 |
| `analysis/` | 引用分析、矩阵投影、关系图、一致性和迁移验收 |
| `discussion/` | 群聊适配器、历史、运行快照与角色讨论上下文 |
| `generation/` | 角色、实体与记忆生成流程 |
| `prompts/` | Markdown 提示词资源，保持资源路径稳定 |

暂留顶层的 `novel-store`、`novel-engine`、`novel-orchestrator`、`novel-memory-store`、`novel-tools` 属于跨域入口或事务编排器，暂不强行拆分。已完成迁移的顶层出口已删除，仓库内调用统一指向对应分区。

提示词构建的唯一实现和导入路径是 `prompting/prompt-builder.ts`；调用方直接依赖 prompting 分区，不保留顶层转发出口。
