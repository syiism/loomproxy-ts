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
  revoked_at TEXT,
  last_active_at TEXT
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
  group_id INTEGER,
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
CREATE TABLE IF NOT EXISTS quota_cost_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  group_code TEXT NOT NULL,
  "interface" TEXT NOT NULL,
  interval INTEGER NOT NULL DEFAULT 0,
  limit_count INTEGER NOT NULL DEFAULT 0,
  window_sec INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, group_code, "interface")
);
CREATE TABLE IF NOT EXISTS quota_transfer_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '',
  from_code TEXT NOT NULL,
  to_code TEXT NOT NULL,
  amount INTEGER NOT NULL,
  from_before INTEGER NOT NULL,
  from_after INTEGER NOT NULL,
  to_before INTEGER NOT NULL,
  to_after INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  batch_no TEXT NOT NULL DEFAULT '',
  plan_id INTEGER NOT NULL,
  plan_name TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by INTEGER
);
CREATE TABLE IF NOT EXISTS source_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_source_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'daily',
  start_clock TEXT NOT NULL DEFAULT '',
  end_clock TEXT NOT NULL DEFAULT '',
  start_at TEXT,
  duration_min INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool TEXT NOT NULL,
  ident TEXT NOT NULL,
  attrs TEXT NOT NULL DEFAULT '{}',
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'cold',
  total_quota INTEGER NOT NULL DEFAULT 0,
  used_quota INTEGER NOT NULL DEFAULT 0,
  expire_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (pool, ident)
);
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS name_cache (
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  ident TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, source, ident)
);
CREATE TABLE IF NOT EXISTS blocked_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_source_configs (
  source_name TEXT PRIMARY KEY,
  base_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_source_configs (
  user_id INTEGER NOT NULL,
  source_name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, source_name)
);
CREATE INDEX IF NOT EXISTS idx_limits_plan ON quota_limits(plan_id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON quota_usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON api_call_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_source ON api_call_logs(source, action);
CREATE INDEX IF NOT EXISTS idx_logs_plugin ON api_call_logs(plugin_version);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);

-- 验证码：发码(Issue)→校验(Check)→业务成功后消费(Consume)。与 Go verification_codes 表逐列对齐。
CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene TEXT NOT NULL,
  target TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vc_scene_target ON verification_codes(scene, target);
CREATE INDEX IF NOT EXISTS idx_vc_target_time ON verification_codes(target, created_at);
CREATE INDEX IF NOT EXISTS idx_vc_ip_time ON verification_codes(ip, created_at);
`

export function nowIso(): string {
  return new Date().toISOString()
}

/** 存储后端契约：Repo 只依赖这四个同步方法（+ 生命周期），换 provider 时 Repo 一行不改。 */
export interface Database {
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined
  all<T = Row>(sql: string, ...params: SqlValue[]): T[]
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number }
  tx<T>(fn: () => T): T
  migrate(): void
  close(): void
}

export class SqliteDb implements Database {
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
    // 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段，而发版时不能要求重建库
    this.ensureColumn('source_groups', 'description', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('sessions', 'last_active_at', 'TEXT')
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (cols.some((c) => c.name === column)) return
    this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
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
