# 生成链路专项审查与修复概览

## 完成内容

已完成统一方案生成链路的源码核查、缺陷修复和最终验证，并生成：

- `docs/novel/2026-08-11-生成链路专项审查.md`
- 更新 `docs/novel/2026-08-11-统一方案落地核查报告.md`

## 核心修复

- Writer pushback 重跑 Director 后补 ScenePlan V2 影子写。
- Appearance 补齐 item/narrative sync 双写、Character/章节删除级联。
- Chunk versionKey 补齐 Memory、章节正文/计划、Hooks、信息层失效维度。
- ChunkCache 增加容量上限、淘汰统计和项目删除清理。
- Chunk 缓存重构为真正的"先查后建"：命中后不执行 chunk 构建函数。
- `contextSummaryMode` 接入生产生成路径，并隔离 full/summary 缓存。
- identity-contract 守卫下沉到 `buildAgentIdentity`，覆盖全部消费方。
- P3 灰度报告改用真实章纲和 Engine 约束。

## 2026-08-12 补干项

- `memoryOperationLedger` 操作审计：迁移 094 建 run/operation 两表，operation 与实体写同事务，失败 run 标记 failed 留痕；flag 关零写、开双写。
- T03-7 预算降级接入生成链：`materializeDegradedChunks` 物化 summary/keepOne，五级仍超限阻止生成；`CreationOptions.contextBudgetTokens` 显式驱动。
- `novel_ask_story` 运行时计数强制：per-run 工具包装，超限返回可理解结果，不触发 SDK 重试。
- Memory 中途失败专项测试（generate 抛错/error status 两种路径）。

## 验证

- 后端 TypeScript：0 错误。
- 前端 TypeScript：0 错误。
- 后端全量测试：156 文件、1799 用例全部通过。
- Windows 下 Vitest 完成后仍有已知进程挂起，由 watchdog 确认结果后结束进程树，最终退出码 0。

## 后续事项

- P1 三条迁移在真实项目数据上对账后开 flag。
- §8 六类回归章节 fixture（最小可维护数据集合）。
- P4 Scene Level Writer 按计划暂缓（仅保持 ScenePlan 影子写一致）。
- 模型 contextWindow 统一暴露：预算降级已可显式驱动，底座提供窗口后由调用层覆盖。
