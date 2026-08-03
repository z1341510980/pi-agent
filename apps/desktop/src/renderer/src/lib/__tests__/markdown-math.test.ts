import { describe, expect, it } from 'vitest'
import { looksLikeMath } from '../markdown-math'

/**
 * 数学插件是按需加载的，是否加载完全取决于这个判断。
 *
 * **判断偏向"宁可多加载"。** 原因：这个函数只决定要不要加载插件，不决定渲染结果。
 * 判 true 而文本其实没有公式时，remark-math 的行为与改造前「插件常驻」完全一致，
 * 不构成回归；判 false 而文本有公式则公式渲染不出来，是真回归。
 * 所以下面只钉住「明显不是公式」的快路径，不追求精确排除所有 `$` 用法。
 */

describe('looksLikeMath', () => {
  it('没有 $ 直接返回 false（快路径）', () => {
    expect(looksLikeMath('普通文本 with code')).toBe(false)
  })

  it('识别块级 $$…$$', () => {
    expect(looksLikeMath('前文\n$$\na^2 + b^2 = c^2\n$$\n后文')).toBe(true)
  })

  it('识别行内 $…$', () => {
    expect(looksLikeMath('能量 $E = mc^2$ 就这样')).toBe(true)
  })

  it('只有一个 $ 时不加载（没有成对定界符）', () => {
    expect(looksLikeMath('这个要 $100 美元')).toBe(false)
    expect(looksLikeMath('单独一个 $ 符号')).toBe(false)
  })

  it('空的 $$ 之间没内容不算公式', () => {
    expect(looksLikeMath('$$')).toBe(false)
  })

  it('行内公式不跨行', () => {
    // 跨行的 $ … $ 不是行内公式
    expect(looksLikeMath('$开头\n结尾$')).toBe(false)
  })

  it('含变量名的行内公式能识别', () => {
    expect(looksLikeMath('设 $x$ 为变量')).toBe(true)
  })

  it('纯数字包裹不算公式（$1$ 这种没意义）', () => {
    expect(looksLikeMath('第 $1$ 项')).toBe(false)
  })
})
