import { describe, it, expect } from 'vitest'
import {
  findUnmentionedEntities,
  mergeMemoryPayloads,
} from '../core/generation/novel-memory-generator.js'
import type { MemoryUpdatePayload } from '../core/generation/novel-memory-generator.js'

describe('findUnmentionedEntities（P1-4 确定性核对）', () => {
  it('正文出现但清单未提及的实体被识别为缺失', () => {
    const payload = {
      characterUpdates: [{ name: '张三', currentState: '负伤' }],
      summary: '张三负伤',
    } as unknown as MemoryUpdatePayload
    const content = '张三拔刀。李四退后一步。王五在远处观望着。'

    const missing = findUnmentionedEntities(payload, content, ['张三', '李四', '王五'])

    expect(missing).toEqual(['李四', '王五'])
  })

  it('清单以任何字段提及即视为已覆盖', () => {
    const payload = {
      conflictUpdates: [{ description: '李四与巡防营的冲突升级', stage: 'escalating' }],
      summary: '',
    } as unknown as MemoryUpdatePayload
    const content = '李四被拦在城门。'

    const missing = findUnmentionedEntities(payload, content, ['李四'])

    expect(missing).toEqual([])
  })

  it('正文未出现的实体不参与缺失判定；单字名跳过', () => {
    const payload = { summary: '' } as MemoryUpdatePayload
    const content = '只有张三在场。'

    const missing = findUnmentionedEntities(payload, content, ['李四', '赵'])

    expect(missing).toEqual([])
  })
})

describe('mergeMemoryPayloads（P1-4 补提取合并）', () => {
  it('逐轨道拼接补充变更，主提取 summary 保留', () => {
    const base = {
      characterUpdates: [{ name: '张三', currentState: '负伤' }],
      summary: '主提取摘要',
    } as unknown as MemoryUpdatePayload
    const supplement = {
      characterUpdates: [{ name: '李四', currentState: '戒心加深' }],
      relationshipUpdates: [{ characterA: '张三', characterB: '李四', currentStage: '恶化' }],
      summary: '补充提取摘要',
    } as unknown as MemoryUpdatePayload

    const merged = mergeMemoryPayloads(base, supplement)

    expect(merged.characterUpdates).toHaveLength(2)
    expect(merged.relationshipUpdates).toHaveLength(1)
    expect(merged.summary).toBe('主提取摘要')
    // 主对象不被原地修改
    expect(base.characterUpdates).toHaveLength(1)
  })

  it('空补充不改变主结果', () => {
    const base = {
      characterUpdates: [{ name: '张三' }],
      summary: 's',
    } as unknown as MemoryUpdatePayload

    const merged = mergeMemoryPayloads(base, { summary: '' })

    expect(merged.characterUpdates).toHaveLength(1)
    expect(merged.summary).toBe('s')
  })
})
