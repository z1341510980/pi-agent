import { describe, expect, it } from 'vitest'
import { parseChapterReviewReport } from '../plugins/novel-plugin/core/chapter-review-parser.js'

describe('parseChapterReviewReport', () => {
  it('解析十维评分、结论和 Findings', () => {
    const result = parseChapterReviewReport(`
## 十维评分
- 一致性：8/10
- 角色：7/10
- 任务完成：9/10
- 线索推进：6/10
- 伏笔状态：8/10
- 冲突变化：7/10
- 节奏：6/10
- 信息控制：9/10
- 读者钩子：8/10
- 文风：7/10
- 总体：7.5/10

## Findings 汇总
| 序号 | 严重度 | 分类 | 问题 | 位置 | 建议 |
| 1 | S2 | continuity | 角色提前知道真相 | 第12段 | 改为怀疑 |

## 结论：revise
`)

    expect(result).toMatchObject({
      consistencyScore: 8, characterScore: 7, taskCompletionScore: 9,
      clueProgressScore: 6, foreshadowStatusScore: 8, conflictChangeScore: 7,
      pacingScore: 6, infoControlScore: 9, readerHookScore: 8,
      styleScore: 7, overallScore: 7.5, verdict: 'revise',
    })
    expect(JSON.parse(result.issues ?? '[]')).toEqual(['[S2/continuity] 第12段：角色提前知道真相'])
    expect(JSON.parse(result.suggestions ?? '[]')).toEqual(['改为怀疑'])
  })
})
