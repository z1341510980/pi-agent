# Infinite Canvas 设计画板（design-board）设计

## 背景

无限画布目前以工作流节点（Prompt、文本、图片、视频、音频、配置、Agent 结果）为核心，缺少单张视觉作品的精细排版能力。参考项目 avnac（AGPL-3.0）提供了完整的浏览器端设计编辑器实现，本设计吸收其公开的产品思路、交互规格与算法参数，全部代码自研实现，不复制其源码。

## 目标

- 新增 `design-board` 节点类型：节点上仅显示预览缩略图。
- 点击/双击打开全屏覆盖式设计编辑器（弹窗），编辑画板内容。
- 画板图片素材自动来自无限画布上的图片节点（资源面板点选插入，不做跨画布拖拽）。
- 支持文本、图片、矩形（MVP）三类对象的创建、选择、拖动、缩放、删除。
- 创建画板时提供尺寸预设参考（含自定义）。
- 导出 PNG/JPG，结果生成新的图片节点，可继续接入既有工作流。

## 非目标

- 不引入 avnac 源码、其后端、IndexedDB 持久化或 Tambo AI 接入。
- MVP 不做：多页面、向量钢笔、SVG 图标系统、渐变、阴影、旋转、多选、对齐分布、网络字体。
- 不改动现有节点类型的交互与持久化行为。

## 画布尺寸预设

创建 `design-board` 节点时弹出预设选择（分类 + 尺寸 + 自定义输入），确认后才创建节点并打开编辑器：

| 分类 | 预设 | 尺寸 |
| --- | --- | --- |
| 社媒 | 小红书竖图 3:4 | 1080×1440 |
| 社媒 | 小红书方图 1:1 | 1080×1080 |
| 社媒 | 抖音/竖屏视频 9:16 | 1080×1920 |
| 社媒 | 公众号首图 | 900×383 |
| 社媒 | X/横版帖子 | 1200×675 |
| 通用 | 横版视频封面 16:9 | 1280×720 |
| 通用 | HD | 1920×1080 |
| 印刷 | A4 海报 @300dpi | 2480×3508 |
| 自定义 | 任意 | 100–16000（clamp） |

默认选中「小红书竖图 3:4」。

## 交互设计

### 节点层（轻）

- `design-board` 节点渲染画板缩略图：canvas 渲染器按节点显示尺寸出图，防抖（200ms 级）+ dataURL 缓存供 minimap 复用。
- 缩略图上叠加画板尺寸标签（如 `1080×1440`）与对象数。
- 交互入口：
  - 单击 = 选中（画布语义不变）。
  - 双击节点体 = 打开编辑器（与图片节点双击查看大图语义一致）。
  - 悬停工具栏「编辑」按钮 = 打开编辑器。
- 空画板（无对象）时缩略图显示背景色 + 居中「双击开始设计」提示。

### 编辑器层（全屏覆盖对话框）

参照 avnac 编辑器骨架，覆盖整个画布工作区：

- 顶部栏：返回（写回并关闭）、导出 PNG/JPG、撤销/重做。
- 左侧资源面板：「画布资源」（自动收集当前画布全部图片节点）+ 对象图层面板。
- 底部工具条：添加文本/矩形、缩放滑杆（5%–500%）+ fit 按钮。
- 属性工具栏：选中对象浮动于其上方（文本：字号/字重/对齐/颜色；图片：来源节点与显示尺寸；矩形：填充/描边/圆角）。图片「替换来源」在阶段二提供。
- 右键菜单：复制/删除。

### 键盘与全局监听门控

- 编辑器打开期间压制画布全局 Delete/Backspace/Ctrl+Z 监听（沿用 `active` prop 同款门控机制，新增 `boardEditing` 状态）。
- 编辑器快捷键表（作用域守卫：目标为 input/textarea/select/contenteditable 时跳过，Escape 除外）：
  - 方向键微移 1px，Shift=10px
  - Delete/Backspace 删除选中
  - Ctrl+Z / Ctrl+Shift+Z 撤销/重做（编辑器内部栈）
  - Ctrl+D 复制（偏移 +24px）
  - Ctrl+1 适配缩放
  - Escape 提交文本草稿

