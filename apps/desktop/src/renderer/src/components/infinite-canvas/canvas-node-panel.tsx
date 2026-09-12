import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  ArrowUp,
  BookOpen,
  BookmarkPlus,
  Check,
  FileText,
  ImageIcon,
  Loader2,
  Lock,
  LockOpen,
  Maximize2,
  Music2,
  Plus,
  Square,
  Video,
  X
} from 'lucide-react'

import type { CanvasNodeData } from '@/api/infinite-canvas-client'
import { proxyExternalImageUrl } from '@/api/infinite-canvas-client'
import { listMediaProviders, type MediaProviderRow } from '@/api/media-provider-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Segmented } from '@/components/ui/segmented'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { saveCanvasAsset } from './asset-library'
import {
  RATIO_PRESETS,
  applyResolutionTier,
  formatSizeValue,
  parseSizeValue,
  ratioLabelForSize,
  scaleForTier,
  snapshotLabel,
  syncLinkedSize,
  type QualityTier,
  type ResolutionTier
} from './canvas-node-panel/image-size-math'
import type { CanvasTheme } from './canvas-theme'

export interface UpstreamInputSummary {
  textCount: number
  imageCount: number
  videoCount: number
  audioCount: number
}

/** 面板里"参考图顺序预览"的一项：按实际发送顺序排列，第 1 张为编辑原图。 */
export interface OrderedReference {
  nodeId: string
  title: string
  /** data URL / 资产路径 / 远程 URL */
  src: string
  isSelf: boolean
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
  /** 参考图顺序预览：与实际发给生成服务的顺序一致（第 1 张为编辑原图）。 */
  orderedReferences?: OrderedReference[]
  /** 上传参考图：选择文件后由工作区压缩入库并建图片节点连线到当前节点。 */
  onAddReferenceImages?: (nodeId: string, files: FileList) => void
  onOpenPromptLibrary?: () => void
}

const QUALITY_VALUES: QualityTier[] = ['auto', 'high', 'medium', 'low']

function qualityValue(value: unknown): QualityTier {
  return QUALITY_VALUES.includes(value as QualityTier) ? (value as QualityTier) : 'auto'
}

/** 从 metadata.size 反推分辨率档：命中 1k/2k/4k 基准表返回档位，auto/自定义尺寸 → 'auto'。 */
function resolutionTierForSize(size: unknown): ResolutionTier {
  const parsed = parseSizeValue(size)
  if (!parsed) return 'auto'
  for (const tier of ['1k', '2k', '4k'] as const) {
    for (const preset of RATIO_PRESETS) {
      const scaled = scaleForTier(preset, tier)
      if (scaled.width === parsed.width && scaled.height === parsed.height) return tier
    }
  }
  return 'auto'
}
// 视频分辨率预设：横竖成对，覆盖 768P / 720P / 1080P 档；'auto' 跟随 Provider 默认。
// 768P 是部分模型（如 minimax 视频）的输出上限档。
const VIDEO_SIZES = [
  'auto',
  '1360x768',
  '768x1360',
  '1280x720',
  '720x1280',
  '1920x1080',
  '1080x1920'
] as const
const VIDEO_SECONDS = [5, 10, 15]
const AUDIO_FORMATS = ['mp3', 'wav']

/** 「跟随全局默认」的哨兵值：Radix Select 不接受空串 value。 */
const FOLLOW_GLOBAL_DEFAULT = '__follow_global_default__'

