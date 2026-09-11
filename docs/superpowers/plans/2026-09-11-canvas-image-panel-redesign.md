# 画布生成面板图像模式改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 图像模式面板改为「参考图上传 + 底部快捷栏（模型/快照/展开/存模板/发送）+ 图像设置 Popover」，服务端补齐 quality/background 透传与 count 1-10。

**Architecture:** 纯函数尺寸计算独立成 `image-size-math.ts`；弹层全部用 `components/ui`（Popover/Dialog/Switch/Segmented/Input/Button/Label）；服务端沿 generate-image 链路补两个可选字段。metadata 语义：`size:'auto'|'WxH'`、`quality:'auto'|'high'|'medium'|'low'`、`background?:'transparent'`、`count:1-10`。

**Tech Stack:** React 19、Radix（components/ui）、Tailwind + CanvasTheme、Vitest + Testing Library、Fastify 插件既有测试栈。

---

## Task 1: 服务端 quality/background 透传 + count 放宽

**Files:** `index.ts`、`media/generator.ts`、`media/adapter.ts`、`media/adapters/openai-images.ts`、对应测试（`media/__tests__/generator.test.ts`、`media/__tests__/openai-images-adapter.test.ts`）；`routes.ts` 不变（已透传）。

- [ ] **Step 1 失败测试**：
  - generator.test.ts：generateImage 传 `quality:'high'`、`background:'transparent'`、`count:10` → 断言 adapter 收到（或 fetch 载荷含 `quality:'high'`、`background:'transparent'`、`n:10`）。
  - openai-images-adapter.test.ts：JSON 生成链路（无参考图）body 含 `quality`/`background`/`n`；`quality:'auto'` 与 background 未设 → body 不含该键；count:10 → `n:10`；xKiro baseUrl → `n:1`；参考图链路（/images/edits）quality/background 同样映射。
- [ ] **Step 2 跑失败**：`pnpm --filter agent-server exec vitest run src/plugins/infinite-canvas-plugin/media/__tests__/generator.test.ts src/plugins/infinite-canvas-plugin/media/__tests__/openai-images-adapter.test.ts --environment node`
- [ ] **Step 3 实现**：
  - `index.ts` `generateImageCore` 入参类型与 `media.generateImage({...})` 转发补 `quality?: string`、`background?: string`（input 解构处加字段）。
  - `generator.ts` `MediaGenerator.generateImage` 接口 + dispatch 的 adapter 调用入参补两字段。
  - `adapter.ts` `MediaGenerationInput` 补 `quality?: string; background?: string`。
  - `openai-images.ts`：`submitJsonGeneration` body 增加 `...(this.qualityParam(input.quality) ?? {})`、`...(this.backgroundParam(input.background) ?? {})` 形态（实现为模块级纯函数导出以便单测：`openAiQualityParam(q?: string): {quality:string}|undefined`（白名单 auto/high/medium/low，小写归一）与 `openAiBackgroundParam(b?: string): {background:string}|undefined`（'transparent'→'transparent'，其余 truthy→'opaque'？仅 'transparent'/'opaque' 白名单））；`n` 钳制 `Math.min(10, Math.max(1, input.count))`；multipart 链路同映射。
  - 工作区 count 钳制（desktop `infinite-canvas-workspace.tsx:2149-2150`）`Math.min(4)` → `Math.min(10)`；`canvas-node-panel.tsx` 数量输入 `max={4}`/clamp 4 → 10（ConfigSettingsRow image 分支在本版被弹窗取代，若仍留有音视频外数量输入则以弹窗为准）。
- [ ] **Step 4 全部通过 + `pnpm typecheck:server` + eslint，提交** `feat: pass image quality/background through generation chain`

## Task 2: 桌面端面板改版

