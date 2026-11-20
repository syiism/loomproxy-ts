import assert from 'node:assert/strict'
import test from 'node:test'
import { translateUpsert, fixQuotes, translate, mapColumns, isoToMysql, mysqlToIso, apiKeyRevokeToDelete, appUpsert, overrideQueryFix } from '../src/mysql-dialect.ts'

test('upsert：ON CONFLICT + excluded → ON DUPLICATE KEY + VALUES', () => {
  const sql = `INSERT INTO blocked_ips (ip, reason) VALUES (?,?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason`
  const out = translateUpsert(sql)
  assert.match(out, /ON DUPLICATE KEY UPDATE reason = VALUES\(reason\)/)
  assert.doesNotMatch(out, /excluded|ON CONFLICT/)
})

test('upsert：带双引号列与多列 SET', () => {
  const sql = `INSERT INTO quota_limits (plan_id,scope,target,"limit",created_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(plan_id,scope,target) DO UPDATE SET "limit" = excluded."limit", updated_at = excluded.updated_at`
  const out = translate(sql, { tables: {} })
  assert.match(out, /ON DUPLICATE KEY UPDATE `limit` = VALUES\(`limit`\), updated_at = VALUES\(updated_at\)/)
})

test('引号修复：SQLite 双引号 → MySQL 反引号', () => {
  assert.equal(fixQuotes('SELECT "limit" FROM t'), 'SELECT `limit` FROM t')
})

test('INSERT OR IGNORE → INSERT IGNORE', () => {
  assert.equal(translate('INSERT OR IGNORE INTO user_roles (user_id,role_id) VALUES (?,?)', { tables: {} }), 'INSERT IGNORE INTO user_roles (user_id,role_id) VALUES (?,?)')
})

test('保留字不重复包裹：已有反引号的 interval 不再变 ``interval``', () => {
  // UPDATE quota_costs SET "interval" = ? 这类：先 "interval"→`interval`，保留字规则不能再包一层
  const out = fixQuotes('UPDATE quota_costs SET "interval" = ?, `key` = ?')
  assert.ok(!out.includes('``'), `不应出现双反引号: ${out}`)
  assert.match(out, /`interval` = \?/)
  assert.match(out, /`key` = \?/)
})

test('表名映射：sessions → auth_sessions, plans → quota_plans', () => {
  const out = translate('SELECT * FROM sessions WHERE jti = ?')
  assert.match(out, /FROM auth_sessions/)
})

test('列映射：jti → session_id', () => {
  const out = mapColumns('SELECT jti FROM auth_sessions WHERE jti = ?', 'auth_sessions')
  assert.equal(out, 'SELECT session_id FROM auth_sessions WHERE session_id = ?')
})

test('日期：ISO → MySQL datetime（墙钟当 UTC，与迁移约定一致）', () => {
  assert.equal(isoToMysql('2026-11-20T02:15:15.084Z'), '2026-11-20 02:15:15.084')
  assert.equal(isoToMysql('普通字符串'), '普通字符串')
})

test('日期：MySQL datetime → ISO', () => {
  assert.equal(mysqlToIso('2026-11-20 02:15:15.084'), '2026-11-20T02:15:15.084Z')
  assert.equal(mysqlToIso('2026-11-20'), '2026-11-20')
})

test('api_keys 软删 → 物理删除，并去掉 revoked_at 过滤', () => {
  const del = apiKeyRevokeToDelete(
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ['2026-01-01', 5, 2],
  )
  assert.equal(del.sql, 'DELETE FROM api_keys WHERE id = ? AND user_id = ?')
  assert.deepEqual(del.params, [5, 2])
  const sel = apiKeyRevokeToDelete('SELECT id,key FROM api_keys WHERE user_id=? AND revoked_at IS NULL', [2])
  assert.equal(sel.sql, 'SELECT id,key FROM api_keys WHERE user_id=?')
})

test('无唯一索引表：先查后写 upsert（quota_limits）', () => {
  const au = appUpsert(
    'INSERT INTO quota_limits (plan_id,scope,target,"limit",created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(plan_id,scope,target) DO UPDATE SET "limit"=excluded."limit"',
    [1, 'source', 'fq_novel', 100, 'c', 'u'],
  )
  assert.ok(au)
  assert.match(au!.probe, /WHERE plan_id=\? AND scope=\? AND target=\?/)
  assert.deepEqual(au!.probeParams, [1, 'source', 'fq_novel'])
  assert.deepEqual(au!.updateParams, [100, 'u', 1, 'source', 'fq_novel'])
})

test('api_keys 别名子查询去 revoked_at，但保留 sessions 的 revoked_at', () => {
  const sql = `SELECT u.id,
    (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL) AS active,
    (SELECT COUNT(*) FROM api_keys k WHERE k.user_id=u.id AND k.revoked_at IS NULL) AS keys
    FROM users u`
  const out = apiKeyRevokeToDelete(sql, []).sql
  assert.match(out, /s\.revoked_at\s+IS\s+NULL/, 'sessions 的 revoked_at 必须保留')
  assert.doesNotMatch(out, /k\.revoked_at/, 'api_keys 别名的 revoked_at 必须去掉')
})

test('无唯一索引表：user_quota_overrides 用 group_code（scope 忽略）', () => {
  const au = appUpsert(
    'INSERT INTO user_quota_overrides (user_id,scope,target,"limit",created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,scope,target) DO UPDATE SET "limit"=excluded."limit"',
    [2, 'source', 'fq_audio', 200, 'c', 'u'],
  )
  assert.ok(au)
  assert.match(au!.probe, /WHERE user_id=\? AND group_code=\?/)
  assert.deepEqual(au!.probeParams, [2, 'fq_audio'])
})
