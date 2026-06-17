/**
 * web_search + web_fetch 扩展
 * 通过 Pi SDK Extensions 机制注册
 * 当前为骨架实现，后续接入实际搜索 API
 */

/** web_search 工具定义 */
export const webSearchTool = {
  name: 'web_search',
  description: '搜索互联网获取信息',
  parameters: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: '搜索关键词' },
    },
    required: ['query'],
  },
}

/** web_fetch 工具定义 */
export const webFetchTool = {
  name: 'web_fetch',
  description: '获取指定 URL 的内容',
  parameters: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: '目标 URL' },
    },
    required: ['url'],
  },
}
