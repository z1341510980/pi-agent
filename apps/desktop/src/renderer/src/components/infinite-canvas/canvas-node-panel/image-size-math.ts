export type QualityTier = 'auto' | 'high' | 'medium' | 'low'
export type ResolutionTier = 'auto' | '1k' | '2k' | '4k'

export const RATIO_PRESETS: Array<{ id: string; w: number; h: number; label: string }> = [
  { id: '1:1', w: 1024, h: 1024, label: '1:1' },
  { id: '2:3', w: 1024, h: 1536, label: '2:3' },
  { id: '3:2', w: 1536, h: 1024, label: '3:2' },
  { id: '4:3', w: 1152, h: 896, label: '4:3' },
  { id: '3:4', w: 896, h: 1152, label: '3:4' },
  { id: '16:9', w: 1536, h: 864, label: '16:9' },
  { id: '9:16', w: 864, h: 1536, label: '9:16' },
  { id: '21:9', w: 1792, h: 768, label: '21:9' },
  { id: '9:21', w: 768, h: 1792, label: '9:21' }
]

export const align16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)

/** 分辨率档缩放：tier→倍数（1k=1, 2k=2, 4k=4），16 对齐；'auto' → {0,0}（表示自动）。 */
export function scaleForTier(
  ratio: { w: number; h: number },
  tier: ResolutionTier
): { width: number; height: number } {
  if (tier === 'auto') return { width: 0, height: 0 }
  const multiplier = tier === '1k' ? 1 : tier === '2k' ? 2 : 4
  return { width: align16(ratio.w * multiplier), height: align16(ratio.h * multiplier) }
}

/** 解析 metadata.size：'auto'→null；'WxH'→{width,height}；非法→null。 */
export function parseSizeValue(size: unknown): { width: number; height: number } | null {
  if (typeof size !== 'string') return null
  const match = /^(\d+)x(\d+)$/.exec(size.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return null
  return { width, height }
}

/** 序列化：width/height 均 >0 → `${w}x${h}`；否则 'auto'。 */
export function formatSizeValue(width: number, height: number): string {
  return width > 0 && height > 0 ? `${width}x${height}` : 'auto'
}

/** 宽高联动：ratio = w/h（用变更前的值），已知一边+锁定 → 另一边 align16。 */
export function syncLinkedSize(
  current: { width: number; height: number },
  edited: 'width' | 'height',
  value: number,
  locked: boolean,
  align: boolean
): { width: number; height: number } {
  const nextValue = align ? align16(value) : value
  if (!locked) {
    return edited === 'width'
      ? { width: nextValue, height: current.height }
      : { width: current.width, height: nextValue }
  }
  const ratio = current.height > 0 ? current.width / current.height : 0
  if (edited === 'width') {
    return { width: nextValue, height: ratio > 0 ? align16(nextValue / ratio) : current.height }
  }
  return { width: ratio > 0 ? align16(nextValue * ratio) : current.width, height: nextValue }
}

/** 匹配比例名：WxH 与 preset 宽高比误差 <2% → 返回 preset.label，否则 null。 */
export function ratioLabelForSize(width: number, height: number): string | null {
  if (!(width > 0) || !(height > 0)) return null
  const ratio = width / height
  for (const preset of RATIO_PRESETS) {
    const presetRatio = preset.w / preset.h
    if (Math.abs(ratio - presetRatio) / presetRatio < 0.02) return preset.label
  }
  return null
}

/** 快照文案：size auto/非法 → `自动·<n>张`；否则 `<比例名|W×H>·<n>张`。quality 非 auto 时前缀 `<质量>·`。 */
export function snapshotLabel(size: unknown, count: number, quality: QualityTier): string {
  const parsed = parseSizeValue(size)
  const sizeLabel = parsed
    ? (ratioLabelForSize(parsed.width, parsed.height) ?? `${parsed.width}×${parsed.height}`)
    : '自动'
  const qualityPrefix =
    quality === 'high' ? '高·' : quality === 'medium' ? '中·' : quality === 'low' ? '低·' : ''
  const clamped = Math.min(10, Math.max(1, Math.floor(count) || 1))
  return `${qualityPrefix}${sizeLabel}·${clamped}张`
}

/** 分辨率档切换：先按当前比例解析 1k 基准（未匹配回退当前 W/H，再退 1024 基准），再 ×1/×2/×4（幂等，不叠加）。 */
export function applyResolutionTier(size: unknown, tier: ResolutionTier): string {
  if (tier === 'auto') return 'auto'
  const parsed = parseSizeValue(size)
  if (!parsed) {
    const scaled = scaleForTier({ w: 1024, h: 1024 }, tier)
    return formatSizeValue(scaled.width, scaled.height)
  }
  const label = ratioLabelForSize(parsed.width, parsed.height)
  const preset = label ? RATIO_PRESETS.find((item) => item.label === label) : null
  const ratioBase = preset ? { w: preset.w, h: preset.h } : { w: parsed.width, h: parsed.height }
  const scaled = scaleForTier(ratioBase, tier)
  return formatSizeValue(scaled.width, scaled.height)
}
