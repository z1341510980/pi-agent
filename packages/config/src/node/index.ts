import "dotenv/config";

import type { NodeConfig } from "../shared/index.js";
import { nodeEnvSchema } from "./schema.js";

const parsed = nodeEnvSchema.parse(process.env);

export const nodeConfig: NodeConfig = {
  mode: parsed.NODE_ENV,

  server: {
    host: parsed.HOST,
    port: parsed.PORT,
    corsOrigin: parsed.CORS_ORIGIN,
  },

  agent: {
    maxAgentLoops: parsed.AGENT_MAX_LOOPS,
    maxToolCalls: parsed.AGENT_MAX_TOOL_CALLS,
    maxContextTokens: parsed.AGENT_MAX_CONTEXT_TOKENS,
  },
};
