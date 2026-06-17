import { browserConfig } from '@repo/config/browser'
import type { AgentMessage } from '@repo/shared/agent'
import type { AguiAnyEvent } from '@repo/shared/agui'

export type RunAgentOptions = {
  threadId?: string
  sessionId?: string
  messages: AgentMessage[]
  onEvent: (event: AguiAnyEvent) => void
  onError?: (error: Error) => void
  onDone?: () => void
}

export async function runAgent(options: RunAgentOptions) {
  try {
    const response = await fetch(`${browserConfig.aguiBaseUrl}/agui/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        threadId: options.threadId,
        sessionId: options.sessionId,
        messages: options.messages
      })
    })

    if (!response.ok) {
      throw new Error(`AG-UI request failed: HTTP ${response.status}`)
    }

    if (!response.body) {
      throw new Error('AG-UI response body is empty')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')

    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()

      if (done) break

      buffer += decoder.decode(value, {
        stream: true
      })

      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        const line = chunk.split('\n').find((item) => item.startsWith('data: '))

        if (!line) continue

        const json = line.replace(/^data:\s*/, '')
        const event = JSON.parse(json) as AguiAnyEvent

        options.onEvent(event)
      }
    }

    options.onDone?.()
  } catch (error) {
    options.onError?.(error instanceof Error ? error : new Error(String(error)))
  }
}
