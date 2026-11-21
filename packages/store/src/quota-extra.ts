// 额度域的三块延伸：套餐级限速覆盖、额度转移、卡密兑换。
// 都与主表同库同事务——转移/兑换是"要么全成要么不动"的多行改动，不许两个入口各写一半。
import { randomBytes } from 'node:crypto'
import { type Database, nowIso, type SqlValue } from './sqlite.ts'
import type { DbQuota } from './quota.ts'

export type CostPlanRow = {
  id: number
  plan_id: number
  group_code: string
  interface: string
  interval: number
  limit_count: number
  window_sec: number
}
export type TransferRow = {
  id: number
  user_id: number
  operator_id: number
  via: 'self' | 'admin'
  from_code: string
  to_code: string
  amount: number
  from_before: number
  from_after: number
  to_before: number
  to_after: number
  from_override: number
  to_override: number
  created_at: string
  cleared_at: string | null
}

/** 与 Go gate.TransferErrorStatus 一一对应：成因 → 给用户看的固定句 / HTTP 状态码 */
export const TRANSFER_ERRORS = {
  amount: [400, '转移数量必须是正整数'],
  same: [400, '转出与转入是同一个数据源'],
  source: [400, '数据源不存在或已停用'],
  unlimited: [400, '不限额的源不参与转移'],
  no_grant: [400, '目标源未授权给该用户'],
  insufficient: [400, '转出源的当日限额不足'],
} as const
export type TransferErrorCode = keyof typeof TRANSFER_ERRORS

export function transferError(code: TransferErrorCode): Error & { transferCode: TransferErrorCode } {
  return Object.assign(new Error(TRANSFER_ERRORS[code][1]), { transferCode: code })
}
export function transferStatus(e: unknown): number {
  const code = (e as { transferCode?: TransferErrorCode } | undefined)?.transferCode
  return code ? TRANSFER_ERRORS[code][0] : 500
}
export type RedeemRow = {
  id: number
  code: string
  batch_no: string
  plan_id: number
  plan_name: string
  status: number
  created_at: string
  used_at: string | null
  used_by: number | null
}

export class DbQuotaExtra {
  private readonly db: Database
  private readonly quota: DbQuota

  constructor(db: Database, quota: DbQuota) {
    this.db = db
    this.quota = quota
  }

  // ---- 套餐级接口限速（覆盖全局） ----
  costPlans(): CostPlanRow[] {
    return this.db.all<CostPlanRow>('SELECT * FROM quota_cost_plans ORDER BY plan_id, group_code, "interface"')
  }

  upsertCostPlan(input: { plan_id: number; group_code: string; interface: string; interval?: number; limit_count?: number; window_sec?: number }): void {
    const now = nowIso()
    this.db.run(
      `INSERT INTO quota_cost_plans (plan_id, group_code, "interface", interval, limit_count, window_sec, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(plan_id, group_code, "interface") DO UPDATE SET
         interval = excluded.interval, limit_count = excluded.limit_count,
         window_sec = excluded.window_sec, updated_at = excluded.updated_at`,
      input.plan_id, input.group_code, input.interface, input.interval ?? 0,
      input.limit_count ?? 0, input.window_sec ?? 60, now, now,
    )
  }

