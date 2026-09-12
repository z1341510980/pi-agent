# 画布视频异步任务队列设计（含 NewAPI 响应形状修复）

## 背景与实锤

- 视频平台是异步任务协议（提交 → task_id → 轮询状态），当前实现是**同步阻塞等待**：HTTP 请求挂在轮询上直到超时（原 10min，已放宽 30min，`f07a8d1`）。
- 实测（aimanplay / newapi-video）：任务 914s 完成，但**线上真实响应与文档不一致**——文档口径 `{task_id, status:'completed', url}`，实际 `{code:'success', data:{task_id, status:'SUCCESS'(大写), result_url, progress, data:{results:[{url}]}}}`。现有解析只认顶层 `url` + 小写状态词 → 完成后既认不出 SUCCESS 也找不到 result_url → 永远轮询到超时。`task_tL3yt5WT2IGZxOvNMgzYKXICtIxue7FB` 即此案例（视频已手动取回桌面）。

## 需求（用户口径）

1. 异步任务要有**队列**：服务端持久化（task_id、provider、项目、节点关联、参数）。
2. **前端可见**：任务状态/进度展示，且关联到画布节点。
3. 后台超时后用户可**手动获取**：按 task_id 重新拉取上游状态，完成后把视频写回节点。

## 方案

### Task 1：NewAPI 视频 adapter 解析修复（前置）

- `taskStatus` 大小写归一（SUCCESS/success 等价）。
- 视频结果 URL 提取顺序：`data.result_url` → `data.data.results[].url` → 顶层 `url`（文档形状）→ `url`/`image_url` 既有 parseImages 路径；提交响应的 task_id 同样兼容 `{data:{task_id}}` 与顶层 `{task_id}`。
- 适配器测试补真实形状 fixture（本案例响应样本入测试）。

### Task 2：服务端任务表 + 异步化 generate-media（视频）

- 迁移 020：`infinite_canvas_video_tasks`（id, project_id, node_id, provider_id, task_id, model, params JSON, status pending/running/success/failed/timeout, result_url, error, created_at, updated_at）。
- adapter 拆分能力：`submitVideoTask`（POST 提交，返回 {taskId, status}）与 `pollVideoTask`（GET 状态，返回 {status, progress?, url?}）；`generateVideo` 保留同步实现（内部组合两者，兼容既有调用/测试）。
- 路由 `POST /generate-media`（mode=video）：提交成功后**立即返回** `{ videoTask: {id, taskId, status} }`（不再阻塞）；nodeId 透传落库。
- 后台 worker（插件内 setInterval，例如 10s 扫一次 running/timeout 任务，指数退避可复用）：pollVideoTask → SUCCESS 时**下载视频到 canvas-assets**（扩展资产 mime 支持 video/mp4；result_url 是 24h 签名 URL，必须本地化）→ 状态 success + result 存 `/assets/{id}` 路径；failed 记 error；超过总预算（如 60min）标 timeout（保留 task_id 供手动恢复）。

### Task 3：查询/恢复路由 + 桌面端接入

- `GET /projects/:id/video-tasks`：任务列表（含节点 id、状态、进度、错误、结果路径）。
- `POST /projects/:id/video-tasks/:id/refresh`：手动获取——强制 poll 一次，SUCCESS 则本地化下载并返回结果（同 worker 逻辑复用）。
- 桌面端：
  - 视频生成节点 loading 态存 `metadata.videoTaskId`（本地任务 id）；
  - 工作区轮询 video-tasks（打开项目期间，10s 间隔）：任务 success → 视频写入 loading 节点（转 video 节点 + asset 路径 + 连线）；failed/timeout → 节点 error 态 + 「重新获取」入口；
  - 节点卡片/面板：loading 中显示排队/生成中/进度；timeout/failed 提供「重新获取结果」按钮（调 refresh，成功回填节点）；
  - 既有同步链路语义对齐：audio 不变（同步够快）；视频旧节点无 videoTaskId 不受影响。

## 非目标

- 不做跨进程持久 worker（服务重启后 running 任务留在表内，靠前端轮询/手动 refresh 恢复——refresh 直接调上游，无需内存态）。
- 不改图片/音频生成链路；不做任务取消（上游协议无取消接口）。

## 验收

- 提交视频生成请求立刻返回，画布节点显示生成中；完成后自动回填视频节点（asset 路径）。
- 超时（或服务重启）后任务不再推进，但节点上「重新获取」能拉回已完成的结果。
- 真实 aimanplay 形状（SUCCESS/result_url）被正确识别（测试覆盖）。
