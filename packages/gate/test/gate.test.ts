import test from 'node:test'
import assert from 'node:assert/strict'
import { ACCESS_REASONS, Ledger, RateLimiter, accessMessage, contentKeyOf, sourceAccessVerdict } from '../src/index.ts'
import type { SourceMeta } from '@loomproxy/contract'

const meta: SourceMeta = {
  code: 'demo',
  display: '演示',
  category: 'demo',
  sort_order: 1,
  status: 1,
  actions: ['search'],
  fixed_base_url: false,
}

test('访问判定：六种结论各走各的，顺序与 Go 版一致（启用判定先于管理员）', () => {
  const anon = (freePlanAllows: boolean) => ({ kind: 'anonymous' as const, freePlanAllows })
  const user = (o: { isAdmin?: boolean; hasPlan?: boolean; granted?: boolean } = {}) => ({
    kind: 'user' as const,
    isAdmin: o.isAdmin ?? false,
    hasPlan: o.hasPlan ?? true,
    granted: o.granted ?? false,
  })
  assert.equal(sourceAccessVerdict({ meta: undefined, enabled: true, caller: anon(true) }), ACCESS_REASONS.not_found)
  assert.equal(sourceAccessVerdict({ meta, enabled: false, caller: anon(true) }), ACCESS_REASONS.disabled)
  assert.equal(
    sourceAccessVerdict({ meta, enabled: false, caller: user({ isAdmin: true }) }),
    ACCESS_REASONS.disabled,
    '管理员也不能用被禁用的源（Go 版同序）',
  )
  assert.equal(sourceAccessVerdict({ meta, enabled: true, caller: anon(true) }), ACCESS_REASONS.ok)
  assert.equal(sourceAccessVerdict({ meta, enabled: true, caller: anon(false) }), ACCESS_REASONS.need_login)
  assert.equal(sourceAccessVerdict({ meta, enabled: true, caller: user({ isAdmin: true }) }), ACCESS_REASONS.ok)
  assert.equal(sourceAccessVerdict({ meta, enabled: true, caller: user() }), ACCESS_REASONS.ungranted)
  assert.equal(sourceAccessVerdict({ meta, enabled: true, caller: user({ hasPlan: false }) }), ACCESS_REASONS.no_plan)
  assert.equal(sourceAccessVerdict({ meta, enabled: true, caller: user({ granted: true }) }), ACCESS_REASONS.ok)
  assert.match(accessMessage(ACCESS_REASONS.ungranted), /套餐/)
})

test('双维限流：IP 与用户各有一桶，两者都放行才放行', () => {
  let now = 1_000_000
  const rl = new RateLimiter(() => now)
  // 间隔型：同一秒内第二次拒绝，过 1s 放行
  assert.equal(rl.allow('u:1:demo:search', { intervalMs: 1000 }), true)
  assert.equal(rl.allow('u:1:demo:search', { intervalMs: 1000 }), false)
  now += 1001
  assert.equal(rl.allow('u:1:demo:search', { intervalMs: 1000 }), true)

  // 窗口型：3 次/分钟
  now = 2_000_000
  assert.equal(rl.allow('ip:1.2.3.4', { count: 3, windowMs: 60_000 }), true)
  assert.equal(rl.allow('ip:1.2.3.4', { count: 3, windowMs: 60_000 }), true)
  assert.equal(rl.allow('ip:1.2.3.4', { count: 3, windowMs: 60_000 }), true)
  assert.equal(rl.allow('ip:1.2.3.4', { count: 3, windowMs: 60_000 }), false)
})

test('计费：同内容在窗口内只扣一次，换一章照扣', () => {
  let now = 1_000_000
  const led = new Ledger(() => now)
  const p1 = { bookId: 'b1', itemId: 'c1' }
  assert.equal(led.charge(1, 'demo', 'content', contentKeyOf('content', p1), 2, 300_000), true)
  assert.equal(led.charge(1, 'demo', 'content', contentKeyOf('content', p1), 2, 300_000), false, '客户端重试不该重复扣')
  assert.equal(led.usedToday(1, 'demo'), 2)
  const p2 = { bookId: 'b1', itemId: 'c2' }
  assert.equal(led.charge(1, 'demo', 'content', contentKeyOf('content', p2), 2, 300_000), true)
  assert.equal(led.usedToday(1, 'demo'), 4)

  // 预检：已用 4，限 4 再加 1 就超
  assert.equal(led.canCharge(1, 'demo', 4, 1), false)
  assert.equal(led.canCharge(1, 'demo', 5, 1), true)
  assert.equal(led.canCharge(1, 'demo', -1, 99), true, 'limit<0 = 不限')
})
