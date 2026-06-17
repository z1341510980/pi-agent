import { z } from "zod";

export const browserEnvSchema = z.object({
  MODE: z.enum(["development", "test", "production"]).default("development"),

  VITE_APP_NAME: z.string().default("PI Agent Desktop"),

  VITE_API_BASE_URL: z.string().url(),

  VITE_AGUI_BASE_URL: z.string().url(),
});
