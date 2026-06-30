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
import { useNovelStore } from '@/stores/novel-store'
import { updateChapter } from '@/api/novel-client'
import { countWords } from '@/lib/novel-utils'
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
}: ChapterContentEditorProps): ReactElement {
  const playheadChapter = useNovelStore((s) => s.playheadChapter)
  const setPlayheadChapter = useNovelStore((s) => s.setPlayheadChapter)
  const chapters = useNovelStore((s) => s.chapters)
  const upsertChapter = useNovelStore((s) => s.upsertChapter)

  const [draftContent, setDraftContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

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
    loadedChapterIdRef.current = targetChapter.id
    const switchTo = () => {
      const content = targetChapter.content ?? ''
      setDraftContent(content)
      setSaveState('saved')
      setErrorMsg(null)
      if (editor) editor.commands.setContent(content, { emitUpdate: false })
    }
    // 章节切换前，若有未保存改动，先强制落库
    if (saveStateRef.current === 'dirty') {
      void flushSave().finally(switchTo)
    } else {
      switchTo()
    }
  }, [playheadChapter, isCreationActive, chapters, editor, flushSave])

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

  // ── 章节导航（通过 setPlayheadChapter 间接驱动，符合"播放头驱动"语义）──
  const maxChapter = chapters.length > 0 ? Math.max(...chapters.map((c) => c.chapterNumber)) : 1
  const currentChapter = chapters.find((c) => c.chapterNumber === playheadChapter)
  const canPrev = playheadChapter > 1
  const canNext = playheadChapter < maxChapter
  const wordCount = countWords(draftContent)

  return (
    <div className="chapter-content-editor">
      <header className="cce-header">
        <div className="cce-nav">
          <button
            type="button"
            onClick={() => canPrev && setPlayheadChapter(playheadChapter - 1)}
            disabled={!canPrev || isCreationActive}
            title="上一章"
          >
            «
          </button>
          <span className="cce-chapter-label">
            第 {playheadChapter} 章
            {currentChapter?.title ? ` · ${currentChapter.title}` : ''}
          </span>
          <button
            type="button"
            onClick={() => canNext && setPlayheadChapter(playheadChapter + 1)}
            disabled={!canNext || isCreationActive}
            title="下一章"
          >
            »
          </button>
        </div>
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
