// 「设备与密钥」读数：会话 / 密钥 / 明细 IP 三张表按用户聚合。
// 只读；处置在登录侧（IP 拉黑、会话撤销），这一页只回答"谁看起来不对劲"。
// 排序与标红口径对齐 Go 的 handlers/admin/devices.go：排序键白名单、聚合后内存排序、
// 并列用 user_id 稳定、last_login 为空恒排后；标红只看 IP 且用设置里的阈值。
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

export type DeviceQuery = {
  page: number
  pageSize: number
  keyword?: string
  sort?: string
  dir?: string
  /** 统计窗口起点 ISO（window_days 天前，由调用方按 kernel/clock 算好） */
  windowStartIso: string
  /** 标红阈值：窗口内不同 IP 数达到该值 */
  suspectIps: number
}

export type DevicePage = {
  total: number
  page: number
  page_size: number
  list: DeviceRow[]
  sort: string
  dir: string
}

const SORT_KEYS = new Set(['sessions', 'devices', 'login_ips', 'call_ips', 'keys', 'revoked', 'last_login'])
const DEFAULT_SORT = 'sessions'

/** 排序用的可比数值；last_login 用 Date.parse，空值由调用方单独处理 */
function sortValue(r: DeviceRow, key: string): number {
  switch (key) {
    case 'devices': return r.login_devices
    case 'login_ips': return r.login_ips
    case 'call_ips': return r.call_ips
    case 'keys': return r.api_keys
    case 'revoked': return r.revoked_recent
    case 'last_login': return r.last_login_at ? Date.parse(r.last_login_at) : 0
    default: return r.active_sessions
  }
}

export class DbDevices {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  page(q: DeviceQuery): DevicePage {
    const sort = q.sort && SORT_KEYS.has(q.sort) ? q.sort : DEFAULT_SORT // 非法值回默认而非 400
    const dir = q.dir === 'asc' ? 'asc' : 'desc'
    const asc = dir === 'asc'

    const where = ['u.deleted_at IS NULL']
    const params: Array<string | number> = []
    if (q.keyword) {
      where.push('(lower(u.username) LIKE ? OR lower(u.nickname) LIKE ?)')
      const like = `%${q.keyword.toLowerCase()}%`
      params.push(like, like)
    }
    const clause = `WHERE ${where.join(' AND ')}`
    // 一次取全部命中用户再在内存里排序/分页（与 Go 同口径：排序值是聚合结果，不能拼进 ORDER BY；
    // 只在本页内排是假排序）。SQL 里的 call_ips 子查询带窗口起点，与 Go 的 WatchWindowStart 一致。
    const rows = this.db.all<Record<string, string | number | null>>(
      `SELECT u.id AS user_id, u.username AS username, COALESCE(p.name, '') AS plan_name,
              u.last_login_at AS last_login_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions,
              (SELECT COUNT(DISTINCT s.user_agent) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS login_devices,
              (SELECT COUNT(DISTINCT s.ip) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS login_ips,
              (SELECT COUNT(DISTINCT l.ip) FROM api_call_logs l JOIN users u2 ON u2.username = l.username WHERE u2.id = u.id AND l.created_at >= ?) AS call_ips,
              (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS api_keys,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NOT NULL) AS revoked_recent
         FROM users u LEFT JOIN plans p ON p.id = u.plan_id
         ${clause}
        ORDER BY u.id DESC`,
      new Date().toISOString(), q.windowStartIso, ...params,
    )
    const list: DeviceRow[] = rows.map((r) => {
      const ips = Number(r['login_ips'] ?? 0)
      const callIps = Number(r['call_ips'] ?? 0)
      return {
        user_id: Number(r['user_id']),
        username: String(r['username'] ?? ''),
        plan_name: String(r['plan_name'] ?? ''),
        active_sessions: Number(r['active_sessions'] ?? 0),
        login_devices: Number(r['login_devices'] ?? 0),
        login_ips: ips,
        call_ips: callIps,
        api_keys: Number(r['api_keys'] ?? 0),
        revoked_recent: Number(r['revoked_recent'] ?? 0),
        last_login_at: r['last_login_at'] === null ? null : String(r['last_login_at']),
        // 标红只看 IP（会话超上限在登录时已处置）：任一 IP 数达阈值即标红，与 Go 同口径
        suspect: ips >= q.suspectIps || callIps >= q.suspectIps,
      }
    })

    // 稳定排序：并列用 user_id 作二级键（与默认 id DESC 同向）；last_login 为空恒排最后（两种方向都是）
    list.sort((a, b) => {
      if (sort === 'last_login') {
        const an = a.last_login_at === null, bn = b.last_login_at === null
        if (an !== bn) return bn && !an ? 1 : -1 // 有值的一方恒在前
      }
      const av = sortValue(a, sort), bv = sortValue(b, sort)
      if (av !== bv) return asc ? av - bv : bv - av
      return b.user_id - a.user_id
    })

    const total = list.length
    const start = Math.min((q.page - 1) * q.pageSize, total)
    return {
      total,
      page: q.page,
      page_size: q.pageSize,
      list: list.slice(start, start + q.pageSize),
      sort,
      dir,
    }
  }
}
