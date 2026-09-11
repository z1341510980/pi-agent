import { describe, expect, it } from 'vitest'

import {
  RATIO_PRESETS,
  align16,
  formatSizeValue,
  parseSizeValue,
  ratioLabelForSize,
  scaleForTier,
  snapshotLabel,
  syncLinkedSize
} from '../canvas-node-panel/image-size-math'

describe('RATIO_PRESETS / align16', () => {
  it('包含 9 个比例预设，21:9 基准为 1792x768', () => {
    expect(RATIO_PRESETS).toHaveLength(9)
    expect(RATIO_PRESETS.find((preset) => preset.id === '21:9')).toEqual({
      id: '21:9',
      w: 1792,
      h: 768,
      label: '21:9'
    })
  })

  it('align16 向最近的 16 倍数取整且下限为 16', () => {
    expect(align16(15)).toBe(16)
    expect(align16(16)).toBe(16)
    expect(align16(24)).toBe(32)
    expect(align16(0)).toBe(16)
  })
})

describe('scaleForTier', () => {
  it("tier 'auto' 返回 {0,0} 表示自动", () => {
    expect(scaleForTier({ w: 1024, h: 1024 }, 'auto')).toEqual({ width: 0, height: 0 })
  })

  it('21:9 1k 基准与 2k/4k 缩放后保持 16 对齐', () => {
    expect(scaleForTier({ w: 1792, h: 768 }, '1k')).toEqual({ width: 1792, height: 768 })
    expect(scaleForTier({ w: 1792, h: 768 }, '2k')).toEqual({ width: 3584, height: 1536 })
    expect(scaleForTier({ w: 1024, h: 1024 }, '4k')).toEqual({ width: 4096, height: 4096 })
    expect(scaleForTier({ w: 1536, h: 864 }, '2k')).toEqual({ width: 3072, height: 1728 })
  })
})

describe('parseSizeValue / formatSizeValue', () => {
  it("解析 'WxH'，'auto'/非法/非字符串返回 null", () => {
    expect(parseSizeValue('1536x864')).toEqual({ width: 1536, height: 864 })
    expect(parseSizeValue('auto')).toBeNull()
    expect(parseSizeValue('abc')).toBeNull()
    expect(parseSizeValue(123)).toBeNull()
    expect(parseSizeValue('0x100')).toBeNull()
  })

  it('序列化 WxH，任一边非正数回退 auto', () => {
    expect(formatSizeValue(1536, 864)).toBe('1536x864')
    expect(formatSizeValue(0, 100)).toBe('auto')
    expect(formatSizeValue(100, 0)).toBe('auto')
  })
})

describe('syncLinkedSize', () => {
  it('未锁定时只改被编辑的一边', () => {
    expect(syncLinkedSize({ width: 1024, height: 1024 }, 'width', 2000, false, false)).toEqual({
      width: 2000,
      height: 1024
    })
    expect(syncLinkedSize({ width: 1536, height: 864 }, 'height', 900, false, false)).toEqual({
      width: 1536,
      height: 900
    })
  })

  it('锁定时按变更前比例联动另一边并 16 对齐', () => {
    expect(syncLinkedSize({ width: 1536, height: 864 }, 'width', 3200, true, true)).toEqual({
      width: 3200,
      height: 1808
    })
    expect(syncLinkedSize({ width: 1536, height: 864 }, 'height', 1728, true, true)).toEqual({
      width: 3072,
      height: 1728
    })
  })

  it('锁定但关闭 16 对齐时另一边仍按比例联动', () => {
    expect(syncLinkedSize({ width: 1536, height: 864 }, 'width', 768, true, false)).toEqual({
      width: 768,
      height: 432
    })
  })
})

describe('ratioLabelForSize', () => {
  it('精确匹配与 2% 容差内匹配比例名', () => {
    expect(ratioLabelForSize(1536, 864)).toBe('16:9')
    expect(ratioLabelForSize(1792, 768)).toBe('21:9')
    expect(ratioLabelForSize(1600, 900)).toBe('16:9')
    expect(ratioLabelForSize(1536, 880)).toBe('16:9')
  })

  it('超出容差或非法尺寸返回 null', () => {
    expect(ratioLabelForSize(1000, 700)).toBeNull()
    expect(ratioLabelForSize(0, 864)).toBeNull()
  })
})

describe('snapshotLabel', () => {
  it('size auto/非法 → 自动·N张', () => {
    expect(snapshotLabel(undefined, 3, 'auto')).toBe('自动·3张')
    expect(snapshotLabel('bogus', 2, 'auto')).toBe('自动·2张')
  })

  it('匹配比例名或回退 W×H，张数钳 1-10', () => {
    expect(snapshotLabel('1536x864', 2, 'auto')).toBe('16:9·2张')
    expect(snapshotLabel('3584x1536', 2, 'auto')).toBe('21:9·2张')
    expect(snapshotLabel('1024x1000', 2, 'auto')).toBe('1024×1000·2张')
    expect(snapshotLabel(undefined, 25, 'auto')).toBe('自动·10张')
  })

  it('quality 非 auto 时加高/中/低前缀', () => {
    expect(snapshotLabel('1536x864', 2, 'high')).toBe('高·16:9·2张')
    expect(snapshotLabel('1536x864', 2, 'medium')).toBe('中·16:9·2张')
    expect(snapshotLabel('1536x864', 2, 'low')).toBe('低·16:9·2张')
  })
})