**Files:**
- Create: `canvas-node-panel/image-size-math.ts`（纯函数）+ `__tests__/image-size-math.test.ts`
- Modify: `canvas-node-panel.tsx`（底部快捷栏 + 图像设置 Popover + 展开 Dialog + 存模板 + 上传按钮）
- Modify: `infinite-canvas-workspace.tsx`（`addReferenceImages` 回调 + 传入面板）
- Test: `__tests__/canvas-node-panel.test.tsx` 增补

### 纯函数模块（完整规格）

```ts
// image-size-math.ts
export type QualityTier = 'auto' | 'high' | 'medium' | 'low'
export type ResolutionTier = 'auto' | '1k' | '2k' | '4k'

export const RATIO_PRESETS: Array<{ id: string; w: number; h: number; label: string }> = [
  { id: '1:1', w: 1024, h: 1024, label: '1:1' },
  { id: '2:3', w: 1024, h: 1536, label: '2:3' },
  { id: '3:2', w: 1536, h: 1024, label: '3:2' },
  { id: '4:3', w: 1152, h: 896, label: '4:3' },
  { id: '3:4', w: 896, h: 1152, label: '3:4' },
  { id: '16:9', w: 1536, h: 864, label: '16:9' },
  { id: '9:16', w: 864, h: 1536, label: '9:16' },
  { id: '21:9', w: 1792, h: 768, label: '21:9' },
  { id: '9:21', w: 768, h: 1792, label: '9:21' }
]

export const align16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)

/** 分辨率档缩放：tier→倍数（1k=1, 2k=2, 4k=4），16 对齐。 */
export function scaleForTier(ratio: { w: number; h: number }, tier: ResolutionTier): { width: number; height: number }
// 'auto' → {width:0,height:0}（表示自动）；否则 align16(w*m)×align16(h*m)

/** 解析 metadata.size：'auto'→null；'WxH'→{width,height}；非法→null。 */
export function parseSizeValue(size: unknown): { width: number; height: number } | null

/** 序列化：width/height 均 >0 → `${w}x${h}`；否则 'auto'。 */
export function formatSizeValue(width: number, height: number): string

/** 宽高联动：ratio = w/h（用变更前的值），已知一边+锁定 → 另一边 align16。 */
export function syncLinkedSize(
  current: { width: number; height: number },
  edited: 'width' | 'height',
  value: number,
  locked: boolean,
  align: boolean
): { width: number; height: number }

/** 匹配比例名：WxH 与 preset 宽高比误差 <2% → 返回 preset.label，否则 null。 */
export function ratioLabelForSize(width: number, height: number): string | null

/** 快照文案：size auto/非法 → `自动·<n>张`；否则 `<比例名|W×H>·<n>张`。quality 非 auto 时前缀 `<质量>·`（高/中/低）。 */
export function snapshotLabel(size: unknown, count: number, quality: QualityTier): string
```

测试：每函数 2-4 例（含 21:9 基准、2k/4k 缩放、align16 边界、联动锁、比例匹配容差、快照各分支）。

### 面板结构改动（锚点）

