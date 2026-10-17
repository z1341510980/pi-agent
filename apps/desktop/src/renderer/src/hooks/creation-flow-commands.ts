import {
  persistChapterChat,
  sendFlowMessage,
  submitCheckpointDecision,
} from '@/api/novel-client'

/** Transport-independent command surface for the creation-flow hook. */
export const creationFlowCommands = {
  submitCheckpoint: submitCheckpointDecision,
  persistChat: persistChapterChat,
  sendInterject: sendFlowMessage,
} as const
