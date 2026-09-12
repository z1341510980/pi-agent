# 无限画布 资产化引用（base64 瘦身）设计

## 背景

generate-image 请求体达 34.6MB（参考图 base64 聚合）触发 32MB bodyLimit 断连（已热修至 128MB，`94255dc`）。根因是 base64 大量走网络：①客户端发生成请求前把全部引用下载转 base64，且 `resourceContext` 重复携带一份；②粘贴图、裁剪/拆分/放大产物以 data URL 存进节点，图 JSON（PUT /graph）随之膨胀。

## 现状关键事实（调研）

- 服务端 `referencesToDataUrls`（canvas-assets.ts:474-485）已能把 `/api/plugins/infinite-canvas/assets/{id}` 读盘转 data URL，generateImageCore/generateImageLocalized/edit-image 主图已接入；POST /assets 按 sha256 去重（同内容上传返回同路径，开销趋零）。
- 客户端 `imageContentAsDataUrl`（workspace:223-230）+ `withHydratedImageReferences` 把 `dataUrl`/`url` 都填成 base64 → references + resourceContext 双份传输。
- edit-image 路由把 `input.images` 预过滤成仅 `data:`（routes.ts:691-693）；mask 未走 referencesToDataUrls；reverse-prompt 的 image 原样透传（节点内容若是资产路径，上游 LLM 拿到相对路径必挂）；generate-media 的 image 同样未归一。
- 节点内容现状：insertFile/拖放/替换/参考上传 → 已是资产路径；**粘贴 → data URL**；**addDerivedImage（裁剪/拆分/放大）→ data URL**；生成结果/蒙版结果 → 服务端已本地化为资产 URL。

## 方案

### Task 1（客户端，主修复）

1. `generateNode` 图像模式：**不再水合 base64**——references 直接取 `context.images[].url`（资产路径或 data URL 原样）；`resourceContext` 保持 url 原样（删除/改造 `withHydratedImageReferences` 的 dataUrl 强填）。`imageContentAsDataUrl` 若无其他使用点则删除。
2. 粘贴路径：与 insertFile 同管线（compress → uploadCanvasAsset → 路径，失败回退 data URL）。
3. `addDerivedImage`：产物 data URL 先 uploadCanvasAsset（projectId 关联）再存路径，失败回退。
4. 效果：生成请求只传路径（服务端读盘转 data URL 供 adapter），图 JSON 里不再有新增 base64。

### Task 2（服务端，补齐归一）

1. reverse-prompt：`input.image` 经 `referencesToDataUrls` 归一后再进 analyzeImage。
2. edit-image：路由的 images 预过滤放开为「`data:` 或资产路径」；mask 在 editImageLocalized 经 `referencesToDataUrls` 归一。
3. generate-media：`input.image` 归一（潜在缺口，桌面端暂不发）。

## 非目标

- 不做资产 GC/孤儿清理；不改远程资产 beginRemoteAsset 逻辑；不做请求内引用哈希复用（POST /assets 已按内容去重）。

## 测试

- 服务端：reverse-prompt 资产路径归一用例；edit-image images 含资产路径可入库 + mask 归一；generate-media image 归一。既有 130+ 不回归。
- 客户端：generation-context/引用收集纯函数补资产路径用例；粘贴/派生产物上传失败的回退路径。
- 回归：双端套件 + tsc + eslint。

## 验收

- 多参考图生成请求体 <1MB 量级（仅路径）；reverse-prompt 在节点内容为资产路径时可用；粘贴/裁剪产物节点内容为路径。
