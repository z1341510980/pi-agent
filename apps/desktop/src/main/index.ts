import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename } from 'path'
import { readFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createTray, attachMinimizeToTray, destroyTray } from './tray'
import { setupAutoUpdater, destroyAutoUpdater } from './auto-updater'
import { startEmbeddedServer, stopEmbeddedServer, getEmbeddedServerPort } from './server'

/** 当前工作目录 */
let currentCwd = process.env.PI_CWD ?? process.cwd()

/** 主窗口引用（用于托盘和更新器获取） */
let mainWindow: BrowserWindow | null = null

/** 嵌入式后端服务端口 */
let serverPort: number | null = null

// ── Workspace IPC handlers ──

/** 选择工作区目录 */
ipcMain.handle('workspace:select', async () => {
  const win = mainWindow
  if (!win) return { canceled: true, path: null }
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '选择工作区目录',
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, path: null }
  }
  return { canceled: false, path: result.filePaths[0] }
})

/** 设置工作区路径 */
ipcMain.handle('workspace:set', async (_event, path: string) => {
  currentCwd = path
  return { ok: true, path: currentCwd }
})

/** 获取当前工作区路径 */
ipcMain.handle('workspace:getCurrent', async () => {
  return { path: currentCwd, name: basename(currentCwd) }
})

/** 获取嵌入式后端服务端口 */
ipcMain.handle('server:getPort', async () => {
  // 实时读取：崩溃自动重启后端口会变化，不能用启动时缓存的旧值
  return getEmbeddedServerPort()
})

// ── File IPC handlers ──

/** 选择文件 */
ipcMain.handle('file:select', async () => {
  const win = mainWindow
  if (!win) return { canceled: true, files: [] }
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: '选择文件',
  })
  if (result.canceled) {
    return { canceled: true, files: [] }
  }
  return {
    canceled: false,
    files: result.filePaths.map((p) => ({ path: p, name: basename(p) })),
  }
})

/** 读取文件内容 */
ipcMain.handle('file:read', async (_event, filePath: string) => {
  try {
    const buffer = await readFile(filePath)
    // 检测是否为二进制文件（简单判断：前 8KB 中是否含 NULL 字节）
    const checkLen = Math.min(buffer.length, 8192)
    let isBinary = false
    for (let i = 0; i < checkLen; i++) {
      if (buffer[i] === 0) {
        isBinary = true
        break
      }
    }
    if (isBinary) {
      return { ok: true, content: buffer.toString('base64'), encoding: 'base64' as const, size: buffer.length }
    }
    return { ok: true, content: buffer.toString('utf-8'), encoding: 'utf-8' as const, size: buffer.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

function createWindow(): void {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // CSP 已按产品要求移除：画布需要加载任意外部图片/媒体，且本地代理已覆盖
  // 不可达域名。renderer 只加载本地内容，contextIsolation 开启、nodeIntegration
  // 关闭；如需恢复，在 onHeadersReceived 注入 Content-Security-Policy 即可。

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote url for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 关闭窗口时最小化到托盘（而非退出）
  attachMinimizeToTray(win)

  mainWindow = win
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  // 必须与 electron-builder.yml 的 appId 一致，否则 Windows 任务栏会回退到 Electron 默认图标
  electronApp.setAppUserModelId('com.wenlang-agent.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 启动嵌入式后端服务
  // 开发模式：默认跳过，由开发者手动启动 `pnpm dev:server`（端口 3900）
  //   若需 Electron 内联启动，设置环境变量 PI_EMBED_SERVER_IN_DEV=1
  // 生产模式：ELECTRON_RUN_AS_NODE 复用 Electron 内置 Node，运行 bytenode 字节码
  const isDev = !app.isPackaged
  const embedInDev = process.env.PI_EMBED_SERVER_IN_DEV === '1'
  if (isDev && !embedInDev) {
    console.log('[embedded-server] 开发模式跳过嵌入式启动，请手动运行 `pnpm dev:server`（默认端口 3900）')
  } else {
    try {
      serverPort = await startEmbeddedServer()
      console.log(`嵌入式 Agent Server 运行于 http://127.0.0.1:${serverPort}`)
    } catch (err) {
      console.error('嵌入式 Agent Server 启动失败:', err)
    }
  }

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  // 创建系统托盘
  createTray(() => mainWindow)

  // 初始化自动更新器（仅生产环境实际检查更新）
  if (mainWindow) {
    setupAutoUpdater(mainWindow, {
      autoCheckOnLaunch: true,
      autoDownload: false,
      autoInstallOnAppQuit: true
    })
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopEmbeddedServer()
  destroyTray()
  destroyAutoUpdater()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
