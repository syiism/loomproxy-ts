// IP 黑名单：登录/注册/数据面三处共用一个判定口（三份事实＝三处漏法）。
import { SqliteDb, nowIso } from './sqlite.ts'

export type BlockedIP = { id: number; ip: string; reason: string; created_at: string }

export class DbBlockedIPs {
  private readonly db: SqliteDb

  constructor(db: SqliteDb) {
    this.db = db
  }

  list(): BlockedIP[] {
    return this.db.all<BlockedIP>('SELECT * FROM blocked_ips ORDER BY id DESC')
  }

  isBlocked(ip: string): boolean {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blocked_ips WHERE ip = ?', ip)?.n === 1
  }

  add(ip: string, reason = ''): BlockedIP {
    const now = nowIso()
    this.db.run(
      'INSERT INTO blocked_ips (ip, reason, created_at) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason',
      ip, reason, now,
    )
    return this.db.get<BlockedIP>('SELECT * FROM blocked_ips WHERE ip = ?', ip)!
  }

  remove(id: number): boolean {
    return this.db.run('DELETE FROM blocked_ips WHERE id = ?', id).changes > 0
  }

  removeByIP(ip: string): boolean {
    return this.db.run('DELETE FROM blocked_ips WHERE ip = ?', ip).changes > 0
  }
}
