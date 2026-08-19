/**
 * 章节正文编辑器
 *
 * - 单向订阅 store.playheadChapter：播放头移动 → 加载对应章节正文
 * - Tiptap 富文本编辑器（StarterKit + Markdown 扩展），落库为 Markdown 字符串
 * - 正文只在用户明确点击保存或按 Ctrl/Cmd+S 时落库
 * - 创作流程激活时进入只读模式
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { Sparkles, FileText, ChevronLeft, ChevronRight, History, Save } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import {
  updateChapter,
  reverseArrangeFlow,
} from '@/api/novel-client'
import { toastSuccess, toastError } from '@/hooks/use-toast'
import { countWords } from '@/lib/novel-utils'
import { ChapterVersionPanel } from './chapter-version-panel'
import './chapter-content-editor.css'

export interface ChapterContentEditorProps {
  /** 创作流程是否激活（运行中或非 idle 阶段）—— 来自 NovelWorkspace 的 isCreationActive */
  isCreationActive: boolean
  /** 创作流程当前章节号 —— 用于只读模式显示 */
  creationChapterNumber?: number
  /** 创作流程实时正文 —— 只读模式下显示，覆盖 playheadChapter 对应章节 */
  creationChapterContent?: string
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

/** tiptap-markdown 注入到 editor.storage.markdown 的存储对象 */
type MarkdownStorage = { getMarkdown(): string }

