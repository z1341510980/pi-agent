import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import type { Gate } from '../tool/gate.js'
import type { EventBus } from '@repo/shared/events'
import { InstructionLoader } from './instruction-loader.js'

export interface PiSessionDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authStorage: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionManager: any
  getApiKey: (provider: string) => Promise<string | undefined>
  gate: Gate
  eventBus: EventBus
  config: {
    cwd: string
    dataDir: string
  }
}

/**
 * createPiSession：创建 Pi SDK Agent Session
 */
export async function createPiSession(deps: PiSessionDeps) {
  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.config.cwd,
    agentDir: deps.config.dataDir,
    systemPromptOverride: () => buildSystemPrompt(deps),
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    sessionManager: deps.sessionManager,
    resourceLoader,
    getApiKey: deps.getApiKey,
    toolExecution: 'parallel',
    beforeToolCall: async ({
      toolCall,
      args,
    }: {
      toolCall: { name: string }
      args: Record<string, unknown>
    }) => {
      const result = await deps.gate.check(toolCall.name, args)
      if (!result.allowed) {
        throw new Error(result.reason ?? '工具被安全策略禁止')
      }
    },
    afterToolCall: async ({
      toolCall,
      result,
      isError,
    }: {
      toolCall: { name: string }
      result: unknown
      isError: boolean
    }) => {
      deps.eventBus.emit('tool:executed', { toolCall, result, isError })
    },
  })

  return session
}

function buildSystemPrompt(deps: PiSessionDeps): string {
  const parts: string[] = []

  parts.push('你是 Pi Agent，一个智能编程助手。')

  const loader = new InstructionLoader(deps.config.cwd)
  const instructions = loader.loadInstructions()
  if (instructions) {
    parts.push('\n## 项目指令\n')
    parts.push(instructions)
  }

  return parts.join('\n')
}
