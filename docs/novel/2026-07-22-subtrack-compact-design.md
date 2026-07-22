# 子轨道紧凑视觉编码设计

日期：2026-07-22
状态：已确认原型，待实现

## 背景

当前子轨道（InlineSubtracks）在窄章节单元格内渲染大量文本标签，导致：
- text/reference 维度的长文本溢出、横向堆叠重叠
- enum/level 维度的 band 标签 + 节点标签在窄列里挤压
- SVG `<text>` 无裁剪，溢出覆盖相邻章节列
- 整体视觉杂乱，信息密度过高

用户决策：
- 优先保持紧凑，详情通过交互展开
- set 类型用数字徽标
- text/reference hover 显示气泡卡片
- enum 色块 + 左侧图例
- 气泡 hover 触发，移开消失
- 空数据折叠隐藏

## 设计

### 核心原则

- **默认状态**：纯视觉编码（色块 / 曲线 / 徽标 / 圆点），无文字标签
- **交互状态**：hover 任一元素显示气泡卡片，含完整信息

### 各维度类型的默认渲染

| 类型 | 维度示例 | 渲染方式 |
|------|----------|----------|
| enum / level | 弧光阶段、冲突阶段、揭示状态 | 连续色块（同值连续段合并，颜色按值映射深浅），变化交界处 2px 竖线刻度，无文字 |
| number | 张力强度、推进进度、回收章节 | 迷你折线（sparkline），数据点小圆点 r=2，无文字 |
| set | 关联冲突、关联线索 | 数字徽标（圆形 r=8，实体色背景白色数字），0 项不显示 |
| text / reference | 当前状态、目标、压力、认知转变 | 小圆点 r=3，实体色，无文字 |

### 左侧轨道标签 + 图例

- 所有维度：轨道名前有实体色小圆点
- enum / level 类型：标签后跟 3-4 个小色块 + 短阶段名图例
- 其他类型：仅轨道名

### Hover 气泡卡片

- 触发方式：hover 即显示，移开即消失
- 样式：暗色卡片 max-width 280px + 下方箭头指向触发元素
- 内容：
  - 维度名（蓝色加粗）
  - 第 N 章（灰色小字）
  - 变化前 → 变化后（旧值红色删除线，新值绿色）
  - 描述（灰色小字）

### 空数据轨道

- 折叠隐藏，不占空间

### 行高

- 保持 28px

## 实现范围

### 修改文件

1. `apps/desktop/src/renderer/src/components/novel/matrix/inline-subtracks.tsx`
   - `buildInlineSubtracks`：移除所有 `valueLabel` 赋值，set 类型 band label 改为数字（用于徽标渲染）
   - `SubtrackOverlay`：
     - enum/level：渲染连续色块 + 变化处竖线刻度，无 `<text>`
     - number：渲染 sparkline，无 `<text>`
     - set：渲染数字徽标（`<circle>` + `<text>` 仅含数字）
     - text/reference：渲染小圆点，无 `<text>`
   - 新增 `SubtrackBubble` 组件：hover 气泡卡片，用 HTML 定位（绝对定位 + transform），不放在 SVG 内
   - `SubtrackRow`：左侧标签列增加图例渲染（enum/level 类型）
   - 空数据轨道：`tracks.length === 0` 时返回 `null`（折叠）

2. `apps/desktop/src/renderer/src/components/novel/matrix/subtrack-builders.ts`
   - `SubtrackNode` 接口：`valueLabel` 改为可选且不再用于显示，新增 `badge?: number`（set 类型的徽标数字）
   - `SubtrackBand` 接口：新增 `valueKey?: string`（用于 enum 颜色映射）

### enum 颜色映射

- 对每个 enum 维度，收集所有出现过的值，按首次出现顺序映射到 3 档透明度（0.3 / 0.6 / 0.9）
- 超过 3 个值时循环使用透明度档位

### 数据流

```
getMatrixAggregation (API)
  → NovelChangeRecord[] (含 dimension / valueType / afterValue)
  → buildInlineSubtracks (按 dimension 分组)
  → SubtrackDef[] (含 bands / curve / nodes / legend)
  → SubtrackRow (渲染色块/曲线/徽标/圆点 + hover 气泡)
```

## 验证

- `pnpm --filter desktop run typecheck:web` 通过
- `pnpm --filter desktop exec vitest run src/renderer/src/components/novel/matrix` 通过
- 视觉对比：与原型 `docs/novel/subtrack-prototype.html` 一致
