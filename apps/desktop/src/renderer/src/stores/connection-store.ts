import { create } from 'zustand'

// ── 类型定义 ──

export type ServerStatus = 'online' | 'offline' | 'connecting'
export type WsStatus = 'connected' | 'disconnected' | 'reconnecting'

interface ConnectionState {
  serverStatus: ServerStatus
  wsStatus: WsStatus
  lastConnectedAt: number | null

  setServerStatus: (status: ServerStatus) => void
  setWsStatus: (status: WsStatus) => void
  markConnected: () => void
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  serverStatus: 'connecting',
  wsStatus: 'disconnected',
  lastConnectedAt: null,

  setServerStatus: (status) => set({ serverStatus: status }),
  setWsStatus: (status) => set({ wsStatus: status }),
  markConnected: () =>
    set({ wsStatus: 'connected', lastConnectedAt: Date.now() }),
}))
