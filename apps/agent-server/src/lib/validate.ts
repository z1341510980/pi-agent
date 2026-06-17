import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodSchema } from "zod";
import { ErrorCode } from "@repo/shared/errors";
import { failure } from "./api-response.js";

export function validateBody<T>(
  schema: ZodSchema<T>,
  request: FastifyRequest,
  reply: FastifyReply,
): T | undefined {
  const result = schema.safeParse(request.body);

  if (!result.success) {
    reply
      .status(400)
      .send(
        failure(
          ErrorCode.VALIDATION_ERROR,
          "请求参数校验失败",
          request.traceId,
          result.error.flatten(),
        ),
      );

    return undefined;
  }

  return result.data;
}