## 架构：双渲染器

avnac 的关键架构决策：编辑态对象用 DOM/SVG 渲染，canvas 只用于导出与缩略图。本设计照此路线：

```text
components/infinite-canvas/design-board/
  design-board-types.ts      数据模型 + 默认值 + 钳制 + 解析校验
  design-board-presets.ts    尺寸预设表
  design-board-renderer.ts   canvas 渲染器（导出 + 节点缩略图共用）
  design-board-export.ts     导出选项 + compressImageDataUrl 接线
  design-board-resources.ts  画布图片资源收集（纯函数）
  design-board-editor.tsx    全屏编辑器（DOM 对象视图 + 交互引擎）
  design-board-object-view.tsx 对象 DOM/SVG 渲染 + 文本编辑 textarea
  design-board-overlays.tsx  选择框/手柄/吸附参考线（DOM 覆盖层）
  design-board-toolbar.tsx   属性工具栏
  design-board-create-dialog.tsx 预设选择对话框
```

- DOM 对象视图：统一外壳 `div[data-design-board-object]`，absolute 定位 + `rotate()`（阶段二），opacity/filter；rect/text 用内联 SVG。
- 覆盖层尺寸全部 `÷screenScale`（`max(scale, 0.01)`）保证屏幕恒定像素：边框 1.5px、角手柄 12px、边手柄 22×8px。
- 交互全用 CSS px；DPR（≤2）仅 canvas 栅格化。

## 数据模型

```ts
type DesignBoardDoc = {
  version: 1
  width: number   // 100–16000
  height: number
  background: string  // 纯色，默认 '#ffffff'
  objects: DesignBoardObject[]
}

type DesignBoardObject =
  | { kind: 'text'; id; x; y; width; height; text; fontSize; fontWeight; align; color }
  | { kind: 'image'; id; x; y; width; height; source: DesignImageSource; radius }
  | { kind: 'rect'; id; x; y; width; height; fill; stroke; strokeWidth; radius }

type DesignImageSource =
  | { kind: 'node-ref'; nodeId: string; index: number }  // 引用画布图片节点（主力）
  | { kind: 'url'; url: string }                          // 外部/代理地址
  | { kind: 'data'; dataUrl: string }                     // 仅画板内衍生图
```

- 默认值（对齐 avnac 规格并本地化）：text `fontSize 64（min 8）/ fill #171717 / lineHeight 1.22 / align left / 系统字体栈`；rect `fill #262626 / stroke transparent / strokeWidth 0 / radius 0`；image `radius 0`。
- 钳制：尺寸 1–16000 取整、opacity 0–1、radius ≤ min(w,h)/2、letterSpacing −200–400（阶段二）。
- 解析哲学：非法对象静默丢弃、字段级钳制回退、`Number.isFinite` 防 NaN 穿透。
- 持久化：文档存节点 `metadata.design`；图片引用化（node-ref/url）保证体积可控，走现有整图保存（32MB 上限压力解除）；`data` 类 dataUrl 受 `compressImageDataUrl` 约束。
- node-ref 解析：渲染时经节点表取 `metadata.content` / `metadata.images[index]`；来源节点被删时渲染占位样式并在属性面板提示，不自动删对象。

## 资源面板（画布资源自动加载）

- 纯函数收集：遍历画布 `nodes`，取 image 节点的 `metadata.content` 与 `metadata.images[]`（string/对象兼容 `canvasGeneratedImageContent`），按 URL 去重，输出 `{id, title, url, naturalWidth, naturalHeight}` 列表。
- URL 经现有 `proxyExternalImageUrl` 渲染缩略图；插入画板即创建 `{kind:'node-ref'}` 图片对象（默认居中、尺寸按 4% 画板宽）。
- MVP 仅图片节点；阶段二并入现有资产库（`asset-library`）。

## 交互引擎规格

### 缩放与视口

- `scale = zoom%/100`；wheel：`pct · e^(−deltaY·0.006)`，clamp 5–500。
- fit：留 48px padding，`floor(min(availW/w, availH/h)·100)`。
- 锚点缩放：记录 scene 坐标，rAF 后按新布局补偿滚动。
- `pointerToScene = (client − rect.left) / scale`，clamp 到画板内。

