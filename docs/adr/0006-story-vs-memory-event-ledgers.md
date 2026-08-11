# StoryEvent 为语义账本，MemoryEvent 为操作审计

日期：2026-08-11 状态：已采纳（MemoryEvent 收敛待 T02-6 实施）

背景：novel_story_events 与 novel_memory_events 都在表达"这一章发生了什么"，职责重叠，存在删表合并的提议。

决策：StoryEvent 收敛为故事语义账本（故事世界里发生了什么：chapter/scene/type/title/summary/outcome/parent/entities），承接下一章故事、因果链、时间线、矩阵投影；MemoryEvent 收敛为记忆操作审计（系统如何从正文推导并应用了什么：operation create/update/link/unlink、target、before/after、reason、source），服务 Memory 调试、数据修复与补偿。消费者迁移完成后删除 MemoryEvent 中重复的语义字段，由 memoryOperationLedger flag 灰度。

理由：直接删除任一账本都会破坏历史追溯；职责收敛后两者互为审计依据（语义结果 vs 推导过程），Memory applyChanges 失败时可基于操作日志补偿而非依赖事务回滚。

反方观点：双账本写入成本增加。以"Memory 一次推导、两处落账（语义归 StoryEvent、操作归 MemoryEvent）"控制，不额外增加 LLM 调用。
