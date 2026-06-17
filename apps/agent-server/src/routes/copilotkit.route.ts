import type { FastifyPluginAsync } from 'fastify'

/**
 * CopilotKit 兼容层
 * 保留旧端点，返回 410 Gone，引导迁移到 AG-UI 端点
 */
export const copilotkitRoute: FastifyPluginAsync = async (app) => {
  app.all('/copilotkit/*', async (_request, reply) => {
    return reply.status(410).send({
      ok: false,
      error: {
        code: 'DEPRECATED',
        message: 'CopilotKit 端点已弃用，请迁移到 AG-UI 协议',
        migration: {
          info: '/ag-ui/info',
          run: '/ag-ui/agent/default/run',
        },
      },
    })
  })
}
