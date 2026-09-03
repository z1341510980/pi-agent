import { describe, expect, it } from 'vitest'
import {
  applySceneCarry,
  checkSceneWords,
  countSceneWords,
  sceneDeviation,
} from '../core/chapters/scene-word-check.js'

describe('scene-word-check', () => {
  it('预算 ±20% 内接受', () => {
    expect(checkSceneWords(1000, 800, 0)).toBe('accept')
    expect(checkSceneWords(1000, 1200, 0)).toBe('accept')
  })

  it('超过 20% 要求压缩，重试后不再循环', () => {
    expect(checkSceneWords(1000, 1201, 0)).toBe('compress')
    expect(checkSceneWords(1000, 1400, 1)).toBe('accept')
  })

  it('低于 50% 要求扩写', () => {
    expect(checkSceneWords(1000, 499, 0)).toBe('expand')
    expect(checkSceneWords(1000, 500, 0)).toBe('accept')
  })

  it('结转超支时保留单场最低预算', () => {
    expect(applySceneCarry(1000, 300)).toEqual({ effective: 700, carry: 0 })
    expect(applySceneCarry(300, 500)).toEqual({ effective: 200, carry: 400 })
  })

  it('结转欠缺时增补下一场', () => {
    expect(applySceneCarry(1000, -200)).toEqual({ effective: 1200, carry: 0 })
  })

  it('统计与偏差使用去空白口径', () => {
    expect(countSceneWords('甲 乙\n丙')).toBe(3)
    expect(sceneDeviation(1100, 1000)).toBe(100)
  })
})
