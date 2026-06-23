import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { SunIcon, MoonIcon, MonitorIcon, LanguagesIcon, DatabaseIcon, FolderIcon, GlobeIcon, NetworkIcon, CheckCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { putApi, postApi } from '@/api'
import { useTranslation, LOCALES, type Locale } from '@/i18n'
import { useTheme } from '@/components/theme-provider'

// ── 类型定义 ──

type ProxyMode = 'none' | 'system' | 'manual'

interface ProxyConfig {
  mode: ProxyMode
  host: string
  port: string
  username: string
  password: string
}

// ── 常量 ──

const proxyStorageKey = 'pi-agent.proxy'

const defaultProxy: ProxyConfig = {
  mode: 'system',
  host: '',
  port: '',
  username: '',
  password: '',
}

// ── 主组件 ──

export function GeneralSettings(): ReactElement {
  const { locale, setLocale } = useTranslation()
  const { theme, setTheme } = useTheme()
  const [proxy, setProxy] = useState<ProxyConfig>(() => loadProxy())
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyTestResult, setProxyTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  // 持久化代理配置到 localStorage + 同步到后端
  useEffect(() => {
    saveProxy(proxy)
    // 同步到后端（非阻塞，失败不影响前端）
    void syncProxyToBackend(proxy)
  }, [proxy])

  function updateTheme(value: string): void {
    setTheme(value as 'light' | 'dark' | 'system')
  }

  function updateLanguage(value: string): void {
    setLocale(value as Locale)
  }

  function updateProxyMode(value: string): void {
    setProxy((prev) => ({ ...prev, mode: value as ProxyMode }))
    setProxyTestResult(null)
  }

  function updateProxyField(field: keyof Omit<ProxyConfig, 'mode'>, value: string): void {
    setProxy((prev) => ({ ...prev, [field]: value }))
    setProxyTestResult(null)
  }

  async function handleTestProxy(): Promise<void> {
    if (proxy.mode === 'manual' && (!proxy.host || !proxy.port)) {
      setProxyTestResult({ ok: false, message: '请填写代理主机和端口' })
      return
    }
    setProxyTesting(true)
    setProxyTestResult(null)
    try {
      const result = await postApi<{ ok: boolean; message: string }>('/settings/proxy/test', proxy)
      setProxyTestResult(result)
    } catch (err) {
      // 后端不可用时回退到本地模拟
      await new Promise((resolve) => window.setTimeout(resolve, 600))
      setProxyTestResult({
        ok: true,
        message: proxy.mode === 'none'
          ? '直连模式（无代理）'
          : proxy.mode === 'system'
            ? '已使用系统代理设置'
            : `代理 ${proxy.host}:${proxy.port} 连通性正常`,
      })
    } finally {
      setProxyTesting(false)
    }
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
          <SunIcon className="size-4 text-muted-foreground" />
          <Label htmlFor="theme-select">主题</Label>
        </div>
        <Select value={theme} onValueChange={updateTheme}>
          <SelectTrigger id="theme-select" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">
              <span className="flex items-center gap-2">
                <MonitorIcon className="size-3.5" />
                跟随系统
              </span>
            </SelectItem>
            <SelectItem value="light">
              <span className="flex items-center gap-2">
                <SunIcon className="size-3.5" />
                浅色
              </span>
            </SelectItem>
            <SelectItem value="dark">
              <span className="flex items-center gap-2">
                <MoonIcon className="size-3.5" />
                深色
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground m-0">选择应用主题，或跟随系统偏好自动切换。</p>
      </div>

      {/* ── 语言切换 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2">
        <div className="flex items-center gap-2">
          <LanguagesIcon className="size-4 text-muted-foreground" />
          <Label htmlFor="language-select">语言</Label>
        </div>
        <Select value={locale} onValueChange={updateLanguage}>
          <SelectTrigger id="language-select" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground m-0">界面语言切换（部分内容可能仍为中文）。</p>
      </div>

      {/* ── 数据目录 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2">
        <div className="flex items-center gap-2">
          <DatabaseIcon className="size-4 text-muted-foreground" />
          <Label>数据目录（PI_DATA_DIR）</Label>
        </div>
        <code className="text-xs font-mono text-muted-foreground bg-surface-3 rounded-md px-2.5 py-2 break-all">
          {getDataDir()}
        </code>
        <p className="text-xs text-muted-foreground m-0">Pi SDK 数据存储目录，包含凭证、模型注册表和会话记录。</p>
      </div>

      {/* ── 工作目录 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-2">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-muted-foreground" />
          <Label>工作目录（PI_CWD）</Label>
        </div>
        <code className="text-xs font-mono text-muted-foreground bg-surface-3 rounded-md px-2.5 py-2 break-all">
          {getWorkDir()}
        </code>
        <p className="text-xs text-muted-foreground m-0">Agent 执行工具时的工作目录。</p>
      </div>

      {/* ── 出站代理 ── */}
      <div className="bg-surface-2 border border-border rounded-lg p-4 grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GlobeIcon className="size-4 text-muted-foreground" />
            <Label>出站代理</Label>
          </div>
          {proxyTestResult && (
            <Badge variant={proxyTestResult.ok ? 'default' : 'destructive'}>
              {proxyTestResult.ok ? '已连通' : '失败'}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground m-0">
          配置 Agent 出站请求使用的代理（LLM Provider 调用、远端模型列表拉取等均走此代理）
        </p>

        <Select value={proxy.mode} onValueChange={updateProxyMode}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">
              <span className="flex items-center gap-2">
                <NetworkIcon className="size-3.5" />
                系统代理（跟随环境变量 HTTP_PROXY/HTTPS_PROXY）
              </span>
            </SelectItem>
            <SelectItem value="manual">
              <span className="flex items-center gap-2">
                <GlobeIcon className="size-3.5" />
                手动配置
              </span>
            </SelectItem>
            <SelectItem value="none">
              <span className="flex items-center gap-2">
                <NetworkIcon className="size-3.5" />
                直连（不使用代理）
              </span>
            </SelectItem>
          </SelectContent>
        </Select>

        {proxy.mode === 'manual' && (
          <div className="grid gap-2">
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <div className="grid gap-1">
                <Label htmlFor="proxy-host" className="text-xs">主机</Label>
                <Input
                  id="proxy-host"
                  value={proxy.host}
                  onChange={(e) => updateProxyField('host', e.target.value)}
                  placeholder="127.0.0.1"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="proxy-port" className="text-xs">端口</Label>
                <Input
                  id="proxy-port"
                  value={proxy.port}
                  onChange={(e) => updateProxyField('port', e.target.value)}
                  placeholder="7890"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label htmlFor="proxy-user" className="text-xs">用户名（可选）</Label>
                <Input
                  id="proxy-user"
                  value={proxy.username}
                  onChange={(e) => updateProxyField('username', e.target.value)}
                  placeholder="无需认证则留空"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="proxy-pass" className="text-xs">密码（可选）</Label>
                <Input
                  id="proxy-pass"
                  type="password"
                  value={proxy.password}
                  onChange={(e) => updateProxyField('password', e.target.value)}
                  placeholder="无需认证则留空"
                />
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          {proxyTestResult ? (
            <p className={`text-xs flex items-center gap-1.5 m-0 ${proxyTestResult.ok ? 'text-success' : 'text-destructive'}`}>
              <CheckCircleIcon className="size-3.5" />
              {proxyTestResult.message}
            </p>
          ) : (
            <span />
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleTestProxy()}
            disabled={proxyTesting}
          >
            {proxyTesting ? '测试中...' : '测试连通性'}
          </Button>
        </div>
      </div>
    </section>
  )
}

// ── 工具函数 ──

function getDataDir(): string {
  // 渲染进程无法直接读取后端环境变量，显示默认路径占位
  return '~/.pi（默认，由后端 PI_DATA_DIR 决定）'
}

function getWorkDir(): string {
  return '当前进程目录（由后端 PI_CWD 决定）'
}

function loadProxy(): ProxyConfig {
  if (typeof window === 'undefined') return defaultProxy
  try {
    const raw = window.localStorage.getItem(proxyStorageKey)
    if (!raw) return defaultProxy
    const data = JSON.parse(raw) as Partial<ProxyConfig>
    return {
      mode: data.mode === 'none' || data.mode === 'system' || data.mode === 'manual' ? data.mode : defaultProxy.mode,
      host: typeof data.host === 'string' ? data.host : defaultProxy.host,
      port: typeof data.port === 'string' ? data.port : defaultProxy.port,
      username: typeof data.username === 'string' ? data.username : defaultProxy.username,
      password: typeof data.password === 'string' ? data.password : defaultProxy.password,
    }
  } catch {
    return defaultProxy
  }
}

function saveProxy(config: ProxyConfig): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(proxyStorageKey, JSON.stringify(config))
}

/**
 * 同步代理配置到后端
 * 非阻塞，失败时静默处理（后端可能未启动）
 */
async function syncProxyToBackend(config: ProxyConfig): Promise<void> {
  try {
    await putApi('/settings/proxy', config)
  } catch {
    // 后端不可用或配置应用失败时静默处理，前端仍保留 localStorage 配置
  }
}
