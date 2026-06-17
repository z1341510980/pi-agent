import type { FormEvent, ReactElement } from 'react'
import { useEffect, useState } from 'react'

export type ProviderSettings = {
  provider: string
  model: string
  apiKey: string
}

const storageKey = 'pi-agent.provider'

const defaultSettings: ProviderSettings = {
  provider: 'deepseek',
  model: 'deepseek-chat',
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
    <form className="provider-form" onSubmit={saveSettings}>
      <div>
        <p className="panel-label">Provider bootstrap</p>
        <h2>模型连接</h2>
      </div>

      <label>
        <span>Provider</span>
        <select
          value={settings.provider}
          onChange={(event) => updateSettings('provider', event.target.value)}
        >
          <option value="deepseek">DeepSeek</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Gemini</option>
          <option value="custom">自定义</option>
        </select>
      </label>

      <label>
        <span>模型</span>
        <input
          value={settings.model}
          onChange={(event) => updateSettings('model', event.target.value)}
          placeholder="deepseek-chat"
        />
      </label>

      <label>
        <span>API Key</span>
        <input
          value={settings.apiKey}
          onChange={(event) => updateSettings('apiKey', event.target.value)}
          placeholder="sk-..."
          type="password"
        />
      </label>

      <button className="primary-button" type="submit">
        保存本机设置
      </button>

      <p className="provider-note" role="status">
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
