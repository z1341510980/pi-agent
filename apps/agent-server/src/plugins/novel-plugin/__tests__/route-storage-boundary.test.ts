import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const routesDirectory = join(import.meta.dirname, '../routes')

describe('novel route storage boundary', () => {
  it('keeps direct SQLite access out of route modules', () => {
    const violations = readdirSync(routesDirectory)
      .filter(file => file.endsWith('.ts'))
      .flatMap(file => {
        const source = readFileSync(join(routesDirectory, file), 'utf8')
        return /(?:context\.db|\.prepare\(|\.transaction\(|\.exec\()/.test(source) ? [file] : []
      })

    expect(violations).toEqual([])
  })
})
