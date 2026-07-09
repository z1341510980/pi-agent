# 小说插件 opencli 浏览器自动化测试用例

本文档定义使用 `opencli browser` 进行真实 UI 自动化测试的完整用例集。所有用例基于真实 DOM 探查结果编写,使用元素索引(`[N]`)或文本匹配定位,模拟用户真实点击、输入、拖拽行为。

## 0. 测试原则

1. **纯浏览器操作**:不直接调用后端 API,所有数据通过 UI 交互产生
2. **真实元素索引**:用例中 `[N]` 索引基于 `opencli browser state` 实际输出,文档会标注「以实际 state 为准」
3. **截图留证**:每个关键步骤截图保存到 `$env:TEMP\opencli-novel-tests\screenshots\`
4. **状态断言**:每步操作后通过 `state` / `extract` 验证 UI 状态
5. **顺序依赖**:测试用例按顺序执行,前序用例的数据供后序用例使用

## 1. 环境准备

### 1.1 检查浏览器桥

```powershell
opencli doctor
```

期望:
- `Daemon: running on port 19825`
- `Extension: connected (v1.0.22)` 或更新
- `Connectivity: connected`

### 1.2 准备截图目录

```powershell
$tmp = "$env:TEMP\opencli-novel-tests"
$shots = "$tmp\screenshots"
New-Item -ItemType Directory -Force -Path $shots | Out-Null
```

### 1.3 启动开发服务器

```powershell
# 终端 A
pnpm dev:server

# 终端 B
pnpm dev:desktop
```

### 1.4 打开浏览器会话

```powershell
opencli browser --session novel open http://localhost:5173
opencli browser --session novel wait time 3
opencli browser --session novel screenshot "$shots\01-home.png"
```

期望:`title: Electron`,页面显示 Wenlang Agent Desktop 主页,含主导航栏(首页/对话工作台/小说创作/设置)。

### 1.5 导航到小说创作页

```powershell
# 主页点击「小说创作」快捷入口(通常是 [14] 按钮,以实际 state 为准)
opencli browser --session novel state | Select-String "小说创作"
# 记录对应按钮索引,假设为 N
opencli browser --session novel click N
opencli browser --session novel wait time 2
opencli browser --session novel screenshot "$shots\02-novel-workspace.png"
```

期望:
- 页面切换为三栏布局:左侧侧边栏 + 中间矩阵/画布 + 右侧详情面板
- 侧边栏顶部显示「小说项目」标题与「+」按钮
- 侧边栏中部显示当前项目的 7 个实体分组
- 主导航栏仍可见(首页/对话工作台/小说创作/设置)

---

## 2. 项目管理测试

### T-01 验证侧边栏项目列表

```powershell
opencli browser --session novel state | Select-String "玄幻|项目"
opencli browser --session novel screenshot "$shots\T-01-project-list.png"
```

**期望**:state 输出包含至少一个项目卡片,含:
- 项目标题(如「架构演进 E2E 验证...」或「开局上交异界...」)
- 题材标签「玄幻」
- 状态圆点(active=绿色)
- hover 时显示删除按钮

**断言**:项目列表非空,且当前项目高亮显示。

### T-02 切换项目

```powershell
# 获取项目列表 state,找到第二个项目的按钮索引
opencli browser --session novel state | Select-String "button.*aria-label" | Select-Object -First 5
# 点击第二个项目(索引以实际为准,假设为 M)
opencli browser --session novel click M
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-02-project-switched.png"
```

**期望**:
- 切换后该项目变为高亮(primary/10 背景)
- 侧边栏分组树刷新为新项目的实体
- 矩阵视图刷新

### T-03 新建项目(对话框流程)

```powershell
# 点击侧边栏顶部「+」按钮
opencli browser --session novel state | Select-String "新建项目"
# 找到「新建项目」按钮索引(假设为 K)
opencli browser --session novel click K
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-03-create-dialog.png"
```

**期望**:弹出 Dialog 标题「新建小说项目」,含 4 个输入框(标题/题材/简介/目标字数)。

```powershell
# 填写表单 - 用 fill 命令定位输入框
opencli browser --session novel state | Select-String "input|placeholder"
# 找到 4 个输入框索引,依次填入
opencli browser --session novel fill <标题输入框> "opencli UI 测试小说"
opencli browser --session novel fill <题材输入框> "玄幻"
opencli browser --session novel fill <简介输入框> "用于 UI 自动化测试"
opencli browser --session novel fill <目标字数输入框> "100000"

