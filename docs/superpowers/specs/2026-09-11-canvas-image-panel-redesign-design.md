# 画布生成面板图像模式改版设计

## 背景

对齐参考产品的绘图面板体验：参考图上传区 + 提示词区 + 底部「模型 & 快捷参数栏」（模型下拉、参数快照标签、展开、存模板、发送）+ 图像设置弹窗（质量/尺寸/分辨率/比例/透明背景/张数）。用户明确要求使用项目 UI 组件库（Radix 封装的 `components/ui`），不用原生控件。

## 调研结论（约束）

- UI 库：`components/ui/` 有 Popover/Dialog/Switch/Input/Label/Button/Tooltip/Select/Segmented（`radix-ui` 统一包）；无 slider/checkbox/textarea。jsdom 测试基建（`src/test/setup.ts`）已支持 Radix 弹层，测试直接渲染真组件。
- 面板 600px 宽（`canvas-node.tsx:767`）；canvas 面板混用 CanvasTheme 内联颜色 + tailwind 布局，新弹层沿用此约定。
- 服务端缺口：`quality`/`background` 在 `index.ts:145-154`（generateImageCore 入参类型 + 显式字段转发）被丢弃；`generator.generateImage` 接口与 `MediaGenerationInput` 均无这两个字段；openai-images adapter 未映射。count 全链路钳 1-4（面板/工作区/adapter），gpt-image 上游支持 n≤10。
- 参考图今天只能靠画布连线（无上传入口）；`orderedReferences` 由 `buildCanvasGenerationContext` 从图推导。
- 提示词无保存路径；资产库 `saveCanvasAsset` 为 localStorage（`asset-library.tsx:40`）。
- openai-images 的 `normalizeOpenAiCompatibleSize`（shared.ts:232）会把任意 WxH 吸附到 1k/2k/4k 白名单档；apimart 透传原始 size、协议一次只返回 1 张（`n:1` 硬编码）。

## 目标（图像模式；video/audio 模式布局不变）

### 1. 参考内容区

- 参考图行加「+」上传按钮（隐藏 file input，`accept="image/*"` multiple）：选择后经工作区新回调 `onAddReferenceImages(nodeId, files)` 走既有 compress → `uploadCanvasAsset` → 建图片节点 → 连线到当前节点，天然进入 `orderedReferences`。
- 提示词 textarea placeholder（config+image）改为「描述要生成的图片内容」。

### 2. 底部模型 & 快捷参数栏（图像模式替代原 ConfigSettingsRow + 生成按钮行）

一行内联（600px 下 flex-wrap 兜底）：
1. 模型下拉（现有 ModelPicker pill，不变）。
2. **参数快照标签**：pill，文本如 `自动·1:1·3张`（尺寸为 auto 显示「自动」，否则显示比例名或 `W×H`；张数 `<n>张`）。点击弹 Radix **图像设置 Popover**。
3. **展开图标**（Maximize2）：Dialog 全屏编辑提示词（大 textarea，双向绑定 prompt，Ctrl/Cmd+Enter 触发生成并关闭）。
4. **存模板图标**（BookmarkPlus）：把当前提示词经 `saveCanvasAsset` 存入资产库（title 取提示词前 20 字），成功后按钮短暂反馈。
5. **发送按钮**：圆形 icon-only（ArrowUp），沿用 canGenerate/isRunning 逻辑。

### 3. 图像设置 Popover（w-[340px]，CanvasTheme 配色 + data-canvas-no-zoom）

① **质量**：Segmented 自动/高/中/低 → `metadata.quality`（'auto'|'high'|'medium'|'low'）。
② **尺寸**：W/H 两个 Input（number）+ 联动锁 toggle 按钮（Lock/LockOpen，锁定时改 W 自动按比例算 H，反之亦然）+ 「16 倍数对齐」Switch（开时 W/H 编辑即时取整到 16 倍数）。写入 `metadata.size = 'WxH'`。
③ **分辨率**：Segmented 1k/2k/4k/自动 → 以当前比例的 1k 基准尺寸缩放 ×1/×2/×4（16 对齐取整）；选「自动」时 `metadata.size='auto'`。
④ **宽高比预设网格**：自动、1:1、2:3、3:2、4:3、3:4、16:9、9:16、21:9、9:21（10 tile，比例真实缩略框）。1k 基准表：1:1→1024×1024、2:3→1024×1536、3:2→1536×1024、4:3→1152×896、3:4→896×1152、16:9→1536×864、9:16→864×1536、21:9→1792×768、9:21→768×1792（全部落在 openai 1k 档白名单内）；点击按当前分辨率档回填 W/H。
⑤ **透明背景**：Switch → `metadata.background='transparent'`（关闭清除）；副标注「仅部分模型支持」。
⑥ **生成张数**：number Input 1-10 → `metadata.count`。

### 4. 服务端透传（Task 1）

- `index.ts` `generateImageCore` 入参与转发补 `quality`/`background`。
- `generator.generateImage` 接口、`MediaGenerationInput` 补 `quality?: string`、`background?: string`，dispatch 透传。
- openai-images adapter：JSON 生成链路 body 增加 `quality`（白名单 auto/high/medium/low，缺省不发）、`background`（'transparent'|'opaque'，缺省不发）；`n` 钳制放宽到 `Math.min(10, Math.max(1, count))`（xKiro 强制 1 保留）。apimart 不动（协议一次一张，多余字段忽略）。
- count 客户端钳制 1-4 → 1-10（工作区 `Math.min(10)`）。

## 非目标

- video/audio 模式布局与参数不变；不改动 generate-media 链路。
- 不改蒙版编辑/放大/裁剪/拆分对话框。
- 不新增服务端路由或迁移；不改 apimart 的单张协议。
- 参考图管理（删除/排序）沿用现状，本版只加上传入口。

## 测试范围

- 服务端：generator 透传 quality/background（fetch 载荷断言）；openai-images adapter quality/background/n=10 用例；既有套件无回归。
- 桌面：`image-size-math.ts` 纯函数全测（基准表、分辨率缩放、16 对齐、联动锁、快照文案）；面板组件测试（快照标签、Popover 打开、质量/比例/张数/透明背景写 metadata、展开 Dialog 编辑提示词、存模板调用、上传回调触发）。
- 回归：画布全套件 + 双端 tsc + eslint。

## 验收标准

- 图像模式面板底部一行：模型 + 快照标签 + 三个图标按钮；快照与弹窗双向一致。
- 弹窗内所有控件写 `metadata.*`，生成载荷携带 size/quality/background/count，服务端可达 adapter 上游。
- 参考图 + 上传后新图片节点连线到当前节点并出现在参考图行。
- video/audio 与既有测试无回归。
