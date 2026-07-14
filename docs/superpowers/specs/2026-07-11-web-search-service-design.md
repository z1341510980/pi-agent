# 联网搜索服务设计

> 日期：2026-07-11 | 状态：待审查 | 作者：AI 辅助设计

---

## 一、背景与目标

### 1.1 现状

pi-agent 当前无联网能力，小说创作 AI 在涉及历史背景、地理、专业知识、时事等真实世界信息时只能依赖训练知识，存在事实风险与时效盲区。

已有基建：
- [pi-session.ts](../../../apps/agent-server/src/core/agent/pi-session.ts)：通过 `pluginSessionTools` 注入 customTools 到 Pi SDK Session
- [plugin-types.ts](../../../apps/agent-server/src/core/plugin/plugin-types.ts)：`PluginContext.registerSessionTools()` 提供 customTools 注入入口
- [hello-plugin](../../../apps/agent-server/src/plugins/examples/hello-plugin/index.ts)：内置插件示例
- [memory-tools.ts](../../../apps/agent-server/src/core/memory/memory-tools.ts)：工具定义参考（Zod schema + execute 函数）
- 依赖：`undici ^8.3.0` 已在 [agent-server package.json](../../../apps/agent-server/package.json) 中

### 1.2 目标

为 AI Agent 提供联网搜索工具，让小说创作 AI 能自主查证真实世界信息：

- **SearXNG 元搜索**：自建实例聚合 Google/Bing/百度/DuckDuckGo/Wikipedia 等引擎，完全免费、无 API 配额
- **中量清洗**：对 top N 结果抓取网页正文并转 Markdown，提供丰富上下文
- **Agent 工具集成**：作为 customTool 注入 pi-session，AI 自主判断何时联网
- **Docker Compose 一键启动**：开发者 `docker compose up` 即可拉起 SearXNG

### 1.3 非目标

- **不做前端搜索面板**：本轮只做 Agent 工具，不做用户手动搜索 UI
- **不做摘要/打分/去重**：中量清洗只抓正文转 Markdown，不做 LLM 摘要、相关度评分、语义去重（重量级留给后续迭代）
- **不做公共 SearXNG 实例托管**：只提供本地 Docker 部署，不运营远程服务
- **不改现有 Agent 推理链路**：只新增工具，不改 novel-orchestrator / pi-session 等已有逻辑

---

## 二、架构总览

### 2.1 模块边界

```
项目根/
├── docker-compose.yml                   ← 新增：SearXNG 容器编排
├── searxng-settings.yml                 ← 新增：SearXNG 配置（启用 JSON、引擎选择）
└── apps/agent-server/src/
    ├── plugins/
    │   └── web-search-plugin/          ← 新增：内置插件
    │       ├── index.ts                 ← 插件入口：registerSessionTools
    │       ├── searxng-client.ts        ← 调 SearXNG /search API
    │       ├── content-fetcher.ts       ← undici 抓网页 HTML
    │       ├── content-extractor.ts     ← readability + turndown 转 Markdown
    │       ├── search-service.ts        ← 编排：搜→抓→清洗→汇总
    │       ├── types.ts                 ← 类型定义
    │       └── __tests__/
    │           ├── content-extractor.test.ts
    │           ├── searxng-client.test.ts
    │           └── search-service.test.ts
    └── routes/
        └── search.route.ts              ← 新增：GET /api/search（调试用）
```

### 2.2 数据流

```
AI 调用 web_search(query="宋代茶文化", max_results=3)
  │
  ▼
search-service.search(query, opts)
  │
  ▼
searxng-client → GET http://localhost:8888/search?q=宋代茶文化&format=json
  │   ← [{ title, url, content(摘要), engine }, ...]
  │   取 top N
  ▼
content-fetcher × N 并发 → undici 抓取每个 url 的 HTML
  │   ← HTML 字符串（超时/403 的跳过）
  ▼
content-extractor → readability 提取正文 → turndown 转 Markdown
  │   ← 干净 Markdown（失败回退用 snippet）
  ▼
search-service 汇总，截断到 ~2000 字/条
  │
  ▼
返回给 AI：
  [{
    title, url, engine, snippet,
    content: '# 标题\n\n正文 Markdown...'
  }]
```

### 2.3 与现有系统的关系

```
                    ┌─────────────────────────────────┐
                    │   pi-session (customTools)      │
                    │   web_search 工具注入            │
                    └────────────┬────────────────────┘
                                 │
                    ┌────────────▼────────────────────┐
                    │   web-search-plugin              │
                    │   registerSessionTools([         │
                    │     webSearchToolDefinition      │
                    │   ])                             │
                    └────────────┬────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ searxng-     │  │ content-     │  │ search-      │
      │ client       │  │ fetcher      │  │ service      │
      │ (搜索)       │  │ (抓 HTML)    │  │ (编排汇总)    │
      └──────┬───────┘  └──────┬───────┘  └──────────────┘
             │                 │
             ▼                 ▼
      ┌──────────────┐  ┌──────────────┐
      │ SearXNG 容器  │  │ 目标网页      │
      │ :8888         │  │ (全网)        │
      └──────────────┘  └──────────────┘
```