# 提交
opencli browser --session novel state | Select-String "创建"
opencli browser --session novel click <创建按钮>
opencli browser --session novel wait time 2
opencli browser --session novel screenshot "$shots\T-03-after-create.png"
```

**期望**:
- 对话框关闭
- 侧边栏项目列表新增「opencli UI 测试小说」
- 新项目自动选中(高亮)
- 主内容区显示空矩阵(无实体)

### T-04 项目软删除(移入回收站)

```powershell
# hover 到刚创建的项目卡片,显示删除按钮
opencli browser --session novel hover <项目卡片索引>
opencli browser --session novel wait time 1
opencli browser --session novel state | Select-String "移入回收站"
# 点击删除按钮
opencli browser --session novel click <删除按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-04-delete-confirm.png"
```

**期望**:弹出确认对话框「移入回收站」,含取消/确认两个按钮。

```powershell
# 点击确认移入回收站
opencli browser --session novel click <确认移入回收站按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-04-after-soft-delete.png"
```

**期望**:项目从列表中消失。

### T-05 回收站恢复

```powershell
# 点击底部「回收站」按钮
opencli browser --session novel state | Select-String "回收站"
opencli browser --session novel click <回收站按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-05-trash-dialog.png"
```

**期望**:弹出 TrashDialog,列出已软删除项目,含标题/类型/章节数/删除日期/恢复/永久删除按钮。

```powershell
# 点击「恢复」
opencli browser --session novel click <恢复按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-05-after-restore.png"
```

**期望**:项目从回收站移除,重新出现在项目列表。

### T-06 回收站永久删除(purge)

```powershell
# 重新软删除一个项目,然后打开回收站
opencli browser --session novel click <回收站按钮>
opencli browser --session novel wait time 1
# 点击「永久删除」
opencli browser --session novel click <永久删除按钮>
opencli browser --session novel wait time 1
# 确认对话框
opencli browser --session novel click <确认按钮>
opencli browser --session novel screenshot "$shots\T-06-after-purge.png"
```

**期望**:项目从回收站列表消失。

---

## 3. 侧边栏分组测试

### T-07 验证 7 个实体分组存在

```powershell
# 选中一个有数据的项目(如「开局上交异界...」)
opencli browser --session novel click <项目索引>
opencli browser --session novel wait time 2
opencli browser --session novel state | Select-String "集合|新建"
opencli browser --session novel screenshot "$shots\T-07-sidebar-groups.png"
```

**期望**:state 输出包含 7 个分组:
1. `角色集合` + `新建角色`
2. `伏笔集合` + `新建伏笔`
3. `冲突集合` + `新建冲突`
4. `势力集合` + `新建势力`
5. `地点集合` + `新建地点`
6. `世界观要素` + `新建世界观要素`
7. `信息差集合` + `新建信息差`

### T-08 折叠/展开分组

```powershell
# 找到「信息差集合」分组的折叠按钮(通常是分组标题行)
opencli browser --session novel state | Select-String "信息差集合"
# 记录分组标题按钮索引(假设为 G)
opencli browser --session novel click G
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-08-collapse-info-layer.png"
```

**期望**:折叠后子项隐藏,Badge 数字仍显示。

```powershell
# 再次点击展开
opencli browser --session novel click G
opencli browser --session novel wait time 1
```

**期望**:子项重新显示。

### T-09 验证分组 Badge 数量

```powershell
# 检查「伏笔集合」分组显示的数字
opencli browser --session novel state | Select-String "伏笔集合|伏笔.*[0-9]+"
```

**期望**:Badge 数字等于实际伏笔条目数。例如「伏笔 5」表示该分组下有 5 个伏笔。

---

## 4. 实体创建测试(侧边栏入口)

### T-10 新建角色(对话框流程)

```powershell
# 点击「角色集合」分组的「新建角色」按钮
opencli browser --session novel state | Select-String "新建角色"
opencli browser --session novel click <新建角色按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-10-character-dialog.png"
```

**期望**:弹出 CharacterCreateDialog,含 name/description 输入框,有「直接创建」和「AI 生成」两个按钮。

```powershell
# 直接创建(不走 AI)
opencli browser --session novel fill <name输入框> "测试角色"
opencli browser --session novel fill <description输入框> "用于 UI 测试"
opencli browser --session novel click <直接创建按钮>
opencli browser --session novel wait time 2
opencli browser --session novel screenshot "$shots\T-10-after-create-character.png"
```

**期望**:
- 对话框关闭
- 侧边栏「角色集合」分组新增「测试角色」条目
- Badge 数字 +1

### T-11 新建伏笔(无对话框)

```powershell
opencli browser --session novel state | Select-String "新建伏笔"
opencli browser --session novel click <新建伏笔按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-11-after-create-foreshadow.png"
```

**期望**:
- 侧边栏「伏笔集合」分组新增一条默认描述(如「新伏笔」)
- 无对话框弹出
- Badge 数字 +1

### T-12 新建冲突(无对话框)

```powershell
opencli browser --session novel click <新建冲突按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-12-after-create-conflict.png"
```

**期望**:侧边栏「冲突集合」分组新增一条,Badge +1。

### T-13 新建势力 / 地点 / 世界观要素

```powershell
# 依次点击三个新建按钮
opencli browser --session novel click <新建势力按钮>
opencli browser --session novel wait time 1
opencli browser --session novel click <新建地点按钮>
opencli browser --session novel wait time 1
opencli browser --session novel click <新建世界要素按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-13-after-create-others.png"
```

**期望**:三个分组各新增一条,Badge 数字均 +1。

### T-14 新建信息差(P3-2 核心)

```powershell
opencli browser --session novel click <新建信息差按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-14-after-create-info-layer.png"
```

**期望**:
- 侧边栏「信息差集合」分组(原显示「暂无信息差」)新增一条
- 新条目 label 为「新的信息差」(截断到 18 字符)
- sublabel 显示「读者未知」
- Badge 数字从 0 变为 1

---

## 5. 详情面板测试

### T-15 点击实体显示详情面板

```powershell
# 点击刚创建的信息差条目
opencli browser --session novel state | Select-String "新的信息差"
opencli browser --session novel click <信息差条目索引>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-15-info-layer-form.png"
```

**期望**:右侧详情面板显示 InfoLayerForm,包含 4 个分区:
1. **基本信息**:信息描述 TextArea
2. **认知状态**:作者是否知晓 Select / 读者是否知晓 Select
3. **揭示**:揭示阶段 Input / 揭示章节 Input / 是否已揭示 Select
4. **关联伏笔**:⚡ 承载伏笔(暂无时显示「暂无」)

### T-16 编辑信息差并保存

```powershell
# 修改信息描述
opencli browser --session novel fill <信息描述TextArea> "林墨真实身世是前朝皇族后裔"

