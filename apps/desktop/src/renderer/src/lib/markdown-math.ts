import { useEffect, useState } from 'react'
import type { Options as ReactMarkdownOptions } from 'react-markdown'

/**
 * markdown 插件列表类型。
 *
 * 从 react-markdown 的 Options 里取，而不是直接引 `unified` —— unified 只是
 * react-markdown 的传递依赖，直接 import 会在 pnpm 严格模式下解析失败。
 */
export type MarkdownPluginList = NonNullable<ReactMarkdownOptions['remarkPlugins']>

/**
 * 数学公式插件的按需加载。
 *
 * ## 为什么不直接静态引
 *
 * `katex` + `rehype-katex` + katex 的 CSS 合计约 300KB，而含公式的消息是少数。
 * 静态引入意味着每次冷启动都为一个大概率用不到的能力付代价。
 *
 * ## 为什么可以延后
 *
 * 不带 math 插件时，`$x^2$` 会被当作普通文本原样显示 —— 内容没丢，只是没排版。
 * 检测到公式后加载插件、下一帧重渲染即成型。相比之下代码块的高亮更不能等
 * （那是每条消息都可能有的），所以两者都做了懒加载但 fallback 策略不同。
 */

/** 缓存加载结果：一个进程只加载一次 */
let mathPluginsPromise: Promise<{ remark: MarkdownPluginList; rehype: MarkdownPluginList }> | null = null

async function loadMathPlugins(): Promise<{ remark: MarkdownPluginList; rehype: MarkdownPluginList }> {
  if (!mathPluginsPromise) {
    mathPluginsPromise = (async () => {
      const [remarkMath, rehypeKatex] = await Promise.all([
        import('remark-math'),
        import('rehype-katex'),
        // CSS 必须一起加载，否则公式会以未排版的裸元素闪一下
        import('katex/dist/katex.min.css'),
      ])
      return {
        remark: [remarkMath.default] as MarkdownPluginList,
        rehype: [rehypeKatex.default] as MarkdownPluginList,
      }
    })()
  }
  return mathPluginsPromise
}

/**
 * 粗判文本里是否含 LaTeX 公式。
 *
 * **偏向"宁可多判 true"**：判断只决定要不要加载插件，不决定渲染结果。多加载一次
 * 时 remark-math 的行为与改造前「插件常驻」一致，不构成回归；漏判则公式渲染不出来。
 * 所以只排除明显不可能的情况（没有成对 `$`、内容为空、纯数字包裹）。
 */
export function looksLikeMath(source: string): boolean {
  if (!source.includes('$')) return false
  // 块级 $$…$$，中间要有非空白内容
  if (/\$\$[\s\S]*?\S[\s\S]*?\$\$/.test(source)) return true
  // 行内 $…$：不跨行、非空、且不是纯数字（`$1$` 没有意义）
  return /\$(?!\s)([^$\n]*[^\s\d$][^$\n]*)\$/.test(source)
}

export interface MarkdownPlugins {
  remark: MarkdownPluginList
  rehype: MarkdownPluginList
}

/**
 * 按内容决定是否附加数学插件。
 *
 * @param baseRemark 基础 remark 插件（gfm 等）
 * @param source 已完成预处理的 markdown 源（定界符已转成 `$`）
 */
export function useMathPlugins(baseRemark: MarkdownPluginList, source: string): MarkdownPlugins {
  const needsMath = looksLikeMath(source)
  const [loaded, setLoaded] = useState<MarkdownPlugins | null>(null)

  useEffect(() => {
    if (!needsMath || loaded) return
    let cancelled = false
    void loadMathPlugins().then((plugins) => {
      if (cancelled) return
      setLoaded({ remark: [...baseRemark, ...plugins.remark], rehype: plugins.rehype })
    })
    return () => {
      cancelled = true
    }
    // baseRemark 是模块级常量，identity 稳定
  }, [needsMath, loaded, baseRemark])

  if (needsMath && loaded) return loaded
  return { remark: baseRemark, rehype: [] }
}
