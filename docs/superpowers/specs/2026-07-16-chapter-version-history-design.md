# 章节正文版本历史功能设计

**日期**：2026-07-16
**状态**：待审查
**作者**：协作设计（用户 + AI）

---

## 1. 概述

为小说创作工作台新增"章节正文版本历史"功能。每次正文被覆盖前自动存档，支持版本列表、版本详情、段落级 diff 对比、安全回滚。解决"重写/修订后旧正文永久丢失、无法追溯和恢复"的问题。

**核心场景**：版本管理 + 回滚。

**设计原则**：
- Store 层单一拦截点，保证所有写入路径都不漏存
- 自动存档为主，手动快照为辅
- 安全回滚（回滚前先存当前，可逆）
- 版本永久保留，不自动清理

---

## 2. 现状与问题

### 2.1 当前存储方式

章节正文存于 `novel_chapters.content` 字段（TEXT），是唯一存储位置。`NovelChapter` 接口（`packages/shared/src/novel/index.ts:128-160`）没有任何 version/revision/history 字段。

### 2.2 覆盖式写入

`NovelStore.updateChapter`（`novel-store.ts:796-819`）和 `updateChapterContent`（`novel-store.ts:822-825`）都是直接 SQL UPDATE 覆盖 content 字段，旧正文永久丢失。

所有写入路径都走这两个方法：
- create-flow：`ChapterFinalizer.finalize` → `updateChapter`（`chapter-finalizer.ts:217`）
- 群聊：`weaveChapter` 产出 → `finalize` → `updateChapter`
- rewrite：递归调 `createChapterWithFlow`，最终走 `finalize` → `updateChapter`
- PostWriteGuard 重写：递归调 `createChapterWithFlow`，同上
- 手动编辑：`PATCH /chapters/:id` 路由 → `updateChapter`

### 2.3 已有的"历史"设施不覆盖正文

| 设施 | 用途 | 与正文的关系 |
|------|------|-------------|
| `novel_memory_events` | 实体状态变更事件 | eventType 枚举无 `chapter_content_change` |
| `novel_memory_snapshots` | 章节级全量实体快照 | 不含 `novel_chapters.content` |
| `novel_character_history` | 角色动态状态历史 | 无关 |
| `novel_agent_logs.result` | Agent 调用日志含 Writer 输出 | 间接保留，但无版本管理 API |
| `novel_discussion_runs` | 群聊 transcript + content | 用于 resume，非版本管理 |

### 2.4 核心问题

用户每次重写、修订、PostWriteGuard 自动重写、手动编辑，旧正文都被永久覆盖，无法恢复、无法对比、无法回滚。

---

## 3. 设计目标

1. **不漏存**：任何一次 content 覆盖前都自动存档
2. **可追溯**：每个版本记录来源元数据（阶段、agent、触发原因）
3. **可对比**：任意两个版本段落级 diff
4. **可回滚**：安全回滚到任意旧版本，回滚本身可逆
5. **零侵入**：现有调用方尽量不改动，靠 Store 层拦截兜底
6. **永久保留**：版本不自动清理（正文是文本，存储量可控）

---

## 4. 总体架构

```
所有写入路径（create-flow / 群聊 / rewrite / PostWriteGuard / 手动PATCH / 回滚）
                          ↓
            NovelStore.updateChapter(id, patch, versionSource?)
            NovelStore.updateChapterContent(id, content, wordCount, versionSource?)
                          ↓
    检测到 content 变更 → 读旧 content → 写入 novel_chapter_versions 表 → 再 UPDATE
                          ↓
            （versionSource='skip' 时跳过拦截，调用方已手动存过）
                          ↓
                    novel_chapter_versions 表
                          ↓
        GET /chapters/:id/versions        版本列表
        GET /chapters/:id/versions/:vid   版本详情
        GET /chapters/:id/versions/diff   段落级 diff
        POST /chapters/:id/versions/:vid/rollback  安全回滚
        POST /chapters/:id/versions       手动快照
```

**关键决策**：Store 层拦截（方案 A），而非业务层显式快照（方案 B）。原因：写入路径 10+ 处，业务层接入容易漏接；Store 层是唯一能保证全覆盖的位置。

