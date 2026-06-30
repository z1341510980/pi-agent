# 章节正文编辑器设计规格

- **日期**：2026-06-30
- **状态**：待审查
- **范围**：在时间线编辑视图上方新增章节正文编辑器，与时间线垂直分割、播放头单向联动
- **关联**：阶段3 of 三阶段计划（阶段1=代码审核已完成，阶段2=时间线优化待定范围）

---

## 1. 背景与目标

### 1.1 现状

当前小说工作台的主内容区（[novel-workspace.tsx#L431-L461](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx#L431)）在时间轴视图下只渲染 `NovelTimelineWorkspace` 一个组件，占满剩余高度。章节正文目前**没有独立编辑入口**：

- 创作流程运行时，正文以只读 Markdown 形式渲染在右侧栏的 `ChapterLivePanel`（[chapter-live-view.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx)）里，用 `ReactMarkdown` 展示 `chapterContent` 流式输出
- 创作完成后通过 `completeChapter(id, {content})` 落库，用户无直接编辑入口
- 章节正文字段 `NovelChapter.content` 是 Markdown 字符串（[novel-client.ts#L49-L62](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/api/novel-client.ts#L49)）

### 1.2 目标

1. 在时间线编辑视图上方新增章节正文编辑器，二者**垂直可拖拽分割**
2. 编辑器**单向订阅播放头章节**：播放头移动 → 编辑器加载对应章节正文；编辑器内切换章节**不回推**播放头
3. 提供所见即所得的富文本编辑体验，落库格式仍为 Markdown（与现有存储一致）
4. 创作流程运行时编辑器进入只读模式，实时显示 AI 生成内容；完成后可在编辑器内继续润色

### 1.3 非目标

- 不做章节正文的版本历史/diff（超出本期范围）
- 不做多章节跨章节编辑（一次只编辑一个章节）
- 不改动画布视图（`viewMode === 'canvas'` 时布局不变）
- 不重构 `ChapterLivePanel`（右侧栏创作预览保持现状，二者并存：右侧栏看 Agent 输出流，正文编辑器看/改最终正文）
- 不做正文与时间线片段的双向绑定（片段标签编辑仍由时间线右键菜单负责）

---

## 2. 架构

### 2.1 布局变更

修改 [novel-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx) 主内容区第 431-452 行：

```
原：  <div className="flex-1 min-h-0">
        {viewMode === 'timeline' ? <NovelTimelineWorkspace/> : <NovelCanvas/>}
      </div>

改：  <div className="flex-1 min-h-0">
        {viewMode === 'timeline' ? (
          <VerticalSplitter initialTopRatio={0.45} storageKey="pi-agent-content-split">
            <ChapterContentEditor/>      {/* 上 */}
            <NovelTimelineWorkspace/>     {/* 下 */}
          </VerticalSplitter>
        ) : <NovelCanvas/>}
      </div>
```

- 画布视图不变
- 分割比例持久化到 localStorage（key: `pi-agent-content-split`），默认上 45% / 下 55%
- 上区最小高度 120px（保证工具栏 + 几行正文可见），下区最小高度 200px（保证时间线至少 3 条轨道可见）

### 2.2 状态提升：playheadChapter 上提到 store

**关键决策**：`playheadChapter` 目前是 [novel-timeline-workspace.tsx#L129](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx#L129) 的局部 `useState(1)`。为让正文编辑器能订阅它，必须提升到 Zustand store。

理由（选择 store 而非父组件 props）：
- store 已有 `viewMode`、`markers` 等"视图状态"先例，`playheadChapter` 性质相同
- `novel-workspace.tsx` 父级提升方案会让 `NovelTimelineWorkspace` 从"自包含"变成"受控"，破坏其封装；store 方案对 timeline workspace 内部改动更小（仅把 `useState` 换成 store selector + action）
- 正文编辑器与 timeline workspace 是平级兄弟组件，store 是最自然的共享通道

**改动点**：
1. [novel-store.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/stores/novel-store.ts) `NovelState` 新增：
   - `playheadChapter: number`（默认 1）
   - `setPlayheadChapter: (chapter: number) => void`
   - **不持久化**（`partialize` 排除，每次进项目从 1 开始）
2. [novel-timeline-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx)：
   - 删除 `const [playheadChapter, setPlayheadChapter] = useState(1)`
   - 改为 `const playheadChapter = useNovelStore(s => s.playheadChapter)` + `const setPlayheadChapter = useNovelStore(s => s.setPlayheadChapter)`
   - `effectivePlayheadChapter` 计算逻辑（第 165-167 行）保持不变，仍由 timeline workspace 内部消费
3. 正文编辑器订阅 `useNovelStore(s => s.playheadChapter)`

### 2.3 组件树

```
NovelWorkspace
├── header / sidebar / detail panel（不变）
└── main
    └── viewMode === 'timeline'
        └── VerticalSplitter
            ├── ChapterContentEditor（新）
            │   ├── EditorToolbar（章节导航 + 保存状态 + Tiptap 工具栏）
            │   └── EditorBody（Tiptap 编辑区）
            └── NovelTimelineWorkspace（改动：playheadChapter 提升到 store）
```

---

## 3. 组件设计：ChapterContentEditor

### 3.1 文件位置

`apps/desktop/src/renderer/src/components/novel/chapter-content-editor.tsx`（新建）

### 3.2 Props

```typescript
interface ChapterContentEditorProps {
  /** 创作流程是否激活（运行中或非 idle 阶段）—— 来自 NovelWorkspace 的 isCreationActive */
  isCreationActive: boolean
  /** 创作流程当前章节号 —— 用于只读模式显示 */
  creationChapterNumber?: number
  /** 创作流程实时正文 —— 只读模式下显示，覆盖 playheadChapter 对应章节 */
  creationChapterContent?: string
}
```

这三个 prop 由 `novel-workspace.tsx` 透传（它已持有 `creationFlow` 状态），避免正文编辑器直接依赖创作流程 hook。

### 3.3 内部状态

```typescript
// 当前编辑的章节（由 playheadChapter 驱动）
const playheadChapter = useNovelStore(s => s.playheadChapter)
const chapters = useNovelStore(s => s.chapters)
const upsertChapter = useNovelStore(s => s.upsertChapter)

// 本地编辑状态
const [draftContent, setDraftContent] = useState('')           // Tiptap 编辑器当前内容（Markdown 字符串）
const [saveState, setSaveState] = useState<'saved'|'saving'|'dirty'|'error'>('saved')
const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
const [errorMsg, setErrorMsg] = useState<string | null>(null)

// Tiptap 实例
const editorRef = useRef<Editor | null>(null)
```

### 3.4 联动逻辑（播放头驱动，单向）

**核心 effect**：

```typescript
useEffect(() => {
  // 创作流程激活时，正文编辑器显示创作内容，不跟随 playheadChapter
  if (isCreationActive) return

  const targetChapter = chapters.find(c => c.chapterNumber === playheadChapter)
  if (!targetChapter) {
    setDraftContent('')
    return
  }
  // 切换章节前，若有未保存改动，先强制落库
  if (saveState === 'dirty') {
    void flushSave().finally(() => {
      setDraftContent(targetChapter.content ?? '')
      setSaveState('saved')
    })
  } else {
    setDraftContent(targetChapter.content ?? '')
    setSaveState('saved')
  }
}, [playheadChapter, isCreationActive, chapters])
```

- `setPlayheadChapter` **不**在编辑器内调用（单向，不回推）
- 章节导航按钮（上一章/下一章）通过调用 `useNovelStore.getState().setPlayheadChapter(n)` 间接驱动——这样导航也会同步移动时间线播放头，符合"播放头驱动"语义且不破坏单向性（导航本身是用户显式操作播放头，不是编辑器副作用）

**实现陷阱（避免重载循环）**：effect 依赖 `chapters`，但保存成功后 `upsertChapter` 会更新 `chapters`（content 变化），若直接按 `chapters` 变化就 `setDraftContent`，会造成"保存→chapters 变→重载 draft→光标重置"的循环。**必须用 `useRef` 记录上一次加载的 `chapterId`，仅在 `chapterId` 变化时才 `setDraftContent`**，content 同步变化不触发重载（draft 已是最新）。

**实现陷阱（闭包）**：`flushSave` 引用 `saveState`，但 `scheduleDebouncedSave` 通过 `setTimeout` 调用它，`setTimeout` 闭包会捕获旧的 `saveState`。**必须用 `saveStateRef` 同步保存最新值，`flushSave` 内读 ref**，或将 `flushSave` 用 `useCallback` 重建并加入 `saveState` 依赖。

### 3.5 编辑与保存

**Tiptap 编辑器初始化**：

```typescript
const editor = useEditor({
  extensions: [
    StarterKit,                    // 标题/段落/列表/引用/分割线/粗斜体/撤销重做
    MarkdownKit,                   // 来自 tiptap-markdown，处理 Markdown 序列化/反序列化
    // 不加图片/表格/代码块高亮等重型扩展（YAGNI）
  ],
  content: draftContent,           // Markdown 字符串，tiptap-markdown 负责解析
  editable: !isCreationActive,     // 创作流程激活时只读
  onUpdate: ({ editor }) => {
    setDraftContent(editor.storage.markdown.getMarkdown())  // 序列化为 Markdown
    setSaveState('dirty')
    scheduleDebouncedSave()
  },
})
```

**防抖自动保存**：

```typescript
const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

const scheduleDebouncedSave = () => {
  if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
  saveTimerRef.current = setTimeout(() => { void flushSave() }, 1500)
}

const flushSave = async () => {
  if (saveState !== 'dirty') return
  const targetChapter = chapters.find(c => c.chapterNumber === playheadChapter)
  if (!targetChapter) return
  setSaveState('saving')
  setErrorMsg(null)
  try {
    const updated = await updateChapter(targetChapter.id, { content: draftContent })
    upsertChapter(updated)                  // 同步本地 store
    setSaveState('saved')
    setLastSavedAt(Date.now())
  } catch (err) {
    setSaveState('error')
    setErrorMsg(err instanceof Error ? err.message : '保存失败')
    // 保留 dirty 内容，不回滚，让用户决定重试或放弃
  }
}

// 卸载时清理定时器 + 强制落库
useEffect(() => {
  return () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    // 卸载时的同步落库用 void，不阻塞；切换项目时若失败由用户在错误状态下重试
    void flushSave()
  }
}, [])
```

**章节切换/项目切换/视图切换的强制落库**：在 `flushSave` 内部判断 `saveState === 'dirty'`，由章节切换 effect（3.4）和卸载 effect 触发。

### 3.6 与创作流程的协作

| 创作流程状态 | 编辑器行为 |
|---|---|
| `isCreationActive === false`（idle） | 正常编辑模式，订阅 playheadChapter |
| `isCreationActive === true` 且 `creationChapterNumber === playheadChapter` | 只读，显示 `creationChapterContent` 实时流式内容 |
| `isCreationActive === true` 且 `creationChapterNumber !== playheadChapter` | 只读，显示 playheadChapter 对应章节的已存正文（用户可在创作期间浏览其他章节） |
| 创作完成 `isCreationActive` 切回 false | effect 触发，重新加载 playheadChapter 对应章节（此时该章节 content 已由 `handleSaveChapter` 落库并 upsertChapter），用户可继续润色 |

**只读切换 effect**：

```typescript
useEffect(() => {
  if (!editor) return
  editor.setEditable(!isCreationActive)
}, [isCreationActive, editor])

useEffect(() => {
  if (!editor) return
  if (isCreationActive && creationChapterNumber === playheadChapter) {
    // 显示创作流程实时内容（覆盖 draftContent）
    editor.commands.setContent(creationChapterContent ?? '', false /* 不触发 onUpdate */)
  }
}, [isCreationActive, creationChapterNumber, playheadChapter, creationChapterContent, editor])
```

注意 `setContent` 的第二个参数 `false` 避免实时流式内容触发 onUpdate 进而污染保存状态。

### 3.7 工具栏（EditorToolbar）

顶部一行，左→右：

1. **章节导航组**：`« 第 N 章 »`（禁用边界：第 1 章禁用 `«`，最后一章禁用 `»`）+ 章节标题（截断显示）
2. **保存状态指示**：`已保存` / `保存中…` / `未保存` / `保存失败：{msg}`（红字 + 重试按钮）
3. **Tiptap 工具栏组**：标题级别下拉（H1/H2/H3/正文）、粗体、斜体、引用、有序列表、无序列表、分割线、撤销、重做
4. **字数统计**：实时显示当前正文字数（复用 [chapter-live-view.tsx#L63-L68](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx#L63) 的 `countWords` 逻辑，抽到共享工具）

创作流程激活时，Tiptap 工具栏按钮全部禁用，仅章节导航和字数统计可用。

---

## 4. 数据流

### 4.1 加载流程

```
项目打开 → NovelWorkspace useQuery 拉取 chapters → store.chapters 填充
         → ChapterContentEditor effect 监听 [playheadChapter, chapters]
         → 找到第 playheadChapter 章 → setDraftContent(content) → Tiptap setContent
```

### 4.2 编辑保存流程

```
用户输入 → Tiptap onUpdate → setDraftContent(markdown) + setSaveState('dirty')
                            → 1.5s 防抖 → flushSave()
                            → updateChapter(id, {content}) → 后端 PUT /chapters/:id
                            → upsertChapter(updated) 同步 store
                            → setSaveState('saved')
```

### 4.3 章节切换流程

```
时间线播放头移动 / 编辑器点上一章下一章 → store.setPlayheadChapter(n)
                                          → effect 触发
                                          → 若 saveState==='dirty' 先 flushSave()
                                          → setDraftContent(新章节 content)
                                          → Tiptap setContent
```

---

## 5. 依赖与选型

### 5.1 新增依赖（apps/desktop）

```
@tiptap/react
@tiptap/starter-kit
@tiptap/pm              # ProseMirror 底层，peer dep
tiptap-markdown         # 社区扩展，Markdown 双向转换
```

### 5.2 为什么选 tiptap-markdown 而非自研转换

- 章节正文已存为 Markdown 字符串，`completeChapter` / `updateChapter` 接口契约不变
- 自研 Markdown↔ProseMirror 双向转换需处理 30+ 节点类型的边界，与 YAGNI 相悖
- tiptap-markdown 是社区主流方案，维护活跃，覆盖 StarterKit 全部节点
- 风险：复杂嵌套（如列表内引用）的往返转换可能有细节损失——**验收时用真实章节正文做往返测试**（见 §7）

### 5.3 后端

**无新增路由**。复用现有 `PUT /chapters/:id`（[novel-routes.ts#L282](file:///d:/WebWork/AI/pi-agent/apps/agent-server/src/plugins/novel-plugin/novel-routes.ts#L282)）+ 前端 `updateChapter(id, input)`（[novel-client.ts#L570](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/api/novel-client.ts#L570)）。

`UpdateChapterInput` 需确认是否支持仅传 `{ content }`（部分字段更新）。若现有 PATCH/PUT 语义要求全字段，则在后端补一个轻量 PATCH 路由仅更新 content + wordCount + updatedAt。**待实现阶段确认，不阻塞设计**。

---

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 加载章节失败（store.chapters 为空） | 编辑区显示"无章节，请先创建章节"空状态 |
| 保存失败（网络/后端 500） | `saveState='error'`，工具栏红字显示错误 + "重试"按钮，保留 dirty 内容不回滚 |
| 章节切换时强制落库失败 | 仍切换到新章节（避免卡死），原章节标记为 error 状态（需在 store 记录失败章节 id 集合，或简化为 toast 提示） |
| Tiptap 初始化失败 | 降级为 textarea + 提示"富文本编辑器加载失败，已切换纯文本模式" |
| Markdown 往返转换损失 | 不自动修复，保留 Tiptap 输出的 Markdown（用户下次打开以此为准）；验收测试覆盖 |

---

## 7. 测试策略

### 7.1 单元测试（Vitest）

- `countWords` 共享工具
- 章节切换 effect 的强制落库逻辑（mock updateChapter）
- 保存状态机转换：saved→dirty→saving→saved / saved→dirty→saving→error→dirty

### 7.2 集成测试

- 拖动播放头 → 编辑器加载对应章节正文
- 编辑正文 → 1.5s 后自动保存 → store.chapters 更新
- 创作流程激活 → 编辑器只读 → 显示流式内容 → 流程结束 → 可继续编辑
- 章节切换时有未保存改动 → 先落库再切换

### 7.3 Markdown 往返验收测试（关键）

取 3 篇真实小说章节正文（含标题/列表/引用/分割线/粗斜体），执行：
```
原文 Markdown → Tiptap 解析 → editor.storage.markdown.getMarkdown() → 输出 Markdown
```
对比输入输出，记录差异。可接受差异：空白字符数量、列表标记统一化（`-` vs `*`）。不可接受差异：节点丢失、嵌套层级变化。

---

## 8. 实施清单

1. **store 改动**：[novel-store.ts](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/stores/novel-store.ts) 加 `playheadChapter` + `setPlayheadChapter`，`partialize` 排除
2. **timeline workspace 改动**：[novel-timeline-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/timeline/novel-timeline-workspace.tsx) 删局部 `useState`，换 store selector
3. **依赖安装**：`pnpm --filter desktop add @tiptap/react @tiptap/starter-kit @tiptap/pm tiptap-markdown`
4. **共享工具抽取**：`countWords` 从 [chapter-live-view.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/chapter-live-view.tsx) 抽到 `lib/novel-utils.ts`
5. **新建 `chapter-content-editor.tsx`**：按 §3 实现
6. **新建 `VerticalSplitter` 或复用 `ResizableSplitter`**：确认 [ResizableSplitter](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/ui/resizable-splitter.tsx) 是否支持 `direction="vertical"`，不支持则新增
7. **布局接入**：[novel-workspace.tsx](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/novel-workspace.tsx) 主内容区改为垂直分割
8. **后端确认**：核对 `UpdateChapterInput` 是否支持部分字段更新，不满足则补 PATCH 路由
9. **样式**：编辑器主题变量对齐 [timeline-styles.css](file:///d:/WebWork/AI/pi-agent/apps/desktop/src/renderer/src/components/novel/timeline/timeline-styles.css) 与 [FRONTEND_DESIGN_SYSTEM.md](file:///d:/WebWork/AI/pi-agent/docs/FRONTEND_DESIGN_SYSTEM.md)
10. **测试**：§7 三类测试

---

## 9. 未决问题

1. **`UpdateChapterInput` 是否支持部分更新**：若不支持，需后端补 PATCH。实现阶段第一步确认。
2. **创作流程实时内容与编辑器只读内容的优先级**：当前设计是 `creationChapterNumber === playheadChapter` 时显示创作内容，否则显示 playheadChapter 已存正文。若用户在创作期间想看创作中章节的"已存旧正文"怎么办？——当前不可见（被创作内容覆盖）。若需要，加一个"显示旧版本"切换按钮。**暂不做，观察用户反馈**。
3. **正文编辑器是否需要全屏模式**：用户可能希望专注写作时隐藏时间线。当前可通过拖拽分割条把时间线压到最小高度实现，暂不额外做全屏按钮。

---

## 10. 与阶段1审核结论的关系

阶段1审核发现的问题中，以下与本期设计相关但**不在本期修复范围**（归入阶段2）：

- 1.10 `loadProjectData` 不覆盖 `characterHistory`：正文编辑器不依赖 characterHistory，不受影响
- 3.4 状态归属不一致（hiddenTracks/lockedTracks 在 editor 内部）：与 playheadChapter 提升无关，阶段2处理

本期 store 改动仅新增 `playheadChapter`，不触碰审核指出的 store 结构问题，避免与阶段2冲突。
