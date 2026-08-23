import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(process.cwd(), 'src')
const HOST_ROOTS = ['core', 'routes', 'lib']

function filesUnder(dir: string): string[] {
  const result: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) result.push(...filesUnder(path))
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) result.push(path)
  }
  return result
}

describe('novel plugin architecture boundary', () => {
  it('host modules do not import novel plugin internals', () => {
    const violations = filesUnder(ROOT)
      .filter((file) => HOST_ROOTS.some((root) => relative(ROOT, file).startsWith(`${root}${sep}`)))
      .filter((file) => readFileSync(file, 'utf8').includes('plugins/novel-plugin'))
      .map((file) => relative(ROOT, file))
    expect(violations).toEqual([])
  })

  it('app.ts does not import novel modules', () => {
    expect(readFileSync(join(ROOT, 'app.ts'), 'utf8')).not.toMatch(/novel-plugin|novel[-_]chapter/i)
  })
})
