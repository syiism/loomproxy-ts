#!/usr/bin/env node
// 只读分析 Go 备份库里的真实流量，用来判断"要不要给 TS 版本接 Redis"。
// 只读：不连上游、不连 Redis，只读 MySQL；不写任何表。
//   node tools/analyze-mysql-traffic.mjs
//   MYSQL_DB=loomproxy_full pnpm run analyze:mysql   # 全量备份（07-27~11-20）
// 连接参数走 env（默认值对应本机 docker 的 root/123456/loomproxy）：
//   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DB
//
// 两个库的表形态不同：
//   loomproxy       —— api_call_logs 有 6.2 万行明细（但 keyword/book/chapter 全 NULL）
//   loomproxy_full  —— api_call_logs 被清成 6 行；用 quota_usage_logs(12.5万行) 看流量节奏，
//                      api_call_stats(198 行) 是权威聚合口径。
// 工具自动探测用哪张明细表，聚合口径始终用 api_call_stats。
import mysql from 'mysql2/promise'

const cfg = {
  host: process.env['MYSQL_HOST'] ?? '127.0.0.1',
  port: Number(process.env['MYSQL_PORT'] ?? 3306),
  user: process.env['MYSQL_USER'] ?? 'root',
  password: process.env['MYSQL_PASSWORD'] ?? '123456',
  database: process.env['MYSQL_DB'] ?? 'loomproxy',
}

const conn = await mysql.createConnection({ ...cfg, connectTimeout: 5000 })

// 返回 mysql2 的 [rows, fields] 元组，调用方用 const [rows] = await q(...) 取行数组
async function q(sql) {
  return conn.query(sql)
}

function pct(n, d) {
  return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '—'
}
function ms(v) {
  return v == null ? '—' : Number(v).toLocaleString() + ' ms'
}
function line(title) {
  console.log('\n' + title)
  console.log('─'.repeat(title.length))
}

