import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, silentLogger, Upstream } from '@loomproxy/kernel'
import { SourceRegistry } from '@loomproxy/source-kit'
import {
  DbApiKeys,
  DbCallLogs,
  DbQuota,
  DbDataSources,
  DbPlans,
  DbRoles,
  DbSessions,
  DbSettings,
  DbUsers,
  InMemorySettings,
  SqliteDb,
} from '@loomproxy/store'
import { SourceHost } from '@loomproxy/source-host'
import { buildServer, signToken } from '../src/index.ts'
import { RateLimiter } from '@loomproxy/gate'

const SECRET = 'test-secret-0123456789abcdef0123456789'

function makePluginDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-api-'))
  const v = join(root, 'plugins', 'demo_one', '1.0.0')
  mkdirSync(v, { recursive: true })
  writeFileSync(
    join(v, 'manifest.json'),
    JSON.stringify({
      sdk_version: '^1',
      entry: './index.mjs',
      params: { search: ['key'], content: ['bookId', 'itemId'] },
      meta: {
        code: 'demo_one',
        display: '演示一号',
        category: 'demo',
        sort_order: 1,
        status: 1,
        actions: ['search', 'content'],
        required_params: { content: ['itemId'] },
        media_type: 'novel',
        search_tabs: [{ tab_type: 3, bd_id: '2', name: '小说', media_type: 'novel' }],
      },
    }),
  )
  writeFileSync(
    join(v, 'index.mjs'),
    `export default { handlers: {
       search: async (ctx) => ({ bookList: [{ bookId: 'b1', name: 'n-' + (ctx.params.key ?? ''), author: 'a',
         kind: 'stale,小说', wordCount: '', lastChapter: '', intro: '', coverUrl: '' }] }),
       content: async () => ({ contentType: 'novel', data: { content: '正文' } }),
     } }`,
  )
  return root
}

async function makeApp() {
  const root = makePluginDir()
  const config = loadConfig({ JWT_SECRET: SECRET, DATA_DIR: join(root, 'data'), PLUGIN_DIR: join(root, 'plugins') })
  const logger = silentLogger()
  const registry = new SourceRegistry()
  const db = new SqliteDb(':memory:')
  db.migrate()
  const settings = new DbSettings(db)
  const dataSources = new DbDataSources(db)
  const upstream = new Upstream({ config, logger })
  const host = new SourceHost({
    pluginDir: config.pluginDir,
    logger,
    registry,
    settings,
    dataSources,
    upstream,
    drainTimeoutMs: 500,
  })
  await host.scanSync()
  // 每个请求把时钟推进 5s：本用例要验的是派发形状，不是限流
  let tick = 0
  const limiter = new RateLimiter(() => 1_000_000 + tick++ * 5_000)
  // 真实 SQLite（:memory:）+ 播种：路由要的是 DbUsers 这一组，用内存替身测不到 join/角色
  const users = new DbUsers(db)
  const roles = new DbRoles(db)
  const plans = new DbPlans(db)
  const sessions = new DbSessions(db)
  const apiKeys = new DbApiKeys(db)
  const callLogs = new DbCallLogs(db)
  const quota = new DbQuota(db)
  for (const r of [
    { code: 'admin', name: '管理员', description: '' },
    { code: 'user', name: '用户', description: '' },
  ]) {
    roles.create(r)
  }
  const plan = plans.create({ name: '基础版', code: 'basic' })
  users.create({ username: 'admin', password: 'secret-pass', planId: plan.id, roles: ['admin'] })
  users.create({ username: 'u', password: 'u-pass', planId: plan.id, roles: ['user'] })
  const app = buildServer({
    config, logger, upstream, host, dataSources, settings, limiter,
    users, roles, plans, sessions, apiKeys, callLogs, quota,
  })
  return { app, root, config, host, callLogs, users, quota, plans }
}

const adminToken = () => signToken({ user_id: 1, username: 'admin', roles: ['admin'] }, SECRET)
const userToken = () => signToken({ user_id: 2, username: 'u' }, SECRET)

