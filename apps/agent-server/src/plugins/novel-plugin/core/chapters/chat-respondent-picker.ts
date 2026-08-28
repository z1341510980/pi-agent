/**
 * 自由聊天回复者选择（轻量选人）
 *
 * ⚠️ 存在动机（2026-08-28 控制平面重排 T2）：
 * 章节自由聊天在用户未 @ 指定 Agent 时需要选一个回复者。旧实现复用群聊的
 * `Moderator.decide()`，以 `phase:'free_chat'` 走完整的决策 prompt + JSON 解析 +
 * 双次重试 + 规则 fallback —— 为了"从 4-8 个成员里挑一个"付出整套群聊调度机制。
 *
 * 群聊侧已删除 Moderator，这里保留同一能力但只做它真正需要的事：
 * 一次小型工具调用提交 agentId，失败即按规则兜底。
 */

import { Type } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { DiscussionMember } from '../discussion/engine/discussion-types.js'

/** 单次调用超时：选人是小任务，不该等到思考型模型的长尾。 */
const RESPONDENT_PICK_TIMEOUT_MS = 30_000

export interface RespondentPickDraft {
  agentId?: string
  reason?: string
}

const PickRespondentParams = Type.Object({
  agentId: Type.String({
    minLength: 1,
    maxLength: 100,
    description: '最适合回复该用户消息的成员 ID，必须来自给出的成员列表',
  }),
  reason: Type.Optional(Type.String({ maxLength: 200, description: '一句话说明为何选这位成员' })),
})

export function createPickRespondentTool(
  draft: RespondentPickDraft,
  allowedIds: string[],
): ToolDefinition<typeof PickRespondentParams> {
  const allowed = new Set(allowedIds)
  return defineTool({
    name: 'novel_pick_chat_respondent',
    label: '选择回复成员',
    description: '从成员列表中选出一位最适合回答用户当前问题的成员。只能选列表内的成员 ID。',
    promptSnippet: '选择本轮回复用户的成员',
    parameters: PickRespondentParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const agentId = params.agentId.trim()
      if (!allowed.has(agentId)) {
        // 防御式校验：模型编造 ID 时返回纠正提示而不是静默接受，
        // 调用方随后走规则兜底。
        return {
          content: [{
            type: 'text',
            text: `选择无效：${agentId} 不在成员列表中。可选成员：${allowedIds.join('、')}。请重新选择。`,
          }],
          details: undefined,
        }
      }
      draft.agentId = agentId
      draft.reason = params.reason?.trim()
      return {
        content: [{ type: 'text', text: `已选择 ${agentId} 回复。` }],
        details: undefined,
      }
    },
  })
}

export interface RespondentPickerContext {
  createSession: (input: {
    systemPrompt: string
    userMessage: string
    tools: unknown[]
    timeoutMs: number
    modelId?: { provider: string; modelId: string }
    signal?: AbortSignal
  }) => Promise<{ prompt: () => Promise<string>; dispose?: () => void }>
  logger: { warn: (obj: unknown, msg: string) => void }
}

/**
 * 选出本轮回复用户的成员。
 *
 * 工具主路径失败（provider 不支持工具 / 调用报错 / 模型编造 ID）时按规则兜底：
 * 优先 Director（它的职责最接近"回答关于本章的问题"），否则第一个工种成员。
 * 兜底是确定性的，不再重试——为选人重试两次不值得。
 */
export async function pickChatRespondent(
  ctx: RespondentPickerContext,
  members: DiscussionMember[],
  userMessage: string,
  input: {
    modelId?: { provider: string; modelId: string }
    signal?: AbortSignal
    directorId: string
  },
): Promise<DiscussionMember | null> {
  if (members.length === 0) return null
  if (members.length === 1) return members[0]

  const fallback = members.find(member => member.id === input.directorId)
    ?? members.find(member => member.type === 'role')
    ?? members[0]

  const draft: RespondentPickDraft = {}
  const tool = createPickRespondentTool(draft, members.map(member => member.id))
  const memberList = members
    .map(member => `- ${member.id}（${member.name}）：${member.expertise}`)
    .join('\n')

  let handle: { prompt: () => Promise<string>; dispose?: () => void } | undefined
  try {
    handle = await ctx.createSession({
      systemPrompt: [
        '你负责为用户的章节相关提问挑选一位最合适的回答者。',
        '必须调用 novel_pick_chat_respondent 工具提交选择，不要在文本中输出 JSON 或解释。',
        '',
        '## 可选成员',
        memberList,
      ].join('\n'),
      userMessage: `用户消息：\n${userMessage}`,
      tools: [tool],
      timeoutMs: RESPONDENT_PICK_TIMEOUT_MS,
      modelId: input.modelId,
      signal: input.signal,
    })
    await handle.prompt()
  } catch (err) {
    if (input.signal?.aborted) throw err
    ctx.logger.warn({ err }, '自由聊天选人调用失败，按规则选择 Director')
    return fallback
  } finally {
    handle?.dispose?.()
  }

  // 只认闭包 payload：工具主路径的终答可能为空（已实证行为）。
  const picked = draft.agentId
    ? members.find(member => member.id === draft.agentId)
    : undefined
  return picked ?? fallback
}
