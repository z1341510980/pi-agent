import { z } from "zod";

export const nodeEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  HOST: z.string().default("127.0.0.1"),

  PORT: z.coerce.number().int().positive().default(3900),

  CORS_ORIGIN: z.string().default("*"),

  AGENT_MAX_LOOPS: z.coerce.number().int().positive().default(30),

  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(20),

  AGENT_MAX_CONTEXT_TOKENS: z.coerce.number().int().positive().default(120000),
});
