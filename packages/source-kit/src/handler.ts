// 源作者的唯一入口形状：handler 收 ctx、吐 DTO。
// ctx 里的东西全部由 host 注入——源不 import store/api，也不自己 new HTTP 客户端。
import type { ActionName, Params } from '@loomproxy/contract'

/** 只读设置视图：声明在这里，实现在 store（source-kit 不依赖 store） */
export interface SettingsReader {
  get(key: string): string
  getBool(key: string, def: boolean): boolean
  getInt(key: string, def: number): number
}

export type FetchOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** 上游短 TTL 缓存（毫秒，>0 才启用）。键里必须含会话维度。 */
  cacheKey?: string
  ttlMs?: number
}

/** 取数门面：源只有这一个 HTTP 出口（迁移-TS-2 §6） */
export interface FetchFacade {
  json(url: string, opts?: FetchOptions): Promise<unknown>
  text(url: string, opts?: FetchOptions): Promise<string>
  raw(url: string, opts?: FetchOptions): Promise<{ body: Uint8Array; status: number }>
}

export type HandlerContext = {
  source: string
  action: ActionName
  /** 值永远是字符串；__uid 是平台注入的用户 ID */
  params: Params
  signal: AbortSignal
  fetch: FetchFacade
  settings: SettingsReader
}

export type Handler = (ctx: HandlerContext) => Promise<unknown>

export type BootContext = {
  settings: SettingsReader
  /** 宿主日志（已带源名前缀） */
  log: (msg: string) => void
}

export type SourceDefinition = {
  handlers: Partial<Record<ActionName, Handler>>
  /** 装配后钩子：每次加载都调，**必须幂等**（迁移-TS-2 §2） */
  onBoot?: (ctx: BootContext) => void | Promise<void>
  /** 卸载/换代时释放资源（定时器、句柄） */
  dispose?: () => void | Promise<void>
}

/**
 * 定义源：只接 handler 与钩子，**不接元数据**——元数据在 manifest（唯一来源）。
 * 注册期就校验"声明的动作必须有 handler"，别等到运行期 404。
 */
export function defineSource(def: SourceDefinition): SourceDefinition {
  const names = Object.keys(def.handlers) as ActionName[]
  if (names.length === 0) throw new Error('defineSource: 至少要有一个 handler')
  for (const n of names) {
    if (typeof def.handlers[n] !== 'function') throw new Error(`defineSource: ${n} 不是函数`)
  }
  return def
}
