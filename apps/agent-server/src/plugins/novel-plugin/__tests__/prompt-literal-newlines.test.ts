import { describe, expect, it } from 'vitest'
import { normalizeLiteralNewlines } from '../core/prompting/prompt-builder.js'

describe('normalizeLiteralNewlines（narrativeTask 字面 \\n 归一）', () => {
  it('把字面反斜杠 n 归一为真实换行（工具提交的 JSON 转义残留）', () => {
    const polluted = '承接上文。\\n\\n【场景一：石屋】记录体感。\\n\\n【场景二：指挥大厅】复核数据。'
    const normalized = normalizeLiteralNewlines(polluted)
    expect(normalized).not.toContain('\\n')
    expect(normalized).toBe('承接上文。\n\n【场景一：石屋】记录体感。\n\n【场景二：指挥大厅】复核数据。')
  })

  it('正常文本原样返回', () => {
    const clean = '承接上文。\n\n【场景一】记录。'
    expect(normalizeLiteralNewlines(clean)).toBe(clean)
  })

  it('归一后压缩多余空行', () => {
    expect(normalizeLiteralNewlines('甲。\\n\\n\\n\\n乙。')).toBe('甲。\n\n乙。')
  })
})
