import { describe, expect, it, vi } from 'vitest'
import { NovelPromptBuilder } from '../core/prompting/prompt-builder.js'

describe('PromptBuilder 单场创作指令', () => {
  it('把场景契约、有效预算和上一场尾部传给 scene-instruction 模板', () => {
    const render = vi.fn((name: string, variables: Record<string, string>) => (
      `${name}\n${JSON.stringify(variables)}`
    ))
    const builder = new NovelPromptBuilder(
      { render } as any,
      { getWritingStyleProfile: () => undefined } as any,
    )
    ;(builder as any).buildWriterSceneSamples = vi.fn(() => '')

    const prompt = builder.buildSceneInstruction(
      'project-1',
      7,
      {
        description: '推进主线',
        type: 'advance_mainline',
        targetEntity: null,
        priority: 'high',
      } as any,
      { positioning: 'high_pressure' } as any,
      {
        scene: {
          order: 2,
          title: '审讯室对峙',
          emphasis: 'core',
          targetWords: 900,
          goal: '逼出线索',
          entry: '主角带着证据入场',
          pressure: '对手拒绝承认',
          choice: '公开证据',
          consequence: '关系彻底破裂',
        },
        sceneIndex: 1,
        sceneCount: 3,
        targetWords: 840,
        previousSceneTail: '上一场末尾锚点',
      },
    )

    expect(render).toHaveBeenCalledWith('scene-instruction', expect.objectContaining({
      chapter_number: '7',
      scene_index: '2',
      scene_count: '3',
      scene_title: '审讯室对峙',
      scene_emphasis: '核心',
      scene_target_words: '840',
      scene_max_words: '1092',
      scene_goal: '逼出线索',
      scene_consequence: '关系彻底破裂',
      previous_scene_tail: '上一场末尾锚点',
    }), 'project-1')
    expect(prompt).toContain('scene-instruction')
  })
})
