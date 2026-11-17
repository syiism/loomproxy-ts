// LRU + TTL：上游短 TTL 缓存与平台响应缓存的同一件原语。
// 必须有上限——内存无界是迁移到 Node 后最容易出的事故（迁移-TS-3 §9）。
export type CacheOptions = { maxEntries: number; ttlMs: number }

type Entry<V> = { value: V; expiresAt: number }

export class TtlCache<V> {
  private readonly map = new Map<string, Entry<V>>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(opts: CacheOptions) {
    this.maxEntries = Math.max(1, opts.maxEntries)
    this.ttlMs = Math.max(0, opts.ttlMs)
  }

  get(key: string, now = Date.now()): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.expiresAt <= now) {
      this.map.delete(key)
      return undefined
    }
    // 命中即刷新 LRU 位置
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key: string, value: V, now = Date.now()): void {
    if (this.ttlMs <= 0) return
    this.map.delete(key)
    this.map.set(key, { value, expiresAt: now + this.ttlMs })
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  sweep(now = Date.now()): number {
    let n = 0
    for (const [k, e] of this.map) {
      if (e.expiresAt <= now) {
        this.map.delete(k)
        n++
      }
    }
    return n
  }

  get size(): number {
    return this.map.size
  }
}
