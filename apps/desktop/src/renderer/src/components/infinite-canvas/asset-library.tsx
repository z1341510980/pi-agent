import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { BookOpen, FileText, ImageIcon, Search, X } from 'lucide-react'

import {
  listPromptItems,
  refreshPromptSources,
  type NormalizedPromptItem
} from '@/api/infinite-canvas-client'
import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import type { CanvasTheme } from './canvas-theme'

export interface CanvasAsset {
  id: string
  kind: 'text' | 'image' | 'video'
  title: string
  content: string
  createdAt: number
}

/** 兼容旧引用：现在由服务端归一化后返回。 */
export type PromptItem = NormalizedPromptItem

const STORAGE_KEY = 'pi-agent:infinite-canvas-assets'

export function readCanvasAssets(): CanvasAsset[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function writeCanvasAssets(assets: CanvasAsset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(assets.slice(0, 500)))
}

export function saveCanvasAsset(asset: Omit<CanvasAsset, 'id' | 'createdAt'>): CanvasAsset {
  const next = { ...asset, id: crypto.randomUUID(), createdAt: Date.now() }
  writeCanvasAssets([next, ...readCanvasAssets()])
  return next
}

export function CanvasAssetLibrary({
  theme,
  nodes,
  initialTab = 'assets',
  onInsert,
  onUsePrompt,
  onClose
}: {
  theme: CanvasTheme
  nodes: CanvasNodeData[]
  initialTab?: 'assets' | 'prompts'
  onInsert: (asset: CanvasAsset) => void
  onUsePrompt?: (prompt: string) => void
  onClose: () => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [assets, setAssets] = useState(readCanvasAssets)
  const [tab, setTab] = useState<'assets' | 'prompts'>(initialTab)
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [promptLoading, setPromptLoading] = useState(false)
  const [failedCount, setFailedCount] = useState(0)
  const [activeCategory, setActiveCategory] = useState<string>('全部')
  const categories = useMemo(() => {
    const names = [...new Set(prompts.map((item) => item.sourceName))]
    return ['全部', ...names]
  }, [prompts])
  const filtered = useMemo(() => {
    const pool =
      tab === 'assets'
        ? assets.map((asset) => ({
            key: asset.id,
            title: asset.title,
            subtitle: asset.content,
            content: asset.content,
            cover: asset.kind === 'image' ? asset.content : '',
            sourceName: ''
          }))
        : prompts
            .filter((item) => activeCategory === '全部' || item.sourceName === activeCategory)
            .map((item) => ({
              key: `${item.sourceId}:${item.id}`,
              title: item.title,
              subtitle: item.description || item.prompt,
              content: item.prompt,
              cover: item.coverUrl,
              sourceName: item.sourceName
            }))
    return pool.filter((item) =>
      `${item.title} ${item.subtitle}`.toLowerCase().includes(query.toLowerCase())
    )
  }, [activeCategory, assets, prompts, query, tab])

  // 从服务端 SQLite 缓存读取；force=true 时先让服务端刷新再拉取。
  const loadPrompts = async (force = false): Promise<void> => {
    setPromptLoading(true)
    try {
      if (force) await refreshPromptSources()
      const items = await listPromptItems()
      setPrompts(items)
      setFailedCount(0)
    } catch {
      setFailedCount(1)
    } finally {
      setPromptLoading(false)
    }
  }

  const loadPromptsRef = useRef(loadPrompts)
  loadPromptsRef.current = loadPrompts
  useEffect(() => {
    if (tab !== 'prompts' || prompts.length || promptLoading) return
    void loadPromptsRef.current()
  }, [tab])

  const addCurrent = (node: CanvasNodeData): void => {
    const content = typeof node.metadata?.content === 'string' ? node.metadata.content : ''
    if (!content) return
    const asset = saveCanvasAsset({
      kind: node.type === 'image' ? 'image' : node.type === 'video' ? 'video' : 'text',
      title: node.title,
      content
    })
    setAssets((current) => [asset, ...current])
  }

  const pickItem = (item: { content: string; cover: string; key: string; title: string }): void => {
    if (tab === 'prompts' && onUsePrompt) {
      onUsePrompt(item.content)
      onClose()
      return
    }
    onInsert({
      id: item.key,
      kind: item.cover ? 'image' : 'text',
      title: item.title,
      content: item.content,
      createdAt: Date.now()
    })
  }
  return (
    <div
      className="fixed inset-0 z-[105] grid place-items-center bg-black/35 p-5"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl border p-4 shadow-2xl"
        style={{
          background: theme.toolbar.panel,
          borderColor: theme.toolbar.border,
          color: theme.node.text
        }}
        data-canvas-no-zoom
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BookOpen className="size-4" />
            我的资产 / 提示词库
          </h2>
          <button type="button" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-3 flex gap-1">
          <button
            type="button"
            className="rounded-full px-3 py-1.5 text-xs"
            style={{ background: tab === 'assets' ? theme.toolbar.activeBg : 'transparent' }}
            onClick={() => setTab('assets')}
          >
            我的资产
          </button>
          <button
            type="button"
            className="rounded-full px-3 py-1.5 text-xs"
            style={{ background: tab === 'prompts' ? theme.toolbar.activeBg : 'transparent' }}
            onClick={() => {
              setTab('prompts')
              void loadPrompts()
            }}
          >
            提示词库
          </button>
        </div>
        {tab === 'prompts' && (
          <div className="thin-scrollbar mt-2 flex gap-1 overflow-x-auto pb-1">
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                className="shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition"
                style={{
                  borderColor:
                    activeCategory === category ? theme.node.activeStroke : theme.toolbar.border,
                  background: activeCategory === category ? theme.toolbar.activeBg : 'transparent'
                }}
                onClick={() => setActiveCategory(category)}
              >
                {category}
              </button>
            ))}
          </div>
        )}
        <div
          className="mt-2 flex items-center gap-2 rounded-xl border px-3"
          style={{ borderColor: theme.toolbar.border }}
        >
          <Search className="size-4 opacity-50" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder="搜索资产和提示词"
          />
        </div>
        <div
          className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto"
          onWheel={(event) => event.stopPropagation()}
        >
          {promptLoading ? (
            <p className="p-8 text-center text-sm opacity-55">正在加载提示词来源…</p>
          ) : (
            filtered.map((item) => (
              <button
                key={item.key}
                type="button"
                className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-black/5 dark:hover:bg-white/10"
                onClick={() => pickItem(item)}
              >
                <span
                  className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg"
                  style={{ background: theme.node.fill }}
                >
                  {item.cover ? (
                    <img
                      src={item.cover}
                      alt=""
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <FileText className="size-4 opacity-60" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    {item.sourceName && (
                      <span
                        className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] opacity-60"
                        style={{ borderColor: theme.toolbar.border }}
                      >
                        {item.sourceName}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs opacity-55">{item.subtitle}</span>
                </span>
              </button>
            ))
          )}
          {!filtered.length && !promptLoading && (
            <p className="p-8 text-center text-sm opacity-55">暂无内容</p>
          )}
        </div>
        {tab === 'prompts' && failedCount > 0 && (
          <p className="mt-2 text-[11px] opacity-55">
            {failedCount} 个提示词来源加载失败，可点击下方刷新重试。
          </p>
        )}
        {tab === 'prompts' && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              className="rounded-full border px-3 py-1.5 text-xs"
              style={{ borderColor: theme.toolbar.border }}
              onClick={() => void loadPrompts(true)}
            >
              强制刷新来源
            </button>
          </div>
        )}
        {tab === 'assets' && (
          <div className="mt-3 border-t pt-3" style={{ borderColor: theme.toolbar.border }}>
            <p className="mb-2 text-xs opacity-55">从当前节点保存</p>
            <div className="flex flex-wrap gap-2">
              {nodes
                .filter((node) => node.metadata?.content)
                .map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs"
                    style={{ borderColor: theme.toolbar.border }}
                    onClick={() => addCurrent(node)}
                  >
                    {node.type === 'image' ? (
                      <ImageIcon className="size-3" />
                    ) : (
                      <FileText className="size-3" />
                    )}
                    {node.title}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
