// 设备与密钥读数：排序（白名单/方向/稳定二级键）与标红阈值，对齐 Go 的 devices.go。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteDb } from '../src/sqlite.ts'
import { DbDevices } from '../src/devices.ts'

function make() {
  const db = new SqliteDb(':memory:')
  db.migrate()
  // 三个用户：不同活跃会话数 / IP 数，最后一个从未登录
  for (const [u, sess] of [['alice', 1], ['bob', 5], ['carol', 3]] as Array<[string, number]>) {
    db.run('INSERT INTO users (username,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?)', u, 'x', 1, '2026-01-01', '2026-01-01')
    const uid = Number(db.get<{ id: number }>('SELECT id FROM users WHERE username=?', u)!.id)
    for (let i = 0; i < sess; i++) {
      db.run('INSERT INTO sessions (user_id,jti,ip,user_agent,created_at,expires_at) VALUES (?,?,?,?,?,?)',
        uid, `${u}-${i}`, `1.2.3.${i}`, `ua${i}`, '2026-01-01', '2099-01-01')
    }
  }
  return { db, devices: new DbDevices(db) }
}

const base = { page: 1, pageSize: 10, windowStartIso: '2020-01-01', suspectIps: 3 }

test('排序：按活跃会话降序，非法 sort 回默认', () => {
  const { devices } = make()
  const desc = devices.page({ ...base, sort: 'sessions', dir: 'desc' })
  assert.equal(desc.sort, 'sessions')
  assert.deepEqual(desc.list.map((r) => r.active_sessions), [5, 3, 1])
  const asc = devices.page({ ...base, sort: 'sessions', dir: 'asc' })
  assert.deepEqual(asc.list.map((r) => r.active_sessions), [1, 3, 5])
  const fallback = devices.page({ ...base, sort: 'bogus' })
  assert.equal(fallback.sort, 'sessions') // 非法值回默认
})

test('回显 sort/dir + config 由 handler 下发；store 只回 sort/dir', () => {
  const { devices } = make()
  const r = devices.page({ ...base, sort: 'sessions', dir: 'asc' })
  assert.equal(r.dir, 'asc')
  assert.equal(r.sort, 'sessions')
})

test('标红：login_ips >= 阈值即 suspect（只看 IP，不看会话数）', () => {
  const { devices } = make()
  const r = devices.page({ ...base, suspectIps: 3 })
  // bob 有 5 个会话（5 个不同 IP）→ login_ips=5 >= 3 标红；alice 1 个不标
  const bob = r.list.find((x) => x.username === 'bob')!
  const alice = r.list.find((x) => x.username === 'alice')!
  assert.equal(bob.suspect, true)
  assert.equal(alice.suspect, false)
})

test('分页切片在排序之后', () => {
  const { devices } = make()
  const p2 = devices.page({ ...base, page: 2, pageSize: 2, sort: 'sessions', dir: 'desc' })
  assert.equal(p2.total, 3)
  assert.equal(p2.list.length, 1)
  assert.equal(p2.list[0]!.active_sessions, 1) // 第 3 名
})
