/** Checkpoint feedback shared by the HTTP decision request and background run. */
const feedbackByCheckpoint = new Map<string, string[]>()

export function registerCheckpointFeedback(checkpointId: string, feedback: string[]): void {
  feedbackByCheckpoint.set(checkpointId, feedback)
}

export function appendCheckpointFeedback(checkpointId: string, messages: string[]): void {
  const feedback = feedbackByCheckpoint.get(checkpointId)
  if (feedback) feedback.push(...messages.map(message => message.trim()).filter(Boolean))
}

export function clearCheckpointFeedback(checkpointId: string): void {
  feedbackByCheckpoint.delete(checkpointId)
}

export function clearCheckpointFeedbackForRun(feedback: string[]): void {
  for (const [checkpointId, candidate] of feedbackByCheckpoint) {
    if (candidate === feedback) feedbackByCheckpoint.delete(checkpointId)
  }
}
