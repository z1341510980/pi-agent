# PlotPilot 借鉴落地实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 PlotPilot 项目中 5 项最有价值的设计借鉴到 pi-agent：章节重排纯函数、防 AI 腔正则库、章节张力曲线、运行时性能配置集中化、LLM 调用熔断器。

**架构：** 全部为本地纯模块/小工具，不改变 pi-agent 现有 Agent 范式与 SSE 流式协议。任务 1/2/5 落在 agent-server 后端，任务 3 跨前后端，任务 4 各端独立配置。所有任务遵循 TDD，先红后绿。

**技术栈：** TypeScript + Fastify + better-sqlite3 + zod（后端）；React + zustand + Tailwind（前端）；vitest 测试。

---

## 文件结构

### 创建

- `apps/agent-server/src/plugins/novel-plugin/core/chapter-renumber.ts` — 章节号重排纯函数模块（值对象 + JSON 字段 walker + 字段映射常量）
- `apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts` — 重排纯函数单测
- `apps/agent-server/src/plugins/novel-plugin/core/cliche-scanner.ts` — 防 AI 腔正则库 + hint 字段
- `apps/agent-server/src/plugins/novel-plugin/__tests__/cliche-scanner.test.ts` — 正则库扫描单测
- `apps/agent-server/src/core/agent/circuit-breaker.ts` — 三态熔断器（CLOSED/OPEN/HALF_OPEN）
- `apps/agent-server/src/__tests__/circuit-breaker.test.ts` — 熔断器单测
- `apps/desktop/src/renderer/src/config/performance.ts` — 前端运行时性能配置（throttle/queue/timeout 等集中常量，env 可覆盖）
- `apps/agent-server/src/config/performance.ts` — 后端运行时性能配置（LLM 超时/熔断阈值/重试次数等集中常量，env 可覆盖）

### 修改

- `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts` — 追加迁移 `047_add_tension_to_novel_chapters`
- `apps/agent-server/src/plugins/novel-plugin/core/types.ts` — `NovelChapter` 接口新增 `tension?: number` 字段（1-10）
- `apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts` — `deleteChapter` 在删后调用 `ChapterRenumberSpec` 重排后续章节号；`rowToChapter` 读取 `tension` 字段；`updateChapter`/`createChapter` 写入 `tension` 字段
- `apps/agent-server/src/plugins/novel-plugin/core/novel-character-generator.ts` — `generate` 中用 `CircuitBreaker` 包装 `session.promptStream` 调用，作为熔断器使用示范
- `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-reviewer.md` — 增加"AI 腔扫描结果"段落注入位（运行时由 Reviewer Agent 拼接扫描结果）
- `apps/desktop/src/renderer/src/api/novel-client.ts` — `NovelChapter` 类型增加 `tension?: number`
- `apps/desktop/src/renderer/src/stores/novel-store.ts` — `NovelChapter` 已通过 import 复用，无需改类型；`upsertChapter` 不变（透传 tension）
- `apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx` — 章节标尺根据 `chapter.tension` 渲染色阶背景；当前章节列高亮附带张力数值徽标

---

## 任务 1：ChapterRenumberSpec 章节重排纯函数

**借鉴来源：** PlotPilot `domain/novel/value_objects/chapter_renumber_spec.py` + `domain/novel/chapter_renumber/json_walk.py`

**为什么：** pi-agent 当前 `deleteChapter` 只删行不重排，导致后续章节号出现"空洞"（删第 3 章后第 4 章仍叫第 4 章，但用户期望变成第 3 章）。PlotPilot 用三层抽象把这件事做得干净：值对象（描述要做什么）+ JSON walker（递归处理嵌套字段）+ 字段映射常量（哪些表/字段引用了 chapter_number）。pi-agent 的 `chapter_spans` 是 JSON 数组 `[[1,3],[10,12]]`，需要专门的 shift 逻辑。

**文件：**
- 创建：`apps/agent-server/src/plugins/novel-plugin/core/chapter-renumber.ts`
- 创建：`apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts`
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts`（`deleteChapter` 方法，约 604-608 行）

### 步骤 1.1：编写失败的测试（标量字段 shift）

- [ ] **编写测试**

创建 `apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import {
  shiftChapterNumber,
  shiftChapterSpans,
  shiftChapterList,
  type ChapterRenumberSpec,
  createChapterRenumberSpec,
} from '../core/chapter-renumber.js'

