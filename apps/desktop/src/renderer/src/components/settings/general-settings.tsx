import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { SunIcon, MoonIcon, LanguagesIcon, DatabaseIcon, FolderIcon } from 'lucide-react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

// ── 类型定义 ──

type Theme = 'light' | 'dark'
type Language = 'zh' | 'en'

interface GeneralSettingsState {
  theme: Theme
  language: Language
}

// ── 常量 ──

const themeStorageKey = 'pi-agent.theme'
const languageStorageKey = 'pi-agent.language'

// ── 主组件 ──

export function GeneralSettings(): ReactElement {
  const [settings, setSettings] = useState<GeneralSettingsState>(() => loadSettings())

  // 同步主题到 document.documentElement
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme)
  }, [settings.theme])

  // 持久化设置
  useEffect(() => {
    saveString(themeStorageKey, settings.theme)
  }, [settings.theme])

  useEffect(() => {
    saveString(languageStorageKey, settings.language)
  }, [settings.language])

  function updateTheme(value: string): void {
    setSettings((prev) => ({ ...prev, theme: value as Theme }))
  }

  function updateLanguage(value: string): void {
    setSettings((prev) => ({ ...prev, language: value as Language }))
  }

  return (
    <section className="p-6 grid gap-5" aria-label="通用设置">
      <div>
        <p className="text-subtle text-xs font-[760] m-0">General</p>
        <h2 className="text-[22px] font-[780] leading-tight mt-0.5">通用设置</h2>
      </div>

      {/* ── 主题切换 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2">
        <div className="flex items-center gap-2">
          <SunIcon className="size-4 text-muted" />
          <Label htmlFor="theme-select">主题</Label>
        </div>
        <Select value={settings.theme} onValueChange={updateTheme}>
          <SelectTrigger id="theme-select" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dark">
              <span className="flex items-center gap-2">
                <MoonIcon className="size-3.5" />
                深色
              </span>
            </SelectItem>
            <SelectItem value="light">
              <span className="flex items-center gap-2">
                <SunIcon className="size-3.5" />
                浅色
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted m-0">切换应用主题（当前仅深色完整支持）。</p>
      </div>

      {/* ── 语言切换 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2">
        <div className="flex items-center gap-2">
          <LanguagesIcon className="size-4 text-muted" />
          <Label htmlFor="language-select">语言</Label>
        </div>
        <Select value={settings.language} onValueChange={updateLanguage}>
          <SelectTrigger id="language-select" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh">中文</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted m-0">界面语言切换（部分内容可能仍为中文）。</p>
      </div>

      {/* ── 数据目录 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2">
        <div className="flex items-center gap-2">
          <DatabaseIcon className="size-4 text-muted" />
          <Label>数据目录（PI_DATA_DIR）</Label>
        </div>
        <code className="text-xs font-mono text-muted bg-surface-3 rounded-md px-2.5 py-2 break-all">
          {getDataDir()}
        </code>
        <p className="text-xs text-muted m-0">Pi SDK 数据存储目录，包含凭证、模型注册表和会话记录。</p>
      </div>

      {/* ── 工作目录 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-muted" />
          <Label>工作目录（PI_CWD）</Label>
        </div>
        <code className="text-xs font-mono text-muted bg-surface-3 rounded-md px-2.5 py-2 break-all">
          {getWorkDir()}
        </code>
        <p className="text-xs text-muted m-0">Agent 执行工具时的工作目录。</p>
      </div>
    </section>
  )
}

// ── 工具函数 ──

function loadSettings(): GeneralSettingsState {
  return {
    theme: (loadString(themeStorageKey) as Theme) ?? 'dark',
    language: (loadString(languageStorageKey) as Language) ?? 'zh'
  }
}

function loadString(key: string): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(key)
}

function saveString(key: string, value: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, value)
}

function getDataDir(): string {
  // 渲染进程无法直接读取后端环境变量，显示默认路径占位
  return '~/.pi（默认，由后端 PI_DATA_DIR 决定）'
}

function getWorkDir(): string {
  return '当前进程目录（由后端 PI_CWD 决定）'
}