### 选择与拖拽

- pointerdown 即选区（无阈值），move/up/cancel 挂 window 监听。
- 点击空白 = 取消选择；Shift/Ctrl+点击 = 切换成员（阶段二多选）。
- marquee 框选（阶段二）：相交命中，仅 visible 对象。

### 缩放手柄

- 8 向 `['nw','n','ne','e','se','s','sw','w']`，对侧手柄即 anchor，光标映射 ns/ew/nwse/nesw-resize。
- 最小尺寸 12px；等比：image 角柄恒锁、rect 默认锁（Shift 解锁）；Alt = 中心缩放。
- 约束公式：`scale = max(12/w, 12/h, |px−ax|/w, |py−ay|/h)`。
- 文本角柄：`factor = max(0.1, max(box.w/initW, box.h/initH))`，fontSize 下限 8，width 下限 24，height = max(排版高度, fontSize×1.22)。
- 图片边柄 = 裁剪语义（阶段二），MVP 仅角柄等比。

### 吸附

- 阈值 `max(8, round(min(w,h)·0.0025))` 场景 px；死区 0.25px；滞回：sticky 窗口 0.5px、释放系数 1.6、切换需明显更近（评分 `absDelta − 1.5`）。
- 候选线：移动方 {left, centerX, right} × 目标同三项 9 组合 + 画板中线；每轴最多 1 条，最多同时 1 竖 1 横。
- 目标集：拖拽开始时取 visible 且不在移动集的对象；参考线坐标存 ref 跨帧滞回，drag start/up 重置。
- 呈现：贯穿画板全长线，线宽 `1/scale`，pointer-events-none。

### 文本编辑

- 双击对象换 `<textarea>`（transparent、`stopPropagation` 防拖拽误触、autoFocus、spellCheck=false）。
- textarea 样式与渲染层逐项同值；高度 = `max(obj.height, 排版高度)` 实时长高。
- 提交：blur / Escape / 点其他对象；text=draft，height = max(layout.height, fontSize×1.22)。
- 换行算法：`\r?\n` 分段 → token 化（保留空白）→ 超宽 token 字符级断行（`Array.from` 按码点）；maxWidth = max(8, obj.width)。
- 基线 offset：`(lineHeight − fontBox)/2 + ascent`，`fontBoundingBoxAscent/Descent` 逐级回退 actualBoundingBox → fontSize×0.8/0.2。

### 撤销

- 编辑器内部全量快照栈：doc 变更 140ms debounce（trailing）、`JSON.stringify` 比对去重、栈深上限 50。
- 关闭编辑器：一次 `pushHistory` + 写回节点 `metadata.design`（编辑期间不触发画布 autosave 逐笔写入）。

## 渲染与导出

### canvas 渲染器（`renderDesignBoardToCanvas`）

- 管线：clearRect → 填充背景 → 按对象顺序绘制；每对象 `save()` → globalAlpha → 变换 → 绘制 → `restore()`。
- rect：圆角路径（`roundRect` 检测 + quadraticCurveTo 回退），`r = clamp(radius, 0, min(w,h)/2)`。
- image：`loadSceneImageElement`（按代理后 URL 键控缓存、Promise 去重、失败删键重试、非 data:/blob: 设 `crossOrigin='anonymous'`）→ 圆角 clip → drawImage。
- text：字体 `${style} ${weight} ${size}px ${family}`；逐行 y=i·lineHeight、基线偏移公式、对齐锚点 left=0/center=w/2/right=w；letterSpacing 逐字绘制（cursor 累进 + measureText(char)）。
- 尺寸必须 `round + max(1)`；`toDataURL` 显式传 mime（jpg→`image/jpeg`）。

### 导出

- 选项：格式 png/jpg（默认 png）、倍率 1–3、jpg 禁透明（MVP 固定不透明背景）。
- `setTransform(multiplier,…)` 统一缩放；导出前 `await document.fonts.load`（修正 avnac 已知的字体未就绪测量偏差坑，MVP 系统字体下为无害防御）。
- 文件名净化复用 batch-download 的清理规则；导出走现有 `compressImageDataUrl`（4MB/4096px，超限转 JPEG q0.92）→ `createNodeData('image')` 生成图片节点（content=dataUrl、mimeType、natural 尺寸），位置放在画板节点右侧。
- 跨域图片污染画布：统一 catch 转用户提示（沿用画布错误提示样式）。