---

## 5. 数据模型

### 5.1 新建表 `novel_chapter_versions`

迁移编号：066（接现有 065 之后）

```sql
CREATE TABLE novel_chapter_versions (
  id          TEXT PRIMARY KEY,           -- 版本 ID（uuid）
  chapter_id  TEXT NOT NULL,              -- 章节 FK
  project_id  TEXT NOT NULL,              -- 项目 FK（冗余，方便按项目查询）
  content     TEXT NOT NULL,              -- 该版本正文全文
  word_count  INTEGER NOT NULL,           -- 字数
  -- 来源元数据
  phase       TEXT,                       -- 触发阶段，枚举见 5.2
  agent_type  TEXT,                       -- writer / reviser / director / null（手动操作）
  trigger     TEXT,                       -- 触发原因简述
  sequence    INTEGER NOT NULL,           -- 该章节版本序号（从 1 递增）
  created_at  INTEGER NOT NULL,           -- 创建时间戳
  FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE
);
CREATE INDEX idx_chapter_versions_chapter ON novel_chapter_versions(chapter_id, sequence);
CREATE INDEX idx_chapter_versions_project ON novel_chapter_versions(project_id, created_at);
```

**设计要点**：
- `sequence` 是章节内自增序号，不是全局 ID，前端展示"第 N 版"
- `project_id` 冗余字段，避免按项目查询时 JOIN
- `ON DELETE CASCADE`：章节删除时版本自动清理
- 正文是文本，单版本通常 < 50KB，无限保留存储可控

### 5.2 phase 枚举

```ts
export type ChapterVersionPhase =
  | 'writer_initial'        // create-flow Writer 初稿落库
  | 'reviser_final'         // Reviser 修订后落库
  | 'rewrite_pre'           // rewrite 递归重写前（显式快照）
  | 'postwrite_guard_pre'   // PostWriteGuard 自动重写前（显式快照）
  | 'discussion_weaver'     // 群聊 weaveChapter 落库
  | 'manual_patch'          // 用户手动 PATCH content
  | 'rollback_pre'          // 回滚前安全存当前
  | 'rollback_applied'      // 回滚写入的正文
  | 'manual_snapshot'       // 手动创建快照（POST /versions）
  | 'import'                // 外部导入
```

### 5.3 TypeScript 类型（`packages/shared/src/novel/index.ts`）

```ts
export interface ChapterVersion {
  id: string
  chapterId: string
  projectId: string
  content: string
  wordCount: number
  phase: ChapterVersionPhase | null
  agentType: string | null
  trigger: string | null
  sequence: number
  createdAt: number
}

/** 版本来源元数据，由调用方传入。
 *  - 传对象：拦截时存入版本表
 *  - 传 'skip'：调用方已手动存过，拦截跳过
 *  - 传 undefined：拦截仍存版本，但元数据为 null */
export type VersionSource =
  | { phase: ChapterVersionPhase; agentType?: string; trigger?: string }
  | 'skip'
  | undefined
```

---

## 6. Store 层拦截

### 6.1 修改 `NovelStore.updateChapter`

```ts
updateChapter(
  id: string,
  patch: Partial<NovelChapter>,
  versionSource?: VersionSource,  // 新增可选参数
): NovelChapter | undefined {
  const existing = this.db.prepare('SELECT * FROM novel_chapters WHERE id = ?').get(id)
  if (!existing) return undefined
  const current = this.rowToChapter(existing)

  // 拦截：content 被覆盖且与旧值不同时，先把旧 content 存为版本
  if (versionSource !== 'skip'
      && patch.content !== undefined
      && patch.content !== current.content) {
    this.saveChapterVersionInternal(current, versionSource ?? null)
  }

  // ... 原有 UPDATE 逻辑不变 ...
}
```

### 6.2 修改 `NovelStore.updateChapterContent`

```ts
updateChapterContent(
  id: string,
  content: string,
  wordCount: number,
  versionSource?: VersionSource,  // 新增可选参数
): NovelChapter | undefined {
  const current = this.getChapterById(id)
  if (current && versionSource !== 'skip' && content !== current.content) {
    this.saveChapterVersionInternal(current, versionSource ?? null)
  }
  // ... 原有 UPDATE 逻辑不变 ...
}
```

