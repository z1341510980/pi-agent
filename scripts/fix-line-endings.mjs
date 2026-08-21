#!/usr/bin/env node
/**
 * 批量统一行尾为 LF（CRLF → LF）
 *
 * 背景：Windows 上 core.autocrlf=true 会把检出文件转成 CRLF，
 * 而 .prettierrc.yaml 要求 endOfLine: lf，导致全量 `Delete ␍` lint 告警。
 * 配合仓库根目录的 .gitattributes（* text=auto eol=lf）使用：
 *   - 本脚本一次性转换现有工作区文件（只处理 git 跟踪的文本文件）
 *   - .gitattributes 保证之后重新检出也不会再变回 CRLF
 *
 * 用法：node scripts/fix-line-endings.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// 这些格式在 Windows 下依赖 CRLF，保持原样
const KEEP_CRLF = /\.(bat|cmd)$/i

/** 只列 git 跟踪的文件：自动遵守 .gitignore，不会误伤 node_modules / 构建产物 */
function listTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString()
    .split('\0')
    .filter(Boolean)
}

let converted = 0
let binary = 0

for (const rel of listTrackedFiles()) {
  if (KEEP_CRLF.test(rel)) continue
  let buf
  try {
    buf = readFileSync(`${root}${rel}`)
  } catch {
    continue // 删除未提交等边缘情况，跳过
  }
  // 含 NUL 字节视为二进制，跳过
  if (buf.includes(0)) {
    binary++
    continue
  }
  const text = buf.toString('utf8')
  if (!text.includes('\r\n')) continue
  writeFileSync(`${root}${rel}`, text.replace(/\r\n/g, '\n'))
  converted++
}

console.log(`已转换 CRLF -> LF：${converted} 个文件`)
console.log(`跳过二进制：${binary} 个文件`)
