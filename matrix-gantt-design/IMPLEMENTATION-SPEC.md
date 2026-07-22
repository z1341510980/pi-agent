# 矩阵甘特图 · 按设计稿修改 · 实施规格

基于 grill-me 决策树梳理，共 23 项决策。

## 一、交付范围（问题 1、22）

**范围：视觉对齐 + 子甘特图展开 + 全部子轨道交互（含弹窗补数据 + 数据模型扩展）**

样板实体：冲突、伏笔。其余 6 类实体（角色/线索/势力/地点/世界要素/信息层）记录待办。

## 二、视觉对齐（问题 2-7）

### 2.1 色带高度与圆角（问题 2）
- 主矩阵色带：回退到设计稿 **19px / 圆角 6px**（回退我上轮的 24px/5px）
- 子轨道色带：统一 **24px / 圆角 5px**

### 2.2 单元格与实体列默认值（问题 3）
- `DEFAULT_CELL_WIDTH`: 36 → **56**
- `SIDEBAR_W_DEFAULT`: 200 → **240**

### 2.3 斑马纹与分隔线（问题 4）
- 保持 React 主题 token（`bg-surface-4` / `border-border/10`），不硬编码 rgba
- 理由：支持暗色模式

### 2.4 色带视觉装饰（问题 5）
- 回退到设计稿纯净版：去掉 `box-shadow`、`font-medium`、`tracking`
- 色带内无文字标签，这些样式无意义

### 2.5 实体列名称与角标（问题 6）
- 保持 React 现状：选中态 `text-primary font-medium`、ChevronRight 箭头、"主"角标
- 不加 desc 描述（数据结构无对应字段）

### 2.6 播放头标签（问题 7）
- 保持现状 `bg-amber-500` 纯色，不加发光效果

## 三、子甘特图展开机制（问题 8-11、14-18）

### 3.1 触发方式（问题 8）
- 实体行首独立展开按钮（chevron-right/chevron-down），与选中实体分离
- 点击 chevron toggle 展开/收起；点击实体名称仍为选中

### 3.2 多实体共存（问题 9）
- **可同时展开多个**，各自独立 toggle
- store 用 `expandedEntityIds: string[]`（非 Set，便于序列化）

### 3.3 渲染位置（问题 11）
- 实体行下方内联展开，作为兄弟节点插入，撑高整体高度

### 3.4 左侧标签列对齐（问题 14）
- 严格对齐主矩阵实体列：复用 `sidebarWidth`/`sticky left-0 z-30`/`bg-surface-1`
- 内容：3px 色条 + 12px 标签 + 折叠按钮（chevron-up）

### 3.5 横向滚动同步（问题 15）
- 复用主矩阵 `visibleChapterColumns` / `visibleRange`
- 色带/曲线/节点用绝对定位 `left = (ch-1) * cellWidth`

### 3.6 展开动画（问题 16）
- framer-motion `AnimatePresence` + `height: 0 → auto` + `opacity: 0 → 1`
- 时长 0.2s easeOut

### 3.7 展开状态持久化（问题 17）
- **不持久化**，每次进项目默认全部收起
- `expandedEntityIds` 不加入 `partialize`

### 3.8 展开后实体行视觉反馈（问题 18）
- 展开背景按实体类型颜色着色：`rgba(colorRgb, 0.06)`
- "展开"角标用该实体类型颜色

## 四、子轨道交互（问题 19-21）

### 4.1 交互级别（问题 19）
- **完全交互**：色带可拖拽调整、曲线节点可拖拽改值

### 4.2 数据写回（问题 20）
- 有字段的子轨道：直接拖拽写回（冲突 chapterSpans/intensity、伏笔 plantChapter/payoffChapter/foreshadowBeats）
- 缺字段的子轨道：双击弹窗引导补数据

### 4.3 弹窗补数据形态（问题 21）
- 浮层 Popover 对话框，定位在色带旁边
- 内含实体选择器，选完写回

## 五、数据模型扩展（问题 23）

### 5.1 冲突新增字段（`packages/shared/src/novel/index.ts` NovelConflict）
```ts
/** 强度曲线点（多点，区别于单值 intensity） */
intensityPoints?: Array<{ chapter: number; value: number }>
/** 参与方按章节范围关联 */
participantSpans?: Array<{ characterId: string; startCh: number; endCh: number }>
/** 关键转折点（多点，区别于单值 climaxChapter） */
turningPoints?: Array<{ chapter: number; label: string }>
/** 解决进度曲线 */
resolutionProgress?: Array<{ chapter: number; percent: number }>
/** 关联线索 ID 列表 */
linkedClues?: string[]
```

### 5.2 伏笔新增字段（NovelForeshadow）
```ts
/** 回收进度点（多点，区别于单值 recoverByChapter） */
resolutionPoints?: Array<{ chapter: number; label: string }>
```

所有新增字段可选（`?`）+ 默认空数组，向后兼容。

## 六、文件改动清单

### 6.1 视觉对齐（阶段一）
| 文件 | 改动 |
|------|------|
| `matrix-view.tsx` | 色带 19px/6px、去 box-shadow/font-medium/tracking |
| `matrix-workspace.tsx` | `DEFAULT_CELL_WIDTH=56`、`SIDEBAR_W_DEFAULT=240` |

### 6.2 子甘特图展开（阶段二）
| 文件 | 操作 | 内容 |
|------|------|------|
| `novel-ui-store.ts` | 改 | 新增 `expandedEntityIds`/`toggleEntityExpand`/`collapseAllExpanded` |
| `matrix-view.tsx` | 改 | 实体行加 chevron 展开按钮、AnimatePresence 包裹子轨道 |
| `entity-subtracks.tsx` | 新建 | 子轨道渲染组件 |
| `subtrack-builders.ts` | 新建 | 冲突/伏笔子轨道数据构建 |

### 6.3 子轨道交互 + 数据模型（阶段三）
| 文件 | 操作 | 内容 |
|------|------|------|
| `packages/shared/src/novel/index.ts` | 改 | NovelConflict/NovelForeshadow 新增字段 |
| `entity-subtracks.tsx` | 改 | 色带拖拽、曲线节点拖拽、双击弹窗 |
| `subtrack-popover.tsx` | 新建 | 弹窗补数据 Popover |
| 后端 API | 改 | 新字段的 CRUD |

## 七、待办记录（非本次交付）

- [ ] 其余 6 类实体子轨道（角色/线索/势力/地点/世界要素/信息层）
- [ ] 子轨道数据模型扩展到其余实体类型
- [ ] 完整拖拽创建色带（mousedown→mousemove→mouseup 预览）
- [ ] 进度拖拽手柄（冲突 intensity/线索 progress）

## 八、验证标准

1. `npx tsc --noEmit -p tsconfig.web.json` 零新增错误
2. `npm run dev` 启动后：
   - 色带 19px、单元格 56px、实体列 240px
   - 点击 chevron 展开子轨道，高度动画 0.2s
   - 同时展开多个实体正常
   - 拖拽冲突阶段色带写回 chapterSpans
   - 双击"参与方"子轨道弹窗补数据
3. 后端迁移：新增字段默认空数组，不破坏现有数据