### 6.3 内部方法 `saveChapterVersionInternal`

```ts
private saveChapterVersionInternal(
  chapter: NovelChapter,
  source: VersionSource | null,
): void {
  const maxSeq = this.db.prepare(
    'SELECT MAX(sequence) as maxSeq FROM novel_chapter_versions WHERE chapter_id = ?'
  ).get(chapter.id)?.maxSeq ?? 0

  this.db.prepare(`
    INSERT INTO novel_chapter_versions
      (id, chapter_id, project_id, content, word_count, phase, agent_type, trigger, sequence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), chapter.id, chapter.projectId,
    chapter.content, chapter.wordCount,
    source && source !== 'skip' ? source.phase : null,
    source && source !== 'skip' ? (source.agentType ?? null) : null,
    source && source !== 'skip' ? (source.trigger ?? null) : null,
    maxSeq + 1, now(),
  )
}
```

### 6.4 新增公开方法

```ts
/** 列出章节所有版本（按 sequence 倒序，最新在前）。列表不含 content 全文。 */
listChapterVersions(chapterId: string): ChapterVersionSummary[] {
  return this.db.prepare(`
    SELECT id, chapter_id, project_id, word_count, phase, agent_type, trigger,
           sequence, created_at
    FROM novel_chapter_versions WHERE chapter_id = ? ORDER BY sequence DESC
  `).all(chapterId).map(this.rowToChapterVersionSummary.bind(this))
}

/** 获取特定版本详情（含全文）。 */
getChapterVersion(versionId: string): ChapterVersion | undefined {
  const row = this.db.prepare(
    'SELECT * FROM novel_chapter_versions WHERE id = ?'
  ).get(versionId)
  return row ? this.rowToChapterVersion(row) : undefined
}

/** 显式创建版本快照（用于 rewrite_pre / postwrite_guard_pre / rollback_pre / 手动快照）。 */
createVersionSnapshot(chapterId: string, source: VersionSource): ChapterVersion | undefined {
  if (source === 'skip' || source === undefined) return undefined
  const chapter = this.getChapterById(chapterId)
  if (!chapter) return undefined
  this.saveChapterVersionInternal(chapter, source)
  return this.getLatestVersion(chapterId)
}

/** 获取章节最新版本。 */
getLatestVersion(chapterId: string): ChapterVersion | undefined {
  const row = this.db.prepare(
    'SELECT * FROM novel_chapter_versions WHERE chapter_id = ? ORDER BY sequence DESC LIMIT 1'
  ).get(chapterId)
  return row ? this.rowToChapterVersion(row) : undefined
}
```

### 6.5 row 映射

```ts
private rowToChapterVersion(row: any): ChapterVersion {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    projectId: row.project_id,
    content: row.content,
    wordCount: row.word_count,
    phase: row.phase,
    agentType: row.agent_type,
    trigger: row.trigger,
    sequence: row.sequence,
    createdAt: row.created_at,
  }
}
```

---

## 7. 调用方接入点

### 7.1 自动覆盖（拦截兜底，无需改动）

以下调用方不传 `versionSource`，拦截自动存版本，元数据为 null（可接受）：

- `ChapterFinalizer.finalize` 的 `updateChapter` 调用（如果 orchestrator 不显式传参）
- `updateChapterContent` 的其他调用方（如有）

**但为了让元数据准确，关键路径应显式传参。**

### 7.2 显式传参（元数据准确）

| 接入点 | phase | agentType | trigger | 说明 |
|--------|-------|-----------|---------|------|
| `ChapterFinalizer.finalize` 落库 | `writer_initial` 或 `reviser_final` 或 `discussion_weaver` | `writer` / `reviser` | 阶段说明 | finalize 需接收 versionSource 参数 |
| `PATCH /chapters/:id` 传 content | `manual_patch` | null | "用户手动编辑" | 路由层传 |
| 手动快照 `POST /chapters/:id/versions` | `manual_snapshot` | null | body.trigger | 路由层调 `createVersionSnapshot` |
| 回滚 `POST /chapters/:id/versions/:vid/rollback` | `rollback_pre` + `rollback_applied` | null | "回滚到版本 X" | 见第 10 节 |

### 7.3 rewrite / PostWriteGuard 的处理

rewrite 和 PostWriteGuard 都是递归调用 `createChapterWithFlow`，最终仍走 `finalize` → `updateChapter` 落库。落库时拦截会自动把"被覆盖的旧正文"存为版本。

**不单独显式快照**，依赖 finalize 拦截存档。原因：rewrite/PostWriteGuard 递归前的正文，与 finalize 落库时被覆盖的正文是同一份，显式快照会产生冗余版本。

phase 标记为 `writer_initial`，通过 trigger 字段区分是初稿还是重写：

```ts
// finalize 调用方（orchestrator）传参
const versionSource: VersionSource = isReviserPath
  ? { phase: 'reviser_final', agentType: 'reviser', trigger: 'Reviser 修订后落库' }
  : guardRewriteCount > 0
    ? { phase: 'writer_initial', agentType: 'writer', trigger: `PostWriteGuard/rewrite 后重写（第 ${guardRewriteCount} 次）` }
    : { phase: 'writer_initial', agentType: 'writer', trigger: 'Writer 初稿落库' }
