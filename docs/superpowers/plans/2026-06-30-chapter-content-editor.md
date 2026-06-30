# 章节正文编辑器 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在时间线编辑视图上方新增 Tiptap 富文本章节正文编辑器，与时间线垂直分割、播放头单向联动、防抖自动保存。

**架构：** `playheadChapter` 从 timeline workspace 局部 state 提升到 Zustand store；新建 `ChapterContentEditor` 组件订阅它；`novel-workspace.tsx` 主内容区用现有 `ResizableSplitter direction="vertical"` 做上下分割；复用 `PATCH /chapters/:id` 路由（后端补 wordCount 自动重算）。

**技术栈：** React 19 + Zustand 5 + Tiptap 2 + tiptap-markdown + Fastify + better-sqlite3

**关联规格：** [docs/superpowers/specs/2026-06-30-chapter-content-editor-design.md](file:///d:/WebWork/AI/pi-agent/docs/superpowers/specs/2026-06-30-chapter-content-editor-design.md)

---

## 文件结构

**新建：**
- `apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx` — 正文编辑器主组件（Tiptap + 工具栏 + 联动 + 保存）
- `apps/desktop/src/renderer/src/lib/novel-utils.ts` — 共享工具（`countWords` 抽取）
- `apps/desktop/src/renderer/src/components/novel/chapter-content-editor.css` — 编辑器样式（对齐 timeline-styles.css 主题变量）
- `apps/desktop/src/renderer/src/__tests__/novel-utils.test.ts` — countWords 单元测试
- `apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-routes.test.ts` — wordCount 重算路由测试（若不存在则新建）

**修改：**
- `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` — PATCH /chapters/:id 路由，传 content 时自动重算 wordCount
- `apps/desktop/src/renderer/src/stores/novel-store.ts` — 新增 `playheadChapter` + `setPlayheadChapter`，`partialize` 排除
- `apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx` — 删局部 `useState(1)`，换 store selector + action
- `apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx` — `countWords` 改为引用共享工具
- `apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx` — 主内容区改为垂直分割，透传创作流程 props
- `apps/desktop/package.json` — 新增 Tiptap 依赖

---

## 任务 1：后端 PATCH /chapters/:id 自动重算 wordCount

**文件：**
- 修改：`apps/agent-server/src/plugins/novel-plugin/novel-routes.ts`（PATCH /chapters/:id handler，约 296-307 行）
- 测试：`apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-routes.test.ts`（若不存在则新建）

**背景：** `store.updateChapter` 是 spread patch，传 `{content}` 不带 `wordCount` 时保留旧值。正文编辑器只传 content，需要路由层自动重算。

- [ ] **步骤 1：编写失败的测试**

新建测试文件（若不存在）`apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-routes.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { registerNovelPlugin } from '../index'

describe('PATCH /chapters/:id', () => {
  let app: any
  let projectId: string
  let chapterId: string

  beforeEach(async () => {
    app = Fastify()
    await registerNovelPlugin(app)
    await app.ready()
    // 创建测试项目 + 章节
    const project = await app.inject({ method: 'POST', url: '/api/novel/projects', payload: { title: '测试', genre: 'test' } })
    projectId = JSON.parse(project.body).data.id
    const chapter = await app.inject({
      method: 'POST', url: `/api/novel/projects/${projectId}/chapters`,
      payload: { chapterNumber: 1, narrativeTask: { description: 't', type: 'advance_mainline', priority: 'medium' } },
    })
    chapterId = JSON.parse(chapter.body).data.id
  })

  afterEach(async () => { await app.close() })

  it('传 content 时自动重算 wordCount', async () => {
    const content = '这是测试正文内容共十个字'
    const res = await app.inject({
      method: 'PATCH', url: `/api/novel/chapters/${chapterId}`,
      payload: { content },
    })
    const body = JSON.parse(res.body)
    expect(body.data.content).toBe(content)
    expect(body.data.wordCount).toBe(10)
  })

  it('不传 content 时 wordCount 保持不变', async () => {
    // 先传一次 content 设置 wordCount
    await app.inject({
      method: 'PATCH', url: `/api/novel/chapters/${chapterId}`,
      payload: { content: '十个字的测试正文内容' },
    })
    // 再只改 title
    const res = await app.inject({
      method: 'PATCH', url: `/api/novel/chapters/${chapterId}`,
      payload: { title: '新标题' },
    })
    const body = JSON.parse(res.body)
    expect(body.data.title).toBe('新标题')
    expect(body.data.wordCount).toBe(10)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter agent-server test chapter-routes`
预期：FAIL，wordCount 为 0 或旧值（未重算）

- [ ] **步骤 3：实现路由层 wordCount 重算**

修改 `apps/agent-server/src/plugins/novel-plugin/novel-routes.ts` PATCH /chapters/:id handler：

```typescript
routes.push({
  method: 'PATCH',
  path: '/chapters/:id',
  handler: async (request: any, reply: any) => {
    const input = validateBody(updateChapterSchema, request, reply)
    if (!input) return reply

    // 传 content 时自动重算 wordCount（与 store.updateChapterContent 一致的中文字符计数）
    let patch = input
    if (input.content != null) {
      const cleaned = input.content.replace(/[#*`>\-\[\]()!]/g, '').replace(/\s+/g, '')
      patch = { ...input, wordCount: cleaned.length }
    }

    const updated = store.updateChapter(request.params.id, patch)
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND, `章节不存在: ${request.params.id}`, 404)
    return success(updated, request.traceId)
  },
})
```

注意：`countWords` 逻辑与前端 [chapter-live-view.tsx#L63-L68](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx#L63) 一致（去 Markdown 标记后按字符计数），任务 2 会把前端逻辑抽到共享工具，后端此处暂时内联（避免跨端共享 TS 文件结构改动过大）。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter agent-server test chapter-routes`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/plugins/novel-plugin/novel-routes.ts apps/agent-server/src/plugins/novel-plugin/__tests__/chapter-routes.test.ts
git commit -m "feat(novel): auto-recompute wordCount on chapter content PATCH"
```

---

## 任务 2：抽取 countWords 共享工具

**文件：**
- 创建：`apps/desktop/src/renderer/src/lib/novel-utils.ts`
- 测试：`apps/desktop/src/renderer/src/__tests__/novel-utils.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx`（第 63-68 行）

- [ ] **步骤 1：编写失败的测试**

创建 `apps/desktop/src/renderer/src/__tests__/novel-utils.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { countWords } from '@/lib/novel-utils'

