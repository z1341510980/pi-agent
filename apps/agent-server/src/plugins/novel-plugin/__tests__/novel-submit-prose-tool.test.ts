/**
 * novel_submit_prose：Writer 正文的提交工具（2026-10 正文通道隔离）。
 *
 * 背景：上游网关把 Gemini 的 thought 摘要拍平进 `delta.content`，思考与草稿
 * 逐句交替且无字段可辨。工具参数走 `tool_calls` 通道，与 content 物理隔离。
 *
 * 这组用例钉住的是"工具通道本身也要防御"：
 *   - 干净正文原样收下；
 *   - 模型把思考/说明/围栏塞进参数时，与文本通道同一套规范化处理（裁掉或拒收）；
 *   - 拒收必须返回可执行的纠正提示，且**不写 draft**（否则脏正文会顶掉好稿）；
 *   - 多次提交以最后一次通过校验的为准（模型自纠的正常路径）。
 */
import { describe, expect, it } from 'vitest'
import { createNovelSubmitProseTool, type ProseDraftHolder } from '../core/tools/submit.js'

function createDraft(): ProseDraftHolder {
  return { submissions: 0 }
}

/** 底层 execute 带 signal/onUpdate/ctx 等可选参数，测试只关心前两个。 */
type ExecutableTool = {
  name: string
  description: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

async function submit(draft: ProseDraftHolder, content: string): Promise<string> {
  const tool = createNovelSubmitProseTool(draft) as unknown as ExecutableTool
  const result = await tool.execute('call-1', { content }) as {
    content: Array<{ type: string; text: string }>
  }
  return result.content.map((block) => block.text).join('\n')
}

const CLEAN_PROSE = [
  '叶明远是被疼醒的。',
  '',
  '左臂被硬木夹板死死箍住，稍微一动，断骨的茬子就往肉里钻。',
  '',
  '“明远哥！你可算醒了！”小六子端着药碗跌撞进来。',
].join('\n')

describe('novel_submit_prose 工具通道', () => {
  it('干净正文原样收下，并回执字数', async () => {
    const draft = createDraft()
    const message = await submit(draft, CLEAN_PROSE)

    expect(draft.content).toBe(CLEAN_PROSE)
    expect(draft.submissions).toBe(1)
    expect(draft.lastRejection).toBeUndefined()
    expect(message).toContain('正文已提交')
    expect(message).toContain(String(CLEAN_PROSE.replace(/\s/g, '').length))
  })

  it('参数里夹带思考时按文本通道同口径裁掉，并如实告知', async () => {
    const draft = createDraft()
    // 复刻实测形态：英文推理在前，中文正文在后
    const contaminated = [
      'The scene needs to open with physical sensation, then reveal the stakes.',
      '',
      'Confirming the word budget is achievable without dropping any beat.',
      '',
      CLEAN_PROSE,
    ].join('\n')

    const message = await submit(draft, contaminated)

    expect(draft.content).toBe(CLEAN_PROSE)
    expect(draft.content).not.toContain('word budget')
    expect(message).toContain('已被系统裁掉')
  })

  it('Markdown 围栏被剥掉（实测章节表里出现过 ```markdown）', async () => {
    const draft = createDraft()
    await submit(draft, '```markdown\n' + CLEAN_PROSE + '\n```')

    expect(draft.content).toBe(CLEAN_PROSE)
  })

  it('纯分析/非中文内容被拒收：不写 draft，返回可执行的纠正提示', async () => {
    const draft = createDraft()
    const message = await submit(
      draft,
      'The task is to write the scene. I will first check the outline, then draft it carefully.',
    )

    expect(draft.content).toBeUndefined()
    expect(draft.submissions).toBe(1)
    expect(draft.lastRejection).toBeTruthy()
    expect(message).toContain('正文未提交')
    expect(message).toContain('重新调用本工具')
  })

  it('拒收不会顶掉此前已通过校验的提交', async () => {
    const draft = createDraft()
    await submit(draft, CLEAN_PROSE)
    await submit(draft, 'Analysis: the previous draft looks fine, I will keep it as is.')

    expect(draft.content).toBe(CLEAN_PROSE)
    expect(draft.submissions).toBe(2)
  })

  it('多次提交以最后一次通过校验的为准', async () => {
    const draft = createDraft()
    await submit(draft, CLEAN_PROSE)
    const revised = '叶明远是被硬生生疼醒的。\n\n左臂被两块厚沉的松木夹板死死箍住。'
    await submit(draft, revised)

    expect(draft.content).toBe(revised)
    expect(draft.submissions).toBe(2)
    expect(draft.lastRejection).toBeUndefined()
  })

  it('工具名与描述明确指向"不要在对话文本里输出正文"', () => {
    const tool = createNovelSubmitProseTool(createDraft())
    expect(tool.name).toBe('novel_submit_prose')
    expect(tool.description).toContain('对话文本中输出正文')
  })

  it('execute 抛错不会污染 draft（例如 provider 直连时参数缺失）', async () => {
    const draft = createDraft()
    const tool = createNovelSubmitProseTool(draft) as unknown as ExecutableTool
    try {
      await tool.execute('call-x', {})
    } catch {
      // schema 校验失败在这里是允许的：调用方（orchestrator）以 draft 是否被写入为准
    }
    // 无论是抛错还是按空串处理，draft 都必须保持"未提交"
    expect(draft.content).toBeUndefined()
  })
})
