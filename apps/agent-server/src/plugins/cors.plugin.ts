import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";

/** CORS 白名单：仅允许本地来源 */
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3900",
  "http://127.0.0.1:3900",
];

export const corsPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(cors, {
    origin: (origin, callback) => {
      // 无 origin（如 curl）允许通过
      if (!origin) {
        callback(null, true);
        return;
      }
      if (ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS 不允许的来源"), false);
    },
    credentials: true,
  });
});
