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
import { updateChapter, reverseArrangeFlow, getChapter } from '@/api/novel-client'
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

type ChapterBaseline = {
  chapterId: string
  version: number
  contentHash: string
  content: string
}

/** 编辑器内容快照哈希：同步、稳定，用于区分章节/版本/正文是否真的变化。 */
function hashContent(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function ChapterContentEditor({
  isCreationActive,
  creationChapterNumber,
  creationChapterContent
}: ChapterContentEditorProps): ReactElement {
  const currentProjectId = useNovelDataStore((s) => s.currentProjectId)
  const playheadChapter = useNovelUiStore((s) => s.playheadChapter)
  const setPlayheadChapter = useNovelUiStore((s) => s.setPlayheadChapter)
  const setUnsavedChapterDraft = useNovelUiStore((s) => s.setUnsavedChapterDraft)
  const clearUnsavedChapterDraft = useNovelUiStore((s) => s.clearUnsavedChapterDraft)
  const chapters = useNovelDataStore((s) => s.chapters)
  const upsertChapter = useNovelDataStore((s) => s.upsertChapter)
  const queryClient = useQueryClient()
  const activeChapterId = chapters.find((chapter) => chapter.chapterNumber === playheadChapter)?.id

  const [draftContent, setDraftContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [reverseArranging, setReverseArranging] = useState(false)
  const [versionPanelOpen, setVersionPanelOpen] = useState(false)
  const [chapterLoadRevision, setChapterLoadRevision] = useState(0)

  const saveStateRef = useRef<SaveState>('saved')
  saveStateRef.current = saveState
  const baselineRef = useRef<ChapterBaseline | null>(null)
  const loadTokenRef = useRef(0)
  const applyingLoadRef = useRef<{ token: number; expectedHash: string } | null>(null)

  // ── Tiptap 编辑器（v3：useEditor 返回 Editor | null，回调经 mostRecentOptions 保持最新）──
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: '',
    editable: !isCreationActive,
    onUpdate: ({ editor }) => {
      const mdStorage = editor.storage as { markdown?: MarkdownStorage }
      const md = mdStorage.markdown?.getMarkdown() ?? ''
      const mdHash = hashContent(md)
      const applying = applyingLoadRef.current
      const baseline = baselineRef.current

      if (!baseline) return

      if (applying) {
        if (applying.token !== loadTokenRef.current || mdHash !== applying.expectedHash) return
        applyingLoadRef.current = null
        return
      }

      const currentChapter = useNovelDataStore
        .getState()
        .chapters.find(
          (chapter) => chapter.chapterNumber === useNovelUiStore.getState().playheadChapter
        )
      if (currentChapter?.id !== baseline.chapterId) return

      if (mdHash === baseline.contentHash) {
        if (saveStateRef.current === 'dirty') {
          clearUnsavedChapterDraft(baseline.chapterId)
          saveStateRef.current = 'saved'
          setSaveState('saved')
        }
        return
      }

      setDraftContent(md)
      setUnsavedChapterDraft({
        chapterId: baseline.chapterId,
        chapterNumber: currentChapter.chapterNumber,
        content: md
      })
      saveStateRef.current = 'dirty'
      setSaveState('dirty')
    }
  })

  const readEditorMarkdown = useCallback((): string => {
    const markdown = (
      editor?.storage as { markdown?: MarkdownStorage } | undefined
    )?.markdown?.getMarkdown()
    return markdown ?? draftContent
  }, [editor, draftContent])

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveStateRef.current === 'saving') return false
    const baseline = baselineRef.current
    const currentChapter = useNovelDataStore
      .getState()
      .chapters.find(
        (chapter) => chapter.chapterNumber === useNovelUiStore.getState().playheadChapter
      )
    if (!baseline || currentChapter?.id !== baseline.chapterId) return false

    const content = readEditorMarkdown()
    const contentHash = hashContent(content)
    if (contentHash === baseline.contentHash) {
      clearUnsavedChapterDraft(baseline.chapterId)
      saveStateRef.current = 'saved'
      setSaveState('saved')
      return true
    }
    if (saveStateRef.current !== 'dirty' && saveStateRef.current !== 'error') return true

    if (!content.trim() && baseline.content.trim()) {
      const confirmed = window.confirm(
        `第 ${currentChapter.chapterNumber} 章已有正文，保存空内容会将其覆盖（生成一个空版本）。确认清空本章？`
      )
      if (!confirmed) return false
    }

    const saveToken = loadTokenRef.current
    saveStateRef.current = 'saving'
    setSaveState('saving')
    setErrorMsg(null)
    try {
      const updated = await updateChapter(baseline.chapterId, { content })
      upsertChapter(updated)

      if (updated.derivedState?.isMiddleRewrite) {
        const ds = updated.derivedState
        toastError(
          '中间章节已重写，后续内容待重建',
          `影响第 ${ds.startChapterNumber ?? currentChapter.chapterNumber} 章起的 ${ds.affectedChapters?.length ?? 0} 章；已暂停后续创作。请先查看影响范围。`
        )
      }

      const stillCurrent =
        loadTokenRef.current === saveToken &&
        baselineRef.current === baseline &&
        useNovelDataStore
          .getState()
          .chapters.find(
            (chapter) => chapter.chapterNumber === useNovelUiStore.getState().playheadChapter
          )?.id === baseline.chapterId
      if (!stillCurrent) return true

      baselineRef.current = {
        chapterId: updated.id,
        version: updated.updatedAt ?? 0,
        contentHash,
        content
      }
      const currentContent = readEditorMarkdown()
      if (hashContent(currentContent) === contentHash) {
        clearUnsavedChapterDraft(updated.id)
        saveStateRef.current = 'saved'
        setSaveState('saved')
      } else {
        setDraftContent(currentContent)
        setUnsavedChapterDraft({
          chapterId: updated.id,
          chapterNumber: currentChapter.chapterNumber,
          content: currentContent
        })
        saveStateRef.current = 'dirty'
        setSaveState('dirty')
      }
      return true
    } catch (err) {
      if (loadTokenRef.current === saveToken && baselineRef.current === baseline) {
        saveStateRef.current = 'error'
        setSaveState('error')
        setErrorMsg(err instanceof Error ? err.message : '保存失败')
      }
      return false
    }
  }, [clearUnsavedChapterDraft, readEditorMarkdown, setUnsavedChapterDraft, upsertChapter])

  // ── 从正文反推实体到矩阵 ──
  // 先 flushSave 确保最新正文落库，再调用 reverse-arrange SSE 接口
  const handleReverseArrange = useCallback(async () => {
    if (!currentProjectId || reverseArranging || isCreationActive) return
    const baseline = baselineRef.current
    const targetChapter = baseline
      ? useNovelDataStore.getState().chapters.find((chapter) => chapter.id === baseline.chapterId)
      : undefined
    if (!targetChapter || !readEditorMarkdown().trim()) {
      toastError('正文为空', '请先写好章节正文，再反推实体')
      return
    }
    setReverseArranging(true)
    try {
      const saved = await flushSave()
      if (!saved) return
      toastSuccess(
        '开始反推实体',
        `正在从第 ${targetChapter.chapterNumber} 章正文提取实体到矩阵...`
      )
      await reverseArrangeFlow(currentProjectId, targetChapter.chapterNumber, {
        onProgress: (evt: unknown) => {
          const e = evt as { type?: string; message?: string }
          if (e?.type === 'arrange_done' && e.message) toastSuccess('反推完成', e.message)
        },
        onResult: () => {
          void queryClient.invalidateQueries({ queryKey: ['novel-project-data', currentProjectId] })
        },
        onError: (err: string) => {
          toastError('反推失败', err)
        }
      })
    } catch (err) {
      toastError('反推失败', err instanceof Error ? err.message : '未知错误')
    } finally {
      setReverseArranging(false)
    }
  }, [
    currentProjectId,
    flushSave,
    isCreationActive,
    queryClient,
    readEditorMarkdown,
    reverseArranging
  ])

  // 历史版本应用由单章接口重新读取，避免非章节响应成为新的正文基线。
  const handleVersionApplied = useCallback(() => {
    setChapterLoadRevision((revision) => revision + 1)
  }, [])

  // ── 章节切换联动（播放头驱动，单向）──
  useEffect(() => {
    const token = loadTokenRef.current + 1
    loadTokenRef.current = token
    applyingLoadRef.current = null
    baselineRef.current = null
    setDraftContent('')
    saveStateRef.current = 'saved'
    setSaveState('saved')
    setErrorMsg(null)

    if (editor) {
      applyingLoadRef.current = { token, expectedHash: hashContent('') }
      editor.commands.setContent('', { emitUpdate: false })
    }
    if (isCreationActive || !activeChapterId) return

    void getChapter(activeChapterId)
      .then((chapter) => {
        if (token !== loadTokenRef.current || chapter.id !== activeChapterId) return

        const content = chapter.content ?? ''
        const baseline: ChapterBaseline = {
          chapterId: chapter.id,
          version: chapter.updatedAt ?? 0,
          contentHash: hashContent(content),
          content
        }
        baselineRef.current = baseline
        upsertChapter(chapter)

        const draft = useNovelUiStore.getState().unsavedChapterDraft
        const restoredDraft = draft?.chapterId === chapter.id ? draft : null
        const displayContent = restoredDraft?.content ?? content
        setDraftContent(displayContent)
        const nextSaveState: SaveState = restoredDraft ? 'dirty' : 'saved'
        saveStateRef.current = nextSaveState
        setSaveState(nextSaveState)

        if (!editor) return
        applyingLoadRef.current = {
          token,
          expectedHash: hashContent(displayContent)
        }
        editor.setEditable(true)
        editor.commands.setContent(displayContent, { emitUpdate: false })
      })
      .catch((error: unknown) => {
        if (token === loadTokenRef.current) {
          toastError('加载章节正文失败', error instanceof Error ? error.message : '未知错误')
        }
      })
  }, [activeChapterId, chapterLoadRevision, editor, isCreationActive, upsertChapter])

  // ── Ctrl/Cmd+S：唯一的快捷保存入口 ──
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isCreationActive || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
        return
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
  // 章节加载 effect 在创作流程激活时只清理旧基线，不请求章节正文。
  // 创作完成后，章节加载 effect 会用单章接口重新建立基线。
  useEffect(() => {
    if (!editor || !isCreationActive || creationChapterNumber !== playheadChapter) return
    const token = loadTokenRef.current + 1
    const content = creationChapterContent ?? ''
    loadTokenRef.current = token
    baselineRef.current = null
    applyingLoadRef.current = { token, expectedHash: hashContent(content) }
    setDraftContent(content)
    editor.commands.setContent(content, { emitUpdate: false })
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
          value={
            editor?.isActive('heading', { level: 1 })
              ? 'h1'
              : editor?.isActive('heading', { level: 2 })
                ? 'h2'
                : editor?.isActive('heading', { level: 3 })
                  ? 'h3'
                  : 'p'
          }
        >
          <option value="p">正文</option>
          <option value="h1">标题 1</option>
          <option value="h2">标题 2</option>
          <option value="h3">标题 3</option>
        </select>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          disabled={isCreationActive || !editor?.can().toggleBold()}
          className={editor?.isActive('bold') ? 'is-active' : ''}
          title="粗体"
        >
          B
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          disabled={isCreationActive || !editor?.can().toggleItalic()}
          className={editor?.isActive('italic') ? 'is-active' : ''}
          title="斜体"
        >
          I
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          disabled={isCreationActive}
          className={editor?.isActive('blockquote') ? 'is-active' : ''}
          title="引用"
        >
          "
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          disabled={isCreationActive}
          className={editor?.isActive('orderedList') ? 'is-active' : ''}
          title="有序列表"
        >
          1.
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          disabled={isCreationActive}
          className={editor?.isActive('bulletList') ? 'is-active' : ''}
          title="无序列表"
        >
          •
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          disabled={isCreationActive}
          title="分割线"
        >
          —
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().undo().run()}
          disabled={isCreationActive || !editor?.can().undo()}
          title="撤销"
        >
          ↶
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().redo().run()}
          disabled={isCreationActive || !editor?.can().redo()}
          title="重做"
        >
          ↷
        </button>
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
            disabled={
              isCreationActive || saveState === 'saved' || saveState === 'saving' || !currentChapter
            }
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
