# 媒体生成 Provider 体系（适配器模式）设计

## 背景

当前媒体生成配置存在四类问题：

1. **模态不拆**：图片生成字段（mediaProtocol/mediaModel/mediaResolution/mediaLanguage）寄生在 LLM Provider 记录（providers 表）上；音频/视频零配置零实现（`generateAudio/generateVideo` 恒抛错），但 UI/路由/参数链路已就绪，用户点击必报错。
2. **两套并行配置源**：画布 `infinite_canvas_media_settings` 单行 override 与 providers 表媒体列语义重叠；override → ImageRequestContext 的解析逻辑在 media-generator 与插件 index.ts 各实现一份（共约 4 处手写）。
3. **协议分支内联**：`openai-images` 与 `apimart` 的差异、xKiro 的 URL hostname 猜测、multipart/JSON 编辑端点探测缓存，全部内联散布在 media-generator.ts（1064 行）的 payload/endpoint/轮询/错误处理各处。
4. **入口割裂**：媒体配置入口是画布内浮层弹窗（「生图 API 配置」DockButton），未进入设置页；能力差异（如 apimart 无 mask）未在配置层声明。

## 目标

- 建立统一媒体 Provider 体系：文字/图片/视频/音频四个模态，每个模态可配置多个 Provider 实例并指定默认。
- 服务端以适配器模式收敛协议差异：Adapter 声明能力（capabilities）与表单 schema（formSchema），Registry 按模态+providerId 解析。
- 配置入口迁入设置页新增「媒体生成」分区；画布内弹窗移除，改为跳转入口。
- 存量配置自动迁移，旧路由兼容一个版本。

## 非目标

- 不重构 LLM Provider 体系本身（文字模态复用现有 provider-manager，见下）。
- 不改变插件 manifest/权限模型；不新增画布插件路由之外的新插件。
- 阶段一不做音频/视频的真实 Provider 实现（仅落配置体系与明确的未配置报错）。
- 不迁移 AG-UI/Agent 运行时的模型选择逻辑。

## 架构

### 1. 数据模型（服务端，新表 media_providers）

```sql
CREATE TABLE media_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  modality TEXT NOT NULL,        -- 'text' | 'image' | 'audio' | 'video'
  adapter TEXT NOT NULL,         -- 'openai-images' | 'apimart' | 'openai-audio' | ...
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL DEFAULT '{}',  -- JSON：size/resolution/language/voice/format 等 adapter 自有参数
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,  -- 模态内默认（每模态至多一个）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

- 每模态多实例、单默认；`enabled=false` 不参与解析。
- 迁移（migrations 追加）：
  - `infinite_canvas_media_settings` 单行（若已配置）→ image 模态默认 Provider（adapter 按其 imageProtocol，params 收 size/resolution/language）。
  - providers 表中带媒体配置的行 → image 模态 Provider（name 取 provider 名 +「（媒体）」，params 收 mediaProtocol/mediaModel/mediaResolution/mediaLanguage；api_key 沿用该行）。
  - 迁移幂等：以来源标记（id 前缀 `mig-`）防重复导入。

### 2. Adapter 层（新目录 agent-server/src/core/media/adapters/）

```ts
export interface MediaModalityContext {
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  params: Record<string, string>
  logger?: FastifyBaseLogger
}

