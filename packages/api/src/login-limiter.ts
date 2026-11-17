// 登录防爆破：按 IP 记失败次数 + 锁定到点；快照给面板「安全」页看，定向解锁给运维。
// 内存态（与 Go 版同取舍）：进程重启清零——它挡的是"一分钟几百次"的猜测，不是长期封禁
// （长期封禁走 blocked_ips 表）。
export type AttemptItem = {
  ip: string
  fails: number
  fail_streak: number
  first_seen: string
  last_seen: string
  locked: boolean
  locked_until: string | null
  window_count: number
  max_per_minute: number
  distinct_ips: number
  sample_ips: string[]
  accounts: number
  accounts_meta: Array<{ principal: string; fails: number; last_seen: string }>
}

const WINDOW_MS = 60_000
const MAX_PER_MINUTE = 10
const LOCK_MS = 15 * 60_000
const LOCK_AFTER = 8

type Rec = { fails: number; streak: number; first: number; last: number; window: number[]; lockedUntil: number; accounts: Map<string, { fails: number; last: number }> }

const recs = new Map<string, Rec>()

function rec(ip: string): Rec {
  let r = recs.get(ip)
  if (!r) {
    r = { fails: 0, streak: 0, first: Date.now(), last: Date.now(), window: [], lockedUntil: 0, accounts: new Map() }
    recs.set(ip, r)
  }
  return r
}

export function lockedUntil(ip: string, now = Date.now()): number {
  const r = recs.get(ip)
  if (!r || r.lockedUntil <= now) return 0
  return r.lockedUntil
}

export function recordAttempt(ip: string, principal: string, ok: boolean, now = Date.now()): void {
  const r = rec(ip)
  r.last = now
  r.window = r.window.filter((t) => now - t < WINDOW_MS)
  r.window.push(now)
  if (ok) {
    r.streak = 0
    return
  }
  r.fails++
  r.streak++
  const a = r.accounts.get(principal) ?? { fails: 0, last: now }
  a.fails++
  a.last = now
  r.accounts.set(principal, a)
  if (r.streak >= LOCK_AFTER || r.window.length > MAX_PER_MINUTE) r.lockedUntil = now + LOCK_MS
}

export function snapshot(ip?: string): AttemptItem[] {
  const now = Date.now()
  const out: AttemptItem[] = []
  for (const [key, r] of recs) {
    if (ip && key !== ip) continue
    const windowCount = r.window.filter((t) => now - t < WINDOW_MS).length
    out.push({
      ip: key,
      fails: r.fails,
      fail_streak: r.streak,
      first_seen: new Date(r.first).toISOString(),
      last_seen: new Date(r.last).toISOString(),
      locked: r.lockedUntil > now,
      locked_until: r.lockedUntil > now ? new Date(r.lockedUntil).toISOString() : null,
      window_count: windowCount,
      max_per_minute: MAX_PER_MINUTE,
      distinct_ips: 1,
      sample_ips: [key],
      accounts: r.accounts.size,
      accounts_meta: [...r.accounts.entries()].map(([principal, v]) => ({
        principal,
        fails: v.fails,
        last_seen: new Date(v.last).toISOString(),
      })),
    })
  }
  return out.sort((a, b) => b.fails - a.fails)
}

/** 定向解锁：传 ip 只清那一台；不传全清 */
export function resetAttempts(ip?: string): number {
  if (!ip) {
    const n = recs.size
    recs.clear()
    return n
  }
  const had = recs.delete(ip)
  return had ? 1 : 0
}
