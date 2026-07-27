import { describe, it, expect } from 'vitest'
import { addImportantToAll, wrapCustomCss, processCustomCss, validateCss } from '../custom-css-processor'

describe('custom-css-processor', () => {
  it('addImportantToAll 给每个声明加 !important', () => {
    expect(addImportantToAll(':root { --a: 1px; }')).toBe(':root { --a: 1px !important; }')
  })

  it('addImportantToAll 跳过已含 !important 的声明', () => {
    expect(addImportantToAll('a { color: red !important; }')).toBe('a { color: red !important; }')
  })

  it('wrapCustomCss 加注释头', () => {
    expect(wrapCustomCss('a{}')).toContain('用户自定义样式')
  })

  it('processCustomCss = wrap(addImportant())', () => {
    const result = processCustomCss('a { color: red; }')
    expect(result).toContain('!important')
    expect(result).toContain('用户自定义样式')
  })

  it('validateCss 检测大括号配对', () => {
    expect(validateCss('a { color: red; }').valid).toBe(true)
    expect(validateCss('a { color: red; ').valid).toBe(false)
  })

  it('validateCss 检测冒号存在', () => {
    expect(validateCss('a { nodcolonor }').valid).toBe(false)
  })

  it('addImportantToAll 支持含数字的自定义属性', () => {
    expect(addImportantToAll(':root { --color-primary-500: #fff; }')).toBe(':root { --color-primary-500: #fff !important; }')
  })

  it('addImportantToAll 支持含下划线的属性', () => {
    expect(addImportantToAll(':root { --my_var: 10px; }')).toBe(':root { --my_var: 10px !important; }')
  })
})
