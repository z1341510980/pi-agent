import { useCallback, type ReactElement } from 'react'
import { ChevronRight, ChevronDown, Plus, Sparkles, Wand2, BookText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  createVolume,
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
      {/* 全书大纲：点击选中项目，在右边栏编辑 */}
      <OutlinePreviewRow
        label="全书大纲"
        value={project.outline ?? ''}
        placeholder="点击编写全书大纲..."
        selected={selectedNodeId === project.id}
        onClick={() => selectNode(project.id, 'project')}
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
                <OutlinePreviewRow
                  label="卷纲"
                  value={vol.outline ?? ''}
                  placeholder="点击编写卷纲..."
                  selected={selectedNodeId === vol.id}
                  onClick={() => selectNode(vol.id, 'volume')}
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
                    onOutlineSelect={() => selectNode(ch.id, 'chapter')}
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
              onOutlineSelect={() => selectNode(ch.id, 'chapter')}
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
  onOutlineSelect: () => void
}

function ChapterRow({
  chapter,
  selected,
  isPlayhead,
  onClick,
  onManualArrange,
  onAiArrange,
  onOutlineSelect,
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
        <OutlinePreviewRow
          label="章纲"
          value={chapter.outline ?? ''}
          placeholder="点击编写章纲（生成的统一起点）..."
          selected={selected}
          onClick={onOutlineSelect}
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

// ── 大纲预览行（点击选中，在右边栏编辑） ──

interface OutlinePreviewRowProps {
  label: string
  value: string
  placeholder: string
  onClick: () => void
  icon?: ReactElement
  selected?: boolean
  compact?: boolean
}

function OutlinePreviewRow({
  label,
  value,
  placeholder,
  onClick,
  icon,
  selected,
  compact,
}: OutlinePreviewRowProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-1.5 px-2 py-1 text-left rounded-md transition-colors w-full text-[11px]',
        selected ? 'bg-primary/10' : 'hover:bg-muted/50',
      )}
    >
      {icon}
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span
        className={cn(
          'flex-1 break-words overflow-hidden',
          '[display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]',
          !value && 'text-muted-foreground italic',
        )}
      >
        {value || placeholder}
      </span>
    </button>
  )
}
