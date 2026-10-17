import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('structured LLM submission architecture', () => {
  it('keeps primary beat/outline submission sessions tool-driven', () => {
    const files = [
      resolve(process.cwd(), 'src/plugins/novel-plugin/core/chapters/beat-plan-generator.ts'),
      resolve(process.cwd(), 'src/plugins/novel-plugin/core/chapters/chapter-outline-generator.ts'),
    ]
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source).toContain('submit_chapter_')
      expect(source).toContain('createSession')
      expect(source).toContain('tools:')
      expect(source).toContain('文本解析只作兜底')
    }
  })
})