# 切换读者认知为「是」
opencli browser --session novel click <读者是否知晓Select>
opencli browser --session novel wait time 1
opencli browser --session novel state | Select-String "是|否"
opencli browser --session novel click <是选项>
opencli browser --session novel wait time 1

# 截图 dirty 状态
opencli browser --session novel screenshot "$shots\T-16-info-layer-dirty.png"
```

**期望**:保存按钮从禁用变为可点。

```powershell
# 点击保存
opencli browser --session novel click <保存修改按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-16-after-save.png"
```

**期望**:
- 保存按钮重新变为禁用
- 侧边栏该条目 label 更新为新描述前 18 字符
- sublabel 从「读者未知」变为「读者已知」

### T-17 验证 ForeshadowForm 的「⚡ 承载信息差」字段

```powershell
# 点击一个伏笔条目
opencli browser --session novel state | Select-String "伏笔"
opencli browser --session novel click <伏笔条目索引>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-17-foreshadow-form.png"
opencli browser --session novel state | Select-String "承载信息差"
```

**期望**:ForeshadowForm 的「关联」分区显示「⚡ 承载信息差」FieldRow:
- 若该伏笔已关联信息差:显示 Badge 列表,每个含信息差描述(截断 16 字符)+「读者已知/读者未知」标签
- 若未关联:显示「暂无」

### T-18 验证 ConflictForm 的 P2-1 字段

```powershell
opencli browser --session novel click <冲突条目索引>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-18-conflict-form.png"
```

**期望**:ConflictForm 显示:
- 功能位(plotFunction)Select:7 值枚举
- 推进模式(progressionMode)Select:5 值枚举(线性升级/突变/停滞/降级/反转)
- 参与方 StringListEditor

### T-19 验证 CharacterForm 的四层逻辑字段

```powershell
opencli browser --session novel click <角色条目索引>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-19-character-form.png"
```

**期望**:CharacterForm 显示:
- 长期欲望(longTermDesire)Input
- 角色层级(plotRole)Select:5 值枚举(protagonist/main_opponent/supporting/function/background)
- 删掉影响(removalImpact)Input
- 参与的冲突(participatingConflicts)只读 Badge 列表

### T-20 删除实体

```powershell
# hover 信息差条目显示删除按钮
opencli browser --session novel hover <信息差条目索引>
opencli browser --session novel wait time 1
opencli browser --session novel state | Select-String "删除"
# 点击删除按钮
opencli browser --session novel click <删除按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-20-delete-confirm.png"
```

**期望**:弹出 `window.confirm` 对话框「确认删除...此操作不可撤销」。

```powershell
# 浏览器原生 confirm 对话框需要特殊处理
# opencli browser 可能需要用 accept-dialog 或直接点确认
# 若是 React 自定义 Dialog,直接点击确认按钮
opencli browser --session novel click <确认删除按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-20-after-delete.png"
```

**期望**:条目从侧边栏消失,Badge 数字 -1。

---

## 6. 矩阵视图测试

### T-21 切换矩阵/画布视图

```powershell
# 找到 ViewSwitcher(通常在工具栏)
opencli browser --session novel state | Select-String "矩阵|画布|视图"
# 点击「画布」切换
opencli browser --session novel click <画布视图按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-21-canvas-view.png"
```

**期望**:主内容区切换为画布视图,显示实体节点和连线。

```powershell
# 切回矩阵
opencli browser --session novel click <矩阵视图按钮>
opencli browser --session novel wait time 1
```

### T-22 验证矩阵 7 个实体分组

```powershell
opencli browser --session novel state | Select-String "角色|冲突|伏笔|势力|地点|世界|信息差"
opencli browser --session novel screenshot "$shots\T-22-matrix-groups.png"
```

**期望**:矩阵视图显示 7 行分组,每行:
- 左列固定:实体名 + 色块图标(角色蓝/冲突红/伏笔黄/势力紫/地点青/世界要素靛/信息差 teal)
- 右侧:章节列单元格

### T-23 矩阵单元格点击(标记/取消出场)

```powershell
# 找到角色行 + 某章节列的交叉单元格
opencli browser --session novel state | Select-String "character|角色"
# 点击该单元格
opencli browser --session novel click <角色单元格>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-23-cell-click.png"
```

**期望**:单元格出现出场符号(圆点);再次点击取消。

### T-24 矩阵右键菜单

```powershell
# 右键点击冲突单元格
opencli browser --session novel click <冲突单元格> --button right
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-24-context-menu.png"
```

**期望**:弹出 EntityCellMenu,含:
- 标记出场 / 取消出场
- 编辑批注
- 编辑跨度(仅 conflict/faction)
- 移除跨度(仅 conflict/faction)

### T-25 矩阵拖拽(侧边栏 → 矩阵)

```powershell
# 从侧边栏拖一个角色到矩阵某章列
opencli browser --session novel drag <角色条目> <目标单元格>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-25-drag-to-matrix.png"
```

**期望**:
- 拖拽时显示 DragOverlay 浮动预览
- 释放后单元格出现角色出场符号
- 角色的 appearChapters 自动更新

### T-26 矩阵端点拖拽(调整跨度)

```powershell
# 找到冲突色带的端点 handle(aria-label="拖动调整起点"或"拖动调整终点")
opencli browser --session novel state | Select-String "拖动调整"
# 拖动端点到另一章节列
opencli browser --session novel drag <端点handle> <目标章节列>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-26-endpoint-drag.png"
```

**期望**:色带跨度扩展或收缩;反转保护(起点 ≤ 终点)生效。

### T-27 章节标尺点击

```powershell
# 点击矩阵顶部的章节标尺
opencli browser --session novel state | Select-String "第.*章|chapter"
opencli browser --session novel click <章节标尺按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-27-ruler-click.png"
```

**期望**:playheadChapter 切换,该列高亮。

### T-28 矩阵右键章节标尺

```powershell
opencli browser --session novel click <章节标尺> --button right
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-28-ruler-context-menu.png"
```

**期望**:弹出 ChapterContextMenu,含:
- 生成 / 重新生成 / 查看 / 删除

---

## 7. 大纲树测试

### T-29 验证大纲树结构

```powershell
# 找到大纲树区域(通常在侧边栏中部或矩阵上方)
opencli browser --session novel state | Select-String "卷|章|大纲"
opencli browser --session novel screenshot "$shots\T-29-outline-tree.png"
```

**期望**:大纲树显示:
- 全书大纲预览(2 行省略)
- 卷列表(可展开/折叠)
- 每卷下的章节列表

### T-30 展开/折叠卷

```powershell
opencli browser --session novel click <卷标题>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-30-volume-collapse.png"
```

**期望**:卷折叠后章节列表隐藏;再次点击展开。

### T-31 新建卷

```powershell
opencli browser --session novel click <新建卷按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-31-new-volume.png"
```

### T-32 新建章节

```powershell
# 在某卷下新建章节
opencli browser --session novel click <卷下新建章按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-32-new-chapter.png"
```

**期望**:大纲树新增章节行;矩阵视图新增对应章节列。

### T-33 点击章节联动矩阵滚动

```powershell
opencli browser --session novel click <大纲树某章节>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-33-scroll-to-chapter.png"
```

**期望**:矩阵视图自动滚动到该章节列;playheadChapter 更新。

---

## 8. 创作流程测试(SSE 消费)

> ⚠️ 这部分用例需要后端 LLM 配置就绪,且耗时较长(可能 1-5 分钟)。

### T-34 启动手动创作流

```powershell
# 确保已选中一个项目和章节
opencli browser --session novel state | Select-String "创作|编排|开始"
# 点击「手动创作」按钮
opencli browser --session novel click <手动创作按钮>
opencli browser --session novel wait time 2
opencli browser --session novel screenshot "$shots\T-34-creation-start.png"
```

**期望**:
- 弹出创作进度浮层(creation-progress-overlay)
- 显示多 Agent 阶段:Director → Writer → Reviewer → Reviser → Memory
- 进度条更新
- SSE 事件驱动 UI 刷新

### T-35 验证创作 checkpoint

```powershell
# 等待 Director 阶段完成,弹出 checkpoint 确认
opencli browser --session novel wait time 30
opencli browser --session novel state | Select-String "checkpoint|确认|批准|修改"
opencli browser --session novel screenshot "$shots\T-35-checkpoint.png"
```

**期望**:弹出 checkpoint 对话框,含:
- Director 的 narrative_task 输出
- 4 个决策按钮:批准 / 修改 / 重写 / 拒绝

```powershell
# 点击「批准」继续
opencli browser --session novel click <批准按钮>
opencli browser --session novel wait time 5
opencli browser --session novel screenshot "$shots\T-35-after-approve.png"
```

### T-36 验证 Writer 阶段流式输出

```powershell
# 等待 Writer 阶段开始
opencli browser --session novel wait time 30
opencli browser --session novel state | Select-String "Writer|正文|生成中"
opencli browser --session novel screenshot "$shots\T-36-writer-streaming.png"
```

**期望**:
- 创作预览面板(chapter-live-view)显示流式正文
- 文字逐步出现(requestAnimationFrame 批处理)
- 进度阶段显示「Writer 生成中」

### T-37 验证 Reviewer 阶段 checkpoint

```powershell
opencli browser --session novel wait time 60
opencli browser --session novel state | Select-String "Reviewer|审查|review"
opencli browser --session novel screenshot "$shots\T-37-review-checkpoint.png"
```

**期望**:弹出第二个 checkpoint,显示 Reviewer 的审查意见。

### T-38 创作完成保存

```powershell
# 等待全流程完成
opencli browser --session novel wait time 60
opencli browser --session novel state | Select-String "完成|保存|丢弃"
opencli browser --session novel screenshot "$shots\T-38-creation-done.png"

