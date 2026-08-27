# 桌面宿主（Electron）

### Electron 主进程

- 描述：桌面应用生命周期管理、窗口/托盘/自动更新，并以子进程方式嵌入 agent-server。
- 入口：`apps/desktop/src/main/index.ts`
- 核心：
  - `apps/desktop/src/main/server.ts`（startEmbeddedServer：spawn agent-server；开发模式系统 Node + tsx，打包模式 ELECTRON_RUN_AS_NODE + bytenode .jsc）
  - `apps/desktop/src/main/tray.ts`、`auto-updater.ts`
- 备注：构建链路 `pnpm --filter desktop build` = typecheck → rebuild:sqlite → build:server（bytenode + collect-deps）→ electron-vite build。
- 覆盖：partial
- last-updated: 2026-08-25

### Preload 桥接

- 描述：renderer 与主进程的安全桥接 API。
- 核心：`apps/desktop/src/preload/index.ts`（类型声明在同目录 `index.d.ts`）
- 覆盖：uncertain —— 未确认具体暴露的 API 面
- last-updated: 2026-08-25

### Renderer（React SPA）

- 描述：React 19 + zustand + TanStack Query 前端；CopilotKit 接入；含小说工作台 UI。
- 入口：`apps/desktop/src/renderer/src/main.tsx` → `App.tsx`
- 核心：
  - `src/renderer/src/stores/`（zustand 状态）
  - `src/renderer/src/api/`（服务端 client）
  - `src/renderer/src/components/`、`ui/`（组件库）、`hooks/`、`onboarding/`、`i18n/`
- 测试：`apps/desktop/src/test/setup.ts`；组件测试 `App.test.tsx`、CSP 测试 `csp.test.ts`（jsdom 环境，`pnpm test:desktop`）
- 备注：本次未深入各页面组件定位，后续触碰具体页面时补全条目。
- 覆盖：partial
- last-updated: 2026-08-25

### Agent 终端执行器

- 描述：设置 Agent `bash` 工具在 Windows 上使用的终端，可选 Git Bash、PowerShell、cmd 或 WSL；配置持久化到 SQLite，变更后使空闲会话重建。
- 页面入口：`apps/desktop/src/renderer/src/components/settings/general-settings.tsx`（通用设置 → 终端执行器）
- API 入口：`apps/agent-server/src/routes/settings.route.ts`（`GET/PUT /api/settings/terminal`）
- 核心：`apps/agent-server/src/core/config/terminal-shell.ts`、`apps/agent-server/src/core/agent/pi-session.ts`、`apps/agent-server/src/core/config/provider-config-store.ts`
- 测试：`apps/agent-server/src/core/config/terminal-shell.test.ts`、`apps/agent-server/src/__tests__/provider-route.test.ts`
- 备注：默认 `git-bash`；SDK 的 Bash 工具通过宿主适配器为不同终端组装启动参数。
- 覆盖：sufficient
- last-updated: 2026-08-27
