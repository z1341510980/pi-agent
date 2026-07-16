/** 读取环境变量中的整数，支持默认值，非合法值回退到默认值 */
export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return defaultValue
  const v = Number.parseInt(raw, 10)
  return Number.isFinite(v) && v > 0 ? v : defaultValue
}
