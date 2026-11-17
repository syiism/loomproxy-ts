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
    const index = await app.inject({ method: 'GET', url: '/panel' })
    assert.equal(index.statusCode, 200)
    assert.match(index.headers['content-type'] ?? '', /text\/html/)
    assert.match(index.body, /id="app"/)

    const spa = await app.inject({ method: 'GET', url: '/panel/plugins' })
    assert.equal(spa.statusCode, 200)
    assert.match(spa.body, /id="app"/, '深层路由回退到 index.html（前端路由接管）')

    const asset = await app.inject({ method: 'GET', url: '/panel/assets/app.js' })
    assert.equal(asset.statusCode, 200)
    assert.match(asset.headers['content-type'] ?? '', /javascript/)
    assert.match(asset.headers['cache-control'] ?? '', /immutable/, '带 hash 的产物可以长缓存')
    await app.close()

    // 产物不在位：503 + 构建命令（不要静默 404，运维要能看懂下一步做什么）
    const missing = await compose({
      env: { PLUGIN_DIR: join(root, 'plugins'), DATA_DIR: join(root, 'data'), WEB_DIST: join(root, 'nope') },
      logger: silentLogger(),
    })
    const res = await missing.app.inject({ method: 'GET', url: '/panel' })
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
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