function CanvasSelectContent({
  theme,
  children
}: {
  theme: CanvasTheme
  children: ReactNode
}): ReactElement {
  return (
    <SelectContent
      position="popper"
      className="z-[120]"
      style={{
        background: theme.node.panel,
        borderColor: theme.node.stroke,
        color: theme.node.text
      }}
      data-canvas-no-zoom
      onWheel={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </SelectContent>
  )
}

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
  if (mode === 'video') {
    const size = String(metadata.size || 'auto')
    const seconds = Number(metadata.seconds) || 5
    return (
      <>
        <Select value={size} onValueChange={(next) => onConfigChange({ size: next })}>
          <SelectTrigger
            aria-label="视频分辨率"
            className="h-8 rounded-full border bg-transparent px-2 text-xs shadow-none dark:bg-transparent"
            style={selectStyle}
          >
            <SelectValue />
          </SelectTrigger>
          <CanvasSelectContent theme={theme}>
            {VIDEO_SIZES.map((value) => {
              const [width, height] = value.split('x').map(Number)
              const label =
                value === 'auto'
                  ? '自动分辨率'
                  : `${width}×${height}（${width >= height ? '横版' : '竖版'}）`
              return (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              )
            })}
          </CanvasSelectContent>
        </Select>
        <span className="inline-flex items-center gap-1 text-xs opacity-70">
          时长
          <Select
            value={String(seconds)}
            onValueChange={(next) => onConfigChange({ seconds: Number(next) })}
          >
            <SelectTrigger
              aria-label="视频时长"
              className="h-8 rounded-full border bg-transparent px-2 text-xs shadow-none dark:bg-transparent"
              style={selectStyle}
            >
              <SelectValue />
            </SelectTrigger>
            <CanvasSelectContent theme={theme}>
              {VIDEO_SECONDS.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value}s
                </SelectItem>
              ))}
            </CanvasSelectContent>
          </Select>
        </span>
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
        <Select
          value={String(metadata.format || 'mp3')}
          onValueChange={(next) => onConfigChange({ format: next })}
        >
          <SelectTrigger
            aria-label="音频格式"
            className="h-8 rounded-full border bg-transparent px-2 text-xs shadow-none dark:bg-transparent"
            style={selectStyle}
          >
            <SelectValue />
          </SelectTrigger>
          <CanvasSelectContent theme={theme}>
            {AUDIO_FORMATS.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </CanvasSelectContent>
        </Select>
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

/** 图像设置弹窗内容：质量/分辨率/宽高比/尺寸/透明背景/张数，全部经 onConfigChange 写 metadata。 */
function ImageSettingsPopover({
  node,
  theme,
  onConfigChange
}: {
  node: CanvasNodeData
  theme: CanvasTheme
  onConfigChange: (patch: Record<string, unknown>) => void
}): ReactElement {
  const metadata = node.metadata ?? {}
  const quality = qualityValue(metadata.quality)
  const parsed = parseSizeValue(metadata.size)
  const tier = resolutionTierForSize(metadata.size)
  const base = parsed ?? { width: 1024, height: 1024 }
  const count = Math.min(10, Math.max(1, Math.floor(Number(metadata.count)) || 1))
  const transparent = metadata.background === 'transparent'
  const selectedRatio = parsed ? ratioLabelForSize(parsed.width, parsed.height) : null
  // 联动锁与 16 倍数对齐是纯 UI 状态；其余取值以父级 metadata 回显为准。
  const [sizeLocked, setSizeLocked] = useState(true)
  const [alignTo16, setAlignTo16] = useState(true)

  const setTier = (value: ResolutionTier): void => {
    // 以当前比例的 1k 基准缩放（幂等），避免从已缩放的尺寸上叠加。
    onConfigChange({ size: applyResolutionTier(metadata.size, value) })
  }

  const setRatio = (presetId: string): void => {
    if (presetId === 'auto') {
      onConfigChange({ size: 'auto' })
      return
    }
    const preset = RATIO_PRESETS.find((item) => item.id === presetId)
    if (!preset) return
    // size 为自动时按 1k 基准回填；否则沿用当前分辨率档缩放。
    const scaled = scaleForTier(preset, tier === 'auto' ? '1k' : tier)
    onConfigChange({ size: formatSizeValue(scaled.width, scaled.height) })
  }

  const setSize = (edited: 'width' | 'height', value: number): void => {
    const next = syncLinkedSize(base, edited, value, sizeLocked, alignTo16)
    onConfigChange({ size: formatSizeValue(next.width, next.height) })
  }

  const inputStyle = { borderColor: theme.toolbar.border, color: theme.node.text }
  return (
    <div className="flex flex-col gap-3 text-xs">
      <section className="flex flex-col gap-1.5">
        <p className="text-[11px] font-medium opacity-60">质量</p>
        <Segmented
          ariaLabel="生成质量"
          size="sm"
          className="self-start"
          value={quality}
          onChange={(value) => onConfigChange({ quality: value })}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'high', label: '高' },
            { value: 'medium', label: '中' },
            { value: 'low', label: '低' }
          ]}
        />
      </section>
      <section className="flex flex-col gap-1.5">
        <p className="text-[11px] font-medium opacity-60">分辨率</p>
        <Segmented
          ariaLabel="分辨率档位"
          size="sm"
          className="self-start"
          value={tier}
          onChange={setTier}
          options={[
            { value: 'auto', label: '自动' },
            { value: '1k', label: '1k' },
            { value: '2k', label: '2k' },
            { value: '4k', label: '4k' }
          ]}
        />
      </section>
      <section className="flex flex-col gap-1.5">
        <p className="text-[11px] font-medium opacity-60">宽高比</p>
        <div className="grid grid-cols-5 gap-1.5">
          <button
            type="button"
            className="flex flex-col items-center rounded-lg px-1 py-1.5 transition"
            style={{
              background: !parsed ? theme.toolbar.activeBg : 'transparent',
              color: !parsed ? theme.toolbar.activeText : theme.node.text
            }}
            onClick={() => setRatio('auto')}
          >
            <span className="flex h-7 items-center justify-center">
              <span
                className="block size-3.5 rounded-sm border border-dashed"
                style={{ borderColor: 'currentColor' }}
                aria-hidden
              />
            </span>
            <span className="text-[10px] font-medium leading-3.5">自动</span>
          </button>
          {RATIO_PRESETS.map((preset) => {
            const selected = selectedRatio === preset.label
            const aspect = preset.w / preset.h
            const boxWidth = aspect >= 1 ? 22 : 22 * aspect
            const boxHeight = aspect >= 1 ? 22 / aspect : 22
            return (
              <button
                key={preset.id}
                type="button"
                className="flex flex-col items-center rounded-lg px-1 py-1.5 transition"
                style={{
                  background: selected ? theme.toolbar.activeBg : 'transparent',
                  color: selected ? theme.toolbar.activeText : theme.node.text
                }}
                onClick={() => setRatio(preset.id)}
              >
                <span className="flex h-7 items-center justify-center">
                  <span
                    className="block rounded-sm border"
                    style={{
                      width: boxWidth,
                      height: boxHeight,
                      borderColor: selected ? 'currentColor' : theme.toolbar.border
                    }}
                    aria-hidden
                  />
                </span>
                <span className="text-[10px] font-medium leading-3.5">{preset.label}</span>
              </button>
            )
          })}
        </div>
      </section>
      <section className="flex flex-col gap-1.5">
        <p className="text-[11px] font-medium opacity-60">尺寸</p>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            aria-label="宽度"
            min={16}
            step={16}
            value={base.width}
            onChange={(event) => setSize('width', Number(event.target.value))}
            className="h-7 min-w-0 flex-1 text-xs"
            style={inputStyle}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={sizeLocked ? '解除宽高联动' : '锁定宽高联动'}
            title={sizeLocked ? '解除联动' : '联动宽高'}
            style={{ color: theme.node.text }}
            onClick={() => setSizeLocked((current) => !current)}
          >
            {sizeLocked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
          </Button>
          <Input
            type="number"
            aria-label="高度"
            min={16}
            step={16}
            value={base.height}
            onChange={(event) => setSize('height', Number(event.target.value))}
            className="h-7 min-w-0 flex-1 text-xs"
            style={inputStyle}
          />
        </div>
        <label className="flex items-center gap-1.5 text-[11px] opacity-70">
          <Switch
            checked={alignTo16}
            aria-label="16 倍数对齐"
            onCheckedChange={(checked) => setAlignTo16(checked)}
          />
          16 倍数对齐
        </label>
      </section>
      <section className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <p className="text-[11px] font-medium opacity-60">透明背景</p>
          <p className="text-[10px] opacity-45">仅部分模型支持</p>
        </div>
        <Switch
          checked={transparent}
          aria-label="透明背景"
          onCheckedChange={(checked) =>
            onConfigChange({ background: checked ? 'transparent' : undefined })
          }
        />
      </section>
      <section className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium opacity-60">生成张数</p>
        <Input
          type="number"
          aria-label="生成张数"
          min={1}
          max={10}
          value={count}
          onChange={(event) =>
            onConfigChange({
              count: Math.min(10, Math.max(1, Math.floor(Number(event.target.value)) || 1))
            })
          }
          className="h-7 w-16 text-center text-xs"
          style={inputStyle}
        />
      </section>
    </div>
  )
}

