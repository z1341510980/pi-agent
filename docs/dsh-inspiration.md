# DeepSeek Harness 可借鉴方案

> 基于对 DSH 50+ 个包的深入探索，整理出 pi-agent 可借鉴的架构设计与实施方案。

## 一、DSH 核心设计理念

DSH 的架构围绕五个核心理念构建：

| 理念 | 实现方式 | pi-agent 对标状态 |
|------|----------|------------------|
| **一切皆可观察** | `session-query` + `tracing.ts` | ✅ 已实现 Tracer |
| **一切皆可配置** | `agent.cordis.yml` + `preset` | ✅ 已实现 `plugins.yml` |
| **一切皆可隔离** | `isolate` realm | ✅ 已实现 `entry.isolate` |
| **一切皆可追溯** | `sourceEventSeqs` + `foldSurface` | ⚠️ 部分实现 |
| **一切皆可组合** | 50+ 独立包 | ❌ 仅 3 个包 |

---

## 二、pi-agent 已实现对标功能

| 功能 | 文件 | 状态 |
|------|------|------|
| 配置驱动插件加载 | `config/plugins.yml` + `plugin-loader.plugin.ts` | ✅ |
| 服务容器 | `ctx.provide()` / `ctx.get()` | ✅ |
| Realm 隔离 | `entry.isolate` | ✅ |
| 热重载 | `pluginManager.reload()` | ✅ |
| 事件追踪模型 | `core/tracer/types.ts` | ✅ |
| 表面折叠 | `Tracer.foldSurface()` | ✅ |
| 追踪 API | `routes/trace.route.ts` | ��� |
| 构建工具 | `tsdown.config.ts` | ✅ |
| 工具调用卡片增强 | `tool-call-card.tsx` | ✅ |
| 相对时间显示 | `message-bubble.tsx` | ✅ |
| 思考过程可视化 | `thinking-block.tsx` | ✅ |

---

## 三、待实施功能（按优先级）

### P0 — 包拆分（3-5 人日）

**目标：** 将当前 3 个包拆分为 10+ 个独立包

**新包结构：**
```
packages/
├── core/              # 核心类型和接口
├── agent/             # Agent 运行时
├── session/           # 会话管理
├── tracer/            # 追踪系统
├── plugin/            # 插件系统
├── tools/             # 工具注册表
├── protocol/          # AG-UI 协议
├── shared/            # 共享工具
├── config/            # 配置管理
└── test-support/      # 测试工具
```

**实施步骤：**
1. 创建新包目录和 `package.json`
2. 移动对应源码并更新 import 路径
3. 配置 `tsdown.config.ts` 和 `tsconfig.json`
4. 更新根目录 `pnpm-workspace.yaml`
5. 验证 `pnpm build` 正常

---

### P0 — foldSurface 集成到 UI（2 人日）

**目标：** 用户编辑消息时，旧消息不被覆盖，可通过“查看历史版本”追溯

**实施步骤：**
1. 前端调用 `GET /api/traces/:traceId/surface` 获取当前表面事件
2. 消息列表根据 `surface` 事件渲染
3. 添加“查看历史版本”按钮，调用 `GET /api/traces/:traceId/trace-event/:seq`
4. 弹出对话框显示版本链

**API 端点（已实现）：**
```
GET  /api/traces/:traceId/surface         # 获取当前表面
GET  /api/traces/:traceId/trace-event/:seq # 追踪事件关系
```

---

### P1 — 预设继承/覆盖（2 人日）

**目标：** 支持预设组合和覆盖

**配置文件格式：**
```yaml
# config/plugins.yml
presets:
  base:
    plugins:
      - id: novel-plugin
        enabled: true

  advanced:
    extends: base
    plugins:
      - id: web-search-plugin
        enabled: true
      - id: novel-plugin
        config:
          maxChapters: 200  # 覆盖 base 配置
```

---

### P1 — E2E 测试（3 人日）

**目标：** 建立核心流程自动化测试

**技术选型：** Vitest + Playwright

