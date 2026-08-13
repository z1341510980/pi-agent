import type { BrowserConfig } from "../shared/index.js";
import { browserEnvSchema } from "./schema.js";

const parsed = browserEnvSchema.parse({
  MODE: import.meta.env.MODE,
  VITE_APP_NAME: import.meta.env.VITE_APP_NAME,
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  VITE_AGUI_BASE_URL: import.meta.env.VITE_AGUI_BASE_URL,
  VITE_REPOSITORY_URL: import.meta.env.VITE_REPOSITORY_URL,
});

export const browserConfig: BrowserConfig = {
  mode: parsed.MODE,
  appName: parsed.VITE_APP_NAME,
  apiBaseUrl: parsed.VITE_API_BASE_URL,
  aguiBaseUrl: parsed.VITE_AGUI_BASE_URL,
  repositoryUrl: parsed.VITE_REPOSITORY_URL,
};

/**
 * 从 Electron 主进程获取嵌入式服务器端口，更新 browserConfig。
 * 仅在 Electron 环境下生效（window.api 存在时）。
 *
 * 调用时机：App 初始化时（早于任何 API 请求）
 */
export async function initEmbeddedServerPort(): Promise<void> {
  const embeddedApi = typeof window === 'undefined'
    ? undefined
    : (window as Window & {
        api?: { server?: { getPort?: () => Promise<number | null> } }
      }).api

  if (embeddedApi?.server?.getPort) {
    try {
      const port = await embeddedApi.server.getPort()
      if (port && typeof port === 'number') {
        const base = `http://127.0.0.1:${port}`
        ;(browserConfig as { apiBaseUrl: string }).apiBaseUrl = base
        ;(browserConfig as { aguiBaseUrl: string }).aguiBaseUrl = base
      }
    } catch {
      // 非 Electron 环境或主进程未启动服务，保持 .env 默认值
    }
  }
}
