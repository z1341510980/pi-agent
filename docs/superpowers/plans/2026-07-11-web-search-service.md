# 联网搜索服务 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 pi-agent 的小说创作 AI 提供 `web_search` 工具，基于 SearXNG 元搜索 + readability 正文提取，通过 customTools 注入 pi-session。

**架构：** 新建内置插件 `web-search-plugin`，包含 searxng-client / content-fetcher / content-extractor / search-service 四个内聚模块。插件通过 `registerSessionTools` 注入 `web_search` 工具。SearXNG 容器通过 docker-compose.yml 在项目根目录一键启动。

**技术栈：** TypeScript / Fastify / undici（已有）/ @mozilla/readability + turndown + jsdom（新增）/ SearXNG Docker 镜像 / vitest（已有）

**规格：** [2026-07-11-web-search-service-design.md](../specs/2026-07-11-web-search-service-design.md)

---

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `docker-compose.yml` | SearXNG 容器编排 | 创建（项目根） |
| `searxng-settings.yml` | SearXNG 配置（启用 JSON、引擎） | 创建（项目根） |
| `apps/agent-server/src/plugins/web-search-plugin/types.ts` | 类型定义 | 创建 |
| `apps/agent-server/src/plugins/web-search-plugin/searxng-client.ts` | 调用 SearXNG /search API | 创建 |
| `apps/agent-server/src/plugins/web-search-plugin/content-fetcher.ts` | undici 抓取网页 HTML | 创建 |
| `apps/agent-server/src/plugins/web-search-plugin/content-extractor.ts` | readability + turndown 转 Markdown | 创建 |
| `apps/agent-server/src/plugins/web-search-plugin/search-service.ts` | 编排：搜→抓→清洗→汇总 | 创建 |
| `apps/agent-server/src/plugins/web-search-plugin/index.ts` | 插件入口，registerSessionTools | 创建 |
| `apps/agent-server/src/plugins/web-search-plugin/__tests__/content-extractor.test.ts` | 正文提取单测 | 创建 |
| `apps/agent-server/src/plugins/web-search-plugin/__tests__/searxng-client.test.ts` | SearXNG 客户端单测 | 创建 |
| `apps/agent-server/src/plugins/web-search-plugin/__tests__/search-service.test.ts` | 编排服务单测 | 创建 |
| `apps/agent-server/src/routes/search.route.ts` | GET /api/search 调试端点 | 创建 |
| `apps/agent-server/src/app.ts` | 注册 searchRoute | 修改 |
| `apps/agent-server/src/plugins/plugin-loader.plugin.ts` | 注册 web-search 内置插件 | 修改 |
| `apps/agent-server/.env.example` | 新增搜索配置 | 修改 |
| `apps/agent-server/package.json` | 新增依赖 | 修改 |

---

### 任务 1：Docker Compose + SearXNG 配置

**文件：**
- 创建：`docker-compose.yml`
- 创建：`searxng-settings.yml`

- [ ] **步骤 1：创建 docker-compose.yml**

```yaml
# docker-compose.yml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: pi-searxng
    ports:
      - "8888:8080"
    volumes:
      - ./searxng-settings.yml:/etc/searxng/settings.yml:ro
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/
    restart: unless-stopped
```

- [ ] **步骤 2：创建 searxng-settings.yml**

```yaml
# searxng-settings.yml
use_default_settings: true

search:
  formats:
    - html
    - json

server:
  secret_key: "pi-agent-local-dev-secret-change-me"
  bind_address: "0.0.0.0"
  port: 8080

engines:
  - name: google
    engine: google
    shortcut: g
    disabled: false
  - name: bing
    engine: bing
    shortcut: b
    disabled: false
  - name: baidu
    engine: baidu
    shortcut: bd
    disabled: false
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
    disabled: false
  - name: wikipedia
    engine: wikipedia
    shortcut: wp
    disabled: false

outgoing:
  request_timeout: 10
```

- [ ] **步骤 3：启动 SearXNG 验证**

运行：`docker compose up -d`
预期：容器启动，`curl "http://localhost:8888/search?q=test&format=json"` 返回 JSON

- [ ] **步骤 4：Commit**

```bash
git add docker-compose.yml searxng-settings.yml
git commit -m "feat: 添加 SearXNG docker-compose 配置"
```

---

### 任务 2：安装依赖

