import type { FastifyBaseLogger } from 'fastify'

/**
 * 创建模块级日志器
 * 为每个模块创建子日志器，便于追踪日志来源
 */
export function createModuleLogger(logger: FastifyBaseLogger, module: string): FastifyBaseLogger {
  return logger.child({ module })
}
