// 源作者的唯一入口形状：handler 收 ctx、吐 DTO。
// ctx 里的东西全部由 host 注入——源不 import store/api，也不自己 new HTTP 客户端。
import {
  inBandError,
  keywordOf,
  paramString,
  scrubQuery,
  textContent,
  type ActionName,
  type Device,
  type Params,
  type PoolConfig,
  type PoolProvider,
} from '@loomproxy/contract'
import { load } from 'cheerio'

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
  /** 取号端口：有池的源用它（fq_novel 的会话池就是这样接的） */
  pool?: (name: string) => {
    acquire(): Promise<Device>
    report(err: unknown): void
    cooldown(ident: string, until?: number, note?: string): void
    success(): void
  }
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

/** 源自带的池声明：装配层负责注册与启停（源包不认识宿主） */
export type PoolDeclaration = {
  name: string
  provider: PoolProvider
  config?: Partial<PoolConfig>
}

export type SourceDefinition = {
  handlers: Partial<Record<ActionName, Handler>>
  /** 该源的设备/凭证池（可选）；handler 里用 ctx.pool(name) 取号 */
  pool?: PoolDeclaration
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

/**
 * SDK 2：宿主注入给插件的**唯一运行时依赖**。
 * 插件源码只做 `import type`，不 import 任何 SDK 值（contract/source-kit 由宿主持有单例）。
 * 与 Pi 扩展的 `pi` / MusicFree 宿主 require 注入同构：插件包因此不再携带 SDK、zod 或版本目录。
 */
export type PluginSdk = {
  inBandError: typeof inBandError
  keywordOf: typeof keywordOf
  paramString: typeof paramString
  scrubQuery: typeof scrubQuery
  textContent: typeof textContent
  defineSource: typeof defineSource
  /** HTML 解析（宿主提供，插件不用自带 cheerio 闭包） */
  load: typeof load
}

/** 插件入口形态：默认导出工厂，宿主调用时注入 SDK（类似 Pi 的 factory / MusicFree 的 module.exports） */
export type PluginFactory = (sdk: PluginSdk) => SourceDefinition

/** 宿主侧构造 SDK（in-process 与 worker 入口各调一次，拿到的都是宿主那份函数） */
export function createPluginSdk(): PluginSdk {
  return { inBandError, keywordOf, paramString, scrubQuery, textContent, defineSource, load }
}
