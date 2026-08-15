/**
 * pi-subagents 根入口的编译期垫片（见 tsconfig.json 的 paths 映射）。
 *
 * 该包入口是 TS 源码（内部 import 带 .ts 后缀、且其代码针对更高版本 SDK 的
 * AgentToolResult 形状），静态类型解析会把整棵源码树拖进本项目类型程序报错。
 * 因此：
 * - 编译期：'pi-subagents' → 本垫片（仅工厂签名）；
 * - 运行时：Node/vitest 仍解析真实包（paths 映射不影响运行时解析）；
 * - 'pi-subagents/delegation' 等浅层子路径继续走真实类型（无 .ts 内部引用）。
 */
declare function registerSubagentExtension(pi: unknown): void | Promise<void>
export default registerSubagentExtension