---

## 三、组件设计

### 3.1 searxng-client.ts

**职责**：调用 SearXNG `/search` API，返回结构化结果列表。

```ts
export interface SearXngResult {
  title: string
  url: string
  snippet: string           // SearXNG 返回的 content 字段（摘要）
  engine: string            // 来源引擎（google/bing/baidu/...）
  publishedDate?: string
}

export interface SearXngSearchOptions {
  query: string
  maxResults?: number       // 默认 5
  timeRange?: 'day' | 'week' | 'month' | 'year'  // SearXNG time_range 参数
  categories?: string[]     // 默认 ['general']，可选 ['news','images','it'] 等
}

export async function searchSearXng(
  baseUrl: string,           // http://localhost:8888
  options: SearXngSearchOptions,
  signal?: AbortSignal
): Promise<SearXngResult[]>
```

**调用方式**：`GET {baseUrl}/search?q={query}&format=json&time_range={range}&categories={cats}`

**错误处理**：
- 连接失败 / 非 200 → 抛 `SearXngError`，由上层 catch
- 空结果 → 返回 `[]`

### 3.2 content-fetcher.ts

**职责**：用 undici 抓取目标 URL 的 HTML，带超时/UA/重定向处理。

```ts
export interface FetchResult {
  ok: boolean
  html?: string
  url: string               // 最终 URL（可能经过重定向）
  error?: string            // ok=false 时的错误信息
  statusCode?: number
}

export async function fetchUrl(
  url: string,
  options?: {
    timeoutMs?: number       // 默认 8000
    signal?: AbortSignal
  }
): Promise<FetchResult>
```

**实现要点**：
- 使用 `undici.request`（已是项目依赖）
- User-Agent：`Mozilla/5.0 (compatible; PiAgent/1.0; +https://pi-agent.local)`
- 超时：通过 `AbortController` + `setTimeout` 实现
- 重定向：undici 默认不跟随，手动处理 301/302（最多 3 次）
- 限制响应体大小：5MB（防超大页面爆内存）

### 3.3 content-extractor.ts

**职责**：HTML → 正文 Markdown。使用 `@mozilla/readability` + `turndown`。

```ts
export interface ExtractionResult {
  ok: boolean
  title?: string             // 提取的文章标题
  content?: string           // Markdown 正文
  error?: string
}

export async function extractContent(
  html: string,
  url: string                // 用于解析相对链接
): Promise<ExtractionResult>
```

**实现要点**：
1. `new JSDOM(html, { url })` 构造 DOM
2. `new Readability(doc).parse()` 返回 `{ title, content: HTML }`
3. `new TurndownService().turndown(content)` 转 Markdown
4. 提取失败（readability 返回 null）→ `ok: false`，上层回退用 snippet

**技术栈**：
- `@mozilla/readability`：Firefox Reader View 同款算法，对新闻/百科/博客提取质量高
- `turndown`：HTML → Markdown 转换
- `jsdom`：readability 的 DOM 依赖

### 3.4 search-service.ts

**职责**：编排搜索→抓取→清洗→汇总的完整流程。

```ts
export interface SearchResultItem {
  title: string
  url: string
  engine: string
  snippet: string
  content: string            // Markdown 正文（截断到 maxContentChars）
  contentStatus: 'fetched' | 'fallback' | 'failed'
}

export interface SearchResponse {
  ok: boolean
  results: SearchResultItem[]
  total: number              // SearXNG 返回的总结果数
  error?: string
}

export interface SearchServiceOptions {
  searxngUrl: string
  maxResults: number          // 抓取正文的结果数（默认 3）
  fetchTimeoutMs: number     // 默认 8000
  maxContentChars: number    // 默认 2000
  concurrency: number        // 抓取并发数（默认 3）
}

export async function search(
  query: string,
  options: SearchServiceOptions,
  signal?: AbortSignal
): Promise<SearchResponse>
```

**编排流程**：
1. 调 `searchSearXng` 拿结果列表
2. 取 top `maxResults` 条，并发 `fetchUrl`（限制 `concurrency`）
3. 对每个成功 fetch 的 URL 调 `extractContent`
4. 提取失败的回退用 snippet 作为 content
5. 每条 content 截断到 `maxContentChars`
6. 汇总返回

**并发控制**：简单实现用 `Promise.all` + 分批，或用 p-limit（暂不引入新依赖，手动分批）。

### 3.5 web-search-plugin/index.ts

**职责**：插件入口，注册 `web_search` 工具到 pi-session customTools。

