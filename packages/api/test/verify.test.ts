// 验证码域单测：mock 发码 + SQLite :memory:，不连网、不连真 MySQL。
// 逐条对齐 Go 的 handlers/verify 与 test/p99_verify_gate_test.go 的判据。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteDb, DbVerification, seedBuiltinSettings, DbSettings } from '@loomproxy/store'
import { Issue, Check, Consume, VerifyError, verifyConfig, sceneEnabledFor, type VerifyDeps, type Settings } from '../src/verify.ts'

type Sent = { scene: string; target: string; code: string }

function make(opts: {
  scenes?: string; provider?: string; now?: number; dailyLimit?: string; interval?: string
} = {}) {
  const db = new SqliteDb(':memory:')
  db.migrate()
  const settings = new DbSettings(db)
  seedBuiltinSettings(settings)
  settings.set('verify_code_scenes', opts.scenes ?? 'register,forgot_password')
  settings.set('verify_provider', opts.provider ?? 'mock')
  if (opts.dailyLimit !== undefined) settings.set('verify_daily_send_limit', opts.dailyLimit)
  if (opts.interval !== undefined) settings.set('verify_send_interval_sec', opts.interval)
  const store = new DbVerification(db)
  const sent: Sent[] = []
  let clock = opts.now ?? Date.parse('2026-11-20T02:00:00.000Z')
  const deps: VerifyDeps = {
    settings: settings as unknown as Settings,
    store,
    dayStartIso: '2026-11-19T16:00:00.000Z',
    now: () => clock,
    send: async (scene, target, code) => { sent.push({ scene, target, code }) },
    log: () => {},
  }
  return { db, settings, store, sent, deps, setClock: (v: number) => { clock = v } }
}

test('发码成功：生成 6 位码（首位非0）、mock 通道拿到码、返回过期秒', async () => {
  const m = make()
  const exp = await Issue('1.2.3.4', 'register', '  User@Example.COM ', m.deps)
  assert.equal(m.sent.length, 1)
  assert.equal(m.sent[0]!.target, 'user@example.com') // 归一化小写
  assert.match(m.sent[0]!.code!, /^[1-9]\d{5}$/)
  assert.ok(exp > Math.floor(m.deps.now!() / 1000))
  const row = m.store.latest('register', 'user@example.com')!
  assert.ok(row)
  assert.notEqual(row.code_hash, m.sent[0]!.code) // 库里是 sha256，不是明文
})

test('校验成功 / 错误 / 已消费', async () => {
  const m = make()
  await Issue('1.2.3.4', 'register', 'a@b.com', m.deps)
  const code = m.sent[0]!.code!
  const id = Check('register', 'a@b.com', code, m.deps)
  assert.equal(typeof id, 'number')
  assert.throws(() => Check('register', 'a@b.com', '000000', m.deps), /验证码错误|错误次数过多/)
  assert.equal(Consume(id, m.deps), true)
  assert.equal(Consume(id, m.deps), false) // 一次性
  assert.throws(() => Check('register', 'a@b.com', code, m.deps), /验证码已过期/)
})

test('场景未启用 / 未知场景 / 目标格式错误 / 注册关闭', async () => {
  const m = make({ scenes: 'forgot_password' })
  await assert.rejects(Issue('ip', 'register', 'a@b.com', m.deps), /该场景未启用验证码/)
  await assert.rejects(Issue('ip', 'nope', 'a@b.com', m.deps), /未知的验证码场景/)
  await assert.rejects(Issue('ip', 'forgot_password', 'not-an-email', m.deps), /目标格式不正确/)
  // register_enabled=false 只拦 register 场景（Go 同口径）
  const m2 = make({ scenes: 'register' })
  m2.settings.set('register_enabled', 'false')
  await assert.rejects(Issue('ip', 'register', 'a@b.com', m2.deps), /注册功能已关闭/)
})

test('冷却：同目标间隔内二次发码被拦', async () => {
  const m = make({ interval: '60' })
  await Issue('ip', 'register', 'a@b.com', m.deps)
  await assert.rejects(Issue('ip', 'register', 'a@b.com', m.deps), /发送过于频繁/)
  m.setClock(m.deps.now!() + 61_000)
  await Issue('ip', 'register', 'a@b.com', m.deps) // 超过间隔后可再发
  assert.equal(m.sent.length, 2)
})

test('日限：同目标当日达到上限被拦', async () => {
  const m = make({ dailyLimit: '2', interval: '0' })
  await Issue('ip', 'register', 'a@b.com', m.deps)
  await Issue('ip', 'register', 'a@b.com', m.deps)
  await assert.rejects(Issue('ip', 'register', 'a@b.com', m.deps), /已达上限/)
})

test('尝试次数超限：连续错误达 maxAttempts 作废', async () => {
  const m = make()
  await Issue('ip', 'register', 'a@b.com', m.deps)
  const code = m.sent[0]!.code!
  const wrong = code === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) {
    try { Check('register', 'a@b.com', wrong, m.deps) } catch (e) {
      if (i < 4) assert.match((e as Error).message, /验证码错误/)
      else assert.match((e as Error).message, /错误次数过多/)
    }
  }
})

test('http sender：占位符替换 + 成功关键字（本地假 HTTP，不连外网）', async () => {
  const { createServer } = await import('node:http')
  let received: { url: string; body: string; auth: string } | undefined
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received = { url: req.url ?? '', body, auth: String(req.headers['x-api-key'] ?? '') }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"code":200,"msg":"ok"}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const m = make({ provider: 'http', interval: '0' })
    m.settings.set('verify_http_url', `http://127.0.0.1:${port}/send`)
    m.settings.set('verify_http_method', 'POST')
    m.settings.set('verify_http_body', '{"to":"{{target}}","code":"{{code}}","scene":"{{scene}}"}')
    m.settings.set('verify_http_headers', '{"x-api-key":"k-{{scene}}","content-type":"application/json"}')
    m.settings.set('verify_http_success_keyword', '"code":200')
    // 不注入 send，走真实 http sender 到本地假服务
    m.deps.send = undefined
    await Issue('ip', 'register', 'a@b.com', m.deps)
    assert.ok(received)
    const code = m.store.latest('register', 'a@b.com')! // 不验明文，验 body 结构
    assert.ok(code)
    assert.match(received!.body, /"to":"a@b.com"/)
    assert.match(received!.body, /"scene":"register"/)
    assert.match(received!.body, /"code":"[1-9]\d{5}"/)
    assert.equal(received!.auth, 'k-register')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('verifyConfig：场景/ttl/interval 与 Go 形状一致', () => {
  const m = make()
  const c = verifyConfig(m.settings)
  assert.deepEqual(c.scenes.sort(), ['forgot_password', 'register'])
  assert.equal(c.ttl, 600)
  assert.equal(c.send_interval, 60)
  assert.equal(sceneEnabledFor(m.settings, 'register'), true)
})
