/**
 * 章节正文编辑器
 *
 * - 单向订阅 store.playheadChapter：播放头移动 → 加载对应章节正文
 * - Tiptap 富文本编辑器（StarterKit + Markdown 扩展），落库为 Markdown 字符串
 * - 1.5s 防抖自动保存；章节切换/卸载时强制落库
 * - 创作流程激活时进入只读模式
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { Sparkles, FileText, ChevronLeft, ChevronRight, History } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import { updateChapter, reverseArrangeFlow } from '@/api/novel-client'
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
  const chapters = useNovelDataStore((s) => s.chapters)
  const upsertChapter = useNovelDataStore((s) => s.upsertChapter)
  const queryClient = useQueryClient()

  const [draftContent, setDraftContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [reverseArranging, setReverseArranging] = useState(false)
  const [versionPanelOpen, setVersionPanelOpen] = useState(false)

  // ── 避免闭包问题：setTimeout 捕获旧值 ──
  const saveStateRef = useRef<SaveState>('saved')
  saveStateRef.current = saveState
  const draftContentRef = useRef('')
  draftContentRef.current = draftContent
  // ── 避免重载循环：仅 chapterId 变化才重载 draft ──
  const loadedChapterIdRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 强制落库 ──
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

  // ── 从正文反推实体到矩阵 ──
  // 先 flushSave 确保最新正文落库，再调用 reverse-arrange SSE 接口
  const handleReverseArrange = useCallback(async () => {
    if (!currentProjectId || reverseArranging || isCreationActive) return
    const targetChapter = chapters.find((c) => c.chapterNumber === playheadChapter)
    if (!targetChapter) return
    const content = draftContentRef.current.trim()
    if (!content) {
      toastError('正文为空', '请先写好章节正文，再反推实体')
      return
    }
    setReverseArranging(true)
    // 先强制保存正文，确保后端能读到最新内容
    if (saveStateRef.current === 'dirty') {
      await flushSave()
    }
    toastSuccess('开始反推实体', `正在从第 ${playheadChapter} 章正文提取实体到矩阵...`)
    try {
      await reverseArrangeFlow(currentProjectId, playheadChapter, {
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
  }, [currentProjectId, reverseArranging, isCreationActive, chapters, playheadChapter, flushSave, queryClient])

  // ── 版本回滚成功回调 ──
  // 用回滚后的正文覆盖编辑器显示和 draft，同步 store 中的 chapter 记录
  // 注意：必须 setSaveState('saved') 避免防抖保存把回滚后的正文再次覆盖（虽然内容相同，但避免无谓请求）
  const handleRollbackSuccess = useCallback((content: string, wordCount: number) => {
    setDraftContent(content)
    setSaveState('saved')
    setErrorMsg(null)
    if (editor) editor.commands.setContent(content, { emitUpdate: false })
    const targetChapter = chapters.find((c) => c.chapterNumber === playheadChapter)
    if (targetChapter) {
      upsertChapter({
        ...targetChapter,
        content,
        wordCount,
        updatedAt: Date.now(),
      })
    }
  }, [editor, chapters, playheadChapter, upsertChapter])

  // ── 1.5s 防抖保存 ──
  const scheduleDebouncedSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void flushSave()
    }, 1500)
  }, [flushSave])

  // ── Tiptap 编辑器（v3：useEditor 返回 Editor | null，回调经 mostRecentOptions 保持最新）──
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: '',
    editable: !isCreationActive,
    onUpdate: ({ editor }) => {
      const mdStorage = editor.storage as { markdown?: MarkdownStorage }
      const md = mdStorage.markdown?.getMarkdown() ?? ''
      setDraftContent(md)
      setSaveState('dirty')
      scheduleDebouncedSave()
    },
  })

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

    // 记住旧章节 id，用于保存未保存的改动到旧章节（而非新章节）
    const previousChapterId = loadedChapterIdRef.current
    loadedChapterIdRef.current = targetChapter.id

    const switchTo = () => {
      const content = targetChapter.content ?? ''
      setDraftContent(content)
      setSaveState('saved')
      setErrorMsg(null)
      if (editor) editor.commands.setContent(content, { emitUpdate: false })
    }

    // 章节切换前，若有未保存改动，先保存到旧章节（通过 previousChapterId 定位）
    if (saveStateRef.current === 'dirty' && previousChapterId) {
      const previousChapter = chapters.find((c) => c.id === previousChapterId)
      if (previousChapter) {
        setSaveState('saving')
        setErrorMsg(null)
        updateChapter(previousChapter.id, { content: draftContentRef.current })
          .then((updated) => {
            upsertChapter(updated)
            setSaveState('saved')
          })
          .catch((err) => {
            setSaveState('error')
            setErrorMsg(err instanceof Error ? err.message : '保存失败')
          })
          .finally(switchTo)
      } else {
        switchTo()
      }
    } else {
      switchTo()
    }
  }, [playheadChapter, isCreationActive, chapters, editor, upsertChapter])

  // ── 卸载清理 + 强制落库 ──
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
    <div className="chapter-content-editor">
      <header className="cce-header">
        {/* 左：editor-title */}
        <div className="cce-title">
          <FileText className="size-3.5 text-amber-500" aria-hidden="true" />
          <span>章节正文</span>
        </div>
        {/* 右：导航 + chapter-badge */}
        <div className="cce-nav">
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
            onClick={handleReverseArrange}
            disabled={isCreationActive || reverseArranging || !currentChapter || wordCount === 0}
            title="从当前正文提取角色/冲突/伏笔等实体到矩阵"
            className="cce-reverse-btn"
          >
            <Sparkles className="size-3" />
            <span>{reverseArranging ? '反推中...' : '反推实体'}</span>
          </button>
          <button
            type="button"
            onClick={() => setVersionPanelOpen(true)}
            disabled={!currentChapter}
            title="查看章节正文的历史版本并支持回滚"
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
        onRollbackSuccess={handleRollbackSuccess}
      />
    </div>
  )
}
