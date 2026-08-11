# 剧情推进模型重构方案更新概览

## 完成内容

已完整重写 `docs/novel/2026-08-05-剧情推进模型重构方案.md`。新方案不再任意指定现有表或运行对象为正确来源，而是从业务不变量重新设计规范数据模型、版本链、事务边界、运行快照和矩阵投影。

## 核心决策

- 数据分为规范事实表、运行时快照、投影/缓存三层。
- 引入不可变正文版本、计划版本、场景身份与场景版本。
- Director 普通流程和群聊模式统一使用 `ChapterScenePlan`。
- 单场景单 POV；群像使用 focus/present；功能角色使用 functional cast。
- `WordBudgetResolver` 唯一解析章节字数，Rhythm 不再修改字数。
- Scene、Progress、Event、EntityChange、Conflict、Clue 各自只保存其领域事实。
- Memory 确认与正文提交使用事务；矩阵通过 outbox 单向投影。
- 重跑、修订、回滚和中间章重写采用 revision、superseded、stale 语义。
- 历史 Scene/Progress 不做不可靠批量推断，保留只读兼容。

## 后续事项

需要确认 5 项产品决策：定位对字数的调整范围、omniscient 的角色关系约束、新实体是否默认人工审核、中间章重写后的重建触发方式、历史场景是否坚持不批量回填。确认后可按文档 T01-T05 分阶段实施。
