/**
 * 热更新 ESM 子树失效（module.register 定制解析钩子）
 *
 * 问题：ESM 以 URL 为缓存键。给入口追加 `?hot=N` 只让入口本身重新执行，
 * 其相对导入的子模块仍命中普通 URL 的缓存 —— 多文件插件热更新后除了
 * 入口全是旧代码。
 *
 * 方案：注册全局 resolve 钩子（Node 公开 API，dsh 用 --expose-internals
 * 清 loadCache 的等价物）。约定：
 *
 * - 候选导入总是以 `?hot=<当前代数>` 显式请求入口；
 * - 钩子规则：父模块 URL 带 `?hot=G` 且 G 等于当前代数时，给子模块解析结果
 *   追加同样的 `?hot=G` —— 戳记沿依赖树逐层传播，整棵子树获得全新 URL；
 * - 宿主自身代码（无戳父模块）完全不受影响；旧代数实例不再参与新解析，
 *   新旧代码不会混串；
 * - 每次候选导入前先 bump 代数并通过 MessagePort 推送给钩子线程。
 *
 * 代价：每代子树模块驻留 ESM 注册表直到进程结束（dev 工具属性，可接受）。
 *
 * @module core/plugin/hot-module-cache
 */

import type { MessagePort } from 'node:worker_threads'

let generation = 0
let registered = false
/** 宿主侧端口：用于向钩子线程推送代数变更 */
let hostPort: MessagePort | undefined

/** 当前热更新代数 */
export function currentHotGeneration(): number {
  return generation
}

/**
 * 递增并返回新代数；每次候选导入前调用。
 * 代数变更同步推送给钩子线程，使后续子树解析带上新戳。
 */
export function bumpHotGeneration(): number {
  const next = ++generation
  try {
    hostPort?.postMessage({ type: 'bump', gen: next })
  } catch {
    // 钩子线程已关闭（进程退出中）；热更新随之失效，无需处理
  }
  return next
}

/**
 * 解析钩子源码（以 data: URL 注册，规避 src/dist 两种布局下的文件定位问题）。
 *
 * 注意此代码运行在钩子专用线程里，不能引用宿主模块。
 */
const HOOKS_SOURCE = `
let gen = 0
const HOT = /[?&]hot=(\\d+)/
export async function initialize(data) {
  if (!data) return
  if (typeof data.gen === 'number') gen = data.gen
  if (!data.port) return
  data.port.on('message', (m) => {
    if (m && m.type === 'bump' && typeof m.gen === 'number') gen = m.gen
  })
  if (typeof data.port.ref === 'function') data.port.ref()
}
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  try {
    if (!result || typeof result.url !== 'string' || !result.url.startsWith('file:')) return result
    const parentURL = context.parentURL
    const match = parentURL ? HOT.exec(parentURL) : null
    if (!match) return result
    if (match[1] !== String(gen)) return result
    if (HOT.test(result.url)) return result
    const sep = result.url.includes('?') ? '&' : '?'
    return { url: \`\${result.url}\${sep}hot=\${gen}\`, shortCircuit: true }
  } catch {
    return result
  }
}
`

/**
 * 注册热更新解析钩子（幂等，进程内只注册一次）。
 *
 * 必须发生在任何 `?hot=` 导入之前；plugin-loader 在启用热更新时
 * 于启动期调用本函数。
 */
export async function ensureHotResolveHooks(): Promise<void> {
  if (registered) return
  const nodeModule = await import('node:module')
  const { MessageChannel } = await import('node:worker_threads')
  // 运行时签名与 @types/node 不一致：实际支持 (specifier, parentURL, options)
  // 且选项键为 transferList。以运行时行为为准，这里显式收窄类型。
  const register = nodeModule.register as unknown as (
    specifier: string,
    parentURL: string | undefined,
    options: { data?: unknown; transferList?: MessagePort[] }
  ) => Promise<void>
  const { port1, port2 } = new MessageChannel()
  // port2 转移给钩子线程；port1 由宿主持有，用于推送代数变更。
  // 注意：Node 22.x 运行时的实际选项键是 transferList（文档与 @types/node
  // 仍写作 transfer，按文档传会导致端口序列化失败），这里以运行时行为为准。
  await register(
    `data:text/javascript,${encodeURIComponent(HOOKS_SOURCE)}`,
    import.meta.url,
    { data: { port: port2, gen: generation }, transferList: [port2] }
  )
  port1.unref()
  hostPort = port1
  registered = true
}