### 节点缩略图

- 最长边目标 480px、`clamp(round(480/maxEdge), 1, 3)` 倍率；dataURL LRU 缓存 48 条，键 `nodeId:updatedAt`。
- 对象变更防抖 200ms 后重渲染；编辑器关闭时立即刷新一次。

## 集成点（防返工清单）

- `geometry.ts` `NODE_SPECS` 注册 design-board 默认尺寸（缩略图按 340×240 节点框）与标题「设计画板」；`node-registry.ts` minimap 色。
- `batch-download.ts` `collectBatchDownloadItems` 加映射：design-board → 导出 `metadata.design` 为 `.json`（否则会被 text 兜底导错）。
- 画布全局键盘门控：`boardEditing` 状态压制画布 Delete/Backspace/Ctrl+Z/Ctrl+A。
- 节点创建入口：节点创建菜单 + 双击空白菜单加「设计画板」项，触发预设选择对话框。
- CSP：图片渲染复用 `proxyExternalImageUrl` 白名单链路，不新增外部域名。

## 阶段划分

- **阶段一（本设计落地范围）**：预设选择、design-board 节点与缩略图、全屏编辑器（文本/图片/矩形、单选/拖动/缩放/删除、吸附、文本编辑、撤销）、画布资源面板、导出 PNG/JPG 生成图片节点、batch-download 映射、键盘门控。
- **阶段二**：旋转（Shift 15° 吸附）、多选/marquee/对齐分布/层级、图片裁剪（边柄裁剪语义）、不透明度/阴影/模糊、图片替换、画板尺寸修改、网络字体（引入即做 `document.fonts.load` 等待）、资产库并入资源面板。
- **阶段三（AI 工作流）**：Agent 工具集（参照 avnac 13 工具形态：`describe_board` 只读摘要 + add_text/add_image/add_rect/update_object/delete_object/set_background/clear_board），挂接现有 submit 工具体系（方案 D）；选中文本+图片节点一键生成画板初稿；quick prompts 池；导出结果接视频/下载链路。无事务回滚，依赖编辑器撤销栈。

## 测试范围

- `design-board-types`：默认值、钳制、解析校验（非法对象丢弃、NaN 防穿透）、node-ref 序列化。
- `design-board-resources`：图片节点收集、string/对象兼容、去重、悬空引用。
- 交互引擎纯函数：吸附求解（阈值/滞回/9 组合）、手柄 anchor 反推、等比约束公式、文本换行与基线、`pointerToScene`。
- 渲染器：每类对象绘制（jsdom canvas mock 或dataURL 快照）、导出倍率、jpg mime。
- 组件：预设选择、编辑器打开/关闭写回、快捷键门控（画布全局键在编辑器打开时不触发）、资源面板插入。
- 回归：batch-download 含 design-board 节点导出 `.json`；现有节点交互无变化。
- 验证命令：`pnpm --filter desktop test`、`pnpm --filter desktop typecheck`、相关 eslint。

## 许可证边界

- 仅参考 avnac 的公开交互规格、算法参数与架构思路；所有代码、类型命名、注释自研。
- 不引入 avnac 源码文件、不复制其文案资源（quick prompts 阶段三自拟中文版）。

## 验收标准

- 节点创建菜单出现「设计画板」，选择预设后创建节点并自动打开编辑器。
- 编辑器内可创建文本/矩形/插入画布图片，可拖动、缩放（含吸附）、删除，Ctrl+Z 可撤销。
- 双击文本进入编辑，Escape/失焦提交，换行与对齐正确。
- 关闭编辑器写回节点，缩略图更新，画布 autosave 正常，历史可回退。
- 导出 PNG/JPG 生成新图片节点，内容与画板一致，图片经代理无 CORS 失败。
- 编辑器打开期间画布全局快捷键失效，关闭后恢复。
- 批量下载选中含 design-board 的节点时导出 `.json`。
- 现有功能（单节点下载、JSON 导出、批量下载、媒体生成）无回归。
