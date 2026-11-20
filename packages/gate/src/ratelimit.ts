// 限流：IP 与用户双维度，**两者都放行才放行**（迁移-TS-1 §4 的 order 600）。
// 口径对齐 Go 的 gate/ratelimit.go：
//   · 窗口计数（limit_count>0）：滑动窗口内最多 count 次，环形缓冲存时间戳，被拒请求不计数；
//   · 固定间隔（interval>0）：每 intervalMs 放行一次；
//   · 不限（两者都无）：直接放行——调用方在 spec 为空时不调用 allow。
export type LimitSpec = { count: number; windowMs: number } | { intervalMs: number }

type WindowBucket = {
  limit: number
  stamps: number[]
  head: number
  n: number
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowBucket>()
  /** 固定间隔：key → 上次放行时刻 */
  private readonly intervals = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 返回 true = 放行 */
  allow(key: string, spec: LimitSpec): boolean {
    const t = this.now()
    if ('intervalMs' in spec) {
      // 固定间隔（不可突发）：intervalMs<=0 视为不限，直接放行
      if (spec.intervalMs <= 0) return true
      const last = this.intervals.get(key)
      if (last === undefined || t - last >= spec.intervalMs) {
        this.intervals.set(key, t)
        return true
      }
      return false
    }
    // 窗口计数：count<=0 视为不限（Go 的 windowLimiter.allow limit<=0 → true）
    if (spec.count <= 0) return true
    const windowMs = spec.windowMs > 0 ? spec.windowMs : 60_000 // 默认窗口 60s（Go defaultWindowSec）
    let b = this.windows.get(key)
    if (!b || b.limit !== spec.count) {
      // 上限变了（面板改配置）→ 重建环形缓冲，旧计数作废（与 Go 一致）
      b = { limit: spec.count, stamps: new Array(spec.count).fill(0), head: 0, n: 0 }
      this.windows.set(key, b)
    }
    // 缓冲满且最旧一次仍在窗口内 → 拒绝（被拒请求不写入、不计数）
    if (b.n === spec.count && t - b.stamps[b.head]! < windowMs) return false
    b.stamps[b.head] = t
    b.head = (b.head + 1) % spec.count
    if (b.n < spec.count) b.n++
    return true
  }

  sweep(now: number, idleMs = 3_600_000): number {
    let n = 0
    for (const [k, b] of this.windows) {
      const recent = b.n > 0 ? Math.max(...b.stamps.slice(0, b.n)) : 0
      if (now - recent > idleMs) {
        this.windows.delete(k)
        n++
      }
    }
    for (const [k, t] of this.intervals) {
      if (now - t > idleMs) {
        this.intervals.delete(k)
        n++
      }
    }
    return n
  }

  get size(): number {
    return this.windows.size + this.intervals.size
  }
}
