# 实现计划：章节正文版本历史

**规格**：`docs/superpowers/specs/2026-07-16-chapter-version-history-design.md`
**日期**：2026-07-16

实现按 5 个 vertical slice 推进，每个 slice 可独立验证。每个 slice 内的步骤按顺序执行，slice 之间有依赖（2 依赖 1，3 依赖 1，4 依赖 1，5 依赖 3）。

---

## Slice 1：数据层基础（迁移 + 类型 + Store 拦截 + Store 方法）

**目标**：版本表就位，Store 写入自动存档，可读版本列表。
**验证**：Store 单元测试全绿。

### 步骤 1.1 类型定义

文件：`packages/shared/src/novel/index.ts`

新增：
- `ChapterVersionPhase` 类型（10 个枚举值，见规格 5.2）
- `ChapterVersion` 接口
- `ChapterVersionSummary` 接口（列表用，不含 content）
- `VersionSource` 类型（对象 | 'skip' | undefined）

位置：紧跟 `NovelChapter` 接口定义之后，与现有类型放在一起。

### 步骤 1.2 迁移 066

文件：`apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`

在 065 之后追加 066（见规格 5.1 的 SQL）。注意：
- 表名 `novel_chapter_versions`
- 两个索引：`idx_chapter_versions_chapter`、`idx_chapter_versions_project`
- `ON DELETE CASCADE` 关联 `novel_chapters(id)`
- 全部用 `IF NOT EXISTS` 保证幂等

### 步骤 1.3 Store 拦截 + 公开方法

文件：`apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts`

改动点：
1. **`updateChapter`（行 796）**：签名加 `versionSource?: VersionSource` 第 3 参数。在 `existing` 读取后、`UPDATE` 前，加拦截判断（见规格 6.1）。
2. **`updateChapterContent`（行 822）**：签名加 `versionSource?: VersionSource` 第 4 参数。加拦截判断（见规格 6.2）。
3. **新增私有方法 `saveChapterVersionInternal`**（见规格 6.3）：用 `MAX(sequence)+1` 计算序号，INSERT 版本行。
4. **新增公开方法**（见规格 6.4）：
   - `listChapterVersions(chapterId)`：返回 `ChapterVersionSummary[]`，按 sequence DESC。SELECT 不含 content。需在返回时计算 `wordCountDelta`（按正序算每版与前一版差，再倒序）和 `isCurrent`（最新版为 true）。
   - `getChapterVersion(versionId)`：返回 `ChapterVersion`（含 content）。
   - `createVersionSnapshot(chapterId, source)`：显式存档，source 为 'skip'/undefined 时返回 undefined。
   - `getLatestVersion(chapterId)`：返回最新版本。
5. **新增 row 映射**：`rowToChapterVersion`、`rowToChapterVersionSummary`（见规格 6.5）。

**注意**：
- `updateChapter` 现有调用方有 10+ 处，全部不传第 3 参数也能工作（拦截存版本，元数据 null）。**不要批量改现有调用方**，让它们靠拦截兜底，仅在 Slice 4 按需传参。
- `updateChapterContent` 同理。
- `saveChapterVersionInternal` 内 `source && source !== 'skip'` 的判断要准确，避免把 'skip' 字符串当对象解构。

### 步骤 1.4 Store 单元测试

文件：`apps/agent-server/src/__tests__/novel-store.test.ts`

补充用例（见规格 13.1）：
- updateChapter 传 content 且不同 → 存版本，sequence 递增
- updateChapter 传 content 但相同 → 不存
- updateChapter 只改 title → 不存
- updateChapter 传 'skip' → 不存
- updateChapter 传 versionSource 对象 → 元数据正确
- updateChapter 不传 → 元数据 null
- updateChapterContent 同上
- createVersionSnapshot 显式存档
- listChapterVersions 顺序 + wordCountDelta + isCurrent
- getChapterVersion
- 删除章节 → CASCADE 清理版本

**验证命令**：`cd apps/agent-server && npx vitest run novel-store.test.ts`

---

## Slice 2：Diff 算法（独立模块）

**目标**：纯函数实现段落级 diff。
**验证**：Diff 单元测试全绿。
**依赖**：Slice 1（用 ChapterVersionDiff 类型，但实际只依赖 string 输入，可并行）。

### 步骤 2.1 Diff 模块

新建文件：`apps/agent-server/src/plugins/novel-plugin/core/chapter-version-diff.ts`

实现 `diffChapterVersions(fromContent, toContent)`（见规格 9）：
1. 按 `\n\n` 分段
2. LCS DP 对齐
3. 回溯生成 segments（unchanged/added/removed）
4. 合并相邻 removed+added 为 modified
5. 统计 stats

