# 章节-实体矩阵视图：替换时间线方案

## 目标

**删除**当前视频编辑器风格的时间线视图（轨道+片段），**替换为**章节-实体矩阵视图。矩阵视图以「章节 × 实体」二维呈现叙事结构，服务小说创作时的结构性思维。

## 设计原型

参考 `demo/matrix-view-demo.html` 的视觉原型。核心设计原则：

- **横轴**：章节（标尺：章节号 + 标题）
- **纵轴**：实体（按类型分组折叠：角色/冲突/伏笔/势力/地点/世界要素）
- **单元格**：24px 宽 × 28px 高，用符号 + 颜色编码信息
- **当前章节列**：整列琥珀色高亮
- **深色主题**：IDE 式信息密度 + 衬线字体呼应文学气质

### 符号系统

| 符号 | 实体类型 | 含义 |
|------|---------|------|
| `●` 实心圆 | 角色 | 出场（大圆=主角，中圆=配角，半透明=仅提及） |
| `▲` 三角 | 冲突/势力 | 起始章 |
| `▼` 倒三角 | 冲突/势力 | 结束章 |
| 色带 | 冲突/势力 | 起始→结束跨度（半透明背景带） |
| `●` 实心圆 | 伏笔 | 埋设章 |
| `○` 空心圆 | 伏笔 | 回收章 |
| 虚线 | 伏笔 | 埋设→回收连接（未回收用虚线+`→`箭头） |
| `◆` 菱形 | 地点 | 出场章 |
| 色带 | 世界要素 | 全程存在（渐变色带） |
| `▌` | 当前章节 | 整列高亮 |

## 文件变更清单

### 新建文件（6 个）

| 文件 | 用途 |
|------|------|
| `matrix/matrix-logic.ts` | 纯函数：单元格计算、跨度计算、分组逻辑 |
| `matrix/matrix-view.tsx` | 主矩阵组件（标尺+分组+实体行+单元格） |
| `matrix/matrix-sidebar.tsx` | 左侧实体分组栏（分组标题+折叠/展开+实体名） |
| `matrix/matrix-toolbar.tsx` | 工具栏（过滤/缩放/补全历史/撤销重做） |
| `matrix/matrix-styles.css` | 矩阵视图样式（从 demo 提取并适配项目） |
| `matrix/__tests__/matrix-logic.test.ts` | 纯函数 TDD 测试 |

### 修改文件（3 个）

| 文件 | 变更 |
|------|------|
| `novel-workspace.tsx` | ① ViewSwitcher 改为 `'matrix' \| 'canvas'`；② 引入 MatrixView 替换 NovelTimelineWorkspace；③ 删除 ChapterContentEditor 的垂直分割（正文编辑后续另做） |
| `novel-store.ts` | 无结构变更（playheadChapter 已存在，复用） |
| `novel-client.ts` | 无变更（数据接口已完备） |

### 删除文件（整个 timeline/ 目录，约 20 个文件）

| 分类 | 文件 |
|------|------|
| 核心组件 | `timeline-editor.tsx`、`novel-timeline-workspace.tsx`、`timeline-toolbar.tsx` |
| 菜单/弹窗 | `chapter-context-menu.tsx`、`clip-context-menu.tsx`、`clip-note-dialog.tsx`、`marker-context-menu.tsx`、`marker-edit-dialog.tsx`、`track-context-menu.tsx` |
| 辅助视图 | `element-pool.tsx`、`timeline-markers.tsx`、`timeline-minimap.tsx`、`timeline-relation-layer.tsx`、`timeline-word-count-bar.tsx` |
| 数据/样式 | `use-timeline-data.ts`、`timeline-logic.ts`、`timeline-styles.css` |
| 测试 | `__tests__/` 下全部 4 个测试文件 |

## 数据流

```
novel-store (store)
  ├─ chapters, characters, conflicts, foreshadows, factions, locations, worldElements
  ├─ characterHistory, markers, relationships
  └─ playheadChapter, setPlayheadChapter
        │
        ▼
  useMatrixData (new hook)
    输入：store 中的数据
    输出：MatrixData { groups: Group[], maxChapter: number }
          Group { id, kind, name, color, collapsed, entities: Entity[] }
          Entity { id, name, kind, data }
          │
          ▼
  MatrixView (主组件)
    ├─ MatrixToolbar (过滤/缩放/补全/撤销重做)
    ├─ MatrixSidebar (分组+实体名)
    └─ MatrixContent (标尺行 + 实体行 + 单元格)
           ├─ ruler cells (章节号 + 标题)
           ├─ character cells (● 出场)
           ├─ conflict cells (▲▼ 跨度)
           ├─ foreshadow cells (●○ 埋设回收)
           ├─ faction cells (▲▼ 跨度)
           ├─ location cells (◆ 出场)
           └─ world element cells (色带 常驻)
```

### 实体类型与数据映射

| 矩阵行类型 | 数据来源 | 判断逻辑 |
|-----------|---------|---------|
| 角色出场 | characterHistory.filter(h => h.characterId === char.id) | chapterNumber 存在则出场 |
| 角色"仅提及" | 未来扩展 | 当前无数据源，暂时不实现 |
| 冲突跨度 | conflict.firstChapter + conflict.lastChapter | firstChapter 非空则显示 |
| 伏笔埋设回收 | foreshadow.firstChapter + foreshadow.recoverByChapter | firstChapter 非空则埋设，recoverByChapter 非空则回收 |
| 势力跨度 | faction.firstChapter + faction.lastChapter | 与冲突相同逻辑 |
| 地点出场 | location.appearChapters[] | 数组中的章节号 |
| 世界要素 | worldElement | 默认全程 1..maxChapter |