describe('countWords', () => {
  it('空字符串返回 0', () => {
    expect(countWords('')).toBe(0)
  })

  it('纯中文按字符计数', () => {
    expect(countWords('这是十个字的测试正文')).toBe(10)
  })

  it('去除 Markdown 标记后计数', () => {
    expect(countWords('# 标题\n**粗体**内容')).toBe(7) // "标题粗体内容"
  })

  it('去除空白后计数', () => {
    expect(countWords('第一段\n\n第二段')).toBe(5) // "第一段第二段"
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter desktop test novel-utils`
预期：FAIL，模块不存在

- [ ] **步骤 3：创建共享工具**

创建 `apps/desktop/src/renderer/src/lib/novel-utils.ts`：

```typescript
/**
 * 计算中文字数（按字符计）
 * 去除空白与 Markdown 标记后按字符计数。
 * 与后端 novel-routes.ts PATCH /chapters/:id 的 wordCount 重算逻辑保持一致。
 */
export function countWords(text: string): number {
  if (!text) return 0
  const cleaned = text.replace(/[#*`>\-\[\]()!]/g, '').replace(/\s+/g, '')
  return cleaned.length
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter desktop test novel-utils`
预期：PASS

- [ ] **步骤 5：替换 chapter-live-view.tsx 的本地实现**

修改 `apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx`：

删除第 63-68 行的本地 `countWords` 函数，在文件顶部 import 区加：

```typescript
import { countWords } from '@/lib/novel-utils'
```

- [ ] **步骤 6：运行 desktop 全部测试验证无回归**

运行：`pnpm --filter desktop test`
预期：全部 PASS

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop/src/renderer/src/lib/novel-utils.ts apps/desktop/src/renderer/src/__tests__/novel-utils.test.ts apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx
git commit -m "refactor(novel): extract countWords to shared util"
```

---

## 任务 3：store 添加 playheadChapter

**文件：**
- 修改：`apps/desktop/src/renderer/src/stores/novel-store.ts`

- [ ] **步骤 1：编写失败的测试**

在 `apps/desktop/src/renderer/src/__tests__/novel-store.test.ts`（若不存在则新建）添加：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useNovelStore } from '@/stores/novel-store'

describe('novel-store playheadChapter', () => {
  beforeEach(() => { useNovelStore.getState().clearProjectData() })

  it('初始值为 1', () => {
    expect(useNovelStore.getState().playheadChapter).toBe(1)
  })

  it('setPlayheadChapter 更新值', () => {
    useNovelStore.getState().setPlayheadChapter(5)
    expect(useNovelStore.getState().playheadChapter).toBe(5)
  })

  it('不在持久化中（clearProjectData 后重置为 1）', () => {
    useNovelStore.getState().setPlayheadChapter(8)
    useNovelStore.getState().clearProjectData()
    expect(useNovelStore.getState().playheadChapter).toBe(1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter desktop test novel-store`
预期：FAIL，`playheadChapter` undefined

- [ ] **步骤 3：在 store 添加字段与 action**

修改 `apps/desktop/src/renderer/src/stores/novel-store.ts`：

在 `NovelState` interface 的 `viewMode` 字段后添加（约第 67 行后）：

```typescript
  // ── 播放头章节（时间线与正文编辑器共享，不持久化）──
  playheadChapter: number
```

在 `setViewMode` action 后添加：

```typescript
  setPlayheadChapter: (chapter: number) => void
```

在 store 创建函数的 `set` 实现区，`setViewMode` 实现后添加（约对应位置）：

```typescript
  setPlayheadChapter: (chapter) => set({ playheadChapter: chapter }),
```

在 store 初始 state 对象中，`viewMode: 'timeline'` 后添加：

```typescript
  playheadChapter: 1,
```

在 `clearProjectData` 实现中追加重置：

```typescript
  clearProjectData: () => set({
    // ... 现有字段保持 ...
    playheadChapter: 1,
  }),
```

在 `partialize` 配置中确认 `playheadChapter` 被排除（partialize 只列出要持久化的字段，playheadChapter 不列入即排除）。检查现有 `partialize` 实现，确保它**显式列出**要持久化的字段而非排除某些字段——若为显式列举模式，无需改动；若为"全包含然后删除"模式，需在删除列表加 `playheadChapter`。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter desktop test novel-store`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/stores/novel-store.ts apps/desktop/src/renderer/src/__tests__/novel-store.test.ts
git commit -m "feat(novel): add playheadChapter to store for cross-component sync"
```

---

## 任务 4：timeline workspace 改用 store 的 playheadChapter

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx`（第 129 行附近）

**目的：** 让正文编辑器能订阅播放头，必须先提升状态归属。

- [ ] **步骤 1：定位现有局部 state**

读 `apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx` 第 129 行：

```typescript
const [playheadChapter, setPlayheadChapter] = useState(1)
```

- [ ] **步骤 2：替换为 store selector + action**

将第 129 行替换为：

```typescript
const playheadChapter = useNovelStore((s) => s.playheadChapter)
const setPlayheadChapter = useNovelStore((s) => s.setPlayheadChapter)
```

确认 `useNovelStore` 已在文件顶部 import（应已存在，因该文件已用 store 订阅其他字段）。

- [ ] **步骤 3：移除未使用的 useState import（若需要）**

检查文件顶部 `import { useState } from 'react'`，若 `useState` 仍被其他状态使用（如 `isPlaying`、`activeTool` 等）则保留；若移除 `playheadChapter` 后 `useState` 不再使用，则从 import 中删除。

- [ ] **步骤 4：手动验证时间线功能不退化**

启动 desktop 应用，进入小说工作台时间轴视图：
- 播放头在第 1 章
- 点播放按钮，播放头逐章前进
- 点上一章/下一章/首章/末章按钮
- 拖动播放头
- 章节右键菜单跳转

预期：所有功能与改动前一致。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx
git commit -m "refactor(novel): lift playheadChapter from timeline workspace to store"
```

---

## 任务 5：安装 Tiptap 依赖

**文件：**
- 修改：`apps/desktop/package.json`

- [ ] **步骤 1：安装依赖**

运行：

```bash
pnpm --filter desktop add @tiptap/react @tiptap/starter-kit @tiptap/pm tiptap-markdown
```

- [ ] **步骤 2：验证安装成功**

运行：`pnpm --filter desktop list @tiptap/react tiptap-markdown`
预期：列出已安装版本

- [ ] **步骤 3：验证 TypeScript 编译无类型错误**

运行：`pnpm --filter desktop typecheck`（若无该 script，运行 `pnpm --filter desktop exec tsc --noEmit`）
预期：无新增错误

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "build(novel): add Tiptap dependencies for chapter content editor"
```

---

## 任务 6：ChapterContentEditor 组件 - 基础结构与保存逻辑

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx`
- 创建：`apps/desktop/src/renderer/src/components/novel/chapter-content-editor.css`

**注意：** 本任务只实现"编辑 + 防抖保存 + 章节切换联动"核心闭环，工具栏与创作流程协作留到任务 7、8。

- [ ] **步骤 1：创建编辑器组件骨架**

创建 `apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx`：

```typescript
/**
 * 章节正文编辑器
 *
 * - 位于时间线编辑器上方，垂直可拖拽分割
 * - 单向订阅 store.playheadChapter：播放头移动 → 加载对应章节正文
 * - 编辑器内章节导航通过 setPlayheadChapter 间接驱动（符合"播放头驱动"语义）
 * - 1.5s 防抖自动保存，章节切换/卸载时强制落库
 * - 创作流程激活时进入只读模式，显示流式内容
 */

import { useEffect, useRef, useState, useCallback, type ReactElement } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { useNovelStore } from '@/stores/novel-store'
import { updateChapter } from '@/api/novel-client'
import { countWords } from '@/lib/novel-utils'
import './chapter-content-editor.css'

export interface ChapterContentEditorProps {
  /** 创作流程是否激活（运行中或非 idle 阶段） */
  isCreationActive: boolean
  /** 创作流程当前章节号 */
  creationChapterNumber?: number
  /** 创作流程实时正文（只读模式下显示） */
  creationChapterContent?: string
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

export function ChapterContentEditor({
  isCreationActive,
  creationChapterNumber,
  creationChapterContent,
}: ChapterContentEditorProps): ReactElement {
  const playheadChapter = useNovelStore((s) => s.playheadChapter)
  const setPlayheadChapter = useNovelStore((s) => s.setPlayheadChapter)
  const chapters = useNovelStore((s) => s.chapters)
  const upsertChapter = useNovelStore((s) => s.upsertChapter)

  const [draftContent, setDraftContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // 避免 stale closure：保存逻辑读 ref 而非 state
  const saveStateRef = useRef<SaveState>('saved')
  saveStateRef.current = saveState
  const draftContentRef = useRef('')
  draftContentRef.current = draftContent

  // 记录当前加载的章节 id，避免 content 变化触发重载循环
  const loadedChapterIdRef = useRef<string | null>(null)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Tiptap 编辑器 ──
  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown,  // tiptap-markdown 提供的扩展，支持 Markdown 序列化/反序列化
    ],
    content: '',
    editable: !isCreationActive,
    onUpdate: ({ editor }) => {
      const md = editor.storage.markdown.getMarkdown()
      setDraftContent(md)
      setSaveState('dirty')
      scheduleDebouncedSave()
    },
  })

  // ── 防抖保存 ──
  const flushSave = useCallback(async () => {
    if (saveStateRef.current !== 'dirty') return
    const targetChapter = chapters.find((c) => c.chapterNumber === playheadChapter)
    if (!targetChapter) return
    setSaveState('saving')
    setErrorMsg(null)
    try {
      const updated = await updateChapter(targetChapter.id, { content: draftContentRef.current })
      upsertChapter(updated)
      setSaveState('saved')
    } catch (err) {
      setSaveState('error')
      setErrorMsg(err instanceof Error ? err.message : '保存失败')
    }
  }, [chapters, playheadChapter, upsertChapter])

  const scheduleDebouncedSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { void flushSave() }, 1500)
  }, [flushSave])

  // ── 章节切换联动（播放头驱动，单向）──
  useEffect(() => {
    if (isCreationActive) return  // 创作流程激活时由任务 8 的 effect 处理

    const targetChapter = chapters.find((c) => c.chapterNumber === playheadChapter)
    if (!targetChapter) {
      setDraftContent('')
      loadedChapterIdRef.current = null
      if (editor) editor.commands.setContent('', false)
      return
    }

    // 同一章节不重载（避免保存后 chapters 变化触发重载→光标重置）
    if (loadedChapterIdRef.current === targetChapter.id) return
    loadedChapterIdRef.current = targetChapter.id

    // 切换前若有未保存改动，先强制落库
    const switchTo = () => {
      const content = targetChapter.content ?? ''
      setDraftContent(content)
      setSaveState('saved')
      setErrorMsg(null)
      if (editor) editor.commands.setContent(content, false)
    }

    if (saveStateRef.current === 'dirty') {
      void flushSave().finally(switchTo)
    } else {
      switchTo()
    }
  }, [playheadChapter, isCreationActive, chapters, editor, flushSave])

  // ── 卸载时清理定时器 + 强制落库 ──
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      void flushSave()
    }
  }, [flushSave])

  // ── 只读模式切换 ──
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!isCreationActive)
  }, [isCreationActive, editor])

  // ── 章节导航 ──
  const maxChapter = chapters.length > 0 ? Math.max(...chapters.map((c) => c.chapterNumber)) : 1
  const currentChapter = chapters.find((c) => c.chapterNumber === playheadChapter)
  const canPrev = playheadChapter > 1
  const canNext = playheadChapter < maxChapter

  const handlePrev = useCallback(() => {
    if (canPrev) setPlayheadChapter(playheadChapter - 1)
  }, [canPrev, playheadChapter, setPlayheadChapter])

  const handleNext = useCallback(() => {
    if (canNext) setPlayheadChapter(playheadChapter + 1)
  }, [canNext, playheadChapter, setPlayheadChapter])

  const wordCount = countWords(draftContent)

  // ── 渲染 ──
  return (
    <div className="chapter-content-editor">
      <header className="cce-header">
        <div className="cce-nav">
          <button onClick={handlePrev} disabled={!canPrev || isCreationActive} title="上一章">«</button>
          <span className="cce-chapter-label">第 {playheadChapter} 章{currentChapter?.title ? ` · ${currentChapter.title}` : ''}</span>
          <button onClick={handleNext} disabled={!canNext || isCreationActive} title="下一章">»</button>
        </div>
        <div className="cce-save-state">
          {saveState === 'saved' && <span className="cce-saved">已保存</span>}
          {saveState === 'saving' && <span className="cce-saving">保存中…</span>}
          {saveState === 'dirty' && <span className="cce-dirty">未保存</span>}
          {saveState === 'error' && (
            <span className="cce-error">
              保存失败：{errorMsg}
              <button onClick={() => void flushSave()}>重试</button>
            </span>
          )}
        </div>
        <div className="cce-word-count">{wordCount} 字</div>
      </header>
      <div className="cce-body">
        {currentChapter ? (
          <EditorContent editor={editor} />
        ) : (
          <div className="cce-empty">无章节，请先创建章节</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：创建基础样式**

创建 `apps/desktop/src/renderer/src/components/novel/chapter-content-editor.css`：

```css
.chapter-content-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--color-surface-1, #fff);
  border-bottom: 1px solid var(--color-border, #e5e7eb);
}

.cce-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  height: 36px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-surface-1, #fff);
  flex-shrink: 0;
  font-size: 12px;
}

.cce-nav { display: flex; align-items: center; gap: 6px; }
.cce-nav button {
  background: transparent; border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 14px;
  color: var(--color-text, #111);
}
.cce-nav button:disabled { opacity: 0.4; cursor: not-allowed; }
.cce-chapter-label { font-weight: 500; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cce-save-state { margin-left: auto; }
.cce-saved { color: var(--color-success, #16a34a); }
.cce-saving { color: var(--color-muted, #6b7280); }
.cce-dirty { color: var(--color-warning, #d97706); }
.cce-error { color: var(--color-destructive, #dc2626); display: flex; align-items: center; gap: 6px; }
.cce-error button { background: transparent; border: 1px solid currentColor; border-radius: 4px; padding: 1px 6px; cursor: pointer; font-size: 11px; color: inherit; }

.cce-word-count { color: var(--color-muted, #6b7280); flex-shrink: 0; }

.cce-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 16px 24px;
}

.cce-empty {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: var(--color-muted, #6b7280); font-size: 13px;
}

/* Tiptap 内容区样式 */
.cce-body .ProseMirror {
  outline: none; min-height: 100%; font-size: 14px; line-height: 1.7;
  color: var(--color-text, #111);
}
.cce-body .ProseMirror h1 { font-size: 20px; font-weight: 600; margin: 16px 0 8px; }
.cce-body .ProseMirror h2 { font-size: 17px; font-weight: 600; margin: 14px 0 6px; }
.cce-body .ProseMirror h3 { font-size: 15px; font-weight: 600; margin: 12px 0 4px; }
.cce-body .ProseMirror p { margin: 6px 0; }
.cce-body .ProseMirror blockquote {
  border-left: 3px solid var(--color-border, #d1d5db); padding-left: 12px;
  color: var(--color-muted, #6b7280); margin: 8px 0;
}
.cce-body .ProseMirror ul, .cce-body .ProseMirror ol { padding-left: 20px; margin: 6px 0; }
.cce-body .ProseMirror hr { border: none; border-top: 1px solid var(--color-border, #e5e7eb); margin: 12px 0; }
.cce-body .ProseMirror strong { font-weight: 600; }
.cce-body .ProseMirror em { font-style: italic; }
```

- [ ] **步骤 3：验证 TypeScript 编译**

运行：`pnpm --filter desktop typecheck`（或 `tsc --noEmit`）
预期：无错误

- [ ] **步骤 4：手动验证基础闭环**

（任务 9 接入布局后才能完整验证，此步骤暂跳过，留到任务 9 后统一验证）

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx apps/desktop/src/renderer/src/components/novel/chapter-content-editor.css
git commit -m "feat(novel): add ChapterContentEditor with Tiptap + debounced autosave"
```

---

## 任务 7：ChapterContentEditor - Tiptap 工具栏

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx`
- 修改：`apps/desktop/src/renderer/src/components/novel/chapter-content-editor.css`

**目的：** 在 header 添加格式工具栏按钮（标题级别/粗体/斜体/引用/列表/分割线/撤销重做）。

- [ ] **步骤 1：在 header 添加工具栏按钮组**

修改 `chapter-content-editor.tsx`，在 `cce-save-state` div 之后、`cce-word-count` 之前插入工具栏：

```tsx
{/* Tiptap 工具栏 */}
<div className="cce-toolbar">
  <select
    onChange={(e) => {
      const v = e.target.value
      if (v === 'p') editor?.chain().focus().setParagraph().run()
      else if (v === 'h1') editor?.chain().focus().setHeading({ level: 1 }).run()
      else if (v === 'h2') editor?.chain().focus().setHeading({ level: 2 }).run()
      else if (v === 'h3') editor?.chain().focus().setHeading({ level: 3 }).run()
    }}
    disabled={isCreationActive}
    title="标题级别"
    value={editor?.isActive('heading', { level: 1 }) ? 'h1'
      : editor?.isActive('heading', { level: 2 }) ? 'h2'
      : editor?.isActive('heading', { level: 3 }) ? 'h3'
      : 'p'}
  >
    <option value="p">正文</option>
    <option value="h1">标题 1</option>
    <option value="h2">标题 2</option>
    <option value="h3">标题 3</option>
  </select>

  <button
    onClick={() => editor?.chain().focus().toggleBold().run()}
    disabled={isCreationActive || !editor?.can().toggleBold()}
    className={editor?.isActive('bold') ? 'is-active' : ''}
    title="粗体"
  >B</button>

  <button
    onClick={() => editor?.chain().focus().toggleItalic().run()}
    disabled={isCreationActive || !editor?.can().toggleItalic()}
    className={editor?.isActive('italic') ? 'is-active' : ''}
    title="斜体"
  >I</button>

  <button
    onClick={() => editor?.chain().focus().toggleBlockquote().run()}
    disabled={isCreationActive}
    className={editor?.isActive('blockquote') ? 'is-active' : ''}
    title="引用"
  >"</button>

  <button
    onClick={() => editor?.chain().focus().toggleOrderedList().run()}
    disabled={isCreationActive}
    className={editor?.isActive('orderedList') ? 'is-active' : ''}
    title="有序列表"
  >1.</button>

  <button
    onClick={() => editor?.chain().focus().toggleBulletList().run()}
    disabled={isCreationActive}
    className={editor?.isActive('bulletList') ? 'is-active' : ''}
    title="无序列表"
  >•</button>

  <button
    onClick={() => editor?.chain().focus().setHorizontalRule().run()}
    disabled={isCreationActive}
    title="分割线"
  >—</button>

  <button
    onClick={() => editor?.chain().focus().undo().run()}
    disabled={isCreationActive || !editor?.can().undo()}
    title="撤销"
  >↶</button>

  <button
    onClick={() => editor?.chain().focus().redo().run()}
    disabled={isCreationActive || !editor?.can().redo()}
    title="重做"
  >↷</button>
</div>
```

- [ ] **步骤 2：添加工具栏样式**

在 `chapter-content-editor.css` 添加：

```css
.cce-toolbar {
  display: flex; align-items: center; gap: 4px; margin-left: 16px;
}
.cce-toolbar button {
  background: transparent; border: 1px solid transparent; border-radius: 4px;
  padding: 2px 8px; cursor: pointer; font-size: 13px; min-width: 26px;
  color: var(--color-text, #111);
}
.cce-toolbar button:hover:not(:disabled) { background: var(--color-muted-soft, rgba(0,0,0,0.05)); }
.cce-toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
.cce-toolbar button.is-active { background: var(--color-primary-soft, rgba(59,130,246,0.15)); color: var(--color-primary, #3b82f6); }
.cce-toolbar select {
  border: 1px solid var(--color-border, #e5e7eb); border-radius: 4px;
  padding: 2px 4px; font-size: 12px; background: var(--color-surface-1, #fff);
  color: var(--color-text, #111);
}
```

- [ ] **步骤 3：验证 TypeScript 编译**

运行：`pnpm --filter desktop typecheck`
预期：无错误

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx apps/desktop/src/renderer/src/components/novel/chapter-content-editor.css
git commit -m "feat(novel): add Tiptap formatting toolbar to chapter content editor"
```

---

## 任务 8：ChapterContentEditor - 创作流程协作

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx`

**目的：** 创作流程激活时显示流式内容（覆盖 playheadChapter 对应章节），完成后切回编辑模式。

- [ ] **步骤 1：添加创作流程实时内容显示 effect**

在 `chapter-content-editor.tsx` 的"只读模式切换" effect 之后添加：

```typescript
// ── 创作流程实时内容显示 ──
useEffect(() => {
  if (!editor) return
  // 仅当创作流程激活且创作章节 == 当前播放头章节时，显示流式内容
  if (isCreationActive && creationChapterNumber === playheadChapter) {
    const content = creationChapterContent ?? ''
    // setContent 第二参数 false：不触发 onUpdate，避免污染保存状态
    editor.commands.setContent(content, false)
    loadedChapterIdRef.current = null  // 标记为"创作中"，章节切换 effect 不应覆盖
  }
}, [isCreationActive, creationChapterNumber, playheadChapter, creationChapterContent, editor])
```

- [ ] **步骤 2：验证 effect 不与章节切换 effect 冲突**

检查任务 6 的章节切换 effect，确认其首行 `if (isCreationActive) return` 已阻止创作期间执行 setDraftContent/setContent。两者互斥，无冲突。

- [ ] **步骤 3：验证创作完成切回编辑模式**

检查任务 6 的章节切换 effect 依赖包含 `isCreationActive`。当 `isCreationActive` 从 true → false 时，effect 重新执行：
- `loadedChapterIdRef.current` 在创作期间被设为 null
- effect 重新查找 `playheadChapter` 对应章节（此时 store.chapters 已含创作完成的 content，由 `handleSaveChapter` upsertChapter）
- `loadedChapterIdRef.current !== targetChapter.id` 成立 → 执行 switchTo → 加载最新 content

逻辑正确，无需额外代码。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx
git commit -m "feat(novel): integrate chapter content editor with creation flow"
```

---

## 任务 9：布局接入 - novel-workspace.tsx 垂直分割

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx`（第 431-452 行主内容区）

**注意：** 现有 `ResizableSplitter` 已支持 `direction="vertical"`，但基于绝对像素 size，不是比例。用 `useState` 管理 size + localStorage 持久化。

- [ ] **步骤 1：添加编辑器高度 state 与持久化**

在 `novel-workspace.tsx` 的 `NovelWorkspace` 组件内，现有 state 声明区（约第 107-112 行）添加：

```typescript
const [contentEditorHeight, setContentEditorHeight] = useState<number>(() => {
  const saved = typeof window !== 'undefined' ? window.localStorage.getItem('pi-agent-content-split') : null
  return saved ? Number(saved) : 300  // 默认 300px
})

const handleContentEditorHeightChange = useCallback((size: number) => {
  setContentEditorHeight(size)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('pi-agent-content-split', String(size))
  }
}, [])
```

- [ ] **步骤 2：导入 ChapterContentEditor**

在文件顶部 import 区（约第 41 行后）添加：

```typescript
import { ChapterContentEditor } from './chapter-content-editor'
```

- [ ] **步骤 3：替换主内容区为垂直分割**

修改第 431-452 行：

原代码：
```tsx
<div className="flex-1 min-h-0">
  {viewMode === 'timeline' ? (
    <NovelTimelineWorkspace
      creationRunning={creationFlow.isRunning}
      creationChapterNumber={creationChapterNumber}
      onCancelCreation={handleDiscardCreation}
      onRegenerateChapter={handleRegenerateChapter}
      onStartCreationAt={handleStartCreationAt}
    />
  ) : (
    <NovelCanvas ... />
  )}
</div>
```

改为：
```tsx
<div className="flex-1 min-h-0 flex flex-col">
  {viewMode === 'timeline' ? (
    <>
      {/* 上：章节正文编辑器 */}
      <div style={{ height: contentEditorHeight }} className="shrink-0 min-h-[120px] overflow-hidden">
        <ChapterContentEditor
          isCreationActive={isCreationActive}
          creationChapterNumber={creationChapterNumber}
          creationChapterContent={creationFlow.chapterContent}
        />
      </div>
      <ResizableSplitter
        direction="vertical"
        size={contentEditorHeight}
        minSize={120}
        maxSize={800}
        onSizeChange={handleContentEditorHeightChange}
        side="top"
      />
      {/* 下：时间线编辑器 */}
      <div className="flex-1 min-h-[200px] overflow-hidden">
        <NovelTimelineWorkspace
          creationRunning={creationFlow.isRunning}
          creationChapterNumber={creationChapterNumber}
          onCancelCreation={handleDiscardCreation}
          onRegenerateChapter={handleRegenerateChapter}
          onStartCreationAt={handleStartCreationAt}
        />
      </div>
    </>
  ) : (
    <NovelCanvas
      relayoutSignal={relayoutSignal}
      creationPhase={creationFlow.phase}
      creationRunning={creationFlow.isRunning}
      creationChapterNumber={creationChapterNumber}
      creationError={creationFlow.error}
      onCancelCreation={handleDiscardCreation}
      onNodeCountChange={setNodeCount}
      onRegenerateChapter={handleRegenerateChapter}
    />
  )}
</div>
```

注意：`isCreationActive` 已在文件第 320 行定义（`const isCreationActive = creationFlow.isRunning || creationFlow.phase !== 'idle'`），直接复用。`ResizableSplitter` 已在文件顶部 import（第 6 行）。

- [ ] **步骤 4：验证 TypeScript 编译**

运行：`pnpm --filter desktop typecheck`
预期：无错误

- [ ] **步骤 5：手动验证完整功能**

启动 desktop 应用，进入小说工作台时间轴视图，验证：

1. **布局**：上方正文编辑器 + 中间可拖拽分割条 + 下方时间线
2. **拖拽分割条**：上下区域高度调整，刷新页面后比例保留
3. **联动**：时间线点上一章/下一章/播放/拖播放头 → 正文编辑器加载对应章节正文
4. **编辑保存**：编辑正文 → 1.5s 后状态变"保存中"→"已保存" → 刷新页面正文保留
5. **章节切换强制落库**：编辑未保存时点下一章 → 自动保存 → 加载新章节
6. **工具栏**：标题/粗体/斜体/引用/列表/分割线/撤销重做可用，按钮 active 态正确
7. **字数统计**：随输入实时更新
8. **创作流程**：点"开始创作" → 编辑器只读 → 显示流式内容 → 完成后可继续编辑
9. **画布视图**：切到画布视图 → 仍是单视图（无分割条），不受影响
10. **错误重试**：断开后端 → 编辑正文 → 状态"保存失败" → 点重试 → 恢复后端 → 重试成功

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx
git commit -m "feat(novel): integrate chapter content editor with vertical splitter in workspace"
```

---

## 任务 10：Markdown 往返验收测试

**文件：**
- 创建：`apps/desktop/src/renderer/src/__tests__/markdown-roundtrip.test.ts`

**目的：** 验证 tiptap-markdown 的 Markdown↔ProseMirror 双向转换无节点丢失。这是规格 §7.3 要求的关键验收。

- [ ] **步骤 1：编写往返测试**

创建 `apps/desktop/src/renderer/src/__tests__/markdown-roundtrip.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'

/**
 * 辅助：Markdown 字符串 → Tiptap 解析 → 重新序列化为 Markdown
 */
function roundtrip(md: string): string {
  const editor = new Editor({
    extensions: [StarterKit, Markdown],
    content: md,
  })
  const output = editor.storage.markdown.getMarkdown()
  editor.destroy()
  return output
}

describe('Markdown 往返转换', () => {
  it('标题保留', () => {
    const input = '# 一级标题\n\n## 二级标题\n\n### 三级标题'
    const output = roundtrip(input)
    expect(output).toContain('# 一级标题')
    expect(output).toContain('## 二级标题')
    expect(output).toContain('### 三级标题')
  })

  it('段落与粗斜体保留', () => {
    const input = '这是**粗体**和*斜体*的混合'
    const output = roundtrip(input)
    expect(output).toContain('**粗体**')
    expect(output).toContain('*斜体*')
  })

  it('引用保留', () => {
    const input = '正文\n\n> 引用内容\n\n正文'
    const output = roundtrip(input)
    expect(output).toContain('> 引用内容')
  })

  it('有序列表保留', () => {
    const input = '1. 第一项\n2. 第二项\n3. 第三项'
    const output = roundtrip(input)
    expect(output).toMatch(/1\.\s*第一项/)
    expect(output).toMatch(/2\.\s*第二项/)
    expect(output).toMatch(/3\.\s*第三项/)
  })

  it('无序列表保留（标记可统一化）', () => {
    const input = '- 第一项\n- 第二项\n- 第三项'
    const output = roundtrip(input)
    // 列表标记可能是 - 或 *，但项数与内容保留
    expect(output).toContain('第一项')
    expect(output).toContain('第二项')
    expect(output).toContain('第三项')
  })

  it('分割线保留', () => {
    const input = '上文\n\n---\n\n下文'
    const output = roundtrip(input)
    expect(output).toMatch(/^---$/m)
  })

  it('中文长文本不丢失字符', () => {
    const input = '这是一段较长的中文正文，用于验证字符不丢失。包含逗号、句号、问号？感叹号！顿号、书名号《书》。'
    const output = roundtrip(input)
    // 逐字符比对（允许空白差异）
    const normalize = (s: string) => s.replace(/\s+/g, '')
    expect(normalize(output)).toContain(normalize(input))
  })
})
```

- [ ] **步骤 2：运行测试**

运行：`pnpm --filter desktop test markdown-roundtrip`
预期：全部 PASS。若有失败，分析失败项：
- 若是空白字符差异：调整断言为 `normalize` 后比对
- 若是节点丢失：在 `chapter-content-editor.tsx` 的 Markdown 扩展配置中调整序列化选项，或记录为已知限制

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/renderer/src/__tests__/markdown-roundtrip.test.ts
git commit -m "test(novel): add markdown roundtrip verification for tiptap-markdown"
```

---

## 自检结果

**1. 规格覆盖度：**
- §2.1 布局变更 → 任务 9 ✓
- §2.2 playheadChapter 提升 → 任务 3、4 ✓
- §2.3 组件树 → 任务 6、9 ✓
- §3.2-3.3 Props 与状态 → 任务 6 ✓
- §3.4 联动逻辑 → 任务 6（含两个实现陷阱的 ref 化处理）✓
- §3.5 编辑与保存 → 任务 6（防抖 + 强制落库 + 卸载清理）✓
- §3.6 创作流程协作 → 任务 8 ✓
- §3.7 工具栏 → 任务 7 ✓
- §5.1 依赖 → 任务 5 ✓
- §5.3 后端（无需新增路由，但需 wordCount 重算）→ 任务 1 ✓
- §7.1-7.3 测试 → 任务 1、2、3、10 分布覆盖 ✓
- §6 错误处理 → 任务 6（saveState error + 重试 + 降级空状态）✓；Tiptap 初始化失败的 textarea 降级**未覆盖**，记为已知简化（实际 Tiptap 初始化失败极罕见，且 textarea 降级需另写一套编辑逻辑，YAGNI）

**2. 占位符扫描：** 无 TODO/待定，所有代码块完整。

**3. 类型一致性：**
- `ChapterContentEditorProps` 在任务 6 定义，任务 9 透传时使用一致字段名 `isCreationActive` / `creationChapterNumber` / `creationChapterContent` ✓
- `SaveState` 类型在任务 6 定义为 `'saved'|'saving'|'dirty'|'error'`，全程一致 ✓
- `setPlayheadChapter` 在任务 3 定义为 `(chapter: number) => void`，任务 4、6 使用一致 ✓
- `countWords` 在任务 2 定义为 `(text: string) => number`，任务 6 使用一致 ✓
- `updateChapter(id, {content})` 与任务 1 后端 schema 一致 ✓

**4. 遗漏补充：**
- 任务 1 后端 wordCount 重算逻辑与任务 2 共享工具 `countWords` 必须保持算法一致（已用注释标注）
- 任务 9 的 `creationFlow.chapterContent` 字段需确认存在——已在 [chapter-live-view.tsx#L277](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx#L277) 的 props 中确认 `chapterContent: string` 字段，`novel-workspace.tsx` 第 478 行透传 `creationFlow.chapterContent`，字段存在 ✓

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-30-chapter-content-editor.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
