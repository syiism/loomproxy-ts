// 并发合并：同键在飞时复用同一个 Promise（Go 的 singleflight 等价物）。
// 上游限流额度是共享的，热门 key 的高并发必须合并成一次。
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>()

  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) return existing as Promise<T>
    const p = fn().finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, p)
    return p
  }

  get size(): number {
    return this.inflight.size
  }
}
