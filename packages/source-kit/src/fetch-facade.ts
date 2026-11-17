// 把 kernel 的 Upstream 包成源可用的三入口。源不许直接 import undici。
import type { Upstream } from '@loomproxy/kernel'
import type { FetchFacade, FetchOptions } from './handler.ts'

export function createFetchFacade(upstream: Upstream): FetchFacade {
  return {
    async json(url, opts: FetchOptions = {}) {
      const o: Parameters<Upstream['fetchJson']>[1] = {
        headers: opts.headers ?? {},
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
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body ? { body: opts.body } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
    },
    async raw(url, opts: FetchOptions = {}) {
      return upstream.fetchRaw(url, {
        headers: opts.headers ?? {},
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body ? { body: opts.body } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.cacheKey ? { cacheKey: opts.cacheKey } : {}),
        ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
      })
    },
  }
}
