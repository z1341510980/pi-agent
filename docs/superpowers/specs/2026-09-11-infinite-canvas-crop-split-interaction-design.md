# 无限画布 裁剪与拆分交互升级设计

## 背景

`media-dialog.tsx` 中的裁剪（CropDialog）与拆分（SplitDialog）目前只有数字输入：裁剪靠 X/Y/宽/高百分比字段，拆分靠行/列数，均无法在图上直接操作。本次对两个**相互独立**的功能分别升级为可视化交互。

## 目标

### 功能一：PS 式裁剪（拖动 + 放大镜）

- 在图上直接显示裁剪框：框外压暗、框内三分构图网格、8 个手柄（4 角 + 4 边中点）。
- 空白处按下并拖动可拉出新裁剪框；框内拖动整体移动；手柄拖动缩放，对侧边锚定。
- 拖动手柄时在光标旁显示圆形放大镜（约 4x）+ 中心十字线，并显示光标原图坐标与当前裁剪框像素尺寸，松手即消失。
- 比例预设：自由 / 1:1 / 4:3 / 16:9。锁定时角点与边中点手柄均保持比例；边中点拖动时另一轴围绕裁剪框中心伸缩。
- 保留 X/Y/宽/高数字输入，与拖动双向同步（最多 2 位小数）。
- 确认输出仍为百分比矩形，`cropDataUrl` 与节点生成链路不变。

### 功能二：拆分预览与可拖切割线

- 行/列数字保留（1–6），图上按行列实时预览网格切割线。
- 每条内部切割线可拖动（列线左右、行线上下），拖动时高亮并显示位置百分比与相邻两块的像素尺寸。
- 行/列数变化时智能增删切割线：增加在最大空隙中点插入，减少移除最接近中间的线，保留用户其余调整。
- 切割线之间保持最小间距（5%），整条钳制在图内。
- 确认输出携带每条切割线百分比位置，按非均匀边界切图；不传切割线时保持均分（向后兼容）。

## 非目标

- 不修改蒙版编辑、放大对话框的行为。
- 不新增服务端接口、数据库迁移或持久化变更。
- 不做裁剪旋转、透视矫正等 PS 高级能力。
- 不改变节点创建、命名、连线与历史行为。
- 两个功能不共享交互状态，互不影响。

## 交互设计

### 裁剪

1. 打开对话框即显示全图裁剪框；图片按 contain 适配（宽 = 对话框内容区，高上限 50vh），交互层与图片内容严格对齐。
2. 手柄为屏幕恒定尺寸（角点 12px 方块，边中点 12px 拉伸为双向条），光标复用 design-board 的 `cursorForHandle` 映射。
3. 空白处拖动新框宽或高小于 3% 时视为误触，恢复原框。
4. 放大镜直径 112px、4x，位于光标右上 24px，靠近右/上边缘时翻转，仅手柄拖动期间显示。
5. 比例在像素空间计算（百分比 × 原图宽高换算），切换预设时以当前框中心重塑并整体钳入图内。

### 拆分

1. 打开对话框默认 2×2；切割线渲染为白色半透明细线（带阴影），拖动命中区约 24px 宽。
2. 拖动时线体高亮为主题色，旁侧深色浮签显示 `百分比 · 左块宽×右块宽`（行线显示上下块高，单位原图像素）。
3. 切割线状态为严格递增的百分比数组（列线 columns−1 条、行线 rows−1 条），行列数与线数始终一致。

## 技术方案

- 新增 `media-dialog-shell.tsx`：从 `media-dialog.tsx` 抽出 `MediaDialogShell`、`DialogAction`、`NumberField` 供各对话框共用，消除后续循环引用。
- 新增 `media-stage.tsx`：`useImageNaturalSize`（加载原图尺寸）、`fitStageSize`（contain 适配纯函数）、`pointerToPercent`（指针→百分比纯函数）、`capturePointer`（jsdom 安全的指针捕获）、`MediaStage` 组件（显式尺寸渲染，消除现有 `object-contain` letterbox 下的坐标错位；`data-media-stage-content` 供 `closest()` 定位）。
- 新增 `crop-split-interaction.ts` 纯函数：`clampCropRect`、`resizeCropRect`、`moveCropRect`、`dragCropRect`、`applyCropRatio`、`seedCuts`、`normalizeCuts`、`addCut`、`removeCut`、`moveCut`、`adjustCutsToCount`、`cutBoundaries`、`piecePixelBounds`；手柄与光标复用 `design-board-interaction` 的 `RESIZE_HANDLE_IDS` / `cursorForHandle`。
- 新增 `crop-dialog.tsx`（裁剪框 + 放大镜，放大用 CSS background 定位实现、无 canvas 重绘）、`split-dialog.tsx`（切割线）；`media-dialog.tsx` 移除旧实现并 re-export，workspace 导入路径不变。
- `splitDataUrls` 增加可选 `rowCuts`/`columnCuts`，按 `piecePixelBounds` 的像素边界切图；`infinite-canvas-workspace.tsx` 的 `splitImage` 参数类型同步扩展。
- 放大镜读数与切割线浮签均使用原图像素坐标。

## 测试范围

- 纯函数全量单测：8 手柄 × 自由/锁定比例、边界与最小尺寸钳制、绘制新框、比例重塑、切割线播种/增删/移动/间距钳制、像素边界单调性与收敛。
- 组件测试：部分 mock `useImageNaturalSize` 并统一 mock `getBoundingClientRect`，验证裁剪拖拽→确认载荷、放大镜出现/消失、比例锁定、数字同步；拆分拖线→确认载荷、行列增删切割线、浮签显示与隐藏。
- 画布全套件回归、desktop web 类型检查、ESLint。

## 验收标准

- 裁剪：拖动/移动/缩放流畅；拖手柄出现放大镜与读数；比例锁定生效；数字输入与拖动同步；产物节点与现状一致（仍是「标题 裁剪」派生节点）。
- 拆分：网格预览即时反映行列数；拖线改变各块尺寸；确认后各块尺寸与预览一致；行列变化不丢失用户已调整的切割线。
- 既有测试无回归，类型检查与 ESLint 通过。
