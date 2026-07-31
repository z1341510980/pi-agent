import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'

/**
 * desktop 的 ESLint 配置。
 *
 * ⚠️ 此前这里 import 了 `eslint-plugin-vue` 与 `vue-eslint-parser`，但两者
 * **从未在任何 package.json 声明过**，node_modules 里也不存在。
 * 结果是 `pnpm --filter desktop lint` 在任何人手上都直接
 * `ERR_MODULE_NOT_FOUND` —— lint 门禁形同虚设，只有显式指定文件路径
 * （`eslint <file>`）时才会因为不加载配置而侥幸跑通。
 *
 * desktop 是 React + Electron 项目，仓库内 `.vue` 文件数为 0，
 * 因此直接移除 vue 相关的三段配置（plugin / parser / 规则），
 * 而不是补装两个用不到的依赖。
 */
export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintConfigPrettier
)
