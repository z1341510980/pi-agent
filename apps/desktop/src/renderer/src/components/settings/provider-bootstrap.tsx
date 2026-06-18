import type { FormEvent, ReactElement } from 'react'
import { useEffect, useState } from 'react'
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

export function ProviderBootstrap(): ReactElement {
  const [settings, setSettings] = useState<ProviderSettings>(() => loadProviderSettings())
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle')

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

  function saveSettings(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    window.localStorage.setItem(storageKey, JSON.stringify(settings))
    setSaveState('saved')
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

      <Button type="submit">保存本机设置</Button>

      <p className="text-muted text-xs leading-relaxed m-0" role="status">
        {saveState === 'saved'
          ? 'Provider 设置已保存到本机。'
          : '后续会接入 Electron safeStorage 和后端连通性验证。'}
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
