import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CircuitBreaker,
  SingleFlight,
  TtlCache,
  clampPage,
  clampPageSize,
  headersKey,
  loadConfig,
  parseDotEnv,
  silentLogger,
} from '../src/index.ts'
import { scrubQuery } from '@loomproxy/contract'

test('TtlCache：TTL 过期与 LRU 上限都生效', () => {
  const c = new TtlCache<number>({ maxEntries: 2, ttlMs: 1000 })
  const t0 = 1_000_000
  c.set('a', 1, t0)
  c.set('b', 2, t0)
  assert.equal(c.get('a', t0), 1)
  c.set('c', 3, t0) // 淘汰最久未用的 b
  assert.equal(c.get('b', t0), undefined)
  assert.equal(c.get('a', t0), 1)
  assert.equal(c.get('c', t0), 3)
  assert.equal(c.get('a', t0 + 1001), undefined)
})

test('SingleFlight：同键在飞只跑一次', async () => {
  const sf = new SingleFlight()
  let calls = 0
  const fn = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 20))
    return 42
  }
  const [a, b, c] = await Promise.all([sf.do('k', fn), sf.do('k', fn), sf.do('k', fn)])
  assert.deepEqual([a, b, c], [42, 42, 42])
  assert.equal(calls, 1)
  await sf.do('k', async () => 1) // 完成后不残留
  assert.equal(sf.size, 0)
})

test('熔断：连续失败到阈值后快速失败，冷却到点放行一次探测', () => {
  const cb = new CircuitBreaker({ enabled: true, failures: 2, cooldownMs: 1000 })
  const t = 10_000
  assert.equal(cb.acquire('h', t), undefined)
  cb.failure('h', t)
  assert.equal(cb.acquire('h', t), undefined)
  cb.failure('h', t)
  assert.match(cb.acquire('h', t) ?? '', /熔断中/)
  // 冷却到点：只放一个探测
  assert.equal(cb.acquire('h', t + 1001), undefined)
  assert.match(cb.acquire('h', t + 1001) ?? '', /熔断中/)
  cb.success('h')
  assert.equal(cb.acquire('h', t + 1002), undefined)
})

test('配置：默认值与 Go 版一致；非法值必须出声（不许静默回落）', () => {
  const cfg = loadConfig({})
  assert.equal(cfg.serverPort, 8081)
  assert.equal(cfg.timeoutConnectMs, 5000)
  assert.equal(cfg.tzOffsetHours, 8)
  assert.equal(cfg.billingDedupeSec, 300)
  assert.deepEqual(cfg.authWhitelist, ['/', '/data', '/auth/register', '/auth/login', '/panel'])
  assert.equal(cfg.warnings.length, 0)

  const bad = loadConfig({ SERVER_PORT: 'abc', CIRCUIT_BREAKER_ENABLED: '1' })
  assert.equal(bad.serverPort, 8081)
  assert.equal(bad.circuitBreakerEnabled, true)
  assert.ok(bad.warnings.some((w) => w.includes('SERVER_PORT')))
})

test('配置：生产（开鉴权）拒绝默认 JWT 密钥——法"带病启动"必须有守卫', () => {
  assert.throws(() => loadConfig({ AUTH_ENABLED: 'true' }), /JWT_SECRET/)
  const ok = loadConfig({ AUTH_ENABLED: 'true', JWT_SECRET: 'x'.repeat(32) })
  assert.equal(ok.authEnabled, true)
})

test('.env 解析：真实环境变量优先，值两端引号被剥离', () => {
  const out = parseDotEnv(
    ['# 注释', 'A=1', 'B="two"', "C='three'", 'D=4', 'broken line'].join('\n'),
    { D: 'from-env' },
  )
  assert.deepEqual(out, { A: '1', B: 'two', C: 'three' })
})

test('headersKey 与日志脱敏', () => {
  assert.equal(headersKey({ b: '2', a: '1' }), 'a=1&b=2')
  assert.equal(scrubQuery('GET https://u/a?app_key=k&sig=s failed'), 'GET https://u/a?<redacted> failed')
  void silentLogger
})

test('分页夹只有一处：非法/越界页码回 1', () => {
  assert.equal(clampPage(undefined), 1)
  assert.equal(clampPage('0'), 1)
  assert.equal(clampPage('-3'), 1)
  assert.equal(clampPage('2.5'), 1)
  assert.equal(clampPage('7'), 7)
  assert.equal(clampPageSize('999'), 100)
})
