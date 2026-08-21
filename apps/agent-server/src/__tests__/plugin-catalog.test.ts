/**
 * 插件 catalog 解析测试（研究文档 §10.2 / §10.11）
 *
 * 覆盖三处已证实的失配：
 * - `${VAR}` 引用此前完全没有实现，配置里的字面量被当成密钥
 * - `enabled: false` 与"未发现"被混为一谈
 * - `manifest.dependencies` 不构成依赖图
 */
import { describe, expect, it } from 'vitest'
import {
  parsePluginCatalog,
  resolveEnvRefs,
  resolveDependencyOrder,
  ALL_PLUGIN_CAPABILITIES,
} from '../core/plugin/plugin-catalog.js'

describe('resolveEnvRefs', () => {
  it('整值引用被替换，只记录变量名', () => {
    const result = resolveEnvRefs({ apiKey: '${MY_KEY}' }, { MY_KEY: 'secret-value' })
    expect(result.value).toEqual({ apiKey: 'secret-value' })
    expect(result.resolved).toEqual(['MY_KEY'])
    expect(result.missing).toEqual([])
  })

  it('缺失变量置为 undefined 而不是留下字面量', () => {
    const result = resolveEnvRefs({ apiKey: '${ABSENT}' }, {})
    expect(result.value).toEqual({ apiKey: undefined })
    expect(result.missing).toEqual(['ABSENT'])
  })

  it('空字符串视为未设置', () => {
    const result = resolveEnvRefs({ apiKey: '${EMPTY}' }, { EMPTY: '' })
    expect(result.missing).toEqual(['EMPTY'])
  })

  it('混合写法不替换并记为 unsupported', () => {
    const result = resolveEnvRefs({ url: 'https://${HOST}/api' }, { HOST: 'example.com' })
    expect(result.value).toEqual({ url: 'https://${HOST}/api' })
    expect(result.unsupported).toEqual(['https://${HOST}/api'])
    expect(result.resolved).toEqual([])
  })

  it('小写变量名不被接受', () => {
    const result = resolveEnvRefs({ key: '${lower}' }, { lower: 'x' })
    expect(result.value).toEqual({ key: '${lower}' })
    expect(result.unsupported).toEqual(['${lower}'])
  })

  it('递归处理嵌套对象与数组', () => {
    const result = resolveEnvRefs(
      { nested: { list: ['${A}', 'plain'], deep: { b: '${B}' } } },
      { A: 'a-value', B: 'b-value' }
    )
    expect(result.value).toEqual({
      nested: { list: ['a-value', 'plain'], deep: { b: 'b-value' } },
    })
    expect(result.resolved.sort()).toEqual(['A', 'B'])
  })

  it('非字符串值原样保留', () => {
    const result = resolveEnvRefs({ n: 1, b: true, nil: null }, {})
    expect(result.value).toEqual({ n: 1, b: true, nil: null })
  })
})

describe('parsePluginCatalog', () => {
  it('缺少 plugins 字段时返回空结果', () => {
    expect(parsePluginCatalog({})).toEqual({ items: [], diagnostics: [] })
    expect(parsePluginCatalog(null)).toEqual({ items: [], diagnostics: [] })
  })

  it('plugins 不是数组时报错', () => {
    const parsed = parsePluginCatalog({ plugins: 'nope' })
    expect(parsed.items).toEqual([])
    expect(parsed.diagnostics[0].message).toContain('数组')
  })

  it('enabled: false 的条目仍进 catalog', () => {
    const parsed = parsePluginCatalog({
      plugins: [{ id: 'hello-plugin', source: 'builtin', enabled: false }],
    })
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]).toMatchObject({ catalogId: 'hello-plugin', enabled: false })
  })

  it('省略 enabled 时默认启用', () => {
    const parsed = parsePluginCatalog({ plugins: [{ id: 'a', source: 'builtin' }] })
    expect(parsed.items[0].enabled).toBe(true)
  })

  it('id 缺失、重复或非字符串被拒绝', () => {
    const parsed = parsePluginCatalog({
      plugins: [
        { source: 'builtin' },
        { id: '  ', source: 'builtin' },
        { id: 'dup', source: 'builtin' },
        { id: 'dup', source: 'builtin' },
      ],
    })
    expect(parsed.items.map((item) => item.catalogId)).toEqual(['dup'])
    expect(parsed.diagnostics.filter((d) => d.level === 'error')).toHaveLength(3)
  })

  it('未知 source 被拒绝', () => {
    const parsed = parsePluginCatalog({ plugins: [{ id: 'a', source: 'ftp' }] })
    expect(parsed.items).toEqual([])
    expect(parsed.diagnostics[0].message).toContain('builtin/local/npm')
  })

  it('local/npm 缺少 sourceRef 被拒绝', () => {
    const parsed = parsePluginCatalog({
      plugins: [
        { id: 'a', source: 'local' },
        { id: 'b', source: 'npm' },
      ],
    })
    expect(parsed.items).toEqual([])
    expect(parsed.diagnostics).toHaveLength(2)
    expect(parsed.diagnostics.every((d) => d.message.includes('sourceRef'))).toBe(true)
  })

  it('未知 capability 被拒绝，而不是静默丢弃', () => {
    const parsed = parsePluginCatalog({
      plugins: [{ id: 'a', source: 'builtin', grants: ['tools.register', 'db.dropAll'] }],
    })
    expect(parsed.items).toEqual([])
    expect(parsed.diagnostics[0].message).toContain('db.dropAll')
  })

  it('合法 capability 全部通过', () => {
    const parsed = parsePluginCatalog({
      plugins: [{ id: 'a', source: 'builtin', grants: [...ALL_PLUGIN_CAPABILITIES] }],
    })
    expect(parsed.items[0].grants).toEqual([...ALL_PLUGIN_CAPABILITIES])
  })

  it('config 中的环境变量引用被解析，诊断只含变量名不含值', () => {
    const parsed = parsePluginCatalog(
      { plugins: [{ id: 'web', source: 'builtin', config: { apiKey: '${SEARCH_KEY}' } }] },
      { SEARCH_KEY: 'super-secret' }
    )
    expect(parsed.items[0].config).toEqual({ apiKey: 'super-secret' })
    const messages = parsed.diagnostics.map((d) => d.message).join(' ')
    expect(messages).toContain('SEARCH_KEY')
    expect(messages).not.toContain('super-secret')
  })

  it('环境变量缺失时给出 error 诊断且值为 undefined', () => {
    const parsed = parsePluginCatalog(
      { plugins: [{ id: 'web', source: 'builtin', config: { apiKey: '${ABSENT_KEY}' } }] },
      {}
    )
    expect(parsed.items[0].config).toEqual({ apiKey: undefined })
    expect(parsed.diagnostics.some((d) => d.level === 'error' && d.message.includes('ABSENT_KEY')))
      .toBe(true)
  })

  it('config 不是对象时被拒绝', () => {
    const parsed = parsePluginCatalog({
      plugins: [{ id: 'a', source: 'builtin', config: ['x'] }],
    })
    expect(parsed.items).toEqual([])
    expect(parsed.diagnostics[0].message).toContain('config')
  })

  it('非法条目不影响同文件中的合法条目', () => {
    const parsed = parsePluginCatalog({
      plugins: [{ id: 'bad', source: 'ftp' }, { id: 'good', source: 'builtin' }],
    })
    expect(parsed.items.map((item) => item.catalogId)).toEqual(['good'])
    expect(parsed.diagnostics).toHaveLength(1)
  })
})

