import { describe, expect, it } from 'vitest'
import {
  runAgentInputSchema,
  threadMessageInputSchema,
  forkThreadInputSchema,
  navigateThreadInputSchema,
  compactThreadInputSchema,
  toolsActiveInputSchema,
} from '../schemas.js'

describe('runAgentInputSchema', () => {
  it('拒绝空 body', () => {
    const result = runAgentInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受最小合法输入', () => {
    const result = runAgentInputSchema.safeParse({
      threadId: 'thread-1',
      runId: 'run-1',
      messages: [],
    })
    expect(result.success).toBe(true)
  })

  it('要求 threadId 为非空字符串', () => {
    const result = runAgentInputSchema.safeParse({
      threadId: '',
      runId: 'run-1',
      messages: [],
    })
    expect(result.success).toBe(false)
  })

  it('要求 runId 为非空字符串', () => {
    const result = runAgentInputSchema.safeParse({
      threadId: 'thread-1',
      runId: '',
      messages: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('threadMessageInputSchema', () => {
  it('要求 threadId 和 text', () => {
    const result = threadMessageInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受合法输入', () => {
    const result = threadMessageInputSchema.safeParse({
      threadId: 'thread-1',
      text: '你好',
    })
    expect(result.success).toBe(true)
  })

  it('接受带 images 的输入', () => {
    const result = threadMessageInputSchema.safeParse({
      threadId: 'thread-1',
      text: '看图',
      images: [{ type: 'image', mimeType: 'image/png', data: 'base64...' }],
    })
    expect(result.success).toBe(true)
  })
})

describe('forkThreadInputSchema', () => {
  it('要求 threadId 和 entryId', () => {
    const result = forkThreadInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受合法输入', () => {
    const result = forkThreadInputSchema.safeParse({
      threadId: 'thread-1',
      entryId: 'entry-1',
    })
    expect(result.success).toBe(true)
  })
})

describe('navigateThreadInputSchema', () => {
  it('要求 threadId 和 targetId', () => {
    const result = navigateThreadInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受带可选字段的输入', () => {
    const result = navigateThreadInputSchema.safeParse({
      threadId: 'thread-1',
      targetId: 'target-1',
      summarize: true,
      customInstructions: '总结重点',
    })
    expect(result.success).toBe(true)
  })
})

describe('compactThreadInputSchema', () => {
  it('要求 threadId', () => {
    const result = compactThreadInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受带可选 customInstructions 的输入', () => {
    const result = compactThreadInputSchema.safeParse({
      threadId: 'thread-1',
      customInstructions: '保留代码片段',
    })
    expect(result.success).toBe(true)
  })
})

describe('toolsActiveInputSchema', () => {
  it('要求 threadId 和 toolNames 数组', () => {
    const result = toolsActiveInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('接受合法输入', () => {
    const result = toolsActiveInputSchema.safeParse({
      threadId: 'thread-1',
      toolNames: ['read', 'bash'],
    })
    expect(result.success).toBe(true)
  })

  it('接受空 toolNames（禁用所有工具）', () => {
    const result = toolsActiveInputSchema.safeParse({
      threadId: 'thread-1',
      toolNames: [],
    })
    expect(result.success).toBe(true)
  })
})
