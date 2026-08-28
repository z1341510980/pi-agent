/**
 * 小说插件设置面板：群聊模式设置。
 *
 * 原寄宿在宿主 Agent 管理页（agent-page.tsx），现按"插件设置由插件自己声明"
 * 迁入 novel-plugin 的 plugin-settings slot 贡献，由桌面设置中心的插件分区渲染。
 * 数据链路不变：GET/PUT /api/plugins/novel/discussion-settings。
 *
 * 2026-08-28 控制平面重排：Moderator 已删除，模型选择项下线；
 * 运行由确定性调度器驱动，本面板仅保留轮数等运行时限制。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  getDiscussionSettings,
  updateDiscussionSettings,
  type DiscussionSettings
} from '@/api/discussion-settings-client'

const DISCUSSION_DEFAULT_MAX_ROUNDS = 20

export function NovelDiscussionSettingsPanel(): ReactElement {
  const queryClient = useQueryClient()
  const [maxRounds, setMaxRounds] = useState<number>(DISCUSSION_DEFAULT_MAX_ROUNDS)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // 获取群聊设置
  const settingsQuery = useQuery({
    queryKey: ['discussion-settings'],
    queryFn: getDiscussionSettings,
  })

  // 设置加载后同步到表单
  useEffect(() => {
    const s: DiscussionSettings | undefined = settingsQuery.data
    if (!s) return
    setMaxRounds(
      typeof s.maxRounds === 'number' ? s.maxRounds : DISCUSSION_DEFAULT_MAX_ROUNDS,
    )
  }, [settingsQuery.data])

  useEffect(() => {
    if (!saveMsg) return
    const t = window.setTimeout(() => setSaveMsg(null), 2500)
    return () => window.clearTimeout(t)
  }, [saveMsg])

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<DiscussionSettings>) => updateDiscussionSettings(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['discussion-settings'] })
      setSaveMsg('群聊设置已保存')
    },
  })

  function handleSave(): void {
    const patch: Partial<DiscussionSettings> = {
      maxRounds,
    }
    updateMutation.mutate(patch)
  }

  return (
    <div className="bg-surface-2 border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">群聊模式设置</h3>
        <p className="text-xs text-muted-foreground mt-1">
          配置群聊讨论的最大轮数。群聊由确定性调度器按场景动作图驱动角色发言与收束。
        </p>
      </div>

      {settingsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground m-0">加载中...</p>
      ) : settingsQuery.isError ? (
        <p className="text-xs text-destructive m-0">
          加载失败：{settingsQuery.error instanceof Error ? settingsQuery.error.message : '未知错误'}
        </p>
      ) : (
        <>
          {/* 最大轮数 */}
          <div className="grid gap-1.5">
            <Label htmlFor="discussion-max-rounds" className="text-xs">
              最大轮数（5-50）
            </Label>
            <Input
              id="discussion-max-rounds"
              type="number"
              min={5}
              max={50}
              step={1}
              value={maxRounds}
              onChange={(e) => {
                const n = Number(e.target.value)
                setMaxRounds(Number.isFinite(n) ? n : DISCUSSION_DEFAULT_MAX_ROUNDS)
              }}
            />
            <p className="text-[10px] text-muted-foreground m-0">
              群聊讨论的最大发言轮数，超出后强制收束
            </p>
          </div>

          {saveMsg && (
            <p className="text-xs text-success m-0">{saveMsg}</p>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? '保存中...' : '保存群聊设置'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
