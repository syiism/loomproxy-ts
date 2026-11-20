#!/usr/bin/env node
// 一次性迁移：Go 版 MySQL 备份 → TS 版 SQLite 库。只读 MySQL、只写目标 SQLite。
//   node tools/mysql-to-sqlite.mjs [--db loomproxy_full] [--out data/loomproxy.db] [--dry-run]
// 连接参数走 env：MYSQL_HOST/PORT/USER/PASSWORD（默认 127.0.0.1:3306 root/123456）。
//
// 定位：本地开发/测试数据导入（生产对接走 DB_TYPE=mysql 双后端，见 compose.ts）。
// 迁完顺带从 api_call_logs 反向重建 name_cache（Go 把这份映射放 Redis，不随库迁移）。
//
// 表名/列名差异（Go → TS）：
//   auth_sessions    → sessions     (session_id → jti)
//   quota_plans      → plans
//   redemption_codes → redeem_codes
// 其余归档/临时表（*_clean_*, deadgate_*）无对应目标表，自动跳过。
import mysql from 'mysql2/promise'
import { SqliteDb } from '../packages/store/src/sqlite.ts'
import { DbNameCache } from '../packages/store/src/name-cache.ts'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const srcDb = arg('--db', process.env['MYSQL_DB'] ?? 'loomproxy_full')
const outPath = arg('--out', process.env['SQLITE_PATH'] ?? 'data/loomproxy.db')
const dryRun = args.includes('--dry-run')
const batchSize = 1000

const TABLE_MAP = {
  auth_sessions: 'sessions',
  quota_plans: 'plans',
  redemption_codes: 'redeem_codes',
}
const COLUMN_MAP = {
  sessions: { session_id: 'jti' },
  // Go 的 group_code 就是源 code → TS 的 target；scope 固定 'source'（限额即授权）
  user_quota_overrides: { group_code: 'target' },
}
const CONST_COL = {
  user_quota_overrides: { scope: 'source' },
}
// 归档/实验表，不迁
const SKIP_SRC = /^(api_call_logs_.*|deadgate_.*|pool_devices_.*_clean_.*|xmly_devices|user_display_aliases|user_quotas|verification_codes|redemption_logs)$/

const mysqlConn = await mysql.createConnection({
  host: process.env['MYSQL_HOST'] ?? '127.0.0.1',
  port: Number(process.env['MYSQL_PORT'] ?? 3306),
  user: process.env['MYSQL_USER'] ?? 'root',
  password: process.env['MYSQL_PASSWORD'] ?? '123456',
  database: srcDb,
  dateStrings: true, // datetime 原样字符串，避免时区偏移；下面转 ISO
  connectTimeout: 5000,
})

// MySQL datetime(3) → TS 用的 ISO 串（UTC，备份 dump 里 SET TIME_ZONE='+00:00'）
function toIso(v) {
  if (typeof v !== 'string') return v
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(v)
  return m ? `${m[1]}T${m[2]}${m[3] ?? ''}Z` : v
}

function placeholder(type) {
  return /INT|REAL|NUM|BOOL/i.test(type) ? 0 : ''
}

// 即使 dry-run 也要打开目标库读 schema（migrate 是 CREATE IF NOT EXISTS，幂等）
const db = new SqliteDb(outPath)
db.migrate()

try {
  const [srcTables] = await mysqlConn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'`,
    [srcDb]
  )
  const summary = []
  for (const { TABLE_NAME: src } of srcTables) {
    if (SKIP_SRC.test(src)) continue
    const dst = TABLE_MAP[src] ?? src
    // 目标表不存在（TS 没有这张表）→ 跳过
    const dstCols = db.all(`PRAGMA table_info(${dst})`)
    if (dstCols.length === 0) continue

    const [srcCols] = await mysqlConn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`,
      [srcDb, src]
    )
    const rename = COLUMN_MAP[dst] ?? {}
    const consts = CONST_COL[dst] ?? {}
    const srcNames = srcCols.map((c) => c.COLUMN_NAME)
    // 对每张目标列：找同名源列，或经 rename 反查
    const mapped = dstCols
      .map((c) => {
        const from = Object.keys(rename).find((k) => rename[k] === c.name) ?? c.name
        return srcNames.includes(from) ? { to: c.name, from } : null
      })
      .filter(Boolean)
    // 目标 NOT NULL 且无默认值、源里没有对应列 → 用常量或占位，否则插入会失败
    const fills = dstCols
      .filter((c) => c.notnull && c.dflt_value === null && c.name !== 'id' && !mapped.some((m) => m.to === c.name))
      .map((c) => ({ to: c.name, value: consts[c.name] ?? placeholder(c.type) }))

    const cols = [...mapped.map((m) => m.to), ...fills.map((f) => f.to)]
    // limit 是 SQLite 保留字：列名必须加引号（踩过一次语法错误）
    const quotedCols = cols.map((c) => `"${c}"`).join(',')
    const placeholders = cols.map(() => '?').join(',')
    const selectList = mapped.map((m) => `\`${m.from}\``).join(',')
    if (!cols.length) continue

    let total = 0
    let offset = 0
    const stmt = dryRun ? null : db.raw.prepare(`INSERT OR REPLACE INTO ${dst} (${quotedCols}) VALUES (${placeholders})`)
    if (!dryRun) db.raw.exec('BEGIN')
    try {
      for (;;) {
        const [rows] = await mysqlConn.query(
          `SELECT ${selectList} FROM \`${src}\` ORDER BY id LIMIT ${batchSize} OFFSET ${offset}`
        )
        if (rows.length === 0) break
        if (stmt) {
          for (const row of rows) {
            const values = mapped.map((m) => toIso(row[m.from]))
            for (const f of fills) values.push(f.value)
            stmt.run(...values)
          }
        }
        total += rows.length
        offset += rows.length
      }
      if (!dryRun) db.raw.exec('COMMIT')
    } catch (e) {
      if (!dryRun) db.raw.exec('ROLLBACK')
      throw e
    }
    summary.push(`${src.padEnd(20)} → ${dst.padEnd(18)} ${String(total).padStart(7)} 行  (${mapped.length} 列${fills.length ? ` +${fills.length} 占位` : ''})`)
  }
  console.log(`\nMySQL ${srcDb} → ${dryRun ? '(dry-run)' : outPath}`)
  console.log(summary.join('\n') || '（没有可迁移的表）')
  if (!dryRun) {
    // 从调用历史反向重建 name_cache：明细里带着 book_name/chapter_title + 标识，
    // 提取成唯一映射，避免切流瞬间"阅读记录"页名字为空（Go 这份放在 Redis，不随库迁）。
    const recovered = new DbNameCache(db).recoverFromLogs()
    console.log(`\nname_cache 从明细恢复：book ${recovered.books} / chapter ${recovered.chapters}`)
  }
} finally {
  await mysqlConn.end()
  db.close()
}