describe('resolveDependencyOrder', () => {
  it('依赖先于消费方', () => {
    const result = resolveDependencyOrder([
      { pluginId: 'novel', dependencies: ['subagent'] },
      { pluginId: 'subagent', dependencies: [] },
    ])
    expect(result.order).toEqual(['subagent', 'novel'])
    expect(result.blocked.size).toBe(0)
  })

  it('无依赖时保持输入顺序', () => {
    const result = resolveDependencyOrder([
      { pluginId: 'a', dependencies: [] },
      { pluginId: 'b', dependencies: [] },
      { pluginId: 'c', dependencies: [] },
    ])
    expect(result.order).toEqual(['a', 'b', 'c'])
  })

  it('缺失依赖被记录并阻断该插件', () => {
    const result = resolveDependencyOrder([{ pluginId: 'novel', dependencies: ['absent'] }])
    expect(result.order).toEqual([])
    expect(result.missing.get('novel')).toEqual(['absent'])
    expect(result.blocked.has('novel')).toBe(true)
  })

  it('依赖链上游被阻断时消费方也被阻断', () => {
    const result = resolveDependencyOrder([
      { pluginId: 'leaf', dependencies: ['mid'] },
      { pluginId: 'mid', dependencies: ['absent'] },
    ])
    expect(result.order).toEqual([])
    expect(result.blocked.has('leaf')).toBe(true)
    expect(result.blocked.has('mid')).toBe(true)
    // 只有直接缺失的那个记 missing，传递阻断不谎报缺失项
    expect(result.missing.has('leaf')).toBe(false)
    expect(result.missing.get('mid')).toEqual(['absent'])
  })

  it('循环依赖被检出并给出环路', () => {
    const result = resolveDependencyOrder([
      { pluginId: 'a', dependencies: ['b'] },
      { pluginId: 'b', dependencies: ['a'] },
    ])
    expect(result.order).toEqual([])
    expect(result.cycles.get('a')).toEqual(['a', 'b', 'a'])
    expect(result.blocked.has('a')).toBe(true)
    expect(result.blocked.has('b')).toBe(true)
  })

  it('自依赖也算循环', () => {
    const result = resolveDependencyOrder([{ pluginId: 'a', dependencies: ['a'] }])
    expect(result.blocked.has('a')).toBe(true)
    expect(result.cycles.get('a')).toEqual(['a', 'a'])
  })

  it('健康插件不被同文件中的坏插件牵连', () => {
    const result = resolveDependencyOrder([
      { pluginId: 'broken', dependencies: ['absent'] },
      { pluginId: 'healthy', dependencies: [] },
      { pluginId: 'consumer', dependencies: ['healthy'] },
    ])
    expect(result.order).toEqual(['healthy', 'consumer'])
    expect(result.blocked).toEqual(new Set(['broken']))
  })

  it('菱形依赖只出现一次且顺序正确', () => {
    const result = resolveDependencyOrder([
      { pluginId: 'top', dependencies: ['left', 'right'] },
      { pluginId: 'left', dependencies: ['base'] },
      { pluginId: 'right', dependencies: ['base'] },
      { pluginId: 'base', dependencies: [] },
    ])
    expect(result.order.filter((id) => id === 'base')).toHaveLength(1)
    expect(result.order.indexOf('base')).toBeLessThan(result.order.indexOf('left'))
    expect(result.order.indexOf('left')).toBeLessThan(result.order.indexOf('top'))
    expect(result.order.indexOf('right')).toBeLessThan(result.order.indexOf('top'))
  })
})
