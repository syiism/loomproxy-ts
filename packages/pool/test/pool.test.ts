import test from 'node:test'
import assert from 'node:assert/strict'
import type { Device, DeviceStore, PoolDeviceRow, Quota } from '@loomproxy/contract'
import { silentLogger } from '@loomproxy/kernel'
import { Pool, KIND_SPREAD } from '../src/index.ts'

/** 内存版 DeviceStore：池运行时只认端口形状，用例不必起库 */
class MemStore implements DeviceStore {
  rows = new Map<string, PoolDeviceRow>()
  load(pool: string): PoolDeviceRow[] {
    return [...this.rows.entries()].filter(([k]) => k.startsWith(`${pool}:`)).map(([, v]) => v)
  }
  save(pool: string, row: PoolDeviceRow): void {
    this.rows.set(`${pool}:${row.ident}`, { ...row })
  }
  update(pool: string, ident: string, patch: Partial<PoolDeviceRow>): void {
    const key = `${pool}:${ident}`
    const cur = this.rows.get(key)
    if (cur) this.rows.set(key, { ...cur, ...patch })
  }
  remove(pool: string, ident: string): void {
    this.rows.delete(`${pool}:${ident}`)
  }
}

function fakeProvider(quota: Quota = { total: 3, used: 0 }) {
  let seq = 0
  const calls = { create: 0, refresh: 0, claim: 0 }
  return {
    calls,
    provider: {
      name: () => 'demo',
      async create(): Promise<Device> {
        calls.create++
        return { ident: `dev-${++seq}`, attrs: { sn: 'secret' }, quota }
      },
      async refresh(): Promise<Quota> {
        calls.refresh++
        return quota
      },
      async claim(): Promise<void> {
        calls.claim++
      },
    },
  }
}

test('墙钟型：启动补冷备 → 取号转正（Refresh+临期 Claim 各自到位）', async () => {
  const store = new MemStore()
  const { provider, calls } = fakeProvider({ total: 3, used: 0, expiresAt: new Date(Date.now() + 60_000) })
  const pool = new Pool({
    name: 'demo',
    provider,
    config: { coldSpares: 2, intervalMs: 3_600_000, renewBeforeMs: 5 * 60_000 },
    store,
    logger: silentLogger(),
  })
  await pool.start()
  assert.equal(calls.create, 2, '冷备补到 coldSpares')
  assert.equal(pool.status().counts['cold'], 2)

  const dev = await pool.acquire()
  assert.equal(dev.ident, 'dev-1')
  assert.equal(pool.status().counts['hot'], 1)
  assert.equal(pool.status().counts['cold'], 1)
  assert.ok(calls.refresh >= 1, '转正前刷台账')
  assert.ok(calls.claim >= 1, '临期续领（剩余 60s < renewBefore 5min）')
  await pool.stop()
})

test('墙钟型：额度耗尽转 spent，并从冷备补位', async () => {
  const store = new MemStore()
  let used = 0
  const provider = {
    name: () => 'demo',
    async create(): Promise<Device> {
      return { ident: `dev-${++used}`, attrs: {}, quota: { total: 1, used: 1 } }
    },
    async refresh(): Promise<Quota> {
      return { total: 1, used: 1 }
    },
    async claim(): Promise<void> {},
  }
  const pool = new Pool({ name: 'demo', provider, config: { coldSpares: 2 }, store, logger: silentLogger() })
  await pool.start()
  // 全部冷备都是"已耗尽"→ 取号会全部判 spent 并报错
  await assert.rejects(() => pool.acquire(), /无可用号/)
  assert.equal(pool.status().counts['spent'], 2)
  assert.equal(pool.status().counts['hot'], 0)
  await pool.stop()
})

test('摊薄型：不探活、风控失败进冷却，冷却期内不再被选中', async () => {
  const store = new MemStore()
  const { provider, calls } = fakeProvider({ total: 1, used: 0 })
  const pool = new Pool({
    name: 'demo',
    provider,
    config: { kind: KIND_SPREAD, coldSpares: 2, intervalMs: 3_600_000 },
    store,
    logger: silentLogger(),
  })
  await pool.start()
  assert.equal(calls.create, 2)
  assert.equal(calls.refresh, 0, '摊薄型启动不探活')

  const a = await pool.acquire()
  pool.report(new Error('risk invalid'))
  const s = pool.status()
  assert.equal(s.counts['cooldown'], 1, '失败上报 → 冷却')
  const b = await pool.acquire()
  assert.notEqual(a.ident, b.ident, '冷却中的号不再被选中')
  await pool.stop()
})

test('快照只列键名不列值（凭证不外泄）', async () => {
  const store = new MemStore()
  const { provider } = fakeProvider()
  const pool = new Pool({ name: 'demo', provider, config: { coldSpares: 1 }, store, logger: silentLogger() })
  await pool.start()
  const info = pool.status().devices[0]!
  assert.deepEqual(info.creds, ['sn'])
  assert.ok(!JSON.stringify(info).includes('secret'), '值不出接口')
  await pool.stop()
})
