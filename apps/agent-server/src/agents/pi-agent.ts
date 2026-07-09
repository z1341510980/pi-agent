import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, Message } from "@ag-ui/client";

function messageContentToText(message: Message | undefined): string {
  if (!message || !("content" in message)) return "";

  const content = message.content;

  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

export function createWenlangAgent() {
  return new BuiltInAgent({
    type: "custom",
    factory: async function* ({ input, abortSignal }): AsyncIterable<BaseEvent> {
      if (abortSignal.aborted) return;

      const messageId = crypto.randomUUID();
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const userText = messageContentToText(lastUserMessage);
      const response = userText
        ? `收到：${userText}`
        : "收到。请继续输入你的问题。";

      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      };

      if (abortSignal.aborted) return;

      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: response,
      };

      if (abortSignal.aborted) return;

      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      };
    },
  });
}