# 点击「保存到章节」
opencli browser --session novel click <保存按钮>
opencli browser --session novel wait time 2
opencli browser --session novel screenshot "$shots\T-38-after-save.png"
```

**期望**:
- 章节内容保存到后端
- 矩阵视图刷新,显示新出场角色/冲突/伏笔
- 记忆事件写入(可通过详情面板查看)

### T-39 创作丢弃

```powershell
# 重新启动一次创作,然后丢弃
opencli browser --session novel click <手动创作按钮>
opencli browser --session novel wait time 10
opencli browser --session novel click <丢弃按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-39-discard.png"
```

**期望**:创作浮层关闭;章节内容未保存。

### T-40 AI 编排(ai-arrange)

```powershell
# 点击「AI 编排」按钮
opencli browser --session novel click <AI编排按钮>
opencli browser --session novel wait time 5
opencli browser --session novel screenshot "$shots\T-40-ai-arrange-start.png"
```

**期望**:
- 显示气泡通知「AI 编排中...」
- 5 个 phase:analyzing → planned → generating → arranged → 完成
- 完成后矩阵视图自动刷新显示新实体

---

## 9. AI 实体生成测试

### T-41 AI 生成角色

```powershell
# 在矩阵视图右键空白单元格,选择「新建角色」
opencli browser --session novel click <矩阵空白区> --button right
opencli browser --session novel wait time 1
opencli browser --session novel click <新建角色菜单项>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-41-character-dialog.png"

