// 数据源默认地址（平台级 / 个人级）：面板「数据源」与「个人中心」两页读写同一对表。
// 空串 = 删除该行（回落到上层：个人 → 平台 → 源内置；这条回落顺序在 middleware/source 里）。
import { type Database, nowIso } from './sqlite.ts'

export class DbSourceConfigs {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  platform(): Record<string, string> {
    const rows = this.db.all<{ source_name: string; base_url: string }>('SELECT source_name, base_url FROM platform_source_configs')
    return Object.fromEntries(rows.map((r) => [r.source_name, r.base_url]))
  }

  setPlatform(source: string, baseUrl: string): void {
    if (!baseUrl) {
      this.db.run('DELETE FROM platform_source_configs WHERE source_name = ?', source)
      return
    }
    this.db.run(
      `INSERT INTO platform_source_configs (source_name, base_url, updated_at) VALUES (?,?,?)
       ON CONFLICT(source_name) DO UPDATE SET base_url = excluded.base_url, updated_at = excluded.updated_at`,
      source, baseUrl, nowIso(),
    )
  }

  user(userId: number): Record<string, string> {
    const rows = this.db.all<{ source_name: string; base_url: string }>(
      'SELECT source_name, base_url FROM user_source_configs WHERE user_id = ?', userId,
    )
    return Object.fromEntries(rows.map((r) => [r.source_name, r.base_url]))
  }

  setUser(userId: number, source: string, baseUrl: string): void {
    if (!baseUrl) {
      this.db.run('DELETE FROM user_source_configs WHERE user_id = ? AND source_name = ?', userId, source)
      return
    }
    this.db.run(
      `INSERT INTO user_source_configs (user_id, source_name, base_url, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id, source_name) DO UPDATE SET base_url = excluded.base_url, updated_at = excluded.updated_at`,
      userId, source, baseUrl, nowIso(),
    )
  }
}
