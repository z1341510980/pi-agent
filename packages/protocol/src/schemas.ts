import { z } from 'zod'

/** AG-UI RunAgentInput 校验 schema */
export const runAgentInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  runId: z.string().min(1, 'runId 不能为空'),
  // 宽松校验：AG-UI Message 结构复杂，下游会二次校验
  messages: z.array(z.unknown()),
  tools: z.array(z.unknown()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  forwardedProps: z.record(z.string(), z.unknown()).optional(),
  parentRunId: z.string().optional(),
})

/** 线程消息输入（steer / follow-up 共用） */
export const threadMessageInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  text: z.string().min(1, 'text 不能为空'),
  images: z
    .array(
      z.object({
        type: z.literal('image'),
        mimeType: z.string().min(1),
        data: z.string().min(1),
      }),
    )
    .optional(),
})

/** 分叉线程输入 */
export const forkThreadInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  entryId: z.string().min(1, 'entryId 不能为空'),
})

/** 导航线程输入 */
export const navigateThreadInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  targetId: z.string().min(1, 'targetId 不能为空'),
  summarize: z.boolean().optional(),
  customInstructions: z.string().optional(),
  replaceInstructions: z.boolean().optional(),
  label: z.string().optional(),
})

/** 压缩线程输入 */
export const compactThreadInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  customInstructions: z.string().optional(),
})

/** 设置活跃工具输入 */
export const toolsActiveInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  toolNames: z.array(z.string().min(1)),
})

/** 重载资源输入 */
export const reloadInputSchema = z.object({
  threadId: z.string().optional(),
})

/** 模型选择输入 */
export const modelSelectionInputSchema = z.object({
  provider: z.string().min(1, 'provider 不能为空'),
  modelId: z.string().min(1, 'modelId 不能为空'),
})

/** Thinking 设置输入 */
export const thinkingSettingsInputSchema = z.object({
  defaultThinkingLevel: z
    .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .optional(),
  thinkingBudgets: z
    .object({
      minimal: z.number().positive().optional(),
      low: z.number().positive().optional(),
      medium: z.number().positive().optional(),
      high: z.number().positive().optional(),
    })
    .optional(),
})

/** 自动压缩/自动重试开关输入 */
export const booleanToggleInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  enabled: z.boolean(),
})

/** 队列模式输入（steering / follow-up 模式） */
export const queueModeInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  mode: z.enum(['all', 'one-at-a-time']),
})

/** 会话命名输入 */
export const sessionNameInputSchema = z.object({
  threadId: z.string().min(1, 'threadId 不能为空'),
  name: z.string().min(1, 'name 不能为空'),
})

/** 导出类型 */
export type RunAgentInputSchema = z.infer<typeof runAgentInputSchema>
export type ThreadMessageInputSchema = z.infer<typeof threadMessageInputSchema>
export type ForkThreadInputSchema = z.infer<typeof forkThreadInputSchema>
export type NavigateThreadInputSchema = z.infer<typeof navigateThreadInputSchema>
export type CompactThreadInputSchema = z.infer<typeof compactThreadInputSchema>
export type ToolsActiveInputSchema = z.infer<typeof toolsActiveInputSchema>
export type ReloadInputSchema = z.infer<typeof reloadInputSchema>
export type ModelSelectionInputSchema = z.infer<typeof modelSelectionInputSchema>
export type ThinkingSettingsInputSchema = z.infer<typeof thinkingSettingsInputSchema>
export type BooleanToggleInputSchema = z.infer<typeof booleanToggleInputSchema>
export type QueueModeInputSchema = z.infer<typeof queueModeInputSchema>
export type SessionNameInputSchema = z.infer<typeof sessionNameInputSchema>
