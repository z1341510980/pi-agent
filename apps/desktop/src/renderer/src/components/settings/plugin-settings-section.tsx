/**
 * 插件设置分区：设置中心里由插件声明驱动的动态分区。
 *
 * 两层内容，按声明自动出现：
 * 1. 自定义面板（plugin-settings slot 贡献 + 受信 renderer 白名单）——复杂交互 UI
 * 2. 声明式 schema（registerSettings + GET /api/plugins/settings-schema）——标量表单，
 *    读写走既有 GET/PATCH /api/plugins/:pluginId/config（写回 plugins.yml）
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangleIcon, RotateCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  getPlugin,
  getPluginSettingsSchemas,
  getPluginUiContributions,
  updatePluginConfig,
  type PluginSettingField
} from '@/api/plugin-client'
import { getTrustedRenderer } from '@/core/slot-context'
import { SettingsCard, SettingsPageHeader } from './setting-primitives'

/** 设置分区条目：schema 声明与自定义面板贡献合并后的投影 */
export interface PluginSettingsEntry {
  pluginId: string
  label: string
  description?: string
  fields: PluginSettingField[]
}

/**
 * 拉取全部已启用插件的设置声明。
 *
 * 两个来源合并：registerSettings 的 schema（可能为空字段集）+ 贡献了
 * plugin-settings 自定义面板的插件 —— 只声明面板的插件也要有自己的分区。
 */
export function usePluginSettingsEntries(): {
  entries: PluginSettingsEntry[]
  isLoading: boolean
} {
  const schemasQuery = useQuery({
    queryKey: ['plugin-settings-schemas'],
    queryFn: getPluginSettingsSchemas,
    staleTime: 30_000,
  })
  const panelsQuery = useQuery({
    queryKey: ['plugin-ui-contributions', 'settings'],
    queryFn: getPluginUiContributions,
    staleTime: 30_000,
  })

  const entries = useMemo<PluginSettingsEntry[]>(() => {
    const merged = new Map<string, PluginSettingsEntry>()
    // schema 声明优先：label 取 manifest 名
    for (const schema of schemasQuery.data?.plugins ?? []) {
      merged.set(schema.pluginId, {
        pluginId: schema.pluginId,
        label: schema.label,
        ...(schema.description ? { description: schema.description } : {}),
        fields: schema.fields,
      })
    }
    // 只贡献了自定义面板的插件：label 用面板标题（更人类可读），字段集为空
    for (const contribution of panelsQuery.data?.contributions ?? []) {
      if (contribution.slot !== 'plugin-settings') continue
      if (contribution.state !== 'active') continue
      if (merged.has(contribution.pluginId)) continue
      merged.set(contribution.pluginId, {
        pluginId: contribution.pluginId,
        label: contribution.label ?? contribution.pluginId,
        fields: [],
      })
    }
    return [...merged.values()]
  }, [schemasQuery.data, panelsQuery.data])

  return { entries, isLoading: schemasQuery.isLoading || panelsQuery.isLoading }
}

