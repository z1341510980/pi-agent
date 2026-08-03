import { describe, expect, it } from 'vitest'
import { hasFileReference, splitFileReferences } from '../file-reference'
import type { FileReference } from '../file-reference'

/** 取出所有识别到的引用 */
function refs(text: string): FileReference[] {
  const out: FileReference[] = []
  for (const part of splitFileReferences(text)) {
    if (part.kind === 'ref') out.push(part.ref)
  }
  return out
}

describe('splitFileReferences', () => {
  it('识别裸文件名', () => {
    expect(refs('看一下 index.ts 这个文件')).toMatchObject([{ path: 'index.ts' }])
  })

  it('识别多级路径', () => {
    expect(refs('改的是 apps/desktop/src/main.tsx')).toMatchObject([
      { path: 'apps/desktop/src/main.tsx' },
    ])
  })

  it('识别 path:line', () => {
    expect(refs('见 src/foo.ts:42')).toMatchObject([{ path: 'src/foo.ts', line: 42 }])
  })

  it('识别 path:line:column', () => {
    expect(refs('报错在 src/foo.ts:42:7')).toMatchObject([
      { path: 'src/foo.ts', line: 42, column: 7 },
    ])
  })

  it('识别 GitHub 风格 #L 锚点', () => {
    expect(refs('参考 src/a.ts#L10')).toMatchObject([{ path: 'src/a.ts', line: 10 }])
  })

  it('识别 #L 区间', () => {
    expect(refs('参考 src/a.ts#L10-L20')).toMatchObject([
      { path: 'src/a.ts', line: 10, endLine: 20 },
    ])
  })

  it('识别 Windows 盘符路径', () => {
    expect(refs('文件在 D:/work/app/main.ts:3')).toMatchObject([
      { path: 'D:/work/app/main.ts', line: 3 },
    ])
  })

  it('识别 Windows 反斜杠路径', () => {
    expect(refs('文件在 src\\components\\App.tsx')).toMatchObject([
      { path: 'src\\components\\App.tsx' },
    ])
  })

  it('识别无扩展名的已知裸文件名', () => {
    expect(refs('改了 Dockerfile 和 Makefile')).toMatchObject([
      { path: 'Dockerfile' },
      { path: 'Makefile' },
    ])
  })

  it('一行里多个引用都能识别', () => {
    expect(refs('从 a/b.ts:1 移到 c/d.ts:2')).toMatchObject([
      { path: 'a/b.ts', line: 1 },
      { path: 'c/d.ts', line: 2 },
    ])
  })
})

describe('splitFileReferences · 不该误判的情况', () => {
  it('URL 里的路径不认', () => {
    expect(refs('见 https://example.com/docs/guide.md')).toEqual([])
  })

  it('版本号不认', () => {
    expect(refs('升级到 1.2.3 版本')).toEqual([])
  })

  it('未知扩展名不认', () => {
    expect(refs('这是 foo.bar 和 x.qqq')).toEqual([])
  })

  it('普通英文缩写不认', () => {
    expect(refs('e.g. this and i.e. that')).toEqual([])
  })

  it('纯数字带点不认', () => {
    expect(refs('结果是 3.14')).toEqual([])
  })

  it('域名不认', () => {
    expect(refs('访问 example.com 看看')).toEqual([])
  })
})

describe('splitFileReferences · 切分结果', () => {
  it('普通文本与引用交替，且能原样拼回', () => {
    const text = '改了 src/a.ts:1 和 src/b.ts，完成。'
    const parts = splitFileReferences(text)

    const rebuilt = parts
      .map((p) => (p.kind === 'text' ? p.text : p.ref.raw))
      .join('')
    expect(rebuilt).toBe(text)
    expect(parts.filter((p) => p.kind === 'ref')).toHaveLength(2)
  })

  it('没有引用时只有一段文本', () => {
    const parts = splitFileReferences('纯文字，没有引用')
    expect(parts).toEqual([{ kind: 'text', text: '纯文字，没有引用' }])
  })

  it('空字符串返回空数组', () => {
    expect(splitFileReferences('')).toEqual([])
  })
})

describe('hasFileReference', () => {
  it('有引用时为 true', () => {
    expect(hasFileReference('见 src/a.ts')).toBe(true)
  })

  it('无引用时为 false', () => {
    expect(hasFileReference('见文档第三章')).toBe(false)
  })
})
