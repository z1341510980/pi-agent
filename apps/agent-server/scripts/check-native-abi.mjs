import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

try {
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  db.prepare('select 1').get()
  db.close()
  console.log(`[native-abi] better-sqlite3 可加载，Node ABI ${process.versions.modules}`)
} catch (error) {
  console.error(`[native-abi] better-sqlite3 无法加载，当前 Node ABI ${process.versions.modules}`)
  console.error('workspace 原生模块与当前 Node ABI 不匹配（可能被 Electron ABI 覆盖过）')
  console.error('恢复命令：pnpm --filter agent-server rebuild better-sqlite3')
  console.error(error)
  process.exit(1)
}
