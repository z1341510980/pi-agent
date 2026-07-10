/**
 * electron-builder beforeBuild hook.
 *
 * electron-vite 已将 main/preload/renderer 全部 bundle 到 out/，
 * 原生模块通过 extraResources 处理，运行时不需要 node_modules。
 * 返回 false 告诉 electron-builder：node_modules 已外部处理，
 * 跳过 node module collector（pnpm store 全量扫描极慢）。
 */
exports.default = async function beforeBuild() {
  return false;
};
