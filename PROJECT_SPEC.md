# wenlang-agent 项目规范文档

## 1. 项目概述

wenlang-agent 是一个基于 **pnpm monorepo** 的 AI Agent 桌面应用项目，包含以下核心组成部分：

| 模块 | 路径 | 描述 |
|------|------|------|
| **agent-server** | `apps/agent-server/` | Fastify 后端服务，提供 AG-UI 协议与 CopilotKit 运行时接口 |
| **desktop** | `apps/desktop/` | Electron 桌面客户端，基于 React + TypeScript |
| **@repo/config** | `packages/config/` | 共享配置包（Zod Schema，按 browser / node / shared 分端导出） |
| **@repo/shared** | `packages/shared/` | 共享类型与工具库（agent、agui、api、errors） |

## 2. 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 包管理 | pnpm | workspace monorepo |
| 语言 | TypeScript | ^5.9.3 |
| 运行时 | Node.js（服务端） / Electron 39（客户端） | — |
| 前端框架 | React | ^19.2.7 |
| 后端框架 | Fastify | ^5.8.5 |
| AI 协议 | AG-UI、CopilotKit Runtime | — |
| 数据校验 | Zod | ^4.4.3 |
| 状态管理 | TanStack React Query | ^5.101.0 |
| 代码规范 | ESLint 9（Flat Config）、Prettier 3 | — |
| 构建工具 | electron-vite、vite 7、tsx | — |

## 3. 目录结构规范

```
wenlang-agent/
├── apps/                          # 应用层（可独立运行的程序）
│   ├── agent-server/              # 后端服务
│   │   ├── src/
│   │   │   ├── agents/            # Agent 定义
│   │   │   ├── lib/               # 工具函数（响应封装、SSE、校验）
│   │   │   ├── plugins/           # Fastify 插件（CORS、错误处理等）
│   │   │   ├── routes/            # 路由定义（AG-UI、CopilotKit、Health）
│   │   │   ├── types/             # 类型声明扩展
│   │   │   ├── app.ts             # Fastify 应用实例
│   │   │   └── index.ts           # 入口文件
│   │   ├── .env                   # 环境变量
│   │   └── package.json
│   └── desktop/                   # 桌面客户端
│       ├── src/
│       │   ├── main/              # Electron 主进程
│       │   ├── preload/           # Electron Preload 脚本
│       │   └── renderer/          # 渲染进程（React 前端）
│       │       ├── api/           # API 客户端封装
│       │       ├── assets/        # 静态资源
│       │       ├── App.tsx        # 根组件
│       │       └── main.tsx       # 渲染进程入口
│       └── package.json
├── packages/                      # 共享包（不可独立运行）
│   ├── config/                    # 配置 Schema 包
│   │   └── src/
│   │       ├── browser/           # 浏览器端配置
│   │       ├── node/              # Node 端配置
│   │       └── shared/            # 通用配置
│   └── shared/                    # 共享类型与工具
│       └── src/
│           ├── agent/             # Agent 消息、运行 Schema
│           ├── agui/              # AG-UI 事件定义
│           ├── api/               # API 响应、分页
│           └── errors/            # 错误码定义
├── package.json                   # 根 workspace 配置
├── pnpm-workspace.yaml            # pnpm workspace 定义
├── .npmrc                         # pnpm 配置
└── pnpm-lock.yaml                 # 锁定依赖版本
```

### 3.1 命名约定

| 层级 | 规则 | 示例 |
|------|------|------|
| 目录 | kebab-case | `agent-server`、`packages/shared/` |
| 文件 | kebab-case | `api-response.ts`、`cors.plugin.ts` |
| 组件（React） | PascalCase | `App.tsx` |
| 类型/接口 | PascalCase | `ApiResponse`、`AgentRun` |
| 变量/函数 | camelCase | `validateRequest`、`sseStream` |
| 常量 | UPPER_SNAKE_CASE | `API_BASE_URL` |
| 环境变量 | UPPER_SNAKE_CASE | `OPENAI_API_KEY` |

## 4. 代码规范

### 4.1 TypeScript 配置

**agent-server（服务端）**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

**desktop（客户端）**
- 使用 solution-style tsconfig（`tsconfig.json` 引用 `tsconfig.node.json` + `tsconfig.web.json`）
- 主进程与渲染进程类型检查分离

### 4.2 ESLint 配置

- ESLint 9 Flat Config（`eslint.config.mjs`）
- 基于 `@electron-toolkit/eslint-config-ts` 的 TypeScript 规则
- Vue 支持（`eslint-plugin-vue` flat/recommended）
- Prettier 集成（`@electron-toolkit/eslint-config-prettier`）

忽略路径：
```js
{ ignores: ['**/node_modules', '**/dist', '**/out'] }
```

### 4.3 Prettier 配置

```yaml
singleQuote: true      # 单引号
semi: false            # 不加分号
printWidth: 100        # 行宽 100
trailingComma: none    # 不加尾逗号
```

### 4.4 EditorConfig

```ini
[*]
charset = utf-8
indent_style = space
indent_size = 2
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
```

## 5. Monorepo 规范

### 5.1 pnpm Workspace

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### 5.2 包引用方式

```json
// 跨包引用使用 workspace: 协议
{
  "dependencies": {
    "@repo/config": "workspace:*",
    "@repo/shared": "workspace:*"
  }
}
```

### 5.3 包导出约定

共享包使用 `exports` 字段定义子路径导出：

```json
// packages/config/package.json
{
  "exports": {
    "./browser": "./src/browser/index.ts",
    "./node": "./src/node/index.ts",
    "./shared": "./src/shared/index.ts"
  }
}
```

