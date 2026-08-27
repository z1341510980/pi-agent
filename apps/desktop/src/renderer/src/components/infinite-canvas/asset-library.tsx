import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { BookOpen, Copy, Eye, FileText, ImageIcon, Search, X } from 'lucide-react'

import {
  listPromptItems,
  listPromptTags,
  refreshPromptSources,
  type NormalizedPromptItem,
  type PromptTagInfo
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

export type PromptItem = NormalizedPromptItem

const STORAGE_KEY = 'pi-agent:infinite-canvas-assets'
const PROXY_BASE = '/api/plugins/infinite-canvas/proxy-image?url='

/** 外部图通过服务端代理绕过 CSP；data: URL 直接用。 */
function resolveCover(url: string): string {
  if (!url) return ''
  if (url.startsWith('data:')) return url
  if (url.startsWith('http')) return `${PROXY_BASE}${encodeURIComponent(url)}`
  return ''
}

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

interface CardItem {
  key: string
  title: string
  description: string
  prompt: string
  cover: string
  sourceName: string
  tags?: string[]
}

/** 单张提示词卡片：封面 + 悬浮描述 + 左上角查看按钮。 */
function PromptCard({
  item,
  theme,
  onUse,
  onView
}: {
  item: CardItem
  theme: CanvasTheme
  onUse: () => void
  onView: () => void
}): ReactElement {
  return (
    <div
      className="group relative cursor-pointer overflow-hidden rounded-xl border transition-shadow hover:shadow-lg"
      style={{ background: theme.node.panel, borderColor: theme.toolbar.border }}
      onClick={onUse}
      data-content-visibility="auto"
      data-content-intrinsic-size="280"
    >
      {/* 封面区 */}
      <div
        className="relative aspect-[4/3] w-full overflow-hidden"
        style={{ background: theme.node.fill }}
      >
        {item.cover ? (
          <img
            src={item.cover}
            alt={item.title}
            loading="lazy"
            className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="grid size-full place-items-center">
            <FileText className="size-8 opacity-25" />
          </div>
        )}
        {/* 左上角查看提示词按钮 */}
        <button
          type="button"
          title="查看完整提示词"
          className="absolute left-1.5 top-1.5 z-10 grid size-7 place-items-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            onView()
          }}
        >
          <Eye className="size-3.5" />
        </button>
        {/* 来源标签 */}
        {item.sourceName && (
          <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white backdrop-blur-sm">
            {item.sourceName}
          </span>
        )}
      </div>
      {/* 标题 + 悬浮描述 */}
      <div className="p-2">
        <p className="truncate text-xs font-medium leading-4">{item.title}</p>
        <p className="mt-0.5 line-clamp-1 text-[11px] opacity-50">{item.description}</p>
      </div>
      {/* 悬浮完整简介遮罩 */}
      <div
        className="pointer-events-none absolute inset-0 z-[5] flex flex-col justify-end bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
      >
        <p className="line-clamp-4 text-[11px] leading-4 text-white/90">{item.description || item.prompt}</p>
      </div>
    </div>
  )
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
  const [activeCategory, setActiveCategory] = useState('全部')
  const [detailItem, setDetailItem] = useState<CardItem | null>(null)
  const [copied, setCopied] = useState(false)
  const [promptTags, setPromptTags] = useState<PromptTagInfo[]>([])
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  const categories = useMemo(() => {
    const names = [...new Set(prompts.map((item) => item.sourceName))]
    return ['全部', ...names]
  }, [prompts])

  const filtered = useMemo<CardItem[]>(() => {
    if (tab === 'assets') {
      return assets.map((asset) => ({
        key: asset.id,
        title: asset.title,
        description: asset.content.slice(0, 200),
        prompt: asset.content,
        cover: asset.kind === 'image' ? asset.content : '',
        sourceName: ''
      }))
    }
    return prompts
      .filter((item) => activeCategory === '全部' || item.sourceName === activeCategory)
      .filter((item) => {
        if (!selectedTags.size) return true
        return selectedTags.isSupersetOf(new Set(item.tags))
      })
      .map((item) => ({
        key: `${item.sourceId}:${item.id}`,
        title: item.title,
        description: item.description || item.prompt.slice(0, 200),
        prompt: item.prompt,
        cover: resolveCover(item.coverUrl),
        sourceName: item.sourceName,
        tags: item.tags
      }))
      .filter((item) =>
        `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase())
      )
  }, [activeCategory, assets, prompts, query, tab, selectedTags])

  const loadPrompts = async (force = false): Promise<void> => {
    setPromptLoading(true)
    try {
      if (force) await refreshPromptSources()
      const [items, tags] = await Promise.all([listPromptItems(), listPromptTags()])
      setPrompts(items)
      setPromptTags(tags)
      setFailedCount(0)
    } catch {
      setFailedCount(1)
    } finally {
      setPromptLoading(false)
    }
  }

  const toggleTag = (tag: string): void => {
    setSelectedTags((current) => {
      const next = new Set(current)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
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

  const useCard = (item: CardItem): void => {
    if (tab === 'prompts' && onUsePrompt) {
      onUsePrompt(item.prompt)
      onClose()
      return
    }
    onInsert({
      id: item.key,
      kind: item.cover ? 'image' : 'text',
      title: item.title,
      content: item.prompt,
      createdAt: Date.now()
    })
  }

  const copyPrompt = async (): Promise<void> => {
    if (!detailItem) return
    try {
      await navigator.clipboard.writeText(detailItem.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="fixed inset-0 z-[105] grid place-items-center bg-black/35 p-5" onClick={onClose}>
      <div
        className="flex h-[85vh] w-full max-w-5xl flex-col rounded-2xl border p-4 shadow-2xl"
        style={{
          background: theme.toolbar.panel,
          borderColor: theme.toolbar.border,
          color: theme.node.text
        }}
        data-canvas-no-zoom
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BookOpen className="size-4" />
            我的资产 / 提示词库
            {tab === 'prompts' && filtered.length > 0 && (
              <span className="ml-1 text-xs font-normal opacity-45">{filtered.length} 条</span>
            )}
          </h2>
          <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded-lg opacity-55 hover:opacity-100">
            <X className="size-4" />
          </button>
        </div>

        {/* 页签 */}
        <div className="mt-3 flex shrink-0 gap-1">
          {(['assets', 'prompts'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="rounded-full px-3 py-1.5 text-xs"
              style={{
                background: tab === key ? theme.toolbar.activeBg : 'transparent',
                color: tab === key ? theme.toolbar.activeText : theme.node.text
              }}
              onClick={() => {
                setTab(key)
                if (key === 'prompts') void loadPrompts()
              }}
            >
              {key === 'assets' ? '我的资产' : '提示词库'}
            </button>
          ))}
        </div>

        {/* 分类筛选 */}
        {tab === 'prompts' && categories.length > 1 && (
          <div className="thin-scrollbar mt-2 flex shrink-0 gap-1 overflow-x-auto pb-1">
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

        {/* 标签筛选 */}
        {tab === 'prompts' && promptTags.length > 0 && (
          <div className="thin-scrollbar mt-1.5 flex shrink-0 items-center gap-1 overflow-x-auto pb-1">
            <span className="shrink-0 text-[10px] opacity-45">标签</span>
            {promptTags.slice(0, 60).map(({ tag, count }) => {
              const active = selectedTags.has(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition"
                  style={{
                    borderColor: active ? theme.node.activeStroke : theme.toolbar.border,
                    background: active ? theme.toolbar.activeBg : 'transparent',
                    color: active ? theme.toolbar.activeText : theme.node.text
                  }}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                  <span className="ml-0.5 opacity-45">{count}</span>
                </button>
              )
            })}
            {selectedTags.size > 0 && (
              <button
                type="button"
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] opacity-50 hover:opacity-100"
                onClick={() => setSelectedTags(new Set())}
              >
                清除
              </button>
            )}
          </div>
        )}

        {/* 搜索 */}
        <div className="mt-2 flex shrink-0 items-center gap-2 rounded-xl border px-3" style={{ borderColor: theme.toolbar.border }}>
          <Search className="size-4 opacity-50" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder="搜索资产和提示词"
          />
        </div>

        {/* 卡片网格 */}
        <div
          ref={scrollRef}
          className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto"
          onWheel={(event) => event.stopPropagation()}
        >
          {promptLoading ? (
            <div className="grid place-items-center p-16">
              <div className="size-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-30" />
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
            >
              {filtered.map((item) => (
                <PromptCard
                  key={item.key}
                  item={item}
                  theme={theme}
                  onUse={() => useCard(item)}
                  onView={() => setDetailItem(item)}
                />
              ))}
            </div>
          )}
          {!filtered.length && !promptLoading && (
            <p className="grid place-items-center p-16 text-sm opacity-55">暂无内容</p>
          )}
        </div>

        {/* 底部操作 */}
        <div className="mt-2 flex shrink-0 items-center justify-between">
          <div>
            {tab === 'prompts' && failedCount > 0 && (
              <p className="text-[11px] opacity-55">{failedCount} 个来源加载失败，可刷新重试。</p>
            )}
            {tab === 'assets' && (
              <div className="flex flex-wrap gap-1.5">
                {nodes
                  .filter((node) => node.metadata?.content)
                  .slice(0, 8)
                  .map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]"
                      style={{ borderColor: theme.toolbar.border }}
                      onClick={() => addCurrent(node)}
                    >
                      {node.type === 'image' ? <ImageIcon className="size-3" /> : <FileText className="size-3" />}
                      {node.title}
                    </button>
                  ))}
              </div>
            )}
          </div>
          {tab === 'prompts' && (
            <button
              type="button"
              className="shrink-0 rounded-full border px-3 py-1.5 text-xs"
              style={{ borderColor: theme.toolbar.border }}
              onClick={() => void loadPrompts(true)}
            >
              刷新来源
            </button>
          )}
        </div>
      </div>

      {/* 提示词详情弹窗 */}
      {detailItem && (
        <div
          className="fixed inset-0 z-[120] grid place-items-center bg-black/50 p-5"
          onClick={() => setDetailItem(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-5 shadow-2xl thin-scrollbar"
            style={{
              background: theme.toolbar.panel,
              borderColor: theme.toolbar.border,
              color: theme.node.text
            }}
            data-canvas-no-zoom
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold leading-5">{detailItem.title}</h3>
                {detailItem.sourceName && (
                  <span className="mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] opacity-60" style={{ borderColor: theme.toolbar.border }}>
                    {detailItem.sourceName}
                  </span>
                )}
              </div>
              <button type="button" onClick={() => setDetailItem(null)} className="grid size-6 shrink-0 place-items-center rounded opacity-50 hover:opacity-100">
                <X className="size-4" />
              </button>
            </div>
            {detailItem.cover && (
              <img
                src={detailItem.cover}
                alt=""
                className="mb-3 max-h-64 w-full rounded-xl object-cover"
              />
            )}
            <div className="rounded-xl border p-3" style={{ borderColor: theme.toolbar.border }}>
              <p className="whitespace-pre-wrap break-words text-xs leading-5 opacity-85">{detailItem.prompt}</p>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void copyPrompt()}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs"
                style={{ borderColor: theme.toolbar.border }}
              >
                <Copy className="size-3" />
                {copied ? '已复制' : '复制'}
              </button>
              <button
                type="button"
                onClick={() => {
                  useCard(detailItem)
                  setDetailItem(null)
                }}
                className="rounded-full px-4 py-1.5 text-xs font-medium"
                style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
              >
                使用此提示词
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
