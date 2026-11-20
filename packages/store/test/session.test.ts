// 会话现行校验：jwt_expire_hours=-1（永不过期）签出的票 expires_at=1970 哨兵，
// 必须被认作有效，否则登录成功但 /auth/me 立刻 401（迁移后出现，Go 版对应写 100 年后）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteDb } from '../src/sqlite.ts'
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
