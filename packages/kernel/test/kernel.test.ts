import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CircuitBreaker,
  SingleFlight,
  TtlCache,
  UA_ROTATE,
  Upstream,
  clampPage,
  clampPageSize,
  headersKey,
  loadConfig,
  parseDotEnv,
  proxyEnabledFor,
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

// ==== 代理池 / UA 轮换（env 来的两个配置真的生效吗） ====

/** 极简 HTTP 正向代理：undici 的 ProxyAgent 走 CONNECT 隧道 */
async function startTunnelProxy() {
  const tunnels: string[] = []
  const server = createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, socket, head) => {
    tunnels.push(req.url ?? '')
    const [host, port] = (req.url ?? '').split(':')
    const up = connect(Number(port), host === 'localhost' ? '127.0.0.1' : (host as string), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, tunnels, url: `http://127.0.0.1:${port}` }
}

async function startUpstreamTarget() {
  const hits: Array<{ ua: string | undefined }> = []
  const server = createServer((req, res) => {
    hits.push({ ua: req.headers['user-agent'] })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, hits, url: `http://127.0.0.1:${port}/api` }
}

test('IP 代理：UPSTREAM_PROXIES 与 UPSTREAM_PROXY_FILE 都真的走代理（# 注释、热加载）', async () => {
  const proxy = await startTunnelProxy()
  const target = await startUpstreamTarget()
  const dir = mkdtempSync(join(tmpdir(), 'loomproxy-proxy-'))
  const cfg = (extra: Record<string, string> = {}) => loadConfig({ JWT_SECRET: 'x'.repeat(32), ...extra })
  try {
    // 直连基线
    {
      const up = new Upstream({ config: cfg(), logger: silentLogger() })
      assert.deepEqual(await up.fetchJson(target.url), { ok: true })
      assert.equal(proxy.tunnels.length, 0)
    }
    // env 名单
    {
      const up = new Upstream({ config: cfg({ UPSTREAM_PROXIES: proxy.url }), logger: silentLogger() })
      assert.deepEqual(await up.fetchJson(target.url), { ok: true })
      assert.equal(proxy.tunnels.length, 1, 'UPSTREAM_PROXIES 必须真的把请求交给代理')
    }
    // 文件（含注释行）+ 热加载：改文件后不重启也要生效
    {
      const file = join(dir, 'proxies.txt')
      writeFileSync(file, '# 注释\n\n')
      const up = new Upstream({ config: cfg({ UPSTREAM_PROXY_FILE: file }), logger: silentLogger() })
      await up.fetchJson(target.url)
      assert.equal(proxy.tunnels.length, 1, '文件里没有可用代理时直连')

      writeFileSync(file, `# 换成真代理\n${proxy.url}\n`)
      // 5s 内不重复 stat，换文件后要等一下子才生效——这是与 Go 的 proxyFileReload 同一取舍
      await new Promise((r) => setTimeout(r, 5_100))
      await up.fetchJson(target.url)
      assert.equal(proxy.tunnels.length, 2, '文件热加载：不重启进程就该切到新代理')
    }
    // 按源/接口门控（设置项 proxy_enabled_sources 的判定函数）
    {
      assert.equal(proxyEnabledFor('', { source: 'a', action: 'search' }), true)
      assert.equal(proxyEnabledFor('a', { source: 'a', action: 'chapter' }), true)
      assert.equal(proxyEnabledFor('a/chapter', { source: 'a', action: 'chapter' }), true)
      assert.equal(proxyEnabledFor('a/chapter', { source: 'a', action: 'content' }), false)
      assert.equal(proxyEnabledFor('b', { source: 'a', action: 'search' }), false)

      const up = new Upstream({
        config: cfg({ UPSTREAM_PROXIES: proxy.url }),
        logger: silentLogger(),
        proxyAllowedFor: (scope) => proxyEnabledFor('b', scope),
      })
      await up.fetchJson(target.url, { scope: { source: 'a', action: 'search' } })
      assert.equal(proxy.tunnels.length, 2, '不在名单里的源不消耗代理')
      await up.fetchJson(target.url, { scope: { source: 'b', action: 'search' } })
      assert.equal(proxy.tunnels.length, 3, '在名单里的源走代理')
    }
  } finally {
    proxy.server.close()
    target.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('UA 轮换：UPSTREAM_UA_ROTATE 生效，且源显式给的 UA 优先', async () => {
  const target = await startUpstreamTarget()
  const cfg = (extra: Record<string, string> = {}) => loadConfig({ JWT_SECRET: 'x'.repeat(32), ...extra })
  try {
    {
      const up = new Upstream({ config: cfg({ UPSTREAM_UA_ROTATE: 'true' }), logger: silentLogger() })
      for (let i = 0; i < 12; i++) await up.fetchText(target.url)
      const uas = target.hits.map((h) => h.ua)
      assert.ok(uas.every((ua) => ua !== undefined && UA_ROTATE.includes(ua)), '轮换出来的 UA 必须来自声明的那一份池子')
      assert.ok(new Set(uas).size > 1, '多请求之间要有轮换（否则等于没开）')
    }
    {
      target.hits.length = 0
      const up = new Upstream({ config: cfg({ UPSTREAM_UA_ROTATE: 'false' }), logger: silentLogger() })
      await up.fetchText(target.url)
      await up.fetchText(target.url, { headers: { 'User-Agent': 'reading/9.9' } })
      assert.notEqual(target.hits[0]?.ua, undefined, '未开轮换时用 undici 默认 UA')
      assert.notEqual(target.hits[0]?.ua, 'reading/9.9')
      assert.equal(target.hits[1]?.ua, 'reading/9.9', '源显式给的 UA 不许被平台覆盖')
    }
  } finally {
    target.server.close()
  }
})

test('fetchRaw：响应头（含多值 set-cookie）透传；缓存命中不回放 cookie', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-probe': 'v1',
      'set-cookie': ['novel_browser_token=v1.123.abc; Path=/', 'device=d1; Path=/'],
    })
    res.end('hello')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`
  const up = new Upstream({
    config: loadConfig({ JWT_SECRET: 'x'.repeat(32) }),
    logger: silentLogger(),
    cache: new TtlCache({ maxEntries: 8, ttlMs: 60_000 }),
  })
  try {
    const first = await up.fetchRaw(url, { cacheKey: 'bootstrap', ttlMs: 60_000 })
    assert.equal(first.headers['x-probe']?.[0], 'v1')
    assert.deepEqual(first.headers['set-cookie'], [
      'novel_browser_token=v1.123.abc; Path=/',
      'device=d1; Path=/',
    ])
    const second = await up.fetchRaw(url, { cacheKey: 'bootstrap', ttlMs: 60_000 })
    assert.equal(new TextDecoder().decode(second.body), 'hello')
    assert.deepEqual(second.headers, {}, '缓存里只放 body，不能把过期 token 当新的还给插件')
  } finally {
    server.close()
  }
})
