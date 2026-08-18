# Jeff 研发质量流程接入（研发侧，不进入小说产品运行时）

> 日期：2026-08-14
> 状态：流程约定（开发者在本地 Pi CLI 中使用），无服务端代码依赖

## 1. 定位

Jeff（[pi.dev](https://pi.dev/packages/@johanthoren/jeff) · [npm](https://www.npmjs.com/package/@johanthoren/jeff) · [repo](https://github.com/johanthoren/jeff)，v6.1.0，Apache-2.0，无 peer 依赖）是
model-native 的质量控制面与协作工作流协议，面向"可信操作者与友好 Agent"，不是安全沙箱。

在本项目中它只用于**研发质量流程**（评审、复核、发布门禁的协作层），
**绝不进入小说产品运行时**：产品运行时的质量门（PostWriteGuard、Reviewer 十维评分、
Reviser 定向修订）由领域编排器与 SQLite 账本自持，见方案文档 §2.1 分层边界。

## 2. 安装（本地 Pi CLI）

```bash
pi install npm:@johanthoren/jeff
# 更新 / 锁定版本
pi update npm:@johanthoren/jeff
pi install npm:@johanthoren/jeff@6.1.0
```

## 3. 在研发流程中的用法

| 环节 | 现有门禁（保留） | Jeff 的协作角色 |
| --- | --- | --- |
| 提交前 | `pnpm lint` / `tsc --noEmit` | 在 Pi 会话中请求 Jeff 对改动做预评审（builder ≠ judge） |
| 评审 | 人工 PR 评审 | Jeff 作为第二评审者复核变更与测试覆盖的一致性 |
| 发布门 | `pnpm --filter agent-server test:direct` 全绿 | Jeff 对发布清单做质量面确认（记录在案，不替代人工决策） |

使用要点：

- Jeff 是协作协议：把它当"复核者"而不是"构建者"——实现与评审分离；
- 门禁结论以本项目 CI/测试为准，Jeff 意见作为补充证据；
- 不在 `.env` / CI 中自动挂 Jeff：显式、按需使用。

## 4. 边界

- 不接入 `apps/agent-server` 服务端运行时（小说创作、群聊、反推、矩阵编排一律不用）；
- 不进入 `agent_call_logs` / 领域账本；
- 若未来需要"研发侧子 Agent 质量面"的自动化，走 `AgentRuntime` 注册表新 kind，另立方案。
