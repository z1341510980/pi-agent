import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

/**
 * 速率限制插件
 * - 普通端点：每分钟 60 次
 * - health 端点：跳过限制
 */
export const rateLimitPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    keyGenerator: (request: FastifyRequest) => {
      return request.ip ?? "unknown";
    },
    allowList: (request: FastifyRequest) => {
      return request.url.startsWith("/api/health");
    },
  });
});
