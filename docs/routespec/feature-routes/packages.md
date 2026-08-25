# workspace 共享包

### @repo/shared

- 描述：跨端共享类型与工具，按 agent / api / errors / events / novel / utils 分域。
- 核心：`packages/shared/src/index.ts`（聚合导出）
- 测试：`pnpm test:packages`（shared 有独立 `__tests__/`）
- 覆盖：partial
- last-updated: 2026-08-25

### @repo/protocol

- 描述：AG-UI 协议事件与 schema 定义。
- 核心：`packages/protocol/src/events.ts`、`schemas.ts`
- 测试：同包 `__tests__/`
- 覆盖：partial
- last-updated: 2026-08-25

### @repo/config

- 描述：共享工程配置（eslint/tsconfig）。
- 核心：`packages/config/src/browser/`、`shared/`
- 覆盖：uncertain —— 未确认具体导出形态
- last-updated: 2026-08-25
