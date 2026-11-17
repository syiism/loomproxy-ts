// 取数栈：源唯一允许的 HTTP 出口（迁移-TS-2 §6）。
// 链：缓存 → 合并 → 熔断 → 代理/直连 → 上游。不许自建 fetch（否则绕开这一整条）。
import { ClientCanceled, UpstreamError, scrubQuery } from '@loomproxy/contract'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { CacheOptions } from './cache.ts'
import { TtlCache } from './cache.ts'
import type { Config } from './config.ts'
import type { Logger } from './logger.ts'
import { CircuitBreaker } from './circuit.ts'
import { SingleFlight } from './singleflight.ts'

export type FetchOptions = {
  method?: string
  headers?: Record<string, string>
  /** 请求体：字符串或已序列化字节 */
  body?: string | Uint8Array
  /** 覆盖默认超时（毫秒） */
  timeoutMs?: number
  signal?: AbortSignal
}

export type UpstreamDeps = {
  config: Config
  logger: Logger
  /** 上游响应短 TTL 缓存（仅当调用方给了 cacheKey 时使用） */
  cache?: TtlCache<unknown>
  breaker?: CircuitBreaker
}

const UA_ROTATE: readonly string[] = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
]

export function headersKey(headers: Record<string, string>): string {
  // 与 Go 版同算法：键排序后 k=v 拼接。双跑对拍时算法不一致会表现成"缓存没命中"。
  return Object.keys(headers)
    .sort()
    .map((k) => `${k}=${headers[k]}`)
    .join('&')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export class Upstream {
  private readonly cache?: TtlCache<unknown>
  private readonly breaker: CircuitBreaker
  private readonly flight = new SingleFlight()
  private readonly proxies: ProxyAgent[]
  private proxyCursor = 0
  private uaCursor = 0

  private readonly deps: UpstreamDeps

  constructor(deps: UpstreamDeps) {
    this.deps = deps
    this.cache = deps.cache
    this.breaker =
      deps.breaker ??
      new CircuitBreaker({
        enabled: deps.config.circuitBreakerEnabled,
        failures: deps.config.circuitBreakerFailures,
        cooldownMs: deps.config.circuitBreakerCooldownSec * 1000,
      })
    this.proxies = deps.config.upstreamProxies.map((p) => new ProxyAgent(p))
  }

  private nextProxy(): ProxyAgent | undefined {
    if (this.proxies.length === 0) return undefined
    const i = this.proxyCursor++ % this.proxies.length
    return this.proxies[i]
  }

  private decorateHeaders(headers: Record<string, string>): Record<string, string> {
    const out = { ...headers }
    const hasUA = Object.keys(out).some((k) => k.toLowerCase() === 'user-agent')
    if (!hasUA && this.deps.config.upstreamUaRotate && UA_ROTATE.length > 0) {
      out['user-agent'] = UA_ROTATE[this.uaCursor++ % UA_ROTATE.length] as string
    }
    return out
  }

  private async perform(
    url: string,
    opts: FetchOptions,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
    const host = hostOf(url)
    const blocked = this.breaker.acquire(host)
    if (blocked) throw new UpstreamError(503, blocked)

    const timeout = opts.timeoutMs ?? this.deps.config.timeoutPoolMs
    const timer = AbortSignal.timeout(timeout)
    const combined = AbortSignal.any([signal, timer])
    const proxy = this.nextProxy()
    try {
      const res = await undiciFetch(url, {
        method: opts.method ?? 'GET',
        headers: this.decorateHeaders(opts.headers ?? {}),
        body: opts.body,
        signal: combined,
        ...(proxy ? { dispatcher: proxy } : {}),
      })
      this.breaker.success(host)
      return res
    } catch (e) {
      if (signal.aborted) throw new ClientCanceled()
      this.breaker.failure(host)
      const msg = e instanceof Error ? e.message : String(e)
      throw new UpstreamError(0, `上游请求失败: ${scrubQuery(msg)}`, e)
    }
  }

  /** 原始字节 + 上游状态码（成败判定归调用方，对应 Go 的 FetchShared） */
  async fetchRaw(
    url: string,
    opts: FetchOptions & { cacheKey?: string; ttlMs?: number; cacheIf?: (body: Uint8Array) => boolean } = {},
  ): Promise<{ body: Uint8Array; status: number }> {
    const signal = opts.signal ?? new AbortController().signal
    const key = opts.cacheKey
    if (key && this.cache && opts.ttlMs && opts.ttlMs > 0) {
      const hit = this.cache.get(key)
      if (hit instanceof Uint8Array) return { body: hit, status: 200 }
    }
    const run = async (): Promise<{ body: Uint8Array; status: number }> => {
      const res = await this.perform(url, opts, signal)
      const body = new Uint8Array(await res.arrayBuffer())
      if (res.status >= 400) {
        throw new UpstreamError(res.status, `上游返回非 2xx: ${res.status}`, undefined)
      }
      if (key && this.cache && opts.ttlMs && (!opts.cacheIf || opts.cacheIf(body))) {
        this.cache.set(key, body)
      }
      return { body, status: res.status }
    }
    return key ? this.flight.do(key, run) : run()
  }

  async fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
    const { body } = await this.fetchRaw(url, opts)
    return new TextDecoder().decode(body)
  }

  async fetchJson(url: string, opts: FetchOptions & { ttlMs?: number } = {}): Promise<unknown> {
    const ttlMs = opts.ttlMs ?? 0
    const cacheKey = ttlMs > 0 ? `json:${url}${headersKey(opts.headers ?? {})}` : undefined
    const { body } = await this.fetchRaw(url, { ...opts, cacheKey, ttlMs })
    const text = new TextDecoder().decode(body)
    try {
      return JSON.parse(text) as unknown
    } catch (e) {
      throw new UpstreamError(0, '上游响应不是合法 JSON', e)
    }
  }
}

export type { CacheOptions }
