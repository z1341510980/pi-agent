import { describe, expect, it } from 'vitest'
import { formatStyleMetricsAsFingerprint, measureStyleMetrics } from '../core/analysis/style-measurement.js'

describe('style measurement', () => {
  it('uses one deterministic snapshot for reference and chapter text', () => {
    const text = Array.from({ length: 24 }, (_, index) => (
      index % 2 === 0
        ? '她抬起头，看见雨水沿着旧墙的裂缝往下流，掌心被门上的铁锈刺痛。'
        : '“你还要继续吗？”他没有回答，只把手按在门上。'
    )).join('\n')

    const snapshot = measureStyleMetrics(text)
    expect(snapshot.paragraphCount).toBe(24)
    expect(snapshot.sentenceCount).toBeGreaterThan(20)
    expect(snapshot.dialogue.charRatio).toBeGreaterThan(0)
    expect(snapshot.sensoryMix.visual).toBeGreaterThan(0)
    expect(snapshot.sensoryMix.tactile).toBeGreaterThan(0)

    const fingerprint = formatStyleMetricsAsFingerprint(snapshot, '测试样本')
    expect(fingerprint).toContain('平均句长')
    expect(fingerprint).toContain('对话占比')
    expect(fingerprint).toContain('说明：')
  })

  it('does not treat a small sample as a hard fingerprint', () => {
    const snapshot = measureStyleMetrics('她看着门。门外没有声音。')
    expect(snapshot.trustworthy).toBe(false)
    expect(formatStyleMetricsAsFingerprint(snapshot, '小样本')).toContain('仅作参考')
  })
})
