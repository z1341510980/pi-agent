# aimanplay 视频适配层改造方案（模型差异化 + OSS 素材链路）

## 背景与根因

aimanplay.cn（菠萝 max）四个 MiniMax-H3 模型的真实协议（用户提供的 `C:\Users\Administrator\Documents\api.md`，与平台代码一致）：

1. **素材只收 URL 不收 base64**（§3 开头）：「素材图片/音频必须先上传到 OSS，拿到公开 URL 后再传给生成接口。视频生成接口不接收文件流，只接收 URL。」——**这就是参考图失效的根因**：我们当前把参考图以 data URL 放进 `ref_image_N`，网关静默丢弃（任务能建、图没参与生成）。
2. **四模型差异化**（§4 模型参数表）：

| 模型 | 图片字段 | duration | resolution 枚举 |
| --- | --- | --- | --- |
| `minimax_h3_lightx2v` | `first_frame` + `last_frame`（**均必填**） | 1–10（默认5） | 480p竖/480p横/768p竖/768p横/480p(1:1)/768p(1:1) |
| `minimax_h3_image_audio_to_video_v2_15s` | `ref_image_0..8`（≤9）+ `ref_audio_0..2`（≤3） | 1–15（默认15） | 480p竖/768p竖/480p横/768p横 |
| `minimax_h3_zm_u24` | 同上（增强版，¥0.07/秒） | 1–15（默认5） | 480p竖/768p竖/480p横/768p横/480p(1:1)/768p(1:1) |
| `minimax_h3_lightx2v_no_pic` | 无（纯文生） | 1–10（默认5） | 同 lightx2v |

3. **成片下载**（§5）：任务状态响应**不含直链**；标准路径 `GET /v1/videos/{id}/content`（字节流，支持 Range）。我们现有轮询解析里 `data.result_url` 是网关额外兼容层，content 路由才是文档口径。
4. **任务状态**（§5.1）：`GET /v1/videos/{id}` 返回 `{id, object:'video', model, status: queued|in_progress|completed|failed|unknown, progress: 0-100(number), created_at, completed_at?, error:{message,code}?, metadata?}`。提交响应同构，取 `id` 为任务 id。
5. **OSS 素材链路**（§3）：`POST /api/video-upload/oss-sts`（Bearer 同一个 sk 令牌）→ STS 凭证（host/region/bucket/dir/accessKeyId/accessKeySecret/securityToken/expiration/maxImageBytes=10MB/maxAudioBytes=20MB，1 小时有效）→ OSS V1 签名 PUT（`x-oss-object-acl: public-read` 参与签名；StringToSign 的 Date 槽位必须填 `x-oss-date` 同值——生产实测坑）→ 公开 URL `{host}/{dir}/{uuid}.{ext}`。

## 当前实现 vs 目标差距

| 环节 | 现状 | 目标 |
| --- | --- | --- |
| 参考图传递 | data URL 进 `ref_image_N`（被丢弃） | 先传 OSS 拿 URL 再进字段 |
| 模型差异化 | 无：所有带参考图模型一律 ref_image_N | lightx2v → first_frame/last_frame（取参考图第 1、2 张）；no_pic → 不带图字段并提示 |
| 参考音频 | 无 | ref_audio_0..2（上游音频节点素材） |
| resolution | 仅透传（params 配置） | 按模型枚举校验/默认（`480p竖` 等）+ 客户端分辨率预设对齐 |
| duration | 透传，无模型范围钳制 | 按模型范围钳制（1-10 / 1-15），默认值按模型（5 / 15） |
| 成片下载 | 轮询解析 result_url（兼容层，已工作） | 优先 result_url，缺失时回退 `GET /v1/videos/{id}/content`（文档口径） |
| 媒体上限 | refImages 钳 8 张 | 图 9 张 / 音频 3 段（adapter 侧钳） |

## 改造方案

### Task 1：OSS 素材桥（服务端，新模块 `media/aimanplay-oss.ts`）

