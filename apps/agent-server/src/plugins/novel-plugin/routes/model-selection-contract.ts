import { z } from 'zod'

/** 小说各类按次模型选择共用的 HTTP 契约。 */
export const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
})

export type ModelSelectionInput = z.infer<typeof modelSelectionSchema>
