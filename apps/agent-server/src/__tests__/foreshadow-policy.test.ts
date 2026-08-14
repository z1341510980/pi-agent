import { describe, expect, it } from 'vitest'
import {
  isAdmissibleNewForeshadow,
  selectAdmissibleNewForeshadows,
} from '../plugins/novel-plugin/core/entities/foreshadow-policy.js'
import { normalizePlannedForeshadows } from '../plugins/novel-plugin/core/generation/novel-entity-generator.js'

describe('伏笔准入规则', () => {
  it('拒绝普通事实、即时风险和没有回收计划的未知点', () => {
    expect(isAdmissibleNewForeshadow({
      importance: 'major',
      narrativeRole: 'dark_line',
      hiddenQuestion: '父亲真正的死因是什么',
      plannedPayoff: '',
    })).toBe(false)

    expect(isAdmissibleNewForeshadow({
      importance: 'minor',
      narrativeRole: 'dark_line',
      hiddenQuestion: '尸体会不会被发现',
      plannedPayoff: '下一章被工头发现',
    })).toBe(false)
  })

  it('只接收服务暗线或重大揭示且有明确回收计划的高价值伏笔', () => {
    expect(isAdmissibleNewForeshadow({
      importance: 'critical',
      narrativeRole: 'dark_line',
      hiddenQuestion: '父亲真正因何死亡',
      plannedPayoff: '查到旧案主谋时揭示遗物编号来源',
    })).toBe(true)
  })

  it('单章最多保留一条新伏笔', () => {
    const candidates = [
      {
        description: '父亲遗物编号', importance: 'critical', narrativeRole: 'dark_line',
        hiddenQuestion: '父亲真正因何死亡', plannedPayoff: '旧案高潮揭示',
      },
      {
        description: '王室血脉印记', importance: 'major', narrativeRole: 'major_reveal',
        hiddenQuestion: '主角真实身份是什么', plannedPayoff: '王位争夺时揭示',
      },
    ]

    expect(selectAdmissibleNewForeshadows(candidates)).toEqual([candidates[0]])
  })

  it('AI 编排只保留本章有明确动作的合格已有伏笔，并过滤普通新事项', () => {
    expect(normalizePlannedForeshadows([
      {
        coreStyle: '已有：父亲遗物上的编号',
        importance: 'critical',
        narrativeRole: 'dark_line',
        hiddenQuestion: '父亲真正因何死亡',
        plannedPayoff: '查到旧案主谋时揭示编号来源',
        chapterAction: 'reinforce',
      },
      { coreStyle: '已有：只是仍未回收的旧条目' },
      { coreStyle: '工头今天没有说话' },
      {
        coreStyle: '父亲遗物编号与旧案卷宗一致',
        importance: 'critical',
        narrativeRole: 'dark_line',
        hiddenQuestion: '父亲真正因何死亡',
        plannedPayoff: '查到旧案主谋时揭示编号来源',
      },
    ])).toEqual([
      expect.objectContaining({ coreStyle: '已有：父亲遗物上的编号' }),
      expect.objectContaining({ coreStyle: '父亲遗物编号与旧案卷宗一致' }),
    ])
  })
})
