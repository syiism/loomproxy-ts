// 池内只用到两个原语（时间戳与形状），故意不依赖 store：持久化走注入的 DeviceStore。
export function nowIso(): string {
  return new Date().toISOString()
}
