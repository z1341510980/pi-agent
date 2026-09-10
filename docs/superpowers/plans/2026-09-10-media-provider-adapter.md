# 媒体生成 Provider 体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立统一媒体 Provider 体系：服务端适配器模式（openai-images/apimart 两 adapter 落地）+ media_providers 表与存量迁移 + 设置页「媒体生成」四模态分区（文字复用 provider-manager），画布配置弹窗迁入设置页。

**Architecture:** Adapter 声明 capabilities + formSchema，Registry 按模态+providerId 解析实例；store 仿 provider-config-store；旧 media-config 路由代理到 image 默认 Provider 兼容一版。规格：docs/superpowers/specs/2026-09-10-media-provider-adapter-design.md。

**Tech Stack:** Fastify + SQLite（better-sqlite3 同步迁移）、React 19 + react-hook-form + zod、Vitest。

---

## 文件边界

- Create: `apps/agent-server/src/core/media/adapter.ts`（接口与类型）
- Create: `apps/agent-server/src/core/media/shared.ts`（dataUrlToBlob/parseImages/withAbortGuard/轮询退避提取）
- Create: `apps/agent-server/src/core/media/adapters/openai-images.ts`
- Create: `apps/agent-server/src/core/media/adapters/apimart.ts`
- Create: `apps/agent-server/src/core/media/registry.ts`
- Create: `apps/agent-server/src/core/media/media-provider-store.ts`
- Create: `apps/agent-server/src/routes/media-provider.route.ts`
- Modify: `apps/agent-server/src/core/config/media-generator.ts`（瘦身为兼容 facade，内部委托 Registry；最终删除重复分支）
- Modify: `apps/agent-server/src/plugins/infinite-canvas-plugin/{index.ts,routes.ts,migrations.ts}`（链路切换 + 迁移 + 旧路由兼容）
- Modify: `apps/agent-server/src/app.ts`（组装 Registry + 新路由注册）
- Create: `apps/desktop/src/renderer/src/api/media-provider-client.ts`
- Create: `apps/desktop/src/renderer/src/components/settings/media-settings.tsx`（分区 + tabs + 图片 Provider 管理）
- Modify: `apps/desktop/src/renderer/src/components/settings/settings-page.tsx`
- Modify: `apps/desktop/src/renderer/src/components/infinite-canvas/{canvas-chrome.tsx,infinite-canvas-workspace.tsx}`（入口替换）
- Delete: `apps/desktop/src/renderer/src/components/infinite-canvas/media-config-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/api/infinite-canvas-client.ts`（清理 media-config 类型与调用）
- Tests: 对应 `__tests__`/`.test.ts`（服务端迁移现有 media-generator 测试为 adapter 测试）

### Task 1: 数据模型、store 与迁移

**Files:** Create `core/media/media-provider-store.ts`、`core/media/adapter.ts`；Modify `plugins/infinite-canvas-plugin/migrations.ts`（或宿主迁移文件——读现有迁移归属后放同层）；Test `core/media/__tests__/media-provider-store.test.ts`

- [ ] **Step 1: 写失败测试**——store CRUD：创建（image/openai-images）、列表按 modality 过滤、更新（空 apiKey 保留旧值）、删除、setDefault 事务（同模态唯一默认）、enabled=false 不参与 resolve 默认。
- [ ] **Step 2: 写迁移失败测试**——存量导入：`infinite_canvas_media_settings` 有配置行 → 生成 image 默认 Provider（id 前缀 `mig-canvas-`，adapter=其 imageProtocol，params 收 imageSize→size/imageResolution→resolution/imageLanguage→language）；providers 表带 mediaProtocol 的行 → `mig-provider-<id>`；重复执行幂等（不重复导入）；无存量时不产生行。
- [ ] **Step 3: 实现**——adapter.ts 定义 `MediaModality/AdapterId/MediaAdapterFormField/MediaProviderAdapter/MediaModalityContext/ResolvedMediaProvider/ImageGenerationInput` 等类型（字段见 spec §2）；store 仿 provider-config-store（同步 better-sqlite3）；迁移按现有 migrations 模式追加编号，读两来源表按 spec §1 规则写入。
- [ ] **Step 4: 运行聚焦测试 + `pnpm --filter agent-server exec tsc --noEmit` 通过后提交**（`feat: add media provider store and migration`）

