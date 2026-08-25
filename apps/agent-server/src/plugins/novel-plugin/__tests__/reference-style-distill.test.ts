import { describe, expect, it, vi } from 'vitest'
import {
  buildChunkedSectionAwareStyleSample,
  buildSectionAwareStyleSample,
  distillStyleExpertFromReference
} from '../core/prompting/style-expert-distiller.js'

describe('reference style distillation', () => {
  it('asks the LLM for dimensioned craft cards with evidence', async () => {
    const response = JSON.stringify({
      name: '情绪蓄压',
      description: '通过日常细节、感官收窄和延迟解释积累情绪，再在动作中释放。',
      distilledPrompt: '迁移情绪蓄压机制，不复制样本内容。',
      exclusions: ['人物姓名', '原作情节'],
      techniques: [
        {
          id: 't1',
          dimension: 'emotion_craft',
          name: '感官收窄后释放',
          mechanism: '爆发前收窄感官，爆发时恢复动作与身体反馈。',
          transfer: '在高压场景中先减少解释，再用具体动作释放。',
          evidence: [{ sectionId: 's1', quote: '她没有抬头，只把手指收紧。' }],
          metricAnchors: ['dialogue.charRatio'],
          confidence: 'verified',
          kept: true
        },
        {
          id: 't2',
          dimension: 'scene_craft',
          name: '错误章节归因',
          mechanism: '把第一章引文错误标成第二章。',
          transfer: '不应保留。',
          evidence: [{ sectionId: 's2', quote: '她没有抬头，只把手指收紧。' }],
          metricAnchors: [],
          confidence: 'verified',
          kept: true
        }
      ],
      exemplarPassages: [
        { sectionId: 's1', text: '她没有抬头，只把手指收紧。', reason: '爆发前蓄势' }
      ]
    })
    const context = {
      createAgUiSession: vi
        .fn()
        .mockResolvedValue({
          session: { prompt: vi.fn().mockResolvedValue(response) },
          dispose: vi.fn()
        })
    } as any
    const draft = await distillStyleExpertFromReference(context, {
      sourceId: 'source-1',
      sections: [{ id: 's1', title: '第一章' } as any, { id: 's2', title: '第二章' } as any],
      text: `${'她没有抬头，只把手指收紧。'.repeat(20)}\n\n${'雨落在空院里。'.repeat(20)}`,
      sectionTexts: {
        s1: '她没有抬头，只把手指收紧。'.repeat(20),
        s2: '雨落在空院里。'.repeat(20)
      },
      metrics: { dialogue: { charRatio: 0.2 } } as any
    })
    expect(draft.techniques[0]?.dimension).toBe('emotion_craft')
    expect(draft.techniques[0]?.evidence[0]?.sectionId).toBe('s1')
    expect(draft.techniques[1]).toMatchObject({
      evidence: [],
      confidence: 'unverified',
      kept: false
    })
    expect(context.createAgUiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('感情引爆'),
        userMessage: expect.stringContaining('【sectionId=s1 title=第一章】\n她没有抬头')
      })
    )
  })

  it('keeps section ids on layered windows for long multi-section samples', () => {
    const sample = buildSectionAwareStyleSample(
      [{ id: 's1', title: '第一章' } as any, { id: 's2', title: '第二章' } as any],
      { s1: '甲'.repeat(5000), s2: '乙'.repeat(5000) },
      '',
      1200
    )

    expect(sample).toContain('sectionId=s1')
    expect(sample).toContain('sectionId=s2')
  })

  it('samples across locally chapter-bounded chunks for long references', () => {
    const sections = [1, 2, 3].map((index) => ({
      id: `s${index}`,
      sourceId: 'source-1',
      type: 'chapter' as const,
      order: index - 1,
      title: `第${index}章`,
      start: index * 100,
      end: (index + 1) * 100,
      characterCount: 200_000,
      estimatedTokens: 200_000,
      boundaryConfidence: 1,
      contentHash: '',
      included: true,
      warnings: [],
      version: 1
    }))
    const sample = buildChunkedSectionAwareStyleSample(
      sections,
      { s1: '甲'.repeat(500), s2: '乙'.repeat(500), s3: '丙'.repeat(500) },
      '',
      900
    )

    expect(sample).toContain('本地章节分包 1/3')
    expect(sample).toContain('本地章节分包 2/3')
    expect(sample).toContain('本地章节分包 3/3')
    expect(sample).toContain('sectionId=s1')
    expect(sample).toContain('sectionId=s2')
    expect(sample).toContain('sectionId=s3')
  })
})
