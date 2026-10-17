import { describe, expect, it } from 'vitest'
import { ContextSectionCollector } from '../core/prompting/context-section-metrics.js'

describe('prompt hot path acceptance thresholds', () => {
  it('keeps section collection bounded for a representative chapter prompt', () => {
    const collector = new ContextSectionCollector({ projectId: 'p1', chapterNumber: 1, agentType: 'writer' })
    const sections: Array<['system' | 'shared' | 'identity' | 'suffix' | 'dynamic' | 'tool_schema', string, string]> = [
      ['system', 'base', '系统规则'.repeat(400)],
      ['shared', 'chapter-info', '章节信息'.repeat(800)],
      ['shared', 'story-ledger', '故事账本'.repeat(1000)],
      ['shared', 'arranged-entities', '实体档案'.repeat(500)],
      ['identity', 'writer', '写作者身份'.repeat(300)],
      ['suffix', 'instruction', '场景任务'.repeat(300)],
      ['dynamic', 'task-input', '当前任务'.repeat(200)],
      ['tool_schema', 'tools', '{"name":"novel_submit_prose"}'.repeat(40)],
    ]
    const started = performance.now()
    for (const [type, id, content] of sections) collector.add(type, id, content)
    const elapsed = performance.now() - started
    const rows = collector.buildInputs('log-1')

    expect(rows).toHaveLength(sections.length)
    expect(rows.reduce((sum, row) => sum + row.chars, 0)).toBeLessThan(30_000)
    expect(elapsed).toBeLessThan(50)
  })
})