  updateCostPlan(id: number, patch: { interval?: number; limit_count?: number; window_sec?: number }): void {
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      sets.push(`${k} = ?`)
      params.push(v as SqlValue)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    params.push(nowIso(), id)
    this.db.run(`UPDATE quota_cost_plans SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  /** 限流参数：套餐覆盖优先，其次全局成本行（两者都没有 = 不限） */
  rateSpecFor(planId: number | null, source: string, action: string): { intervalMs?: number; count?: number; windowMs?: number } {
    if (planId !== null) {
      const p = this.db.get<{ interval: number; limit_count: number; window_sec: number }>(
        'SELECT interval, limit_count, window_sec FROM quota_cost_plans WHERE plan_id = ? AND group_code = ? AND "interface" = ?',
        planId, source, action,
      )
      if (p && (p.limit_count > 0 || p.interval > 0)) {
        return p.limit_count > 0
          ? { count: p.limit_count, windowMs: Math.max(1, p.window_sec) * 1000 }
          : { intervalMs: Math.max(1, p.interval) * 1000 }
      }
    }
    const g = this.quota.costOf(source, action)
    if (g && g.limit_count > 0) return { count: g.limit_count, windowMs: Math.max(1, g.window_sec) * 1000 }
    if (g && g.interval > 0) return { intervalMs: g.interval * 1000 }
    return {}
  }

  // ---- 额度转移（与 Go gate/transfer.go + transfer_math.go 逐条对齐） ----
  /**
   * 一次转移的完整算式：*Before/*After 是**有效额度**，*OverrideAfter 是写回覆盖行的**增量**。
   * 纯函数，守恒（转出恰减、转入恰加）与「超额直接拒，不许夹到 0 后继续」都在这里钉住。
   */
  static transferPlan(baseFrom: number, ovFrom: number, baseTo: number, ovTo: number, amount: number) {
    const clamp = (v: number) => Math.max(0, v)
    if (amount <= 0) return undefined
    const fromBefore = clamp(baseFrom + ovFrom)
    const toBefore = clamp(baseTo + ovTo)
    if (fromBefore < amount) return undefined
    const fromAfter = fromBefore - amount
    const toAfter = clamp(toBefore + amount)
    return {
      fromBefore, fromAfter, toBefore, toAfter,
      fromOverrideAfter: fromAfter - baseFrom,
      toOverrideAfter: toAfter - baseTo,
    }
  }

  /**
   * 执行转移：两端都必须是存在且启用的数据源、目标须已授权、两端都不能是 -1（不限）；
   * 覆盖行写增量（0 删行），审计行与两行覆盖同事务。operatorId/via 区分本人与管理员操作。
   */
  transfer(input: { userId: number; operatorId: number; via: 'self' | 'admin'; from: string; to: string; amount: number; planId: number | null }): TransferRow {
    const amount = Math.trunc(Number(input.amount))
    if (!Number.isFinite(amount) || amount <= 0) throw transferError('amount')
    if (!input.from || !input.to) throw transferError('source')
    if (input.from === input.to) throw transferError('same')
    const active = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM data_sources WHERE name IN (?,?) AND status = 1', input.from, input.to,
    )?.n ?? 0
    if (active !== 2) throw transferError('source')

    const baseFrom = this.quota.baseLimitOf(input.planId, input.from)
    const baseTo = this.quota.baseLimitOf(input.planId, input.to)
    if (baseTo < 0) {
      const granted = input.planId !== null && this.quota.hasGrant(input.planId, input.to)
      throw transferError(granted ? 'unlimited' : 'no_grant')
    }
    if (baseFrom < 0) throw transferError('unlimited')

    const math = DbQuotaExtra.transferPlan(
      baseFrom, this.quota.overrideRaw(input.userId, input.from),
      baseTo, this.quota.overrideRaw(input.userId, input.to),
      amount,
    )
    if (!math) throw transferError('insufficient')

    return this.db.tx(() => {
      // 两行覆盖是同一个事务里的**增量**写回；0 表示删行（回到无覆盖）
      this.quota.setOverride(input.userId, 'source', input.from, math.fromOverrideAfter)
      this.quota.setOverride(input.userId, 'source', input.to, math.toOverrideAfter)
      const now = nowIso()
      const { lastInsertRowid } = this.db.run(
        `INSERT INTO quota_transfer_logs (user_id, operator_id, via, from_code, to_code, amount,
           from_before, from_after, to_before, to_after, from_override, to_override, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.userId, input.operatorId, input.via, input.from, input.to, amount,
        math.fromBefore, math.fromAfter, math.toBefore, math.toAfter,
        math.fromOverrideAfter, math.toOverrideAfter, now,
      )
      return this.db.get<TransferRow>('SELECT * FROM quota_transfer_logs WHERE id = ?', lastInsertRowid)!
    })
  }

  /** includeCleared=false = 本人视角（清掉的不再看见）；true = 管理端审计面，一概不过滤 */
  transfers(q: { userId?: number; page: number; pageSize: number; includeCleared?: boolean }): { total: number; page: number; page_size: number; list: TransferRow[] } {
    const where: string[] = q.includeCleared ? [] : ['cleared_at IS NULL']
    const params: SqlValue[] = []
    if (q.userId !== undefined) {
      where.push('user_id = ?')
      params.push(q.userId)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM quota_transfer_logs ${clause}`, ...params)?.n ?? 0
    const list = this.db.all<TransferRow>(
      `SELECT * FROM quota_transfer_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, q.pageSize, (q.page - 1) * q.pageSize,
    )
    return { total, page: q.page, page_size: q.pageSize, list }
  }

  /** 本人清除 = 软删（行留库里，管理端审计面仍可查） */
  clearTransfers(userId: number): number {
    return this.db.run('UPDATE quota_transfer_logs SET cleared_at = ? WHERE user_id = ? AND cleared_at IS NULL', nowIso(), userId).changes
  }

  // ---- 卡密 ----
  createRedeemCodes(input: { count: number; planId: number; planName: string; batchNo?: string }): RedeemRow[] {
    const batch = input.batchNo ?? `B${Date.now().toString(36).toUpperCase()}`
    const out: RedeemRow[] = []
    this.db.tx(() => {
      for (let i = 0; i < Math.max(1, Math.min(500, input.count)); i++) {
        const code = `LP-${randomBytes(6).toString('hex').toUpperCase()}`
        const now = nowIso()
        const { lastInsertRowid } = this.db.run(
          'INSERT INTO redeem_codes (code, batch_no, plan_id, plan_name, status, created_at) VALUES (?,?,?,?,1,?)',
          code, batch, input.planId, input.planName, now,
        )
        out.push(this.db.get<RedeemRow>('SELECT * FROM redeem_codes WHERE id = ?', lastInsertRowid)!)
      }
    })
    return out
  }

  redeemCodes(q: { page: number; pageSize: number; batchNo?: string; status?: string; planId?: number }): {
    total: number
    page: number
    page_size: number
    list: RedeemRow[]
  } {
    const where: string[] = []
    const params: SqlValue[] = []
    if (q.batchNo) { where.push('batch_no = ?'); params.push(q.batchNo) }
    if (q.status === 'unused') where.push('status = 1')
    if (q.status === 'used') where.push('status = 2')
    if (q.status === 'revoked') where.push('status = 0')
    if (q.planId) { where.push('plan_id = ?'); params.push(q.planId) }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM redeem_codes ${clause}`, ...params)?.n ?? 0
    const list = this.db.all<RedeemRow>(
      `SELECT * FROM redeem_codes ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, q.pageSize, (q.page - 1) * q.pageSize,
    )
    return { total, page: q.page, page_size: q.pageSize, list }
  }

  revokeRedeemCode(id: number): boolean {
    return this.db.run('UPDATE redeem_codes SET status = 0 WHERE id = ? AND status = 1', id).changes > 0
  }

  revokeRedeemCodes(ids: number[]): number {
    let n = 0
    this.db.tx(() => {
      for (const id of ids) n += this.db.run('UPDATE redeem_codes SET status = 0 WHERE id = ? AND status = 1', id).changes
    })
    return n
  }

  revokeRedeemBatch(batchNo: string): number {
    return this.db.run('UPDATE redeem_codes SET status = 0 WHERE batch_no = ? AND status = 1', batchNo).changes
  }

  /** 兑换：核销 + 换套餐在一个事务里；重复兑换被 status 条件挡住 */
  redeem(input: { code: string; userId: number; username: string }): { plan: { id: number; name: string; code: string } } {
    return this.db.tx(() => {
      const row = this.db.get<RedeemRow>('SELECT * FROM redeem_codes WHERE code = ?', input.code.trim().toUpperCase())
      if (!row) throw new Error('卡密不存在')
      if (row.status !== 1) throw new Error('卡密已被使用或作废')
      this.db.run('UPDATE redeem_codes SET status = 2, used_at = ?, used_by = ? WHERE id = ?', nowIso(), input.userId, row.id)
      this.quota.setPlan(input.userId, row.plan_id)
      const plan = this.db.get<{ id: number; name: string; code: string }>('SELECT id, name, code FROM plans WHERE id = ?', row.plan_id)
      if (!plan) throw new Error('卡密绑定的套餐已不存在')
      return { plan }
    })
  }
}