/**
 * 图像模式底部快捷栏：模型 + 参数快照 pill（图像设置 Popover）+ 展开 + 存模板 + 圆形发送按钮。
 * video/audio/text 模式不使用此组件，保持原 ConfigSettingsRow 布局。
 */
function ImageQuickBar({
  node,
  theme,
  mode,
  prompt,
  isRunning,
  canGenerate,
  className,
  leading,
  onPromptChange,
  onGenerate,
  onStop,
  onConfigChange
}: {
  node: CanvasNodeData
  theme: CanvasTheme
  mode: string
  prompt: string
  isRunning: boolean
  canGenerate: boolean
  className?: string
  leading?: ReactElement
  onPromptChange: (value: string) => void
  onGenerate: () => void
  onStop: () => void
  onConfigChange: (patch: Record<string, unknown>) => void
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [savedTemplate, setSavedTemplate] = useState(false)
  const savedTimerRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current)
    }
  }, [])

  const metadata = node.metadata ?? {}
  const count = Math.min(10, Math.max(1, Math.floor(Number(metadata.count)) || 1))
  const quality = qualityValue(metadata.quality)
  const trimmed = prompt.trim()

  const handleSaveTemplate = (): void => {
    if (!trimmed) return
    saveCanvasAsset({ kind: 'text', title: trimmed.slice(0, 20) || '提示词模板', content: trimmed })
    setSavedTemplate(true)
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current)
    savedTimerRef.current = window.setTimeout(() => setSavedTemplate(false), 800)
  }

  const handleGenerate = (): void => {
    if (isRunning || !canGenerate) return
    onGenerate()
    setExpanded(false)
  }

  return (
    <div className={`flex min-w-0 flex-1 flex-wrap items-center gap-2 ${className ?? ''}`}>
      {leading}
      <ModelPicker
        theme={theme}
        mode={mode}
        providerId={typeof metadata.providerId === 'string' ? metadata.providerId : undefined}
        model={typeof metadata.model === 'string' ? metadata.model : undefined}
        onChange={onConfigChange}
      />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            title="图像设置"
            className="border px-2.5 text-xs"
            style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
          >
            {snapshotLabel(metadata.size, count, quality)}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="w-[340px]"
          style={{
            background: theme.node.panel,
            borderColor: theme.node.stroke,
            color: theme.node.text
          }}
          data-canvas-no-zoom
          onWheel={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ImageSettingsPopover node={node} theme={theme} onConfigChange={onConfigChange} />
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="展开编辑提示词"
        style={{ color: theme.node.text }}
        onClick={() => setExpanded(true)}
      >
        <Maximize2 className="size-3.5" />
      </Button>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="w-[720px] sm:max-w-[720px]"
          style={{
            background: theme.node.panel,
            borderColor: theme.node.stroke,
            color: theme.node.text
          }}
          data-canvas-no-zoom
          onWheel={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <DialogTitle className="text-sm font-semibold">编辑提示词</DialogTitle>
          <textarea
            aria-label="提示词全文"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                handleGenerate()
              }
            }}
            className="thin-scrollbar min-h-64 w-full resize-y rounded-xl border bg-transparent p-3 text-sm leading-6 outline-none"
            style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
            placeholder="描述要生成的图片内容"
          />
          <DialogFooter className="items-center gap-3">
            <span className="text-[10px] opacity-45">
              Ctrl/Cmd + Enter 生成；编辑实时生效，关闭不丢失。
            </span>
            <Button
              type="button"
              className="h-8 rounded-full px-4 text-xs"
              disabled={!canGenerate || isRunning}
              style={{
                background: theme.toolbar.activeBg,
                color: theme.toolbar.activeText
              }}
              onClick={handleGenerate}
            >
              生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="存为提示词模板"
        disabled={!trimmed}
        style={{ color: theme.node.text }}
        onClick={handleSaveTemplate}
      >
        {savedTemplate ? <Check className="size-3.5" /> : <BookmarkPlus className="size-3.5" />}
      </Button>
      <Button
        type="button"
        disabled={!isRunning && !canGenerate}
        className={isRunning ? 'h-9 gap-1 rounded-full px-3 text-xs' : 'size-9 rounded-full p-0'}
        style={{
          background: isRunning ? '#b91c1c' : theme.toolbar.activeBg,
          color: isRunning ? '#fff' : theme.toolbar.activeText
        }}
        title={isRunning ? '停止' : '生成'}
        onClick={() => (isRunning ? onStop() : handleGenerate())}
      >
        {isRunning ? (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            <Square className="size-3 fill-current" />
            停止
          </>
        ) : (
          <ArrowUp className="size-4" />
        )}
      </Button>
    </div>
  )
}

