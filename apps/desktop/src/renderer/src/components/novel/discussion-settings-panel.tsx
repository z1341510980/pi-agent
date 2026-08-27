/**
 * 小说插件设置面板：群聊模式设置。
 *
 * 原寄宿在宿主 Agent 管理页（agent-page.tsx），现按"插件设置由插件自己声明"
 * 迁入 novel-plugin 的 plugin-settings slot 贡献，由桌面设置中心的插件分区渲染。
 * 数据链路不变：GET/PUT /api/plugins/novel/discussion-settings。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { getApi } from '@/api'
import {
  getDiscussionSettings,
  updateDiscussionSettings,
  type DiscussionSettings
} from '@/api/discussion-settings-client'

interface ProviderBrief {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

const DISCUSSION_DEFAULT_MAX_ROUNDS = 20

export function NovelDiscussionSettingsPanel(): ReactElement {
  const queryClient = useQueryClient()
  const [moderatorProvider, setModeratorProvider] = useState('')
  const [moderatorModelId, setModeratorModelId] = useState('')
  const [maxRounds, setMaxRounds] = useState<number>(DISCUSSION_DEFAULT_MAX_ROUNDS)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // 获取群聊设置
  const settingsQuery = useQuery({
    queryKey: ['discussion-settings'],
    queryFn: getDiscussionSettings,
  })

  // 获取 provider 列表（用于下拉选择）
  const providersQuery = useQuery({
    queryKey: ['providers-for-discussion'],
    queryFn: () => getApi<ProviderBrief[]>('/api/providers'),
  })

  const providers = providersQuery.data ?? []

  // 当前选中 provider 下的可选模型
  const availableModels = providers.find((p) => p.id === moderatorProvider)?.models ?? []

  // 设置加载后同步到表单
  useEffect(() => {
    const s: DiscussionSettings | undefined = settingsQuery.data
    if (!s) return
    setModeratorProvider(s.moderatorModel?.provider ?? '')
    setModeratorModelId(s.moderatorModel?.modelId ?? '')
    setMaxRounds(
      typeof s.maxRounds === 'number' ? s.maxRounds : DISCUSSION_DEFAULT_MAX_ROUNDS,
    )
  }, [settingsQuery.data])

  // 当 provider 切换后，若当前 modelId 不在新 provider 的模型列表中，则清空
  useEffect(() => {
    if (
      moderatorModelId &&
      availableModels.length > 0 &&
      !availableModels.some((m) => m.id === moderatorModelId)
    ) {
      setModeratorModelId('')
    }
  }, [moderatorProvider, moderatorModelId, availableModels])

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
    if (moderatorProvider.trim() && moderatorModelId.trim()) {
      patch.moderatorModel = {
        provider: moderatorProvider.trim(),
        modelId: moderatorModelId.trim(),
      }
    }
    updateMutation.mutate(patch)
  }

  return (
    <div className="bg-surface-2 border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">群聊模式设置</h3>
        <p className="text-xs text-muted-foreground mt-1">
          配置群聊讨论的 Moderator 模型与最大轮数。Moderator 负责协调角色发言顺序与收束讨论。
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
          {/* Moderator 模型选择 */}
          <div className="grid gap-2">
            <Label className="text-xs">Moderator 模型</Label>
            {providersQuery.isLoading ? (
              <p className="text-xs text-muted-foreground m-0">加载 Provider 列表...</p>
            ) : providersQuery.isError ? (
              <div className="grid gap-1.5">
                <Input
                  value={moderatorProvider}
                  onChange={(e) => setModeratorProvider(e.target.value)}
                  placeholder="provider id（例如 openai）"
                />
                <Input
                  value={moderatorModelId}
                  onChange={(e) => setModeratorModelId(e.target.value)}
                  placeholder="model id（例如 gpt-4o）"
                />
                <p className="text-[10px] text-muted-foreground m-0">
                  Provider 列表加载失败，可手动输入
                </p>
              </div>
            ) : providers.length === 0 ? (
              <div className="grid gap-1.5">
                <Input
                  value={moderatorProvider}
                  onChange={(e) => setModeratorProvider(e.target.value)}
                  placeholder="provider id（例如 openai）"
                />
                <Input
                  value={moderatorModelId}
                  onChange={(e) => setModeratorModelId(e.target.value)}
                  placeholder="model id（例如 gpt-4o）"
                />
                <p className="text-[10px] text-muted-foreground m-0">
                  暂无已注册 Provider，可手动输入
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="discussion-provider" className="text-[10px] text-muted-foreground">
                    Provider
                  </Label>
                  <Select
                    value={moderatorProvider}
                    onValueChange={(v) => {
                      setModeratorProvider(v)
                      setModeratorModelId('')
                    }}
                  >
                    <SelectTrigger id="discussion-provider" className="w-full">
                      <SelectValue placeholder="选择 Provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name || p.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="discussion-model" className="text-[10px] text-muted-foreground">
                    Model
                  </Label>
                  <Select
                    value={moderatorModelId}
                    onValueChange={setModeratorModelId}
                    disabled={!moderatorProvider || availableModels.length === 0}
                  >
                    <SelectTrigger id="discussion-model" className="w-full">
                      <SelectValue
                        placeholder={
                          !moderatorProvider
                            ? '先选择 Provider'
                            : availableModels.length === 0
                              ? '该 Provider 无模型'
                              : '选择模型'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name || m.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

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
              群聊讨论的最大发言轮数，超出后 Moderator 将强制收束
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
