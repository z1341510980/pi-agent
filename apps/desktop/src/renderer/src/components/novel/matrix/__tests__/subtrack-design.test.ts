import { describe, expect, it } from 'vitest'
import {
  buildSubtracksForEntity,
  computeCurvePointDrag,
  computeSubtrackNodeChapter,
} from '../subtrack-builders'
import { computeSubtrackPopoverPosition } from '../subtrack-popover-position'
import type { MatrixEntity } from '../matrix-logic'

const baseEntity: MatrixEntity = {
  id: 'entity-1',
  entityId: 'entity-1',
  entityType: 'conflict',
  kind: 'conflict',
  name: '主冲突',
}

describe('子轨道设计稿映射', () => {
  it('冲突使用设计稿中的六条轨道名称和独立颜色', () => {
    const tracks = buildSubtracksForEntity({
      ...baseEntity,
      chapterSpans: [[5, 14]],
      intensityPoints: [{ chapter: 5, value: 2 }, { chapter: 14, value: 10 }],
      turningPoints: [{ chapter: 12, label: '身份反转' }],
      resolutionProgress: [{ chapter: 14, percent: 80 }],
    }, 'conflict')

    expect(tracks.map((track) => track.label)).toEqual([
      '冲突阶段',
      '张力强度',
      '参与方博弈',
      '赌注/代价',
      '突转潜力',
      '推进节点',
    ])
    expect(new Set(tracks.map((track) => track.color)).size).toBeGreaterThan(3)
    expect(tracks[4].nodes?.[0]?.shape).toBe('diamond')
  })

  it('伏笔使用设计稿中的五条轨道，并用不同形状区分事件类型', () => {
    const tracks = buildSubtracksForEntity({
      ...baseEntity,
      entityType: 'foreshadow',
      kind: 'foreshadow',
      plantChapter: 4,
      payoffChapter: 16,
      foreshadowBeats: [
        { chapter: 4, type: 'plant', note: '埋设' },
        { chapter: 9, type: 'reinforce', note: '强化' },
        { chapter: 16, type: 'payoff', note: '回收' },
      ],
      plantMethod: 'implicit',
      recoverMethod: 'progressive',
    }, 'foreshadow')

    expect(tracks.map((track) => track.label)).toEqual([
      '伏笔状态',
      '事件链 beats',
      '埋设/回收手法',
      '关联实体',
      '信息差承载',
    ])
    expect(tracks[1].nodes?.map((node) => node.shape)).toEqual(['circle', 'diamond', 'star'])
  })
})

describe('子轨道编辑浮层定位', () => {
  it('优先显示在触发点右下方，并限制在视口内', () => {
    expect(computeSubtrackPopoverPosition({ x: 120, y: 80 }, { width: 360, height: 420 }, { width: 1280, height: 800 }))
      .toEqual({ left: 132, top: 92 })

    expect(computeSubtrackPopoverPosition({ x: 1240, y: 760 }, { width: 360, height: 420 }, { width: 1280, height: 800 }))
      .toEqual({ left: 868, top: 328 })
  })
})

describe('子轨道拖拽计算', () => {
  it('按横向像素变化换算曲线点章节', () => {
    expect(computeCurvePointDrag({ chapter: 5, value: 0.5 }, 41, 0, 20, 36))
      .toEqual({ chapter: 7, value: 0.5 })
  })

  it('曲线点纵向拖拽值限制在 0-1', () => {
    expect(computeCurvePointDrag({ chapter: 5, value: 0.9 }, 0, -40, 20, 36).value).toBe(1)
    expect(computeCurvePointDrag({ chapter: 5, value: 0.1 }, 0, 40, 20, 36).value).toBe(0)
  })

  it('节点横向拖拽后的章节不小于 1', () => {
    expect(computeSubtrackNodeChapter(2, -100, 20)).toBe(1)
  })
})
