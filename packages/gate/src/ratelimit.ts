// 限流：IP 与用户双维度，**两者都放行才放行**（迁移-TS-1 §4 的 order 600）。
export type LimitSpec = { count: number; windowMs: number } | { intervalMs: number }

type Bucket = { tokens: number; updatedAt: number }
/** 间隔型的最小间隔：每秒最多一次（防 0/负值把限流关掉） */
const MIN_INTERVAL_MS = 1000

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  /** 间隔型单独记"上次放行的时刻"，与令牌桶的 tokens 语义不同 */
  private readonly lastAllowed = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 返回 true = 放行 */
  allow(key: string, spec: LimitSpec): boolean {
    const t = this.now()
    if ('intervalMs' in spec) {
      const interval = Math.max(MIN_INTERVAL_MS, spec.intervalMs)
      const last = this.lastAllowed.get(key)
      if (last === undefined || t - last >= interval) {
        this.lastAllowed.set(key, t)
        return true
      }
      return false
    }
    const b = this.buckets.get(key) ?? { tokens: spec.count, updatedAt: t }
    // 匀速回填：窗口内均匀补充，避免"整点突发"
    const refill = ((t - b.updatedAt) / spec.windowMs) * spec.count
    b.tokens = Math.min(spec.count, b.tokens + Math.max(0, refill))
    b.updatedAt = t
    if (b.tokens < 1) {
      this.buckets.set(key, b)
      return false
    }
    b.tokens -= 1
    this.buckets.set(key, b)
    return true
  }

  sweep(now: number, idleMs = 3_600_000): number {
    let n = 0
    for (const [k, b] of this.buckets) {
      if (now - b.updatedAt > idleMs) {
        this.buckets.delete(k)
        n++
      }
    }
    for (const [k, t] of this.lastAllowed) {
      if (now - t > idleMs) {
        this.lastAllowed.delete(k)
        n++
      }
    }
    return n
  }

  get size(): number {
    return this.buckets.size + this.lastAllowed.size
  }
}