### Task 2: shared 工具提取与 openai-images adapter

**Files:** Create `core/media/shared.ts`、`core/media/adapters/openai-images.ts`；Test `core/media/__tests__/openai-images-adapter.test.ts`

- [ ] **Step 1: 迁移现有测试**——把 media-generator.test.ts 中 openai-images 行为用例（生成 payload/size 白名单吸附/编辑三级回退含 multipart 记忆/404 回退/轮询/xKiro 默认模型 gpt-image 与 n=1）改写为 adapter 测试（构造 ctx 调 `adapter.generateImage/editImage`，fetch mock 沿用现模式）。先跑红。
- [ ] **Step 2: 提取 shared.ts**——从 media-generator.ts 移出 dataUrlToBlob/recordCandidates(parseImages)/withAbortGuard/轮询退避常量与函数（保持导出签名，media-generator 过渡期 re-export）。
- [ ] **Step 3: 实现 adapter**——`requestImageGeneration/requestImageEdit` 逻辑整体迁入（ctx.baseUrl/apiKey/model/params 替代 ImageRequestContext；探测缓存 Set 移入 adapter 闭包、键改 providerId+baseUrl；formSchema：baseUrl/key/model/size select[1024x1024,1792x1024,1024x1792,512x512]；capabilities: generate/edit/mask=true, analyze=true）。保持行为等价是硬约束：迁移用例全绿后不许出现语义 diff。
- [ ] **Step 4: 聚焦测试 + typecheck 后提交**（`feat: migrate openai-images adapter`）

### Task 3: apimart adapter 与 Registry

**Files:** Create `core/media/adapters/apimart.ts`、`core/media/registry.ts`；Test `core/media/__tests__/{apimart-adapter,registry}.test.ts`

- [ ] **Step 1: apimart 测试迁移**（现有 apimart 用例：payload 比例 size/resolution/image_urls、`/tasks/{id}?language=` 轮询、默认 gpt-image-2）→ adapter 测试；capabilities: generate/edit=false 语义（edit 走 generations+image_urls，mask 抛错）保持现状；formSchema：model/size 比例输入/resolution select[1k,2k,4k]/language text。
- [ ] **Step 2: Registry 实现**——register/listAdapters/resolve（providerId 精确 → 模态 enabled 默认 → throw `该模态尚未配置生成 Provider，请到 设置 → 媒体生成 配置`）；text 模态 resolve 桥接 provider-config-store（本阶段无调用方，仅实现 + 单测）。
- [ ] **Step 3: 聚焦测试 + typecheck 后提交**（`feat: add apimart adapter and media provider registry`）

### Task 4: 路由与链路切换

**Files:** Create `routes/media-provider.route.ts`；Modify `app.ts`、`core/config/media-generator.ts`、`plugins/infinite-canvas-plugin/{index.ts,routes.ts}`；Test `routes/__tests__/media-provider.route.test.ts`（读现有 provider.route 测试位置与模式后对齐）

- [ ] **Step 1: REST 路由**——`GET /api/media-providers?modality=`、`POST /api/media-providers`、`PATCH /api/media-providers/:id`、`DELETE /api/media-providers/:id`、`POST /api/media-providers/:id/default`；响应含 `adapters` 清单（modality→adapter 元数据+formSchema，供 UI 动态表单）；鉴权/错误响应模式照 provider.route.ts。空 apiKey 更新保留旧值（store 层已处理）。
- [ ] **Step 2: 链路切换**——app.ts 组装 Registry+store 注册路由；宿主 media facade（createMediaGenerator）内部改为经 Registry resolve→adapter（providerConfigStore 仅作 text 桥接与兜底读取迁移源）；插件 index.ts 删除手写 ImageRequestContext 与 generateImageWithOverride 双路（画布 providerId 透传给 resolve）；generate-media（audio/video）未配置统一报 spec 文案。media-generator.ts 收敛为薄兼容层（保留导出签名防外部引用，内部委托），其测试仅保留不再被 adapter 覆盖的公共工具用例。
- [ ] **Step 3: 旧路由兼容**——插件 routes.ts 的 GET/PUT /media-config 改为读/写 image 默认 Provider（字段映射 spec §6），注释 deprecated。
- [ ] **Step 4: 测试**——media-provider.route CRUD/默认/adapters 清单；generate-image 经 Registry（画布 providerId 命中/默认/未配置报错）；generate-media 文案；media-config GET/PUT 兼容映射；全量 agent-server 测试回归。提交（`feat: switch media generation to provider registry`）

