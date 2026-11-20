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
  username: string
  operator: string
  from_code: string
  to_code: string
  amount: number
  from_before: number
  from_after: number
  to_before: number
  to_after: number
  created_at: string
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

  // ---- 额度转移 ----
  /** 把自己两个源之间的**日限额**重排：转出减、转入加，总数不变；不限额端不参与 */
  transfer(input: { userId: number; username: string; operator: string; from: string; to: string; amount: number; planId: number | null }): TransferRow {
    const amount = Math.max(1, Math.trunc(input.amount))
    if (input.from === input.to) throw new Error('转出与转入不能是同一个源')
    return this.db.tx(() => {
      const fromLimit = this.quota.effectiveLimit(input.userId, input.planId, input.from)
      const toLimit = this.quota.effectiveLimit(input.userId, input.planId, input.to)
      if (fromLimit < 0 || toLimit < 0) throw new Error('不限额的数据源不参与转移')
      if (fromLimit < amount) throw new Error(`转出方额度不足（当前 ${fromLimit}）`)
      this.quota.setOverride(input.userId, 'source', input.from, fromLimit - amount)
      this.quota.setOverride(input.userId, 'source', input.to, toLimit + amount)
      const now = nowIso()
      const { lastInsertRowid } = this.db.run(
        `INSERT INTO quota_transfer_logs (user_id, username, operator, from_code, to_code, amount,
           from_before, from_after, to_before, to_after, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        input.userId, input.username, input.operator, input.from, input.to, amount,
        fromLimit, fromLimit - amount, toLimit, toLimit + amount, now,
      )
      return this.db.get<TransferRow>('SELECT * FROM quota_transfer_logs WHERE id = ?', lastInsertRowid)!
    })
  }

  transfers(q: { userId?: number; page: number; pageSize: number }): { total: number; page: number; page_size: number; list: TransferRow[] } {
    const where = ['deleted_at IS NULL']
    const params: SqlValue[] = []
    if (q.userId !== undefined) {
      where.push('user_id = ?')
      params.push(q.userId)
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM quota_transfer_logs ${clause}`, ...params)?.n ?? 0
    const list = this.db.all<TransferRow>(
      `SELECT * FROM quota_transfer_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, q.pageSize, (q.page - 1) * q.pageSize,
    )
    return { total, page: q.page, page_size: q.pageSize, list }
  }

  /** 清除 = 软删（行留库里，管理端仍可查） */
  clearTransfers(userId: number): number {
    return this.db.run('UPDATE quota_transfer_logs SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL', nowIso(), userId).changes
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