try {
  console.log(`库: ${cfg.database}  @ ${cfg.host}:${cfg.port}`)

  // 0. 探测明细表（哪个有数据用哪个）
  const [[cnt]] = await q(`SELECT COUNT(*) c FROM api_call_logs`)
  const detailTable = Number(cnt.c) > 100 ? 'api_call_logs' : 'quota_usage_logs'
  const timeCol = 'created_at'
  const keyCol = detailTable === 'api_call_logs' ? 'source, action' : 'interface'
  console.log(`明细表: ${detailTable}（api_call_logs ${cnt.c} 行）`)

  // 1. 概况（api_call_stats 是权威聚合口径）
  const [stats] = await q(`
    SELECT COUNT(*) rows_, SUM(total) total, SUM(success) ok, SUM(failed) fail,
           ROUND(SUM(total_latency_ms)/NULLIF(SUM(total),0)) avglat,
           MAX(max_latency_ms) maxlat
    FROM api_call_stats`)
  const s = stats[0]
  line('1. 数据概况（api_call_stats 聚合口径）')
  console.log(`总调用     ${Number(s.total).toLocaleString()}`)
  console.log(`成功/失败  ${Number(s.ok).toLocaleString()} / ${Number(s.fail).toLocaleString()}（失败率 ${pct(s.fail, s.total)}）`)
  console.log(`平均延迟   ${ms(s.avglat)}    最慢单请求 ${ms(s.maxlat)}`)

  // 2. 来源分布：按失败率排序，暴露坏源
  const [bySource] = await q(`
    SELECT source, action, total, success, failed,
           ROUND(total_latency_ms/NULLIF(total,0)) avglat
    FROM api_call_stats WHERE total>100 ORDER BY total DESC LIMIT 12`)
  line('2. 主力 source/action（按调用量）')
  console.log('source/action              总量     成功      失败   失败率   平均延迟')
  for (const r of bySource) {
    console.log(
      `${(r.source + '/' + r.action).padEnd(22)} ${String(r.total).padStart(7)} ${String(r.success).padStart(8)} ${String(r.failed).padStart(8)} ${pct(r.failed, r.total).padStart(7)} ${ms(r.avglat).padStart(10)}`
    )
  }

  // 3. 流量强度
  const [peak] = await q(`
    SELECT DATE_FORMAT(${timeCol},'%Y-%m-%d %H:%i') m, COUNT(*) c
    FROM ${detailTable} GROUP BY m ORDER BY c DESC LIMIT 5`)
  line('3. 流量强度')
  for (const r of peak) console.log(`  ${r.m}  ${r.c} 次/分钟 ≈ ${(r.c / 60).toFixed(1)} req/s`)
  const [days] = await q(`
    SELECT DATE(${timeCol}) d, COUNT(*) c FROM ${detailTable}
    GROUP BY d ORDER BY c DESC LIMIT 5`)
  console.log('流量最集中的日期:', days.map((r) => `${String(r.d).slice(0, 10)}(${r.c})`).join('  '))

  // 4. 本地缓存能否消化：有精确键字段时用精确键，否则退化到粗键
  //    精确键 = source + action + keyword + book_ident + chapter_ident
  const precise = detailTable === 'api_call_logs'
  const kExpr = precise
    ? "source, action, IFNULL(keyword,''), IFNULL(book_ident,''), IFNULL(chapter_ident,'')"
    : keyCol
  const [kf] = precise
    ? await q(`SELECT SUM(book_ident IS NULL OR book_ident='') book_null,
                      SUM(chapter_ident IS NULL OR chapter_ident='') chap_null,
                      SUM(keyword IS NULL OR keyword='') kw_null, COUNT(*) total FROM api_call_logs`)
    : await q(`SELECT 0 book_null, 0 chap_null, 0 kw_null, COUNT(*) total FROM quota_usage_logs`)

  async function dupAt(sec) {
    const [r] = await q(`
      SELECT SUM(IF(cnt>1,cnt-1,0)) AS saved, SUM(cnt) AS total
      FROM (
        SELECT FLOOR(UNIX_TIMESTAMP(${timeCol})/${sec}) b, ${kExpr}, COUNT(*) cnt
        FROM ${detailTable} GROUP BY b, ${kExpr}
      ) t`)
    return r[0]
  }
  const at10 = await dupAt(10)
  const at60 = await dupAt(60)
  const at1 = await dupAt(1)
  line('4. 本地 TtlCache 能否消化（精确键优先）')
  if (precise) {
    console.log(`缓存键字段填充率: keyword ${pct(kf[0].total - kf[0].kw_null, kf[0].total)} / book ${pct(kf[0].total - kf[0].book_null, kf[0].total)} / chapter ${pct(kf[0].total - kf[0].chap_null, kf[0].total)}`)
  }
  console.log(`10 秒窗口重复: ${Number(at10.saved).toLocaleString()} / ${Number(at10.total).toLocaleString()} ≈ ${pct(at10.saved, at10.total)}`)
  console.log(`60 秒窗口重复: ${Number(at60.saved).toLocaleString()} ≈ ${pct(at60.saved, at60.total)}`)
  console.log(`同秒重复（SingleFlight 空间）: ${Number(at1.saved).toLocaleString()} ≈ ${pct(at1.saved, at1.total)}`)

  // 5. 计费去重窗口（BILLING_DEDUPE_SEC=300）
  const at300 = await dupAt(300)
  line('5. 计费去重窗口（300 秒）')
  console.log(`同键 5 分钟重复: ${Number(at300.saved).toLocaleString()} 次`)

  line('6. 结论依据（留给判断，不在此下结论）')
  console.log(`峰值 ${(peak[0].c / 60).toFixed(1)} req/s · 平均延迟 ${ms(s.avglat)} · 失败率 ${pct(s.fail, s.total)}`)
  console.log(`精确键可省 10s ${pct(at10.saved, at10.total)} / 60s ${pct(at60.saved, at60.total)}`)
  console.log('单进程下，进程内 TtlCache + SingleFlight 已覆盖这些重复；Redis 的增量价值只在多副本共享缓存/状态时成立。')
} finally {
  await conn.end()
}
