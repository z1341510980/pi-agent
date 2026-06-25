import { useCallback, type ReactElement } from 'react'
import { useReactFlow } from '@xyflow/react'
import {
  UserPlus,
  FilePlus,
  Swords,
  Lightbulb,
  LayoutGrid,
  Move,
  ZoomIn,
  ZoomOut,
  Maximize,
  Download,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNovelStore } from '@/stores/novel-store'
import {
  createCharacter,
  createChapter,
  createConflict,
  createForeshadow,
} from '@/api/novel-client'

export interface NovelToolbarProps {
  layoutMode: 'auto' | 'free'
  onLayoutModeChange: (mode: 'auto' | 'free') => void
  onRelayout: () => void
  /** 导出当前画布数据为 JSON */
  onExport?: () => void
  onImport?: () => void
}

interface AddButtonProps {
  icon: typeof UserPlus
  label: string
  onClick: () => void
  disabled?: boolean
}

function AddButton({ icon: Icon, label, onClick, disabled }: AddButtonProps): ReactElement {
  return (
    <Button size="sm" variant="ghost" onClick={onClick} disabled={disabled} title={`添加${label}`}>
      <Icon className="size-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )
}

export function NovelToolbar({
  layoutMode,
  onLayoutModeChange,
  onRelayout,
  onExport,
  onImport,
}: NovelToolbarProps): ReactElement {
  const currentProjectId = useNovelStore((s) => s.currentProjectId)
  const upsertCharacter = useNovelStore((s) => s.upsertCharacter)
  const upsertChapter = useNovelStore((s) => s.upsertChapter)
  const upsertConflict = useNovelStore((s) => s.upsertConflict)
  const upsertForeshadow = useNovelStore((s) => s.upsertForeshadow)
  const chapters = useNovelStore((s) => s.chapters)

  const { zoomIn, zoomOut, fitView } = useReactFlow()

  const noProject = !currentProjectId

  const handleAddCharacter = useCallback(async () => {
    if (!currentProjectId) return
    try {
      const character = await createCharacter(currentProjectId, {
        name: `新角色 ${Date.now().toString().slice(-4)}`,
      })
      upsertCharacter(character)
    } catch {
      // 静默失败（可在通知中心提示）
    }
  }, [currentProjectId, upsertCharacter])

  const handleAddChapter = useCallback(async () => {
    if (!currentProjectId) return
    const nextNumber = chapters.length > 0
      ? Math.max(...chapters.map((c) => c.chapterNumber)) + 1
      : 1
    try {
      const chapter = await createChapter(currentProjectId, {
        chapterNumber: nextNumber,
        narrativeTask: {
          description: '推进主线剧情',
          type: 'advance_mainline',
          priority: 'medium',
        },
      })
      upsertChapter(chapter)
    } catch {
      // 静默失败
    }
  }, [currentProjectId, chapters, upsertChapter])

  const handleAddConflict = useCallback(async () => {
    if (!currentProjectId) return
    try {
      const conflict = await createConflict(currentProjectId, {
        description: '新的冲突',
        type: 'interest',
        intensity: 5,
        stage: 'latent',
      })
      upsertConflict(conflict)
    } catch {
      // 静默失败
    }
  }, [currentProjectId, upsertConflict])

  const handleAddForeshadow = useCallback(async () => {
    if (!currentProjectId) return
    try {
      const foreshadow = await createForeshadow(currentProjectId, {
        description: '新的伏笔',
        category: '事件',
        status: 'planned',
      })
      upsertForeshadow(foreshadow)
    } catch {
      // 静默失败
    }
  }, [currentProjectId, upsertForeshadow])

  return (
    <div className="flex items-center gap-1 px-3 h-11 border-b border-border bg-surface-1 shrink-0">
      {/* 添加实体 */}
      <div className="flex items-center gap-0.5">
        <AddButton icon={UserPlus} label="角色" onClick={handleAddCharacter} disabled={noProject} />
        <AddButton icon={FilePlus} label="章节" onClick={handleAddChapter} disabled={noProject} />
        <AddButton icon={Swords} label="冲突" onClick={handleAddConflict} disabled={noProject} />
        <AddButton icon={Lightbulb} label="伏笔" onClick={handleAddForeshadow} disabled={noProject} />
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 布局模式 */}
      <div className="flex items-center gap-0.5">
        <Button
          size="sm"
          variant={layoutMode === 'auto' ? 'secondary' : 'ghost'}
          onClick={() => onLayoutModeChange('auto')}
          title="自动布局"
        >
          <LayoutGrid className="size-3.5" />
          <span className="hidden sm:inline">自动</span>
        </Button>
        <Button
          size="sm"
          variant={layoutMode === 'free' ? 'secondary' : 'ghost'}
          onClick={() => onLayoutModeChange('free')}
          title="自由拖拽"
        >
          <Move className="size-3.5" />
          <span className="hidden sm:inline">自由</span>
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onRelayout}
          title="重新排列"
          disabled={noProject}
        >
          <Maximize className="size-3.5" />
        </Button>
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      {/* 缩放控制 */}
      <div className="flex items-center gap-0.5">
        <Button size="icon-sm" variant="ghost" onClick={() => zoomIn({ duration: 200 })} title="放大">
          <ZoomIn className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => zoomOut({ duration: 200 })} title="缩小">
          <ZoomOut className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => fitView({ padding: 0.2, duration: 300 })}
          title="适应视图"
        >
          <Maximize className="size-3.5" />
        </Button>
      </div>

      {/* 右侧：导出/导入 */}
      <div className="ml-auto flex items-center gap-0.5">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onImport}
          title="导入"
          className={cn(!onImport && 'hidden')}
        >
          <Upload className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onExport}
          title="导出"
          className={cn(!onExport && 'hidden')}
        >
          <Download className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