```

> `rewrite_pre` 和 `postwrite_guard_pre` 两个 phase 枚举值保留供未来扩展（如需要在递归前留独立标记时使用），当前实现不产生这两个 phase 的版本。

### 7.4 finalize 传参方案

给 `ChapterFinalizer.finalize` 的参数对象加可选字段：

```ts
interface FinalizeParams {
  // ... 现有字段 ...
  versionSource?: VersionSource  // 新增
}
```

finalize 内部调 `updateChapter` 时透传：

```ts
this.store.updateChapter(chapterId, {
  content: cleanedContent,
  status: 'review',
  wordCount: cleanedContent.length,
  // ...
}, params.versionSource)
```

群聊路径（`novel-discussion-runner.ts`）调 finalize 时传：

```ts
{ phase: 'discussion_weaver', agentType: 'writer', trigger: '群聊共创编织' }
```

---

## 8. API 设计

路由文件：`novel-routes.ts`

### 8.1 GET `/chapters/:id/versions`

列出章节所有版本（按 sequence 倒序）。

**响应**（列表，不含 content 全文）：

```ts
interface ChapterVersionSummary {
  id: string
  sequence: number
  phase: ChapterVersionPhase | null
  agentType: string | null
  trigger: string | null
  wordCount: number
  wordCountDelta: number    // 与上一版的字数差（正/负/0）
  createdAt: number
  isCurrent: boolean        // 是否对应当前正文（最新一版为 true）
}
```

**wordCountDelta 计算**：后端在组装列表时，按 sequence 正序计算每版与前一版的 wordCount 差，再倒序返回。

### 8.2 GET `/chapters/:id/versions/:versionId`

获取特定版本详情（含全文）。

**响应**：`ChapterVersion`（含 content）

**校验**：versionId 的 chapterId 必须匹配 :id，否则 400。

### 8.3 GET `/chapters/:id/versions/diff?from=&to=`

两个版本的段落级 diff。

**查询参数**：
- `from`：源版本 ID
- `to`：目标版本 ID

**响应**：

```ts
interface ChapterVersionDiff {
  fromVersionId: string
  toVersionId: string
  fromSequence: number
  toSequence: number
  segments: Array<
    | { type: 'unchanged'; content: string; fromIndex: number; toIndex: number }
    | { type: 'added'; content: string; toIndex: number }
    | { type: 'removed'; content: string; fromIndex: number }
    | { type: 'modified'; fromContent: string; toContent: string; fromIndex: number; toIndex: number }
  >
  stats: {
    added: number
    removed: number
    modified: number
    unchanged: number
    wordCountDelta: number
  }
}
```

### 8.4 POST `/chapters/:id/versions/:versionId/rollback`

安全回滚到指定版本。

**流程**：见第 10 节。

**响应**：

```ts
interface RollbackResult {
  success: boolean
  savedVersionId: string   // 回滚前安全存的版本 ID（rollback_pre）
  currentContent: string   // 回滚后的当前正文
  currentWordCount: number
}
```

### 8.5 POST `/chapters/:id/versions`

手动创建快照。

**请求体**：

```ts
{ trigger?: string }  // 可选说明
```

**响应**：`ChapterVersion`（新建的快照）

---

## 9. Diff 算法（段落级）

### 9.1 实现位置

新建 `apps/agent-server/src/plugins/novel-plugin/core/chapter-version-diff.ts`，纯函数，不依赖 Store。

### 9.2 算法

1. **分段**：正文按 `\n\n` 切分为段落数组（保留单段内的换行）
2. **LCS 对齐**：用最长公共子序列 DP 对齐两个段落数组
   - 复杂度 O(n×m)，段落级 n/m 通常 < 100，性能足够
3. **回溯生成 segments**：遍历 LCS 结果，标记 unchanged / added / removed
4. **合并 modified**：相邻的 removed + added 对合并为 modified（避免一段拆成"删旧+加新"两条，可读性差）
5. **统计 stats**：统计各类型数量 + wordCountDelta

### 9.3 边界处理

- `from === to`（同版本）：返回全 unchanged
- 空正文版本：当作 0 段处理，显示全部 added 或全部 removed
- 超长段落（单段 > 5000 字）：modified 段不展开字符级 diff，只标"已修改"并展示前后全文

### 9.4 核心函数签名

```ts
export function diffChapterVersions(
  fromContent: string,
  toContent: string,
): Omit<ChapterVersionDiff, 'fromVersionId' | 'toVersionId' | 'fromSequence' | 'toSequence'>
```

---

## 10. 回滚流程

### 10.1 安全回滚语义

回滚 = "把当前正文存为新版本（rollback_pre）→ 用目标版本覆盖当前正文（rollback_applied）"。回滚本身可逆，不丢当前正文。

### 10.2 流程

```
POST /chapters/:id/versions/:versionId/rollback
        ↓
