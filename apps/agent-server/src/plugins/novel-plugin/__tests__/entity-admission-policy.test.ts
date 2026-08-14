import { describe, expect, it } from 'vitest'
import {
  findCoveredConflict,
  isAdmissibleNewClue,
  selectAdmissibleNewClues,
} from '../core/entities/entity-admission-policy.js'

describe('entity admission policy', () => {
  it('accepts a clue only when it has evidence, a target, and a verification path', () => {
    expect(isAdmissibleNewClue({
      description: '父亲遗物上的车票编号与旧货栈账簿一致',
      pointsTo: '父亲失踪可能与旧货栈的私下交易有关',
      nextStep: '比对旧货栈账簿和车票编号的登记人',
    })).toBe(true)

    expect(isAdmissibleNewClue({
      description: '叶明远在陌生房间听见爆炸声，确认环境异常',
      pointsTo: '叶明远可能已经来到陌生世界',
      nextStep: '确认地点与周围人员身份',
    })).toBe(false)
  })

  it('does not create multiple clues from one chapter by default', () => {
    const clue = {
      description: '父亲遗物上的车票编号与旧货栈账簿一致',
      pointsTo: '父亲失踪可能与旧货栈的私下交易有关',
      nextStep: '比对旧货栈账簿和车票编号的登记人',
    }
    expect(selectAdmissibleNewClues([clue, { ...clue, description: '账簿记录上的交易编号' }])).toEqual([clue])
  })

  it('recognizes paraphrased same-chapter conflicts as an update to the planned conflict', () => {
    const existing = [{
      id: 'moral-conflict',
      description: '叶明远刚被裁员，房租、生活与下一份工作都没有着落，却在斑马线前看见失控货车冲向小男孩。他必须在保全自身这个本能与救下孩子的道德选择之间作出决定，最终以致命撞击为代价完成救援。',
      type: 'moral' as const,
      chapterSpans: [[1, 1]] as Array<[number, number]>,
    }]

    const covered = findCoveredConflict(existing as any, {
      description: '叶明远在失业、房租和未来职业选择的压力下，仍必须在瞬间决定是否冒险救下斑马线上的小男孩。',
      type: 'moral',
    }, 1)

    expect(covered?.id).toBe('moral-conflict')
    expect(findCoveredConflict(existing as any, {
      description: '叶明远发现工牌记录被人篡改，必须找出篡改者以免被当成叛徒。',
      type: 'moral',
    }, 1)).toBeUndefined()
  })
})
