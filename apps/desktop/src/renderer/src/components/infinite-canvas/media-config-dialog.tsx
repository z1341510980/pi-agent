import { useEffect, useState, type ReactElement } from 'react'
import { Eye, EyeOff, Key, X } from 'lucide-react'

import {
  getMediaConfig,
  updateMediaConfig,
  type CanvasMediaConfigStatus
} from '@/api/infinite-canvas-client'
import type { CanvasTheme } from './canvas-theme'

/** 画布独立生图 API 配置：与 LLM Provider 的 Key 完全分离。 */
export function MediaConfigDialog({
  theme,
  onClose,
  onSaved
}: {
  theme: CanvasTheme
  onClose: () => void
  onSaved?: () => void
}): ReactElement {
  const [status, setStatus] = useState<CanvasMediaConfigStatus | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [imageSize, setImageSize] = useState('1024x1024')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void getMediaConfig()
      .then((config) => {
        setStatus(config)
        setBaseUrl(config.baseUrl)
        setModel(config.model)
        setImageSize(config.imageSize)
      })
      .catch(() => setError('无法加载当前配置'))
  }, [])

  const save = async (): Promise<void> => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setError('Base URL 和 API Key 不能为空')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await updateMediaConfig({
        imageBaseUrl: baseUrl.trim(),
        imageApiKey: apiKey.trim(),
        imageModel: model.trim(),
        imageSize: imageSize.trim()
      })
      setStatus(updated)
      onSaved?.()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    borderColor: theme.toolbar.border,
    color: theme.node.text,
    background: 'transparent'
  }

  return (
    <div className="fixed inset-0 z-[130] grid place-items-center bg-black/35 p-5" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border p-5 shadow-2xl"
        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
        data-canvas-no-zoom
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Key className="size-4" />
            生图 API 配置
          </h2>
          <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded-lg opacity-55 transition hover:opacity-100">
            <X className="size-4" />
          </button>
        </div>

        <p className="mb-4 text-xs leading-5 opacity-60">
          生图平台的 API Key 通常与 LLM Provider 不同。此处配置独立的 Base URL 和 Key，仅用于画布内的图片生成。
          未配置时回退到设置页的默认 Provider（如果该 Provider 支持生图协议）。
        </p>

        {status && !status.configured && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            当前未配置独立生图 API，图片生成将尝试使用默认 LLM Provider。
          </div>
        )}
        {status?.configured && (
          <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
            已配置 · {status.model || '未填模型'} · Key {status.keyHint}
          </div>
        )}

        <div className="space-y-3">
          <label className="block text-xs font-medium">
            Base URL
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              className="mt-1 h-9 w-full rounded-lg border px-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30"
              style={inputStyle}
            />
          </label>
          <label className="block text-xs font-medium">
            API Key
            <div className="relative mt-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…"
                className="h-9 w-full rounded-lg border px-3 pr-9 text-sm outline-none focus:ring-2 focus:ring-blue-500/30"
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded opacity-40 hover:opacity-100"
              >
                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium">
              模型
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="gpt-image"
                className="mt-1 h-9 w-full rounded-lg border px-3 text-sm outline-none"
                style={inputStyle}
              />
            </label>
            <label className="block text-xs font-medium">
              尺寸
              <select
                value={imageSize}
                onChange={(event) => setImageSize(event.target.value)}
                className="mt-1 h-9 w-full rounded-lg border bg-transparent px-2 text-sm outline-none"
                style={inputStyle}
              >
                <option value="1024x1024">1024 × 1024</option>
                <option value="1792x1024">1792 × 1024</option>
                <option value="1024x1792">1024 × 1792</option>
                <option value="512x512">512 × 512</option>
              </select>
            </label>
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm opacity-60 transition hover:opacity-100">
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-40"
            style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
