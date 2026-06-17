import type { BrowserConfig } from "../shared/index.js";
import { browserEnvSchema } from "./schema.js";

const parsed = browserEnvSchema.parse({
  MODE: import.meta.env.MODE,
  VITE_APP_NAME: import.meta.env.VITE_APP_NAME,
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  VITE_AGUI_BASE_URL: import.meta.env.VITE_AGUI_BASE_URL,
});

export const browserConfig: BrowserConfig = {
  mode: parsed.MODE,
  appName: parsed.VITE_APP_NAME,
  apiBaseUrl: parsed.VITE_API_BASE_URL,
  aguiBaseUrl: parsed.VITE_AGUI_BASE_URL,
};
