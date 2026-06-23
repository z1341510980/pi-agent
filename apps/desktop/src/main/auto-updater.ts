import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { is } from '@electron-toolkit/utils'

/**
 * 自动更新模块
 *
 * 设计参考：docs/ARCHITECTURE.md §18
 *
 * 功能：
 * - 启动时检查更新（可配置）
 * - 提供手动检查更新 API（通过 IPC）
 * - 下载进度通知
 * - 安装更新（退出并安装）
 *
 * IPC 接口：
 * - `update:check` → 返回更新检查结果
 * - `update:download` → 触发下载
 * - `update:install` → 退出并安装
 * - `update:subscribe` → 订阅更新状态变化（renderer → main 注册）
 *
 * 在开发环境下 electron-updater 无法实际工作（缺少 app-update.yml），
 * 因此会做降级处理：返回「无更新」并打日志。
 */

/** 更新状态（推送给 renderer） */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; info: SerializedUpdateInfo }
  | { state: 'not-available' }
  | { state: 'downloading'; progress: SerializedProgressInfo | null }
  | { state: 'downloaded'; info: SerializedUpdateInfo }
  | { state: 'error'; message: string }

/** 序列化后的更新信息（可安全通过 IPC 传输） */
export interface SerializedUpdateInfo {
  version: string
  releaseDate: string | null
  releaseNotes: string | null
}

/** 序列化后的下载进度信息 */
export interface SerializedProgressInfo {
  total: number
  delta: number
  transferred: number
  percent: number
  bytesPerSecond: number
}

/** 自动更新器配置选项 */
export interface AutoUpdaterOptions {
  /** 应用启动后是否自动检查更新（默认 true，仅生产环境生效） */
  autoCheckOnLaunch?: boolean
  /** 是否自动下载（默认 false，由用户确认） */
  autoDownload?: boolean
  /** 退出时是否自动安装（默认 true） */
  autoInstallOnAppQuit?: boolean
}

/** 主窗口引用（用于向 renderer 推送状态） */
let mainWindowRef: BrowserWindow | null = null

/** 当前状态缓存（用于新订阅者立即获取最新状态） */
let currentStatus: UpdateStatus = { state: 'idle' }

/** 是否已初始化（避免重复绑定事件） */
let initialized = false

/** 是否已注册 IPC 监听器 */
let ipcRegistered = false

/**
 * 序列化 UpdateInfo（electron-updater 原始对象可能含复杂类型，不能直接 IPC 传输）
 */
function serializeUpdateInfo(info: UpdateInfo): SerializedUpdateInfo {
  let releaseNotes: string | null = null
  if (typeof info.releaseNotes === 'string') {
    releaseNotes = info.releaseNotes
  } else if (Array.isArray(info.releaseNotes)) {
    // electron-updater 可能返回 ReleaseNoteInfo[]，拼接为 markdown
    releaseNotes = info.releaseNotes
      .map((note) => {
        const version = note.version ?? ''
        const text = typeof note.note === 'string' ? note.note : ''
        return `## ${version}\n\n${text}`
      })
      .join('\n\n')
  }
  return {
    version: info.version ?? '',
    releaseDate: info.releaseDate ?? null,
    releaseNotes
  }
}

/**
 * 序列化下载进度
 */
function serializeProgress(info: ProgressInfo): SerializedProgressInfo {
  return {
    total: info.total ?? 0,
    delta: info.delta ?? 0,
    transferred: info.transferred ?? 0,
    percent: info.percent ?? 0,
    bytesPerSecond: info.bytesPerSecond ?? 0
  }
}

/**
 * 推送状态到所有 renderer
 */
function emitStatus(status: UpdateStatus): void {
  currentStatus = status
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('update:status-changed', status)
  }
}

/**
 * 初始化自动更新器
 *
 * 应在 app.whenReady() 之后调用。
 *
 * @param mainWindow 主窗口实例
 * @param options 配置选项
 */
export function setupAutoUpdater(
  mainWindow: BrowserWindow,
  options: AutoUpdaterOptions = {}
): void {
  mainWindowRef = mainWindow

  const {
    autoCheckOnLaunch = true,
    autoDownload = false,
    autoInstallOnAppQuit = true
  } = options

  if (!initialized) {
    initialized = true
    // 配置 autoUpdater
    autoUpdater.autoDownload = autoDownload
    autoUpdater.autoInstallOnAppQuit = autoInstallOnAppQuit
    // 不要在下载前弹出 Electron 原生通知（我们用自己的 UI）
    autoUpdater.allowDowngrade = false

    // 绑定事件 → 推送状态
    autoUpdater.on('checking-for-update', () => {
      emitStatus({ state: 'checking' })
    })

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      emitStatus({ state: 'available', info: serializeUpdateInfo(info) })
    })

    autoUpdater.on('update-not-available', () => {
      emitStatus({ state: 'not-available' })
    })

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      emitStatus({
        state: 'downloading',
        progress: serializeProgress(progress)
      })
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      emitStatus({ state: 'downloaded', info: serializeUpdateInfo(info) })
    })

    autoUpdater.on('error', (error: Error) => {
      emitStatus({ state: 'error', message: error?.message ?? String(error) })
    })
  }

  // 注册 IPC 监听器（仅一次）
  if (!ipcRegistered) {
    ipcRegistered = true
    registerIpcHandlers()
  }

  // 启动时检查更新（仅生产环境）
  if (autoCheckOnLaunch && !is.dev) {
    // 延迟 3 秒，避免与启动流程竞争资源
    setTimeout(() => {
      checkForUpdates().catch((err) => {
        console.warn('[auto-updater] 启动检查失败:', err?.message ?? err)
      })
    }, 3000)
  }
}

/**
 * 注册 IPC 处理器
 */
function registerIpcHandlers(): void {
  // 手动检查更新
  ipcMain.handle('update:check', async (): Promise<UpdateStatus> => {
    try {
      const result = await checkForUpdates()
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { state: 'error', message }
    }
  })

  // 触发下载
  ipcMain.handle('update:download', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emitStatus({ state: 'error', message })
      return { ok: false, error: message }
    }
  })

  // 退出并安装
  ipcMain.handle('update:install', (): { ok: boolean } => {
    try {
      // setImmediate 确保返回值先送回 renderer
      setImmediate(() => {
        autoUpdater.quitAndInstall(false, true)
      })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emitStatus({ state: 'error', message })
      return { ok: false }
    }
  })

  // 订阅状态变化（renderer 注册后立即收到当前状态）
  ipcMain.on('update:subscribe', (event: IpcMainEvent) => {
    event.sender.send('update:status-changed', currentStatus)
  })
}

/**
 * 检查更新（内部实现）
 *
 * 在开发环境下，electron-updater 缺少 app-update.yml，会抛错。
 * 这里捕获并降级为「无更新」。
 */
async function checkForUpdates(): Promise<UpdateStatus> {
  if (is.dev) {
    // 开发环境降级：直接返回「无更新」
    emitStatus({ state: 'not-available' })
    return currentStatus
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result || !result.isUpdateAvailable) {
      emitStatus({ state: 'not-available' })
    }
    // 如果有更新，update-available 事件会推送状态
    return currentStatus
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emitStatus({ state: 'error', message })
    return currentStatus
  }
}

/**
 * 清理自动更新器（应用退出时调用）
 */
export function destroyAutoUpdater(): void {
  mainWindowRef = null
}

// 显式导出类型供 preload 使用
export type { UpdateInfo, ProgressInfo }
