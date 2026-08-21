/**
 * 路径包含性判定（插件系统的共用安全谓词）。
 *
 * 为什么单独成模块：这个判定出现在两处安全边界上 —— npm 插件必须落在
 * node_modules 内、插件文件必须落在自身 dataDir 内。两处原先各写一遍，
 * 其中 npm 那处把分隔符硬编码成 '\\'，导致判定在 posix 上恒为"逃逸"，
 * 所有合法 npm 插件都被拒绝加载。而在 Windows 上跑测试又看不出问题。
 *
 * 收口成纯函数后可以用两种分隔符的字面量路径直接单测，不依赖运行平台。
 *
 * @module core/plugin/path-guard
 */

import { isAbsolute, relative, resolve } from 'node:path'

/**
 * child 是否严格位于 parent 内部。
 *
 * 严格：`parent` 自身不算"在内部"（返回 false）。这样调用方不会把
 * "恰好指向根目录"当成合法子路径。
 *
 * 判定用 `relative()` 而不是字符串前缀比较：前者由 node 按当前平台的
 * 分隔符规则计算，不需要调用方拼接 '/' 或 '\\'。
 */
export function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  if (rel === '') return false
  if (rel.startsWith('..')) return false
  // 盘符不同时 relative 会返回绝对路径（Windows: C:\ vs D:\）
  if (isAbsolute(rel)) return false
  return true
}

/**
 * 把若干片段解析到 base 之内，越界抛错。
 *
 * @param base 允许的根目录（绝对路径）
 * @param segments 相对片段
 * @param describe 抛错信息的构造器，便于各调用点给出领域化文案
 */
export function resolveWithin(
  base: string,
  segments: string[],
  describe: (attempted: string) => string
): string {
  const target = resolve(base, ...segments)
  if (target !== base && !isInsideDir(base, target)) {
    throw new Error(describe(segments.join('/')))
  }
  return target
}
