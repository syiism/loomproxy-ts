// worker：持有 mysql2 连接池，经 postMessage 收请求，异步执行后把结果 JSON 写进 SAB 并 notify。
// 主线程同步 API 见 mysql.ts：postMessage 后 Atomics.wait 在 done 槽；本 worker 不阻塞，
// mysql2 的异步回调能正常跑。done 在 post 前由主线程清零，故无丢唤醒。
import { parentPort, workerData } from 'node:worker_threads'
import mysql from 'mysql2/promise'

const { sab, cfg } = workerData as {
  sab: SharedArrayBuffer
  cfg: { host: string; port: number; user: string; password: string; database: string; dateStrings: boolean }
}

// 布局：Int32[0]=done(0/1) [1]=len [2]=err(0/1) [3]=ready(0等/1好/-1失败) 之后 JSON 结果字节
const HDR = 4 * 4
const ctrl = new Int32Array(sab, 0, 4)
const bytes = new Uint8Array(sab, HDR)

const pool = mysql.createPool({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  dateStrings: cfg.dateStrings,
  waitForConnections: true,
  connectionLimit: 4,
  // mysql2 把 DECIMAL/BIGINT（含 SUM()）返回为字符串防爆精度，但本项目的金额/id 都是小整数，
  // 与 SQLite 对齐成 number；否则前端 `reduce((a,b)=>a+b)` 会把数字当字符串拼出 "00005991…"。
  // 只在纯整数串时转，保留其它字符串原样。
  typeCast: (field, next) => {
    const v = next()
    const type = String(field.type).toUpperCase()
    if ((type === 'DECIMAL' || type === 'NEWDECIMAL' || type === 'BIGINT' || type === 'LONGLONG') &&
        typeof v === 'string' && /^-?\d+$/.test(v)) {
      const n = Number(v)
      return Number.isSafeInteger(n) ? n : v
    }
    return v
  },
})

function writeBuf(text: string): number {
  const enc = Buffer.from(text, 'utf8')
  if (enc.length > bytes.length) throw new Error(`结果 ${enc.length} 字节超出共享缓冲，调大 MYSQL_SAB_MB`)
  bytes.set(enc, 0)
  return enc.length
}

// 就绪信号用 Atomics（不靠 postMessage，主线程 Atomics.wait 期间事件循环不转）
try {
  const conn = await pool.getConnection()
  await conn.ping()
  conn.release()
  Atomics.store(ctrl, 1, 0)
  Atomics.store(ctrl, 3, 1)
  Atomics.notify(ctrl, 3)
} catch (e) {
  const len = writeBuf(e instanceof Error ? e.message : String(e))
  Atomics.store(ctrl, 1, len)
  Atomics.store(ctrl, 3, -1)
  Atomics.notify(ctrl, 3)
}

type Req = { sql: string; params: unknown[] }
parentPort?.on('message', (req: Req) => {
  void (async () => {
    try {
      const [rows] = await pool.query(req.sql, req.params)
      // SELECT 返回 RowDataPacket[]；写操作/DDL 返回 ResultSetHeader（非数组）
      const isWrite = !Array.isArray(rows)
      const payload = isWrite
        ? {
            changes: Number((rows as { affectedRows?: number }).affectedRows ?? 0),
            lastInsertRowid: Number((rows as { insertId?: number }).insertId ?? 0),
          }
        : { rows }
      const len = writeBuf(JSON.stringify(payload))
      Atomics.store(ctrl, 1, len)
      Atomics.store(ctrl, 2, 0)
    } catch (e) {
      const len = writeBuf(e instanceof Error ? e.message : String(e))
      Atomics.store(ctrl, 1, len)
      Atomics.store(ctrl, 2, 1)
    }
    Atomics.store(ctrl, 0, 1)
    Atomics.notify(ctrl, 0)
  })()
})