## 保留功能

### 从时间线迁移到矩阵的功能

| 功能 | 矩阵中的实现 |
|------|-------------|
| 播放头（当前章节指示器） | 整列高亮（琥珀色） + 点击章节标尺跳转 |
| 按类型过滤 | 工具栏 chips（点击角色/冲突/伏笔...只显示对应分组） |
| 撤销/重做 | 工具栏按钮（复用现有 EditAction 历史系统） |
| 缩放 | 工具栏 ± 按钮（调整 `--cell-w` CSS 变量：16px~40px） |
| 补全角色历史 | 工具栏按钮（复用现有逻辑） |
| 片段批注 | 单元格 hover tooltip 显示批注内容 |
| 标记（书签/转折点/高潮/备注） | 标尺上的标记图标（从 timeline-markers 迁移） |
| 章节右键菜单 | 复用 ChapterContextMenu（生成/重新生成/查看/删除） |

### 不再需要的功能

| 功能 | 原因 |
|------|------|
| 轨道+片段视觉 | 替换为矩阵符号系统 |
| 拖拽移动片段 | 矩阵中编辑范围用右键菜单或双击弹窗 |
| 删除片段 | 同上 |
| 框选多选 | 矩阵不需要选中编辑 |
| 元素池拖入 | 拖入到矩阵的语义不清晰（拖入到哪章？） |
| 轨道锁定/隐藏/折叠/静音/独显 | 视频概念，矩阵中分组折叠替代 |
| 关系连线 | 角色关系是全局的，不适合画在时间轴上（保留用于画布视图） |
| 小地图 | 矩阵用水平滚动替代 |
| 字数条 | 矩阵标尺上可显示字数（后续可加） |

## 实现任务分解（5 步）

### B-1：matrix-logic 纯函数 + TDD（预计 3-4 个函数）

```
matrix-logic.ts:
  computeCellValue(entity, chapterNumber) → { type, symbol, color }
  computeSpanRange(entity, maxChapter) → { start, end } | null
  computeForeshadowLine(entity, maxChapter) → { start, end, recovered } | null
  buildGroups(chapters, characters, ...) → Group[]
```

### B-2：MatrixView 主组件

```
MatrixView.tsx:
  - 接收 MatrixData 作为 props
  - 渲染：标尺行（章节号+标题） + 分组行（分隔线） + 实体行（单元格）
  - 当前章节列高亮
  - 水平滚动
  - 点击章节标尺 → onPlayheadChange
  - 点击实体行 → 联动右侧详情面板
  - 双击实体行 → 编辑范围/批注弹窗
```

### B-3：MatrixSidebar + MatrixToolbar

```
MatrixSidebar.tsx:
  - 分组标题（带类型图标 + 折叠箭头 + 实体计数）
  - 实体名列表（带颜色圆点 + hover 高亮）
  - 折叠/展开交互

MatrixToolbar.tsx:
  - 过滤 chips（角色/冲突/伏笔/势力/地点/世界要素/全部）
  - 缩放 ± 按钮
  - 补全历史按钮
  - 撤销/重做按钮
```

### B-4：集成到 novel-workspace

```
novel-workspace.tsx:
  - ViewSwitcher: 'matrix' | 'canvas'（替换 'timeline'）
  - <MatrixView> 替换 <NovelTimelineWorkspace>
  - 删除 ChapterContentEditor 垂直分割（暂时）
  - 删除 ResizableSplitter 垂直分割（暂时）
  - 清理不再使用的 import
```

### B-5：删除 timeline/ 目录 + 运行全量测试

```
- 删除 apps/desktop/src/renderer/src/components/novel/timeline/ 整个目录
- 清理 novel-workspace.tsx 中的 timeline 引用
- 运行 pnpm --filter desktop exec vitest run（确认无引用损坏）
- 运行 npx tsc --noEmit -p apps/desktop/tsconfig.web.json（确认无新增错误）
```

## 约束

- **不修改后端**：矩阵视图是纯前端视图层变化，不涉及 API 或数据库
- **不修改 novel-store**：数据结构不变
- **不修改画布视图**：matrix 只替换 timeline，canvas 保持不变
- **保留播放头**：作为"当前章节指示器"，联动正文编辑器（后续）
- **保留标记系统**：bookmark/turning-point/foreshadow/climax/note/clip-note 类型不变
- **保留撤销重做**：EditAction 历史系统复用

## 验证清单

- [ ] 矩阵视图正确展示所有 6 种实体类型
- [ ] 分组折叠/展开正常工作
- [ ] 过滤 chips 只显示对应分组
- [ ] 缩放 ± 调整单元格大小
- [ ] 当前章节列高亮正确
- [ ] 点击标尺跳转播放头
- [ ] 点击实体行联动右侧详情面板
- [ ] 播放头联动 ChapterContentEditor（后续）
- [ ] 撤销/重做正常工作
- [ ] 补全角色历史正常工作
- [ ] 测试全量通过
- [ ] TypeScript 无新增错误
- [ ] 深色主题样式一致