**文件：**
- 修改：`apps/agent-server/package.json`

- [ ] **步骤 1：安装依赖**

运行（在 `apps/agent-server/` 目录）：
```bash
pnpm add @mozilla/readability turndown jsdom
pnpm add -D @types/turndown
```

- [ ] **步骤 2：验证 package.json**

运行：`cat apps/agent-server/package.json | grep -E "readability|turndown|jsdom"`
预期：三个包在 dependencies，`@types/turndown` 在 devDependencies

- [ ] **步骤 3：Commit**

```bash
git add apps/agent-server/package.json pnpm-lock.yaml
git commit -m "chore: 添加 web-search 插件依赖"
```

---

### 任务 3：类型定义

**文件：**
- 创建：`apps/agent-server/src/plugins/web-search-plugin/types.ts`

- [ ] **步骤 1：编写类型定义**

```ts
/**
 * 联网搜索服务类型定义
 */

/** SearXNG 单条搜索结果 */
export interface SearXngResult {
  title: string
  url: string
  /** SearXNG 返回的 content 字段（摘要） */
  snippet: string
  /** 来源引擎（google/bing/baidu/...） */
  engine: string
  publishedDate?: string
}

/** SearXNG 搜索选项 */
export interface SearXngSearchOptions {
  query: string
  maxResults?: number
  timeRange?: 'day' | 'week' | 'month' | 'year'
  categories?: string[]
}

/** URL 抓取结果 */
export interface FetchResult {
  ok: boolean
  html?: string
  /** 最终 URL（可能经过重定向） */
  url: string
  error?: string
  statusCode?: number
}

/** 正文提取结果 */
export interface ExtractionResult {
  ok: boolean
  title?: string
  content?: string
  error?: string
}

/** 搜索结果项（最终返回给 AI） */
export interface SearchResultItem {
  title: string
  url: string
  engine: string
  snippet: string
  /** Markdown 正文（截断到 maxContentChars） */
  content: string
  contentStatus: 'fetched' | 'fallback' | 'failed'
}

/** 搜索响应 */
export interface SearchResponse {
  ok: boolean
  results: SearchResultItem[]
  total: number
  error?: string
}

/** 搜索服务配置 */
export interface SearchServiceOptions {
  searxngUrl: string
  maxResults: number
  fetchTimeoutMs: number
  maxContentChars: number
  concurrency: number
}

/** web_search 工具入参 */
export interface WebSearchArgs {
  query: string
  max_results?: number
  time_range?: 'day' | 'week' | 'month' | 'year'
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/agent-server/src/plugins/web-search-plugin/types.ts
git commit -m "feat: 添加 web-search-plugin 类型定义"
```

---

### 任务 4：SearXNG 客户端（TDD）

**文件：**
- 创建：`apps/agent-server/src/plugins/web-search-plugin/searxng-client.ts`
- 测试：`apps/agent-server/src/plugins/web-search-plugin/__tests__/searxng-client.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
// __tests__/searxng-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { searchSearXng, SearXngError } from '../searxng-client.js'

// Mock undici
vi.mock('undici', () => ({
  request: vi.fn(),
}))

import { request } from 'undici'

describe('searchSearXng', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('正常返回结果列表', async () => {
    ;(request as any).mockResolvedValue({
      statusCode: 200,
      body: {
        json: async () => ({
          results: [
            {
              title: '宋代茶文化',
              url: 'https://example.com/tea',
              content: '宋代茶文化是...',
              engine: 'google',
              publishedDate: '2026-01-01',
            },
          ],
          number_of_results: 100,
        }),
      },
    })

    const results = await searchSearXng('http://localhost:8888', {
      query: '宋代茶文化',
      maxResults: 5,
    })

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('宋代茶文化')
    expect(results[0].url).toBe('https://example.com/tea')
    expect(results[0].snippet).toBe('宋代茶文化是...')
    expect(results[0].engine).toBe('google')
  })

  it('拼接查询参数正确', async () => {
    ;(request as any).mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ results: [], number_of_results: 0 }) },
    })

    await searchSearXng('http://localhost:8888', {
      query: 'hello world',
      maxResults: 3,
      timeRange: 'month',
      categories: ['news'],
    })

    const callArgs = (request as any).mock.calls[0][0]
    const url = new URL(callArgs.url)
    expect(url.searchParams.get('q')).toBe('hello world')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('time_range')).toBe('month')
    expect(url.searchParams.get('categories')).toBe('news')
  })

  it('HTTP 非 200 抛 SearXngError', async () => {
    ;(request as any).mockResolvedValue({
      statusCode: 503,
      body: { text: async () => 'Service Unavailable' },
    })

    await expect(
      searchSearXng('http://localhost:8888', { query: 'test' }),
    ).rejects.toThrow(SearXngError)
  })

  it('连接失败抛 SearXngError', async () => {
    ;(request as any).mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(
      searchSearXng('http://localhost:8888', { query: 'test' }),
    ).rejects.toThrow(SearXngError)
  })

  it('空结果返回空数组', async () => {
    ;(request as any).mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ results: [], number_of_results: 0 }) },
    })

    const results = await searchSearXng('http://localhost:8888', {
      query: '不存在的内容',
    })
    expect(results).toEqual([])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && pnpm test -- --run src/plugins/web-search-plugin/__tests__/searxng-client.test.ts`
