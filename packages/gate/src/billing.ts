// 计费：额度预检 + 成功后扣减 + 同内容去重窗口（迁移-TS-1 §4 的 order 500）。
// 去重窗口的意义：客户端超时重试同一篇正文时，第二次起不再重复扣额度。
import type { Params } from '@loomproxy/contract'
import { paramString } from '@loomproxy/contract'

export type CostSpec = { cost: number; status: number } | undefined

export class Ledger {
  private readonly used = new Map<string, number>()
  private readonly lastCharge = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private key(user: number, source: string): string {
    return `${user}:${source}`
  }

  usedToday(user: number, source: string): number {
    return this.used.get(this.key(user, source)) ?? 0
  }

  /** 预检：limit < 0 视为不限 */
  canCharge(user: number, source: string, limit: number, cost: number): boolean {
    if (limit < 0 || cost <= 0) return true
    return this.usedToday(user, source) + cost <= limit
  }

  /** 扣减：同接口同内容在 windowMs 内只扣一次（返回 true = 真的扣了） */
  charge(user: number, source: string, action: string, contentKey: string, cost: number, windowMs: number): boolean {
    if (cost <= 0) return false
    const dedupeKey = `${user}:${source}:${action}:${contentKey}`
    const t = this.now()
    if (windowMs > 0) {
      const last = this.lastCharge.get(dedupeKey)
      if (last !== undefined && t - last < windowMs) return false
      this.lastCharge.set(dedupeKey, t)
    }
    const k = this.key(user, source)
    this.used.set(k, (this.used.get(k) ?? 0) + cost)
    return true
  }

  reset(): void {
    this.used.clear()
    this.lastCharge.clear()
  }
}

/** 内容维度键：让"同一篇正文的重试"能认出来；换一章就换键（照扣不误） */
export function contentKeyOf(action: string, params: Params): string {
  switch (action) {
    case 'content':
      return `${paramString(params, 'bookId')}|${paramString(params, 'itemId')}`
    case 'chapter':
    case 'detail':
      return paramString(params, 'bookId')
    case 'search':
      return paramString(params, 'key') || paramString(params, 'query')
    default:
      return paramString(params, 'url') || paramString(params, 'category')
  }
}