describe('ChapterRenumberSpec - 标量字段 shift', () => {
  it('当被删章节是 3，当前字段值 5 时，应 shift 为 4', () => {
    expect(shiftChapterNumber(5, createChapterRenumberSpec(3))).toBe(4)
  })

  it('当被删章节是 3，当前字段值 3 时，应返回 null（被删章节引用需清除）', () => {
    expect(shiftChapterNumber(3, createChapterRenumberSpec(3))).toBeNull()
  })

  it('当被删章节是 3，当前字段值 2 时，不变（小于被删章节）', () => {
    expect(shiftChapterNumber(2, createChapterRenumberSpec(3))).toBe(2)
  })

  it('当被删章节是 3，当前字段值 null 时，返回 null', () => {
    expect(shiftChapterNumber(null, createChapterRenumberSpec(3))).toBeNull()
  })

  it('delta 为正数时（向右 shift，预留插入场景），值 5 → 6', () => {
    const spec: ChapterRenumberSpec = { deletedChapter: 3, delta: 1 }
    expect(shiftChapterNumber(5, spec)).toBe(6)
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts
```
预期：FAIL，报错 `Cannot find module '../core/chapter-renumber.js'`

### 步骤 1.2：编写失败的测试（chapter_spans JSON 数组 shift）

- [ ] **追加测试**

在同一文件追加：

```typescript
describe('ChapterRenumberSpec - chapter_spans JSON 数组 shift', () => {
  it('单段跨度 [[1,5]] 删第 3 章 → [[1,4]]（end 减 1，start 不变因小于被删章）', () => {
    expect(shiftChapterSpans([[1, 5]], createChapterRenumberSpec(3))).toEqual([[1, 4]])
  })

  it('单段跨度 [[1,2]] 删第 3 章 → [[1,2]]（被删章在跨度外，不变）', () => {
    expect(shiftChapterSpans([[1, 2]], createChapterRenumberSpec(3))).toEqual([[1, 2]])
  })

  it('单段跨度 [[3,5]] 删第 3 章 → [[3,4]]（start 等于被删章，视为从被删章开始，start 不变 end shift）', () => {
    expect(shiftChapterSpans([[3, 5]], createChapterRenumberSpec(3))).toEqual([[3, 4]])
  })

  it('单段跨度 [[3,3]] 删第 3 章 → []（整段被删，移除）', () => {
    expect(shiftChapterSpans([[3, 3]], createChapterRenumberSpec(3))).toEqual([])
  })

  it('多段跨度 [[1,2],[5,8]] 删第 5 章 → [[1,2],[5,7]]（仅第二段 end 减 1）', () => {
    expect(shiftChapterSpans([[1, 2], [5, 8]], createChapterRenumberSpec(5))).toEqual([[1, 2], [5, 7]])
  })

  it('多段跨度 [[1,2],[5,8]] 删第 3 章 → [[1,2],[4,7]]（第二段 start 和 end 都减 1）', () => {
    expect(shiftChapterSpans([[1, 2], [5, 8]], createChapterRenumberSpec(3))).toEqual([[1, 2], [4, 7]])
  })

  it('空数组不变', () => {
    expect(shiftChapterSpans([], createChapterRenumberSpec(3))).toEqual([])
  })

  it('非法跨度（start > end）原样返回，不做修复', () => {
    expect(shiftChapterSpans([[5, 3]], createChapterRenumberSpec(2))).toEqual([[5, 3]])
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts
```
预期：FAIL，`shiftChapterSpans` 未定义

### 步骤 1.3：编写失败的测试（appear_chapters JSON 列表 shift）

- [ ] **追加测试**

```typescript
describe('ChapterRenumberSpec - appear_chapters JSON 列表 shift', () => {
  it('列表 [1,2,5,7] 删第 3 章 → [1,2,4,6]（大于被删章的全减 1）', () => {
    expect(shiftChapterList([1, 2, 5, 7], createChapterRenumberSpec(3))).toEqual([1, 2, 4, 6])
  })

  it('列表 [1,2,3,5] 删第 3 章 → [1,2,4]（被删章本身移除）', () => {
    expect(shiftChapterList([1, 2, 3, 5], createChapterRenumberSpec(3))).toEqual([1, 2, 4])
  })

  it('空列表不变', () => {
    expect(shiftChapterList([], createChapterRenumberSpec(3))).toEqual([])
  })

  it('含重复值 [1,1,3,3] 删第 3 章 → [1,1]（两个 3 都被移除）', () => {
    expect(shiftChapterList([1, 1, 3, 3], createChapterRenumberSpec(3))).toEqual([1, 1])
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts
```
预期：FAIL，`shiftChapterList` 未定义

### 步骤 1.4：实现 ChapterRenumberSpec 模块

- [ ] **编写实现**

创建 `apps/agent-server/src/plugins/novel-plugin/core/chapter-renumber.ts`：

```typescript
/**
 * 章节号重排规格（借鉴 PlotPilot ChapterRenumberSpec）
 *
 * 当删除某章节后，所有引用了 chapter_number 的字段需要：
 * - 大于被删章节的：减 1
 * - 等于被删章节的：清除（返回 null / 从数组移除）
 * - 小于被删章节的：不变
 *
 * 三类字段处理：
 * 1. 标量 chapter_number：shiftChapterNumber
 * 2. JSON 数组 [[start,end],...]：shiftChapterSpans（冲突/势力跨度）
 * 3. JSON 列表 [n,n,...]：shiftChapterList（地点出现章节）
 *
 * 字段映射常量 CHAPTER_RENUMBER_FIELDS 在 NovelStore.deleteChapter 中使用，
 * 列出所有需要被重排的表/列，便于后续扩展。
 */

export interface ChapterRenumberSpec {
  /** 被删除的章节号 */
  readonly deletedChapter: number
  /** 偏移量：删章 = -1（默认），插章 = +1（预留） */
  readonly delta: number
}

export function createChapterRenumberSpec(
  deletedChapter: number,
  delta: number = -1,
): ChapterRenumberSpec {
  if (!Number.isInteger(deletedChapter) || deletedChapter < 1) {
    throw new Error(`deletedChapter 必须是正整数，收到: ${deletedChapter}`)
  }
  if (delta !== -1 && delta !== 1) {
    throw new Error(`delta 仅支持 -1（删章）和 +1（插章），收到: ${delta}`)
  }
  return { deletedChapter, delta }
}

/**
 * 处理标量 chapter_number 字段
 * @returns 新章节号；若字段引用的就是被删章节，返回 null（调用方负责清除或删除该行）
 */
export function shiftChapterNumber(
  current: number | null | undefined,
  spec: ChapterRenumberSpec,
): number | null {
  if (current == null) return null
  if (current === spec.deletedChapter) return null
  if (spec.delta === -1 && current > spec.deletedChapter) return current - 1
  if (spec.delta === 1 && current >= spec.deletedChapter) return current + 1
  return current
}

/**
 * 处理 chapter_spans JSON 数组 [[start,end],...]
 * - 跨度完全等于被删章节（[3,3] 删第 3 章）：移除该段
 * - 跨度包含被删章节：调整 end（删章则 end-1）
 * - 跨度起点大于被删章节：start 和 end 都 shift
 * - 跨度终点小于被删章节：不变
 */
export function shiftChapterSpans(
  spans: Array<[number, number]>,
  spec: ChapterRenumberSpec,
): Array<[number, number]> {
  const result: Array<[number, number]> = []
  for (const [start, end] of spans) {
    if (start > end) {
      // 非法跨度，原样保留
      result.push([start, end])
      continue
    }
    // 整段都被删（[3,3] 删 3）
    if (start === spec.deletedChapter && end === spec.deletedChapter) {
      continue
    }
    let newStart = start
    let newEnd = end
    if (spec.delta === -1) {
      if (start > spec.deletedChapter) newStart = start - 1
      if (end >= spec.deletedChapter) newEnd = end - 1
    } else {
      // 插章：>= deletedChapter 的都 +1
      if (start >= spec.deletedChapter) newStart = start + 1
      if (end >= spec.deletedChapter) newEnd = end + 1
    }
    result.push([newStart, newEnd])
  }
  return result
}

/**
 * 处理 appear_chapters JSON 列表 [n,n,...]
 * - 等于被删章节的元素：移除
 * - 大于被删章节的元素：减 1
 * - 小于被删章节的元素：不变
 */
export function shiftChapterList(
  chapters: number[],
  spec: ChapterRenumberSpec,
): number[] {
  const result: number[] = []
  for (const ch of chapters) {
    if (ch === spec.deletedChapter) continue
    if (spec.delta === -1 && ch > spec.deletedChapter) {
      result.push(ch - 1)
    } else if (spec.delta === 1 && ch >= spec.deletedChapter) {
      result.push(ch + 1)
    } else {
      result.push(ch)
    }
  }
  return result
}

/**
 * 字段映射常量：列出所有引用 chapter_number 的表和列
 *
 * 借鉴 PlotPilot DEFAULT_CHAPTER_INTEGER_JSON_KEYS frozenset 思路，
 * 但更细化——区分三类字段：
 *   scalar  - 整数标量字段，用 shiftChapterNumber
 *   spans   - JSON 跨度数组，用 shiftChapterSpans
 *   list    - JSON 列表，用 shiftChapterList
 *
 * NovelStore.deleteChapter 遍历此常量，对每张表执行相应 UPDATE。
 */
export const CHAPTER_RENUMBER_FIELDS = [
  { table: 'novel_chapters', column: 'chapter_number', kind: 'scalar' as const },
  { table: 'novel_memory_events', column: 'chapter_number', kind: 'scalar' as const },
  { table: 'novel_memory_snapshots', column: 'chapter_number', kind: 'scalar' as const },
  { table: 'novel_agent_logs', column: 'chapter_number', kind: 'scalar' as const },
  { table: 'novel_character_history', column: 'chapter_number', kind: 'scalar' as const },
  { table: 'novel_markers', column: 'chapter', kind: 'scalar' as const },
  { table: 'novel_conflicts', column: 'chapter_spans', kind: 'spans' as const },
  { table: 'novel_factions', column: 'chapter_spans', kind: 'spans' as const },
  { table: 'novel_locations', column: 'appear_chapters', kind: 'list' as const },
]
```

- [ ] **运行测试验证通过**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts
```
预期：PASS（全部 16 个用例）

### 步骤 1.5：编写集成测试（NovelStore.deleteChapter 自动重排）

- [ ] **追加集成测试**

在 `chapter-renumber.test.ts` 文件末尾追加：

```typescript
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { NovelStore } from '../core/novel-store.js'
import { novelMigrations } from '../novel-migrations.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of novelMigrations) db.exec(m.sql)
  return db
}

describe('NovelStore.deleteChapter 集成 - 章节重排', () => {
  let db: Database.Database
  let store: NovelStore
  let projectId: string

  beforeEach(() => {
    db = createTestDb()
    store = new NovelStore(db)
    const project = store.createProject({
      id: randomUUID(),
      title: '测试项目',
      genre: 'test',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    projectId = project.id
    // 创建 5 章
    for (let i = 1; i <= 5; i++) {
      store.createChapter({
        id: randomUUID(),
        projectId,
        volume: 1,
        chapterNumber: i,
        title: `第${i}章`,
        content: '',
        wordCount: 0,
        status: 'planned',
        narrativeTask: '',
        acceptanceResult: null,
      })
    }
  })

  afterEach(() => db.close())

  it('删除第 3 章后，第 4、5 章号自动前移为 3、4', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    store.deleteChapter(ch3.id)
    const after = store.listChapters(projectId).sort((a, b) => a.chapterNumber - b.chapterNumber)
    expect(after.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 4])
    expect(after[2].title).toBe('第4章')
    expect(after[3].title).toBe('第5章')
  })

  it('删除第 1 章后，所有后续章节号前移', () => {
    const chapters = store.listChapters(projectId)
    const ch1 = chapters.find((c) => c.chapterNumber === 1)!
    store.deleteChapter(ch1.id)
    const after = store.listChapters(projectId).sort((a, b) => a.chapterNumber - b.chapterNumber)
    expect(after.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 4])
    expect(after[0].title).toBe('第2章')
  })

  it('删除末章（第 5 章）后，其他章节号不变', () => {
    const chapters = store.listChapters(projectId)
    const ch5 = chapters.find((c) => c.chapterNumber === 5)!
    store.deleteChapter(ch5.id)
    const after = store.listChapters(projectId).sort((a, b) => a.chapterNumber - b.chapterNumber)
    expect(after.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 4])
  })

  it('删除章节时同步重排 markers.chapter', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    const ch5 = chapters.find((c) => c.chapterNumber === 5)!
    // 在第 5 章放一个 marker
    store.createMarker({
      id: randomUUID(),
      projectId,
      chapter: 5,
      title: '测试标记',
      type: 'bookmark',
      color: 'blue',
      note: '',
      createdAt: Date.now(),
    })
    store.deleteChapter(ch3.id)
    const markers = store.listMarkers(projectId)
    expect(markers).toHaveLength(1)
    expect(markers[0].chapter).toBe(4) // 5 → 4
  })

  it('删除章节时同步重排 conflict.chapter_spans', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    // 创建一个跨度 [4, 5] 的冲突
    store.createConflict({
      id: randomUUID(),
      projectId,
      description: '冲突1',
      type: 'interest',
      intensity: 5,
      stage: 'latent',
      participants: '[]',
      chapterSpans: [[4, 5]],
      tier: 'secondary',
    })
    store.deleteChapter(ch3.id)
    const conflicts = store.listConflicts(projectId)
    expect(conflicts[0].chapterSpans).toEqual([[3, 4]]) // [4,5] - 1 = [3,4]
  })

  it('删除章节时同步重排 location.appear_chapters', () => {
    const chapters = store.listChapters(projectId)
    const ch3 = chapters.find((c) => c.chapterNumber === 3)!
    store.createLocation({
      id: randomUUID(),
      projectId,
      name: '酒馆',
      description: '',
      appearChapters: [1, 3, 5],
    })
    store.deleteChapter(ch3.id)
    const locations = store.listLocations(projectId)
    expect(locations[0].appearChapters).toEqual([1, 4]) // 3 被移除，5 → 4
  })
})
```

- [ ] **运行集成测试验证失败**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts
```
预期：FAIL，集成测试中 `deleteChapter` 后章节号未重排

### 步骤 1.6：修改 NovelStore.deleteChapter 集成重排

- [ ] **修改 deleteChapter 实现**

打开 `apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts`，找到 `deleteChapter` 方法（约 604 行），替换为：

```typescript
  deleteChapter(id: string): boolean {
    // 1. 读取章节信息（需要 projectId 和 chapterNumber 做重排）
    const chapter = this.getChapterById(id)
    if (!chapter) return false

    // 2. 删除与该章节关联的画布连线
    this.deleteEdgesByEntity(id)

    // 3. 删除章节行
    const result = this.db.prepare('DELETE FROM novel_chapters WHERE id = ?').run(id)
    if (result.changes === 0) return false

    // 4. 重排后续章节号（借鉴 PlotPilot ChapterRenumberSpec）
    //    使用事务保证原子性：要么全部重排成功，要么全部回滚
    const spec = createChapterRenumberSpec(chapter.chapterNumber)
    this.renumberChapterReferences(chapter.projectId, spec)

    return true
  }

  /**
   * 重排所有引用了 chapter_number 的字段
   * 按 CHAPTER_RENUMBER_FIELDS 常量遍历，逐表执行 UPDATE
   */
  private renumberChapterReferences(projectId: string, spec: ChapterRenumberSpec): void {
    const tx = this.db.transaction(() => {
      for (const field of CHAPTER_RENUMBER_FIELDS) {
        if (field.kind === 'scalar') {
          // 标量字段：大于被删章的 -1，等于被删章的设为 NULL（保留行，由调用方决定是否清除）
          if (field.column === 'chapter') {
            // novel_markers.chapter 不允许 NULL（NOT NULL DEFAULT 0），直接删除该 marker
            this.db.prepare(
              `DELETE FROM ${field.table} WHERE project_id = ? AND ${field.column} = ?`,
            ).run(projectId, spec.deletedChapter)
            this.db.prepare(
              `UPDATE ${field.table} SET ${field.column} = ${field.column} - 1 WHERE project_id = ? AND ${field.column} > ?`,
            ).run(projectId, spec.deletedChapter)
          } else {
            // 其他标量字段允许 NULL：先清除引用被删章的行（chapter_number 字段设为 NULL）
            this.db.prepare(
              `UPDATE ${field.table} SET ${field.column} = NULL WHERE ${field.column} = ? AND project_id = ?`,
            ).run(spec.deletedChapter, projectId)
            this.db.prepare(
              `UPDATE ${field.table} SET ${field.column} = ${field.column} - 1 WHERE ${field.column} IS NOT NULL AND ${field.column} > ? AND project_id = ?`,
            ).run(spec.deletedChapter, projectId)
          }
        } else if (field.kind === 'spans') {
          // JSON 跨度数组：用 json_each 展开逐段处理
          // 注意 better-sqlite3 不支持自定义 JS 函数，所以读取所有行 → JS 处理 → 逐行 UPDATE
          const rows = this.db.prepare(
            `SELECT id, ${field.column} AS spans FROM ${field.table} WHERE project_id = ?`,
          ).all(projectId) as Array<{ id: string; spans: string | null }>
          for (const row of rows) {
            if (!row.spans) continue
            try {
              const parsed = JSON.parse(row.spans) as Array<[number, number]>
              if (!Array.isArray(parsed)) continue
              const shifted = shiftChapterSpans(parsed, spec)
              this.db.prepare(
                `UPDATE ${field.table} SET ${field.column} = ? WHERE id = ?`,
              ).run(JSON.stringify(shifted), row.id)
            } catch {
              // JSON 解析失败，跳过
            }
          }
        } else if (field.kind === 'list') {
          // JSON 列表：同样读取所有行 → JS 处理 → 逐行 UPDATE
          const rows = this.db.prepare(
            `SELECT id, ${field.column} AS list FROM ${field.table} WHERE project_id = ?`,
          ).all(projectId) as Array<{ id: string; list: string }>
          for (const row of rows) {
            try {
              const parsed = JSON.parse(row.list) as number[]
              if (!Array.isArray(parsed)) continue
              const shifted = shiftChapterList(parsed, spec)
              this.db.prepare(
                `UPDATE ${field.table} SET ${field.column} = ? WHERE id = ?`,
              ).run(JSON.stringify(shifted), row.id)
            } catch {
              // JSON 解析失败，跳过
            }
          }
        }
      }
    })
    tx()
  }
```

在文件顶部 import 区追加：

```typescript
import { createChapterRenumberSpec, shiftChapterSpans, shiftChapterList, CHAPTER_RENUMBER_FIELDS } from './chapter-renumber.js'
import type { ChapterRenumberSpec } from './chapter-renumber.js'
```

- [ ] **运行测试验证通过**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts
```
预期：PASS（全部用例，包括集成测试）

- [ ] **运行 server typecheck**

```bash
cd apps/agent-server && pnpm exec tsc --noEmit
```
预期：无错误

### 步骤 1.7：运行现有测试确保无回归

- [ ] **运行相关测试**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-routes.test.ts src/__tests__/novel-store.test.ts src/__tests__/novel-marker-routes.test.ts
```
预期：PASS（已有的章节/marker 测试不应回归）

### 步骤 1.8：Commit

- [ ] **提交**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/chapter-renumber.ts \
        apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-renumber.test.ts \
        apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts
git commit -m "feat(novel): 章节删除时自动重排所有 chapter_number 引用

借鉴 PlotPilot ChapterRenumberSpec + json_walk 三层抽象：
- chapter-renumber.ts: 纯函数模块（标量/跨度/列表三类字段 shift）
- novel-store.ts: deleteChapter 调用 renumberChapterReferences，
  事务内重排 chapters/markers/character_history/memory_events/
  memory_snapshots/agent_logs/conflicts.chapter_spans/
  factions.chapter_spans/locations.appear_chapters

修复删除章节后章节号出现空洞的问题。"
```

---

## 任务 2：ClicheScanner 防 AI 腔正则库

**借鉴来源：** PlotPilot `application/audit/services/cliche_scanner.py`（35+ 正则 + hint 字段）

**为什么：** pi-agent 的 Writer 系统提示词已有 4 条风格规则（不用破折号、直接进入场景、止于画面、语言干净），但只是被动约束——LLM 是否遵守无法验证。Reviewer 当前只检查一致性/节奏/可读性，没有"AI 腔扫描"环节。借鉴 PlotPilot 的正则库 + hint 字段，让 Reviewer 拿到扫描结果后能给出具体修改建议（"第 3 段检测到'突然'滥用，建议改为…"）。

**文件：**
- 创建：`apps/agent-server/src/plugins/novel-plugin/core/cliche-scanner.ts`
- 创建：`apps/agent-server/src/plugins/novel-plugin/__tests__/cliche-scanner.test.ts`
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/prompts/role-reviewer.md`（增加扫描结果注入位说明）

### 步骤 2.1：编写失败的测试

- [ ] **编写测试**

创建 `apps/agent-server/src/plugins/novel-plugin/__tests__/cliche-scanner.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { scanCliches, ClicheScanner, type ClicheHit } from '../core/cliche-scanner.js'

describe('ClicheScanner - 防 AI 腔扫描', () => {
  it('空文本返回空数组', () => {
    expect(scanCliches('')).toEqual([])
  })

  it('检测滥用破折号"——"', () => {
    const text = '他抬头看天——乌云密布——雷声轰隆——'
    const hits = scanCliches(text)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const dashHit = hits.find((h) => h.pattern === 'em_dash_abuse')
    expect(dashHit).toBeDefined()
    expect(dashHit!.count).toBe(3)
    expect(dashHit!.hint).toContain('破折号')
  })

  it('检测"突然"滥用（出现 ≥ 2 次）', () => {
    const text = '突然，门开了。突然，他笑了。突然，风停了。'
    const hits = scanCliches(text)
    const suddenHit = hits.find((h) => h.pattern === 'sudden_adverb')
    expect(suddenHit).toBeDefined()
    expect(suddenHit!.count).toBe(3)
    expect(suddenHit!.hint).toContain('突然')
  })

  it('检测"然而"作为转折连词开头（出现 ≥ 2 次）', () => {
    const text = '然而他没有说话。然而她已经走远。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'however_conjunction')
    expect(hit).toBeDefined()
    expect(hit!.count).toBe(2)
  })

  it('检测"于是"过度使用', () => {
    const text = '于是他走了。于是她哭了。于是天黑了。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'so_conjunction')
    expect(hit).toBeDefined()
    expect(hit!.count).toBe(3)
  })

  it('检测"不由得""不禁"AI 总结腔', () => {
    const text = '他不禁感叹，这真是命运的安排。她不由得想起了从前。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'cant_help_but')
    expect(hit).toBeDefined()
    expect(hit!.count).toBeGreaterThanOrEqual(2)
  })

  it('检测"仿佛...一般"AI 比喻模板', () => {
    const text = '他的眼神仿佛寒冰一般冷。她的笑容仿佛春风一般温暖。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'simile_template')
    expect(hit).toBeDefined()
    expect(hit!.count).toBe(2)
  })

  it('检测"内心深处""灵魂深处"等陈词滥调', () => {
    const text = '在他内心深处，有一个声音在呼唤。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'deep_inside')
    expect(hit).toBeDefined()
  })

  it('检测章节末尾的总结性句子"就这样，...结束了"等', () => {
    const text = '就这样，他的一天结束了。这便是命运的安排。'
    const hits = scanCliches(text)
    const summaryHit = hits.find((h) => h.pattern === 'ending_summary')
    expect(summaryHit).toBeDefined()
  })

  it('单次出现"突然"不触发（阈值保护）', () => {
    const text = '突然，他停下了脚步。'
    const hits = scanCliches(text)
    expect(hits.find((h) => h.pattern === 'sudden_adverb')).toBeUndefined()
  })

  it('扫描结果含位置（hit.positions 含每个匹配的索引）', () => {
    const text = '突然他笑了。突然她哭了。'
    const hits = scanCliches(text)
    const hit = hits.find((h) => h.pattern === 'sudden_adverb')!
    expect(hit.positions.length).toBe(2)
    expect(text.substring(hit.positions[0])).toMatch(/突然/)
  })

  it('ClicheScanner 类实例可复用，结果一致', () => {
    const scanner = new ClicheScanner()
    const text = '突然，他走了。突然，她来了。'
    const r1 = scanner.scan(text)
    const r2 = scanner.scan(text)
    expect(r1).toEqual(r2)
  })

  it('formatClicheReport 把扫描结果格式化为 Reviewer 可读文本', () => {
    const hits: ClicheHit[] = [
      {
        pattern: 'sudden_adverb',
        name: '"突然"滥用',
        count: 3,
        positions: [0, 10, 20],
        hint: '建议改为更具体的动作描写或心理变化',
        severity: 'medium',
      },
    ]
    const report = formatClicheReport(hits)
    expect(report).toContain('防 AI 腔扫描')
    expect(report).toContain('"突然"滥用')
    expect(report).toContain('出现 3 次')
    expect(report).toContain('建议改为更具体的动作描写')
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/cliche-scanner.test.ts
```
预期：FAIL，模块不存在

### 步骤 2.2：实现 ClicheScanner

- [ ] **编写实现**

创建 `apps/agent-server/src/plugins/novel-plugin/core/cliche-scanner.ts`：

```typescript
/**
 * 防 AI 腔正则扫描器（借鉴 PlotPilot ClicheScanner）
 *
 * 与 Writer 系统提示词的 4 条风格规则对应：
 * 1. 不用"——"做转折 → em_dash_abuse
 * 2. 开头直接进入场景 → opening_scenery（开头纯风景描写，启发式）
 * 3. 结尾止于画面 → ending_summary
 * 4. 语言干净 → sudden_adverb/however_conjunction/so_conjunction
 *
 * 每个模式带 hint 字段，Reviewer 拿到扫描结果后可给出具体修改建议。
 *
 * 阈值设计：单次出现的"突然""然而"等是正常的（小说语言天然会有），
 * 只有滥用（出现 ≥ 2 次）才标记为 AI 腔。
 */

export type ClicheSeverity = 'low' | 'medium' | 'high'

export interface ClichePattern {
  /** 模式 ID（稳定，不随文案变化） */
  pattern: string
  /** 中文名称 */
  name: string
  /** 正则表达式（g 标志必须，用于全局匹配） */
  regex: RegExp
  /** 触发阈值（出现次数 >= 阈值才算命中，默认 1） */
  threshold: number
  /** 修复建议 */
  hint: string
  /** 严重程度 */
  severity: ClicheSeverity
}

export interface ClicheHit {
  pattern: string
  name: string
  count: number
  /** 每个匹配的起始索引 */
  positions: number[]
  hint: string
  severity: ClicheSeverity
}

const PATTERNS: ClichePattern[] = [
  {
    pattern: 'em_dash_abuse',
    name: '滥用破折号"——"',
    regex: /——/g,
    threshold: 1,
    hint: '不使用破折号做情节转折或插说。所有转折通过角色的行动、对话或心理变化自然完成。',
    severity: 'high',
  },
  {
    pattern: 'sudden_adverb',
    name: '"突然"滥用',
    regex: /突然[，,]?/g,
    threshold: 2,
    hint: '"突然"出现过于频繁，建议改为更具体的动作描写或心理变化。如"突然门开了"→"门吱呀一声推开"。',
    severity: 'medium',
  },
  {
    pattern: 'however_conjunction',
    name: '"然而"做转折开头',
    regex: /然而[，,]/g,
    threshold: 2,
    hint: '"然而"作为转折连词开头过于密集。建议改用角色行动或对话承载转折，如"她没有回头"。',
    severity: 'medium',
  },
  {
    pattern: 'so_conjunction',
    name: '"于是"过度使用',
    regex: /于是[，,]/g,
    threshold: 2,
    hint: '"于是"出现频繁。建议拆分为独立句子，用动作或时间推进替代。',
    severity: 'low',
  },
  {
    pattern: 'cant_help_but',
    name: '"不禁/不由得"AI 总结腔',
    regex: /(不禁|不由得|不由自主地)/g,
    threshold: 2,
    hint: '"不禁/不由得"是 AI 总结腔的常见标志。建议直接描写角色的具体动作或表情。',
    severity: 'medium',
  },
  {
    pattern: 'simile_template',
    name: '"仿佛...一般"AI 比喻模板',
    regex: /(仿佛|宛如|犹如)[^，。！？]{1,15}(一般|似的|一样)/g,
    threshold: 2,
    hint: '比喻句式过于工整。建议减少"仿佛...一般"模板，改用更直接的意象。',
    severity: 'low',
  },
  {
    pattern: 'deep_inside',
    name: '"内心深处"等陈词滥调',
    regex: /(内心深处|灵魂深处|心底深处|心底里)/g,
    threshold: 1,
    hint: '"内心深处"是 AI 常见的情感陈词滥调。建议改用具体动作或微表情承载情感。',
    severity: 'medium',
  },
  {
    pattern: 'ending_summary',
    name: '结尾总结性句子',
    regex: /(就这样[，,].{0,20}结束了|这便是.{0,15}安排|一切都.{0,10}尘埃落定|所有的.{0,10}都.{0,10}释然)/g,
    threshold: 1,
    hint: '结尾出现总结性句子。结尾应止于一个动作、一句对话或一个画面，绝不发表总结性、感悟性的句子。',
    severity: 'high',
  },
  {
    pattern: 'opening_scenery',
    name: '开头纯风景描写',
    regex: /^[^"「『]{0,5}(天|云|风|雨|月|日|阳光|夜色|山|水)/g,
    threshold: 1,
    hint: '开头可能为纯风景/环境描写。开头必须直接进入场景、动作或对话。',
    severity: 'medium',
  },
  {
    pattern: 'meta_narration',
    name: '元叙事评论',
    regex: /(读者|观众|故事|剧情|作者|笔锋|文字)/g,
    threshold: 2,
    hint: '元叙事评论（提及"读者/故事"等）破坏沉浸感。建议删除直接对读者的称呼。',
    severity: 'medium',
  },
  {
    pattern: 'purple_prose',
    name: '紫色散文（过度修饰）',
    regex: /(犹如|宛若|仿佛|恍若|好似|有如)/g,
    threshold: 3,
    hint: '比喻词密度过高。建议精简，仅保留最具表现力的比喻。',
    severity: 'low',
  },
]

export class ClicheScanner {
  private readonly patterns: ClichePattern[]

  constructor(patterns: ClichePattern[] = PATTERNS) {
    this.patterns = patterns
  }

  scan(text: string): ClicheHit[] {
    if (!text) return []
    const hits: ClicheHit[] = []
    for (const p of this.patterns) {
      // 重置 regex lastIndex（g 标志会保留状态）
      p.regex.lastIndex = 0
      const positions: number[] = []
      let match: RegExpExecArray | null
      while ((match = p.regex.exec(text)) !== null) {
        positions.push(match.index)
        // 防止零宽匹配死循环
        if (match.index === p.regex.lastIndex) p.regex.lastIndex++
      }
      if (positions.length >= p.threshold) {
        hits.push({
          pattern: p.pattern,
          name: p.name,
          count: positions.length,
          positions,
          hint: p.hint,
          severity: p.severity,
        })
      }
    }
    return hits
  }
}

const defaultScanner = new ClicheScanner()

export function scanCliches(text: string): ClicheHit[] {
  return defaultScanner.scan(text)
}

/**
 * 把扫描结果格式化为 Reviewer 可读的文本块
 * 用于注入 Reviewer 系统提示词或用户消息
 */
export function formatClicheReport(hits: ClicheHit[]): string {
  if (hits.length === 0) {
    return '【防 AI 腔扫描】未检测到明显的 AI 腔模式。'
  }
  const lines: string[] = ['【防 AI 腔扫描】检测到以下问题：']
  for (const hit of hits) {
    lines.push(
      `- ${hit.name}：出现 ${hit.count} 次（严重度：${hit.severity}）`,
    )
    lines.push(`  建议：${hit.hint}`)
  }
  return lines.join('\n')
}
```

- [ ] **运行测试验证通过**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/cliche-scanner.test.ts
```
预期：PASS（全部用例）

### 步骤 2.3：在 Reviewer 系统提示词中标注注入位

- [ ] **修改 role-reviewer.md**

打开 `apps/agent-server/src/plugins/novel-plugin/core/prompts/role-reviewer.md`，在文件末尾追加段落：

```markdown
## 防 AI 腔扫描结果

审稿时若收到 `【防 AI 腔扫描】` 开头的扫描报告，必须基于扫描结果给出具体修改建议：

- 每个命中模式都要在评审报告中列出
- 引用原文片段（前后各 20 字），让 Writer 知道具体在哪里
- 给出可直接替换的改写建议，不要说"建议修改"这种模糊话

示例输出格式：

```
【AI 腔问题】
1. "突然"滥用（出现 3 次，第 2/5/8 段）
   原文："突然，门开了。突然，他笑了。"
   建议：改为"门吱呀一声推开。他嘴角动了动，扯出一个笑。"
2. 滥用破折号"——"（出现 2 次，第 4 段）
   原文："他抬头——乌云密布——雷声轰隆"
   建议：拆分为独立短句，用动作衔接
```
```

- [ ] **运行 typecheck**

```bash
cd apps/agent-server && pnpm exec tsc --noEmit
```
预期：无错误

### 步骤 2.4：Commit

- [ ] **提交**

```bash
git add apps/agent-server/src/plugins/novel-plugin/core/cliche-scanner.ts \
        apps/agent-server/src/plugins/novel-plugin/__tests__/cliche-scanner.test.ts \
        apps/agent-server/src/plugins/novel-plugin/core/prompts/role-reviewer.md
git commit -m "feat(novel): 添加防 AI 腔正则扫描器（借鉴 PlotPilot ClicheScanner）

- cliche-scanner.ts: 11 个 AI 腔模式（破折号/突然/然而/于是/不禁/
  仿佛一般/内心深处/结尾总结/开头风景/元叙事/紫色散文），每个带 hint
  修复建议和严重度
- role-reviewer.md: 增加 Reviewer 系统提示词的扫描结果注入位说明
- formatClicheReport: 把扫描结果格式化为 Reviewer 可读文本

与 Writer 系统提示词的 4 条风格规则对应，从被动约束升级为可检测。"
```

---

## 任务 3：TensionLevel 章节张力曲线

**借鉴来源：** PlotPilot `domain/novel/value_objects/tension_level.py`（10 级非线性标度）

**为什么：** pi-agent 的 NovelConflict 已有 `intensity: 1-10`，但这是冲突烈度，不是章节张力曲线。张力是章节级的——一章可能有多个冲突交织，整体张力由节奏、冲突强度、信息差、角色情绪综合决定。PlotPilot 用 10 级非线性标度（LOW=1 → EXTREME=10），矩阵视图标尺根据张力渲染深浅色阶，让用户一眼看出"第 7 章是全书张力峰值"。

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`（追加 047 迁移）
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/types.ts`（NovelChapter 增加 tension 字段）
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts`（rowToChapter 读取、createChapter/updateChapter 写入 tension）
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`（updateChapterSchema 增加 tension 可选字段）
- 修改：`apps/desktop/src/renderer/src/api/novel-client.ts`（NovelChapter 增加 tension）
- 修改：`apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx`（标尺色阶）

### 步骤 3.1：编写迁移测试

- [ ] **追加测试到 chapter-routes.test.ts**

打开 `apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-routes.test.ts`，在文件末尾追加新的 describe 块：

```typescript
describe('PATCH /chapters/:id tension 字段', () => {
  let db: Database.Database
  let store: NovelStore
  let app: FastifyInstance
  let chapterId: string

  beforeEach(async () => {
    db = createTestDb()
    store = new NovelStore(db)
    const project = store.createProject({
      id: randomUUID(),
      title: '测试项目',
      genre: 'test',
      synopsis: '',
      targetWords: 0,
      currentVolume: 1,
      currentChapter: 0,
      currentStage: 'setup',
      status: 'active',
    })
    chapterId = randomUUID()
    store.createChapter({
      id: chapterId,
      projectId: project.id,
      volume: 1,
      chapterNumber: 1,
      title: '第一章',
      content: '',
      wordCount: 0,
      status: 'planned',
      narrativeTask: '',
      acceptanceResult: null,
    })
    app = await buildApp(store)
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  it('PATCH tension=8 后 GET 返回 tension=8', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 8 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.tension).toBe(8)

    const get = await app.inject({ method: 'GET', url: `/chapters/${chapterId}` })
    expect(get.json().data.tension).toBe(8)
  })

  it('不传 tension 时保持原值（不覆盖）', async () => {
    // 先设为 7
    await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 7 },
    })
    // 再 PATCH title，tension 应保持 7
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { title: '新标题' },
    })
    expect(res.json().data.tension).toBe(7)
  })

  it('tension 超出 1-10 范围时返回 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 11 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('tension=null 清除张力值', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: 5 },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/chapters/${chapterId}`,
      payload: { tension: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.tension).toBeNull()
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-routes.test.ts
```
预期：FAIL（tension 字段未定义）

### 步骤 3.2：追加迁移

- [ ] **修改 novel-migrations.ts**

打开 `apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts`，在最后一个迁移 `046_add_deleted_at_to_novel_projects` 后追加：

```typescript
  {
    // 047: 章节张力曲线（1-10，NULL 表示未设定）
    // 借鉴 PlotPilot TensionLevel：LOW=1 → EXTREME=10 非线性标度
    id: '047_add_tension_to_novel_chapters',
    sql: `ALTER TABLE novel_chapters ADD COLUMN tension INTEGER;`,
  },
```

- [ ] **运行测试验证部分通过**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-routes.test.ts
```
预期：仍 FAIL（类型与 schema 未更新）

### 步骤 3.3：更新类型定义

- [ ] **修改 types.ts**

打开 `apps/agent-server/src/plugins/novel-plugin/core/types.ts`，找到 `NovelChapter` 接口（约 100-130 行附近，搜索 `interface NovelChapter`），在 `acceptanceResult` 字段后追加：

```typescript
  /** 章节张力等级（1-10，NULL 表示未设定）
   *  借鉴 PlotPilot TensionLevel：1=LOW, 3-4=RISING, 5-6=ELEVATED,
   *  7-8=HIGH, 9=INTENSE, 10=EXTREME
   *  由 Director Agent 在规划时建议，或用户手动调整 */
  tension?: number | null
```

### 步骤 3.4：更新 NovelStore 读写 tension

- [ ] **修改 novel-store.ts**

在 `novel-store.ts` 中找到 `rowToChapter` 方法，添加 `tension` 字段读取。先 Grep 定位：

```bash
cd apps/agent-server && grep -n "rowToChapter" src/plugins/novel-plugin/core/novel-store.ts
```

找到 `rowToChapter` 方法后，在返回对象中添加 `tension: row.tension ?? null`。具体修改需根据实际代码结构，预期形如：

```typescript
  private rowToChapter(row: ChapterRow): NovelChapter {
    return {
      id: row.id,
      projectId: row.project_id,
      volume: row.volume,
      chapterNumber: row.chapter_number,
      title: row.title,
      content: row.content,
      wordCount: row.word_count,
      status: row.status,
      narrativeTask: row.narrative_task,
      acceptanceResult: row.acceptance_result ?? null,
      outline: row.outline ?? '',
      volumeId: row.volume_id ?? null,
      tension: row.tension ?? null,  // ← 新增
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
```

同时在 `ChapterRow` 类型中添加 `tension: number | null` 字段。

在 `createChapter` 方法中添加 `tension` 字段到 INSERT 语句：

```typescript
    this.db.prepare(`
      INSERT INTO novel_chapters (
        id, project_id, volume, chapter_number, title, content, word_count,
        status, narrative_task, outline, volume_id, tension, created_at, updated_at
      ) VALUES (
        @id, @project_id, @volume, @chapter_number, @title, @content, @word_count,
        @status, @narrative_task, @outline, @volume_id, @tension, @created_at, @updated_at
      )
    `).run({
      id: chapter.id, project_id: chapter.projectId, volume: chapter.volume,
      chapter_number: chapter.chapterNumber, title: chapter.title,
      content: chapter.content, word_count: chapter.wordCount,
      status: chapter.status, narrative_task: chapter.narrativeTask,
      outline: chapter.outline ?? '', volume_id: chapter.volumeId ?? null,
      tension: chapter.tension ?? null,  // ← 新增
      created_at: chapter.createdAt, updated_at: chapter.updatedAt,
    })
```

在 `updateChapter` 方法的 UPDATE 语句中添加 `tension` 字段（仅当 patch 中含 tension 时更新）：

```typescript
  updateChapter(id: string, patch: Partial<NovelChapter>): NovelChapter | undefined {
    const existing = this.getChapterById(id)
    if (!existing) return undefined
    const updated: NovelChapter = {
      ...existing,
      ...patch,
      updatedAt: now(),
    }
    this.db.prepare(`
      UPDATE novel_chapters SET title=@title, content=@content, word_count=@word_count,
      status=@status, narrative_task=@narrative_task, outline=@outline, volume_id=@volume_id,
      tension=@tension, updated_at=@updated_at
      WHERE id=@id
    `).run({
      id, title: updated.title, content: updated.content, word_count: updated.wordCount,
      status: updated.status, narrative_task: updated.narrativeTask,
      outline: updated.outline ?? '', volume_id: updated.volumeId ?? null,
      tension: updated.tension ?? null,  // ← 新增
      updated_at: updated.updatedAt,
    })
    return updated
  }
```

### 步骤 3.5：更新路由 schema

- [ ] **修改 novel-routes.ts**

打开 `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`，找到 `updateChapterSchema`（约 453 行）：

```typescript
  const updateChapterSchema = z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    status: z.enum(['planned', 'drafting', 'review', 'published', 'rejected']).optional(),
    outline: z.string().max(20000).optional(),
    volumeId: z.string().nullable().optional(),
    tension: z.number().int().min(1).max(10).nullable().optional(),  // ← 新增
  })
```

注意：根据项目约束 `PATCH 请求 schemas for markers must use .optional() without .default() to avoid overwriting existing values`，使用 `.optional()` 而不 `.default()`。

- [ ] **运行测试验证通过**

```bash
cd apps/agent-server && pnpm exec vitest run src/plugins/novel-plugin/__tests__/chapter-routes.test.ts
```
预期：PASS

### 步骤 3.6：更新前端类型

- [ ] **修改 novel-client.ts**

打开 `apps/desktop/src/renderer/src/api/novel-client.ts`，找到 `NovelChapter` interface，添加：

```typescript
  /** 章节张力等级（1-10，NULL 表示未设定） */
  tension?: number | null
```

- [ ] **运行 typecheck**

```bash
cd apps/desktop && pnpm exec tsc --noEmit
```
预期：无错误

### 步骤 3.7：编写前端矩阵色阶测试

- [ ] **追加测试**

在 `apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-logic.test.ts` 末尾追加：

```typescript
import { tensionToBgClass, tensionToLabel } from '../matrix-logic'

describe('TensionLevel 矩阵色阶', () => {
  it('tension=1 (LOW) 返回最浅色阶', () => {
    expect(tensionToBgClass(1)).toContain('bg-amber')
    expect(tensionToLabel(1)).toBe('LOW')
  })

  it('tension=10 (EXTREME) 返回最深色阶', () => {
    expect(tensionToBgClass(10)).toContain('bg-red')
    expect(tensionToLabel(10)).toBe('EXTREME')
  })

  it('tension=null/undefined 返回空字符串', () => {
    expect(tensionToBgClass(null)).toBe('')
    expect(tensionToBgClass(undefined)).toBe('')
    expect(tensionToLabel(null)).toBe('')
    expect(tensionToLabel(undefined)).toBe('')
  })

  it('tension 阶梯映射：1-3 浅色, 4-6 中色, 7-8 深色, 9-10 极深', () => {
    expect(tensionToBgClass(3)).toMatch(/bg-amber-100|bg-amber-200/)
    expect(tensionToBgClass(6)).toMatch(/bg-amber-300|bg-amber-400/)
    expect(tensionToBgClass(8)).toMatch(/bg-red-400|bg-red-500/)
    expect(tensionToBgClass(10)).toMatch(/bg-red-600|bg-red-700/)
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/desktop && pnpm exec vitest run src/renderer/src/components/novel/matrix/__tests__/matrix-logic.test.ts
```
预期：FAIL，`tensionToBgClass` / `tensionToLabel` 未导出

### 步骤 3.8：在 matrix-logic.ts 中实现色阶映射

- [ ] **修改 matrix-logic.ts**

打开 `apps/desktop/src/renderer/src/components/novel/matrix/matrix-logic.ts`，在文件末尾追加：

```typescript
// ── TensionLevel 色阶（借鉴 PlotPilot TensionLevel 10 级非线性标度）──
// 1-2 LOW      → bg-amber-100
// 3-4 RISING   → bg-amber-200
// 5-6 ELEVATED → bg-amber-300
// 7  HIGH      → bg-amber-500
// 8  HIGH+     → bg-red-400
// 9  INTENSE   → bg-red-500
// 10 EXTREME   → bg-red-600

const TENSION_BG_MAP: Record<number, string> = {
  1: 'bg-amber-100',
  2: 'bg-amber-100',
  3: 'bg-amber-200',
  4: 'bg-amber-200',
  5: 'bg-amber-300',
  6: 'bg-amber-300',
  7: 'bg-amber-500',
  8: 'bg-red-400',
  9: 'bg-red-500',
  10: 'bg-red-600',
}

const TENSION_LABEL_MAP: Record<number, string> = {
  1: 'LOW',
  2: 'LOW',
  3: 'RISING',
  4: 'RISING',
  5: 'ELEVATED',
  6: 'ELEVATED',
  7: 'HIGH',
  8: 'HIGH',
  9: 'INTENSE',
  10: 'EXTREME',
}

export function tensionToBgClass(tension: number | null | undefined): string {
  if (tension == null) return ''
  return TENSION_BG_MAP[tension] ?? ''
}

export function tensionToLabel(tension: number | null | undefined): string {
  if (tension == null) return ''
  return TENSION_LABEL_MAP[tension] ?? ''
}
```

- [ ] **运行测试验证通过**

```bash
cd apps/desktop && pnpm exec vitest run src/renderer/src/components/novel/matrix/__tests__/matrix-logic.test.ts
```
预期：PASS

### 步骤 3.9：在 MatrixView 标尺中渲染张力色阶

- [ ] **修改 matrix-view.tsx**

打开 `apps/desktop/src/renderer/src/renderer/src/components/novel/matrix/matrix-view.tsx`。

找到标尺行渲染部分（搜索 `sticky top-0 z-40 flex h-[44px]`），在章节标尺单元格中根据 `chapters.find(c => c.chapterNumber === col)?.tension` 渲染色阶背景：

```tsx
{/* 标尺行：每个章节单元格根据张力渲染色阶背景 */}
{visibleChapterColumns.map((col) => {
  const chapter = chapters.find((c) => c.chapterNumber === col)
  const tensionBg = chapter?.tension ? tensionToBgClass(chapter.tension) : ''
  const tensionLabel = chapter?.tension ? tensionToLabel(chapter.tension) : ''
  return (
    <div
      key={col}
      className={cn(
        'flex h-full w-[var(--cell-w)] flex-col items-center justify-center border-r border-border/50',
        tensionBg,
        playheadChapter === col && 'ring-2 ring-amber-500/40',
      )}
      style={{ width: `${cellWidth}px` }}
      onClick={() => handleRulerClick(col)}
      onContextMenu={(e) => handleRulerContextMenu(e, col)}
    >
      <span className="font-serif text-[11px] text-hint">{String(col).padStart(2, '0')}</span>
      {tensionLabel && (
        <span className="text-[9px] text-hint/70 mt-0.5">{tensionLabel}</span>
      )}
    </div>
  )
})}
```

在文件顶部 import 中追加：

```typescript
import { tensionToBgClass, tensionToLabel } from './matrix-logic'
```

注意：实际修改时需根据 matrix-view.tsx 现有的标尺渲染结构对齐（保持章节号竖排标题等现有逻辑），仅在单元格 className 中追加 `tensionBg`，并在标题下方追加 tensionLabel。

- [ ] **运行 typecheck**

```bash
cd apps/desktop && pnpm exec tsc --noEmit
```
预期：无错误

### 步骤 3.10：Commit

- [ ] **提交**

```bash
git add apps/agent-server/src/plugins/novel-plugin/novel-migrations.ts \
        apps/agent-server/src/plugins/novel-plugin/core/types.ts \
        apps/agent-server/src/plugins/novel-plugin/core/novel-store.ts \
        apps/agent-server/src/plugins/novel-plugin/novel-routes.ts \
        apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-routes.test.ts \
        apps/desktop/src/renderer/src/api/novel-client.ts \
        apps/desktop/src/renderer/src/components/novel/matrix/matrix-logic.ts \
        apps/desktop/src/renderer/src/components/novel/matrix/__tests__/matrix-logic.test.ts \
        apps/desktop/src/renderer/src/components/novel/matrix/matrix-view.tsx
git commit -m "feat(novel): 章节张力曲线（借鉴 PlotPilot TensionLevel）

- 047 迁移: novel_chapters 增加 tension INTEGER 字段
- types.ts/novel-store.ts/novel-routes.ts: tension 1-10 可选字段，
  PATCH 使用 .optional() 不带 .default() 避免覆盖
- 前端 NovelChapter 类型同步
- matrix-logic.ts: tensionToBgClass/tensionToLabel 10 级非线性色阶
  (LOW/RISING/ELEVATED/HIGH/INTENSE/EXTREME)
- matrix-view.tsx: 标尺单元格根据张力渲染深浅色阶 + 张力标签"
```

---

## 任务 4：runtimePerformance 集中式性能配置

**借鉴来源：** PlotPilot `frontend/src/config/performance.ts`（集中常量 + env 覆盖）

**为什么：** pi-agent 的性能数字散落多处：matrix onScroll 节流 100ms、SSE batch rAF、debounce 500ms、LLM 超时 300s、novel undo 历史 200 步等。没有集中管理导致调优需要全代码库搜索。PlotPilot 的做法是集中到一个文件，env 可覆盖。本任务只建基础设施，不强制迁移现有代码（避免大范围回归），让新代码引用、旧代码逐步迁移。

**文件：**
- 创建：`apps/agent-server/src/config/performance.ts`
- 创建：`apps/desktop/src/renderer/src/config/performance.ts`

### 步骤 4.1：编写后端测试

- [ ] **编写测试**

创建 `apps/agent-server/src/__tests__/performance.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runtimePerformance, reloadPerformanceFromEnv } from '../config/performance.js'

describe('runtimePerformance 后端配置', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // 清除可能的环境变量
    delete process.env.PI_LLM_TIMEOUT_MS
    delete process.env.PI_LLM_CIRCUIT_FAILURE_THRESHOLD
    delete process.env.PI_LLM_CIRCUIT_RESET_TIMEOUT_MS
    delete process.env.PI_SSE_BATCH_SIZE
    reloadPerformanceFromEnv()
  })

  afterEach(() => {
    // 恢复环境变量
    for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v
    reloadPerformanceFromEnv()
  })

  it('默认 LLM 超时 300s', () => {
    expect(runtimePerformance.llm.timeoutMs).toBe(300_000)
  })

  it('env PI_LLM_TIMEOUT_MS 可覆盖', () => {
    process.env.PI_LLM_TIMEOUT_MS = '600000'
    reloadPerformanceFromEnv()
    expect(runtimePerformance.llm.timeoutMs).toBe(600_000)
  })

  it('env 非法值回退到默认', () => {
    process.env.PI_LLM_TIMEOUT_MS = 'not-a-number'
    reloadPerformanceFromEnv()
    expect(runtimePerformance.llm.timeoutMs).toBe(300_000)
  })

  it('默认熔断阈值 5 次', () => {
    expect(runtimePerformance.llm.circuitBreaker.failureThreshold).toBe(5)
  })

  it('env PI_LLM_CIRCUIT_FAILURE_THRESHOLD 可覆盖', () => {
    process.env.PI_LLM_CIRCUIT_FAILURE_THRESHOLD = '10'
    reloadPerformanceFromEnv()
    expect(runtimePerformance.llm.circuitBreaker.failureThreshold).toBe(10)
  })

  it('默认熔断重置超时 120s', () => {
    expect(runtimePerformance.llm.circuitBreaker.resetTimeoutMs).toBe(120_000)
  })

  it('默认 SSE 节流 100ms', () => {
    expect(runtimePerformance.sse.throttleMs).toBe(100)
  })

  it('默认 SSE 队列上限 50', () => {
    expect(runtimePerformance.sse.maxQueueSize).toBe(50)
  })

  it('config 对象只读（运行时不允许直接赋值）', () => {
    expect(() => {
      // @ts-expect-error 测试只读
      runtimePerformance.llm.timeoutMs = 1000
    }).toThrow()
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/agent-server && pnpm exec vitest run src/__tests__/performance.test.ts
```
预期：FAIL，模块不存在

### 步骤 4.2：实现后端 performance 配置

- [ ] **编写实现**

创建 `apps/agent-server/src/config/performance.ts`：

```typescript
/**
 * 后端运行时性能配置（借鉴 PlotPilot frontend/src/config/performance.ts）
 *
 * 集中管理散落各处的性能数字：
 * - LLM 调用超时（默认 300s）
 * - 熔断器阈值（失败 5 次开路 120s）
 * - SSE 节流与队列上限
 *
 * 所有值可通过环境变量覆盖，便于调优和压测。
 * 环境变量命名约定：PI_<域>_<字段名> 大写下划线。
 */

interface LlmPerfConfig {
  /** LLM 调用超时（毫秒），默认 300s（与 Memory Agent 一致） */
  timeoutMs: number
  /** LLM 调用熔断器配置 */
  circuitBreaker: {
    /** 失败多少次后开路（默认 5） */
    failureThreshold: number
    /** 开路后多久尝试半开（毫秒，默认 120s） */
    resetTimeoutMs: number
  }
}

interface SsePerfConfig {
  /** SSE 事件节流（毫秒，默认 100ms） */
  throttleMs: number
  /** SSE 事件队列上限（默认 50，超出后丢弃最旧事件） */
  maxQueueSize: number
}

interface PersistencePerfConfig {
  /** SQLite 写入重试次数（默认 3） */
  writeRetryCount: number
  /** SQLite 写入重试退避基数（毫秒，默认 50） */
  writeRetryBackoffMs: number
}

export interface RuntimePerformanceConfig {
  readonly llm: LlmPerfConfig
  readonly sse: SsePerfConfig
  readonly persistence: PersistencePerfConfig
}

function readEnvInt(key: string, defaultValue: number): number {
  const v = process.env[key]
  if (v == null || v === '') return defaultValue
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n < 0) return defaultValue
  return n
}

function buildConfig(): RuntimePerformanceConfig {
  return {
    llm: {
      timeoutMs: readEnvInt('PI_LLM_TIMEOUT_MS', 300_000),
      circuitBreaker: {
        failureThreshold: readEnvInt('PI_LLM_CIRCUIT_FAILURE_THRESHOLD', 5),
        resetTimeoutMs: readEnvInt('PI_LLM_CIRCUIT_RESET_TIMEOUT_MS', 120_000),
      },
    },
    sse: {
      throttleMs: readEnvInt('PI_SSE_THROTTLE_MS', 100),
      maxQueueSize: readEnvInt('PI_SSE_MAX_QUEUE_SIZE', 50),
    },
    persistence: {
      writeRetryCount: readEnvInt('PI_SQLITE_WRITE_RETRY_COUNT', 3),
      writeRetryBackoffMs: readEnvInt('PI_SQLITE_WRITE_BACKOFF_MS', 50),
    },
  }
}

/** 深冻结对象，防止运行时被意外修改 */
function deepFreeze<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj
  for (const key of Object.keys(obj)) {
    const v = (obj as any)[key]
    if (typeof v === 'object' && v !== null) deepFreeze(v)
  }
  return Object.freeze(obj) as T
}

let cachedConfig: RuntimePerformanceConfig = deepFreeze(buildConfig())

/** 当前生效的运行时性能配置（只读） */
export const runtimePerformance: RuntimePerformanceConfig = cachedConfig

/**
 * 从环境变量重新加载配置
 * 用于测试或运行时热更新 env 后刷新
 */
export function reloadPerformanceFromEnv(): void {
  cachedConfig = deepFreeze(buildConfig())
  // 把 cachedConfig 的字段同步到导出的 runtimePerformance
  // 注意：因为对象被 deepFreeze，运行时是只读的；这里通过重新赋值内部对象实现"重载"
  // 但导出常量的引用不能变，所以用 Object.assign 覆盖字段（需要先解冻）
  Object.keys(cachedConfig).forEach((k) => {
    ;(runtimePerformance as any)[k] = (cachedConfig as any)[k]
  })
}
```

注意：由于 `runtimePerformance` 被 deepFreeze，测试中"运行时不允许直接赋值"会抛错。但 `reloadPerformanceFromEnv` 需要能更新值——这里通过先 `buildConfig` 再 `Object.assign` 覆盖字段实现。但 `Object.assign` 在 frozen 对象上会静默失败（非严格模式）或抛错（严格模式）。需要修改 reload 实现使用 Object.defineProperty 或先解冻再赋值再冻结。

修正后的 reload 实现：

```typescript
export function reloadPerformanceFromEnv(): void {
  const newConfig = deepFreeze(buildConfig())
  // 解冻当前对象，赋值，再冻结
  const unfrozen = { ...newConfig }
  Object.keys(unfrozen).forEach((k) => {
    Object.defineProperty(runtimePerformance, k, {
      value: (unfrozen as any)[k],
      writable: true,
      configurable: true,
      enumerable: true,
    })
  })
  Object.freeze(runtimePerformance)
}
```

更简洁的实现：把 runtimePerformance 设计为可重新赋值内部字段的对象，reload 时整体替换字段。最终版本如下（替换上面的实现）：

```typescript
export function reloadPerformanceFromEnv(): void {
  const newConfig = buildConfig()
  // 通过 Object.defineProperty 覆盖 frozen 对象的字段
  for (const key of Object.keys(newConfig) as Array<keyof RuntimePerformanceConfig>) {
    Object.defineProperty(runtimePerformance, key, {
      value: deepFreeze(newConfig[key]),
      writable: false,
      configurable: true,  // 允许下次 reload 再次覆盖
      enumerable: true,
    })
  }
}
```

- [ ] **运行测试验证通过**

```bash
cd apps/agent-server && pnpm exec vitest run src/__tests__/performance.test.ts
```
预期：PASS

### 步骤 4.3：编写前端测试

- [ ] **编写测试**

创建 `apps/desktop/src/renderer/src/__tests__/performance.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runtimePerformance, reloadPerformanceFromEnv } from '../config/performance'

describe('runtimePerformance 前端配置', () => {
  const originalImportMeta = import.meta.env

  beforeEach(() => {
    reloadPerformanceFromEnv()
  })

  afterEach(() => {
    reloadPerformanceFromEnv()
  })

  it('默认 matrix onScroll 节流 16ms（60fps）', () => {
    expect(runtimePerformance.matrix.scrollThrottleMs).toBe(16)
  })

  it('默认 SSE rAF batch 开启', () => {
    expect(runtimePerformance.sse.useRafBatching).toBe(true)
  })

  it('默认 debounce 500ms', () => {
    expect(runtimePerformance.editor.debounceMs).toBe(500)
  })

  it('默认 undo 历史栈上限 200', () => {
    expect(runtimePerformance.undo.historyLimit).toBe(200)
  })

  it('env VITE_MATRIX_SCROLL_THROTTLE_MS 可覆盖', () => {
    vi.stubEnv('VITE_MATRIX_SCROLL_THROTTLE_MS', '32')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.matrix.scrollThrottleMs).toBe(32)
    vi.unstubAllEnvs()
  })

  it('env 非法值回退默认', () => {
    vi.stubEnv('VITE_MATRIX_SCROLL_THROTTLE_MS', 'abc')
    reloadPerformanceFromEnv()
    expect(runtimePerformance.matrix.scrollThrottleMs).toBe(16)
    vi.unstubAllEnvs()
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/desktop && pnpm exec vitest run src/renderer/src/__tests__/performance.test.ts
```
预期：FAIL，模块不存在

### 步骤 4.4：实现前端 performance 配置

- [ ] **编写实现**

创建 `apps/desktop/src/renderer/src/config/performance.ts`：

```typescript
/**
 * 前端运行时性能配置（借鉴 PlotPilot frontend/src/config/performance.ts）
 *
 * 集中管理散落各处的性能数字：
 * - matrix onScroll 节流（默认 16ms = 60fps）
 * - SSE 流式 delta 累积是否用 rAF 批处理
 * - 编辑器 debounce（默认 500ms）
 * - Undo/Redo 历史栈上限（默认 200）
 *
 * env 覆盖使用 Vite 的 import.meta.env，前缀 VITE_。
 */

interface MatrixPerfConfig {
  /** onScroll 节流（毫秒，默认 16 = 60fps） */
  scrollThrottleMs: number
  /** 水平虚拟化 overscan（默认 3 列） */
  overscanColumns: number
}

interface SsePerfConfig {
  /** 是否使用 rAF 批处理 delta（默认 true） */
  useRafBatching: boolean
  /** 单帧累积 delta 上限（超出立即 flush，默认 256 字符） */
  rafFlushCharLimit: number
}

interface EditorPerfConfig {
  /** 编辑器 debounce（毫秒，默认 500） */
  debounceMs: number
}

interface UndoPerfConfig {
  /** Undo 历史栈上限（默认 200） */
  historyLimit: number
}

export interface RuntimePerformanceConfig {
  readonly matrix: MatrixPerfConfig
  readonly sse: SsePerfConfig
  readonly editor: EditorPerfConfig
  readonly undo: UndoPerfConfig
}

function readEnvInt(key: string, defaultValue: number): number {
  const v = import.meta.env[key]
  if (v == null || v === '') return defaultValue
  const n = Number.parseInt(String(v), 10)
  if (!Number.isFinite(n) || n < 0) return defaultValue
  return n
}

function readEnvBool(key: string, defaultValue: boolean): boolean {
  const v = import.meta.env[key]
  if (v == null || v === '') return defaultValue
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return defaultValue
}

function buildConfig(): RuntimePerformanceConfig {
  return {
    matrix: {
      scrollThrottleMs: readEnvInt('VITE_MATRIX_SCROLL_THROTTLE_MS', 16),
      overscanColumns: readEnvInt('VITE_MATRIX_OVERSCAN_COLUMNS', 3),
    },
    sse: {
      useRafBatching: readEnvBool('VITE_SSE_USE_RAF_BATCHING', true),
      rafFlushCharLimit: readEnvInt('VITE_SSE_RAF_FLUSH_CHAR_LIMIT', 256),
    },
    editor: {
      debounceMs: readEnvInt('VITE_EDITOR_DEBOUNCE_MS', 500),
    },
    undo: {
      historyLimit: readEnvInt('VITE_UNDO_HISTORY_LIMIT', 200),
    },
  }
}

function deepFreeze<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj
  for (const key of Object.keys(obj)) {
    const v = (obj as any)[key]
    if (typeof v === 'object' && v !== null) deepFreeze(v)
  }
  return Object.freeze(obj) as T
}

export const runtimePerformance: RuntimePerformanceConfig = deepFreeze(buildConfig())

export function reloadPerformanceFromEnv(): void {
  const newConfig = buildConfig()
  for (const key of Object.keys(newConfig) as Array<keyof RuntimePerformanceConfig>) {
    Object.defineProperty(runtimePerformance, key, {
      value: deepFreeze(newConfig[key]),
      writable: false,
      configurable: true,
      enumerable: true,
    })
  }
}
```

- [ ] **运行测试验证通过**

```bash
cd apps/desktop && pnpm exec vitest run src/renderer/src/__tests__/performance.test.ts
```
预期：PASS

### 步骤 4.5：Commit

- [ ] **提交**

```bash
git add apps/agent-server/src/config/performance.ts \
        apps/agent-server/src/__tests__/performance.test.ts \
        apps/desktop/src/renderer/src/config/performance.ts \
        apps/desktop/src/renderer/src/__tests__/performance.test.ts
git commit -m "feat: 集中式运行时性能配置（借鉴 PlotPilot runtimePerformance）

- 后端: apps/agent-server/src/config/performance.ts
  集中 LLM 超时(300s)/熔断阈值(5)/重置超时(120s)/
  SSE 节流(100ms)/队列上限(50)/SQLite 写入重试
  所有值支持 PI_* 环境变量覆盖，深度冻结防误改

- 前端: apps/desktop/src/renderer/src/config/performance.ts
  集中 matrix scroll 节流(16ms)/overscan(3)/
  SSE rAF batch/编辑器 debounce(500ms)/undo 历史(200)
  所有值支持 VITE_* 环境变量覆盖

本任务只建基础设施，不强制迁移现有代码（避免大范围回归），
新代码引用，旧代码逐步迁移。"
```

---

## 任务 5：CircuitBreaker 三态熔断器

**借鉴来源：** PlotPilot `application/engine/services/circuit_breaker.py`（CLOSED/OPEN/HALF_OPEN 三态，failure_threshold=5, reset_timeout=120s）

**为什么：** pi-agent 的 LLM 调用失败后没有熔断保护。当 Provider 故障（API 限流/服务不可用）时，会持续重试导致雪崩。PlotPilot 用三态熔断器：CLOSED 正常放行 → 失败累计达阈值 → OPEN 拒绝所有请求 → reset_timeout 后 HALF_OPEN 试探 → 成功则 CLOSED，失败则继续 OPEN。本任务实现熔断器并包装 NovelCharacterGenerator 作为示范。

**文件：**
- 创建：`apps/agent-server/src/core/agent/circuit-breaker.ts`
- 创建：`apps/agent-server/src/__tests__/circuit-breaker.test.ts`
- 修改：`apps/agent-server/src/plugins/novel-plugin/core/novel-character-generator.ts`（包装 generate 方法）

### 步骤 5.1：编写失败的测试

- [ ] **编写测试**

创建 `apps/agent-server/src/__tests__/circuit-breaker.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker, type CircuitBreakerOptions } from '../core/agent/circuit-breaker.js'

describe('CircuitBreaker 三态熔断器', () => {
  it('初始状态为 CLOSED', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 })
    expect(cb.state).toBe('closed')
    expect(cb.canExecute()).toBe(true)
  })

  it('失败次数未达阈值时保持 CLOSED', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('LLM 失败'))
    await expect(cb.execute(fail)).rejects.toThrow('LLM 失败')
    await expect(cb.execute(fail)).rejects.toThrow('LLM 失败')
    expect(cb.state).toBe('closed')
    expect(cb.stats.failures).toBe(2)
  })

  it('失败达阈值后切换为 OPEN，拒绝后续调用', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('LLM 失败'))
    // 失败 3 次
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    expect(cb.state).toBe('open')
    // 第 4 次调用应被熔断器拒绝（不实际调用 fn）
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(cb.execute(fn)).rejects.toThrow(/熔断器开路|circuit breaker is open/i)
    expect(fn).not.toHaveBeenCalled()
  })

  it('reset_timeout 后切换为 HALF_OPEN，允许一次试探调用', async () => {
    vi.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    expect(cb.state).toBe('open')

    // 推进时间 1s
    vi.advanceTimersByTime(1000)
    expect(cb.state).toBe('half_open')
    expect(cb.canExecute()).toBe(true)

    vi.useRealTimers()
  })

  it('HALF_OPEN 时试探成功 → CLOSED，重置失败计数', async () => {
    vi.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    vi.advanceTimersByTime(1000)
    expect(cb.state).toBe('half_open')

    const success = vi.fn().mockResolvedValue('ok')
    const result = await cb.execute(success)
    expect(result).toBe('ok')
    expect(cb.state).toBe('closed')
    expect(cb.stats.failures).toBe(0)

    vi.useRealTimers()
  })

  it('HALF_OPEN 时试探失败 → 回到 OPEN，重置计时', async () => {
    vi.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    vi.advanceTimersByTime(1000)
    expect(cb.state).toBe('half_open')

    // 试探再次失败
    await expect(cb.execute(fail)).rejects.toThrow()
    expect(cb.state).toBe('open')
    // 计时重置，需要再等 1s
    vi.advanceTimersByTime(999)
    expect(cb.state).toBe('open')
    vi.advanceTimersByTime(1)
    expect(cb.state).toBe('half_open')

    vi.useRealTimers()
  })

  it('成功调用重置失败计数（不累积历史失败）', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    const ok = vi.fn().mockResolvedValue('ok')

    await expect(cb.execute(fail)).rejects.toThrow()
    await expect(cb.execute(fail)).rejects.toThrow()
    expect(cb.stats.failures).toBe(2)
    await cb.execute(ok)
    expect(cb.stats.failures).toBe(0)
  })

  it('manualReset 手动重置为 CLOSED', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(fail)).rejects.toThrow()
    }
    expect(cb.state).toBe('open')
    cb.manualReset()
    expect(cb.state).toBe('closed')
    expect(cb.stats.failures).toBe(0)
  })

  it('stats 返回当前失败/成功/拒绝次数', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 })
    const fail = vi.fn().mockRejectedValue(new Error('失败'))
    const ok = vi.fn().mockResolvedValue('ok')

    await cb.execute(ok)
    await expect(cb.execute(fail)).rejects.toThrow()
    await expect(cb.execute(fail)).rejects.toThrow()
    // 第 3 次应被拒绝
    await expect(cb.execute(fail)).rejects.toThrow(/熔断器开路/i)

    expect(cb.stats).toEqual({
      successes: 1,
      failures: 2,
      rejections: 1,
      state: 'open',
    })
  })

  it('从 runtimePerformance 读取默认配置（与配置模块联动）', () => {
    const cb = new CircuitBreaker()
    expect(cb.options.failureThreshold).toBe(5)
    expect(cb.options.resetTimeoutMs).toBe(120_000)
  })
})
```

- [ ] **运行测试验证失败**

```bash
cd apps/agent-server && pnpm exec vitest run src/__tests__/circuit-breaker.test.ts
```
预期：FAIL，模块不存在

### 步骤 5.2：实现 CircuitBreaker

- [ ] **编写实现**

创建 `apps/agent-server/src/core/agent/circuit-breaker.ts`：

```typescript
/**
 * 三态熔断器（借鉴 PlotPilot CircuitBreaker）
 *
 * 状态机：
 *   CLOSED → 失败累计达阈值 → OPEN
 *   OPEN → reset_timeout → HALF_OPEN
 *   HALF_OPEN → 试探成功 → CLOSED（重置计数）
 *   HALF_OPEN → 试探失败 → OPEN（重置计时）
 *
 * CLOSED：正常放行所有请求，记录成功/失败
 * OPEN：拒绝所有请求（直接抛错，不实际调用 fn）
 * HALF_OPEN：仅允许一次试探调用，结果决定回到 CLOSED 还是 OPEN
 *
 * 默认配置从 runtimePerformance 读取，支持运行时通过 env 调整。
 */

import { runtimePerformance } from '../../config/performance.js'

export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerOptions {
  /** 失败多少次后开路（默认从 runtimePerformance 读取） */
  failureThreshold?: number
  /** 开路后多久尝试半开（毫秒，默认从 runtimePerformance 读取） */
  resetTimeoutMs?: number
  /** 判定异常是否算失败（默认所有 rejected 都算） */
  shouldTrip?: (err: unknown) => boolean
}

export interface CircuitBreakerStats {
  successes: number
  failures: number
  rejections: number
  state: CircuitBreakerState
}

export class CircuitBreaker {
  readonly options: Required<Omit<CircuitBreakerOptions, 'shouldTrip'>>
  private _state: CircuitBreakerState = 'closed'
  private failureCount = 0
  private successCount = 0
  private rejectionCount = 0
  private lastFailureAt = 0
  private readonly shouldTrip: (err: unknown) => boolean

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = {
      failureThreshold:
        options.failureThreshold ?? runtimePerformance.llm.circuitBreaker.failureThreshold,
      resetTimeoutMs:
        options.resetTimeoutMs ?? runtimePerformance.llm.circuitBreaker.resetTimeoutMs,
    }
    this.shouldTrip = options.shouldTrip ?? (() => true)
  }

  get state(): CircuitBreakerState {
    this.maybeTransitionToHalfOpen()
    return this._state
  }

  get stats(): CircuitBreakerStats {
    return {
      successes: this.successCount,
      failures: this.failureCount,
      rejections: this.rejectionCount,
      state: this.state,
    }
  }

  /** 当前是否允许调用 fn（CLOSED 或 HALF_OPEN 时为 true） */
  canExecute(): boolean {
    return this.state !== 'open'
  }

  /**
   * 执行 fn，根据结果更新状态
   * - CLOSED：执行 fn，成功重置失败计数，失败累计
   * - OPEN：直接 reject（不调用 fn），rejectionCount++
   * - HALF_OPEN：执行 fn，成功 → CLOSED，失败 → OPEN
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      this.rejectionCount++
      throw new Error('熔断器开路：拒绝调用（circuit breaker is open）')
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      if (this.shouldTrip(err)) {
        this.onFailure()
      }
      throw err
    }
  }

  private onSuccess(): void {
    this.successCount++
    if (this._state === 'half_open') {
      // 试探成功 → CLOSED，重置计数
      this._state = 'closed'
      this.failureCount = 0
    } else if (this._state === 'closed') {
      // CLOSED 状态下成功重置失败计数（不累积历史失败）
      this.failureCount = 0
    }
  }

  private onFailure(): void {
    this.lastFailureAt = Date.now()
    this.failureCount++
    if (this._state === 'half_open') {
      // 试探失败 → 回到 OPEN
      this._state = 'open'
    } else if (this._state === 'closed' && this.failureCount >= this.options.failureThreshold) {
      this._state = 'open'
    }
  }

  /** 检查是否到了从 OPEN 转 HALF_OPEN 的时间 */
  private maybeTransitionToHalfOpen(): void {
    if (this._state !== 'open') return
    const elapsed = Date.now() - this.lastFailureAt
    if (elapsed >= this.options.resetTimeoutMs) {
      this._state = 'half_open'
    }
  }

  /** 手动重置为 CLOSED（管理员/调试用） */
  manualReset(): void {
    this._state = 'closed'
    this.failureCount = 0
    this.lastFailureAt = 0
  }
}
```

- [ ] **运行测试验证通过**

```bash
cd apps/agent-server && pnpm exec vitest run src/__tests__/circuit-breaker.test.ts
```
预期：PASS（全部 11 个用例）

### 步骤 5.3：在 NovelCharacterGenerator 中包装示范

- [ ] **修改 novel-character-generator.ts**

打开 `apps/agent-server/src/plugins/novel-plugin/core/novel-character-generator.ts`，在类构造函数中注入 CircuitBreaker 实例（默认从全局取），并在 `generate` 方法中包装 `session.promptStream` 调用。

在文件顶部 import：

```typescript
import { CircuitBreaker } from '../../../core/agent/circuit-breaker.js'
```

修改类定义（约 41-46 行）：

```typescript
export class NovelCharacterGenerator {
  /** LLM 调用熔断器（实例级，所有 generate 调用共享） */
  private readonly circuitBreaker: CircuitBreaker

  constructor(
    private promptBuilder: NovelPromptBuilder,
    private promptManager: PromptManager,
    private context: PluginContext,
    circuitBreaker?: CircuitBreaker,
  ) {
    // 未注入则使用默认配置（从 runtimePerformance 读取阈值）
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker()
  }
```

修改 `generate` 方法（约 80-100 行）中调用 `session.promptStream` 的部分，用 `circuitBreaker.execute` 包装：

```typescript
    try {
      // 用熔断器包装 LLM 调用：连续失败时熔断，避免雪崩
      const result = await this.circuitBreaker.execute(async () => {
        // 使用 promptStream 实现真正的流式推送：
        // 每收到一段 text_delta 就通过 onProgress 推送给前端
        let streamedText = ''
        let lastEmitTs = 0
        return await session.promptStream((delta) => {
          streamedText += delta
          // 节流：每 500ms 最多发一次进度
          const now = Date.now()
          if (now - lastEmitTs < 500) return
          lastEmitTs = now
          const partial = streamedText.slice(-200)
          onProgress?.({
            phase: 'generating',
            message: 'AI 正在生成角色设定...',
            data: { partial },
          })
        })
      })
      this.context.logger.info(
        {
          projectId,
          coreStylePreview: coreStyle.slice(0, 80),
          resultLength: result.length,
          circuitBreakerState: this.circuitBreaker.state,
        },
        '角色生成 LLM 调用完成',
      )
      onProgress?.({
        phase: 'parsing',
        message: '正在解析生成结果...',
        data: { resultLength: result.length },
      })
      // ── 4. 解析 LLM 返回的 JSON ──
      const character = this.parseCharacterJson(result, coreStyle)
      onProgress?.({
        phase: 'completed',
        message: '角色生成完成',
        data: { name: character.name },
      })
      return character
    } catch (err) {
      // 熔断器开路时给出明确错误信息
      if (err instanceof Error && /熔断器开路/.test(err.message)) {
        this.context.logger.warn(
          { projectId, circuitBreakerState: this.circuitBreaker.state },
          '角色生成被熔断器拒绝',
        )
        onProgress?.({
          phase: 'fallback',
          message: 'AI 服务暂时不可用（熔断器开路），请稍后重试',
        })
      }
      throw err
    }
```

- [ ] **运行 typecheck**

```bash
cd apps/agent-server && pnpm exec tsc --noEmit
```
预期：无错误

### 步骤 5.4：运行相关测试确保无回归

- [ ] **运行测试**

```bash
cd apps/agent-server && pnpm exec vitest run src/__tests__/circuit-breaker.test.ts src/__tests__/performance.test.ts
```
预期：PASS

### 步骤 5.5：Commit

- [ ] **提交**

```bash
git add apps/agent-server/src/core/agent/circuit-breaker.ts \
        apps/agent-server/src/__tests__/circuit-breaker.test.ts \
        apps/agent-server/src/plugins/novel-plugin/core/novel-character-generator.ts
git commit -m "feat: 三态熔断器（借鉴 PlotPilot CircuitBreaker）

- circuit-breaker.ts: CLOSED/OPEN/HALF_OPEN 状态机
  默认阈值从 runtimePerformance 读取（5 次失败，120s 重置）
  支持 shouldTrip 自定义判定、manualReset 手动重置、stats 监控
- novel-character-generator.ts: 用熔断器包装 session.promptStream
  作为熔断器使用示范，连续失败时拒绝调用避免雪崩
  熔断时通过 onProgress 通知前端'AI 服务暂时不可用'

修复 LLM Provider 故障时持续重试导致雪崩的问题。"
```

---

## 自检

### 规格覆盖度

- **借鉴 PlotPilot 5 项推荐**：任务 1（ChapterRenumberSpec）、任务 2（ClicheScanner）、任务 3（TensionLevel）、任务 4（runtimePerformance）、任务 5（CircuitBreaker）—— 全部覆盖。
- **TDD**：每个任务都先写测试（红）再实现（绿）。
- **不破坏现有功能**：任务 1.7 验证 chapter-routes 测试无回归；任务 3 的迁移使用 IF NOT EXISTS / ALTER TABLE ADD COLUMN（幂等可重入）。

### 占位符扫描

- 无"待定" / "TODO" / "后续实现"。
- 每个步骤都有完整代码或精确命令。
- 测试断言使用具体数值（`toBe(8)`, `toEqual([[1,4]])`）。

### 类型一致性

- `ChapterRenumberSpec` 在 `chapter-renumber.ts` 定义，在 `novel-store.ts` 引用 —— 一致。
- `ClicheHit` 在 `cliche-scanner.ts` 定义，测试中 import —— 一致。
- `tensionToBgClass` / `tensionToLabel` 在 `matrix-logic.ts` 定义，在 `matrix-view.tsx` 和测试中引用 —— 一致。
- `runtimePerformance` 在前后端各一份独立 config，类型定义在各自文件中 —— 一致。
- `CircuitBreaker` 在 `circuit-breaker.ts` 定义，在 `novel-character-generator.ts` 引用 —— 一致。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-07-04-plotpilot-borrow.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
