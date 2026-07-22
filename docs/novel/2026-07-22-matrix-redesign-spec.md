# 故事矩阵前端重设计方案

日期：2026-07-22
状态：原型已出（`docs/novel/matrix-redesign-prototype.html`），待评审后实施
关联：`2026-07-21-story-matrix-unified-engine-design.md`（统一引擎）、`2026-07-22-subtrack-compact-design.md`（子轨道紧凑编码）

---

## 1. 目标与原则

目标：好看、统一、交互顺畅。落到四条可验收的原则：

1. **一个引擎**：折叠态与展开态同一渲染管线、同一数据投影（账本 ChangeRecord），彻底删除 svar 甘特旧链路。
2. **一套语言**：一套色板、一套透明度刻度、一套圆角/行高、一套悬浮卡、一套拖拽反馈，跨 9 类实体一致。
3. **密度分层**：默认纯视觉编码（色带/曲线/徽标/圆点），hover 出悬浮卡，点击出详情面板。任何状态下无文字挤压。
4. **即时反馈**：所有操作 100ms 内有视觉响应；拖拽有吸附预览；编辑走 optimistic update。

## 2. 现状问题清单（代码实证）

| # | 问题 | 证据 |
|---|---|---|
| P1 | 双引擎双数据源：折叠态读实体快照字段，展开态读账本投影；svar 甘特链路全死代码 | `entity-gantt-focus.tsx` / `entity-gantt-adapter.ts` / `subtrack-popover.tsx`（永不可达）/ `story-event-dialog.tsx` / `subtrack-builders.ts` |
| P2 | N 个展开实体 = N 次全量 aggregation 请求 | `inline-subtracks.tsx` queryKey 含 entityId 但请求参数不含 |
| P3 | 悬浮信息两套机制：data-tip 委托（MatrixTooltip）+ CSS group-hover（SubtrackBubble），样式与时机不一致 | `matrix-tooltip.tsx` vs `inline-subtracks.tsx:803` |
| P4 | 拖拽四种拖源各自为政，拖动中无吸附预览，子轨道完全只读 | `matrix-logic.ts` 4 种 DragData；`handleSubtrackDoubleClick` 被 void |
| P5 | buildGroups 在 Workspace 和 View 各算一遍；行高/列宽魔法数散落 | `matrix-workspace.tsx:231` / `matrix-view.tsx` |
| P6 | 垂直无虚拟化，多实体展开 DOM 膨胀；关系连线 Y 偏移（entityRowY 按折叠行高硬算） | `matrix-view.tsx` 注释自承 |
| P7 | mutation 后全量 refetch + 子轨道缓存（30s staleTime）可能陈旧 | `matrix-workspace.tsx` 各 handler |

## 3. 视觉系统

### 3.1 色板（沿用 GROUP_META 九色，不动语义）

角色 #3b82f6 / 冲突 #e8463a / 线索 #22c55e / 伏笔 #f59e0b / 势力 #a855f7 / 地点 #06b6d4 / 世界要素 #4b3fe3 / 信息差 #14b8a6 / 物品 #d97706

### 3.2 统一透明度刻度（浅色主题）

| 用途 | alpha | 说明 |
|---|---|---|
| 行 hover 底色 | 0.04 | 整行（含 sticky 列） |
| 选中底色 | 0.07 | + 左侧 2px 实体色条 |
| 色带填充 | 0.22 | band 主体 |
| 色带描边 | 0.45 | 1px |
| 播放头列 | amber 0.07 | + 标尺三角 |
| enum 子轨道色块 | 0.30 / 0.60 / 0.90 | 按值首现顺序循环三档 |

### 3.3 几何与排版

- 行高：标尺 40px / 分组头 26px / 实体行 32px / 子轨道 26px（现状 44/28/32/28 收敛）
- 色带：高 18px 垂直居中，圆角 4px；节点圆点 r=3；徽标圆 r=8 白字
- 网格：竖线 1px rgba(115,115,115,0.07)，每 5 章加深至 0.16，取消横向行线的视觉重量
- 标尺：章节号 11px 等宽数字 + 底部 5px 张力热力条（绿→琥珀→红渐变）
- 字体：Plus Jakarta Sans / PingFang SC / Microsoft YaHei；数字 tabular-nums
- 图标：Lucide 线性图标，禁用 emoji 字符

### 3.4 悬浮卡（唯一一套）

白底 + rgba(115,115,115,0.18) 描边 + 8px 圆角 + 阴影，max-width 280px，箭头指向触发元素；内容为「维度名（实体色加粗）/ 第 N 章（灰）/ 旧值（红删除线）→ 新值（绿）/ 描述（灰）」。全矩阵（单元格、色带、节点、子轨道、标尺 marker）统一 120ms 延迟单例弹出，移开即消。

## 4. 交互系统

### 4.1 统一拖拽（2 种拖源 × 1 套反馈）

