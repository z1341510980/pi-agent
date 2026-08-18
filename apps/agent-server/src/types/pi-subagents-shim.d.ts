/**
 * pi-subagents 根入口的编译期类型垫片。
 *
 * 真实包根入口是 TS 源码（index.ts 内部 import 带 .ts 后缀、且针对更高版本 SDK 的
 * AgentToolResult 形状），直接参与类型解析会把整棵源码树拖进本项目类型程序报错。
 * tsconfig.json 用 paths 把 'pi-subagents' 映射到本文件，只暴露工厂签名。
 *
 * 运行时（tsx）：package.json "dev" 指定 tsx --tsconfig tsconfig.tsx.json，这个配置
 * 移除了 paths 映射，不遮蔽真实包，直接加载其 index.ts，避免无限递归。
 *
 * 'pi-subagents/delegation' 等子路径继续走真实包类型（无 .ts 内部引用问题）。
 */
declare function registerSubagentExtension(pi: unknown): void | Promise<void>
export default registerSubagentExtension