### Task 5: 客户端 API 与设置页分区

**Files:** Create `api/media-provider-client.ts`、`components/settings/media-settings.tsx`；Modify `settings-page.tsx`；Test `components/settings/__tests__/media-settings.test.tsx`

- [ ] **Step 1: client**——类型 `MediaProviderRow/MediaAdapterMeta/MediaAdapterFormField`；listMediaProviders/create/update/remove/setDefault/listAdapters。
- [ ] **Step 2: media-settings.tsx**——分区标题 + 四 tab（文字｜图片｜视频｜音频）；文字 tab 嵌 `ProviderManager`（import 现有组件，传入其现有 props——读 provider-settings.tsx 的用法）；图片 tab：Provider 卡片列表（名称/adapter 标签/model/keyHint 掩码/默认徽标）+ 新增/编辑抽屉（adapter select → formSchema 动态渲染字段：text/select/number，Key password+Eye、空值 placeholder「留空以保留当前 Key」）+ 设为默认/删除（确认）；视频/音频 tab：空态引导卡「该模态尚未支持配置，将在后续版本提供」+ adapters 为空说明。
- [ ] **Step 3: settings-page 挂载**——「AI 核心」组内新增「媒体生成」入口（复用现有 page 切换模式）。
- [ ] **Step 4: 测试**——tab 切换；图片 Provider 列表渲染/新增表单按 adapter schema 出字段/默认切换调用 client；视频音频空态。运行聚焦 + `pnpm --filter desktop typecheck:web`。提交（`feat: add media generation settings section`）

### Task 6: 画布入口替换

**Files:** Delete `media-config-dialog.tsx`；Modify `canvas-chrome.tsx`、`infinite-canvas-workspace.tsx`、`api/infinite-canvas-client.ts`；Test 相关回归

- [ ] **Step 1: 入口**——canvas-chrome「生图 API 配置」DockButton 改为触发 `onOpenMediaSettings`（workspace 回调：优先走宿主导航到设置页媒体分区——实施时检查桌面端是否有跨页导航事件/函数；若无现成通道，按钮改为弹出轻提示卡「请到 设置 → 媒体生成 配置」+「打开设置」按钮走可用通道，实在无通道则保留只读状态弹窗）。
- [ ] **Step 2: 清理**——删 media-config-dialog.tsx 与 infinite-canvas-client 的 getMediaConfig/updateMediaConfig/CanvasMediaConfigStatus（确认无其他引用后）；media-configdialog 相关状态移除。
- [ ] **Step 3: 回归**——infinite-canvas 全量 + desktop typecheck + 全量 desktop 测试。提交（`refactor: move canvas media config into settings`）

### Task 7: 全量验证

- [ ] `pnpm test`（packages/server/desktop 全量；已知 App.test/plugin-* 并行抖动单独重跑判定）；`pnpm typecheck`；相关 eslint；`git diff --check`；`git log` 核对提交序列。

## Plan Self-Review

- Spec 覆盖：表+迁移（T1）、两 adapter（T2/T3）、Registry（T3）、REST+链路切换+兼容路由（T4）、设置页四 tab（T5）、画布入口（T6）、验证（T7）。文字 tab 复用组件、formSchema 驱动、capabilities 驱动均有落点。
- 占位符扫描：无 TBD；「实施时确认跨页导航通道」给出了三级降级路径。
- 类型一致性：adapter 接口/ctx/resolve 签名在 T1 定义后 T2-T4 消费一致；formSchema 字段类型 T4 路由与 T5 客户端一致。
