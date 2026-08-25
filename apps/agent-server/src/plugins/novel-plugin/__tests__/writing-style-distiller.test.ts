import { describe, expect, it, vi } from 'vitest'
import { distillStyleExpert, distillStyleExpertFromReference } from '../core/prompting/style-expert-distiller.js'

describe('distillStyleExpert', () => {
  it('returns a reviewed-ready independent style expert draft', async () => {
    const prompt = JSON.stringify({
      name: '冷峻留白',
      description: '用动作和环境承载情绪，减少直接解释。',
      prompt: '迁移动作承载情绪和信息留白，不复制原作内容。',
    })
    const context = {
      createAgUiSession: vi.fn().mockResolvedValue({
        session: { prompt: vi.fn().mockResolvedValue(prompt) },
        dispose: vi.fn(),
      }),
    } as any

    const result = await distillStyleExpert(context, {
      sourceTitle: '测试小说',
      sourceAuthor: '测试作者',
      sample: '雨落在旧城的瓦片上。她没有抬头，只把手里的钥匙收紧。门后的声音停了片刻，像有人在黑暗里重新计算距离。'.repeat(2),
    })

    expect(result).toMatchObject({
      name: '冷峻留白',
      sourceTitle: '测试小说',
      sourceAuthor: '测试作者',
      enabled: true,
    })
    expect(context.createAgUiSession).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('只提炼写作机制'),
    }))
  })

  it('rejects samples that are too short', async () => {
    await expect(distillStyleExpert({} as any, {
      sourceTitle: '测试小说',
      sample: '太短',
    })).rejects.toThrow('至少需要 80')
  })

  it('tool-submit 路径：模型调用 submit_style_distill，结构化参数经闭包捕获并自动补 id', async () => {
    const payload = {
      name: '冷峻留白·工具版',
      description: '用动作和环境承载情绪。',
      distilledPrompt: '迁移动作承载情绪和信息留白，不复制原作内容。',
      exclusions: ['原作人物姓名'],
      antiPatterns: ['旁白解释动机'],
      boundaries: ['不适合群战场'],
      expressionDna: { sentence: '落点句短', rhythm: '先铺陈后收拢' },
      tensions: [{ name: '克制与引爆', between: ['低温白描', '彻底失态'], resolution: '一章一个引爆点' }],
      techniques: [
        {
          dimension: 'emotion_craft',
          name: '器物承情',
          mechanism: '情感落在物件上',
          transfer: '找相关物件写现状',
          failureMode: '物件无前文铺垫时无效',
          evidence: [{ sectionId: 's1', quote: '她没有抬头' }],
          validation: { crossDomain: 2, generative: true, exclusive: true },
          confidence: 'verified',
          kept: true,
        },
      ],
      exemplarPassages: [{ sectionId: 's1', text: '她没有抬头，只把手里的钥匙收紧。', reason: '蓄势' }],
    }
    let capturedTool: { execute: (id: string, args: unknown) => Promise<unknown> } | undefined
    const context = {
      createAgUiSession: vi.fn().mockImplementation(async (options: any) => {
        capturedTool = options.tools?.[0]
        return {
          session: {
            // 模拟模型：不吐文本 JSON，直接发起工具调用
            prompt: vi.fn(async () => {
              await capturedTool!.execute('fake-tool-call', structuredClone(payload))
              return '已通过结构化提交工具入库。'
            }),
          },
          dispose: vi.fn(),
        }
      }),
    } as any

    const result = await distillStyleExpertFromReference(
      context as never,
      {
        sourceId: 'src-test',
        sections: [
          {
            id: 's1', sourceId: 'src-test', type: 'chapter' as const, order: 0,
            title: '测试章节', start: 0, end: 300, characterCount: 300,
            estimatedTokens: 0, boundaryConfidence: 1, contentHash: '', included: true, version: 1, warnings: []
          }
        ],
        text: '雨落在旧城的瓦片上。她没有抬头，只把手里的钥匙收紧。门后的声音停了片刻。'.repeat(3),
        sectionTexts: {
          s1: '雨落在旧城的瓦片上。她没有抬头，只把手里的钥匙收紧。门后的声音停了片刻。'.repeat(3)
        },
        metrics: { characterCount: 300 } as never,
      }
    )

    expect(result.name).toBe('冷峻留白·工具版')
    // 自动补齐的 id 与三重验证门槛下的 verified 保持
    expect(result.techniques?.[0]).toMatchObject({
      id: 't1',
      confidence: 'verified',
      kept: true,
      failureMode: '物件无前文铺垫时无效',
    })
    expect(result.expressionDna?.sentence).toBe('落点句短')
    expect(result.tensions?.[0].between).toEqual(['低温白描', '彻底失态'])
    expect(result.exemplarPassages?.[0].text).toContain('她没有抬头')
  })
})