1. **参考区**（orderedReferences 行，~L639-667）：行尾加 `<label>` 上传按钮（Plus 图标，隐藏 `<input type="file" accept="image/*" multiple>`，onChange 调 `props.onAddReferenceImages?.(node.id, files)` 后清空 value）；无参考时的空态文案保持。
2. **提示词 placeholder**（~L696-704）：config+image 分支 → `描述要生成的图片内容`。
3. **底部行**（~L764-811）重构，config+image 分支渲染 `<ImageQuickBar>`（新组件，同文件）：
   - `ModelPicker`（原样）
   - 快照 pill：`<Popover><PopoverTrigger asChild>` 内 Button variant ghost pill，文本 `snapshotLabel(...)`；`PopoverContent side="top" align="end"` 内 `<ImageSettingsPopover>`。
   - `ImageSettingsPopover`：质量 Segmented（自动/高/中/低）、分辨率 Segmented（自动/1k/2k/4k）、比例网格 `grid-cols-5`（tile = 缩略框+label，选中态 activeBg）、W/H Input ×2 + 联动锁 Button（Lock/Unlock 图标）+ 「16 倍数对齐」Switch、透明背景 Switch + 「仅部分模型支持」标注、张数 Input(1-10)。全部经 `changeConfig` 写 `{size|quality|background|count}`；内部 state 用 `useState` 从 metadata 派生 + 编辑即写（受控回显以 metadata 为准）。
   - 图标按钮：展开（Maximize2 → `<Dialog>` 大 textarea 绑定 prompt，onPromptChange；Ctrl/Cmd+Enter 触发 onGenerate 并关闭）、存模板（BookmarkPlus → `saveCanvasAsset({ kind: 'text', title: prompt.slice(0,20) || '提示词模板', content: prompt.trim() })`，import 自 `../asset-library`（确认实际导出路径/函数名后适配），成功后 800ms 内显示 Check）、发送（圆形 ArrowUp，沿用 canGenerate/isRunning/停止逻辑）。
   - image 模式下 `ConfigSettingsRow` 不再渲染（尺寸/张数移入弹窗）；video/audio 分支维持现状（ModelPicker + ConfigSettingsRow + 生成按钮不变）。
   - 非_config 图像工作流节点同样使用 ImageQuickBar。
4. **工作区**：新增 `addReferenceImages = useCallback(async (nodeId, files) => {...})`：对每个 image file → `fileAsDataUrl` → `compressImageDataUrl`（复用 insertFile L1654-1690 的既有管线与命名「参考图」）→ `uploadCanvasAsset` → `createNodeData('image', ...)` 定位在源节点左上偏移 → pushHistory + setNodes + setConnections（连线 toNodeId=nodeId）。面板 props 加 `onAddReferenceImages?: (nodeId: string, files: FileList) => void`，workspace 传 `{(id, files) => void addReferenceImages(id, files)}`。

### 组件测试（canvas-node-panel.test.tsx 增补；Radix 真渲染，jsdom 已 polyfill）

1. 快照 pill 文本：`{count:3}` 无 size → `自动·3张`；`{size:'1536x864',count:2}` → `16:9·2张`；quality 'high' → 前缀 `高·`。
2. 点击快照 → Popover 内容出现（`await screen.findByText('质量')`）；点「21:9」tile + 分辨率 2k → metadata.size === `3584x1536`。
3. 质量选「高」→ `onConfigChange` 收到 `{quality:'high'}`；透明背景 Switch 开 → `{background:'transparent'}`；张数 Input 改 12 → 钳 10。
4. 展开图标 → Dialog 出现，textarea 改文本 → onPromptChange 收到新值。
5. 存模板：mock `saveCanvasAsset` 模块 → 点击后以 `{content: prompt}` 调用。
6. 上传按钮：`fireEvent.change(hiddenInput, {target:{files:[new File(...)]}})` → `onAddReferenceImages` 以 (nodeId, files) 调用。
7. 既有 10 个模型选择/SizePicker 测试保持通过（image ConfigSettingsRow 移除会使「尺寸」相关用例改为断言弹窗内 tile——按实际适配并在报告中列出）。

## Task 3: 回归（controller 执行）

画布全套件 + server 插件套件 + 双端 tsc + eslint 触碰文件 + git 核对。

## Plan Self-Review

- Spec coverage：上传/占位符/快捷栏五件套/弹窗六区/服务端透传/张数放宽均落在 Task 1-2；apimart 单张协议不改。
- Placeholder scan：无 TBD；纯函数给全签名，组件给结构契约与测试断言；`saveCanvasAsset` 导入路径允许按实际适配（报告列出）。
- Type consistency：metadata 键与 `CanvasNodeMetadata` 既有 size/quality/background/count 一致，无新键。
- Scope：video/audio 不动；无迁移无新路由。