类型 `ChapterVersionDiff`、`ChapterVersionDiffSegment` 放在此文件或 shared 包（建议放 shared，供前端复用）。

边界（见规格 9.3）：
- from === to → 全 unchanged
- 空正文 → 0 段
- 超长段落（>5000 字）→ modified 不展开字符级

### 步骤 2.2 Diff 单元测试

新建文件：`apps/agent-server/src/__tests__/chapter-version-diff.test.ts`

用例见规格 13.2。

**验证命令**：`cd apps/agent-server && npx vitest run chapter-version-diff.test.ts`

---

## Slice 3：API 端点

**目标**：5 个版本管理 API 可用。
**验证**：API 集成测试全绿。
**依赖**：Slice 1（Store 方法）+ Slice 2（diff 函数）。

### 步骤 3.1 路由实现

文件：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`

在 `/chapters/:id` 现有路由之后追加 5 个端点：

1. **GET `/chapters/:id/versions`**：调 `store.listChapterVersions(id)`，返回 `ChapterVersionSummary[]`。章节不存在 → 404。
2. **GET `/chapters/:id/versions/:versionId`**：调 `store.getChapterVersion(versionId)`，校验 chapterId 匹配，返回 `ChapterVersion`。不存在 → 404，不匹配 → 400。
3. **GET `/chapters/:id/versions/diff`**：query 取 from/to，调 `store.getChapterVersion` 两次，校验都存在且属于该章节，调 `diffChapterVersions`，组装成 `ChapterVersionDiff` 返回。from/to 缺失 → 400。
4. **POST `/chapters/:id/versions/:versionId/rollback`**：见规格 10.3 实现。返回 `RollbackResult`。当前正文等于目标 → 400。
5. **POST `/chapters/:id/versions`**：body 取 `trigger?`，调 `store.createVersionSnapshot(id, { phase: 'manual_snapshot', trigger })`，返回 `ChapterVersion`。

**注意**：
- GET `/chapters/:id/versions/diff` 路径需注册在 `/chapters/:id/versions/:versionId` 之前，避免 'diff' 被当成 versionId。或者在 versionId handler 里判断是否 'diff' 转发。推荐前者（路径精确匹配优先）。
- rollback 的事务性：3 步操作（存 rollback_pre + 覆盖 + 存 rollback_applied）建议包在 `db.transaction` 内，避免中途失败留脏状态。

### 步骤 3.2 API 集成测试

文件：`apps/agent-server/src/__tests__/novel-routes.test.ts`

补充用例见规格 13.3。

**验证命令**：`cd apps/agent-server && npx vitest run novel-routes.test.ts`

---

## Slice 4：调用方接入（元数据准确化）

**目标**：关键写入路径传 versionSource，元数据准确。
**验证**：现有测试不破 + 版本元数据正确。
**依赖**：Slice 1。

### 步骤 4.1 FinalizeParams 加字段

文件：`apps/agent-server/src/core/agent/chapter-finalizer.ts`

- `FinalizeParams` 接口（行 83）加 `versionSource?: VersionSource`
- `finalize` 内调 `updateChapter`（行 228）时透传 `params.versionSource`

### 步骤 4.2 Orchestrator 传参

文件：`apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`

找到所有调 `this.finalizer.finalize(...)` 的位置，传 versionSource：
- **create-flow 正常路径**：`{ phase: 'writer_initial', agentType: 'writer', trigger: 'Writer 初稿落库' }`
- **Reviser 修订后路径**：`{ phase: 'reviser_final', agentType: 'reviser', trigger: 'Reviser 修订后落库' }`
- **rewrite/PostWriteGuard 重写后路径**：`{ phase: 'writer_initial', agentType: 'writer', trigger: \`PostWriteGuard/rewrite 后重写（第 ${guardRewriteCount} 次）\` }`

**注意**：finalize 在 orchestrator 内可能有多处调用（create-flow 主路径、rewrite 递归路径）。根据 `guardRewriteCount` 和是否经过 Reviser 选择 trigger。需要先 Grep 定位所有 finalize 调用点。

### 步骤 4.3 群聊路径传参

文件：`apps/agent-server/src/plugins/novel-plugin/core/novel-discussion-runner.ts`

找到调 `finalize` 的位置，传：
`{ phase: 'discussion_weaver', agentType: 'writer', trigger: '群聊共创编织' }`

如果群聊路径有 resume 续跑场景，trigger 标"群聊共创编织（断点续跑）"。

### 步骤 4.4 PATCH 路由传参

文件：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`

`PATCH /chapters/:id`（行 693-712）调 `store.updateChapter` 时（行 708），当 `input.content != null` 时传：
`{ phase: 'manual_patch', trigger: '用户手动编辑' }`

只在传 content 时传 versionSource（不改 content 时不产生版本，传不传无所谓）。

### 步骤 4.5 回归测试

- 运行 `chapter-finalizer.test.ts` 确认 finalize 透传不破现有测试
- 运行 `novel-orchestrator` 相关测试
- 运行 `novel-discussion-runner.test.ts`
- 运行 `novel-routes.test.ts`

**验证命令**：`cd apps/agent-server && npx vitest run`

---

## Slice 5：前端版本面板

**目标**：用户可查看版本列表、详情、diff、回滚、手动快照。
**验证**：手动验证 + 前端组件测试。
**依赖**：Slice 3（API 可用）。

### 步骤 5.1 API 客户端

文件：`apps/desktop/src/renderer/src/api/novel-client.ts`

新增方法：
- `listChapterVersions(chapterId): Promise<ChapterVersionSummary[]>`
- `getChapterVersion(chapterId, versionId): Promise<ChapterVersion>`
- `diffChapterVersions(chapterId, fromId, toId): Promise<ChapterVersionDiff>`
- `rollbackChapter(chapterId, versionId): Promise<RollbackResult>`
- `createChapterSnapshot(chapterId, trigger?): Promise<ChapterVersion>`

### 步骤 5.2 类型共享

把 `ChapterVersion`、`ChapterVersionSummary`、`ChapterVersionDiff`、`ChapterVersionPhase` 等类型从 shared 包导入前端（shared 包已跨端共享）。

### 步骤 5.3 版本面板组件

新建文件：`apps/desktop/src/renderer/src/components/novel/chapter-version-panel.tsx`

布局见规格 11.2：
- 左侧版本列表（sequence 倒序，显示 phase/trigger/字数/时间/wordCountDelta）
- 右侧详情/Diff 切换
- 详情视图：全文展示 + 元数据
- Diff 视图：段落级高亮（unchanged 灰、added 绿、removed 红、modified 黄）
- 底部操作按钮：回滚到此版本（二次确认）+ 手动快照

交互见规格 11.4：
- 点版本 → 右侧展示全文
- 勾选两个版本 → 切 Diff 视图
- 回滚 → confirm → 调 API → toast + 刷新编辑器内容 + 刷新列表
- 手动快照 → 输入说明 → 调 API → toast + 刷新列表

遵循用户偏好：
- 操作后 toast 通知
- 列表加载用骨架屏，不显示全屏 loading

### 步骤 5.4 接入编辑器

文件：`apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx`

- 顶部工具栏或右键菜单加"历史版本"按钮
- 点击打开 `chapter-version-panel`（Drawer 或 Modal）
- 回滚成功后，用返回的 `currentContent` 更新编辑器内容
- 回滚后 toast 提示"已回滚到版本 N"

### 步骤 5.5 phase 中文映射

在前端加一个 phase → 中文名 + 颜色的小工具函数，用于版本列表展示：
- writer_initial → "初稿"
- reviser_final → "修订后"
- discussion_weaver → "群聊编织"
- manual_patch → "手动编辑"
- rollback_pre → "回滚前"
- rollback_applied → "回滚应用"
- manual_snapshot → "手动快照"
- import → "导入"

### 步骤 5.6 前端测试

文件：`apps/desktop/src/renderer/src/components/novel/__tests__/chapter-version-panel.test.tsx`

- 列表渲染
- 点版本展示详情
- 勾选两版切 diff
- 回滚二次确认 + 调 API
- toast 反馈

**验证命令**：`cd apps/desktop && npx vitest run chapter-version-panel`

---

## 全局验证

所有 slice 完成后：
1. `cd apps/agent-server && npx vitest run`（后端全测试）
2. `cd apps/desktop && npx vitest run`（前端全测试）
3. `cd apps/agent-server && npx tsc --noEmit`（类型检查）
4. `cd apps/desktop && npx tsc --noEmit`（类型检查）
5. 手动 E2E：创作一章 → 查看版本列表 → diff 两版 → 回滚 → 确认编辑器内容更新

---

## 风险与注意点

1. **`updateChapter` 调用方众多**：Slice 1 不批量改现有调用方，靠拦截兜底。Slice 4 只改关键路径（finalize/orchestrator/discussion/PATCH）传参。
2. **路径匹配顺序**：`/chapters/:id/versions/diff` 必须在 `/chapters/:id/versions/:versionId` 之前注册，否则 'diff' 被当 versionId。
3. **rollback 事务性**：3 步操作包在 `db.transaction` 内。
4. **sequence 并发**：当前单章串行，MAX+1 够用。后续并发场景再优化。
5. **listChapterVersions 不返回 content**：避免列表接口流量过大，详情接口才返回全文。
6. **前端 loading**：版本列表用骨架屏，不用全屏 loading（用户偏好）。
7. **toast**：所有用户操作（回滚、手动快照）必须 toast 反馈（用户偏好）。
