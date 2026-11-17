// SQLite 持久化：node:sqlite（Node 22.5+ 内置，无 native/cgo 依赖——Go 版那边是 mattn/go-sqlite3）。
// 迁移写成 DDL 常量 + `CREATE TABLE IF NOT EXISTS`：先能读能写，drizzle 的迁移工具链等接口稳定再换，
// **接口不变**（③ §6 的分工：只有这一层碰持久化）。
// 为什么不是 drizzle 现在就上：它的 provider 只认 better-sqlite3/libsql，而后者要 native 构建；
// 本轮先零依赖跑通读写，schema 与 SQL 都是手写、可逐条审。
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type SqlValue = string | number | null
export type Row = Record<string, SqlValue>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  content_consent INTEGER NOT NULL DEFAULT 1,
  plan_id INTEGER,
  quota_reset_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  jti TEXT NOT NULL UNIQUE,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS system_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'string',
  description TEXT NOT NULL DEFAULT '',
  sensitive INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS data_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  media_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  in_band_error INTEGER NOT NULL DEFAULT 0,
  in_band_reason TEXT NOT NULL DEFAULT '',
  in_band_code TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  keyword TEXT NOT NULL DEFAULT '',
  book_name TEXT NOT NULL DEFAULT '',
  chapter_title TEXT NOT NULL DEFAULT '',
  book_ident TEXT NOT NULL DEFAULT '',
  chapter_ident TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '',
  result_count INTEGER NOT NULL DEFAULT 0,
  content_withheld INTEGER NOT NULL DEFAULT 0,
  plugin_version TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS api_call_stats (
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  max_latency_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, action)
);
CREATE TABLE IF NOT EXISTS quota_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  "limit" INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, scope, target)
);
CREATE TABLE IF NOT EXISTS user_quota_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  "limit" INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, scope, target)
);
CREATE TABLE IF NOT EXISTS quota_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  group_code TEXT NOT NULL,
  "interface" TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_code TEXT NOT NULL,
  "interface" TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  interval INTEGER NOT NULL DEFAULT 0,
  limit_count INTEGER NOT NULL DEFAULT 0,
  window_sec INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (group_code, "interface")
);
CREATE INDEX IF NOT EXISTS idx_limits_plan ON quota_limits(plan_id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON quota_usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON api_call_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_source ON api_call_logs(source, action);
CREATE INDEX IF NOT EXISTS idx_logs_plugin ON api_call_logs(plugin_version);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
`

export function nowIso(): string {
  return new Date().toISOString()
}

export class SqliteDb {
  readonly raw: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    // WAL：并发读不被写阻塞；外键交给 SQL 层显式维护（这里不开，避免 seed 顺序踩坑）
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;')
    this.raw.exec('PRAGMA busy_timeout = 5000;')
  }

  migrate(): void {
    this.raw.exec(SCHEMA)
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[]
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params)
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  /** 事务：node:sqlite 没有内置事务辅助，手写 BEGIN/COMMIT（异常必回滚） */
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    }
  }

  close(): void {
    this.cache.clear()
    this.raw.close()
  }
}

export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1'
}

export function boolInt(v: boolean): number {
  return v ? 1 : 0
}
