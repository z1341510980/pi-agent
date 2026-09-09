import { useEffect, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, ImageIcon, X } from 'lucide-react'

import { listMediaLogs, proxyExternalImageUrl, type MediaLogEntry } from '@/api/infinite-canvas-client'
import type { CanvasTheme } from './canvas-theme'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function LogImage({ src, label, theme }: { src: string; label: string; theme: CanvasTheme }): ReactElement {
  return (
    <figure className="w-28 shrink-0">
      <img
        src={proxyExternalImageUrl(src)}
        alt={label}
        loading="lazy"
        className="h-24 w-28 rounded-lg border object-cover"
        style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}
      />
      <figcaption className="mt-1 truncate text-[10px] opacity-50">{label}</figcaption>
    </figure>
  )
}

/** 媒体生成日志面板：每条记录展示请求（提示词/参考图/蒙版）与响应（结果图/错误）。 */
export function MediaLogPanel({
  theme,
  onClose
}: {
  theme: CanvasTheme
  onClose: () => void
}): ReactElement {
  const [logs, setLogs] = useState<MediaLogEntry[] | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listMediaLogs()
      .then(setLogs)
      .catch(() => setError('无法加载生成日志'))
  }, [])

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: theme.toolbar.border }}>
          <h2 className="text-sm font-semibold">生成日志</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid size-6 place-items-center rounded opacity-50 hover:opacity-100"
            aria-label="关闭生成日志"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p className="text-xs text-red-500">{error}</p>}
          {!error && logs === null && <p className="text-xs opacity-50">加载中…</p>}
          {logs?.length === 0 && <p className="text-xs opacity-50">还没有生成记录。</p>}
          <div className="space-y-2">
            {logs?.map((log) => {
              const expanded = expandedId === log.id
              return (
                <div
                  key={log.id}
                  className="rounded-xl border text-xs"
                  style={{ borderColor: theme.toolbar.border }}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                    onClick={() => setExpandedId(expanded ? null : log.id)}
                  >
                    {expanded ? <ChevronDown className="size-3.5 opacity-50" /> : <ChevronRight className="size-3.5 opacity-50" />}
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: log.status === 'ok' ? '#4ade80' : '#f87171' }}
                      aria-label={log.status === 'ok' ? '成功' : '失败'}
                    />
                    <span className="shrink-0 opacity-50">
                      {new Date(log.createdAt).toLocaleTimeString()}
                    </span>
                    <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] opacity-70" style={{ borderColor: theme.toolbar.border }}>
                      {log.kind === 'edit' ? '图生图/重绘' : '文生图'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{log.prompt || '（无提示词）'}</span>
                    <span className="shrink-0 opacity-50">{(log.durationMs / 1000).toFixed(1)}s</span>
                  </button>
                  {expanded && (
                    <div className="space-y-3 border-t px-3 py-3" style={{ borderColor: theme.toolbar.border }}>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 opacity-70">
                        <span>模型：{log.model ?? '—'}</span>
                        <span>尺寸：{log.size ?? '—'}</span>
                        <span>端点：{log.endpoint}</span>
                      </div>
                      <div>
                        <p className="mb-1 font-medium opacity-70">提示词</p>
                        <p className="whitespace-pre-wrap break-words leading-relaxed opacity-85">
                          {log.prompt || '—'}
                        </p>
                      </div>
                      {log.references.length > 0 && (
                        <div>
                          <p className="mb-1 flex items-center gap-1 font-medium opacity-70">
                            <ImageIcon className="size-3" /> 参考图（{log.references.length}）
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {log.references.map((reference, index) => (
                              <LogImage
                                key={`${log.id}-ref-${index}`}
                                src={reference.preview}
                                label={formatBytes(reference.bytes)}
                                theme={theme}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      {log.maskPath && (
                        <div>
                          <p className="mb-1 font-medium opacity-70">蒙版（透明区=重绘区）</p>
                          <LogImage src={log.maskPath} label="mask" theme={theme} />
                        </div>
                      )}
                      <div>
                        <p className="mb-1 font-medium opacity-70">返回结果</p>
                        {log.status === 'ok' && log.responseImages.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {log.responseImages.map((src, index) => (
                              <LogImage key={`${log.id}-out-${index}`} src={src} label={`结果 ${index + 1}`} theme={theme} />
                            ))}
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap break-words text-red-500">
                            {log.error ?? '没有返回图片'}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
