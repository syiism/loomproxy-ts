// 额度域（额度=授权，见 gate/grant.go 的同一口径）：套餐限额既是"能给多少"也是"能不能用这个源"。
// 生效顺序：用户覆盖 → 套餐限额 → 不限（没有限额行 = 该套餐不含这个源，访问判定那边据此拒绝）。
import { type Database, nowIso, type SqlValue } from './sqlite.ts'

export type LimitRow = { id: number; plan_id: number; scope: string; target: string; limit: number; created_at: string; updated_at: string }
export type CostRow = {
  id: number
  group_code: string
  interface: string
  cost: number
  status: number
  interval: number
  limit_count: number
  window_sec: number
}
export type UsageRow = { id: number; user_id: number; username: string; group_code: string; interface: string; cost: number; created_at: string }

/**
 * 接口默认成本档（**唯一一处**）：只有正文（content）消耗 1 单位。
 * 检索/详情/目录默认免费——它们是"找到正文"的前置步骤，按次计费会让"翻目录"比"读正文"还贵。
 * 免费动作也建行（成本 0）：面板「接口」页是按行编辑的，没有行就没有 id，改成本的请求会静默打空。
 * 管理员改完立刻生效（读侧每次现取），不走重启。
 */
export const DEFAULT_ACTION_COST: Readonly<Record<string, number>> = { content: 1 }

export function defaultCostFor(action: string): number {
  return DEFAULT_ACTION_COST[action] ?? 0
}

export class DbQuota {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  // ---- 套餐限额（= 授权） ----
  limitsOfPlan(planId: number): LimitRow[] {
    return this.db.all<LimitRow>('SELECT * FROM quota_limits WHERE plan_id = ? ORDER BY id', planId)
  }

  grantedSources(planId: number): LimitRow[] {
    return this.db.all<LimitRow>("SELECT * FROM quota_limits WHERE plan_id = ? AND scope = 'source' ORDER BY target", planId)
  }

  /**
   * 默认成本行（**只有正文 content 计 1 单位，其余动作 0**）：缺这一行 = 该接口不计费。
   * 为什么给免费动作也建行：面板「接口」页是按行编辑的（`PUT /admin/quota-costs/:id`），
   * 没有行就没有 id，改成本的请求会静默打空——"免费"必须是**可编辑的 0**，不是"没有这一行"。
   * 装配期扫描与运行期「安装插件」必须走同一条（两处各抄一份就会漂移成
   * "启动时装好的源计费、后装的源免费"）。
   */
  ensureDefaultCosts(code: string, actions: readonly string[]): void {
    for (const action of actions) {
      if (!this.costOf(code, action)) this.upsertCost({ group_code: code, interface: action, cost: defaultCostFor(action) })
    }
  }

  /** 批量授权（幂等 upsert）：同一 (plan, scope, target) 只留一行 */
  grant(planId: number, scope: string, target: string, limit: number): void {
    const now = nowIso()
    this.db.run(
      `INSERT INTO quota_limits (plan_id, scope, target, "limit", created_at, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(plan_id, scope, target) DO UPDATE SET "limit" = excluded."limit", updated_at = excluded.updated_at`,
      planId, scope, target, limit, now, now,
    )
  }

  createLimit(input: { plan_id: number; scope: string; target: string; limit: number }): number {
    this.grant(input.plan_id, input.scope, input.target, input.limit)
    return this.db.get<{ id: number }>(
      'SELECT id FROM quota_limits WHERE plan_id = ? AND scope = ? AND target = ?',
      input.plan_id, input.scope, input.target,
    )!.id
  }

  updateLimit(id: number, limit: number): void {
    this.db.run('UPDATE quota_limits SET "limit" = ?, updated_at = ? WHERE id = ?', limit, nowIso(), id)
  }

  removeLimit(id: number): boolean {
    return this.db.run('DELETE FROM quota_limits WHERE id = ?', id).changes > 0
  }

  cloneSources(toPlanId: number, fromPlanId: number): number {
    const rows = this.grantedSources(fromPlanId)
    for (const r of rows) this.grant(toPlanId, r.scope, r.target, r.limit)
    return rows.length
  }

  // ---- 用户覆盖 ----
  overridesOf(userId: number): LimitRow[] {
    return this.db.all<LimitRow>('SELECT * FROM user_quota_overrides WHERE user_id = ? ORDER BY id', userId)
  }

