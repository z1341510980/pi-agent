import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronRight, ChevronDown, Plus, Sparkles, Wand2, BookText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  updateProject,
  updateChapter,
  createVolume,
  updateVolume,
  type NovelProject,
  type NovelChapter,
  type NovelVolume,
} from '@/api/novel-client'
import { Button } from '@/components/ui/button'

// ── 主组件 ──

export interface OutlineTreeProps {
  project: NovelProject
  volumes: NovelVolume[]
  chapters: NovelChapter[]
  onManualArrange: (chapter: NovelChapter) => void
  onAiArrange: (chapter: NovelChapter) => void
}

export function OutlineTree({
  project,
  volumes,
  chapters,
  onManualArrange,
  onAiArrange,
}: OutlineTreeProps): ReactElement {
  const selectedNodeId = useNovelStore((s) => s.selectedNodeId)
  const playheadChapter = useNovelStore((s) => s.playheadChapter)
  const expandedVolumes = useNovelStore((s) => s.expandedVolumes)
  const selectNode = useNovelStore((s) => s.selectNode)
  const setPlayheadChapter = useNovelStore((s) => s.setPlayheadChapter)
  const setMatrixScrollTarget = useNovelStore((s) => s.setMatrixScrollTarget)
  const toggleExpandedVolume = useNovelStore((s) => s.toggleExpandedVolume)
  const upsertProject = useNovelStore((s) => s.upsertProject)
  const upsertChapter = useNovelStore((s) => s.upsertChapter)
  const upsertVolume = useNovelStore((s) => s.upsertVolume)

  const sortedVolumes = [...volumes].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.volumeNumber - b.volumeNumber,
  )
  const orphanChapters = chapters
    .filter((c) => !c.volumeId)
    .sort((a, b) => a.chapterNumber - b.chapterNumber)

  const handleSelectChapter = useCallback(
    (chapter: NovelChapter) => {
      selectNode(chapter.id, 'chapter')
      setPlayheadChapter(chapter.chapterNumber)
      setMatrixScrollTarget({ chapter: chapter.chapterNumber, ts: Date.now() })
    },
    [selectNode, setPlayheadChapter, setMatrixScrollTarget],
  )

  const handleCreateVolume = useCallback(async () => {
    if (!project.id) return
    try {
      const nextNumber =
        volumes.length > 0 ? Math.max(...volumes.map((v) => v.volumeNumber)) + 1 : 1
      const vol = await createVolume(project.id, {
        volumeNumber: nextNumber,
        title: `第${nextNumber}卷`,
      })
      upsertVolume(vol)
    } catch (err) {
      console.error('[OutlineTree] 创建卷失败:', err)
    }
  }, [volumes, project.id, upsertVolume])

  return (
    <div className="flex flex-col gap-0.5">
      {/* 全书大纲 */}
      <EditableOutlineRow
        label="全书大纲"
        value={project.outline ?? ''}
        placeholder="点击编写全书大纲..."
        onSave={async (outline) => {
          const updated = await updateProject(project.id, { outline })
          upsertProject(updated)
        }}
        icon={<BookText className="size-3.5 text-primary" />}
      />

      {/* 新建卷按钮 */}
      <button
        type="button"
        onClick={handleCreateVolume}
        className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-text hover:bg-muted/50 rounded-md transition-colors"
      >
        <Plus className="size-3" /> 新建卷
      </button>

      {/* 卷 + 章 */}
      {sortedVolumes.map((vol) => {
        const expanded = expandedVolumes.includes(vol.id)
        const volChapters = chapters
          .filter((c) => c.volumeId === vol.id)
          .sort((a, b) => a.chapterNumber - b.chapterNumber)
        return (
          <div key={vol.id}>
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => toggleExpandedVolume(vol.id)}
                className="flex items-center gap-1 px-1 py-1 text-xs font-medium text-text hover:bg-muted/50 rounded-md flex-1 min-w-0"
              >
                {expanded ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <span className="truncate">{vol.title || `第${vol.volumeNumber}卷`}</span>
              </button>
            </div>
            {expanded && (
              <div className="ml-3 border-l border-border pl-1.5">
                <EditableOutlineRow
                  label="卷纲"
                  value={vol.outline ?? ''}
                  placeholder="点击编写卷纲..."
                  onSave={async (outline) => {
                    const updated = await updateVolume(vol.id, { outline })
                    upsertVolume(updated)
                  }}
                  compact
                />
                {volChapters.map((ch) => (
                  <ChapterRow
                    key={ch.id}
                    chapter={ch}
                    selected={selectedNodeId === ch.id}
                    isPlayhead={playheadChapter === ch.chapterNumber}
                    onClick={() => handleSelectChapter(ch)}
                    onManualArrange={() => onManualArrange(ch)}
                    onAiArrange={() => onAiArrange(ch)}
                    onOutlineSave={async (outline) => {
                      const updated = await updateChapter(ch.id, { outline })
                      upsertChapter(updated)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* 无卷归属的章节 */}
      {orphanChapters.length > 0 && (
        <div className="ml-1 border-l border-border pl-1.5">
          {orphanChapters.map((ch) => (
            <ChapterRow
              key={ch.id}
              chapter={ch}
              selected={selectedNodeId === ch.id}
              isPlayhead={playheadChapter === ch.chapterNumber}
              onClick={() => handleSelectChapter(ch)}
              onManualArrange={() => onManualArrange(ch)}
              onAiArrange={() => onAiArrange(ch)}
              onOutlineSave={async (outline) => {
                const updated = await updateChapter(ch.id, { outline })
                upsertChapter(updated)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── 章节行 ──

interface ChapterRowProps {
  chapter: NovelChapter
  selected: boolean
  isPlayhead: boolean
  onClick: () => void
  onManualArrange: () => void
  onAiArrange: () => void
  onOutlineSave: (outline: string) => Promise<void>
}

function ChapterRow({
  chapter,
  selected,
  isPlayhead,
  onClick,
  onManualArrange,
  onAiArrange,
  onOutlineSave,
}: ChapterRowProps): ReactElement {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-md transition-colors text-left',
          selected || isPlayhead
            ? 'bg-primary/10 text-text'
            : 'text-text-secondary hover:bg-muted/50',
        )}
      >
        <span className="text-muted-foreground shrink-0">第{chapter.chapterNumber}章</span>
        <span className="truncate flex-1">{chapter.title || '未命名'}</span>
        {isPlayhead && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
      </button>
      <div className="ml-2 flex flex-col gap-0.5">
        <EditableOutlineRow
          label="章纲"
          value={chapter.outline ?? ''}
          placeholder="点击编写章纲（生成的统一起点）..."
          onSave={onOutlineSave}
          compact
        />
        <div className="flex items-center gap-1 px-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={onManualArrange}
            title="手动编排"
          >
            <Sparkles className="size-3" /> 手动编排
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={onAiArrange}
            disabled={!chapter.outline?.trim()}
            title="AI编排"
          >
            <Wand2 className="size-3" /> AI编排
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── 可编辑纲要行（防抖 1.5s 保存） ──

interface EditableOutlineRowProps {
  label: string
  value: string
  placeholder: string
  onSave: (value: string) => Promise<void>
  icon?: ReactElement
  selected?: boolean
  compact?: boolean
}

function EditableOutlineRow({
  label,
  value,
  placeholder,
  onSave,
  icon,
  selected,
  compact,
}: EditableOutlineRowProps): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSavingRef = useRef(false)

  // value 变化时同步 draft，但保存期间不覆盖（避免闭包陷阱：用户继续输入被回写覆盖）
  useEffect(() => {
    if (!isSavingRef.current) setDraft(value)
  }, [value])

  // 卸载时清理定时器，避免回调命中已卸载组件
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const doSave = useCallback(
    async (text: string) => {
      if (text.trim() === value.trim()) return
      isSavingRef.current = true
      try {
        await onSave(text)
      } catch (err) {
        console.error('[OutlineTree] 保存失败:', err)
      } finally {
        isSavingRef.current = false
      }
    },
    [value, onSave],
  )

  const scheduleSave = useCallback(
    (text: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        void doSave(text)
      }, 1500)
    },
    [doSave],
  )

  if (editing) {
    return (
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          scheduleSave(e.target.value)
        }}
        onBlur={() => {
          setEditing(false)
          if (timerRef.current) clearTimeout(timerRef.current)
          void doSave(draft)
        }}
        placeholder={placeholder}
        className={cn(
          'w-full rounded-md border border-input bg-transparent px-2 py-1 text-[11px] outline-none focus-visible:border-ring resize-y min-h-[40px]',
          compact ? 'text-[11px]' : 'text-xs',
        )}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        'flex items-start gap-1.5 px-2 py-1 text-left rounded-md transition-colors w-full',
        selected ? 'bg-primary/10' : 'hover:bg-muted/50',
        compact ? 'text-[11px]' : 'text-xs',
      )}
    >
      {icon}
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span
        className={cn('flex-1 whitespace-pre-wrap break-words', !value && 'text-muted-foreground italic')}
      >
        {value || placeholder}
      </span>
    </button>
  )
}