# 填写 name 和 description
opencli browser --session novel fill <name输入框> "神秘剑客"
opencli browser --session novel fill <description输入框> "黑衣长剑的修真者"

# 点击「AI 生成」
opencli browser --session novel click <AI生成按钮>
opencli browser --session novel wait time 5
opencli browser --session novel screenshot "$shots\T-41-generating.png"
```

**期望**:
- 进度阶段切换:preparing → generating → parsing → completed
- 流式预览字段实时更新(personality/appearance 等)
- 完成后进入 review 阶段,显示 14 个字段

```powershell
# review 阶段修改 plotRole
opencli browser --session novel click <plotRole Select>
opencli browser --session novel wait time 1
opencli browser --session novel click <protagonist选项>

# 提交
opencli browser --session novel click <提交按钮>
opencli browser --session novel wait time 2
opencli browser --session novel screenshot "$shots\T-41-after-submit.png"
```

**期望**:
- 对话框关闭
- 侧边栏角色集合新增「神秘剑客」
- 矩阵视图对应章节显示该角色

### T-42 AI 生成实体(非角色)

```powershell
# 右键矩阵空白,选择「新建伏笔」
opencli browser --session novel click <矩阵空白区> --button right
opencli browser --session novel click <新建伏笔菜单项>
opencli browser --session novel wait time 1
opencli browser --session novel fill <描述输入框> "主角玉佩的秘密"
opencli browser --session novel click <AI补全按钮>
opencli browser --session novel wait time 5
opencli browser --session novel screenshot "$shots\T-42-foreshadow-generate.png"
```

**期望**:
- SSE 流式生成 category/plantChapter/payoffChapter 等字段
- review 阶段显示伏笔分类 Select(8 值枚举)
- 提交后侧边栏新增伏笔

### T-43 AI 生成取消回滚

```powershell
# 启动 AI 生成,然后在 review 阶段取消
opencli browser --session novel click <AI生成按钮>
opencli browser --session novel wait time 5
opencli browser --session novel click <取消按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-43-cancel.png"
```

**期望**:对话框关闭;已创建的临时角色被删除(回滚逻辑)。

---

## 10. P3-2 双向联动 UI 测试

### T-44 验证伏笔的「承载信息差」字段显示

前置:通过 API 或 UI 建立伏笔↔信息差关联(参考 T-14 + T-A12)。

```powershell
# 选中已关联信息差的伏笔
opencli browser --session novel click <伏笔条目>
opencli browser --session novel wait time 1
opencli browser --session novel state | Select-String "承载信息差|读者"
opencli browser --session novel screenshot "$shots\T-44-foreshadow-linked.png"
```

**期望**:ForeshadowForm 的「⚡ 承载信息差」FieldRow 显示:
- Badge 含信息差描述(截断 16 字符)
- 旁边标签「读者已知」或「读者未知」
- 不是原始 ID

### T-45 验证信息差的「承载伏笔」字段显示

```powershell
# 选中已关联伏笔的信息差
opencli browser --session novel click <信息差条目>
opencli browser --session novel wait time 1
opencli browser --session novel state | Select-String "承载伏笔"
opencli browser --session novel screenshot "$shots\T-45-info-layer-linked.png"
```

**期望**:InfoLayerForm 的「⚡ 承载伏笔」FieldRow 显示:
- Badge 含伏笔描述(截断 16 字符)
- 旁边标签显示伏笔 status

### T-46 删除信息差自动 prune

```powershell
# 记录当前伏笔的「承载信息差」字段有内容
# 删除关联的信息差
opencli browser --session novel hover <信息差条目>
opencli browser --session novel click <删除按钮>
opencli browser --session novel click <确认删除>
opencli browser --session novel wait time 1

