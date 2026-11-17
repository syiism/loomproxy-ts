// 池的设备持久化：实现 contract 里的 DeviceStore 端口（**不 import @loomproxy/pool**，
// 只认那张形状——这是"声明在契约、实现在下游"的单向依赖写法）。
import type { DeviceStore, PoolDeviceRow, PoolStatus } from '@loomproxy/contract'
import { SqliteDb, nowIso, type SqlValue } from './sqlite.ts'

type Row = {
  ident: string
  attrs: string
  payload: string | null
  status: string
  total_quota: number
  used_quota: number
  expire_at: string | null
  note: string
  created_at: string
  updated_at: string
}

export class DbPoolDevices implements DeviceStore {
  private readonly db: SqliteDb

  constructor(db: SqliteDb) {
    this.db = db
  }

  load(pool: string): PoolDeviceRow[] {
    return this.db.all<Row>('SELECT * FROM pool_devices WHERE pool = ? ORDER BY id', pool).map((r) => this.row(r))
  }

  save(pool: string, row: PoolDeviceRow): void {
    this.db.run(
      `INSERT INTO pool_devices (pool, ident, attrs, payload, status, total_quota, used_quota, expire_at, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(pool, ident) DO UPDATE SET
         attrs = excluded.attrs, payload = excluded.payload, status = excluded.status,
         total_quota = excluded.total_quota, used_quota = excluded.used_quota,
         expire_at = excluded.expire_at, note = excluded.note, updated_at = excluded.updated_at`,
      pool, row.ident, JSON.stringify(row.attrs ?? {}), row.payload === undefined ? null : JSON.stringify(row.payload),
      row.status, row.total_quota, row.used_quota, row.expire_at, row.note ?? '', row.created_at, row.updated_at,
    )
  }

  update(
    pool: string,
    ident: string,
    patch: Partial<Pick<PoolDeviceRow, 'status' | 'total_quota' | 'used_quota' | 'expire_at' | 'note'>>,
  ): void {
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      sets.push(`${k} = ?`)
      params.push(v as SqlValue)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    params.push(nowIso(), pool, ident)
    this.db.run(`UPDATE pool_devices SET ${sets.join(', ')} WHERE pool = ? AND ident = ?`, ...params)
  }

  remove(pool: string, ident: string): void {
    this.db.run('DELETE FROM pool_devices WHERE pool = ? AND ident = ?', pool, ident)
  }

  private row(r: Row): PoolDeviceRow {
    return {
      ident: r.ident,
      attrs: safeJson<Record<string, string>>(r.attrs, {}),
      ...(r.payload ? { payload: safeJson<unknown>(r.payload, undefined) } : {}),
      status: r.status as PoolStatus,
      total_quota: r.total_quota,
      used_quota: r.used_quota,
      expire_at: r.expire_at,
      ...(r.note ? { note: r.note } : {}),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }
  }
}

function safeJson<T>(raw: string, def: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return def
  }
}
