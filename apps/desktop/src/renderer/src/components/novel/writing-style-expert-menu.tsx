import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
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
  STYLE_TEAM_DIMENSION_LABELS,
  type StyleTeamDimension,
} from '@/api/novel-client'
import {
  type NovelStyleExpert,
  type NovelWritingStyleProfile,
  type NovelWritingStyleProfileInput,
} from '@repo/shared/novel'

interface WritingStyleExpertMenuProps {
  projectId: string
  onOpenSettings: () => void
}

/** 可召集文风专家总数上限 */
const MAX_CONVENABLE_EXPERTS = 8

/** 维度徽标文案：未知维度值兜底显示原值 */
function dimensionBadgeLabel(dimension: string): string {
  return STYLE_TEAM_DIMENSION_LABELS[dimension as StyleTeamDimension] ?? dimension
}

interface StyleExpertGroup {
  key: string
  teamKey?: string
  sourceTitle: string
  experts: NovelStyleExpert[]
}

/** 菜单项按 teamKey（专家团）分组；无 teamKey 的历史/手动专家按 sourceTitle 兜底分组 */
function groupStyleExperts(experts: NovelStyleExpert[]): StyleExpertGroup[] {
  const groups = new Map<string, StyleExpertGroup>()
  for (const expert of experts) {
    const key = expert.teamKey ?? expert.sourceTitle
    const existing = groups.get(key)
    if (existing) {
      existing.experts.push(expert)
    } else {
      groups.set(key, {
        key,
        teamKey: expert.teamKey,
        sourceTitle: expert.sourceTitle,
        experts: [expert],
      })
    }
  }
  return Array.from(groups.values())
}

function toInput(profile: NovelWritingStyleProfile, styleExperts: NovelStyleExpert[]): NovelWritingStyleProfileInput {
  const { id: _id, projectId: _projectId, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = profile
  return { ...input, styleExperts }
}

export function WritingStyleExpertMenu({ projectId, onOpenSettings }: WritingStyleExpertMenuProps): ReactElement {
  const [profile, setProfile] = useState<NovelWritingStyleProfile | null>(null)
  const [experts, setExperts] = useState<NovelStyleExpert[]>([])
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)

  const expertGroups = useMemo(() => groupStyleExperts(experts), [experts])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await getWritingStyleProfile(projectId)
      setProfile(next)
      // 没有蒸馏过就是空列表；不再用占位默认专家撑场面（它们没有手法与证据）
      setExperts(next?.styleExperts ?? [])
    } catch (error) {
      toastError('文风专家团加载失败', error instanceof Error ? error.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const saveExperts = async (nextExperts: NovelStyleExpert[], lockId: string): Promise<void> => {
    if (!profile) return
    setExperts(nextExperts)
    setSavingId(lockId)
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

  const toggle = async (expert: NovelStyleExpert, enabled: boolean): Promise<void> => {
    if (!profile || savingId) return
    const nextExperts = experts.map((item) => (item.id === expert.id ? { ...item, enabled } : item))
    await saveExperts(nextExperts, expert.id)
  }

  // 组级全选：勾选=启用组内全部专家，受总数上限约束，超额部分不勾选
  const toggleGroup = async (group: StyleExpertGroup, checked: boolean): Promise<void> => {
    if (!profile || savingId) return
    let nextExperts: NovelStyleExpert[]
    if (checked) {
      const pending = group.experts.filter((expert) => !expert.enabled)
      if (pending.length === 0) return
      const slots = MAX_CONVENABLE_EXPERTS - experts.filter((expert) => expert.enabled).length
      if (slots <= 0) {
        toastError('最多召集 8 个文风专家')
        return
      }
      const enableIds = new Set(pending.slice(0, slots).map((expert) => expert.id))
      if (pending.length > slots) toastError('最多召集 8 个文风专家')
      nextExperts = experts.map((item) => (enableIds.has(item.id) ? { ...item, enabled: true } : item))
    } else {
      const groupIds = new Set(group.experts.map((expert) => expert.id))
      if (!group.experts.some((expert) => expert.enabled)) return
      nextExperts = experts.map((item) => (groupIds.has(item.id) ? { ...item, enabled: false } : item))
    }
    await saveExperts(nextExperts, group.key)
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
        {experts.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-muted-foreground">
            还没有蒸馏出文风专家。打开详细设置从参考小说蒸馏。
          </div>
        ) : null}
        {expertGroups.map((group, groupIndex) => (
          <div key={group.key}>
            {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuCheckboxItem
              checked={group.experts.every((expert) => expert.enabled)}
              disabled={!profile || savingId !== null}
              onCheckedChange={(checked) => void toggleGroup(group, checked)}
              className="text-xs"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-[11px] text-muted-foreground">
                  {group.teamKey ? `《${group.sourceTitle}》· 专家团` : `《${group.sourceTitle}》`}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">全选本团队</span>
              </span>
            </DropdownMenuCheckboxItem>
            {group.experts.map((expert) => (
              <DropdownMenuCheckboxItem
                key={expert.id}
                checked={expert.enabled}
                disabled={!profile || savingId !== null}
                onCheckedChange={(checked) => void toggle(expert, checked)}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{expert.name}</span>
                    {expert.dimension ? (
                      <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
                        {dimensionBadgeLabel(expert.dimension)}
                      </span>
                    ) : null}
                    {expert.reviewStatus === 'draft' ? (
                      <span className="shrink-0 text-[10px] text-amber-600">待审核</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">来源：{expert.sourceTitle}</span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </div>
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
