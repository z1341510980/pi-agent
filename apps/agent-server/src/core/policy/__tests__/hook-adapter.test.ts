/**
 * Hook 配置解析器测试
 *
 * 验证自有配置格式的解析、非法条目拒绝和宿主安全策略默认值。
 *
 * @module core/policy/__tests__/hook-adapter.test
 */

import { describe, expect, it } from 'vitest'
import {
  parsePiHookConfigDetailed,
  parseHookSecurity,
  normalizeToHookDefinitions,
  parsePiHooks,
  type PiHookConfig,
} from '../hook-adapter.js'


describe('Hook 配置解析器', () => {
  describe('parsePiHookConfigDetailed', () => {
    it('应解析配置中的 command 和 timeoutSec', () => {
      const config: PiHookConfig = {
        hooks: [
          { point: 'PreToolUse', command: 'echo "pre"', timeoutSec: 5 },
        ],
      }
      const result = parsePiHookConfigDetailed(config).hooks
      expect(result).toHaveLength(1)
      expect(result[0].command).toBe('echo "pre"')
      expect(result[0].timeoutSec).toBe(5)
      expect(result[0].point).toBe('PreToolUse')
      expect(result[0].enabled).toBe(true)
    })

    it('应处理 matcher 字段', () => {
      const config: PiHookConfig = {
        hooks: [
          { point: 'PreToolUse', command: 'echo "tool"', matcher: 'bash' },
        ],
      }
      const result = parsePiHookConfigDetailed(config).hooks
      expect(result[0].matcher).toBe('bash')
    })

    it('应默认 enabled 为 true', () => {
      const config: PiHookConfig = {
        hooks: [
          { point: 'PreToolUse', command: 'echo' },
        ],
      }
      const result = parsePiHookConfigDetailed(config).hooks
      expect(result[0].enabled).toBe(true)
    })

    it('应支持显式设置 enabled 为 false', () => {
      const config: PiHookConfig = {
        hooks: [
          { point: 'PreToolUse', command: 'echo', enabled: false },
        ],
      }
      const result = parsePiHookConfigDetailed(config).hooks
      expect(result[0].enabled).toBe(false)
    })

    it('应处理空配置', () => {
      const result = parsePiHookConfigDetailed({}).hooks
      expect(result).toHaveLength(0)
    })

    it('应处理所有 Hook 点类型', () => {
      const config: PiHookConfig = {
        hooks: [
          { point: 'PreToolUse', command: 'echo' },
          { point: 'PostToolUse', command: 'echo' },
          { point: 'SessionStart', command: 'echo' },
          { point: 'UserPromptSubmit', command: 'echo' },
          { point: 'Stop', command: 'echo' },
        ],
      }
      const result = parsePiHookConfigDetailed(config).hooks
      expect(result.map(h => h.point)).toEqual([
        'PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'
      ])
    })
  })

  describe('非法条目被拒绝而不是带进运行时', () => {
    it('未知 point 被拒绝并给出原因', () => {
      const config = {
        hooks: [{ point: 'BeforeAnything', command: 'echo' }],
      } as unknown as PiHookConfig
      const parsed = parsePiHookConfigDetailed(config)
      expect(parsed.hooks).toHaveLength(0)
      expect(parsed.rejected).toEqual([{ index: 0, reason: '未知 Hook point: BeforeAnything' }])
    })

    it('command 缺失或空白被拒绝', () => {
      const config = {
        hooks: [
          { point: 'Stop' },
          { point: 'Stop', command: '   ' },
        ],
      } as unknown as PiHookConfig
      const parsed = parsePiHookConfigDetailed(config)
      expect(parsed.hooks).toHaveLength(0)
      expect(parsed.rejected.map((item) => item.index)).toEqual([0, 1])
    })

    it('args 必须为字符串数组', () => {
      const config = {
        hooks: [{ point: 'Stop', command: 'node', args: [1, 2] }],
      } as unknown as PiHookConfig
      const parsed = parsePiHookConfigDetailed(config)
      expect(parsed.hooks).toHaveLength(0)
      expect(parsed.rejected[0].reason).toContain('args')
    })

    it('非正数 timeoutSec 被拒绝', () => {
      const config = {
        hooks: [
          { point: 'Stop', command: 'node', timeoutSec: 0 },
          { point: 'Stop', command: 'node', timeoutSec: -5 },
          { point: 'Stop', command: 'node', timeoutSec: 'fast' },
        ],
      } as unknown as PiHookConfig
      const parsed = parsePiHookConfigDetailed(config)
      expect(parsed.hooks).toHaveLength(0)
      expect(parsed.rejected).toHaveLength(3)
    })

    it('非法条目不影响同一文件中的合法条目', () => {
      const config = {
        hooks: [
          { point: 'Nope', command: 'echo' },
          { point: 'Stop', command: 'node', args: ['-e', 'console.log(1)'] },
        ],
      } as unknown as PiHookConfig
      const parsed = parsePiHookConfigDetailed(config)
      expect(parsed.hooks.map((hook) => hook.point)).toEqual(['Stop'])
      expect(parsed.rejected).toHaveLength(1)
    })
  })

  describe('宿主安全策略', () => {
    it('缺省时最严格：非受信', () => {
      expect(parseHookSecurity({})).toEqual({ trusted: false })
    })

    it('显式 trusted 才放开', () => {
      expect(parseHookSecurity({ security: { trusted: true } }).trusted).toBe(true)
      // 非布尔真值不能提权
      expect(
        parseHookSecurity({ security: { trusted: 'yes' } } as unknown as PiHookConfig).trusted
      ).toBe(false)
    })

    it('读取 envAllowlist / maxOutputBytes / cwd', () => {
      const security = parseHookSecurity({
        security: { envAllowlist: ['PATH', 'TZ'], maxOutputBytes: 1024, cwd: '/tmp' },
      })
      expect(security.envAllowlist).toEqual(['PATH', 'TZ'])
      expect(security.maxOutputBytes).toBe(1024)
      expect(security.cwd).toBe('/tmp')
    })

    it('非法 maxOutputBytes 退回默认（不写入）', () => {
      expect(parseHookSecurity({ security: { maxOutputBytes: 0 } }).maxOutputBytes).toBeUndefined()
      expect(parseHookSecurity({ security: { maxOutputBytes: -1 } }).maxOutputBytes).toBeUndefined()
    })
  })

  describe('parsePiHooks', () => {
    it('应一站式解析配置到 HookDefinition', () => {
      const config: PiHookConfig = {
        hooks: [
          { point: 'PreToolUse', command: 'echo', timeoutSec: 5, matcher: 'bash' },
        ],
      }
      const result = parsePiHooks(config)
      expect(result[0]).toEqual({
        point: 'PreToolUse',
        command: 'echo',
        timeoutSec: 5,
        matcher: 'bash',
        enabled: true,
      })
    })

    it('保留 args 与 shell 声明', () => {
      const result = parsePiHooks({
        hooks: [{ point: 'Stop', command: 'node', args: ['-e', 'console.log(1)'], shell: true }],
      })
      expect(result[0]).toMatchObject({
        command: 'node',
        args: ['-e', 'console.log(1)'],
        shell: true,
      })
    })
  })

  describe('normalizeToHookDefinitions', () => {
    it('应转换为 PolicyHookManager 所需的格式', () => {
      const normalized = [
        { point: 'PreToolUse' as const, command: 'echo', timeoutSec: 5, matcher: 'bash', enabled: true },
      ]
      const defs = normalizeToHookDefinitions(normalized)
      expect(defs[0]).toEqual({
        point: 'PreToolUse',
        command: 'echo',
        timeoutSec: 5,
        matcher: 'bash',
        enabled: true,
      })
    })
  })
})