test('存活探针是裸对象（不是信封）', async () => {
  const { app, root } = await makeApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { app: 'LoomProxy', status: 'ok', panel: '/panel' })
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('/datasources：只列已加载且启用的源，形状与 Go 版一致', async () => {
  const { app, root } = await makeApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/datasources' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { code: number; msg: string; data: Array<Record<string, unknown>> }
    assert.equal(body.code, 0)
    assert.equal(body.msg, 'ok')
    assert.equal(body.data.length, 1)
    const item = body.data[0]!
    assert.equal(item['id'], 'demo_one')
    assert.equal(item['name'], '演示一号')
    assert.equal(item['media_type'], 'novel')
    assert.deepEqual(item['search_tab'], [{ tab_type: 3, bd_id: '2', name: '小说', media_type: 'novel' }])
    assert.deepEqual(item['files'], [])
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('数据面是裸对象：search 打标 source/kind，content 原样返回', async () => {
  const { app, root } = await makeApp()
  try {
    const search = await app.inject({ method: 'GET', url: '/demo_one/search?key=三体' })
    assert.equal(search.statusCode, 200)
    const sBody = search.json() as { bookList: Array<{ source: string; kind: string; name: string }>; code?: number }
    assert.equal(sBody.code, undefined, '数据面不许出现 code/msg 信封')
    assert.equal(sBody.bookList[0]!.name, 'n-三体', '只注入声明过的 query')
    assert.equal(sBody.bookList[0]!.source, 'demo_one')
    assert.equal(sBody.bookList[0]!.kind, 'demo_one,stale,小说')

    // 未声明的 query 不注入
    const extra = await app.inject({ method: 'GET', url: '/demo_one/search?key=三体&baseUrl=http://evil' })
    assert.equal((extra.json() as { bookList: Array<{ name: string }> }).bookList[0]!.name, 'n-三体')

    const content = await app.inject({ method: 'GET', url: '/demo_one/content?bookId=b1&itemId=c1' })
    assert.equal(content.statusCode, 200)
    assert.deepEqual(content.json(), { contentType: 'novel', data: { content: '正文' } })
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('必填参数缺失 → 400 信封（不许落到源的带内错误）', async () => {
  const { app, root } = await makeApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/demo_one/content?bookId=b1' })
    assert.equal(res.statusCode, 400)
    const body = res.json() as { code: number; msg: string }
    assert.equal(body.code, -1, 'code 取 ERROR_CODE，不是 HTTP 码')
    assert.match(body.msg, /itemId/)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('未知源 404；未登录访问受保护的控制面 401', async () => {
  const { app, root } = await makeApp()
  try {
    const nf = await app.inject({ method: 'GET', url: '/nope/search?key=x' })
    assert.equal(nf.statusCode, 404)
    assert.deepEqual(nf.json(), { code: 404, msg: 'not found' })

    const ep = await app.inject({ method: 'GET', url: '/endpoints' })
    assert.equal(ep.statusCode, 401)
    assert.match((ep.json() as { msg: string }).msg, /登录归属/)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件管理：要管理员；reload 生效且 /datasources 跟着变；rollback 可回退', async () => {
  const { app, root, host } = await makeApp()
  try {
    const forbidden = await app.inject({ method: 'GET', url: '/admin/sources/plugins', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal(forbidden.statusCode, 403)

    const okRes = await app.inject({
      method: 'GET',
      url: '/admin/sources/plugins',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal(okRes.statusCode, 200)
    const list = (okRes.json() as { data: Array<{ code: string; state: string; version: string }> }).data
    assert.equal(list[0]?.code, 'demo_one')
    assert.equal(list[0]?.state, 'active')

    // 加一个高版本，reload 后 /datasources 立即反映（不用重启）
    const v = join(root, 'plugins', 'demo_one', '1.1.0')
    mkdirSync(v, { recursive: true })
    writeFileSync(
      join(v, 'manifest.json'),
      JSON.stringify({
        sdk_version: '^1',
        entry: './index.mjs',
        meta: {
          code: 'demo_one',
          display: '演示一号 v2',
          category: 'demo',
          sort_order: 1,
          status: 1,
          actions: ['search'],
        },
      }),
    )
    writeFileSync(join(v, 'index.mjs'), `export default { handlers: { search: async () => ({ bookList: [] }) } }`)

    const reload = await app.inject({
      method: 'POST',
      url: '/admin/sources/demo_one/reload',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal(reload.statusCode, 200)
    assert.equal((reload.json() as { data: { version: string } }).data.version, '1.1.0')

    const ds = await app.inject({ method: 'GET', url: '/datasources' })
    const item = (ds.json() as { data: Array<{ name: string }> }).data[0]
    assert.equal(item?.name, '演示一号 v2', '清单必须跟着换代')

    // rollback 回 1.0.0
    const rb = await app.inject({
      method: 'POST',
      url: '/admin/sources/demo_one/rollback',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal(rb.statusCode, 200)
    assert.equal((rb.json() as { data: { version: string } }).data.version, '1.0.0')
    assert.equal(host.registryRef.get('demo_one')?.version, '1.0.0')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('静态字典：缺文件 404 且不列清单', async () => {
  const { app, root } = await makeApp()
  try {
    const miss = await app.inject({ method: 'GET', url: '/data/demo_one/nope' })
    assert.equal(miss.statusCode, 404)
    assert.deepEqual(miss.json(), { error: 'not found' })

    const index = await app.inject({ method: 'GET', url: '/data' })
    assert.equal(index.statusCode, 200)
    const body = index.json() as { data: { count: number; sources: Record<string, unknown> } }
    assert.equal(body.data.count, 0)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('登录：错密码 401，对密码拿到 token，/auth/me 认 token', async () => {
  const { app, root } = await makeApp()
  try {
    const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'x' } })
    assert.equal(bad.statusCode, 401)
    assert.match((bad.json() as { msg: string }).msg, /用户名或密码错误/)

    const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'secret-pass' } })
    assert.equal(ok.statusCode, 200)
    const body = ok.json() as {
      code: number
      data: { token: string; expires_at: string; user: { username: string; roles: Array<{ code: string }> } }
    }
    assert.equal(body.code, 0)
    assert.ok(body.data.token.split('.').length === 3)
    // 面板读 `r.code`（isAdmin() 就是这么判的），所以 roles 是对象数组
    assert.equal(body.data.user.roles[0]?.code, 'admin')

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${body.data.token}` } })
    assert.equal(me.statusCode, 200)
    assert.equal((me.json() as { data: { username: string } }).data.username, 'admin')

    const anon = await app.inject({ method: 'GET', url: '/auth/me' })
    assert.equal(anon.statusCode, 401)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('明细：每次派发落一行并带 plugin_version，历史页可按版本筛（④ §7 批准的第三格）', async () => {
  const { app, root, callLogs } = await makeApp()
  try {
    const token = adminToken()
    const search = await app.inject({ method: 'GET', url: '/demo_one/search?key=x' })
    assert.equal(search.statusCode, 200)
    const miss = await app.inject({ method: 'GET', url: '/demo_one/content?bookId=b1' })
    assert.equal(miss.statusCode, 400)
    assert.equal(callLogs.count(), 2, '成功与被拒的请求都进明细（Go 的 monitor 同口径）')

    const hit = await app.inject({
      method: 'GET',
      url: '/admin/monitor/history?plugin_version=1.0.0&source=demo_one',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(hit.statusCode, 200)
    const page = (hit.json() as { data: { total: number; list: Array<Record<string, unknown>> } }).data
    assert.equal(page.total, 2)
    const row = page.list.find((r) => r['status'] === 400)!
    assert.equal(row['plugin_version'], '1.0.0')
    assert.equal(row['action'], 'content')
    assert.equal(row['chapter_ident'], '')
    assert.ok(typeof row['latency_ms'] === 'number')

    const none = await app.inject({
      method: 'GET',
      url: '/admin/monitor/history?plugin_version=9.9.9',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal((none.json() as { data: { total: number } }).data.total, 0)

    // 非管理员不许看明细
    const forbidden = await app.inject({ method: 'GET', url: '/admin/monitor/history', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal(forbidden.statusCode, 403)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('reload-all：一次把所有插件换代，失败的各留 last_error', async () => {
  const { app, root } = await makeApp()
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/sources/reload-all',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal(res.statusCode, 200)
    const list = (res.json() as { data: Array<{ code: string; state: string; version: string }> }).data
    assert.equal(list.length, 1)
    assert.equal(list[0]?.code, 'demo_one')
    assert.equal(list[0]?.state, 'active')
    assert.equal(list[0]?.version, '1.0.0')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('额度域：授权即限额、超了 429、成功记账进流水（一次调用一行）', async () => {
  const { app, root, quota, plans } = await makeApp()
  try {
    const plan = plans.list()[0]!
    // 接口成本登记（装配时按插件的动作自动写；这里直接写同样的行）
    quota.upsertCost({ group_code: 'demo_one', interface: 'search', cost: 1 })
    quota.grant(plan.id, 'source', 'demo_one', 1)

    const first = await app.inject({ method: 'GET', url: '/demo_one/search?key=a', headers: { authorization: `Bearer ${adminToken()}` } })
    assert.equal(first.statusCode, 200)

    // 换搜索词（绕开去重窗口）再打：限额 1 用完了
    const second = await app.inject({ method: 'GET', url: '/demo_one/search?key=b', headers: { authorization: `Bearer ${adminToken()}` } })
    assert.equal(second.statusCode, 429)
    assert.match((second.json() as { msg: string }).msg, /额度已用完/)

    const logs = await app.inject({ method: 'GET', url: '/admin/usage-logs', headers: { authorization: `Bearer ${adminToken()}` } })
    const page = (logs.json() as { data: { total: number; list: Array<{ group_code: string; interface: string; cost: number }> } }).data
    assert.equal(page.total, 1, '只记成功那一发')
    assert.equal(page.list[0]?.group_code, 'demo_one')
    assert.equal(page.list[0]?.interface, 'search')
    assert.equal(page.list[0]?.cost, 1)

    // 看板：限额/已用/剩余
    const dash = await app.inject({ method: 'GET', url: '/quota/dashboard', headers: { authorization: `Bearer ${adminToken()}` } })
    const rows = (dash.json() as { data: { rows: Array<{ source: string; limit: number; used: number; remaining: number }> } }).data.rows
    assert.deepEqual(rows, [{ source: 'demo_one', limit: 1, used: 1, remaining: 0 }])
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
