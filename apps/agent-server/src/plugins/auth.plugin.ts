import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { AppError, ErrorCode } from "@repo/shared/errors";

/** 不需要认证的路径前缀 */
const PUBLIC_PATHS = ["/api/health"];

/**
 * Bearer Token 认证插件
 * Token 由 Electron Main 进程启动时生成，通过环境变量 PI_AGENT_AUTH_TOKEN 传入
 */
export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  const expectedToken = process.env.PI_AGENT_AUTH_TOKEN;

  // 生产环境必须设置 Token
  if (!expectedToken) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("生产环境必须设置 PI_AGENT_AUTH_TOKEN");
    }
    app.log.warn("PI_AGENT_AUTH_TOKEN 未设置，认证已禁用（仅限开发模式）");
    return;
  }

  app.decorate("authToken", expectedToken);

  app.addHook("onRequest", async (request) => {
    // 公开路径跳过认证
    if (PUBLIC_PATHS.some((path) => request.url.startsWith(path))) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "缺少认证 Token", 401);
    }

    const token = authHeader.slice("Bearer ".length);

    // 常量时间比较，防止时序攻击
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);
    if (
      tokenBuf.length !== expectedBuf.length ||
      !timingSafeEqual(tokenBuf, expectedBuf)
    ) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "认证 Token 无效", 401);
    }
  });
});