1. 读取目标版本：getChapterVersion(versionId)
   - 不存在 → 404
   - chapterId 不匹配 :id → 400
2. 读取当前章节：getChapterById(id)
   - 当前正文 === 目标版本正文 → 400 "当前正文已是该版本，无需回滚"
3. 安全存当前（rollback_pre）：createVersionSnapshot
4. 覆盖当前正文，跳过拦截（versionSource='skip'）：updateChapterContent
5. 显式存回滚后的正文（rollback_applied）：createVersionSnapshot
```

### 10.3 实现代码

第 4 步传 `versionSource='skip'` 跳过拦截，避免与第 3 步的 `rollback_pre` 重复存"被覆盖的当前正文"。然后第 5 步显式存 `rollback_applied` 记录"回滚后的正文"，让版本链清晰。

```ts
// 1. 安全存当前（rollback_pre）
const savedVersion = store.createVersionSnapshot(id, {
  phase: 'rollback_pre',
  trigger: `回滚到版本 ${versionId}（seq ${target.sequence}）`
})
// 2. 覆盖当前正文，跳过拦截
store.updateChapterContent(id, target.content, target.wordCount, 'skip')
// 3. 显式存回滚后的正文（rollback_applied）
store.createVersionSnapshot(id, {
  phase: 'rollback_applied',
  trigger: `回滚自版本 ${versionId}`
})
```

### 10.4 回滚后的版本链示例

```
seq 1: writer_initial    "初稿"
seq 2: reviser_final     "修订后"       ← 当前正文
--- 用户点回滚到 seq 1 ---
seq 3: rollback_pre      "修订后"       ← 安全存当前
seq 4: rollback_applied  "初稿"         ← 回滚写入，当前正文变回初稿
```

版本链清晰，用户一眼看到"回滚到这里了"。后续修改会继续追加 seq 5+。

---

## 11. 前端集成要点

### 11.1 入口

章节编辑器（`chapter-content-editor.tsx`）顶部工具栏或右键菜单加"历史版本"按钮，打开版本面板（Drawer 或 Modal）。

### 11.2 版本面板布局

```
┌─────────────────────────────────────────────┐
│ 版本历史                          [关闭]     │
├──────────────┬──────────────────────────────┤
│ 版本列表     │ 版本详情 / Diff 对比          │
│              │                              │
│ ● seq 4      │ [版本详情 | Diff 对比] 切换   │
│   回滚应用   │                              │
│   刚刚       │ seq 4 - 回滚应用             │
│              │ 字数 3200 (+200)             │
│ ○ seq 3      │ ─────────────────────────    │
│   回滚前     │ 正文全文展示...              │
│   刚刚       │                              │
│              │ [回滚到此版本] [手动快照]     │
│ ○ seq 2      │                              │
│   修订后     │                              │
│   5分钟前    │                              │
│              │                              │
│ ○ seq 1      │                              │
│   初稿       │                              │
│   10分钟前   │                              │
└──────────────┴──────────────────────────────┘
```

### 11.3 Diff 视图

- 左右两列或上下两段对比
- unchanged 灰色，added 绿色，removed 红色，modified 黄色并展示前后
- 段落级高亮，不展开字符级

### 11.4 交互

- 版本列表点某版 → 右侧展示全文
- 勾选两个版本 → 切换到 Diff 对比视图
- "回滚到此版本"按钮 → 二次确认 → 调 rollback API → 刷新编辑器内容 + 刷新版本列表
- "手动快照"按钮 → 输入说明 → 调 POST /versions → 刷新列表
- 操作后 toast 反馈（遵循用户偏好：保存动作需 toast 通知）

### 11.5 定时刷新不显示 loading

版本列表加载用骨架屏或直接替换，不显示全屏 loading（遵循用户偏好）。

---

## 12. 迁移与兼容

### 12.1 数据库迁移

迁移 066 创建 `novel_chapter_versions` 表（见第 5 节）。迁移幂等：`CREATE TABLE IF NOT EXISTS`。

### 12.2 现有数据兼容

- 现有章节无版本记录，`listChapterVersions` 返回空数组，前端显示"暂无历史版本"
- 现有调用方不传 `versionSource` 也能工作（拦截存版本，元数据 null）
- 不回填历史版本（旧正文已丢失，无法恢复）

### 12.3 向后兼容

- `updateChapter` / `updateChapterContent` 的 `versionSource` 是可选参数，现有调用方无需改动
- 新增 API 端点不影响现有端点

---

## 13. 测试计划

### 13.1 Store 层单元测试（`novel-store.test.ts` 补充）

- `updateChapter` 传 content 且与旧值不同 → 自动存版本，sequence 递增
- `updateChapter` 传 content 但与旧值相同 → 不存版本
- `updateChapter` 只改 title 不改 content → 不存版本
- `updateChapter` 传 `versionSource='skip'` → 不存版本
- `updateChapter` 传 `versionSource` 对象 → 版本元数据正确
- `updateChapter` 不传 `versionSource` → 版本元数据为 null
- `updateChapterContent` 同上
- `createVersionSnapshot` 显式存档
- `listChapterVersions` 按 sequence 倒序
- `getChapterVersion` 按 id 查询
- 章节删除（CASCADE）→ 版本自动清理

### 13.2 Diff 算法单元测试（新建 `chapter-version-diff.test.ts`）

- 完全相同 → 全 unchanged
- 纯新增段落 → added
- 纯删除段落 → removed
- 修改段落 → modified（不拆成 removed+added）
- 空正文 vs 非空 → 全 added
- 非空 vs 空正文 → 全 removed
- 超长段落 → modified 不展开字符级
- 复杂混合场景（增删改并存）

### 13.3 API 集成测试（`novel-routes.test.ts` 补充）

- `GET /chapters/:id/versions` 返回列表，wordCountDelta 正确
- `GET /chapters/:id/versions/:vid` 返回详情含全文
- `GET /chapters/:id/versions/:vid` chapterId 不匹配 → 400
- `GET /chapters/:id/versions/diff` 返回 diff segments
- `POST /chapters/:id/versions/:vid/rollback` 回滚后当前正文 = 目标版本
- 回滚后版本链：rollback_pre + rollback_applied 两个新版本
- 回滚到当前正文 → 400
- `POST /chapters/:id/versions` 手动快照 → 新版本

### 13.4 端到端测试

- create-flow 创作一章 → 版本列表有 writer_initial
- 触发 revise → 版本列表有 reviser_final
- 触发 rewrite → 版本列表有 writer_initial（trigger 标 rewrite）
- 触发 PostWriteGuard 重写 → 版本列表有 writer_initial（trigger 标 guard）
- 群聊创作 → 版本列表有 discussion_weaver
- 手动 PATCH content → 版本列表有 manual_patch
- 回滚 → 版本列表有 rollback_pre + rollback_applied，编辑器内容更新

---

## 14. 风险与边界

### 14.1 性能

- 每次 `updateChapter` 多一次 SELECT（读旧 content）+ INSERT（存版本），开销可忽略（正文是文本，单次 < 1ms）
- `listChapterVersions` 不返回 content 全文，避免大流量
- Diff 算法 O(n×m) 段落级，n/m < 100，性能足够

### 14.2 存储

- 单版本 < 50KB（万字正文），一章 50 个版本 ≈ 2.5MB
- 无限保留，不自动清理
- 用户可手动删除版本（后续迭代可加 DELETE API，本期不做）

### 14.3 并发

- `saveChapterVersionInternal` 的 `MAX(sequence)+1` 非原子操作，并发写入可能 sequence 冲突
- 当前项目单章创作是串行的（create-flow 有锁），风险低
- 若后续支持并发，可改用 `AUTOINCREMENT` 或事务内加锁

### 14.4 群聊 resume 与版本的交互

- `resumeChapterWeaving` 从 `novel_discussion_runs` 恢复 transcript，重新 weaveChapter 后走 finalize 落库
- 落库时拦截存版本，phase 为 `discussion_weaver`，trigger 标"断点续跑"
- 不影响 resume 逻辑本身

### 14.5 不在本次范围

- 版本删除 API（用户手动清理）
- 跨章节的正文演变时间线
- 创作过程回放（Director/Writer/Reviewer 各步输入输出）
- 字符级 diff（段落级已够用）
- 版本搜索/过滤

---

## 15. 实现顺序建议

1. 迁移 066 + 类型定义（`packages/shared/src/novel/index.ts`）
2. Store 层拦截 + 公开方法（`novel-store.ts`）
3. Diff 算法（`chapter-version-diff.ts`）
4. API 路由（`novel-routes.ts`）
5. 调用方接入（`chapter-finalizer.ts` + `novel-orchestrator.ts` + `novel-discussion-runner.ts` + PATCH 路由）
6. 测试（Store + Diff + API + E2E）
7. 前端版本面板（`chapter-version-panel.tsx` + 接入编辑器）

---

## 附录 A：相关文件清单

**新增**：
- `apps/agent-server/src/plugins/novel-plugin/core/chapter-version-diff.ts`（Diff 算法）
- `apps/desktop/src/renderer/src/components/novel/chapter-version-panel.tsx`（前端版本面板）
- `apps/agent-server/src/__tests__/chapter-version-diff.test.ts`（Diff 测试）

**修改**：
- `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`（迁移 066）
- `packages/shared/src/novel/index.ts`（类型定义）
- `apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts`（拦截 + 公开方法）
- `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`（5 个 API 端点）
- `apps/agent-server/src/core/agent/chapter-finalizer.ts`（versionSource 透传）
- `apps/agent-server/src/plugins/novel-plugin/core/novel-orchestrator.ts`（finalize 传参）
- `apps/agent-server/src/plugins/novel-plugin/core/novel-discussion-runner.ts`（finalize 传参）
- `apps/desktop/src/renderer/src/api/novel-client.ts`（前端 API 客户端）
- `apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx`（接入版本面板）
- `apps/agent-server/src/__tests__/novel-store.test.ts`（Store 测试补充）
- `apps/agent-server/src/__tests__/novel-routes.test.ts`（API 测试补充）
