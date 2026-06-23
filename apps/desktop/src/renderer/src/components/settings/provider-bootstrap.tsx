import type { FormEvent, ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { postApi } from '../../api'
import { providerPresets, presetOptions } from './provider-manager'

export type ProviderSettings = {
  provider: string
  model: string
  apiKey: string
}

const storageKey = 'pi-agent.provider'

const defaultSettings: ProviderSettings = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
  apiKey: ''
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function ProviderBootstrap(): ReactElement {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState<ProviderSettings>(() => loadProviderSettings())
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (saveState !== 'saved') return

    const timer = window.setTimeout(() => setSaveState('idle'), 1800)
    return () => window.clearTimeout(timer)
  }, [saveState])

  function updateSettings(field: keyof ProviderSettings, value: string): void {
    setSettings((current) => ({
      ...current,
      [field]: value
    }))
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setSaveState('saving')
    setSaveError(null)
    try {
      const preset = providerPresets[settings.provider]
      if (!preset) {
        throw new Error(`不支持的 Provider "${settings.provider}"，请在 Provider 管理中配置`)
      }

      // 构建 models：使用 preset 的模型，如果用户输入的 model 不在 preset 中，添加它
      const models = [...preset.models]
      if (settings.model && !models.some((m) => m.id === settings.model)) {
        models.push({ id: settings.model, name: settings.model })
      }
      if (models.length === 0) {
        throw new Error('请填写模型名称')
      }

      const label = presetOptions.find((o) => o.value === settings.provider)?.label ?? settings.provider

      await postApi('/api/providers', {
        id: settings.provider,
        name: label,
        baseUrl: preset.baseUrl,
        apiKey: settings.apiKey,
        api: preset.api,
        authHeader: true,
        models,
      })

      // Provider 变更后，使模型列表缓存失效，让对话界面的模型选择器重新获取
      void queryClient.invalidateQueries({ queryKey: ['agui-models'] })

      window.localStorage.setItem(storageKey, JSON.stringify(settings))
      setSaveState('saved')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
      setSaveState('error')
    }
  }

  return (
    <form className="grid gap-4 min-h-0 overflow-auto p-4 align-content-start" onSubmit={saveSettings}>
      <div>
        <p className="text-subtle text-xs font-[760] m-0">Provider bootstrap</p>
        <h2 className="text-[22px] font-[780] leading-tight mt-0.5">模型连接</h2>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="provider">Provider</Label>
        <Select
          value={settings.provider}
          onValueChange={(value) => updateSettings('provider', value)}
        >
          <SelectTrigger id="provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="anthropic">Anthropic</SelectItem>
            <SelectItem value="gemini">Gemini</SelectItem>
            <SelectItem value="deepseek">DeepSeek</SelectItem>
            <SelectItem value="custom">自定义</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="model">模型</Label>
        <Input
          id="model"
          value={settings.model}
          onChange={(event) => updateSettings('model', event.target.value)}
          placeholder="gpt-4.1-mini"
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="apiKey">API Key</Label>
        <Input
          id="apiKey"
          type="password"
          value={settings.apiKey}
          onChange={(event) => updateSettings('apiKey', event.target.value)}
          placeholder="sk-..."
        />
      </div>

      <Button type="submit" disabled={saveState === 'saving'}>
        {saveState === 'saving' ? '保存中...' : '保存并注册到后端'}
      </Button>

      <p className="text-muted-foreground text-xs leading-relaxed m-0" role="status">
        {saveState === 'saved'
          ? 'Provider 已注册到后端，可立即使用。'
          : saveState === 'error'
            ? (saveError ?? '保存失败')
            : '保存时会将 Provider 注册到后端 ModelRegistry。'}
      </p>
    </form>
  )
}

function loadProviderSettings(): ProviderSettings {
  if (typeof window === 'undefined') return defaultSettings

  const raw = window.localStorage.getItem(storageKey)
  if (!raw) return defaultSettings

  try {
    return {
      ...defaultSettings,
      ...(JSON.parse(raw) as Partial<ProviderSettings>)
    }
  } catch {
    return defaultSettings
  }
}