- 拖源收敛为 **band-drag**（色带整体平移 / 端点拉伸，hover 色带浮现左右把手）与 **node-drag**（伏笔 beat、地点/物品出场点、侧栏实体拖入）
- 拖动中：原色带 50% 透明，目标位置显示吸附幽灵带 + 章节号气泡；松手吸附到最近章节列，非法目标红色拒绝态
- 子轨道节点（可编辑维度）同语言拖拽：纵向锁死、横向吸附章节

### 4.2 点击语义（全矩阵一致）

| 操作 | 语义 |
|---|---|
| 单击单元格 | 切换出场（按实体类型自适应） |
| 单击行首 | 选中（Ctrl 多选、Shift 连选），联动右面板 |
| 双击色带 | 打开实体详情 |
| 右键 | 上下文菜单（章节列 / 单元格 / 分组空白三套） |
| 行首 chevron | inline 展开子轨道（多实体可同时展开） |

### 4.3 键盘与滚动

↑↓ 移动选中 / Enter 展开 / Esc 清空 / Ctrl+A 全选可见；Shift+滚轮横向滚动；Ctrl+滚轮以光标为中心缩放（28–76px 连续，替代步进 4 的按钮档）。

## 5. 信息架构

### 5.1 折叠态（每类实体一种主编码）

| 实体 | 主编码 |
|---|---|
| 角色 | 出场连续段色带 + 主角标记 |
| 冲突 | 多段色带（强度渐变）+ 高潮菱形标 |
| 线索 | 跨度色带 + 进度端点刻度 |
| 伏笔 | 埋设→回收连线 + beats 节点（plant/reinforce/payoff 三态） |
| 势力 | 跨度色带（实力深浅） |
| 地点/物品 | 出场章圆点列 |
| 信息差 | 隐藏期色带 + 揭示章标记 |
| 世界要素 | 全程细带 |

### 5.2 展开子轨道（紧凑编码，按已确认的 7 项调整）

- enum/level：同值连续色块 + 变化处 2px 竖线，左侧 3–4 档图例
- number：sparkline + r=2 数据点
- set：r=8 数字徽标（0 不显示）
- text/reference：r=3 圆点，详情全在悬浮卡
- 空轨道折叠；dimension 清单按 PR4 确认结果调整（faction.strength 换 activity、info_layer.knowledge_spread 新增等）

## 6. 数据流与性能

- **单聚合请求**：matrix-aggregation 按 projectId 一个 queryKey，展开实体共享缓存，前端按 subjectType/subjectId 过滤（修 P2）
- **buildGroups 上移**：Workspace 算一次，props 下发（修 P5）
- **垂直虚拟化**：行级 windowing（ overscan 5 ），展开行按实际高度计入；修关系连线 Y 偏移（改由行高累加表驱动）（修 P6）
- **mutation 局部更新**：写操作直接更新 zustand + 精确 invalidate aggregation，不做全量 refetch（修 P7）
- 删除死代码：entity-gantt-focus / entity-gantt-adapter / subtrack-popover / story-event-dialog / subtrack-builders 中仅服务 svar 的部分（修 P1）

## 7. React 组件架构（目标结构）

```
matrix/
├── matrix-workspace.tsx        # 接线层：store + mutation + 对话框（瘦身至 ~600 行）
├── matrix-view.tsx             # 纯渲染：标尺 + 分组 + 行 + 虚拟化（~700 行）
├── matrix-row.tsx              # 实体行（sticky 行首 + 单元格 + 主编码 SVG）
├── matrix-subtracks.tsx        # inline 子轨道（吸收 inline-subtracks.tsx，共享 overlay 组件）
├── matrix-overlay-svg.tsx      # band/curve/node/badge 统一渲染件（折叠态与子轨道复用）
├── matrix-hover-card.tsx       # 唯一悬浮卡系统（替代 matrix-tooltip + SubtrackBubble）
├── matrix-drag-layer.tsx       # 统一拖拽幽灵 + 吸附预览
├── matrix-model.ts             # buildGroups + 账本投影 + 行高累加表（吸收 matrix-logic.ts 纯函数）
└── （删除）entity-gantt-focus / entity-gantt-adapter / subtrack-popover / story-event-dialog
```

数据与行为接口保持与 novel-data-store / novel-ui-store / novel-client 兼容，不改后端。

## 8. 实施步骤

1. M1 底座：matrix-model 单聚合 + buildGroups 上移 + 死代码删除（行为不变，先止血）
2. M2 渲染统一：matrix-row + overlay-svg + 子轨道并入，视觉系统全套落地
3. M3 交互统一：hover-card 单例 + drag-layer + Ctrl 缩放 + 垂直虚拟化
4. M4 打磨：动画曲线、空态、键盘、性能 Profile

每步独立可验证，随时可停。

## 9. 原型

`docs/novel/matrix-redesign-prototype.html`：单文件可交互原型（浅色主题，16 章 × 9 类实体 mock 数据），覆盖本方案全部视觉编码与核心交互（展开子轨道、悬浮卡、拖拽吸附、缩放、过滤、播放头）。评审通过即按第 7-8 节实施。
