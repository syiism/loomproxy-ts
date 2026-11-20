// 「设备与密钥」读数：会话 / 密钥 / 明细 IP 三张表按用户聚合。
// 只读；处置在登录侧（IP 拉黑、会话撤销），这一页只回答"谁看起来不对劲"。
import { type Database } from './sqlite.ts'

export type DeviceRow = {
  user_id: number
  username: string
  plan_name: string
  active_sessions: number
  login_devices: number
  login_ips: number
  call_ips: number
  api_keys: number
  revoked_recent: number
  last_login_at: string | null
  suspect: boolean
}

export class DbDevices {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  page(q: { page: number; pageSize: number; keyword?: string }): { total: number; page: number; page_size: number; list: DeviceRow[] } {
    const where = ['u.deleted_at IS NULL']
    const params: Array<string | number> = []
    if (q.keyword) {
      where.push('(lower(u.username) LIKE ? OR lower(u.nickname) LIKE ?)')
      const like = `%${q.keyword.toLowerCase()}%`
      params.push(like, like)
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${clause}`, ...params)?.n ?? 0
    const rows = this.db.all<Record<string, string | number | null>>(
      `SELECT u.id AS user_id, u.username AS username, COALESCE(p.name, '') AS plan_name,
              u.last_login_at AS last_login_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions,
              (SELECT COUNT(DISTINCT s.user_agent) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS login_devices,
              (SELECT COUNT(DISTINCT s.ip) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS login_ips,
              (SELECT COUNT(DISTINCT l.ip) FROM api_call_logs l JOIN users u2 ON u2.username = l.username WHERE u2.id = u.id) AS call_ips,
              (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS api_keys,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NOT NULL) AS revoked_recent
         FROM users u LEFT JOIN plans p ON p.id = u.plan_id
         ${clause}
         ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      new Date().toISOString(), ...params, q.pageSize, (q.page - 1) * q.pageSize,
    )
    const list: DeviceRow[] = rows.map((r) => {
      const active = Number(r['active_sessions'] ?? 0)
      const ips = Number(r['login_ips'] ?? 0)
      return {
        user_id: Number(r['user_id']),
        username: String(r['username'] ?? ''),
        plan_name: String(r['plan_name'] ?? ''),
        active_sessions: active,
        login_devices: Number(r['login_devices'] ?? 0),
        login_ips: ips,
        call_ips: Number(r['call_ips'] ?? 0),
        api_keys: Number(r['api_keys'] ?? 0),
        revoked_recent: Number(r['revoked_recent'] ?? 0),
        last_login_at: r['last_login_at'] === null ? null : String(r['last_login_at']),
        // 判据与 Go 版同形：活跃会话 > 3 或 登录 IP > 5 就标红（只标红，不处置）
        suspect: active > 3 || ips > 5,
      }
    })
    return { total, page: q.page, page_size: q.pageSize, list }
  }
}
