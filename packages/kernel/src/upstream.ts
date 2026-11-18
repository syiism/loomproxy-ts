// 取数栈：源唯一允许的 HTTP 出口（迁移-TS-2 §6）。
// 链：缓存 → 合并 → 熔断 → 代理/直连 → 上游。不许自建 fetch（否则绕开这一整条）。
import { readFileSync, statSync } from 'node:fs'
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
  /** 这次请求属于哪个源/动作：代理门控（proxy_enabled_sources）读它 */
  scope?: UpstreamScope
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
  /**
   * 「这个源的这次调用走不走代理」：设置项 proxy_enabled_sources 是热读的，
   * 所以每次调用现问（不许在构造期把名单烘死）。缺省 = 不限制。
   */
  proxyAllowedFor?: (scope: UpstreamScope) => boolean
}

/** 一次上游请求属于哪个源/动作（代理门控与将来的按源统计都用它，别让调用方自己拆 URL） */
export type UpstreamScope = { source: string; action: string }

/**
 * UA 轮换池：与 Go 版 `base/proxy.go` 的 userAgents 逐条对齐（移动端为主，贴近阅读类客户端真实分布）。
 * **一处定义**：面板、源包都不许再抄一份——抄出来的第二份会先漂移，再变成"某个源总被风控"。
 */
export const UA_ROTATE: readonly string[] = [
  'Mozilla/5.0 (Linux; Android 13; 2304FPN6DC Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; M2007J3SC Build/SKQ1.211006.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 11; Redmi K40 Build/RKQ1.200826.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'okhttp/4.12.0',
  'Dalvik/2.1.0 (Linux; U; Android 13; 2304FPN6DC Build/TKQ1.221114.001)',
  'reading/3.5.0 (Android)',
]

/** 代理文件热加载的判定间隔（与 Go 的 proxyFileReload 同值）：5 秒内不重复 stat */
const PROXY_FILE_RELOAD_MS = 5_000

/**
 * 读代理文件：每行一个，空行与 `#` 注释跳过。按 mtime 缓存（5s 内不重复 stat）。
 * 文件不存在/读失败返回上一次的结果——运维正在换文件时不该把整条代理链断掉。
 */
class ProxyFile {
  private readonly path: string
  private mtime = 0
  private checkedAt = 0
  private list: string[] = []

  constructor(path: string) {
    this.path = path
  }

  read(now = Date.now()): string[] {
    if (now - this.checkedAt < PROXY_FILE_RELOAD_MS) return this.list
    this.checkedAt = now
    try {
      const st = statSync(this.path)
      if (st.mtimeMs === this.mtime) return this.list
      this.list = readFileSync(this.path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
      this.mtime = st.mtimeMs
    } catch {
      // 读不到就沿用上一次（空列表 = 直连）
    }
    return this.list
  }
}

/**
 * 「设置项 proxy_enabled_sources 允许这个调用走代理吗」。
 * 列表项两种粒度：数据源名（`novel_a` = 该源全部接口）与接口（`novel_a/chapter`）；
 * 留空 = 不限制（与 Go 的 proxyAllowedForPath 同口径，保持历史行为）。
 */
export function proxyEnabledFor(list: string, scope: UpstreamScope): boolean {
  const raw = list.trim()
  if (raw === '') return true
  const path = `${scope.source}/${scope.action}`
  return raw
    .split(',')
    .map((x) => x.trim())
    .some((x) => x !== '' && (x === scope.source || x === path))
}

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
  private readonly agents = new Map<string, ProxyAgent>()
  private readonly proxyFile?: ProxyFile
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
    if (deps.config.upstreamProxyFile) this.proxyFile = new ProxyFile(deps.config.upstreamProxyFile)
  }

  /**
   * 当前代理池 = env `UPSTREAM_PROXIES` + 文件 `UPSTREAM_PROXY_FILE`（文件按 mtime 热加载）。
   * 每次现拼：换文件不该等重启（两个来源都是"部署时给的东西"，不是"进程启动时那一刻的东西"）。
   */
  private proxyPool(): string[] {
    const fromEnv = this.deps.config.upstreamProxies
    const fromFile = this.proxyFile?.read() ?? []
    return fromFile.length === 0 ? fromEnv : [...fromEnv, ...fromFile]
  }

  /** 代理客户端按 URL 复用（ProxyAgent 各自持连接池，每次新建等于不复用连接） */
  private agentFor(url: string): ProxyAgent {
    const hit = this.agents.get(url)
    if (hit) return hit
    const agent = new ProxyAgent(url)
    this.agents.set(url, agent)
    return agent
  }

  private nextProxy(): ProxyAgent | undefined {
    const pool = this.proxyPool()
    if (pool.length === 0) return undefined
    // 轮转（Go 是随机）：均匀分摊，也不让单测随机抖动
    const i = this.proxyCursor++ % pool.length
    return this.agentFor(pool[i] as string)
  }

  private decorateHeaders(headers: Record<string, string>, scope?: UpstreamScope): Record<string, string> {
    void scope
    const out = { ...headers }
    // 调用方（源）显式给了 UA 就不覆盖：那是它对上游的伪装，比平台池更懂
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
    scope?: UpstreamScope,
  ): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
    const host = hostOf(url)
    const blocked = this.breaker.acquire(host)
    if (blocked) throw new UpstreamError(503, blocked)

    const timeout = opts.timeoutMs ?? this.deps.config.timeoutPoolMs
    const timer = AbortSignal.timeout(timeout)
    const combined = AbortSignal.any([signal, timer])
    // 按源/接口门控（设置项 proxy_enabled_sources）：没给 scope 就不限，给了就现问
    const allowed = scope ? (this.deps.proxyAllowedFor?.(scope) ?? true) : true
    const proxy = allowed ? this.nextProxy() : undefined
    try {
      const res = await undiciFetch(url, {
        method: opts.method ?? 'GET',
        headers: this.decorateHeaders(opts.headers ?? {}, scope),
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
      const res = await this.perform(url, opts, signal, opts.scope)
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
