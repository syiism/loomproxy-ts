// MySQL 后端：实现 Database 接口，保持与 SqliteDb 相同的同步签名，让 store 层与上层零改动。
// mysql2 是异步的，故用 worker 线程 + SharedArrayBuffer + Atomics.wait 做同步桥接。
// 主线程阻塞等待时事件循环不转，但 TS store 本就是同步模型（node:sqlite 一样阻塞），语义一致。
import { Worker } from 'node:worker_threads'
import { SqliteDb } from './sqlite.ts'
import type { Database, Row, SqlValue } from './sqlite.ts'
import { translate, mapColumns, isoToMysql, mysqlToIso, apiKeyRevokeToDelete, appUpsert, systemSettingsFix, dropColumns, overrideQueryFix } from './mysql-dialect.ts'

export type MysqlConfig = {
  host: string
  port: number
  user: string
  password: string
  database: string
  /** 共享缓冲 MB，须大于单条结果 JSON；默认 32 */
  sabMb?: number
  /** TS 本地表（kv_state/name_cache，Go 侧放 Redis/无对应）的 SQLite 旁路库路径；默认 :memory: */
  metaPath?: string
}

const HDR = 4 * 4
const READY_TIMEOUT_MS = 10_000

export class MysqlDb implements Database {
  private readonly worker: Worker
  private readonly ctrl: Int32Array
  private readonly bytes: Uint8Array
  private readonly meta: SqliteDb

  constructor(cfg: MysqlConfig) {
    // 本地旁路：kv_state（口令来源标记）与 name_cache（Go 放 Redis）在 MySQL 无对应表，
    // 用内嵌 SQLite 承载。migrate 会建全部表，但只有这两张会被路由到这里。
    this.meta = new SqliteDb(cfg.metaPath ?? ':memory:')
    this.meta.migrate()
    const sab = new SharedArrayBuffer((cfg.sabMb ?? 32) * 1024 * 1024)
    this.ctrl = new Int32Array(sab, 0, 4)
    this.bytes = new Uint8Array(sab, HDR)
    this.worker = new Worker(new URL('./mysql-bridge-worker.ts', import.meta.url), {
      workerData: {
        sab,
        cfg: {
          host: cfg.host, port: cfg.port, user: cfg.user,
          password: cfg.password, database: cfg.database, dateStrings: true,
        },
      },
    })
    const r = Atomics.wait(this.ctrl, 3, 0, READY_TIMEOUT_MS)
    const state = Atomics.load(this.ctrl, 3)
    if (state !== 1) {
      const len = Atomics.load(this.ctrl, 1)
      const msg = Buffer.from(this.bytes.buffer, this.bytes.byteOffset, len).toString('utf8')
      void this.worker.terminate()
      throw new Error(`MySQL 连接失败${r === 'timed-out' ? '（超时）' : ''}: ${msg}`)
    }
  }

  private raw<T>(sql: string, params: SqlValue[], kind: 'get' | 'all' | 'run', reverse?: Record<string, string>): T {
    Atomics.store(this.ctrl, 0, 0)
    Atomics.store(this.ctrl, 2, 0)
    this.worker.postMessage({ sql, params })
    Atomics.wait(this.ctrl, 0, 0)
    const len = Atomics.load(this.ctrl, 1)
    const isErr = Atomics.load(this.ctrl, 2) === 1
    const text = Buffer.from(this.bytes.buffer, this.bytes.byteOffset, len).toString('utf8')
    // 不把 SQL 拼进错误：SQL 结构属内部实现，且可能含签名/参数痕迹。全局错误处理器已对 5xx 兜底脱敏。
    if (isErr) throw new Error(`MySQL 查询失败: ${text.slice(0, 200)}`)
    const payload = JSON.parse(text) as { rows?: Row[]; changes?: number; lastInsertRowid?: number }
    if (kind === 'run') return { changes: payload.changes ?? 0, lastInsertRowid: payload.lastInsertRowid ?? 0 } as T
    const rows = (payload.rows ?? []).map((row) => {
      const out: Row = {}
      for (const [k, v] of Object.entries(row)) {
        const key = reverse?.[k] ?? k
        out[key] = mysqlToIso(v) as SqlValue
      }
      return out
    })
    return (kind === 'get' ? rows[0] : rows) as T
  }

