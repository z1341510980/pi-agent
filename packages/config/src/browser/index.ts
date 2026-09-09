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
 * 调用时机：App 初始化时（早于任何 API 请求）。
 * 服务可能比窗口晚就绪（崩溃自动重启后端口也会变）：这里轮询重试，
 * 最长等 20 秒；超时保持默认值，由页面上的离线重试按钮接手。
 */
export async function initEmbeddedServerPort(): Promise<void> {
  const embeddedApi = typeof window === 'undefined'
    ? undefined
    : (window as Window & {
        api?: { server?: { getPort?: () => Promise<number | null> } }
      }).api

  const getPort = embeddedApi?.server?.getPort
  if (!getPort) return

  const maxAttempts = 40 // 40 × 500ms = 20s
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const port = await getPort()
      if (port && typeof port === 'number') {
        const base = `http://127.0.0.1:${port}`
        ;(browserConfig as { apiBaseUrl: string }).apiBaseUrl = base
        ;(browserConfig as { aguiBaseUrl: string }).aguiBaseUrl = base
        return
      }
    } catch {
      /* 主进程暂时不可用，继续重试 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