export interface MediaProviderAdapter {
  id: string                          // = 表 adapter 列
  label: string
  modality: Exclude<MediaModality, 'text'>
  capabilities: {
    generate: boolean
    edit?: boolean                    // 图生图
    mask?: boolean                    // 蒙版局部重绘
    analyze?: boolean                 // 反推提示词（多模态）
  }
  /** 声明式表单：驱动设置页动态渲染（含模态特有参数） */
  formSchema: MediaAdapterFormField[]
  generateImage?(ctx: MediaModalityContext, input: ImageGenerationInput): Promise<{ images: string[] }>
  editImage?(ctx: MediaModalityContext, input: ImageEditInput): Promise<{ images: string[] }>
  analyzeImage?(ctx: MediaModalityContext, input: ImageAnalysisInput): Promise<{ text: string }>
  generateAudio?(ctx: MediaModalityContext, input: AudioGenerationInput): Promise<{ outputs: MediaOutput[] }>
  generateVideo?(ctx: MediaModalityContext, input: VideoGenerationInput): Promise<{ outputs: MediaOutput[] }>
  /** 连接测试（阶段三实现，先声明） */
  testConnection?(ctx: MediaModalityContext): Promise<{ ok: boolean; message?: string }>
}
```

阶段一实现两个 Adapter：

- `openai-images.ts`：现 media-generator 的 openai-images 分支整体迁移——`/images/generations`、编辑三级回退（JSON → multipart → generations+image_urls）、`/images/generations/{id}` 轮询、size 白名单吸附、`defaultImageModelForBaseUrl`。探测缓存（jsonOnly/multipartOnly）改为 adapter 实例内按 providerId 键控。
- `apimart.ts`：apimart 分支整体迁移——payload（比例 size/resolution/image_urls）、`/tasks/{task_id}?language=` 轮询、capabilities.mask=false、默认模型 gpt-image-2。

xKiro 特判收敛：`isXKiroBaseUrl` 逻辑保留在 openai-images adapter 内（URL 归一后判定），不单独建 adapter（它本就是 openai-images 的厂商变体）。media-generator.ts 其余公共工具（dataUrlToBlob、parseImages 深度遍历、withAbortGuard、轮询退避）提取为 `core/media/shared.ts` 供各 adapter 复用。

### 3. Registry（core/media/registry.ts）

```ts
class MediaProviderRegistry {
  register(adapter: MediaProviderAdapter): void
  listAdapters(modality): MediaProviderAdapter[]
  /** 解析：providerId 精确命中 → 模态默认 → null（调用方报「未配置」） */
  async resolve(modality, opts?: { providerId?: string }): Promise<ResolvedMediaProvider>
}
```

- `ResolvedMediaProvider = { providerId, adapter, ctx: MediaModalityContext }`。
- store（`media-provider-store.ts`，仿 provider-config-store 模式）负责 media_providers 表 CRUD + 默认切换事务（同模态先清 is_default）。
- 宿主在 app.ts 组装 Registry 并注入 PluginContext.media（facade 改为经 Registry 分发）；插件 index.ts 删除 4 处手写 ImageRequestContext，改为 `resolve('image', { providerId: 画布传入 })` 后调 adapter 方法。

### 4. 文字模态的纳入方式

- 设置分区含「文字」tab，**直接复用现有 provider-manager 组件**（现有 LLM Provider 体系即文本生成 Provider 体系，不重建、不迁移数据）。
- media_providers 表不存 text 行；Registry.resolve('text') 桥接 provider-config-store（返回 openai-completions 语义 ctx），供未来统一消费；本阶段无调用方。
- LLM Provider 表单内寄生的「图片生成配置（可选）」折叠卡移除。

### 5. 设置页 UI（桌面端）

- settings-page 新增分区「媒体生成」（宿主固定分区，与 AI 核心并列）：四个 tab——文字｜图片｜视频｜音频。
  - 文字 tab：嵌入现有 provider-manager（原「模型与 Provider」页内容；原页面保留入口或由本 tab 承接，实施时保持一个真实来源避免双入口漂移——决定：原分区入口保留，媒体分区文字 tab 嵌同一组件，共享同一数据源）。
  - 图片/视频/音频 tab：Provider 卡片列表（复用 provider-manager 交互模式：新增/编辑/删除、默认标记、Key 掩码 keyHint、空 Key 保留旧值），表单字段由所选 adapter 的 formSchema 动态渲染；未配置模态显示引导卡（「配置 XX 生成 Provider」）。
- 画布：`media-config-dialog.tsx` 删除；canvas-chrome「生图 API 配置」DockButton 改为触发宿主导航到设置页媒体分区（通过现有导航 contribution/事件机制，实施时确认桌面端跨页跳转通道；不可达时保留弹窗壳改为只读状态展示 + 「前往设置」按钮）。
- 视频/音频 tab 在阶段一即渲染（空态引导），阶段二填入真实 adapter 后表单自动可用（formSchema 驱动）。

### 6. 调用链路切换

- `POST /generate-image`、`POST /edit-image`、`POST /reverse-prompt`：经 Registry 解析（画布节点 providerId 优先 → image 默认）→ adapter.generateImage/editImage/analyzeImage。
- `POST /generate-media`（audio/video）：阶段一 resolve 失败统一报「该模态尚未配置生成 Provider，请到 设置 → 媒体生成 配置」；阶段二接 adapter 真实现。
- 旧 `GET/PUT /media-config` 保留：GET 返回 image 默认 Provider 的 status 视图（字段映射兼容），PUT 写回该 Provider（adapter/params 映射），路由注释标记 deprecated，阶段三清理。

## 分阶段

- **阶段一（本设计实施范围）**：media_providers 表 + 迁移；adapter 抽象与 openai-images/apimart 迁移；Registry/store；设置页「媒体生成」分区（文字 tab 复用 provider-manager、图片 tab 全功能、视频/音频空态引导）；画布弹窗移除与入口替换；生成/编辑/反推链路切换；旧路由兼容。
- **阶段二**：openai-audio / apimart-video（或同类任务式视频）adapter 真实现 + generate-media 接通；连接测试（testConnection）落地。
- **阶段三**：能力探测持久化（按 providerId）、keyHint 掩码统一到 provider 展示层、deprecated 路由与 providers 表媒体列清理。

## 测试范围

- 迁移：存量 override/providers 媒体列导入、幂等、默认标记唯一。
- Adapter：openai-images（生成/编辑三级回退/轮询/size 吸附/xKiro 默认模型）与 apimart（payload/轮询/无 mask）行为与迁移前等价（现 media-generator.test.ts 用例迁移为 adapter 测试）。
- Registry：providerId 命中/默认回退/未配置报错/enabled 过滤/默认唯一事务。
- 路由：generate-image/edit-image/reverse-prompt 经 Registry；generate-media 未配置报错文案；旧 media-config GET/PUT 兼容映射。
- 设置页：媒体分区渲染、tab 切换、图片 Provider 增删改/默认切换/Key 保留、formSchema 动态字段、画布入口跳转。
- 回归：现有 media-generator 相关测试、插件路由测试、桌面端全量。

## 验收标准

- 设置页出现「媒体生成」分区，四个模态 tab 可用；图片模态可增删改多个 Provider 并指定默认。
- 存量画布媒体配置迁移后，画布生图/编辑/反推行为与迁移前一致（无需重新配置）。
- 画布内不再有独立配置弹窗；入口跳转设置页。
- 音频/视频生成在未配置时返回明确引导文案而非笼统报错。
- apimart Provider 的编辑面板不出现蒙版能力（capabilities 驱动）。
- 全部现有测试回归通过。