  /** 翻译 + 参数日期转换后执行。 */
  private exec<T>(sql: string, params: SqlValue[], kind: 'get' | 'all' | 'run'): T {
    // 逐表列差异：去掉 MySQL 不存在的列、重命名列（都在翻译前做，保证参数顺序对齐）
    const sf = systemSettingsFix(sql, params)
    const oq = overrideQueryFix(sf.sql, sf.params)
    const ds = dropColumns(oq.sql, oq.params, 'data_sources', ['media_type'])
    // api_call_logs.plugin_version：TS/Go 规划列，本机 MySQL 结构无此列，写入时丢弃（读侧 ?? '' 兜底）
    const cl = dropColumns(ds.sql, ds.params, 'api_call_logs', ['plugin_version'])
    // quota_usage_logs.username：线上表无此列（冗余展示列，不影响计费），写入时丢弃
    const ul = dropColumns(cl.sql, cl.params, 'quota_usage_logs', ['username'])
    let out = translate(ul.sql)
    let p = ul.params
    // jti → session_id 只在 sessions/auth_sessions 相关语句出现（TS 仅此一处用 jti）
    if (/\bauth_sessions\b|\bsessions\b/.test(out)) out = mapColumns(out, 'auth_sessions')
    // blocked_ips：TS reason → MySQL note
    if (/\bblocked_ips\b/i.test(out)) out = out.replace(/\breason\b/gi, 'note')
    // api_keys 撤销：Go 物理删除，无 revoked_at 列
    const ak = apiKeyRevokeToDelete(out, p)
    out = ak.sql
    p = ak.params
    // 读回列反向映射（仅针对真正改名的表；group_code/note 在 quota_costs/pool_devices 里是真列，不能动）
    let reverse: Record<string, string> | undefined
    if (/\bauth_sessions\b|\bsessions\b/i.test(out)) reverse = { session_id: 'jti' }
    else if (/\buser_quota_overrides\b/i.test(out)) reverse = { group_code: 'target' }
    else if (/\bblocked_ips\b/i.test(out)) reverse = { note: 'reason' }
    const converted = p.map(isoToMysql) as SqlValue[]
    return this.raw<T>(out, converted, kind, reverse)
  }

  private isMeta(sql: string): boolean {
    return /\b(kv_state|name_cache)\b/i.test(sql)
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    if (this.isMeta(sql)) return this.meta.get<T>(sql, ...params)
    return this.exec<T | undefined>(sql, params, 'get')
  }
  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    if (this.isMeta(sql)) return this.meta.all<T>(sql, ...params)
    return this.exec<T[]>(sql, params, 'all')
  }
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    if (this.isMeta(sql)) return this.meta.run(sql, ...params)
    // 无唯一索引表的幂等 upsert：先查后写（必须在 translate 之前识别原始 ON CONFLICT）
    const au = appUpsert(sql, params)
    if (au) {
      const exists = this.raw<{ id: number } | undefined>(
        au.probe, au.probeParams.map(isoToMysql) as SqlValue[], 'get',
      )
      if (exists) return this.raw(au.update, au.updateParams.map(isoToMysql) as SqlValue[], 'run')
      return this.raw(au.insert, au.insertParams.map(isoToMysql) as SqlValue[], 'run')
    }
    return this.exec(sql, params, 'run')
  }
  tx<T>(fn: () => T): T {
    this.run('BEGIN')
    try {
      const out = fn()
      this.run('COMMIT')
      return out
    } catch (e) {
      this.run('ROLLBACK')
      throw e
    }
  }
  migrate(): void {
    // 线上库 schema 已存在，no-op
  }
  close(): void {
    void this.worker.terminate()
    this.meta.close()
  }
}
