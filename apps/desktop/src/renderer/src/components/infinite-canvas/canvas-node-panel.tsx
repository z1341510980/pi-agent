import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  ArrowUp,
  BookOpen,
  FileText,
  ImageIcon,
  Loader2,
  Music2,
  Square,
  Video,
  X
} from 'lucide-react'

import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import type { CanvasTheme } from './canvas-theme'

export interface UpstreamInputSummary {
  textCount: number
  imageCount: number
  videoCount: number
  audioCount: number
}

export interface MentionReference {
  nodeId: string
  title: string
  kind: 'text' | 'image' | 'video' | 'audio'
}

/** 与参考项目一致的引用标记：@[node:<id>]，生成时解析为「标题: 内容」。 */
export const MENTION_TOKEN_PATTERN = /@\[node:([^\]]+)\]/g

export interface CanvasNodePanelProps {
  node: CanvasNodeData
  theme: CanvasTheme
  isRunning: boolean
  onPromptChange: (nodeId: string, prompt: string) => void
  onModeChange: (nodeId: string, mode: string) => void
  onGenerate: (nodeId: string, prompt: string, mode: string) => void
  onStop: (nodeId: string) => void
  onClose: () => void
  onConfigChange?: (nodeId: string, patch: Record<string, unknown>) => void
  upstreamSummary?: UpstreamInputSummary
  mentionReferences?: MentionReference[]
  onOpenPromptLibrary?: () => void
}

const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']
const VIDEO_SIZES = ['auto', '1280x720', '1920x1080']
const VIDEO_SECONDS = [5, 10]
const AUDIO_FORMATS = ['mp3', 'wav']

function ModeSegmented({
  theme,
  mode,
  onChange
}: {
  theme: CanvasTheme
  mode: string
  onChange: (mode: string) => void
}): ReactElement {
  const options = [
    { value: 'image', icon: <ImageIcon className="size-3.5" />, label: '图片' },
    { value: 'text', icon: <FileText className="size-3.5" />, label: '文本' },
    { value: 'video', icon: <Video className="size-3.5" />, label: '视频' },
    { value: 'audio', icon: <Music2 className="size-3.5" />, label: '音频' }
  ]
  return (
    <div
      className="flex shrink-0 gap-0.5 rounded-lg border p-0.5"
      style={{ borderColor: theme.toolbar.border }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition"
          style={{
            background: mode === option.value ? theme.toolbar.activeBg : 'transparent',
            color: mode === option.value ? theme.toolbar.activeText : theme.toolbar.item
          }}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  )
}

function InputChip({
  theme,
  label,
  count
}: {
  theme: CanvasTheme
  label: string
  count: number
}): ReactElement {
  return (
    <span
      className="inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[11px]"
      style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}
    >
      {label}
      <span className="font-medium" style={{ color: theme.node.text }}>
        {count}
      </span>
    </span>
  )
}