# 重新选中伏笔,验证「承载信息差」变为「暂无」
opencli browser --session novel click <伏笔条目>
opencli browser --session novel wait time 1
opencli browser --session novel state | Select-String "承载信息差"
opencli browser --session novel screenshot "$shots\T-46-after-prune.png"
```

**期望**:伏笔的「⚡ 承载信息差」字段从 Badge 列表变为「暂无」。

### T-47 删除伏笔自动 prune

```powershell
# 反向验证:删除伏笔后,信息差的「承载伏笔」变为「暂无」
opencli browser --session novel hover <伏笔条目>
opencli browser --session novel click <删除按钮>
opencli browser --session novel click <确认删除>
opencli browser --session novel wait time 1

opencli browser --session novel click <信息差条目>
opencli browser --session novel wait time 1
opencli browser --session novel state | Select-String "承载伏笔"
opencli browser --session novel screenshot "$shots\T-47-after-foreshadow-prune.png"
```

**期望**:信息差的「⚡ 承载伏笔」字段变为「暂无」。

---

## 11. 章节编辑器测试

### T-48 Tiptap 编辑器输入

```powershell
# 点击矩阵中的章节标尺,切换到章节内容编辑器
opencli browser --session novel click <章节标尺>
opencli browser --session novel wait time 1
opencli browser --session novel state | Select-String "textarea|contenteditable|tiptap"
opencli browser --session novel click <编辑器区域>
opencli browser --session novel type <编辑器> "测试正文内容..."
opencli browser --session novel wait time 2
opencli browser --session novel screenshot "$shots\T-48-editor-input.png"
```

**期望**:
- Tiptap 编辑器接收输入
- 1.5s 防抖后自动保存
- 保存后状态指示器更新

### T-49 章节状态切换

```powershell
# 找到章节状态 Select
opencli browser --session novel state | Select-String "planned|drafting|review|published"
opencli browser --session novel click <状态Select>
opencli browser --session novel wait time 1
opencli browser --session novel click <review选项>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-49-status-change.png"
```

**期望**:章节状态变为「review」。

---

## 12. 设置页测试

### T-50 导航到设置页

```powershell
# 点击主导航栏的「设置」按钮
opencli browser --session novel state | Select-String "设置"
opencli browser --session novel click <设置导航按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-50-settings.png"
```

**期望**:
- 主导航栏仍可见
- 设置按钮显示 active 态
- 内容区渲染设置页(非全屏替换)
- 设置页左侧 7 个导航项:Provider / Models / Agents / Security / Cron / General / About

### T-51 验证主导航栏始终可见

```powershell
opencli browser --session novel state | Select-String "首页|对话工作台|小说创作|设置"
```

**期望**:state 输出包含 4 个主导航按钮。

### T-52 切换设置子页

```powershell
# 依次点击 7 个设置导航项
opencli browser --session novel click <Provider导航>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-52-provider.png"

