# novel-migration-tools：对账 / 报表脚本

本目录存放 P0/P1 结构迁移的**只读**对账与报表脚本，复用 `scripts/e2e-test/lib/db-verify.mjs`
的数据库打开方式（默认 `~/.pi/wenlang-agent.db`，可用 `PI_DATA_DIR` 环境变量覆盖）。

## 通用约定

- **只读**：对账脚本只做 SELECT / 解压回读，**不写业务表**（唯一例外：cleanup 脚本按保留策略删除过期 payload，需显式 `--apply` 才执行删除）。
- **输出**：JSON 报告写到 `scripts/novel-migration-tools/output/`（目录不存在会自动创建）；CSV 导出同目录。
- **退出码**：验收通过（mismatch/orphan/duplicate 全 0）返回 0，否则返回 1，便于 CI 接入。
- **运行方式**：`node scripts/novel-migration-tools/<name>.mjs [projectId] [--json|--csv]`（部分脚本参数见各文件头注释）。

## 脚本清单

| 脚本 | 用途 | 对应迁移 |
|---|---|---|
| `reconcile-version-chains.mjs` | 新旧正文版本链按 (chapter_id, content sha256) 对账 | P1-1 |
| `verify-log-payloads.mjs` | payload gzip 解压回读，content_hash + 字段完整性校验 | P1-2 |
| `cleanup-log-payloads.mjs` | 按保留策略清理过期 payload（元数据不删） | P1-2 |
| `reconcile-scene-cast.mjs` | novel_scene_focus/presence/functions → novel_scene_cast 往返对账 | P1-3 |
| `scan-deprecated-columns.mjs` | 删除前引用扫描（业务代码 + SQL + e2e 断言） | P1-4 |
| `cost-report.mjs` | 按 project_id + chapter_number 输出成本报表（JSON/CSV） | P0-2 |
| `sample-baseline.mjs` | 按采样要求跑批，落盘基线报告（docs/novel） | P0-4 |

## 输出格式约定

- JSON 报告统一包含 `report` 字段（含 `MigrationAcceptance` 或指标对象）与 `acceptance` 布尔值。
- 所有日期时间戳为 Unix 秒（与主库一致）。
- 报表列名见各脚本头部注释，CSV 首行为表头。

## 新增脚本要求

- 每个对账脚本必须产出 `MigrationAcceptance`（见 `core/migration-acceptance.ts`），
  三项计数 = 0 且 `rollbackVerified = true` 才算 PASS。
- 不要在生产库上执行破坏性操作；先 `--dry-run`（默认），确认后再 `--apply`。
