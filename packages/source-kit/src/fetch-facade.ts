// 把 kernel 的 Upstream 包成源可用的三入口。源不许直接 import undici。
import type { Upstream, UpstreamScope } from '@loomproxy/kernel'
import type { FetchFacade, FetchOptions } from './handler.ts'

/**
 * scope = 这次请求属于哪个源/动作。带上是**必须**的：代理门控（设置项 proxy_enabled_sources）
 * 按「源」与「源/接口」两级判，没有 scope 就只能"全走"或"全不走"。
 */
export function createFetchFacade(upstream: Upstream, scope?: UpstreamScope): FetchFacade {
  return {
    async json(url, opts: FetchOptions = {}) {
      const o: Parameters<Upstream['fetchJson']>[1] = {
        headers: opts.headers ?? {},
        ...(scope ? { scope } : {}),
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body ? { body: opts.body } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
      }
      return upstream.fetchJson(url, o)
    },
    async text(url, opts: FetchOptions = {}) {
      return upstream.fetchText(url, {
        headers: opts.headers ?? {},
        ...(scope ? { scope } : {}),
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body ? { body: opts.body } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
    },
    async raw(url, opts: FetchOptions = {}) {
      return upstream.fetchRaw(url, {
        headers: opts.headers ?? {},
        ...(scope ? { scope } : {}),
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body ? { body: opts.body } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.cacheKey ? { cacheKey: opts.cacheKey } : {}),
        ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
      })
    },
  }
}
