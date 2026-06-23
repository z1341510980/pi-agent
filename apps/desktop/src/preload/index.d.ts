import { ElectronAPI } from '@electron-toolkit/preload'
import type { PiAPI } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: PiAPI
  }
}

export {}
