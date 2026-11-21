#!/usr/bin/env node
// 写对拍：同一组写操作分别在 SQLite 与 MySQL 后端执行，再逐 Repo 读回对比。
// 目的是验证 MySQL 适配层的写路径与 SQLite 行为一致（不让"无缝接手"变成"带 bug 接手"）。
//   node tools/write-parity.mjs
// MySQL 用 scratch 库（必须先建好且为空，工具会 DROP 重建表），连接走 env：
//   MYSQL_HOST/PORT/USER/PASSWORD/DB（默认 127.0.0.1:3306 root/123456 loomproxy_parity）
import mysql from 'mysql2/promise'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  SqliteDb, MysqlDb,
  DbUsers, DbRoles, DbPlans, DbSessions, DbApiKeys, DbSettings,
  DbDataSources, DbCallLogs, DbQuota, DbQuotaExtra, DbBlockedIPs,
  DbSourceConfigs, DbSourceGroups, DbPoolDevices, DbKv, DbNameCache,
  seedBuiltinSettings,
} from '../packages/store/src/index.ts'

const cfg = {
  host: process.env['MYSQL_HOST'] ?? '127.0.0.1',
  port: Number(process.env['MYSQL_PORT'] ?? 3306),
  user: process.env['MYSQL_USER'] ?? 'root',
  password: process.env['MYSQL_PASSWORD'] ?? '123456',
  database: process.env['MYSQL_DB'] ?? 'loomproxy_parity',
}

// 准备 MySQL scratch 库：用 Go 备份的 schema（只结构、无数据）建空表——这正是适配层针对生产结构。
// 先 mysqldump --no-data loomproxy_full > /tmp/opencode/schema-only.sql（README/WORKLOG 有说明）。
const schemaSqlPath = process.env['PARITY_SCHEMA_SQL'] ?? '/tmp/opencode/schema-only.sql'
readFileSync(schemaSqlPath) // 存在性校验
const admin = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password })
await admin.query(`DROP DATABASE IF EXISTS \`${cfg.database}\``)
await admin.query(`CREATE DATABASE \`${cfg.database}\` CHARACTER SET utf8mb4`)
await admin.end()
// dump 里含 MariaDB 专有注释，mysql2 multipleStatements 解析不了；用 mysql CLI（导入时已验证可行）
const cliArgs = ['-h', cfg.host, '-P', String(cfg.port), '-u', cfg.user, `-p${cfg.password}`, cfg.database]
execFileSync('mysql', cliArgs, { input: readFileSync(schemaSqlPath) })

// 两端各建库并播种（相同的 DDL / 相同的初始行）
function buildRepos(db) {
  const roles = new DbRoles(db), plans = new DbPlans(db), users = new DbUsers(db)
  const sessions = new DbSessions(db), apiKeys = new DbApiKeys(db), settings = new DbSettings(db)
  const dataSources = new DbDataSources(db), callLogs = new DbCallLogs(db)
  const quota = new DbQuota(db), quotaExtra = new DbQuotaExtra(db, quota)
  const blockedIPs = new DbBlockedIPs(db), sourceConfigs = new DbSourceConfigs(db)
  const sourceGroups = new DbSourceGroups(db, quota), poolDevices = new DbPoolDevices(db)
  const kv = new DbKv(db), nameCache = new DbNameCache(db)
  // 最小播种：角色 + 一个套餐 + 一个用户（IDs 两端一致）
  for (const code of ['admin', 'vip', 'user']) roles.create({ code, name: code })
  const plan = plans.create({ name: 'free', code: 'free' })
  users.create({ username: 'alice', password: 'pw', planId: plan.id, roles: ['user'] })
  seedBuiltinSettings(settings)
  return { db, roles, plans, users, sessions, apiKeys, settings, dataSources, callLogs, quota, quotaExtra, blockedIPs, sourceConfigs, sourceGroups, poolDevices, kv, nameCache, plan }
}