```ts
import type { Plugin, PluginContext } from '../../../core/plugin/plugin-types.js'
import type { PiToolDefinition } from '@earendil-works/pi-coding-agent'
import { search } from './search-service.js'

const webSearchTool: PiToolDefinition = {
  name: 'web_search',
  description: '联网搜索最新信息。用于查证历史背景、地理、专业知识、时事等小说创作所需的真实世界信息。返回每条结果的标题、链接、摘要和正文（Markdown）。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询词' },
      max_results: {
        type: 'number',
        description: '返回并抓取正文的结果数（1-5）',
        default: 3,
      },
      time_range: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: '时间范围过滤，不传则不限时间',
      },
    },
    required: ['query'],
  },
  execute: async (args, ctx) => {
    const result = await search(args.query, {
      searxngUrl: process.env.SEARXNG_URL ?? 'http://localhost:8888',
      maxResults: Math.min(Math.max(args.max_results ?? 3, 1), 5),
      fetchTimeoutMs: Number(process.env.WEB_SEARCH_FETCH_TIMEOUT ?? 8000),
      maxContentChars: Number(process.env.WEB_SEARCH_MAX_CONTENT_CHARS ?? 2000),
      concurrency: Number(process.env.WEB_SEARCH_CONCURRENCY ?? 3),
    }, ctx.signal)
    return { ok: result.ok, data: result, error: result.error }
  },
}

export const webSearchPlugin: Plugin = {
  manifest: {
    name: 'web-search',
    version: '0.1.0',
    description: '联网搜索工具，基于 SearXNG 元搜索 + 正文提取',
    builtin: true,
  },
  setup(context: PluginContext) {
    context.registerSessionTools([webSearchTool])
  },
}
```

### 3.6 search.route.ts

**职责**：调试用 HTTP 端点，方便开发者不开 AI 对话直接测试搜索。

```ts
// GET /api/search?q={query}&max={n}
// 返回 SearchResponse JSON
```

### 3.7 docker-compose.yml + searxng-settings.yml

```yaml
# docker-compose.yml（项目根）
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

```yaml
# searxng-settings.yml
use_default_settings: true

search:
  formats:
    - html
    - json          # 必须，否则 /search 不返回 JSON

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

---

## 四、配置项

### 4.1 环境变量

`.env.example` 新增：

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

### 4.2 依赖新增

`apps/agent-server/package.json` 新增：

```json
{
  "dependencies": {
    "@mozilla/readability": "^0.5.0",
    "turndown": "^7.2.0",
    "jsdom": "^25.0.0"
  },
  "devDependencies": {
    "@types/turndown": "^5.0.5"
  }
}
```

> 注：`@mozilla/readability` 和 `jsdom` 无内置类型，jsdom 自带类型，readability 需 `@types/readability` 或手写声明。

---

## 五、错误处理

| 场景 | 处理 |
|---|---|
| SearXNG 容器未启动 | 工具返回 `ok:false, error:"SearXNG 不可达，请先 docker compose up"` |
| SearXNG 返回空结果 | 返回 `ok:true, results:[]`，AI 据此判断无信息 |
| 某网页抓取超时 | 跳过该条，`contentStatus: 'failed'`，content 留空 |
| 某网页 403/404 | 同上，跳过 |
| 正文提取失败（JS 渲染页） | `contentStatus: 'fallback'`，content 用 snippet |
| 整体超时（>15s，ctx.signal） | 返回已拿到的部分结果 |
| 单页非 UTF-8 编码 | 尝试从 meta charset 识别，iconv 转码（暂不引入，留待后续） |

---

## 六、测试策略

### 6.1 单元测试

| 文件 | 测试内容 |
|---|---|
| `content-extractor.test.ts` | 喂样本 HTML（新闻页/百科/博客），断言输出 Markdown 包含关键段落、去除 nav/footer |
| `searxng-client.test.ts` | mock undici 响应，断言参数拼装、结果解析、空结果处理 |
| `search-service.test.ts` | mock searxng-client + content-fetcher + extractor，测编排：并发、回退、截断、错误汇总 |

### 6.2 集成测试

`search.route.ts` 的 `GET /api/search` 端到端，需 SearXNG 容器运行（CI 可跳过，本地手动）。

### 6.3 测试框架

复用 vitest，与现有 `apps/agent-server/src/__tests__/` 一致。

---

## 七、安全与合规

- **无 API Key 暴露**：SearXNG 本地部署，无第三方 API Key
- **抓取频率**：单次搜索最多 5 个并发，对目标站点友好
- **User-Agent 透明**：标识为 PiAgent，不伪装浏览器
- **内容截断**：正文截断到 2000 字，避免上下文爆炸
- **不执行 JS**：undici 只抓静态 HTML，JS 渲染页回退 snippet

---

## 八、后续迭代方向（非本轮范围）

1. **摘要/打分/去重**：引入 LLM 生成摘要、相关度评分、语义去重
2. **缓存层**：相同 query 短时间内复用结果
3. **前端搜索面板**：用户手动搜索 UI
4. **多模态**：图片/视频搜索结果
5. **SearXNG 引擎调优**：按场景启用/禁用特定引擎（如学术搜索）
6. **JS 渲染页支持**：Puppeteer 抓取动态页面
