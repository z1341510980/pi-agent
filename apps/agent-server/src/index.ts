import { createApp } from "./app.js";
import { nodeConfig } from "@repo/config/node";

const app = await createApp();

try {
  await app.listen({
    host: nodeConfig.server.host,
    port: nodeConfig.server.port,
  });

  app.log.info(
    `Agent Server running at http://${nodeConfig.server.host}:${nodeConfig.server.port}`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