  /**
   * 写用户覆盖**增量**（Go putOverride 同口径）：正数追加、负数扣减，0 = 没有覆盖（删行而不是留 0）。
   * 面板与转移都按增量解释；写绝对值会把「转 100 出去」变成「变成 100+套餐限额」。
   */
  setOverride(userId: number, scope: string, target: string, delta: number): void {
    const now = nowIso()
    if (delta === 0) {
      this.db.run('DELETE FROM user_quota_overrides WHERE user_id = ? AND scope = ? AND target IN (?)', userId, scope, target)
      return
    }
    this.db.run(
      `INSERT INTO user_quota_overrides (user_id, scope, target, "limit", created_at, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id, scope, target) DO UPDATE SET "limit" = excluded."limit", updated_at = excluded.updated_at`,
      userId, scope, target, delta, now, now,
    )
  }

  /** 原始覆盖增量（没有行 = 0）；判定用 effectiveLimit，转移写库用这个 */
  overrideRaw(userId: number, source: string): number {
    return this.db.get<{ lim: number }>(
      'SELECT "limit" AS lim FROM user_quota_overrides WHERE user_id = ? AND scope = ? AND target IN (?, \'*\') LIMIT 1',
      userId, 'source', source,
    )?.lim ?? 0
  }

  /** 套餐源限额；没有行 = -1（不限/未授权，访问轴另有判定） */
  baseLimitOf(planId: number | null, source: string): number {
    if (planId === null) return -1
    const row = this.db.get<{ lim: number }>(
      'SELECT "limit" AS lim FROM quota_limits WHERE plan_id = ? AND scope = ? AND target IN (?, \'*\') LIMIT 1',
      planId, 'source', source,
    )
    return row ? row.lim : -1
  }

  clearOverrides(userId: number): number {
    return this.db.run('DELETE FROM user_quota_overrides WHERE user_id = ?', userId).changes
  }

  /**
   * **有没有授权**（本套餐有没有这个源的行）。授权与额度是两件事：
   * 行存在 = 能用；额度 -1 = 不限。混用会让"授权了但额度填 -1"的源从看板上消失。
   */
  hasGrant(planId: number | null, source: string): boolean {
    if (planId === null) return false
    return (this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM quota_limits WHERE plan_id = ? AND scope = ? AND target IN (?, \'*\')',
      planId, 'source', source,
    )?.n ?? 0) > 0
  }

  /** 生效额度：覆盖优先，其次套餐；-1 = 不限（plan 里没有这一行时也回 -1） */
  /** 有效日额度 = clamp(套餐限额 + 覆盖增量)；套餐不限（-1）时覆盖不生效（Go EffectiveSourceLimit 同口径） */
  effectiveLimit(userId: number, planId: number | null, source: string): number {
    const base = this.baseLimitOf(planId, source)
    if (base < 0) return -1
    return Math.max(0, base + this.overrideRaw(userId, source))
  }



  // ---- 用量 ----
  /** 当天已用（日界按用户起算点 quota_reset_at；没设就用自然日 0 点） */
  usedSince(userId: number, source: string, sinceIso: string): number {
    return this.db.get<{ n: number }>(
      'SELECT COALESCE(SUM(cost), 0) AS n FROM quota_usage_logs WHERE user_id = ? AND group_code = ? AND created_at >= ?',
      userId, source, sinceIso,
    )?.n ?? 0
  }

  // ---- 汇总读数（管理员视角 / 首页看板） ----
  usedTodayAll(source: string, sinceIso: string): number {
    return this.db.get<{ n: number }>(
      'SELECT COALESCE(SUM(cost), 0) AS n FROM quota_usage_logs WHERE group_code = ? AND created_at >= ?',
      source, sinceIso,
    )?.n ?? 0
  }

  activeUsersForSource(source: string, sinceIso: string): number {
    return this.db.get<{ n: number }>(
      'SELECT COUNT(DISTINCT user_id) AS n FROM quota_usage_logs WHERE group_code = ? AND created_at >= ?',
      source, sinceIso,
    )?.n ?? 0
  }

  activeUsersAll(sinceIso: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(DISTINCT user_id) AS n FROM quota_usage_logs WHERE created_at >= ?', sinceIso)?.n ?? 0
  }

  callCountSince(sinceIso: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_call_logs WHERE created_at >= ?', sinceIso)?.n ?? 0
  }

