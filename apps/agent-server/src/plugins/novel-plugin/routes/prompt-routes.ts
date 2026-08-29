import type { RouteDefinition } from '../../../core/plugin/plugin-types.js'
import type { NovelServices } from '../novel-services.js'
import { z } from 'zod'
import { success } from '../../../lib/api-response.js'
import { validateBody } from '../../../lib/validate.js'
import { getPromptPartMeta } from '../core/prompting/prompt-part-catalog.js'

export function createPromptRoutes(services: NovelServices): RouteDefinition[] {
  const { promptManager, store } = services
  const savePromptSchema = z.object({ content: z.string().min(1), projectId: z.string().nullable(), description: z.string().optional() })

  /**
   * 调用统计：最近 500 条 agent log 按 agentType 聚合。
   * 面板把它映射到各部件的 agents 字段，回答"这段提示词最近被用了多少次"。
   * 统计失败不影响列表（纯观测数据）。
   */
  const usageByAgent = (projectId: string | undefined): Record<string, number> => {
    const counts: Record<string, number> = {}
    if (!projectId) return counts
    try {
      for (const log of store.listAgentLogs(projectId, undefined, 500)) {
        counts[log.agentType] = (counts[log.agentType] ?? 0) + 1
      }
    } catch {
      /* 观测数据，失败静默 */
    }
    return counts
  }

  return [
    { method: 'GET', path: '/prompts', handler: async (request: any) => {
      const projectId = request.query?.projectId ? String(request.query.projectId) : undefined
      const usage = usageByAgent(projectId)
      const items = promptManager.listTemplateNames().map((name) => {
        const meta = getPromptPartMeta(name)
        const source = promptManager.getTemplateSource(name, projectId)
        const effective = source.effectiveContent ?? ''
        return {
          name,
          source: source.source,
          hasRuntimeOverride: source.hasRuntimeOverride,
          category: meta.category,
          title: meta.title,
          usedBy: meta.usedBy,
          effect: meta.effect,
          charCount: effective.length,
          /** 关联 Agent 在最近 500 条日志窗口内的调用次数 */
          usage: Object.fromEntries(meta.agents.map((agent) => [agent, usage[agent] ?? 0])),
        }
      })
      // 分类排序：底座最前，其次按分类名字符排序，同分类内按模板名
      const categoryOrder = ['通用底座', '主流程工种', '群聊共创', '规划与编排', '分析与状态']
      items.sort((a, b) =>
        categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category)
        || a.name.localeCompare(b.name))
      return success(items, request.traceId)
    } },
    { method: 'GET', path: '/prompts/:name', handler: async (request: any) => {
      const projectId = request.query?.projectId ? String(request.query.projectId) : undefined
      const source = promptManager.getTemplateSource(request.params.name, projectId)
      const meta = getPromptPartMeta(request.params.name)
      if (!source.exists) {
        return success({ name: request.params.name, content: null, ...source, meta }, request.traceId)
      }
      const content = promptManager.getTemplate(request.params.name, projectId)
      return success({
        name: request.params.name,
        content,
        source: source.source,
        hasRuntimeOverride: source.hasRuntimeOverride,
        defaultContent: source.defaultContent,
        meta,
        charCount: content.length,
      }, request.traceId)
    } },
    { method: 'PUT', path: '/prompts/:name', handler: async (request: any, reply: any) => {
      const input = validateBody(savePromptSchema, request, reply); if (!input) return reply
      promptManager.saveTemplate(request.params.name, input.content, input.projectId, input.description)
      promptManager.clearCache()
      return success({ name: request.params.name, saved: true }, request.traceId)
    } },
    { method: 'DELETE', path: '/prompts/:name', handler: async (request: any) => {
      // 恢复默认：删除运行时覆盖（projectId 精确范围；不传则删全局覆盖）
      const projectId = request.query?.projectId ? String(request.query.projectId) : undefined
      const deleted = promptManager.deleteTemplateOverride(request.params.name, projectId)
      return success({ name: request.params.name, reset: deleted }, request.traceId)
    } },
  ]
}
