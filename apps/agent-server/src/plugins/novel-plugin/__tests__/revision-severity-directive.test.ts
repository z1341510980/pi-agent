import { describe, it, expect } from 'vitest'
import { buildRevisionSeverityDirective } from '../core/novel-orchestrator.js'

describe('buildRevisionSeverityDirective（P1-3 修订按严重度路由）', () => {
  it('存在 S2 时注入整段重写策略', () => {
    const directive = buildRevisionSeverityDirective(['S2', 'S3'])

    expect(directive).toContain('修订策略（检测到 S2 级结构问题）')
    expect(directive).toContain('重写其所在的完整段落组')
    expect(directive).toContain('因果链')
    expect(directive).toContain('最小改动原则')
  })

  it('仅有 S3/S4 时不注入指令（维持默认补丁行为）', () => {
    expect(buildRevisionSeverityDirective(['S3'])).toBe('')
    expect(buildRevisionSeverityDirective(['S4', 'S3'])).toBe('')
  })

  it('空问题列表返回空串', () => {
    expect(buildRevisionSeverityDirective([])).toBe('')
  })
})