/** 节点级模型选项：一个已启用 Provider 下的一段候选模型。 */
interface ModelOption {
  value: string
  label: string
}

/** 按模态聚合已启用 Provider 的候选模型（行默认 model + params.models）。 */
export function providerModelOptions(rows: MediaProviderRow[], modality: string): ModelOption[] {
  const options: ModelOption[] = []
  for (const row of rows) {
    if (row.modality !== modality || !row.enabled) continue
    const extra = typeof row.params?.models === 'string' ? row.params.models.split(/\r?\n/) : []
    const models = [...new Set([row.model, ...extra].map((model) => model.trim()).filter(Boolean))]
    for (const model of models) {
      options.push({ value: `${row.id}:${model}`, label: `${row.name} / ${model}` })
    }
  }
  return options
}

/** 节点面板模型选择：写 metadata.providerId/model；空 value = 跟随全局默认（清除）。 */
function ModelPicker({
  theme,
  mode,
  providerId,
  model,
  onChange
}: {
  theme: CanvasTheme
  mode: string
  providerId?: string
  model?: string
  onChange: (patch: { providerId?: string; model?: string }) => void
}): ReactElement {
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void listMediaProviders()
      .then((rows) => {
        if (!cancelled) setOptions(providerModelOptions(rows, mode))
      })
      .catch(() => {
        if (!cancelled) setOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [mode])
  const value = providerId && model ? `${providerId}:${model}` : ''
  const unavailable = options !== null && options.length === 0
  return (
    <label className="inline-flex min-w-0 flex-1 items-center gap-1 text-xs opacity-70">
      模型
      <Select
        value={value || FOLLOW_GLOBAL_DEFAULT}
        disabled={options === null || unavailable}
        onValueChange={(next) => {
          if (next === FOLLOW_GLOBAL_DEFAULT) {
            onChange({ providerId: undefined, model: undefined })
            return
          }
          const separator = next.indexOf(':')
          onChange({ providerId: next.slice(0, separator), model: next.slice(separator + 1) })
        }}
      >
        <SelectTrigger
          aria-label="模型"
          className="h-8 min-w-0 flex-1 rounded-full border bg-transparent px-2 text-xs shadow-none dark:bg-transparent"
          style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
        >
          <SelectValue />
        </SelectTrigger>
        <CanvasSelectContent theme={theme}>
          <SelectItem value={FOLLOW_GLOBAL_DEFAULT}>
            {options === null
              ? '加载模型中…'
              : unavailable
                ? '未配置可用的 Provider'
                : '跟随全局默认'}
          </SelectItem>
          {(options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </CanvasSelectContent>
      </Select>
    </label>
  )
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
  orderedReferences = [],
  onAddReferenceImages,
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

  const modelPickerProps = {
    theme,
    mode,
    providerId:
      typeof node.metadata?.providerId === 'string' ? node.metadata.providerId : undefined,
    model: typeof node.metadata?.model === 'string' ? node.metadata.model : undefined
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

  const modeSelect = (
    <Select value={mode} onValueChange={updateMode}>
      <SelectTrigger
        aria-label="节点模式"
        className="h-8 min-w-28 rounded-full border bg-transparent px-3 text-xs shadow-none dark:bg-transparent"
        style={{ borderColor: theme.toolbar.border, color: theme.node.text }}
      >
        <SelectValue />
      </SelectTrigger>
      <CanvasSelectContent theme={theme}>
        <SelectItem value="text">文本 Agent</SelectItem>
        <SelectItem value="image">图片工作流</SelectItem>
        <SelectItem value="video">视频工作流</SelectItem>
        <SelectItem value="audio">音频工作流</SelectItem>
      </CanvasSelectContent>
    </Select>
  )

  const imageQuickBarProps = {
    node,
    theme,
    mode,
    prompt,
    isRunning,
    canGenerate,
    onPromptChange: updatePrompt,
    onGenerate: () => onGenerate(node.id, prompt.trim(), mode),
    onStop: () => onStop(node.id),
    onConfigChange: changeConfig
  }

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
      {(mode === 'image' || mode === 'video') && (
        <div className="mt-2">
          <p className="mb-1 text-[10px] font-medium opacity-55">
            参考图（按发送顺序）
            {mode === 'video' && <span className="ml-1 opacity-70">· 首张为生成主参考</span>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {orderedReferences.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {orderedReferences.map((reference, index) => (
                  <figure key={reference.nodeId} className="w-16">
                    <img
                      src={proxyExternalImageUrl(reference.src)}
                      alt={reference.title}
                      className="h-12 w-16 rounded-lg border object-cover"
                      style={{
                        borderColor: reference.isSelf
                          ? theme.toolbar.activeBg
                          : theme.toolbar.border
                      }}
                    />
                    <figcaption className="mt-0.5 truncate text-[10px] opacity-60">
                      {reference.isSelf
                        ? mode === 'video'
                          ? '第1张 · 主参考'
                          : '第1张 · 原图'
                        : `参考图${index + 1}`}
                    </figcaption>
                    <p className="truncate text-[10px] opacity-45" title={reference.title}>
                      {reference.title}
                    </p>
                  </figure>
                ))}
              </div>
            ) : node.type === 'image' ? (
              <p className="text-[10px] opacity-50">
                {mode === 'video'
                  ? '将以本节点图片作为首张主参考发送。'
                  : '将以本节点图片作为第 1 张原图发送。'}
              </p>
            ) : (
              <p className="text-[10px] opacity-50">
                {mode === 'video'
                  ? '未连接图片参考，将按纯文字生成视频。'
                  : '未连接图片参考，将按纯文字生成。'}
              </p>
            )}
            <label
              className="inline-flex size-12 cursor-pointer items-center justify-center rounded-full border border-dashed opacity-70 transition hover:opacity-100"
              style={{ borderColor: theme.toolbar.border }}
              title="上传参考图"
            >
              <Plus className="size-4" />
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files
                  if (files && files.length > 0) onAddReferenceImages?.(node.id, files)
                  event.target.value = ''
                }}
              />
            </label>
          </div>
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
                ? '描述要生成的图片内容'
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
      {!isConfig && mode !== 'text' && mode !== 'image' && onConfigChange && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ConfigSettingsRow
            node={node}
            theme={theme}
            mode={mode}
            onConfigChange={(patch) => onConfigChange(node.id, patch)}
          />
          <ModelPicker {...modelPickerProps} onChange={changeConfig} />
        </div>
      )}
      {isConfig && mode === 'image' ? (
        <ImageQuickBar {...imageQuickBarProps} className="mt-2" />
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2">
          {isConfig ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <ConfigSettingsRow
                node={node}
                theme={theme}
                mode={mode}
                onConfigChange={changeConfig}
              />
              {mode !== 'text' && <ModelPicker {...modelPickerProps} onChange={changeConfig} />}
            </div>
          ) : mode === 'image' && onConfigChange ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {modeSelect}
              <ImageQuickBar {...imageQuickBarProps} />
            </div>
          ) : (
            modeSelect
          )}
          {!(mode === 'image' && (isConfig || Boolean(onConfigChange))) && (
            <button
              type="button"
              disabled={!isRunning && !canGenerate}
              className="inline-flex h-9 min-w-20 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-35"
              style={{
                background: isRunning ? '#b91c1c' : theme.toolbar.activeBg,
                color: isRunning ? '#fff' : theme.toolbar.activeText
              }}
              onClick={() =>
                isRunning ? onStop(node.id) : onGenerate(node.id, prompt.trim(), mode)
              }
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
          )}
        </div>
      )}
      <p className="mt-2 text-[10px] opacity-45">
        {isConfig
          ? 'Ctrl/Cmd + Enter 生成；无提示词时将直接汇总上游输入交给 Agent。'
          : 'Ctrl/Cmd + Enter 生成。图片、视频、音频模式会先由画布 Agent 输出可继续编辑的工作流文本。'}
      </p>
    </div>
  )
}
