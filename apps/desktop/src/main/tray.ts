import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, type MenuItemConstructorOptions } from 'electron'
import icon from '../../resources/icon.png?asset'

/**
 * 系统托盘管理
 *
 * 功能：
 * - 创建系统托盘图标
 * - 右键菜单：显示主窗口、新建会话、切换权限模式、退出
 * - 关闭窗口时最小化到托盘（而非退出）
 * - 双击托盘图标恢复窗口
 *
 * 设计参考：docs/ARCHITECTURE.md §18、docs/FRONTEND_DESIGN_SYSTEM.md §6.5
 */

/** 权限模式（与 renderer 的 PermissionModeSwitch 保持一致） */
type PermissionMode = 'auto' | 'plan' | 'readonly'

const PERMISSION_MODE_ORDER: PermissionMode[] = ['auto', 'plan', 'readonly']
const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  auto: 'Auto（自动）',
  plan: 'Plan（计划）',
  readonly: 'Read-only（只读）'
}

let tray: Tray | null = null

/** 是否已注册过 IPC 监听器（避免重复注册） */
let ipcRegistered = false

/**
 * 创建系统托盘
 *
 * @param getMainWindow 获取主窗口的函数（延迟获取，避免时序问题）
 * @returns 创建的 Tray 实例
 */
export function createTray(getMainWindow: () => BrowserWindow | null): Tray {
  // 使用应用图标作为托盘图标；在 Windows 上推荐 16x16 ICO，但 PNG 也可工作
  const trayIcon = nativeImage.createFromPath(icon)
  // macOS 上托盘图标应为模板图（黑白透明），这里保持原样
  if (process.platform === 'darwin') {
    trayIcon.setTemplateImage(true)
  }

  tray = new Tray(trayIcon)
  tray.setToolTip('PI Agent')

  // 双击托盘图标 → 显示并聚焦主窗口
  tray.on('double-click', () => {
    showMainWindow(getMainWindow())
  })

  // 初始菜单
  updateTrayMenu(getMainWindow, 'auto')

  // 注册一次 IPC 监听器，用于从 renderer 同步当前权限模式到托盘菜单
  if (!ipcRegistered) {
    ipcRegistered = true
    ipcMain.on('tray:update-permission-mode', (_event, mode: PermissionMode) => {
      if (tray) {
        updateTrayMenu(getMainWindow, mode)
      }
    })
  }

  return tray
}

/**
 * 重新构建并设置托盘右键菜单
 *
 * @param getMainWindow 获取主窗口的函数
 * @param currentMode 当前权限模式（用于菜单勾选）
 */
function updateTrayMenu(
  getMainWindow: () => BrowserWindow | null,
  currentMode: PermissionMode
): void {
  if (!tray) return

  const menuTemplate: MenuItemConstructorOptions[] = [
    {
      label: '显示主窗口',
      click: () => showMainWindow(getMainWindow())
    },
    {
      label: '新建会话',
      click: () => {
        const win = getMainWindow()
        if (win) {
          showMainWindow(win)
          win.webContents.send('tray:new-session')
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: '权限模式',
      submenu: PERMISSION_MODE_ORDER.map((mode) => ({
        label: PERMISSION_MODE_LABELS[mode],
        type: 'checkbox' as const,
        checked: mode === currentMode,
        click: () => {
          const win = getMainWindow()
          win?.webContents.send('tray:switch-permission-mode', mode)
        }
      }))
    },
    {
      type: 'separator'
    },
    {
      label: '退出',
      click: () => {
        // 标记本次退出为「真正退出」，绕过最小化到托盘逻辑
        app.exit(0)
      }
    }
  ]

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate))
}

/**
 * 显示并聚焦主窗口
 *
 * - 如果窗口最小化或隐藏，先恢复
 * - 然后显示并聚焦
 */
function showMainWindow(win: BrowserWindow | null): void {
  if (!win) return
  if (win.isMinimized()) {
    win.restore()
  }
  if (!win.isVisible()) {
    win.show()
  }
  win.focus()
}

/**
 * 销毁托盘（应用退出时调用）
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

/**
 * 将窗口关闭行为改为最小化到托盘
 *
 * 应在主窗口创建后调用，绑定 close 事件。
 * 用户从托盘菜单选择「退出」时调用 app.exit() 跳过此逻辑。
 *
 * @param win 主窗口
 */
export function attachMinimizeToTray(win: BrowserWindow): void {
  win.on('close', (event) => {
    // 防止窗口真正关闭，改为隐藏到托盘
    event.preventDefault()
    win.hide()
  })
}