预期：FAIL，报错 `Cannot find module '../searxng-client.js'`

- [ ] **步骤 3：编写实现**

```ts
// searxng-client.ts
import { request } from 'undici'
import type { SearXngResult, SearXngSearchOptions } from './types.js'

/** SearXNG 调用错误 */
export class SearXngError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = 'SearXngError'
  }
}

/**
 * 调用 SearXNG /search API
 *
 * @param baseUrl SearXNG 实例地址，如 http://localhost:8888
 * @param options 搜索选项
 * @param signal 中止信号
 */
export async function searchSearXng(
  baseUrl: string,
  options: SearXngSearchOptions,
  signal?: AbortSignal,
): Promise<SearXngResult[]> {
  const url = new URL('/search', baseUrl)
  url.searchParams.set('q', options.query)
  url.searchParams.set('format', 'json')
  if (options.timeRange) {
    url.searchParams.set('time_range', options.timeRange)
  }
  if (options.categories && options.categories.length > 0) {
    url.searchParams.set('categories', options.categories.join(','))
  }

  let response
  try {
    response = await request(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal,
    })
  } catch (err) {
    throw new SearXngError(
      `SearXNG 不可达，请确认 ${baseUrl} 已启动（docker compose up）`,
      err,
    )
  }

  if (response.statusCode !== 200) {
    const text = await response.body.text()
    throw new SearXngError(
      `SearXNG 返回 ${response.statusCode}: ${text}`,
    )
  }

  const body = (await response.body.json()) as {
    results: Array<{
      title: string
      url: string
      content?: string
      engine?: string
      publishedDate?: string
    }>
    number_of_results?: number
  }

  const max = options.maxResults ?? 5
  return body.results.slice(0, max).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? '',
    engine: r.engine ?? 'unknown',
    publishedDate: r.publishedDate,
  }))
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/agent-server && pnpm test -- --run src/plugins/web-search-plugin/__tests__/searxng-client.test.ts`
预期：PASS，5 个测试全过

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/plugins/web-search-plugin/searxng-client.ts apps/agent-server/src/plugins/web-search-plugin/__tests__/searxng-client.test.ts
git commit -m "feat: 添加 SearXNG 客户端"
```

---

### 任务 5：内容抓取器（content-fetcher）

**文件：**
- 创建：`apps/agent-server/src/plugins/web-search-plugin/content-fetcher.ts`

- [ ] **步骤 1：编写实现**

```ts
// content-fetcher.ts
import { request } from 'undici'
import type { FetchResult } from './types.js'

const USER_AGENT =
  'Mozilla/5.0 (compatible; PiAgent/1.0; +https://pi-agent.local)'

/** 响应体大小上限：5MB */
const MAX_BODY_LENGTH = 5 * 1024 * 1024

/**
 * 用 undici 抓取目标 URL 的 HTML
 *
 * @param url 目标 URL
 * @param options.timeoutMs 超时毫秒（默认 8000）
 * @param signal 外部中止信号
 */
