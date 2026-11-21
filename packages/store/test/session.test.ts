// 会话现行校验：jwt_expire_hours=-1（永不过期）签出的票 expires_at=1970 哨兵，
// 必须被认作有效，否则登录成功但 /auth/me 立刻 401（迁移后出现，Go 版对应写 100 年后）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteDb } from '../src/sqlite.ts'
import type { Database } from '../src/sqlite.ts'
import { DbSessions } from '../src/db-repos.ts'

function make() {
  const db = new SqliteDb(':memory:')
  db.migrate()
  return { db, sessions: new DbSessions(db) }
}

test('普通未来到期时间：有效', () => {
  const { db, sessions } = make()
  db.run('INSERT INTO users (id,username,password_hash,status,created_at,updated_at) VALUES (1,\'u\',\'x\',1,\'now\',\'now\')')
  const future = new Date(Date.now() + 3600_000).toISOString()
  db.run('INSERT INTO sessions (user_id,jti,ip,user_agent,created_at,expires_at) VALUES (1,\'j1\',\'\',\'\',\'now\',?)', future)
  assert.equal(sessions.isActive('j1'), true)
})

test('1970 哨兵（永不过期）：有效，不能被当过期', () => {
  const { db, sessions } = make()
  db.run('INSERT INTO users (id,username,password_hash,status,created_at,updated_at) VALUES (1,\'u\',\'x\',1,\'now\',\'now\')')
  db.run("INSERT INTO sessions (user_id,jti,ip,user_agent,created_at,expires_at) VALUES (1,'j2','','','now','1970-01-01T00:00:00.000Z')")
  assert.equal(sessions.isActive('j2'), true)
})

test('真正的过期时间：失效', () => {
  const { db, sessions } = make()
  db.run('INSERT INTO users (id,username,password_hash,status,created_at,updated_at) VALUES (1,\'u\',\'x\',1,\'now\',\'now\')')
  db.run("INSERT INTO sessions (user_id,jti,ip,user_agent,created_at,expires_at) VALUES (1,'j3','','','now','2020-01-01T00:00:00.000Z')")
  assert.equal(sessions.isActive('j3'), false)
})

test('吊销的会话：即使永不过期也失效', () => {
  const { db, sessions } = make()
  db.run('INSERT INTO users (id,username,password_hash,status,created_at,updated_at) VALUES (1,\'u\',\'x\',1,\'now\',\'now\')')
  db.run("INSERT INTO sessions (user_id,jti,ip,user_agent,created_at,expires_at,revoked_at) VALUES (1,'j4','','','now','1970-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')")
  assert.equal(sessions.isActive('j4'), false)
})

test('revokeExcess 的派生表必须有别名（MySQL 8 不接受无别名的 derived table）', () => {
  const sqls: string[] = []
  const capture = {
    run(sql: string) { sqls.push(sql); return { changes: 0, lastInsertRowid: 0 } },
    get: () => undefined, all: () => [], tx: () => undefined, migrate: () => undefined, close: () => undefined,
  } as unknown as Database
  new DbSessions(capture).revokeExcess(1, 'keep', 5)
  assert.match(sqls[0] ?? '', /\)\s+ranked\s+WHERE\s+rn\s*>\s*\?/)
})

test('revokeExcess：保留本次 + 最近 N-1 个，踢掉最旧的（只看活跃会话数）', () => {
  const { db, sessions } = make()
  db.run("INSERT INTO users (id,username,password_hash,status,created_at,updated_at) VALUES (1,'u','x',1,'now','now')")
  const future = new Date(Date.now() + 3600_000).toISOString()
  // 一个用户 4 个会话，last_active_at 依次变旧；j4 是本次登录
  for (let i = 1; i <= 4; i++) {
    const active = `2026-11-20T0${i}:00:00.000Z`
    db.run('INSERT INTO sessions (user_id,jti,ip,user_agent,created_at,expires_at,last_active_at) VALUES (1,?,?,?,?,?,?)',
      `j${i}`, '', '', '2026-11-20', future, active)
  }
  // maxKeep=2 → 保留 j4(本次) + j3(最近)，撤销 j1/j2
  const removed = sessions.revokeExcess(1, 'j4', 2)
  assert.equal(removed, 2)
  assert.equal(sessions.exists('j4'), true)
  assert.equal(sessions.exists('j3'), true)
  // j1/j2 被撤销（exists 只数行不判 revoked，要看 isActive）
  assert.equal(sessions.isActive('j1'), false)
  assert.equal(sessions.isActive('j2'), false)
  assert.equal(sessions.isActive('j3'), true)
})

test('revokeExcess：开关关闭（maxKeep<=0）不处置', () => {
  const { sessions } = make()
  assert.equal(sessions.revokeExcess(1, 'x', 0), 0)
})
