/**
 * PluginWatcher 单元测试。
 *
 * 用真实临时目录 + 真实 fs.watch 驱动（文件系统事件是本组件的被测边界，
 * mock 掉就只剩自说自话）；去抖窗口用小延迟控制测试时长。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { PluginWatcher } from '../plugin-watcher.js'

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silentLogger
} as unknown as FastifyBaseLogger

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pi-plugin-watcher-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** 在临时工作区里准备一个插件目录并写入入口文件 */
function seedPlugin(name: string, content = 'export {}\n'): string {
  const dir = join(workDir, name)
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, 'index.js')
  writeFileSync(entry, content, 'utf-8')
  return entry
}

describe('PluginWatcher', () => {
  it('登记目录的文件变更会触发对应插件的重载回调', async () => {
    const entry = seedPlugin('a', 'export const v = 1\n')
    const onReload = vi.fn().mockResolvedValue(undefined)
    const watcher = new PluginWatcher(silentLogger, onReload, { debounceMs: 50 })
    watcher.add('plugin-a', entry)

    writeFileSync(entry, 'export const v = 2\n', 'utf-8')
    await vi.waitFor(
      () => {
        expect(onReload).toHaveBeenCalledWith('plugin-a')
      },
      { timeout: 3000, interval: 50 }
    )
    await watcher.close()
  })

  it('去抖窗口内的多次写入只触发一次重载', async () => {
    const entry = seedPlugin('b', 'export const v = 1\n')
    const onReload = vi.fn().mockResolvedValue(undefined)
    // 去抖窗口长于写入间隔，窗口内连续写三次
    const watcher = new PluginWatcher(silentLogger, onReload, { debounceMs: 300 })
    watcher.add('plugin-b', entry)

    writeFileSync(entry, 'export const v = 2\n', 'utf-8')
    await new Promise((resolve) => setTimeout(resolve, 60))
    writeFileSync(entry, 'export const v = 3\n', 'utf-8')
    await new Promise((resolve) => setTimeout(resolve, 60))
    writeFileSync(entry, 'export const v = 4\n', 'utf-8')

    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(onReload).toHaveBeenCalledTimes(1)
    await watcher.close()
  })

  it('编辑器临时文件的变更被忽略', async () => {
    const entry = seedPlugin('c')
    const onReload = vi.fn().mockResolvedValue(undefined)
    const watcher = new PluginWatcher(silentLogger, onReload, { debounceMs: 50 })
    watcher.add('plugin-c', entry)

    writeFileSync(join(entry, '..', '.index.js.swp'), 'garbage', 'utf-8')
    writeFileSync(`${entry}~`, 'garbage', 'utf-8')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(onReload).not.toHaveBeenCalled()
    await watcher.close()
  })

  it('close 会等待在途重载结束后才返回，且关闭后不再接受新任务', async () => {
    const entry = seedPlugin('d', 'export const v = 1\n')
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let finished = false
    const onReload = vi.fn().mockImplementation(() => {
      return gate.then(() => {
        finished = true
      })
    })
    const watcher = new PluginWatcher(silentLogger, onReload, { debounceMs: 30 })
    watcher.add('plugin-d', entry)

    writeFileSync(entry, 'export const v = 2\n', 'utf-8')
    await vi.waitFor(
      () => {
        expect(onReload).toHaveBeenCalledWith('plugin-d')
      },
      { timeout: 3000, interval: 50 }
    )

    // 在途回调未结束时 close 不返回
    const closing = watcher.close()
    const closedBeforeRelease = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise((resolve) => setTimeout(() => resolve('pending' as const), 100))
    ])
    expect(closedBeforeRelease).toBe('pending')

    release?.()
    await closing
    expect(finished).toBe(true)
    expect(watcher.watchedRootCount).toBe(0)

    // 关闭后写入不再触发
    writeFileSync(entry, 'export const v = 3\n', 'utf-8')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('不同根目录的插件互不干扰', async () => {
    const entryA = seedPlugin('fa')
    const entryB = seedPlugin('fb')
    const onReload = vi.fn().mockResolvedValue(undefined)
    const watcher = new PluginWatcher(silentLogger, onReload, { debounceMs: 50 })
    watcher.add('plugin-fa', entryA)
    watcher.add('plugin-fb', entryB)
    // 每个插件各自的包目录是一个监听根
    expect(watcher.watchedRootCount).toBe(2)

    writeFileSync(entryB, 'export const x = 1\n', 'utf-8')
    await vi.waitFor(
      () => {
        expect(onReload).toHaveBeenCalledWith('plugin-fb')
      },
      { timeout: 3000, interval: 50 }
    )
    expect(onReload).not.toHaveBeenCalledWith('plugin-fa')
    await watcher.close()
  })

  it('remove 摘除登记后变更不再触发，独占监听根一并关闭', async () => {
    const entry = seedPlugin('r')
    const onReload = vi.fn().mockResolvedValue(undefined)
    const watcher = new PluginWatcher(silentLogger, onReload, { debounceMs: 50 })
    watcher.add('plugin-r', entry)
    expect(watcher.watchedRootCount).toBe(1)

    watcher.remove('plugin-r')
    expect(watcher.watchedRootCount).toBe(0)

    writeFileSync(entry, 'export const x = 1\n', 'utf-8')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(onReload).not.toHaveBeenCalled()
    await watcher.close()
  })

  it('共享同一根目录的插件共同触发（无模块图无法按文件归因，取保守行为）', async () => {
    const dir = join(workDir, 'e')
    mkdirSync(dir, { recursive: true })
    const entryA = join(dir, 'a.js')
    const entryB = join(dir, 'b.js')
    writeFileSync(entryA, 'export {}\n', 'utf-8')
    writeFileSync(entryB, 'export {}\n', 'utf-8')
    const onReload = vi.fn().mockResolvedValue(undefined)
    const watcher = new PluginWatcher(silentLogger, onReload, { debounceMs: 50 })
    watcher.add('plugin-ea', entryA)
    watcher.add('plugin-eb', entryB)
    // 同目录复用同一个 watcher 句柄
    expect(watcher.watchedRootCount).toBe(1)

    writeFileSync(entryA, 'export const x = 1\n', 'utf-8')
    await vi.waitFor(
      () => {
        expect(onReload).toHaveBeenCalledWith('plugin-ea')
        expect(onReload).toHaveBeenCalledWith('plugin-eb')
      },
      { timeout: 3000, interval: 50 }
    )
    await watcher.close()
  })
})
