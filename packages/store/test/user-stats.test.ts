// /admin/stats 的角色计数口径对齐 Go handlers/admin/admin.go Stats：
// vip 是角色码（不是套餐码），软删用户不计入；admin+vip 双角时两边各计一次。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteDb } from '../src/sqlite.ts'
import { DbRoles, DbUsers } from '../src/db-repos.ts'

test('stats 按角色码数 VIP，软删用户不算', () => {
  const db = new SqliteDb(':memory:')
  db.migrate()
  const roles = new DbRoles(db)
  const users = new DbUsers(db)
  for (const code of ['admin', 'user', 'vip']) roles.create({ code, name: code })
  const admin = users.create({ username: 'admin', password: 'p', roles: ['admin'] })
  users.create({ username: 'v1', password: 'p', roles: ['vip'] })
  users.create({ username: 'v2', password: 'p', roles: ['vip', 'user'] })
  users.create({ username: 'plain', password: 'p', roles: ['user'] })
  const gone = users.create({ username: 'gone', password: 'p', roles: ['vip'] })
  db.run('UPDATE users SET deleted_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', gone.id)

  const s = users.stats()
  assert.equal(s.total, 5)
  assert.equal(s.admin, 1)
  assert.equal(s.vip, 2, '软删的 vip 不计入')
  assert.equal(s.deleted, 1)
  assert.equal(admin.roles[0]?.code, 'admin')
})

test('stats 里 admin 与 vip 各按角色计数，双角用户不互斥', () => {
  const db = new SqliteDb(':memory:')
  db.migrate()
  const roles = new DbRoles(db)
  const users = new DbUsers(db)
  for (const code of ['admin', 'vip']) roles.create({ code, name: code })
  users.create({ username: 'both', password: 'p', roles: ['admin', 'vip'] })

  const s = users.stats()
  assert.equal(s.admin, 1)
  assert.equal(s.vip, 1)
})
