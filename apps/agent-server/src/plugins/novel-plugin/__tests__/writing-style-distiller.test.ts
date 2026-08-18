import { describe, expect, it, vi } from 'vitest'
import { distillStyleExpert } from '../core/prompting/style-expert-distiller.js'

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
})