// 一整套写操作（对两端逐一执行，参数完全相同）
function writes(r) {
  const uid = r.users.byUsernameOrEmail('alice').id
  // 用户
  r.users.update(uid, { nickname: '爱丽丝', email: 'a@example.com' })
  r.users.setPassword(uid, 'newpw')
  r.users.setConsent(uid, false)
  r.users.touchLogin(uid)
  r.users.setRoles(uid, ['admin', 'vip'])
  // 会话
  r.sessions.create(uid, 'jti-1', '2099-01-01T00:00:00.000Z', '1.2.3.4', 'UA')
  r.sessions.create(uid, 'jti-2', '2099-01-01T00:00:00.000Z', '1.2.3.5', 'UA2')
  r.sessions.revoke('jti-2')
  r.sessions.revokeOthers(uid, 'jti-1')
  // API key（含软删/物理删差异）
  const k = r.apiKeys.create(uid, 'k1', 'lp_testkey')
  r.apiKeys.revoke(uid, k.id)
  // 设置
  r.settings.set('maintenance_mode', 'true')
  r.settings.upsertRaw({ key: 'custom_x', value: 'v', type: 'string', description: 'd' })
  // 数据源 upsert（media_type 差异）
  r.dataSources.upsert({ code: 'src1', display: '源一', category: 'novel', sort_order: 1, status: 1, media_type: 'novel', actions: ['search'], settings: [] })
  r.dataSources.upsert({ code: 'src1', display: '源一改', category: 'novel', sort_order: 2, status: 1, media_type: 'novel', actions: ['search'], settings: [] })
  r.dataSources.upsert({ code: 'src2', display: '源二', category: 'novel', sort_order: 3, status: 1, media_type: 'novel', actions: ['search'], settings: [] })
  // 调用日志（upsert api_call_stats）
  r.callLogs.append({ username: 'alice', ip: '1.2.3.4', source: 'src1', action: 'search', status: 200, latency_ms: 100, in_band_error: false, in_band_reason: '', in_band_code: '', keyword: '三体', book_name: '', chapter_title: '', book_ident: '', chapter_ident: '', media_type: 'novel', result_count: 5, content_withheld: false, plugin_version: '1.0' })
  r.callLogs.append({ username: 'alice', ip: '1.2.3.4', source: 'src1', action: 'search', status: 500, latency_ms: 200, in_band_error: false, in_band_reason: '', in_band_code: '', keyword: '三体', book_name: '', chapter_title: '', book_ident: '', chapter_ident: '', media_type: 'novel', result_count: 0, content_withheld: false, plugin_version: '1.0' })
  // 额度（先查后写 upsert）
  r.quota.grant(r.plan.id, 'source', 'src1', 10)
  r.quota.grant(r.plan.id, 'source', 'src1', 20) // 应更新不重复
  r.quota.grant(r.plan.id, 'source', 'src2', 20)
  // 额度转移：覆盖写增量 + 审计行（operator_id/via/from_override/to_override）
  r.quotaExtra.transfer({ userId: uid, operatorId: uid, via: 'self', from: 'src1', to: 'src2', amount: 5, planId: r.plan.id })
  r.dataSources.setStatus('src1', 0)
  r.quota.setOverride(uid, 'source', 'src1', 5)
  r.quota.setOverride(uid, 'source', 'src1', 7)
  r.quota.ensureDefaultCosts('src1', ['search', 'content'])
  // 成本计划 upsert
  r.quotaExtra.upsertCostPlan({ plan_id: r.plan.id, group_code: 'src1', interface: 'search', interval: 60, limit_count: 10, window_sec: 60 })
  // IP 黑名单 upsert
  r.blockedIPs.add('9.9.9.9', 'test')
  r.blockedIPs.add('9.9.9.9', 'test2') // 更新
  // 源配置
  r.sourceConfigs.setPlatform('src1', 'https://x')
  r.sourceConfigs.setUser(uid, 'src1', 'https://y')
  // 分组
  const g = r.sourceGroups.create({ name: 'g1', sort_order: 1 })
  r.sourceGroups.setMembers(g.id, ['src1'])
  // 号池设备 upsert
  const dev = { ident: 'dev1', status: 'active', attrs: {}, payload: {}, total_quota: 10, used_quota: 0, expire_at: null, note: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
  r.poolDevices.save('p1', dev)
  r.poolDevices.save('p1', { ...dev, status: 'spent', used_quota: 10, note: 'n' })
  // kv / name cache（旁路 SQLite）
  r.kv.set('k', 'v')
  r.nameCache.rememberBook('src1', 'b1', '书名')
  r.nameCache.rememberChapter('src1', 'b1', 'c1', '章名')
}

// 读回稳定结果（避开时间戳/自增 ID 噪声；对"状态"做语义对比）
function reads(r, kind) {
  const uid = r.users.byUsernameOrEmail('alice').id
  const mediaCol = 'media'
  const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => {
    if (['created_at', 'updated_at', 'last_login_at', 'last_used_at', 'expires_at', 'revoked_at', 'applied_at', 'cleared_at', 'used_at'].includes(k)) return '<T>'
    return v
  }))
  return norm({
    user: { nickname: r.users.byId(uid).nickname, email: r.users.byId(uid).email, consent: r.users.byId(uid).content_consent, roles: r.users.byId(uid).roles.map(x => x.code).sort() },
    sessions: r.sessions.listByUser(uid).map(s => ({ jti: s.jti, ip: s.ip })),
    sessionActive: [r.sessions.isActive('jti-1'), r.sessions.isActive('jti-2')],
    apiKeys: r.apiKeys.listByUser(uid).map(k => k.key),
    settings: { maint: r.settings.get('maintenance_mode'), custom: r.settings.get('custom_x') },
    dataSources: r.dataSources.listAll().map(d => ({ name: d.name, display_name: d.display_name, category: d.category, sort_order: d.sort_order, status: d.status })),
    callStats: r.db.all('SELECT source,action,total,success,failed FROM api_call_stats ORDER BY source,action'),
    callLogs: r.db.all(`SELECT source,action,status,${mediaCol} AS media FROM api_call_logs ORDER BY id`),
    limits: r.quota.limitsOfPlan(r.plan.id).map(l => ({ scope: l.scope, target: l.target, limit: l.limit })),
    overrides: r.quota.overridesOf(uid).map(l => ({ target: l.target, limit: l.limit })),
    transfers: r.db.all('SELECT user_id,operator_id,via,from_code,to_code,amount,from_before,from_after,to_before,to_after,from_override,to_override FROM quota_transfer_logs ORDER BY id')
      .map(t => ({ ...t, user_id: t.user_id === uid ? '<uid>' : t.user_id, operator_id: t.operator_id === uid ? '<uid>' : t.operator_id })),
    costs: r.db.all('SELECT group_code,interface,cost,status FROM quota_costs ORDER BY group_code,interface'),
    costPlans: r.quotaExtra.costPlans().map(c => ({ group_code: c.group_code, interface: c.interface, interval: c.interval, limit_count: c.limit_count })),
    ipBlock: kind === 'mysql'
      ? r.db.all('SELECT ip,note AS reason FROM blocked_ips ORDER BY ip')
      : r.db.all('SELECT ip,reason FROM blocked_ips ORDER BY ip'),
    platformCfg: r.sourceConfigs.platform(),
    userCfg: r.sourceConfigs.user(uid),
    groups: r.sourceGroups.list().map(g => ({ name: g.name, sort_order: g.sort_order })),
    pool: r.db.all('SELECT pool,ident,status,total_quota,used_quota,note FROM pool_devices ORDER BY pool,ident'),
    kv: r.kv.get('k'),
    nameBook: r.nameCache.lookupBook('src1', 'b1'),
    nameChapter: r.nameCache.lookupChapter('src1', 'b1', 'c1'),
  })
}

const sqliteDb = new SqliteDb(':memory:')
sqliteDb.migrate()
const sRepos = buildRepos(sqliteDb)
writes(sRepos)
const sRead = reads(sRepos, 'sqlite')

const mysqlDb = new MysqlDb({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database })
const mRepos = buildRepos(mysqlDb)
writes(mRepos)
const mRead = reads(mRepos, 'mysql')

let ok = true
for (const key of Object.keys(sRead)) {
  const a = JSON.stringify(sRead[key])
  const b = JSON.stringify(mRead[key])
  if (a !== b) {
    ok = false
    console.log(`✗ ${key}\n   SQLite: ${a}\n   MySQL : ${b}`)
  } else {
    console.log(`✓ ${key}`)
  }
}
console.log(ok ? '\n写对拍：全部一致 ✅' : '\n写对拍：存在差异 ❌')
sqliteDb.close()
mysqlDb.close()
process.exit(ok ? 0 : 1)
