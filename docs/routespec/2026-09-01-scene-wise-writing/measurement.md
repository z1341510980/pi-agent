# 按场生成对账记录

日期：2026-09-02

## 已完成的确定性验证

- `novel-orchestrator-run-context.test.ts`：24 tests passed，覆盖按场调用、上一场尾部承接、已完成场景跳过、单场就地重写和失败时快照保留。
- `scene-word-check.test.ts` + `writer-rewrite-plan.test.ts`：27 tests passed。
- `workflow-run-store.test.ts` + `chapter-scene-plan-adapter.test.ts`：21 tests passed。
- `novel-tools.test.ts` + `creation-flow-routes.test.ts`：36 tests passed。
- `pnpm --filter agent-server exec tsc --noEmit`：通过。

## 真实模型对账

本轮未执行真实第 1 章生成，因此没有填写场景字数、LLM 调用次数、token 总量或缓存命中率。当前运行环境无法写入 Pi 运行目录（`C:\Users\HUAWEI\.pi`），且未提供可用于稳定复现实测的模型配置；填入估算值会使本报告失真。

执行真实对账时需记录：

| 指标 | 基线 | 按场实现 |
| --- | --- | --- |
| 首稿总字数 | 4740 字（目标 3000） | 待实测 |
| Writer 初次调用数 | 1 | 场景数，待实测重写次数 |
| Writer 重写范围 | 可能整章 | 单场，待实测 |
| 输入/输出 token | 待从 agent logs 汇总 | 待从 agent logs 汇总 |
| prompt cache 命中率 | 待从 usage records 汇总 | 待从 usage records 汇总 |

## 全量回归备注

服务端全量运行结果为 225 个测试文件通过、3 个文件 7 项失败。失败原因是测试环境对 Pi 运行目录和 SQLite 数据目录的写权限限制（`EPERM` / `SQLITE_READONLY`），不是场景写作测试或相关业务断言失败。
