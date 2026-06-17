import { z } from "zod";

export const agentRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const agentMessageSchema = z.object({
  id: z.string().min(1),
  role: agentRoleSchema,
  content: z.string(),
  createdAt: z.number().int().positive(),
});

export const agentRunInputSchema = z.object({
  threadId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),

  messages: z.array(agentMessageSchema).min(1, "messages 至少需要一条消息"),

  state: z.record(z.string(), z.unknown()).optional(),
});

export type AgentRunInputSchema = z.infer<typeof agentRunInputSchema>;
