import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { AppError, ErrorCode } from "@repo/shared/errors";
import { failure } from "../lib/api-response.js";

/** 带有 Fastify 扩展属性的 Error 类型 */
type FastifyError = Error & {
  validation?: unknown;
  statusCode?: number;
};

export const errorHandlerPlugin: FastifyPluginAsync = fp(async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const traceId = request.traceId ?? crypto.randomUUID();
    const fastifyError = error as FastifyError;

    // AppError：使用自带的状态码和脱敏消息
    if (error instanceof AppError) {
      request.log.error({
        traceId,
        code: error.code,
        internalMessage: error.internalMessage,
      });
      return reply.status(error.statusCode).send(
        failure(error.code, error.userMessage, traceId),
      );
    }

    // Fastify 验证错误
    if (fastifyError.validation) {
      return reply.status(400).send(
        failure(ErrorCode.VALIDATION_ERROR, "请求参数校验失败", traceId, {
          validation: fastifyError.validation,
        }),
      );
    }

    // 速率限制错误
    if (fastifyError.statusCode === 429) {
      return reply.status(429).send(
        failure(ErrorCode.BAD_REQUEST, "请求过于频繁，请稍后重试", traceId),
      );
    }

    // 未知错误：脱敏后返回 500
    request.log.error({ traceId, error });
    return reply.status(500).send(
      failure(ErrorCode.INTERNAL_SERVER_ERROR, "服务器内部错误", traceId),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    const traceId = request.traceId ?? crypto.randomUUID();
    return reply
      .status(404)
      .send(
        failure(
          ErrorCode.NOT_FOUND,
          `接口不存在：${request.method} ${request.url}`,
          traceId,
        ),
      );
  });
});