opencli browser --session novel click <Models导航>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-52-models.png"

# ... 依次点击其余 5 个
```

**期望**:每次切换后右侧内容区更新;主导航栏不变。

### T-53 从设置返回小说创作

```powershell
opencli browser --session novel click <小说创作导航按钮>
opencli browser --session novel wait time 1
opencli browser --session novel screenshot "$shots\T-53-back-to-novel.png"
```

**期望**:返回小说工作区;之前的选中状态恢复。

---

## 13. 错误处理与边界测试

### T-54 控制台错误检查

```powershell
opencli browser --session novel console
```

**期望**:无未捕获的 React error;无 5xx 网络错误;warning 可接受。

### T-55 网络请求捕获

```powershell
opencli browser --session novel network --detail
```

**期望**:捕获到 `/api/plugins/novel/projects`、`/characters` 等请求;响应体 schema 正确。

### T-56 验证空项目状态

```powershell
# 新建一个全新项目,验证空状态
# (参考 T-03 创建新项目)
opencli browser --session novel state | Select-String "暂无"
opencli browser --session novel screenshot "$shots\T-56-empty-project.png"
```

**期望**:所有分组显示「暂无...」;矩阵视图为空。

### T-57 验证 loading 状态

```powershell
# 切换项目时观察 loading 指示器
opencli browser --session novel click <另一项目>
opencli browser --session novel wait time 0.5
opencli browser --session novel screenshot "$shots\T-57-loading.png"
```

**期望**:数据加载时显示 loading 指示器。

### T-58 验证 SSE 断连恢复

```powershell
# 在创作过程中模拟网络断开(手动断网或用 opencli 模拟)
# 然后验证 UI 显示错误提示
opencli browser --session novel screenshot "$shots\T-58-sse-error.png"
```

**期望**:错误时显示「重试」按钮。

---

## 14. 结束测试

### T-59 关闭浏览器会话

```powershell
opencli browser --session novel close
```

**期望**:浏览器标签页释放;session 资源清理。

### T-60 生成测试报告

```powershell
# 汇总截图
Get-ChildItem $shots | Format-Table Name, Length, LastWriteTime