export async function fetchUrl(
  url: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<FetchResult> {
  const timeoutMs = options?.timeoutMs ?? 8000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  // 外部 signal 触发时也中止内部
  const onExternalAbort = () => controller.abort()
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    const response = await request(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      maxRedirections: 3,
      signal: controller.signal,
    })

    if (response.statusCode !== 200) {
      return {
        ok: false,
        url,
        statusCode: response.statusCode,
        error: `HTTP ${response.statusCode}`,
      }
    }

    // 限制响应体大小，读前 5MB
    const chunks: Buffer[] = []
    let totalLength = 0
    for await (const chunk of response.body) {
      totalLength += chunk.length
      if (totalLength > MAX_BODY_LENGTH) {
        break
      }
      chunks.push(chunk as Buffer)
    }

    const html = Buffer.concat(chunks).toString('utf-8')

    return {
      ok: true,
      html,
      url,
      statusCode: response.statusCode,
    }
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      url,
      error: isTimeout ? `抓取超时（${timeoutMs}ms）` : (err as Error).message,
    }
  } finally {
    clearTimeout(timeout)
    options?.signal?.removeEventListener('abort', onExternalAbort)
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add apps/agent-server/src/plugins/web-search-plugin/content-fetcher.ts
git commit -m "feat: 添加网页抓取器 content-fetcher"
```

---

### 任务 6：正文提取器（TDD）

**文件：**
- 创建：`apps/agent-server/src/plugins/web-search-plugin/content-extractor.ts`
- 测试：`apps/agent-server/src/plugins/web-search-plugin/__tests__/content-extractor.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
// __tests__/content-extractor.test.ts
import { describe, it, expect } from 'vitest'
import { extractContent } from '../content-extractor.js'

const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>宋代茶文化 - 维基百科</title>
  <meta charset="utf-8">
</head>
<body>
  <nav><a href="/">首页</a> | <a href="/about">关于</a></nav>
  <header><h1>网站标题</h1></header>
  <main>
    <article>
      <h1>宋代茶文化</h1>
      <p>宋代是中国茶文化发展的鼎盛时期。点茶法在此时盛行，影响深远。</p>
      <p>宋徽宗赵佶著有《大观茶论》，详细记载了点茶技艺。</p>
      <p>斗茶是宋代流行的茶艺竞技活动，通过比拼茶汤色泽和咬盏情况评判优劣。</p>
    </article>
  </main>
  <footer>版权所有 © 2026</footer>
  <script>console.log('tracking')</script>
</body>
</html>
`

describe('extractContent', () => {
  it('从 HTML 提取正文并转 Markdown', async () => {
    const result = await extractContent(SAMPLE_HTML, 'https://example.com/tea')

    expect(result.ok).toBe(true)
    expect(result.title).toContain('宋代茶文化')
    // 正文应包含关键段落
    expect(result.content).toContain('点茶法')
    expect(result.content).toContain('大观茶论')
    expect(result.content).toContain('斗茶')
    // 不应包含 nav/footer 内容
    expect(result.content).not.toContain('首页')
    expect(result.content).not.toContain('版权所有')
    expect(result.content).not.toContain('tracking')
  })

  it('正文应为 Markdown 格式（包含标题或段落）', async () => {
    const result = await extractContent(SAMPLE_HTML, 'https://example.com/tea')
    expect(result.ok).toBe(true)
    // Markdown 标题或段落
    expect(result.content).toMatch(/^(#|宋)/m)
  })

  it('空 HTML 返回 ok:false', async () => {
    const result = await extractContent('', 'https://example.com')
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('无正文的页面返回 ok:false', async () => {
    const html = '<html><head><title>x</title></head><body></body></html>'
    const result = await extractContent(html, 'https://example.com')
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && pnpm test -- --run src/plugins/web-search-plugin/__tests__/content-extractor.test.ts`
预期：FAIL，报错 `Cannot find module '../content-extractor.js'`

- [ ] **步骤 3：编写实现**

```ts
// content-extractor.ts
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import type { ExtractionResult } from './types.js'

// Turndown 单例（避免重复创建）
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

// 移除脚本和样式（readability 不总是清理这些）
turndown.remove(['script', 'style', 'nav', 'footer', 'aside'])

/**
 * 从 HTML 提取正文并转 Markdown
 *
 * 使用 @mozilla/readability（Firefox Reader View 同款算法）提取正文，
 * 再用 turndown 转为 Markdown。
 *
 * @param html 原始 HTML
 * @param url 页面 URL（用于解析相对链接）
 */
export async function extractContent(
  html: string,
  url: string,
): Promise<ExtractionResult> {
  if (!html || html.trim().length === 0) {
    return { ok: false, error: 'HTML 内容为空' }
  }

  try {
    const dom = new JSDOM(html, { url })
    const reader = new Readability(dom.window.document)
    const article = reader.parse()

    if (!article || !article.content) {
      return { ok: false, error: '无法提取正文（可能是 JS 渲染页或无内容）' }
    }

    const markdown = turndown.turndown(article.content)

    if (!markdown || markdown.trim().length === 0) {
      return { ok: false, error: '提取到的正文为空' }
    }

    return {
      ok: true,
      title: article.title,
      content: markdown,
    }
  } catch (err) {
    return {
      ok: false,
      error: `正文提取失败: ${(err as Error).message}`,
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/agent-server && pnpm test -- --run src/plugins/web-search-plugin/__tests__/content-extractor.test.ts`
预期：PASS，4 个测试全过

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/plugins/web-search-plugin/content-extractor.ts apps/agent-server/src/plugins/web-search-plugin/__tests__/content-extractor.test.ts
git commit -m "feat: 添加正文提取器 content-extractor"
```

---

### 任务 7：搜索编排服务（TDD）

**文件：**
- 创建：`apps/agent-server/src/plugins/web-search-plugin/search-service.ts`
- 测试：`apps/agent-server/src/plugins/web-search-plugin/__tests__/search-service.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
// __tests__/search-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { search } from '../search-service.js'

// Mock searxng-client
vi.mock('../searxng-client.js', () => ({
  searchSearXng: vi.fn(),
  SearXngError: class SearXngError extends Error {},
}))

// Mock content-fetcher
vi.mock('../content-fetcher.js', () => ({
  fetchUrl: vi.fn(),
}))

// Mock content-extractor
vi.mock('../content-extractor.js', () => ({
  extractContent: vi.fn(),
}))

import { searchSearXng, SearXngError } from '../searxng-client.js'
import { fetchUrl } from '../content-fetcher.js'
import { extractContent } from '../content-extractor.js'

const OPTIONS = {
  searxngUrl: 'http://localhost:8888',
  maxResults: 2,
  fetchTimeoutMs: 5000,
  maxContentChars: 200,
  concurrency: 2,
}

describe('search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('完整流程：搜索→抓取→提取→汇总', async () => {
    ;(searchSearXng as any).mockResolvedValue([
      { title: '文章A', url: 'https://a.com', snippet: '摘要A', engine: 'google' },
      { title: '文章B', url: 'https://b.com', snippet: '摘要B', engine: 'bing' },
    ])
    ;(fetchUrl as any).mockImplementation(async (url: string) => ({
      ok: true,
      html: `<html><body><article><p>${url} 正文</p></article></body></html>`,
      url,
      statusCode: 200,
    }))
    ;(extractContent as any).mockImplementation(async (html: string) => ({
      ok: true,
      title: '提取标题',
      content: '# 提取标题\n\n这是正文内容',
    }))

    const result = await search('茶文化', OPTIONS)

    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.results[0].title).toBe('文章A')
    expect(result.results[0].contentStatus).toBe('fetched')
    expect(result.results[0].content).toContain('正文内容')
  })

  it('抓取失败时回退到 snippet', async () => {
    ;(searchSearXng as any).mockResolvedValue([
      { title: '文章A', url: 'https://a.com', snippet: '摘要A', engine: 'google' },
    ])
    ;(fetchUrl as any).mockResolvedValue({
      ok: false,
      url: 'https://a.com',
      error: '超时',
    })

    const result = await search('茶文化', OPTIONS)

    expect(result.ok).toBe(true)
    expect(result.results[0].contentStatus).toBe('fallback')
    expect(result.results[0].content).toBe('摘要A')
  })

  it('提取失败时回退到 snippet', async () => {
    ;(searchSearXng as any).mockResolvedValue([
      { title: '文章A', url: 'https://a.com', snippet: '摘要A', engine: 'google' },
    ])
    ;(fetchUrl as any).mockResolvedValue({
      ok: true,
      html: '<html></html>',
      url: 'https://a.com',
    })
    ;(extractContent as any).mockResolvedValue({
      ok: false,
      error: '无法提取',
    })

    const result = await search('茶文化', OPTIONS)

    expect(result.results[0].contentStatus).toBe('fallback')
    expect(result.results[0].content).toBe('摘要A')
  })

  it('SearXNG 错误返回 ok:false', async () => {
    ;(searchSearXng as any).mockRejectedValue(
      new SearXngError('SearXNG 不可达'),
    )

    const result = await search('茶文化', OPTIONS)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('SearXNG 不可达')
    expect(result.results).toEqual([])
  })

  it '正文超过 maxContentChars 时截断', async () => {
    const longContent = 'A'.repeat(500)
    ;(searchSearXng as any).mockResolvedValue([
      { title: '文章A', url: 'https://a.com', snippet: '摘要', engine: 'google' },
    ])
    ;(fetchUrl as any).mockResolvedValue({
      ok: true,
      html: '<html></html>',
      url: 'https://a.com',
    })
    ;(extractContent as any).mockResolvedValue({
      ok: true,
      title: '标题',
      content: longContent,
    })

    const result = await search('茶文化', { ...OPTIONS, maxContentChars: 100 })

    expect(result.results[0].content.length).toBeLessThanOrEqual(103)
    expect(result.results[0].content.endsWith('...')).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/agent-server && pnpm test -- --run src/plugins/web-search-plugin/__tests__/search-service.test.ts`
预期：FAIL，报错 `Cannot find module '../search-service.js'`

- [ ] **步骤 3：编写实现**

```ts
// search-service.ts
import { searchSearXng, SearXngError } from './searxng-client.js'
import { fetchUrl } from './content-fetcher.js'
import { extractContent } from './content-extractor.js'
import type {
  SearchResponse,
  SearchResultItem,
  SearchServiceOptions,
} from './types.js'

/**
 * 联网搜索编排：搜索→抓取→清洗→汇总
 *
 * @param query 搜索查询
 * @param options 服务配置
 * @param signal 中止信号
 */
export async function search(
  query: string,
  options: SearchServiceOptions,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  // 1. 调 SearXNG 搜索
  let searxResults
  try {
    searxResults = await searchSearXng(
      options.searxngUrl,
      { query, maxResults: options.maxResults },
      signal,
    )
  } catch (err) {
    return {
      ok: false,
      results: [],
      total: 0,
      error: err instanceof SearXngError
        ? err.message
        : `搜索失败: ${(err as Error).message}`,
    }
  }

  // 2. 并发抓取+提取
  const items: SearchResultItem[] = []
  // 简单分批并发：每批 concurrency 个
  for (let i = 0; i < searxResults.length; i += options.concurrency) {
    const batch = searxResults.slice(i, i + options.concurrency)
    const batchResults = await Promise.all(
      batch.map(async (r) => {
        const fetched = await fetchUrl(r.url, {
          timeoutMs: options.fetchTimeoutMs,
          signal,
        })

        let content = r.snippet
        let status: SearchResultItem['contentStatus'] = 'fallback'

        if (fetched.ok && fetched.html) {
          const extracted = await extractContent(fetched.html, r.url)
          if (extracted.ok && extracted.content) {
            content = extracted.content
            status = 'fetched'
          }
        } else if (!fetched.ok) {
          status = 'failed'
          content = r.snippet
        }

        // 截断
        if (content.length > options.maxContentChars) {
          content = content.slice(0, options.maxContentChars) + '...'
        }

        return {
          title: r.title,
          url: r.url,
          engine: r.engine,
          snippet: r.snippet,
          content,
          contentStatus: status,
        } satisfies SearchResultItem
      }),
    )
    items.push(...batchResults)
  }

  return {
    ok: true,
    results: items,
    total: searxResults.length,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/agent-server && pnpm test -- --run src/plugins/web-search-plugin/__tests__/search-service.test.ts`
预期：PASS，5 个测试全过

- [ ] **步骤 5：Commit**

```bash
git add apps/agent-server/src/plugins/web-search-plugin/search-service.ts apps/agent-server/src/plugins/web-search-plugin/__tests__/search-service.test.ts
git commit -m "feat: 添加搜索编排服务 search-service"
```

---

### 任务 8：插件入口

**文件：**
- 创建：`apps/agent-server/src/plugins/web-search-plugin/index.ts`

- [ ] **步骤 1：编写实现**

```ts
// index.ts
/**
 * 联网搜索插件
 *
 * 基于 SearXNG 元搜索 + readability 正文提取
 * 通过 registerSessionTools 注入 web_search 工具到 pi-session
 *
 * 依赖：
 * - SearXNG 容器（docker compose up 启动，默认 http://localhost:8888）
 * - 环境变量 SEARXNG_URL 覆盖默认地址
 */

import type { ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Plugin } from '../../core/plugin/plugin-types.js'
import { search } from './search-service.js'
import type { WebSearchArgs } from './types.js'

/** web_search 工具定义 */
const webSearchTool: PiToolDefinition = {
  name: 'web_search',
  description:
    '联网搜索最新信息。用于查证历史背景、地理、专业知识、时事等小说创作所需的真实世界信息。返回每条结果的标题、链接、摘要和正文（Markdown）。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询词' },
      max_results: {
        type: 'number',
        description: '返回并抓取正文的结果数（1-5）',
      },
      time_range: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: '时间范围过滤，不传则不限时间',
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, unknown>, ctx) {
    const input = args as unknown as WebSearchArgs
    const maxResults = Math.min(Math.max(input.max_results ?? 3, 1), 5)

    const result = await search(input.query, {
      searxngUrl: process.env.SEARXNG_URL ?? 'http://localhost:8888',
      maxResults,
      fetchTimeoutMs: Number(process.env.WEB_SEARCH_FETCH_TIMEOUT ?? 8000),
      maxContentChars: Number(process.env.WEB_SEARCH_MAX_CONTENT_CHARS ?? 2000),
      concurrency: Number(process.env.WEB_SEARCH_CONCURRENCY ?? 3),
    }, ctx.signal)

    return {
      ok: result.ok,
      data: result,
      error: result.error,
    }
  },
}

/** 创建联网搜索插件实例 */
export function createWebSearchPlugin(): Plugin {
  return {
    manifest: {
      name: 'web-search',
      version: '0.1.0',
      description: '联网搜索工具，基于 SearXNG 元搜索 + 正文提取',
      builtin: true,
    },

    setup(context) {
      context.registerSessionTools([webSearchTool])
    },
  }
}

export default createWebSearchPlugin
```

- [ ] **步骤 2：Commit**

```bash
git add apps/agent-server/src/plugins/web-search-plugin/index.ts
git commit -m "feat: 添加 web-search 插件入口"
```

---

### 任务 9：注册插件到 plugin-loader

**文件：**
- 修改：`apps/agent-server/src/plugins/plugin-loader.plugin.ts`

- [ ] **步骤 1：添加 import**

在 [plugin-loader.plugin.ts](../../../apps/agent-server/src/plugins/plugin-loader.plugin.ts) 第 23 行 `import { createNovelPlugin } from './novel-plugin/index.js'` 之后添加：

```ts
import { createWebSearchPlugin } from './web-search-plugin/index.js'
```

- [ ] **步骤 2：添加到 builtinPlugins 数组**

在 [plugin-loader.plugin.ts](../../../apps/agent-server/src/plugins/plugin-loader.plugin.ts) 第 41-44 行的 `builtinPlugins` 数组中添加 `createWebSearchPlugin()`：

```ts
  const builtinPlugins = [
    ...(enableExamples ? [{ plugin: createHelloPlugin() }] : []),
    { plugin: createNovelPlugin() },
    { plugin: createWebSearchPlugin() },
  ]
```

- [ ] **步骤 3：验证启动**

运行：`cd apps/agent-server && pnpm dev`
预期：服务启动，日志无报错，插件加载

- [ ] **步骤 4：Commit**

```bash
git add apps/agent-server/src/plugins/plugin-loader.plugin.ts
git commit -m "feat: 注册 web-search 内置插件"
```

---

### 任务 10：调试端点 search.route.ts

**文件：**
- 创建：`apps/agent-server/src/routes/search.route.ts`
- 修改：`apps/agent-server/src/app.ts`

- [ ] **步骤 1：编写路由**

```ts
// routes/search.route.ts
import type { FastifyPluginAsync } from 'fastify'
import { success, failure } from '../lib/api-response.js'
import { ErrorCode } from '@repo/shared/errors'
import { search } from '../plugins/web-search-plugin/search-service.js'

export const searchRoute: FastifyPluginAsync = async (app) => {
  // GET /api/search?q={query}&max={n}
  app.get('/api/search', async (request, reply) => {
    const query = (request.query as { q?: string }).q
    if (!query) {
      reply.status(400)
      return failure(
        ErrorCode.VALIDATION_ERROR,
        '缺少查询参数 q',
        request.traceId,
      )
    }

    const maxResults = Math.min(
      Math.max(Number((request.query as { max?: string }).max ?? 3), 1),
      5,
    )

    const result = await search(query, {
      searxngUrl: process.env.SEARXNG_URL ?? 'http://localhost:8888',
      maxResults,
      fetchTimeoutMs: Number(process.env.WEB_SEARCH_FETCH_TIMEOUT ?? 8000),
      maxContentChars: Number(process.env.WEB_SEARCH_MAX_CONTENT_CHARS ?? 2000),
      concurrency: Number(process.env.WEB_SEARCH_CONCURRENCY ?? 3),
    })

    return success(result, request.traceId)
  })
}
```

- [ ] **步骤 2：在 app.ts 注册路由**

在 [app.ts](../../../apps/agent-server/src/app.ts) 第 33 行 `import { skillsRoute } from './routes/skills.route.js'` 之后添加：

```ts
import { searchRoute } from './routes/search.route.js'
```

在第 155 行 `await app.register(skillsRoute)` 之后添加：

```ts
  await app.register(searchRoute)
```

- [ ] **步骤 3：验证端点**

运行：`cd apps/agent-server && pnpm dev`
另开终端：`curl "http://127.0.0.1:3900/api/search?q=test"`
预期：返回 JSON，含 `ok: true` 和 `results` 字段（需 SearXNG 已启动）

- [ ] **步骤 4：Commit**

```bash
git add apps/agent-server/src/routes/search.route.ts apps/agent-server/src/app.ts
git commit -m "feat: 添加 /api/search 调试端点"
```

---

### 任务 11：环境变量模板

**文件：**
- 修改：`apps/agent-server/.env.example`

- [ ] **步骤 1：追加配置**

在 [.env.example](../../../apps/agent-server/.env.example) 末尾追加：

```bash

# ===== Web Search =====
# SearXNG 实例地址（docker compose up 后默认本地 8888）
SEARXNG_URL=http://localhost:8888
# 正文抓取超时（毫秒）
WEB_SEARCH_FETCH_TIMEOUT=8000
# 单次搜索抓取正文并发数
WEB_SEARCH_CONCURRENCY=3
# 正文截断字数
WEB_SEARCH_MAX_CONTENT_CHARS=2000
```

- [ ] **步骤 2：Commit**

```bash
git add apps/agent-server/.env.example
git commit -m "docs: 添加 web-search 环境变量模板"
```

---

### 任务 12：全量测试 + 类型检查

- [ ] **步骤 1：运行全部单测**

运行：`cd apps/agent-server && pnpm test`
预期：所有测试 PASS（包括新增的 14 个 web-search 测试 + 现有测试）

- [ ] **步骤 2：类型检查**

运行：`cd apps/agent-server && pnpm build`
预期：tsc 无报错

- [ ] **步骤 3：端到端验证**

```bash
# 1. 启动 SearXNG
docker compose up -d

# 2. 启动 agent-server
cd apps/agent-server && pnpm dev

# 3. 测试搜索端点
curl "http://127.0.0.1:3900/api/search?q=宋代茶文化&max=2" | jq .
```

预期：返回包含 2 条结果的 JSON，每条含 `content`（Markdown 正文）和 `contentStatus`

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "test: web-search 全量测试通过"
```

---

## 自检结果

**1. 规格覆盖度：**
- §2.1 模块边界 → 任务 3-8 覆盖所有文件 ✓
- §2.2 数据流 → 任务 7 编排服务完整实现 ✓
- §3.1-3.7 所有组件 → 任务 3-10 ✓
- §4.1 环境变量 → 任务 11 ✓
- §4.2 依赖 → 任务 2 ✓
- §5 错误处理 → 任务 4（SearXNG 错误）+ 任务 5（抓取超时）+ 任务 7（回退）✓
- §6 测试策略 → 任务 4/6/7 单测 + 任务 12 集成 ✓
- §7 安全 → UA 透明（任务 5）+ 截断（任务 7）✓
- docker-compose → 任务 1 ✓

**2. 占位符扫描：** 无 TODO/待定，所有步骤含完整代码 ✓

**3. 类型一致性：** `SearXngResult` / `FetchResult` / `ExtractionResult` / `SearchResultItem` / `SearchResponse` / `SearchServiceOptions` / `WebSearchArgs` 在任务 3 定义，任务 4-8 使用一致 ✓
