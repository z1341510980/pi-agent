import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

export const requestContextPlugin: FastifyPluginAsync = fp(async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    const fromHeader = request.headers["x-trace-id"];
    const traceId =
      typeof fromHeader === "string" && fromHeader.length > 0
        ? fromHeader
        : crypto.randomUUID();

    request.traceId = traceId;
    reply.header("x-trace-id", traceId);
  });
});
