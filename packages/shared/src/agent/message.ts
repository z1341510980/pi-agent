export type AgentRole = "system" | "user" | "assistant" | "tool";

export type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: number;
};
