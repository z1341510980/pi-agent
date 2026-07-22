import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    server: {
      // 避开 Windows 动态保留端口范围 5141-5240（含 5173）
      port: 5273,
      strictPort: true
    },
    plugins: [react(), tailwindcss()]
  }
})
