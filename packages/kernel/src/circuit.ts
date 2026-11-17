// 熔断：按上游 host 维度。连续失败达到阈值 → 冷却期内快速失败 → 到点放行一次探测。
export type CircuitOptions = { enabled: boolean; failures: number; cooldownMs: number }

type State = { fails: number; openUntil: number; probing: boolean }

export class CircuitBreaker {
  private readonly states = new Map<string, State>()
  private readonly opts: CircuitOptions

  constructor(opts: CircuitOptions) {
    this.opts = opts
  }

  /** 返回 undefined = 放行；返回字符串 = 快速失败的文案 */
  acquire(host: string, now = Date.now()): string | undefined {
    if (!this.opts.enabled) return undefined
    const s = this.states.get(host)
    if (!s) return undefined
    if (s.openUntil === 0) return undefined
    if (now >= s.openUntil && !s.probing) {
      s.probing = true // 半开：只放一个探测
      return undefined
    }
    return `上游 ${host} 熔断中，请稍后重试`
  }

  success(host: string): void {
    this.states.delete(host)
  }

  failure(host: string, now = Date.now()): void {
    if (!this.opts.enabled) return
    const s = this.states.get(host) ?? { fails: 0, openUntil: 0, probing: false }
    s.fails++
    s.probing = false
    if (s.fails >= this.opts.failures) {
      s.fails = 0
      s.openUntil = now + this.opts.cooldownMs
    }
    this.states.set(host, s)
  }

  stateOf(host: string): { fails: number; openUntil: number } {
    const s = this.states.get(host)
    return { fails: s?.fails ?? 0, openUntil: s?.openUntil ?? 0 }
  }
}
