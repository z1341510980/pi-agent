import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { ChevronDown, Plus, Wand2, BookText, Zap, RefreshCw, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { useNovelDataStore } from '@/stores/novel-data-store'
import { useNovelUiStore } from '@/stores/novel-ui-store'
import { useNovelBeatStore } from '@/stores/novel-beat-store'
import {
  createChapter,
  createVolume,
  generateChapterBeatPlan,
  updateBeatPlan,
  type NovelProject,
  type NovelChapter,
  type NovelVolume,
} from '@/api/novel-client'
import { Button } from '@/components/ui/button'
import {
  BEAT_FUNCTION_LABELS,
  BEAT_FUNCTION_ACCENTS,
  BEAT_STATUS_LABELS,
} from './sidebar/beat-labels'
import { BeatEditForm, type BeatEditFormFields } from './sidebar/beat-edit-form'

// ── 主组件 ──

export interface OutlineTreeProps {
  project: NovelProject
  volumes: NovelVolume[]
  chapters: NovelChapter[]
  onManualArrange: (chapter: NovelChapter) => void
  onAiArrange: (chapter: NovelChapter) => void
  /** 删除章节（含后端重排与运行锁校验）；由侧栏统一处理后端错误呈现 */
  onDeleteChapter?: (chapter: NovelChapter) => void
}

export function OutlineTree({
  project,
  volumes,
  chapters,
  onAiArrange,
  onDeleteChapter,
}: OutlineTreeProps): ReactElement {
  const selectedNodeId = useNovelUiStore((s) => s.selectedNodeId)
  const playheadChapter = useNovelUiStore((s) => s.playheadChapter)
  const expandedVolumes = useNovelUiStore((s) => s.expandedVolumes)
  const selectNode = useNovelUiStore((s) => s.selectNode)
  const setPlayheadChapter = useNovelUiStore((s) => s.setPlayheadChapter)
  const setMatrixScrollTarget = useNovelUiStore((s) => s.setMatrixScrollTarget)
  const toggleExpandedVolume = useNovelUiStore((s) => s.toggleExpandedVolume)
  const upsertVolume = useNovelDataStore((s) => s.upsertVolume)
  const upsertChapter = useNovelDataStore((s) => s.upsertChapter)
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
          className="flex items-center gap-1 px-2 py-1 text-micro text-muted-foreground hover:text-text hover:bg-muted/50 rounded-md transition-[color,background-color,transform] active:scale-[0.96]"
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
                    projectId={project.id}
                    chapter={ch}
                    selected={selectedNodeId === ch.id}
                    isPlayhead={playheadChapter === ch.chapterNumber}
                    onClick={() => handleSelectChapter(ch)}
                    onAiArrange={() => onAiArrange(ch)}
                    onOutlineSelect={() => handleSelectChapter(ch)}
                    onDelete={onDeleteChapter ? () => onDeleteChapter(ch) : undefined}
                  />
                ))}
                {/* 卷内新建章：新章节直接归属该卷，不会游离到所有卷之外 */}
                <button
                  type="button"
                  onClick={() => handleCreateChapter(vol.id)}
                  className="flex items-center gap-1 px-2 py-1 text-micro text-muted-foreground hover:text-text hover:bg-muted/50 rounded-md transition-[color,background-color,transform] active:scale-[0.96]"
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
              projectId={project.id}
              chapter={ch}
              selected={selectedNodeId === ch.id}
              isPlayhead={playheadChapter === ch.chapterNumber}
              onClick={() => handleSelectChapter(ch)}
              onAiArrange={() => onAiArrange(ch)}
              onOutlineSelect={() => handleSelectChapter(ch)}
              onDelete={onDeleteChapter ? () => onDeleteChapter(ch) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── 章节行 ──

interface ChapterRowProps {
  projectId: string
  chapter: NovelChapter
  selected: boolean
  isPlayhead: boolean
  onClick: () => void
  onAiArrange: () => void
  onOutlineSelect: () => void
  onDelete?: () => void
}

function ChapterRow({
  projectId,
  chapter,
  selected,
  isPlayhead,
  onClick,
  onAiArrange,
  onOutlineSelect,
  onDelete,
}: ChapterRowProps): ReactElement {
  const beat = useNovelBeatStore((s) =>
    s.beats.find((item) => item.chapterNumber === chapter.chapterNumber)
  )
  const upsertBeat = useNovelBeatStore((s) => s.upsertBeat)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState(false)
  const isPublished = chapter.status === 'published'

  // 章号变化（删章重排）时重置行内交互状态
  useEffect(() => {
    setEditing(false)
    setError('')
    setHint(false)
  }, [chapter.chapterNumber])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    setError('')
    setHint(false)
    try {
      const result = await generateChapterBeatPlan(projectId, chapter.chapterNumber)
      upsertBeat(result.beat)
      setHint(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`节拍生成失败：${message}`)
      console.error('[OutlineTree] 单章节拍生成失败:', err)
    } finally {
      setGenerating(false)
    }
  }, [projectId, chapter.chapterNumber, upsertBeat])

  const handleSave = useCallback(
    async (fields: BeatEditFormFields) => {
      if (!beat) return
      setSaving(true)
      try {
        const updated = await updateBeatPlan(beat.id, fields)
        upsertBeat(updated)
        setEditing(false)
        setError('')
      } catch (err) {
        console.error('[OutlineTree] 保存节拍失败:', err)
        setError('保存节拍失败，请重试')
      } finally {
        setSaving(false)
      }
    },
    [beat, upsertBeat]
  )

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 text-micro rounded-md transition-colors text-left',
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
        {/* 节拍行：本章在整卷戏剧结构中的职责（与侧栏节拍表共享数据源） */}
        {editing && beat ? (
          <BeatEditForm
            initial={{
              dramaticFunction: beat.dramaticFunction,
              emotionalDebt: beat.emotionalDebt,
              payoff: beat.payoff,
              arcPosition: beat.arcPosition,
              summary: beat.summary,
            }}
            saving={saving}
            onSave={handleSave}
            onCancel={() => setEditing(false)}
          />
        ) : beat ? (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => !isPublished && setEditing(true)}
              title={
                isPublished
                  ? `${BEAT_FUNCTION_LABELS[beat.dramaticFunction]}｜已发布章节只读`
                  : `${BEAT_FUNCTION_LABELS[beat.dramaticFunction]}｜点击编辑本章节拍`
              }
              className="flex min-w-0 flex-1 items-center gap-1 px-2 py-0.5 text-left text-nano rounded-md hover:bg-muted/50 transition-colors"
            >
              <Zap
                className={cn(
                  'size-3 shrink-0',
                  BEAT_FUNCTION_ACCENTS[beat.dramaticFunction]
                )}
              />
              <span className={cn('shrink-0', BEAT_FUNCTION_ACCENTS[beat.dramaticFunction])}>
                {BEAT_FUNCTION_LABELS[beat.dramaticFunction]}
              </span>
              {beat.status !== 'planned' && (
                <span className="shrink-0 text-muted-foreground">
                  ·{BEAT_STATUS_LABELS[beat.status]}
                </span>
              )}
              {beat.summary && (
                <span className="truncate text-muted-foreground">{beat.summary}</span>
              )}
            </button>
            {!isPublished && (
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                title="重新生成本章节拍（只替换这一行，不动其他章节的节拍）"
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-text transition-colors"
              >
                <RefreshCw className={cn('size-3', generating && 'animate-spin')} />
              </button>
            )}
          </div>
        ) : !isPublished ? (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-1 px-2 py-0.5 text-nano text-muted-foreground hover:text-text hover:bg-muted/50 rounded-md transition-colors"
            title="为本章生成节拍（需要所属卷已填写卷纲）"
          >
            <Zap className="size-3" />
            {generating ? '节拍生成中...' : '生成本章节拍'}
          </button>
        ) : null}
        {hint && (
          <div className="px-2 text-nano text-muted-foreground">
            已更新本章节拍；若与后续节拍结构冲突，建议在节拍表分组整卷重排
          </div>
        )}
        {error && <div className="px-2 text-nano text-destructive">{error}</div>}
        <div className="flex items-center gap-1 px-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-nano"
            onClick={onAiArrange}
            disabled={!chapter.outline?.trim()}
            title="AI编排"
          >
            <Wand2 className="size-3" /> AI编排
          </Button>
          {onDelete && (
            <button
              type="button"
              title={
                isPublished
                  ? '已发布章节不能删除，请先进入修订或撤回流程'
                  : `删除第${chapter.chapterNumber}章（后续章节自动前移重排）`
              }
              onClick={() => {
                if (
                  window.confirm(
                    `确认删除第${chapter.chapterNumber}章「${chapter.title || '未命名'}」？后续章节将自动前移重排，此操作不可撤销。`,
                  )
                ) {
                  onDelete()
                }
              }}
              disabled={isPublished}
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            >
              <Trash2 className="size-3" />
            </button>
          )}
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
        'flex items-start gap-1.5 px-2 py-1 text-left rounded-md transition-colors w-full text-micro',
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
