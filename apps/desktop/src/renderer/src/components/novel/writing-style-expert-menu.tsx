import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Feather, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { toastError } from '@/hooks/use-toast'
import {
  getWritingStyleProfile,
  saveWritingStyleProfile,
} from '@/api/novel-client'
import {
  DEFAULT_NOVEL_STYLE_EXPERTS,
  type NovelStyleExpert,
  type NovelWritingStyleProfile,
  type NovelWritingStyleProfileInput,
} from '@repo/shared/novel'

interface WritingStyleExpertMenuProps {
  projectId: string
  onOpenSettings: () => void
}

function toInput(profile: NovelWritingStyleProfile, styleExperts: NovelStyleExpert[]): NovelWritingStyleProfileInput {
  const { id: _id, projectId: _projectId, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = profile
  return { ...input, styleExperts }
}

export function WritingStyleExpertMenu({ projectId, onOpenSettings }: WritingStyleExpertMenuProps): ReactElement {
  const [profile, setProfile] = useState<NovelWritingStyleProfile | null>(null)
  const [experts, setExperts] = useState<NovelStyleExpert[]>(DEFAULT_NOVEL_STYLE_EXPERTS)
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await getWritingStyleProfile(projectId)
      setProfile(next)
      setExperts(next?.styleExperts?.length ? next.styleExperts : DEFAULT_NOVEL_STYLE_EXPERTS)
    } catch (error) {
      toastError('文风专家团加载失败', error instanceof Error ? error.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (expert: NovelStyleExpert, enabled: boolean): Promise<void> => {
    if (!profile || savingId) return
    const nextExperts = experts.map((item) => item.id === expert.id ? { ...item, enabled } : item)
    setExperts(nextExperts)
    setSavingId(expert.id)
    try {
      const saved = await saveWritingStyleProfile(projectId, toInput(profile, nextExperts))
      setProfile(saved)
      setExperts(saved.styleExperts?.length ? saved.styleExperts : nextExperts)
    } catch (error) {
      setExperts(experts)
      toastError('文风专家团保存失败', error instanceof Error ? error.message : '未知错误')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          title="文风专家团"
          className="gap-1.5 text-subtle hover:text-text"
        >
          <Feather className="size-3.5" />
          <span className="hidden lg:inline text-xs">文风专家团</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>文风专家团</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {experts.map((expert) => (
          <DropdownMenuCheckboxItem
            key={expert.id}
            checked={expert.enabled}
            disabled={!profile || savingId !== null}
            onCheckedChange={(checked) => void toggle(expert, checked)}
          >
            <span className="min-w-0">
              <span className="block">{expert.name}</span>
              <span className="block truncate text-[10px] text-muted-foreground">来源：{expert.sourceTitle}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSettings}>
          <Settings2 className="size-3.5" />
          打开专家团详细设置
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
