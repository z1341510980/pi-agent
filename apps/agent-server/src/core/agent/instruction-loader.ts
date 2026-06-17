import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * InstructionLoader：项目级指令加载
 */
export class InstructionLoader {
  constructor(private readonly cwd: string) {}

  loadInstructions(): string | null {
    const instructionFile = join(this.cwd, '.pi', 'instructions.md')
    if (!existsSync(instructionFile)) {
      return null
    }

    try {
      const content = readFileSync(instructionFile, 'utf-8')
      return content.trim() || null
    } catch {
      return null
    }
  }
}
