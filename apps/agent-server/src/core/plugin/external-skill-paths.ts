/**
 * 第三方 Pi 包 Skills 发现（方案 §9.3 策略层接口的落地形态）
 *
 * Pi 生态的包（pi install 型，如 @llblab/pi-actors、pi-subagents、@johanthoren/jeff）
 * 通过 manifest 声明 skills/ 目录。我们的 plugin:* 会话保持 noSkills=true，只经
 * additionalSkillPaths 定向加载白名单 Skill —— 本模块把「第三方包已安装的 Skills」
 * 解析成可白名单加载的 SKILL.md 路径列表，供编排层按需接入（如研发/编排类会话）。
 *
 * 约定：Pi 包 skills 目录结构为 `<pkg>/skills/<skill-name>/SKILL.md`
 * （部分包为 `<pkg>/dist/skills/...`），正文为带 frontmatter 的 SKILL.md。
 *
 * 注意：
 * - 包未安装或目录缺失时返回空数组（调用方回退自身 Skill 路径）；
 * - 仅解析路径，不自动加载 —— 是否授权给某次会话仍由编排层决定；
 * - 包内 Skill 往往描述其自身扩展工具（spawn/registry 等），在服务端会话中
 *   若未接入对应扩展，模型会看到「不存在工具」的指令，需由编排层判断适用性。
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

export interface ExternalSkillPathsOptions {
  /** 包内技能目录候选（按顺序尝试） */
  skillDirs?: string[]
  /** 解析 require 的锚点目录（默认 process.cwd()） */
  requireFrom?: string
}

/**
 * 解析已安装 Pi 包的全部 SKILL.md 路径（按路径排序，确定性输出）。
 *
 * @returns 文件路径数组；包未安装 / 无 skills 目录时返回 []
 */
export function resolveExternalSkillPaths(
  packageName: string,
  options: ExternalSkillPathsOptions = {},
): string[] {
  const skillDirs = options.skillDirs ?? ['skills', 'dist/skills']
  const requireFrom = options.requireFrom ?? process.cwd()

  let packageRoot: string
  try {
    const localRequire = createRequire(join(requireFrom, 'noop.js'))
    packageRoot = dirname(localRequire.resolve(`${packageName}/package.json`))
  } catch {
    return []
  }

  const paths: string[] = []
  for (const dir of skillDirs) {
    const base = join(packageRoot, dir)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillMd = join(base, entry.name, 'SKILL.md')
      if (existsSync(skillMd)) paths.push(skillMd)
    }
    // 优先使用第一个命中的目录（如源码 skills/），避免 dist/skills 镜像重复
    if (paths.length > 0) break
  }
  return paths.sort()
}

/** 返回 SKILL.md 所在目录（可作为 skill_read 的授权根目录）。 */
export function skillRootOf(skillFilePath: string): string {
  return dirname(skillFilePath)
}