export function ChapterContentEditor({
  isCreationActive,
  creationChapterNumber,
  creationChapterContent,
}: ChapterContentEditorProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const playheadChapter = useNovelUiStore((s) => s.playheadChapter)
  const setPlayheadChapter = useNovelUiStore((s) => s.setPlayheadChapter)
  const unsavedChapterDraft = useNovelUiStore((s) => s.unsavedChapterDraft)
  const setUnsavedChapterDraft = useNovelUiStore((s) => s.setUnsavedChapterDraft)
  const clearUnsavedChapterDraft = useNovelUiStore((s) => s.clearUnsavedChapterDraft)
  const chapters = useNovelDataStore((s) => s.chapters)
  const upsertChapter = useNovelDataStore((s) => s.upsertChapter)
  const queryClient = useQueryClient()

  const [draftContent, setDraftContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [reverseArranging, setReverseArranging] = useState(false)
  const [versionPanelOpen, setVersionPanelOpen] = useState(false)

  // ── 使用 ref 保存最新草稿，异步保存期间始终绑定已加载章节 ──
  const saveStateRef = useRef<SaveState>('saved')
  saveStateRef.current = saveState
  const draftContentRef = useRef('')
  draftContentRef.current = draftContent
  // ── 避免重载循环：仅 chapterId 变化才重载 draft ──
  const loadedChapterIdRef = useRef<string | null>(null)
  // ── 版本锁：记录加载时的版本号，用于判断内容是否被外部更新 ──
  const loadedVersionRef = useRef<number>(0)

  // ── 手动落库 ──
  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveStateRef.current === 'saving') return false
    if (saveStateRef.current !== 'dirty' && saveStateRef.current !== 'error') return true
    const targetChapterId = loadedChapterIdRef.current
    const targetChapter = targetChapterId
      ? chapters.find((c) => c.id === targetChapterId)
      : undefined
    if (!targetChapter) return false
    // 写入一致性守卫：播放头已切走说明 ref 过期（切换/数据刷新竞态），
    // 此时落库会把 A 章正文写进 B 章的版本链。草稿已在 unsavedChapterDraft
    // 持久化，切回该章后会恢复，这里直接放弃本次写入。
    if (targetChapter.chapterNumber !== useNovelUiStore.getState().playheadChapter) {
      return false
    }
    const editorInstance = editor
    const content = editorInstance
      ? (editorInstance.storage as { markdown?: MarkdownStorage }).markdown?.getMarkdown() ?? draftContentRef.current
      : draftContentRef.current

    // 版本锁校验：检查加载后内容是否被外部更新
    const currentVersion = targetChapter.updatedAt ?? Date.now()
    if (loadedVersionRef.current !== 0 && loadedVersionRef.current !== currentVersion) {
      // 内容已被外部更新（如 AI 生成、其他用户编辑），提示用户并刷新
      const shouldReload = window.confirm(
        `第 ${targetChapter.chapterNumber} 章内容已被外部更新，您当前的修改将覆盖最新内容。\n\n确定要继续保存吗？点击「确定」覆盖，点击「取消」重新加载最新内容。`,
      )
      if (!shouldReload) {
        // 取消保存，重新加载最新内容
        saveStateRef.current = 'saved'
        setSaveState('saved')
        setErrorMsg(null)
        // 重新加载最新内容
        const latestContent = targetChapter.content ?? ''
        setDraftContent(latestContent)
        draftContentRef.current = latestContent
        loadedVersionRef.current = currentVersion
        if (editor) editor.commands.setContent(latestContent, { emitUpdate: false })
        clearUnsavedChapterDraft(targetChapter.id)
        return true
      }
      // 用户选择覆盖，更新版本锁
      loadedVersionRef.current = currentVersion
    }

    // 空正文守卫：章节已有正文而草稿为空（加载时序异常/草稿残留）时，
    // 空内容会把现有正文覆盖成一个空版本。要求显式确认才放行。
    if (!content.trim() && (targetChapter.content ?? '').trim()) {
      const confirmed = window.confirm(
        `第 ${targetChapter.chapterNumber} 章已有正文，保存空内容会将其覆盖（生成一个空版本）。确认清空本章？`,
      )
      if (!confirmed) {
        saveStateRef.current = 'saved'
        setSaveState('saved')
        clearUnsavedChapterDraft(targetChapter.id)
        return true
      }
    }
    saveStateRef.current = 'saving'
    setSaveState('saving')
    setErrorMsg(null)
    try {
      const updated = await updateChapter(targetChapter.id, { content })
      upsertChapter(updated)
      // 版本锁同步：更新为最新版本号
      loadedVersionRef.current = updated.updatedAt ?? Date.now()
      // T04 决策 4：中间章重写 → 提示后续派生状态待重建
      if (updated.derivedState?.isMiddleRewrite) {
        const ds = updated.derivedState
        toastError(
          '中间章节已重写，后续内容待重建',
          `影响第 ${ds.startChapterNumber ?? targetChapter.chapterNumber} 章起的 ${ds.affectedChapters?.length ?? 0} 章；已暂停后续创作。请先查看影响范围。`,
        )
      }
      const latestDraft = useNovelUiStore.getState().unsavedChapterDraft
      if (latestDraft?.chapterId === targetChapter.id && latestDraft.content === content) {
        clearUnsavedChapterDraft(targetChapter.id)
      }
      saveStateRef.current = 'saved'
      setSaveState('saved')
      return true
    } catch (err) {
      saveStateRef.current = 'error'
      setSaveState('error')
      setErrorMsg(err instanceof Error ? err.message : '保存失败')
      return false
    }
  }, [chapters, upsertChapter, clearUnsavedChapterDraft])

  // ── 从正文反推实体到矩阵 ──
  // 先 flushSave 确保最新正文落库，再调用 reverse-arrange SSE 接口
  const handleReverseArrange = useCallback(async () => {
    if (!currentProjectId || reverseArranging || isCreationActive) return
    const targetChapter = chapters.find((c) => c.id === loadedChapterIdRef.current)
    if (!targetChapter) return
    const content = draftContentRef.current.trim()
    if (!content) {
      toastError('正文为空', '请先写好章节正文，再反推实体')
      return
    }
    setReverseArranging(true)
    try {
      // 反推是显式依赖后端正文的操作，先要求用户保存当前草稿。
      const saved = await flushSave()
      if (!saved) return
      toastSuccess('开始反推实体', `正在从第 ${targetChapter.chapterNumber} 章正文提取实体到矩阵...`)
      await reverseArrangeFlow(currentProjectId, targetChapter.chapterNumber, {
        onProgress: (evt: unknown) => {
          const e = evt as { type?: string; message?: string }
          if (e?.type === 'arrange_done' && e.message) {
            toastSuccess('反推完成', e.message)
          }
        },
        onResult: () => {
          // 刷新项目数据（store 会在 query 重新拉取后同步矩阵）
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
        },
        onError: (err: string) => {
          toastError('反推失败', err)
        },
      })
    } catch (err) {
      toastError('反推失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setReverseArranging(false)
    }
  }, [currentProjectId, reverseArranging, isCreationActive, chapters, flushSave, queryClient])

  // ── Tiptap 编辑器（v3：useEditor 返回 Editor | null，回调经 mostRecentOptions 保持最新）──
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: '',
    editable: !isCreationActive,
    onUpdate: ({ editor }) => {
      const mdStorage = editor.storage as { markdown?: MarkdownStorage }
      const md = mdStorage.markdown?.getMarkdown() ?? ''
      setDraftContent(md)
      if (loadedChapterIdRef.current) {
        const chapterNumber = chapters.find((chapter) => chapter.id === loadedChapterIdRef.current)?.chapterNumber
        if (chapterNumber != null) {
          setUnsavedChapterDraft({
            chapterId: loadedChapterIdRef.current,
            chapterNumber,
            content: md,
          })
        }
      }
      setSaveState('dirty')
    },
  })

  // ── 历史版本应用成功回调 ──
  // 用目标版本正文覆盖编辑器显示和 draft，同步 store 中的 chapter 记录
  // 注意：必须在 editor 初始化之后声明；useCallback 的依赖数组会在渲染时立即读取 editor
  // 应用历史版本后同步清除未保存标记，避免用户回到编辑器时看到旧草稿状态。
  const handleVersionApplied = useCallback((content: string, wordCount: number) => {
    setDraftContent(content)
    draftContentRef.current = content
    saveStateRef.current = 'saved'
    setSaveState('saved')
    setErrorMsg(null)
    if (loadedChapterIdRef.current) clearUnsavedChapterDraft(loadedChapterIdRef.current)
    if (editor) editor.commands.setContent(content, { emitUpdate: false })
    const targetChapter = chapters.find((c) => c.id === loadedChapterIdRef.current)
    if (targetChapter) {
      upsertChapter({
        ...targetChapter,
        content,
        wordCount,
        updatedAt: Date.now(),
      })
    }
  }, [editor, chapters, upsertChapter, clearUnsavedChapterDraft])

  // ── 章节切换联动（播放头驱动，单向）──
  useEffect(() => {
    if (isCreationActive) return
    const targetChapter = chapters.find((c) => c.chapterNumber === playheadChapter)
    if (!targetChapter) {
      setDraftContent('')
      loadedChapterIdRef.current = null
      if (editor) editor.commands.setContent('', { emitUpdate: false })
      return
    }
    // 避免重载循环：content 变化（保存后 upsertChapter）不触发重载
    if (loadedChapterIdRef.current === targetChapter.id) return

    loadedChapterIdRef.current = targetChapter.id
    // 版本锁：记录加载时的 updatedAt，用于检测外部更新
    loadedVersionRef.current = targetChapter.updatedAt ?? Date.now()

    const draft = unsavedChapterDraft?.chapterId === targetChapter.id ? unsavedChapterDraft : null
    // 坏草稿防御：恢复的草稿为空而章节本身有正文（上次会话的加载时序残留），
    // 直接丢弃并以章节正文为准，避免空草稿标记 dirty 进而覆盖成空版本。
    if (draft && !draft.content.trim() && (targetChapter.content ?? '').trim()) {
      clearUnsavedChapterDraft(targetChapter.id)
      setDraftContent(targetChapter.content ?? '')
      draftContentRef.current = targetChapter.content ?? ''
      saveStateRef.current = 'saved'
      setSaveState('saved')
      setErrorMsg(null)
      try {
        editor?.setEditable(!isCreationActive)
        if (editor) editor.commands.setContent(targetChapter.content ?? '', { emitUpdate: false })
      } catch {
        editor?.setEditable(true)
      }
      return
    }
    const content = draft?.content ?? targetChapter.content ?? ''
    setDraftContent(content)
    draftContentRef.current = content
    // 如果有草稿，标记为 dirty；否则检查内容是否与加载时的版本一致
    if (draft) {
      saveStateRef.current = 'dirty'
      setSaveState('dirty')
    } else {
      // 无草稿时，内容应与后端一致，视为已保存
      saveStateRef.current = 'saved'
      setSaveState('saved')
    }
    setErrorMsg(null)
    try {
      editor?.setEditable(!isCreationActive)
      if (editor) editor.commands.setContent(content, { emitUpdate: false })
    } catch {
      editor?.setEditable(true)
    }
  }, [playheadChapter, isCreationActive, chapters, editor, unsavedChapterDraft])

  // ── Ctrl/Cmd+S：唯一的快捷保存入口 ──
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isCreationActive || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void flushSave()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [flushSave, isCreationActive])

  // ── 关闭窗口/页面时保护未保存正文；不在卸载时偷偷写入后端 ──
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!useNovelUiStore.getState().unsavedChapterDraft) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  /*
   * 不在章节切换或组件卸载时自动保存：未保存草稿留在 UI store 中，
   * 这样切换工作区布局后重新挂载编辑器仍能恢复，并且不会发生跨章节写入。
   */

  // ── 只读模式切换 ──
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!isCreationActive)
  }, [isCreationActive, editor])

  // ── 创作流程实时内容显示 ──
  // 创作流程激活且创作章节 == 当前播放头章节时，显示流式内容；
  // 与章节切换 effect 互斥（章节切换 effect 首行 `if (isCreationActive) return` 拦截）。
  // 创作完成（isCreationActive true→false）时，本 effect 重跑但条件不满足不执行；
  // 章节切换 effect 随之重跑，因 loadedChapterIdRef 在创作期间被置 null，会重新加载 playheadChapter 最新 content。
  useEffect(() => {
    if (!editor) return
    if (isCreationActive && creationChapterNumber === playheadChapter) {
      const content = creationChapterContent ?? ''
      // v3 API：setContent(content, { emitUpdate: false }) 不触发 onUpdate
      editor.commands.setContent(content, { emitUpdate: false })
      loadedChapterIdRef.current = null // 标记为"创作中"，章节切换 effect 不应覆盖
    }
  }, [isCreationActive, creationChapterNumber, playheadChapter, creationChapterContent, editor])

  // ── 章节导航（通过 setPlayheadChapter 间接驱动，符合"播放头驱动"语义）──
  const maxChapter = chapters.length > 0 ? Math.max(...chapters.map((c) => c.chapterNumber)) : 1
  const currentChapter = chapters.find((c) => c.chapterNumber === playheadChapter)
  const canPrev = playheadChapter > 1
  const canNext = playheadChapter < maxChapter
  const wordCount = countWords(draftContent)

  return (
    <div className="chapter-content-editor" data-tour="editor">
      <header className="cce-header">
        {/* 左：editor-title */}
        <div className="cce-title">
          <FileText className="size-3.5 text-amber-500" aria-hidden="true" />
          <span>章节正文</span>
        </div>
        {/* 右：导航 + chapter-badge */}
        <div className="cce-nav" data-tour="chapter-nav">
          <button
            type="button"
            onClick={() => canPrev && setPlayheadChapter(playheadChapter - 1)}
            disabled={!canPrev || isCreationActive}
            title="上一章"
            className="cce-nav-btn"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
          </button>
          <span className="chapter-badge">
            <span className="dot" aria-hidden="true" />
            <span className="ch-num">CH.{playheadChapter}</span>
            {currentChapter?.title && <span className="ch-title">{currentChapter.title}</span>}
          </span>
          <button
            type="button"
            onClick={() => canNext && setPlayheadChapter(playheadChapter + 1)}
            disabled={!canNext || isCreationActive}
            title="下一章"
            className="cce-nav-btn"
          >
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>
      {/* 富文本工具栏：header 下方独立一行 */}
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
        <button type="button" onClick={() => editor?.chain().focus().toggleBold().run()} disabled={isCreationActive || !editor?.can().toggleBold()} className={editor?.isActive('bold') ? 'is-active' : ''} title="粗体">B</button>
        <button type="button" onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={isCreationActive || !editor?.can().toggleItalic()} className={editor?.isActive('italic') ? 'is-active' : ''} title="斜体">I</button>
        <button type="button" onClick={() => editor?.chain().focus().toggleBlockquote().run()} disabled={isCreationActive} className={editor?.isActive('blockquote') ? 'is-active' : ''} title="引用">"</button>
        <button type="button" onClick={() => editor?.chain().focus().toggleOrderedList().run()} disabled={isCreationActive} className={editor?.isActive('orderedList') ? 'is-active' : ''} title="有序列表">1.</button>
        <button type="button" onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={isCreationActive} className={editor?.isActive('bulletList') ? 'is-active' : ''} title="无序列表">•</button>
        <button type="button" onClick={() => editor?.chain().focus().setHorizontalRule().run()} disabled={isCreationActive} title="分割线">—</button>
        <button type="button" onClick={() => editor?.chain().focus().undo().run()} disabled={isCreationActive || !editor?.can().undo()} title="撤销">↶</button>
        <button type="button" onClick={() => editor?.chain().focus().redo().run()} disabled={isCreationActive || !editor?.can().redo()} title="重做">↷</button>
      </div>
      <div className="cce-body">
        {currentChapter ? (
          <EditorContent editor={editor} />
        ) : (
          <div className="cce-empty">无章节，请先创建章节</div>
        )}
      </div>
      {/* 底部状态栏：保存状态 + 反推 + 字数 */}
      <footer className="cce-footer">
        <div className="cce-save-state">
          {saveState === 'saved' && <span className="cce-saved">已保存</span>}
          {saveState === 'saving' && <span className="cce-saving">保存中…</span>}
          {saveState === 'dirty' && <span className="cce-dirty">未保存</span>}
          {saveState === 'error' && (
            <span className="cce-error">
              保存失败：{errorMsg}
              <button type="button" onClick={() => void flushSave()}>
                重试
              </button>
            </span>
          )}
        </div>
        <div className="cce-footer-right">
          <button
            type="button"
            onClick={() => void flushSave()}
            disabled={isCreationActive || saveState === 'saved' || saveState === 'saving' || !currentChapter}
            title="保存当前章节正文 (Ctrl/Cmd+S)"
            className="cce-save-btn"
          >
            <Save className="size-3" />
            <span>{saveState === 'saving' ? '保存中...' : '保存'}</span>
          </button>
          <button
            type="button"
            onClick={handleReverseArrange}
            disabled={isCreationActive || reverseArranging || !currentChapter || wordCount === 0}
            title="从当前正文提取角色/冲突/伏笔等实体到矩阵"
            className="cce-reverse-btn"
            data-tour="reverse-arrange"
          >
            <Sparkles className="size-3" />
            <span>{reverseArranging ? '反推中...' : '反推实体'}</span>
          </button>
          <button
            type="button"
            onClick={() => setVersionPanelOpen(true)}
            disabled={!currentChapter}
            title="查看、对比历史版本并应用到当前正文"
            className="cce-reverse-btn"
          >
            <History className="size-3" />
            <span>历史版本</span>
          </button>
          <div className="cce-word-count tabular-nums">{wordCount} 字</div>
        </div>
      </footer>

      <ChapterVersionPanel
        open={versionPanelOpen}
        onOpenChange={setVersionPanelOpen}
        chapterId={currentChapter?.id ?? null}
        onBeforeApply={flushSave}
        onApplySuccess={handleVersionApplied}
      />
    </div>
  )
}
