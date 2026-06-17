import type { AgentMessage } from "./message.js";

export type AgentRunInput = {
  threadId?: string;
  sessionId?: string;
  messages: AgentMessage[];
  state?: Record<string, unknown>;
};
