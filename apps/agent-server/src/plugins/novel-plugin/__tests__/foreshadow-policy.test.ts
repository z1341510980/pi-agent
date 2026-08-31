import { describe, expect, it } from 'vitest'
import {
  isAdmissibleNewForeshadow,
  selectAdmissibleNewForeshadows,
} from '../core/entities/foreshadow-policy.js'
import { normalizePlannedForeshadows } from '../core/generation/novel-entity-generator.js'

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

  it('AI 编排：已有伏笔复用不再要求准入字段，chapterAction 归一化/兜底；新增仍走准入门槛', () => {
    expect(normalizePlannedForeshadows([
      {
        coreStyle: '已有：父亲遗物上的编号',
        importance: 'critical',
        narrativeRole: 'dark_line',
        hiddenQuestion: '父亲真正因何死亡',
        plannedPayoff: '查到旧案主谋时揭示编号来源',
        chapterAction: 'reinforce',
      },
      // 复用项缺准入字段与 chapterAction：不再整条丢弃（旧实现会静默消失），
      // chapterAction 兜底为 reinforce，保证矩阵格子里一定有 beat
      { coreStyle: '已有：只是仍未回收的旧条目' },
      // 复用项 chapterAction 写中文：归一化到枚举
      { coreStyle: '已有：父亲遗物上的编号', chapterAction: '揭示' },
      { coreStyle: '工头今天没有说话' },
      {
        coreStyle: '父亲遗物编号与旧案卷宗一致',
        importance: 'critical',
        narrativeRole: 'dark_line',
        hiddenQuestion: '父亲真正因何死亡',
        plannedPayoff: '查到旧案主谋时揭示编号来源',
      },
    ])).toEqual([
      expect.objectContaining({ coreStyle: '已有：父亲遗物上的编号', chapterAction: 'reinforce' }),
      expect.objectContaining({ coreStyle: '已有：只是仍未回收的旧条目', chapterAction: 'reinforce' }),
      expect.objectContaining({ coreStyle: '已有：父亲遗物上的编号', chapterAction: 'reveal' }),
      expect.objectContaining({ coreStyle: '父亲遗物编号与旧案卷宗一致' }),
    ])
  })
})
