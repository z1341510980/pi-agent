import { useCallback, type ReactElement } from 'react'
import { ChevronDown, Plus, Wand2, BookText } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  createChapter,
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
  const upsertChapter = useNovelStore((s) => s.upsertChapter)
  const queryClient = useQueryClient()

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
      // 刷新 React Query 缓存，避免后台 refetch 返回旧数据覆盖本地新建
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', project.id] })
    } catch (err) {
      console.error('[OutlineTree] 创建卷失败:', err)
    }
  }, [volumes, project.id, upsertVolume, queryClient])

  // 新建章：在指定卷内创建，避免章节游离在所有卷之外
  // 章节号全局唯一（不是卷内唯一），取所有章节最大号 +1
  // volumeId 必传：用户在大纲树点卷内"+ 新建章"按钮调用，确保新章直接归属该卷
  const handleCreateChapter = useCallback(async (volumeId: string) => {
    if (!project.id) return
    try {
      const nextNumber =
        chapters.length > 0 ? Math.max(...chapters.map((c) => c.chapterNumber)) + 1 : 1
      const chapter = await createChapter(project.id, {
        chapterNumber: nextNumber,
        narrativeTask: {
          description: '待补充',
          type: 'manual',
          priority: 'medium',
        },
        volumeId,
      })
      upsertChapter(chapter)
      // 确保目标卷已展开，让新创建的章节立即可见
      if (!expandedVolumes.includes(volumeId)) {
        toggleExpandedVolume(volumeId)
      }
      // 选中新创建的章节，便于右侧栏立即编辑
      selectNode(chapter.id, 'chapter')
      setPlayheadChapter(chapter.chapterNumber)
      // 刷新 React Query 缓存，与 handleStartCreationAt 保持一致，
      // 避免后台 refetch 返回旧数据（不含新章节）触发 loadProjectData 全量替换擦除新章节
      void queryClient.invalidateQueries({ queryKey: ['novel-project-data', project.id] })
    } catch (err) {
      console.error('[OutlineTree] 创建章失败:', err)
    }
  }, [chapters, project.id, upsertChapter, selectNode, setPlayheadChapter, queryClient, expandedVolumes, toggleExpandedVolume])

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

      {/* 新建卷按钮（新建章入口在卷内，避免章节游离在所有卷之外） */}
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={handleCreateVolume}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-text hover:bg-muted/50 rounded-md transition-[color,background-color,transform] active:scale-[0.96]"
        >
          <Plus className="size-3" /> 新建卷
        </button>
      </div>

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
                <ChevronDown
                  className={cn(
                    'size-3 shrink-0 transition-transform duration-200 ease-out',
                    !expanded && '-rotate-90',
                  )}
                />
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
                />
                {volChapters.map((ch) => (
                  <ChapterRow
                    key={ch.id}
                    chapter={ch}
                    selected={selectedNodeId === ch.id}
                    isPlayhead={playheadChapter === ch.chapterNumber}
                    onClick={() => handleSelectChapter(ch)}
                    onAiArrange={() => onAiArrange(ch)}
                    onOutlineSelect={() => handleSelectChapter(ch)}
                  />
                ))}
                {/* 卷内新建章：新章节直接归属该卷，不会游离到所有卷之外 */}
                <button
                  type="button"
                  onClick={() => handleCreateChapter(vol.id)}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-text hover:bg-muted/50 rounded-md transition-[color,background-color,transform] active:scale-[0.96]"
                >
                  <Plus className="size-3" /> 新建章
                </button>
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
              onAiArrange={() => onAiArrange(ch)}
              onOutlineSelect={() => handleSelectChapter(ch)}
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
  onAiArrange: () => void
  onOutlineSelect: () => void
}

function ChapterRow({
  chapter,
  selected,
  isPlayhead,
  onClick,
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
        <span className="text-muted-foreground shrink-0 tabular-nums">第{chapter.chapterNumber}章</span>
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
        />
        <div className="flex items-center gap-1 px-1">
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
}

function OutlinePreviewRow({
  label,
  value,
  placeholder,
  onClick,
  icon,
  selected,
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