**测试范围：**
1. 创建项目 → 生成章节 → 保存 → 查看追踪
2. 插件加载 → 服务注册 → 工具调用
3. UI 交互：消息发送 → 流式响应 → 工具调用卡片

---

### P2 — 日志导出 UI（2 人日）

**目标：** 导出追踪报告为 HTML/JSON

**参考 DSH：** `session-log-export`

**实施步骤：**
1. 在诊断弹框中添加“导出”按钮
2. 调用 `POST /api/traces/export` 生成报告
3. 下载为 HTML 文件（包含时间线、事件详情、耗时统计）

---

### P2 — 双面构建（1 人日）

**目标：** 同一份代码生成服务端/客户端产物

**实施方式：**
```typescript
// tsdown.config.ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  env: {
    DSH_BUILD_FACE: process.env.DSH_BUILD_FACE || 'host'
  }
})
```

---

## 四、DSH 关键源码参考

### 4.1 事件追踪模型 (tracing.ts)

```typescript
// DSH 的核心追踪接口
interface SessionEvent {
  seq: number                    // 全局递增序号
  sourceEventSeqs?: number[]     // 引用来源 → 有向图
}

// traceEvent 返回的关系链
function traceEvent(events, seq) {
  return {
    target: record,
    replacedBy: seq,              // 被谁替换
    replacementChain: [seq, ...], // 替换链
    sourceEventSeqs: [seq, ...],  // 来源事件
    derivedEventSeqs: [seq, ...]  // 派生事件
  }
}
```

### 4.2 预设系统 (agent-presets)

```typescript
// 预设挂载：一个预设 mount 一次，所有 session 共享
const mount = standingMountFor(presetId)
bindScopeParent(agentScope, mount.scope)

// 插件隔离：每个预设独立实例
isolate: true  // 在 agent.cordis.yml 中声明
```

### 4.3 表面折叠 (foldSurface)

```typescript
// 计算当前可见的“表面”事件
const surface = foldSurface(events)
// 返回当前可见的 seq 列表
// 被替换的事件通过 replacedBy 映射追踪
```

---

## 五、下一步行动

### 立即执行（本周）

| 步骤 | 任务 | 命令 |
|------|------|------|
| 1 | 创建包拆分目录结构 | `mkdir packages/{core,agent,session}` |
| 2 | 移动源码并更新 import | `git mv apps/agent-server/src/core/* packages/core/src/` |
| 3 | 配置 tsdown | 复制 `tsdown.config.ts` 到每个包 |
| 4 | 更新 workspace | 编辑 `pnpm-workspace.yaml` |
| 5 | 验证构建 | `pnpm build` |

### 近期规划（下周）

6. 实现 foldSurface UI 集成
7. 实现预设继承/覆盖
8. 搭建 E2E 测试框架

### 后续优化

9. 日志导出 UI
10. 双面构建
11. 持续优化包结构和依赖关系

---

## 六、总结

| 维度 | DSH 优势 | pi-agent 已实现 | 待实施 |
|------|----------|----------------|--------|
| 插件系统 | Cordis + isolate | ✅ 配置驱动 + 隔离 | ❌ 完整 Cordis 生态 |
| 追踪系统 | session-query + 有向图 | ✅ Tracer + 事件溯源 | ❌ foldSurface UI 集成 |
| 模块化 | 50+ 独立包 | ❌ 仅 3 个包 | ⚠️ 包拆分 |
| 构建工具 | tsdown + 双面构建 | ✅ tsdown | ❌ 双面构建 |
| 测试 | E2E + Web 测试 | ❌ 覆盖不足 | ⚠️ E2E 测试 |
| 配置 | YAML + 环境变量 | ✅ 部分实现 | ⚠️ 预设继承 |

**建议立即开始：** 包拆分和 foldSurface UI 集成，这两项对长期可维护性和用户体验影响最大。

---

*文档创建时间: 2026-08-19*
*基于 DSH 源码版本: 0.1.0-rc.7*