# 检查测试覆盖率
Write-Host "总测试用例数: 60"
Write-Host "截图数: $((Get-ChildItem $shots).Count)"
```

---

## 附录 A:opencli browser 命令速查

| 命令 | 用途 |
|------|------|
| `open <url>` | 导航到 URL |
| `state` | 获取页面 DOM 快照(含 `[N]` 索引) |
| `click <N>` | 点击索引 N 的元素 |
| `click <N> --button right` | 右键点击 |
| `fill <N> <text>` | 填充输入框 |
| `select <N> <value>` | 选择下拉项 |
| `hover <N>` | 鼠标悬停 |
| `drag <srcN> <dstN>` | 拖拽元素 |
| `wait time <s>` | 等待 N 秒 |
| `screenshot <path>` | 截图 |
| `console` | 读取控制台日志 |
| `network --detail` | 捕获网络请求 |
| `close` | 关闭会话 |

## 附录 B:常见元素索引定位策略

1. **按文本搜索**:`state | Select-String "文本内容"`
2. **按 aria-label**:`state | Select-String "aria-label=新建"`
3. **按 placeholder**:`state | Select-String "placeholder="`
4. **按角色**:`state | Select-String "role=button|role=combobox"`
5. **按 title**:`state | Select-String "title=删除"`

## 附录 C:测试用例与功能映射

| 用例 | 覆盖功能 |
|------|---------|
| T-01~T-06 | 项目 CRUD + 回收站 |
| T-07~T-09 | 侧边栏 7 分组 + Badge |
| T-10~T-14 | 7 类实体创建 |
| T-15~T-20 | 详情面板 10 个 Form + 删除 |
| T-21~T-28 | 矩阵视图(切换/单元格/右键/拖拽/标尺) |
| T-29~T-33 | 大纲树(卷/章/联动) |
| T-34~T-40 | 创作流程 SSE(checkpoint/流式/编排) |
| T-41~T-43 | AI 实体生成(角色/非角色/取消) |
| T-44~T-47 | P3-2 双向联动 UI |
| T-48~T-49 | 章节编辑器 |
| T-50~T-53 | 设置页 |
| T-54~T-58 | 错误处理与边界 |
