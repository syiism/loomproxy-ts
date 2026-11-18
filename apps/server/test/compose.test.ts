// e2e：走"线上同一条装配路径"（compose），不起端口、用 inject。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { silentLogger } from '@loomproxy/kernel'
import { compose } from '../src/compose.ts'

test('装配：没有插件目录也能起（/datasources 为空），有插件则立即可派发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-compose-'))
  try {
    const empty = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data') },
      logger: silentLogger(),
    })
    const emptyRes = await empty.app.inject({ method: 'GET', url: '/datasources' })
    assert.deepEqual((emptyRes.json() as { data: unknown[] }).data, [])
    await empty.app.close()

    // 放一个插件进去，重新装配即可用（等价于进程启动时那段扫描）
    const v = join(root, 'plugins', 'p_one', '1.0.0')
    mkdirSync(v, { recursive: true })
    writeFileSync(
      join(v, 'manifest.json'),
      JSON.stringify({
        sdk_version: '^1',
        entry: './index.mjs',
        meta: { code: 'p_one', display: 'P1', category: 'p', actions: ['search'] },
      }),
    )
    writeFileSync(
      join(v, 'index.mjs'),
      `export default { handlers: { search: async () => ({ bookList: [{ bookId: '1', name: 'n', author: 'a', kind: 'k', wordCount: '', lastChapter: '', intro: '', coverUrl: '' }] }) } }`,
    )

    const { app, settings, dataSources } = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data') },
      logger: silentLogger(),
    })
    const res = await app.inject({ method: 'GET', url: '/p_one/search?key=x' })
    assert.equal(res.statusCode, 200)
    assert.equal((res.json() as { bookList: unknown[] }).bookList.length, 1)
    assert.equal(dataSources.get('p_one')?.status, 1)
    assert.equal(settings.get('missing_key'), '')
    await app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('面板：/panel 与 /panel/* 回 SPA，产物缺失时 503 且给出构建命令', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-web-'))
  try {
    const webDir = join(root, 'dist')
    mkdirSync(join(webDir, 'assets'), { recursive: true })
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>panel</title><div id="app"></div>')
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log("hi")')

    const { app } = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data'), WEB_DIST: webDir },
      logger: silentLogger(),
    })
    const index = await app.inject({ method: 'GET', url: '/' })
    assert.equal(index.statusCode, 200)
    assert.match(index.headers['content-type'] ?? '', /text\/html/)
    assert.match(index.body, /id="app"/)

    // 面板用 history 路由：深层链接是两段路径，与 /{source}/{action} 同形 —— 靠归属+Accept 区分
    const deep = await app.inject({ method: 'GET', url: '/admin/plugins', headers: { accept: 'text/html,*/*' } })
    assert.equal(deep.statusCode, 200)
    assert.match(deep.body, /id="app"/, '浏览器访问非源路径 → 回面板')
    const apiDeep = await app.inject({ method: 'GET', url: '/admin/plugins', headers: { accept: 'application/json' } })
    assert.equal(apiDeep.statusCode, 404, 'API 客户端仍拿到 404 JSON（下游契约不变）')

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' })
    assert.equal(asset.statusCode, 200)
    assert.match(asset.headers['content-type'] ?? '', /javascript/)
    assert.match(asset.headers['cache-control'] ?? '', /immutable/, '带 hash 的产物可以长缓存')
    await app.close()

    // 产物不在位：503 + 构建命令（不要静默 404，运维要能看懂下一步做什么）
    const missing = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data'), WEB_DIST: join(root, 'nope') },
      logger: silentLogger(),
    })
    const res = await missing.app.inject({ method: 'GET', url: '/' })
    assert.equal(res.statusCode, 503)
    assert.match((res.json() as { msg: string }).msg, /pnpm -F @loomproxy\/web build/)
    await missing.app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('登录 → 明细：一次数据面请求会被记进历史页（带 plugin_version）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-login-'))
  try {
    const pluginDir = join(root, 'plugins')
    const v = join(pluginDir, 'p_one', '1.0.0')
    mkdirSync(v, { recursive: true })
    writeFileSync(
      join(v, 'manifest.json'),
      JSON.stringify({
        sdk_version: '^1',
        entry: './index.mjs',
        meta: { code: 'p_one', display: 'P1', category: 'p', actions: ['search'] },
      }),
    )
    writeFileSync(
      join(v, 'index.mjs'),
      `export default { handlers: { search: async () => ({ bookList: [] }) } }`,
    )

    const { app } = await compose({
      env: {
        PLUGIN_DIR: pluginDir,
        DATA_DIR: join(root, 'data'),
        ADMIN_PASSWORD: 'adminpw',
        AUTH_ENABLED: 'true',
        JWT_SECRET: 'x'.repeat(32),
      },
      logger: silentLogger(),
    })
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'adminpw' },
    })
    assert.equal(login.statusCode, 200)
    const token = (login.json() as { data: { token: string } }).data.token

    await app.inject({ method: 'GET', url: '/p_one/search?key=x' })
    const hist = await app.inject({
      method: 'GET',
      url: '/admin/monitor/history?plugin_version=1.0.0',
      headers: { authorization: `Bearer ${token}` },
    })
    const page = (hist.json() as { data: { total: number; list: Array<{ source: string; plugin_version: string }> } }).data
    assert.equal(page.total, 1)
    assert.equal(page.list[0]?.source, 'p_one')
    assert.equal(page.list[0]?.plugin_version, '1.0.0')
    await app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('管理员口令：首启随机生成 → 写进 env 重启即生效；面板改过则以面板为准', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-adminpw-'))
  const base = {
    PLUGIN_DIR: join(root, 'plugins'),
    DATA_DIR: join(root, 'data'),
    JWT_SECRET: 'x'.repeat(32),
  }
  const attempt = async (extra: Record<string, string>, username: string, password: string) => {
    const c = await compose({ env: { ...base, ...extra }, logger: silentLogger() })
    const res = await c.app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })
    await c.app.close()
    return res.statusCode
  }
  try {
    // 首启没有 ADMIN_PASSWORD：随机生成（只出现在启动日志里）
    assert.equal(await attempt({}, 'admin', 'whatever'), 401)
    // 把口令写进 env 再重启：这一次必须生效（现场 2026-11-17 就是卡在这条）
    assert.equal(await attempt({ ADMIN_PASSWORD: 'env-pass' }, 'admin', 'env-pass'), 200)
    // 再重启一次仍然可用（口令来源标记 env）
    assert.equal(await attempt({ ADMIN_PASSWORD: 'env-pass' }, 'admin', 'env-pass'), 200)

    // 面板上改过密码 ⇒ 标记 panel；重启时 env 不再覆盖
    {
      const c = await compose({ env: { ...base, ADMIN_PASSWORD: 'env-pass' }, logger: silentLogger() })
      const login = await c.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'env-pass' } })
      const token = (login.json() as { data: { token: string } }).data.token
      const ch = await c.app.inject({
        method: 'POST',
        url: '/auth/password',
        headers: { authorization: `Bearer ${token}` },
        payload: { old_password: 'env-pass', new_password: 'panel-pass' },
      })
      assert.equal(ch.statusCode, 200)
      await c.app.close()
    }
    assert.equal(await attempt({ ADMIN_PASSWORD: 'env-pass' }, 'admin', 'env-pass'), 401, 'env 旧口令不该复活')
    assert.equal(await attempt({ ADMIN_PASSWORD: 'env-pass' }, 'admin', 'panel-pass'), 200, '面板口令继续有效')
    // 运维明确要求以 env 为准时才强制覆盖
    assert.equal(
      await attempt({ ADMIN_PASSWORD: 'env-pass', ADMIN_PASSWORD_SYNC: 'true' }, 'admin', 'env-pass'),
      200,
    )
    // 来源回到 env 之后，env 就是权威：改 env 的口令、重启即生效（不用再加 SYNC）。
    // 现场 2026-11-18：库里的来源标记写着 env，实际存的却是别处的口令，改了 .env 也登不上。
    assert.equal(await attempt({ ADMIN_PASSWORD: 'env-pass-2' }, 'admin', 'env-pass-2'), 200, '来源=env 时改 env 即生效')
    assert.equal(await attempt({ ADMIN_PASSWORD: 'env-pass-2' }, 'admin', 'env-pass'), 401, '旧 env 口令不能继续用')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('健康检查在 /health；/ 与 /* 是面板；/panel* 301 到根', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-root-'))
  try {
    const webDir = join(root, 'dist')
    mkdirSync(join(webDir, 'assets'), { recursive: true })
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="app"></div>')
    writeFileSync(join(webDir, 'assets', 'app.js'), 'x')
    const { app } = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data'), WEB_DIST: webDir },
      logger: silentLogger(),
    })

    const health = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { app: 'LoomProxy', status: 'ok' })

    const home = await app.inject({ method: 'GET', url: '/' })
    assert.equal(home.statusCode, 200)
    assert.match(home.headers['content-type'] ?? '', /text\/html/, '/ 现在是面板')

    const legacy = await app.inject({ method: 'GET', url: '/panel/admin/settings?x=1' })
    assert.equal(legacy.statusCode, 301)
    assert.equal(legacy.headers['location'], '/admin/settings?x=1', '旧链接一跳到位（干净路径），query 不丢')

    // 数据面仍然走 /:source/:action（不能被 /* 抢走）
    const api404 = await app.inject({ method: 'GET', url: '/nope/search?key=x' })
    assert.equal(api404.statusCode, 404)
    assert.deepEqual(api404.json(), { code: 404, msg: 'not found' })
    await app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文档导航 vs API：面板页给 HTML，API 给 JSON；report.html 未登录 302 到登录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-doc-'))
  try {
    const webDir = join(root, 'dist')
    mkdirSync(webDir, { recursive: true })
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="app"></div>')
    const v = join(root, 'plugins', 'p_one', '1.0.0')
    mkdirSync(v, { recursive: true })
    writeFileSync(join(v, 'manifest.json'), JSON.stringify({ sdk_version: '^1', entry: './index.mjs',
      meta: { code: 'p_one', display: 'P1', category: 'p', actions: ['search'] } }))
    writeFileSync(join(v, 'index.mjs'), `export default { handlers: { search: async () => ({ bookList: [] }) } }`)
    const { app } = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data'), WEB_DIST: webDir, ADMIN_PASSWORD: 'pw' },
      logger: silentLogger(),
    })

    // 面板页（同时也是 API 的路径）：浏览器文档导航 → HTML；fetch（通配 Accept）→ JSON
    const doc = await app.inject({ method: 'GET', url: '/admin/monitor', headers: { accept: 'text/html,*/*;q=0.8' } })
    assert.equal(doc.statusCode, 200)
    assert.match(doc.headers['content-type'] ?? '', /text\/html/)
    const fetchReq = await app.inject({ method: 'GET', url: '/admin/monitor', headers: { accept: '*/*' } })
    assert.equal(fetchReq.statusCode, 403, '未登录的 API 调用仍是 403 JSON')

    // 显式文档端点：未登录 302 到登录（不是把 JSON 甩给浏览器）
    const report = await app.inject({ method: 'GET', url: '/admin/monitor/report.html', headers: { accept: 'text/html' } })
    assert.equal(report.statusCode, 302)
    assert.match(report.headers['location'] ?? '', /^\/login\?next=/)

    // /datasources 两副面孔
    const dsDoc = await app.inject({ method: 'GET', url: '/datasources', headers: { accept: 'text/html' } })
    assert.match(dsDoc.headers['content-type'] ?? '', /text\/html/)
    const dsApi = await app.inject({ method: 'GET', url: '/datasources', headers: { accept: 'application/json' } })
    assert.match(dsApi.headers['content-type'] ?? '', /application\/json/)
    await app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
