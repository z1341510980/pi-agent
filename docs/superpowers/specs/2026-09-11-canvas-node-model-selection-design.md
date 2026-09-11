# 无限画布 节点级模型选择设计

## 背景

画布生成节点（config 节点，generationMode = image / video / audio）目前一律使用「设置 → 媒体生成」里的默认 Provider/模型。用户要求在节点上直接选择本次生成用哪个模型，不必每次去设置里改默认值。已确认的决策：

- 选择器放**节点面板**（下拉）；节点卡片上以小字显示当前所选模型。
- 下拉按**节点类型**聚合该类型（image/video/audio）全部**已启用** Provider 的模型，显示为 `Provider名 / 模型`。
- 节点所选的模型/Provider 被删除或停用后，点生成**报错阻止生成**（不静默回退默认）。

## 现状要点（调研结论）

- `CanvasNodeMetadata` 已声明 `model?` / `providerId?`（`infinite-canvas-client.ts:59-60`），workspace 生成时已随载荷发送（image 2144-2145、audio/video 2162-2163），路由已透传（routes.ts:598-599、642-643），generator/adapter 已按 `input.model || ctx.model` 消费——**唯一缺口是 UI 写入与失效校验**。
- 模型候选来源：Provider 行的 `model` 字段 + `params.models`（换行分隔的附加模型，设置面板已有此约定）；客户端 `listMediaProviders()` 一次可取全部模态的行（含 enabled 标记），无需新服务端路由。
- `registry.findRow` 对显式 providerId 未命中/停用时会**静默回退默认 Provider**，与"报错阻止"需求冲突，需在 generator 层加显式校验（registry 本身行为不变）。

## 目标

1. config 节点面板在 image/video/audio 模式下显示「模型」下拉：
   - 首项「跟随全局默认」（value 空，写入 `{providerId: undefined, model: undefined}` 即清除）。
   - 其余项为该模态全部已启用 Provider 的候选模型（`model` + `params.models` 去重），显示 `Provider名 / 模型`，value 为 `providerId:model`。
   - 选择后通过既有 `onConfigChange` 写入 `metadata.providerId` + `metadata.model`。
   - 未启用任何该类型 Provider 时下拉禁用并提示；加载中禁用。
2. config 节点卡片在选择了模型时显示小字模型名（仅 `metadata.model`）。
3. 服务端校验：载荷带显式 `providerId` 时，若该 Provider 不存在/已停用/模态不符 → 生成失败并报错「…已被删除或停用，请在节点面板重新选择」；若带 `model` 且不在该 Provider 候选列表 → 报错「已从 Provider 移除…」。不带 `providerId` 时行为完全不变（registry 静默回退默认的既有语义保留）。
4. 错误沿用现有 502 码失败通道，消息显示在源节点 `errorDetails`。

## 非目标

- 不改文字模式（仍走画布 Agent 默认配置）。
- 不改反推提示词的模型选择（已有 analyzeModel 机制）。
- 不新增服务端路由或数据库迁移。
- 不做"先选 Provider 再选模型"的两级选择。
- 不改设置面板的默认 Provider/模型语义。

## 交互细节

- 下拉位于各模式参数行（尺寸/数量、分辨率/时长、音色/格式/语速）之下，label「模型」。
- 载荷已有 `model` 但无 `providerId`（理论遗留）时按「跟随全局默认」显示；重新选择即写入完整二元组。
- 服务端校验只在 `providerId` 显式存在时触发；`model` 缺省时仅校验 Provider 可用性。

## 技术方案

- 服务端：`registry.ts` 暴露 `findEnabledRow(modality, providerId)`（现有 `findRow` 的对外只读封装，无回退）；`generator.ts` 新增 `assertProviderSelection`（校验 Provider 可用 + `providerCandidateModels(row)` 包含所选 model），在 `generateImage` / `generateAudio` / `generateVideo` 入口处调用。
- 桌面端：`canvas-node-panel.tsx` 新增 `ModelPicker`（挂载时经 `listMediaProviders()` 拉取，按当前 mode 过滤 `modality` 且 `enabled`）；`canvas-node.tsx` config 卡片加模型小字。
- 复用：面板既有 `onConfigChange` 合并语义；`media-provider-client.listMediaProviders`；测试模式参照 `media-settings-panel.test.tsx` 的 client mock 与 `canvas-node-panel.test.tsx` 的 useState metadata 测试架。

## 测试范围

- 服务端（generator.test.ts 增补）：显式 providerId 未知/停用/模态不符 → 拒绝且不发上游请求；model 不在候选 → 拒绝；model 在 `params.models` → 放行并按该模型请求；无 providerId → 既有回退行为不变。
- 桌面（canvas-node-panel.test.tsx 增补）：mock client 后断言选项聚合（默认模型 + params.models、排除停用 Provider）、默认「跟随全局默认」、选择写入 `{providerId, model}`、清空写入 undefined、加载中/无 Provider 禁用态。
- 全量回归：画布套件、双端 tsc、相关文件 eslint。

## 验收标准

- 在节点面板选好模型后，该节点生成请求使用所选 Provider/模型（服务端日志与上游载荷可见）。
- 清除选择（跟随全局默认）后恢复原行为。
- 所选 Provider 被删除/停用或模型被移除后，点生成不发起上游调用，节点显示可读错误。
- 未选择模型的节点与现状行为一致；既有测试无回归。
