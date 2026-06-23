import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** 序列化后的更新信息（与 main/auto-updater.ts 保持一致） */
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

/** 更新状态（与 main/auto-updater.ts 保持一致） */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; info: SerializedUpdateInfo }
  | { state: 'not-available' }
  | { state: 'downloading'; progress: SerializedProgressInfo | null }
  | { state: 'downloaded'; info: SerializedUpdateInfo }
  | { state: 'error'; message: string }

/** 权限模式（与 renderer PermissionModeSwitch 一致） */
export type PermissionMode = 'auto' | 'plan' | 'readonly'

/** 文件选择结果 */
export interface FileSelectResult {
  canceled: boolean
  files: Array<{ path: string; name: string }>
}

/** 文件读取结果 */
export interface FileReadResult {
  ok: boolean
  content?: string
  encoding?: 'utf-8' | 'base64'
  size?: number
  error?: string
}

/** 工作区选择结果 */
export interface WorkspaceSelectResult {
  canceled: boolean
  path: string | null
}

/** 当前工作区信息 */
export interface WorkspaceInfo {
  path: string
  name: string
}

/** 通过 contextBridge 暴露给 renderer 的 API */
export interface PiAPI {
  /** 自动更新相关 */
  updater: {
    /** 手动检查更新 */
    check: () => Promise<UpdateStatus>
    /** 触发下载 */
    download: () => Promise<{ ok: boolean; error?: string }>
    /** 退出并安装 */
    install: () => Promise<{ ok: boolean }>
    /** 订阅状态变化（立即收到当前状态） */
    onStatus: (callback: (status: UpdateStatus) => void) => () => void
  }
  /** 托盘相关 */
  tray: {
    /** 通知主进程当前权限模式变化（用于托盘菜单勾选同步） */
    setPermissionMode: (mode: PermissionMode) => void
    /** 订阅托盘「新建会话」事件 */
    onNewSession: (callback: () => void) => () => void
    /** 订阅托盘「切换权限模式」事件 */
    onSwitchPermissionMode: (callback: (mode: PermissionMode) => void) => () => void
  }
  /** 工作区相关 */
  workspace: {
    /** 打开目录选择对话框 */
    select: () => Promise<WorkspaceSelectResult>
    /** 设置工作区路径 */
    set: (path: string) => Promise<{ ok: boolean; path: string }>
    /** 获取当前工作区信息 */
    getCurrent: () => Promise<WorkspaceInfo>
  }
  /** 文件相关 */
  file: {
    /** 打开文件选择对话框（支持多选） */
    select: () => Promise<FileSelectResult>
    /** 读取文件内容 */
    read: (path: string) => Promise<FileReadResult>
  }
  /** 嵌入式服务相关 */
  server: {
    /** 获取后端服务端口 */
    getPort: () => Promise<number | null>
  }
}

const api: PiAPI = {
  updater: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (callback) => {
      const handler = (_event: IpcRendererEvent, status: UpdateStatus): void => {
        callback(status)
      }
      ipcRenderer.on('update:status-changed', handler)
      // 注册订阅，主进程会立即推送当前状态
      ipcRenderer.send('update:subscribe')
      return () => {
        ipcRenderer.removeListener('update:status-changed', handler)
      }
    }
  },
  tray: {
    setPermissionMode: (mode) => {
      ipcRenderer.send('tray:update-permission-mode', mode)
    },
    onNewSession: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('tray:new-session', handler)
      return () => {
        ipcRenderer.removeListener('tray:new-session', handler)
      }
    },
    onSwitchPermissionMode: (callback) => {
      const handler = (_event: IpcRendererEvent, mode: PermissionMode): void => {
        callback(mode)
      }
      ipcRenderer.on('tray:switch-permission-mode', handler)
      return () => {
        ipcRenderer.removeListener('tray:switch-permission-mode', handler)
      }
    }
  },
  workspace: {
    select: () => ipcRenderer.invoke('workspace:select'),
    set: (path) => ipcRenderer.invoke('workspace:set', path),
    getCurrent: () => ipcRenderer.invoke('workspace:getCurrent'),
  },
  file: {
    select: () => ipcRenderer.invoke('file:select'),
    read: (path) => ipcRenderer.invoke('file:read', path),
  },
  server: {
    getPort: () => ipcRenderer.invoke('server:getPort'),
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