/** 单个字段的受控渲染 */
function SettingFieldRow({
  field,
  value,
  onChange,
}: {
  field: PluginSettingField
  value: unknown
  onChange: (next: unknown) => void
}): ReactElement {
  const stringified = value === undefined || value === null ? '' : String(value)
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{field.label}</Label>
      {field.type === 'boolean' ? (
        <div className="flex items-center gap-2">
          <Switch checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
          <span className="text-xs text-subtle">{field.description}</span>
        </div>
      ) : field.type === 'select' ? (
        <Select value={stringified} onValueChange={(v) => onChange(v)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={field.placeholder ?? `选择${field.label}`} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'textarea' ? (
        <textarea
          className="min-h-20 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-[var(--color-ring)]"
          value={stringified}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          type={field.type === 'number' ? 'number' : 'text'}
          value={field.type === 'number' && typeof value === 'number' ? value : stringified}
          min={field.min}
          max={field.max}
          step={field.step}
          required={field.required}
          placeholder={field.placeholder}
          onChange={(e) => {
            if (field.type === 'number') {
              const n = Number(e.target.value)
              onChange(Number.isFinite(n) ? n : e.target.value)
            } else {
              onChange(e.target.value)
            }
          }}
        />
      )}
      {field.type !== 'boolean' && field.description ? (
        <p className="m-0 text-xs text-subtle">{field.description}</p>
      ) : null}
    </div>
  )
}

/**
 * 单个插件的设置分区：自定义面板在前，schema 表单在后。
 */
export function PluginSettingsSection({
  entry,
}: {
  entry: PluginSettingsEntry
}): ReactElement {
  // 当前 config（plugins.yml 投影）
  const detailQuery = useQuery({
    queryKey: ['plugin-detail', entry.pluginId],
    queryFn: () => getPlugin(entry.pluginId),
  })

  // 该插件是否贡献了 plugin-settings 自定义面板（active 且在白名单内才渲染）
  const contributionsQuery = useQuery({
    queryKey: ['plugin-ui-contributions', 'settings'],
    queryFn: getPluginUiContributions,
    staleTime: 30_000,
  })
  const customPanel = useMemo(() => {
    const contribution = (contributionsQuery.data?.contributions ?? []).find(
      (item) =>
        item.pluginId === entry.pluginId &&
        item.slot === 'plugin-settings' &&
        item.state === 'active',
    )
    if (!contribution) return null
    const renderer = getTrustedRenderer(contribution.rendererKey)
    return renderer ?? null
  }, [contributionsQuery.data, entry.pluginId])

  const config = detailQuery.data?.config ?? {}
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [restartRequired, setRestartRequired] = useState(false)

  // config 到达后按 schema 初始化表单值（config 缺省用字段 default）
  useEffect(() => {
    if (!detailQuery.data) return
    const next: Record<string, unknown> = {}
    for (const field of entry.fields) {
      next[field.key] = config[field.key] !== undefined ? config[field.key] : field.default
    }
    setValues(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config/schema 就绪时初始化一次即可
  }, [detailQuery.data, entry])

  useEffect(() => {
    if (!saveMsg) return
    const t = window.setTimeout(() => setSaveMsg(null), 2500)
    return () => window.clearTimeout(t)
  }, [saveMsg])

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const result = await updatePluginConfig(entry.pluginId, {
        config: { ...config, ...values },
      })
      setRestartRequired(result.restartRequired === true)
      setSaveMsg('设置已保存')
    } catch (err) {
      setSaveMsg(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const CustomPanel = customPanel

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={entry.label}
        description={entry.description ?? `${entry.label} 插件设置`}
      />

      {CustomPanel ? (
        <SettingsCard>
          <h3 className="m-0 pb-2 text-sm font-medium text-text">插件面板</h3>
          <CustomPanel />
        </SettingsCard>
      ) : null}

      {entry.fields.length > 0 ? (
        <SettingsCard>
          <h3 className="m-0 pb-3 text-sm font-medium text-text">基础配置</h3>
          <div className="grid gap-4">
            {entry.fields.map((field) => (
              <SettingFieldRow
                key={field.key}
                field={field}
                value={values[field.key]}
                onChange={(next) => setValues((prev) => ({ ...prev, [field.key]: next }))}
              />
            ))}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="min-w-0 text-xs text-subtle">
                {saveMsg ??
                  (detailQuery.isError
                    ? `配置加载失败：${detailQuery.error instanceof Error ? detailQuery.error.message : '未知错误'}`
                    : '')}
              </div>
              <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                <RotateCwIcon className={`size-3.5 ${saving ? 'animate-spin' : ''}`} />
                {saving ? '保存中...' : '保存设置'}
              </Button>
            </div>
            {restartRequired ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-text">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span>
                  配置已写入 plugins.yml；路由、服务装饰等启动期资源需要重启应用后生效。
                </span>
              </div>
            ) : null}
          </div>
        </SettingsCard>
      ) : null}
    </div>
  )
}