- `uploadToAimanplayOss(providerKey: {baseUrl, apiKey}, source: {bytes: Buffer, mime: string}, kind: 'image'|'audio'): Promise<string>`
  1. STS：`POST {origin}/api/video-upload/oss-sts`（注意：baseUrl 是 `https://aimanplay.cn/v1`，STS 路径在站点根——从 baseUrl 推 origin）；缓存凭证至 expiration 前 5min（模块级单例，按 providerId 缓存）。
  2. PUT：OSS V1 签名（Node `crypto` HMAC-SHA1；`x-oss-date` RFC1123 同值进 StringToSign Date 槽位；canonical headers 排序 `x-oss-date`/`x-oss-object-acl:public-read`/`x-oss-security-token`；key = `{dir}/{uuid}.{ext}`）。
  3. 上限校验：maxImageBytes/maxAudioBytes 超限报可读错误。
  4. 诊断事件 `mediaDiag.event('oss-upload', {providerId, kind, bytes, key})`。
- 输入素材解析复用 `referenceToDataUrl`（data URL / 资产路径 → bytes）。

### Task 2：adapter 模型差异化（`newapi-video.ts`）

- 模型档案表 `AIMANPLAY_MODEL_PROFILES`（按模型 id 前缀匹配）：字段模式 `first-last` | `ref-media` | `text-only`、duration 范围+默认、resolution 枚举+默认（竖屏优先 `480p竖`）。
- `buildSubmitPlan` 按档案分流：
  - `first-last`：参考图[0]→first_frame、[1]→last_frame（不足两张 → 明确报错「首尾帧模型需要至少 2 张参考图」）；
  - `ref-media`：ref_image_N（≤9）+ ref_audio_N（≤3，来自输入 refAudios）；
  - `text-only`：忽略参考图；**提交前若带了参考图则日志提醒**（不报错）。
- duration/resolution 按档案钳制与补默认；resolution 枚举外值 → 400 风格可读错误。
- **URL 化**：submit 前对每个图片/音频素材调用 Task 1 的 OSS 上传（先查 `input.refImages` 是 data URL 还是已是公网 URL：http(s) 直传，data:/资产路径 → 走 OSS）。缓存按内容 sha256（重复素材同 URL）。
- 提交诊断增强：`video-submit` 事件补 `modelProfile`、`uploadedToOss: n`、`refAudioCount`。

### Task 3：链路字段与 UI

- `VideoGenerationInput`/路由/桌面载荷补 `refAudios?: string[]`（≤3）；workspace 视频分支收集上游**音频节点**内容一并发出（`buildCanvasGenerationContext` 已收集 audio 上游？确认后接入）。
- 下载回退：worker/refresh 成功判定后，`result_url` 缺失 → `GET {base}/videos/{task_id}/content` 下载字节流（复用现有 localize 管线）。
- 客户端分辨率预设：视频模式 resolution select 选项改为档案枚举（`480p竖` 等中文档位）——面板 VIDEO_SIZES 保留给旧协议，新协议按 provider 的模型档案显示。此为 UI 增强，可后置。

### 测试

- OSS 桥：STS 获取/缓存、签名串构造（用文档 §3.3 算法做已知向量断言）、超限错误、URL 拼接。
- adapter：四模型各自 submit body（first/last、ref_image+ref_audio、纯文）、duration/resolution 钳制、参考图 URL 化调用计数与缓存、text-only 带图提醒。
- 下载回退：轮询 completed 无 url → content 端点被调。
- 既有 156 用例不回归。

## 分期建议

1. **P0（本次）**：Task 1 + Task 2 的 URL 化与 first/last 分流 + duration/resolution 钳制 → 直接修复参考图失效，四模型全部可用。
2. **P1**：ref_audio 链路 + content 下载回退。
3. **P2**：面板分辨率档位 UI 对齐。

## 开放问题（需用户/平台确认）

- OSS 桶的公开对象会产生公网可访问 URL——素材隐私可接受？（playground 同款行为）
- STS 接口的限流策略未知；按 provider 缓存 + 提交期串行上传兜底。