  appendUsage(row: { user_id: number; username: string; group_code: string; action: string; cost: number }): void {
    this.db.run(
      'INSERT INTO quota_usage_logs (user_id, username, group_code, "interface", cost, created_at) VALUES (?,?,?,?,?,?)',
      row.user_id, row.username, row.group_code, row.action, row.cost, nowIso(),
    )
  }

  usagePage(q: { page: number; pageSize: number; userId?: number; username?: string; groupCode?: string }): {
    total: number
    page: number
    page_size: number
    list: UsageRow[]
  } {
    // username 不落在 quota_usage_logs（线上 MySQL 无此列，SQLite 的冗余列也不可信），
    // 与 Go 同口径：JOIN users 补用户名；按用户名搜索也走 users.username 模糊匹配。
    const join = q.username ? 'JOIN users u ON u.id = l.user_id' : 'LEFT JOIN users u ON u.id = l.user_id'
    const where: string[] = []
    const params: SqlValue[] = []
    if (q.userId !== undefined) { where.push('l.user_id = ?'); params.push(q.userId) }
    if (q.username) { where.push('u.username LIKE ?'); params.push(`%${q.username}%`) }
    if (q.groupCode) { where.push('l.group_code = ?'); params.push(q.groupCode) }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const from = `FROM quota_usage_logs l ${join} ${clause}`
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, ...params)?.n ?? 0
    const list = this.db.all<UsageRow>(
      `SELECT l.id, l.user_id, u.username AS username, l.group_code, l.\`interface\`, l.cost, l.created_at
         ${from} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      ...params, q.pageSize, (q.page - 1) * q.pageSize,
    )
    return { total, page: q.page, page_size: q.pageSize, list }
  }

  /** 用户手工刷新过额度的时刻（没刷过为 null）——面板要和下发起算点一起回显 */
  resetAt(userId: number): string | null {
    return this.db.get<{ quota_reset_at: string | null }>('SELECT quota_reset_at FROM users WHERE id = ?', userId)?.quota_reset_at ?? null
  }

  /** 日界起算点：users.quota_reset_at 优先，否则当天 0 点（平台时区见 kernel/clock） */
  startOfWindow(userId: number, tzOffsetHours: number): string {
    const raw = this.db.get<{ quota_reset_at: string | null }>('SELECT quota_reset_at FROM users WHERE id = ?', userId)?.quota_reset_at
    if (raw) return raw
    const offsetMs = tzOffsetHours * 3600_000
    const now = Date.now() + offsetMs
    return new Date(Math.floor(now / 86_400_000) * 86_400_000 - offsetMs).toISOString()
  }

  refreshStart(userId: number): void {
    this.db.run('UPDATE users SET quota_reset_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), userId)
  }

  setPlan(userId: number, planId: number | null): void {
    this.db.run('UPDATE users SET plan_id = ?, updated_at = ? WHERE id = ?', planId, nowIso(), userId)
  }

  // ---- 接口消耗（Interfaces 页）----
  costs(): CostRow[] {
    return this.db.all<CostRow>('SELECT * FROM quota_costs ORDER BY group_code, "interface"')
  }

  costOf(source: string, action: string): CostRow | undefined {
    return this.db.get<CostRow>('SELECT * FROM quota_costs WHERE group_code = ? AND "interface" = ?', source, action)
  }

  upsertCost(input: { group_code: string; interface: string; cost: number; status?: number; interval?: number; limit_count?: number; window_sec?: number }): void {
    const now = nowIso()
    this.db.run(
      `INSERT INTO quota_costs (group_code, "interface", cost, status, interval, limit_count, window_sec, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(group_code, "interface") DO UPDATE SET
         cost = excluded.cost, status = excluded.status, interval = excluded.interval,
         limit_count = excluded.limit_count, window_sec = excluded.window_sec, updated_at = excluded.updated_at`,
      input.group_code, input.interface, input.cost, input.status ?? 1, input.interval ?? 0,
      input.limit_count ?? 0, input.window_sec ?? 60, now, now,
    )
  }

  updateCost(id: number, patch: { cost?: number; status?: number; interval?: number; limit_count?: number; window_sec?: number }): void {
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      sets.push(`"${k}" = ?`)
      params.push(v as SqlValue)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    params.push(nowIso(), id)
    this.db.run(`UPDATE quota_costs SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }
}
