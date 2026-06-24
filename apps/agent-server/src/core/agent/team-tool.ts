/**
 * team_execute 工具定义
 *
 * 参考 MULTI_AGENT_DESIGN.md §3.4，使用 defineTool + TypeBox 格式。
 * LLM 可通过此工具组建团队执行复杂任务。
 */

import { Type, type Static } from 'typebox'
import { defineTool, type ToolDefinition, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { TeamManager } from './team-manager.js'

/** team_execute 工具参数 */
const TeamExecuteParams = Type.Object({
  teamId: Type.String({ description: 'Team ID（从可用团队列表中选择）' }),
  task: Type.String({ minLength: 1, description: '团队要执行的总任务描述' }),
  members: Type.Optional(
    Type.Array(
      Type.Object({
        agentId: Type.String({ description: '成员 Agent ID' }),
        role: Type.Optional(Type.String({ description: '成员角色的简短描述' })),
        subtask: Type.String({ description: '分配给该成员的具体子任务' }),
      }),
    ),
  ),
  strategy: Type.Optional(
    Type.Union([
      Type.Literal('sequential'),
      Type.Literal('parallel'),
      Type.Literal('pipeline'),
    ]),
  ),
  timeout: Type.Optional(
    Type.Number({
      default: 300000,
      description: '整个团队任务的总超时毫秒数（默认 300s）',
    }),
  ),
})

type TeamExecuteInput = Static<typeof TeamExecuteParams>

/** 创建 team_execute 工具（Pi SDK ToolDefinition 格式） */
export function createTeamExecuteTool(
  teamManager: TeamManager,
): ToolDefinition<typeof TeamExecuteParams> {
  return defineTool({
    name: 'team_execute',
    label: '团队执行',
    description:
      '组建团队执行复杂任务。Team Lead 负责分解任务、分配子任务给成员、收集结果并汇总。' +
      '适用于需要多角色协作的复杂任务。支持三种执行策略：' +
      'sequential（串行）、parallel（并行）、pipeline（管道，前一个输出作为后一个输入）。',
    promptSnippet: '组建团队执行复杂任务',
    parameters: TeamExecuteParams,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<undefined>> {
      // 通知前端：团队任务开始执行
      onUpdate?.({
        content: [{ type: 'text', text: `正在组建团队 ${params.teamId} 执行任务...` }],
        details: undefined,
      })

      const result = await teamManager.execute(params.teamId, params.task, {
        members: params.members,
        strategy: params.strategy,
        timeoutMs: params.timeout,
        signal,
        onProgress: (progress) => {
          onUpdate?.({
            content: [{ type: 'text', text: progress.text }],
            details: undefined,
          })
        },
      })

      if (!result.success) {
        const failedMembers = Object.values(result.memberResults)
          .filter((r) => !r.success)
          .map((r) => r.agentId)
        return {
          content: [
            {
              type: 'text',
              text: `团队执行完成，但部分成员失败: ${failedMembers.join(', ')}\n\n${result.summary}`,
            },
          ],
          details: undefined,
        }
      }

      return {
        content: [{ type: 'text', text: result.summary }],
        details: undefined,
      }
    },
  })
}