function ConfigSettingsRow({
  node,
  theme,
  mode,
  onConfigChange
}: {
  node: CanvasNodeData
  theme: CanvasTheme
  mode: string
  onConfigChange: (patch: Record<string, unknown>) => void
}): ReactElement {
  const metadata = node.metadata ?? {}
  const selectStyle = { borderColor: theme.toolbar.border, color: theme.node.text }
  if (mode === 'image') {
    const size = String(metadata.size || 'auto')
    const count = Math.min(4, Math.max(1, Number(metadata.count) || 1))
    return (
      <>
        <select
          value={size}
          onChange={(event) => onConfigChange({ size: event.target.value })}
          className="h-8 rounded-full border bg-transparent px-2 text-xs outline-none"
          style={selectStyle}
          aria-label="图片尺寸"
        >
          {IMAGE_SIZES.map((value) => (
            <option key={value} value={value}>
              {value === 'auto' ? '自动尺寸' : value}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 text-xs opacity-70">
          数量
          <input
            type="number"
            min={1}
            max={4}
            value={count}
            onChange={(event) =>
              onConfigChange({ count: Math.min(4, Math.max(1, Number(event.target.value) || 1)) })
            }
            className="h-8 w-14 rounded-full border bg-transparent px-2 text-center text-xs outline-none"
            style={selectStyle}
          />
        </label>
      </>
    )
  }
  if (mode === 'video') {
    const size = String(metadata.size || 'auto')
    const seconds = Number(metadata.seconds) || 5
    return (
      <>
        <select
          value={size}
          onChange={(event) => onConfigChange({ size: event.target.value })}
          className="h-8 rounded-full border bg-transparent px-2 text-xs outline-none"
          style={selectStyle}
          aria-label="视频分辨率"
        >
          {VIDEO_SIZES.map((value) => (
            <option key={value} value={value}>
              {value === 'auto' ? '自动分辨率' : value}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 text-xs opacity-70">
          时长
          <select
            value={seconds}
            onChange={(event) => onConfigChange({ seconds: Number(event.target.value) })}
            className="h-8 rounded-full border bg-transparent px-2 text-xs outline-none"
            style={selectStyle}
          >
            {VIDEO_SECONDS.map((value) => (
              <option key={value} value={value}>
                {value}s
              </option>
            ))}
          </select>
        </label>
      </>
    )
  }
  if (mode === 'audio') {
    return (
      <>
        <input
          type="text"
          value={String(metadata.voice ?? '')}
          placeholder="音色"
          onChange={(event) => onConfigChange({ voice: event.target.value })}
          className="h-8 w-24 rounded-full border bg-transparent px-2 text-xs outline-none"
          style={selectStyle}
        />
        <select
          value={String(metadata.format || 'mp3')}
          onChange={(event) => onConfigChange({ format: event.target.value })}
          className="h-8 rounded-full border bg-transparent px-2 text-xs outline-none"
          style={selectStyle}
          aria-label="音频格式"
        >
          {AUDIO_FORMATS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 text-xs opacity-70">
          语速
          <input
            type="number"
            min={0.25}
            max={4}
            step={0.25}
            value={Number(metadata.speed) || 1}
            onChange={(event) => onConfigChange({ speed: Number(event.target.value) || 1 })}
            className="h-8 w-16 rounded-full border bg-transparent px-2 text-center text-xs outline-none"
            style={selectStyle}
          />
        </label>
      </>
    )
  }
  return <span className="text-xs opacity-50">文本模式使用画布 Agent 默认配置</span>
}

/**
 * 参考项目的节点下方面板的桌面端适配版。
 * 文本输入、生成模式和 Agent 调用保持在节点 metadata 中，画布状态仍由父级统一持久化。
 * config 节点渲染专用布局：模式切换 + 上游输入统计 + 每模式生成参数。
 */
export function CanvasNodePanel({
  node,
  theme,
  isRunning,
  onPromptChange,
  onModeChange,
  onGenerate,
  onStop,
  onClose,
  onConfigChange,
  upstreamSummary,
  mentionReferences,
  onOpenPromptLibrary
}: CanvasNodePanelProps): ReactElement {
  const isConfig = node.type === 'config'
  const [prompt, setPrompt] = useState(
    String(node.metadata?.composerContent ?? node.metadata?.prompt ?? '')
  )
  const [mode, setMode] = useState(
    String(node.metadata?.generationMode ?? (node.type === 'text' ? 'text' : 'image'))
  )
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setPrompt(String(node.metadata?.composerContent ?? node.metadata?.prompt ?? ''))
    setMode(String(node.metadata?.generationMode ?? (node.type === 'text' ? 'text' : 'image')))
    // 提示词库等外部写入也需同步到输入框；输入时 onPromptChange 会写回相同值，不会打断输入。
  }, [
    node.id,
    node.metadata?.composerContent,
    node.metadata?.generationMode,
    node.metadata?.prompt
  ])

  const updatePrompt = (value: string): void => {
    setPrompt(value)
    onPromptChange(node.id, value)
  }

  const handlePromptInput = (value: string, selectionStart: number | null): void => {
    updatePrompt(value)
    if (!mentionReferences?.length || selectionStart === null) {
      setMentionQuery(null)
      return
    }
    // 输入 "@" 触发上游引用候选（对齐参考 CanvasConfigComposer 的 mention 行为）。
    const match = /@([^\s@]*)$/.exec(value.slice(0, selectionStart))
    setMentionQuery(match ? { start: selectionStart - match[0].length, query: match[1] } : null)
  }

  const insertMention = (reference: MentionReference): void => {
    if (!mentionQuery) return
    const token = `@[node:${reference.nodeId}] `
    const next =
      prompt.slice(0, mentionQuery.start) +
      token +
      prompt.slice(mentionQuery.start + 1 + mentionQuery.query.length)
    updatePrompt(next)
    setMentionQuery(null)
    const caret = mentionQuery.start + token.length
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.setSelectionRange(caret, caret)
    })
  }

  const mentionCandidates = useMemo(() => {
    if (!mentionReferences) return []
    const query = mentionQuery?.query.trim().toLowerCase() ?? ''
    if (!query) return mentionReferences
    return mentionReferences.filter((item) => item.title.toLowerCase().includes(query))
  }, [mentionQuery, mentionReferences])

  const mentionedTitles = useMemo(() => {
    const ids = new Set<string>()
    for (const match of prompt.matchAll(MENTION_TOKEN_PATTERN)) ids.add(match[1].trim())
    return [...ids].map(
      (id) =>
        mentionReferences?.find((item) => item.nodeId === id) ?? {
          nodeId: id,
          title: '未知节点',
          kind: 'text' as const
        }
    )
  }, [mentionReferences, prompt])

  const updateMode = (value: string): void => {
    setMode(value)
    onModeChange(node.id, value)
  }

  const changeConfig = (patch: Record<string, unknown>): void => {
    onConfigChange?.(node.id, patch)
  }

  const summary = upstreamSummary ?? { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 }
  const hasAnyInput = Boolean(
    summary.textCount || summary.imageCount || summary.videoCount || summary.audioCount
  )
  // config 节点对齐参考：有提示词或任一上游输入即可生成；普通节点仍要求非空提示词。
  const canGenerate = isConfig ? Boolean(prompt.trim()) || hasAnyInput : Boolean(prompt.trim())

  const panelTitle = isConfig ? '生成配置' : '节点 Agent'
  const panelHint = isConfig
    ? '连线传入上游内容，选择模式与参数后生成'
    : '可使用已连接的上游节点作为上下文'

  return (
    <div
      data-canvas-no-zoom
      className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
      style={{
        background: theme.toolbar.panel,
        borderColor: theme.toolbar.border,
        color: theme.node.text
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold">{panelTitle}</p>
          <p className="truncate text-[11px] opacity-55">{panelHint}</p>
        </div>
        <button
          type="button"
          title="关闭面板"
          className="grid size-7 shrink-0 place-items-center rounded-lg opacity-55 transition hover:bg-white/10 hover:opacity-100"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {isConfig && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <InputChip theme={theme} label="提示词" count={summary.textCount} />
            <InputChip theme={theme} label="引用图" count={summary.imageCount} />
            <InputChip theme={theme} label="视频引用" count={summary.videoCount} />
            <InputChip theme={theme} label="音频引用" count={summary.audioCount} />
          </div>
          <ModeSegmented theme={theme} mode={mode} onChange={updateMode} />
        </div>
      )}
      {mentionedTitles.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[10px] opacity-50">@引用</span>
          {mentionedTitles.map((item) => (
            <span
              key={item.nodeId}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
              style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
            >
              {item.kind === 'image' ? (
                <ImageIcon className="size-3 opacity-70" />
              ) : item.kind === 'video' ? (
                <Video className="size-3 opacity-70" />
              ) : item.kind === 'audio' ? (
                <Music2 className="size-3 opacity-70" />
              ) : (
                <FileText className="size-3 opacity-70" />
              )}
              {item.title}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => handlePromptInput(event.target.value, event.target.selectionStart)}
          onBlur={() => setMentionQuery(null)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              setMentionQuery(null)
              return
            }
            if (mentionQuery && (event.key === 'Enter' || event.key === 'Tab')) {
              const candidate = mentionCandidates[0]
              if (candidate && mentionCandidates.length === 1) {
                event.preventDefault()
                insertMention(candidate)
                return
              }
            }
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              if (canGenerate && !isRunning) onGenerate(node.id, prompt.trim(), mode)
            }
          }}
          onWheel={(event) => event.stopPropagation()}
          className="thin-scrollbar min-h-28 w-full resize-y rounded-xl border bg-transparent px-3 py-2 text-sm leading-6 outline-none"
          style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
          placeholder={
            isConfig
              ? mode === 'image'
                ? '描述要生成的图片…（输入 @ 引用上游，也可只依赖上游输入）'
                : '输入提示词或任务…（输入 @ 可引用上游节点）'
              : node.type === 'text' && node.metadata?.content
                ? '描述你想如何改写这段文本…'
                : '输入提示词或任务…'
          }
        />
        {mentionQuery && mentionCandidates.length > 0 && (
          <div
            className="absolute inset-x-0 top-full z-[80] mt-1 max-h-44 overflow-y-auto rounded-xl border p-1 shadow-2xl"
            style={{ background: theme.node.panel, borderColor: theme.node.stroke }}
            data-canvas-no-zoom
          >
            {mentionCandidates.map((candidate) => (
              <button
                key={candidate.nodeId}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault()
                  insertMention(candidate)
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
                style={{ color: theme.node.text }}
              >
                {candidate.kind === 'image' ? (
                  <ImageIcon className="size-3.5 shrink-0 opacity-60" />
                ) : candidate.kind === 'video' ? (
                  <Video className="size-3.5 shrink-0 opacity-60" />
                ) : candidate.kind === 'audio' ? (
                  <Music2 className="size-3.5 shrink-0 opacity-60" />
                ) : (
                  <FileText className="size-3.5 shrink-0 opacity-60" />
                )}
                <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                <span className="shrink-0 text-[10px] opacity-50">插入引用</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!isConfig && onOpenPromptLibrary && (
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            title="从提示词库插入"
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs opacity-75 transition hover:opacity-100"
            style={{ borderColor: theme.toolbar.border }}
            onClick={onOpenPromptLibrary}
          >
            <BookOpen className="size-3.5" />
            提示词库
          </button>
        </div>
      )}
      {!isConfig && mode !== 'text' && onConfigChange && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ConfigSettingsRow
            node={node}
            theme={theme}
            mode={mode}
            onConfigChange={(patch) => onConfigChange(node.id, patch)}
          />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        {isConfig ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ConfigSettingsRow
              node={node}
              theme={theme}
              mode={mode}
              onConfigChange={changeConfig}
            />
          </div>
        ) : (
          <select
            value={mode}
            onChange={(event) => updateMode(event.target.value)}
            className="h-8 min-w-28 rounded-full border bg-transparent px-3 text-xs outline-none"
            style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
          >
            <option value="text">文本 Agent</option>
            <option value="image">图片工作流</option>
            <option value="video">视频工作流</option>
            <option value="audio">音频工作流</option>
          </select>
        )}
        <button
          type="button"
          disabled={!isRunning && !canGenerate}
          className="inline-flex h-9 min-w-20 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-35"
          style={{
            background: isRunning ? '#b91c1c' : theme.toolbar.activeBg,
            color: isRunning ? '#fff' : theme.toolbar.activeText
          }}
          onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id, prompt.trim(), mode))}
        >
          {isRunning ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <Square className="size-3 fill-current" />
              停止
            </>
          ) : (
            <>
              <ArrowUp className="size-4" />
              生成
            </>
          )}
        </button>
      </div>
      <p className="mt-2 text-[10px] opacity-45">
        {isConfig
          ? 'Ctrl/Cmd + Enter 生成；无提示词时将直接汇总上游输入交给 Agent。'
          : 'Ctrl/Cmd + Enter 生成。图片、视频、音频模式会先由画布 Agent 输出可继续编辑的工作流文本。'}
      </p>
    </div>
  )
}