```json
// packages/shared/package.json
{
  "exports": {
    ".": "./src/index.ts",
    "./api": "./src/api/index.ts",
    "./errors": "./src/errors/index.ts",
    "./agent": "./src/agent/index.ts",
    "./agui": "./src/agui/index.ts"
  }
}
```

### 5.4 依赖覆盖

```yaml
# pnpm-workspace.yaml
overrides:
  "@copilotkit/runtime>zod": "3.25.76"
```

## 6. 脚本命令规范

### 6.1 根级别脚本

```bash
pnpm dev:desktop    # 启动桌面客户端开发模式
pnpm dev:server     # 启动后端服务开发模式
```

### 6.2 桌面应用脚本

```bash
pnpm dev            # 启动 Electron 开发模式
pnpm start          # 预览构建产物
pnpm build          # 类型检查 + 构建
pnpm build:win      # 构建 Windows 安装包
pnpm build:mac      # 构建 macOS 安装包
pnpm build:linux    # 构建 Linux 安装包
pnpm lint           # ESLint 检查
pnpm format         # Prettier 格式化
pnpm typecheck      # 类型检查（node + web）
```

### 6.3 后端服务脚本

```bash
pnpm dev            # tsx watch 热重载开发
```

## 7. 架构规范

### 7.1 后端服务架构

```
index.ts          # 入口：启动 Fastify 服务器
  └── app.ts      # 创建 Fastify 实例，注册插件与路由
      ├── plugins/
      │   ├── cors.plugin.ts        # CORS 配置
      │   ├── error-handler.plugin.ts  # 全局错误处理
      │   └── request-context.plugin.ts  # 请求上下文
      ├── routes/
      │   ├── agui.route.ts         # AG-UI 协议路由
      │   ├── copilotkit.route.ts   # CopilotKit 路由
      │   └── health.route.ts       # 健康检查
      ├── agents/
      │   └── wenlang-agent.ts           # Agent 定义
      └── lib/
          ├── api-response.ts       # 统一响应格式
          ├── sse.ts                # Server-Sent Events
          └── validate.ts           # 请求校验
```

### 7.2 桌面应用架构

```
main/index.ts       # Electron 主进程：窗口管理、生命周期
preload/index.ts    # 预加载脚本：安全桥接
renderer/           # 渲染进程（React SPA）
  ├── api/          # API 客户端层（agui-client、http-client）
  ├── App.tsx       # 根组件
  └── main.tsx      # React 入口
```

### 7.3 共享库分层

```
@repo/shared/
  ├── agent/        # Agent 相关：消息格式、运行状态、Schema
  ├── agui/         # AG-UI 协议事件类型
  ├── api/          # API 工具：统一响应格式、分页
  └── errors/       # 错误码定义与错误类型

@repo/config/
  ├── shared/       # 浏览器和 Node 端通用的配置类型
  ├── node/         # Node 端配置 Schema（环境变量等）
  └── browser/      # 浏览器端配置 Schema
```

## 8. Git 工作流规范

### 8.1 分支策略

| 分支 | 用途 |
|------|------|
| `main` | 稳定分支，可部署/发布 |
| `dev` | 开发集成分支 |
| `feature/*` | 功能开发分支 |
| `fix/*` | Bug 修复分支 |
| `release/*` | 发布准备分支 |

### 8.2 Commit 消息规范（Conventional Commits）

```
<type>(<scope>): <subject>

<body>

<footer>
```

| type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构 |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `chore` | 构建/工具变更 |
| `ci` | CI 配置变更 |

示例：
```
feat(desktop): 添加 CopilotKit 对话界面
fix(agent-server): 修复 SSE 连接超时问题
chore: 升级 zod 至 4.4.3
```

## 9. 环境变量规范

### 9.1 配置文件

| 文件 | 用途 |
|------|------|
| `.env` | 通用环境变量（不提交） |
| `.env.development` | 开发环境（不提交） |
| `.env.production` | 生产环境（不提交） |

### 9.2 敏感信息

- `.env` 文件必须加入 `.gitignore`
- 敏感值（API Key、Token）不得提交至版本控制
- 使用 `.env.example` 提供变量名模板

## 10. 构建与发布规范

### 10.1 类型检查

构建前必须通过类型检查：

```bash
# 桌面应用
pnpm typecheck

# agent-server（由 tsconfig strict: true 保证）
```

### 10.2 构建产物

| 模块 | 输出目录 |
|------|----------|
| desktop（构建） | `out/main/`、`out/preload/`、`out/renderer/` |
| agent-server | `dist/`（由 tsconfig `outDir` 指定） |

### 10.3 打包产物

```bash
pnpm build:win      # dist/ 目录下生成 .exe 安装包
pnpm build:mac      # 生成 .dmg / .app
pnpm build:linux    # 生成 .AppImage / .deb
```

## 11. 代码审查规范

### 11.1 提交前自查

- [ ] 代码通过 ESLint 检查（`pnpm lint`）
- [ ] 代码通过 Prettier 格式化（`pnpm format`）
- [ ] TypeScript 类型检查通过（`pnpm typecheck`）
- [ ] 没有 console.log 等调试代码遗留
- [ ] 提交信息遵循 Conventional Commits 规范

### 11.2 Code Review 要点

- 类型安全：优先使用 Zod 做运行时校验，TypeScript 做编译时校验
- 错误处理：统一使用 `@repo/shared/errors` 定义的错误码
- API 响应：统一使用 `@repo/shared/api` 的响应格式
- 环境变量：敏感配置通过 `.env` 注入，不得硬编码
