import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, silentLogger, Upstream } from '@loomproxy/kernel'
import { SourceRegistry } from '@loomproxy/source-kit'
import {
  DbApiKeys,
  DbBlockedIPs,
  DbCallLogs,
  DbDevices,
  DbQuota,
  DbQuotaExtra,
  DbSourceGroups,
  DbDataSources,
  DbPlans,
  DbRoles,
  DbSessions,
  DbSettings,
  DbUsers,
  seedBuiltinSettings,
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
  // 内置设置（29 条）也一起播：注册开关/维护模式/验证码场景这些行为项都要有行才能改
  seedBuiltinSettings(settings)
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
  const sourceGroups = new DbSourceGroups(db, quota)
  const quotaExtra = new DbQuotaExtra(db, quota)
  const blockedIPs = new DbBlockedIPs(db)
  const devices = new DbDevices(db)
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
    users, roles, plans, sessions, apiKeys, callLogs, quota, quotaExtra, sourceGroups, blockedIPs, devices,
  })
  return { app, root, config, host, callLogs, users, quota, plans, quotaExtra, blockedIPs, dataSources, sessions, apiKeys, roles, settings }
}

const adminToken = () => signToken({ user_id: 1, username: 'admin', roles: ['admin'] }, SECRET)
const userToken = () => signToken({ user_id: 2, username: 'u' }, SECRET)

test('健康检查是裸对象（不是信封），挂在 /health；/ 归面板', async () => {
  const { app, root } = await makeApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { app: 'LoomProxy', status: 'ok' })
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
    // 源声明了 media_type 且响应里没有 bookTypeCode → 明细这一格必须是声明的媒介，
    // 不许留空（面板的媒介筛选、覆盖率、内容榜都读它，空=“未判定”）
    const searchRow = page.list.find((r) => r['action'] === 'search')!
    assert.equal(searchRow['media_type'], 'novel')

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

    const first = await app.inject({ method: 'GET', url: '/demo_one/search?key=a', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal(first.statusCode, 200)

    // 换搜索词（绕开去重窗口）再打：限额 1 用完了
    const second = await app.inject({ method: 'GET', url: '/demo_one/search?key=b', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal(second.statusCode, 429)
    assert.match((second.json() as { msg: string }).msg, /额度已用完/)

    const logs = await app.inject({ method: 'GET', url: '/admin/usage-logs', headers: { authorization: `Bearer ${adminToken()}` } })
    const page = (logs.json() as { data: { total: number; list: Array<{ group_code: string; interface: string; cost: number }> } }).data
    assert.equal(page.total, 1, '只记成功那一发')
    assert.equal(page.list[0]?.group_code, 'demo_one')
    assert.equal(page.list[0]?.interface, 'search')
    assert.equal(page.list[0]?.cost, 1)

    // 看板（普通用户视角）：形状照 Go 的 DashboardResponse，源卡读 effective_total/used_today/remaining/usage_pct
    const dash = await app.inject({ method: 'GET', url: '/quota/dashboard', headers: { authorization: `Bearer ${userToken()}` } })
    const body = (dash.json() as {
      data: {
        is_admin: boolean
        plan_name: string
        sources: Array<{ source_code: string; effective_total: number; used_today: number; remaining: number; usage_pct: number; next_reset: string }>
      }
    }).data
    assert.equal(body.is_admin, false)
    assert.equal(body.plan_name, '基础版')
    assert.equal(body.sources.length, 1, '非管理员只见套餐授权的源')
    const card = body.sources[0]!
    assert.equal(card.source_code, 'demo_one')
    assert.equal(card.effective_total, 1)
    assert.equal(card.used_today, 1)
    assert.equal(card.remaining, 0)
    assert.equal(card.usage_pct, 100)
    assert.match(card.next_reset, /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:00$/)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('黑名单：数据面入口直接 403（与登录共用一张表）', async () => {
  const { app, root, blockedIPs } = await makeApp()
  try {
    blockedIPs.add('127.0.0.1', 'test')
    const res = await app.inject({ method: 'GET', url: '/demo_one/search?key=x', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal(res.statusCode, 403)
    assert.match((res.json() as { msg: string }).msg, /IP 已被拉黑/)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('额度转移：两个已授权源之间重排日限额，流水一行、覆盖增量立刻生效', async () => {
  const { app, root, quota, plans, dataSources } = await makeApp()
  try {
    // 造第二个源（同一条装配路径：插件 upsert 的等价物）
    dataSources.upsert({
      code: 'demo_two',
      display: '演示二号',
      category: 'demo',
      sort_order: 2,
      status: 1,
      actions: ['search'],
      fixed_base_url: false,
    })
    const plan = plans.list()[0]!
    quota.grant(plan.id, 'source', 'demo_one', 10)
    quota.grant(plan.id, 'source', 'demo_two', 5)

    const res = await app.inject({
      method: 'POST',
      url: '/quota/transfer',
      headers: { authorization: `Bearer ${userToken()}` },
      payload: { from: 'demo_one', to: 'demo_two', amount: 3 },
    })
    assert.equal(res.statusCode, 200)
    const row = (res.json() as { data: { from_after: number; to_after: number; amount: number } }).data
    assert.equal(row.from_after, 7)
    assert.equal(row.to_after, 8)

    const hist = await app.inject({ method: 'GET', url: '/quota/transfers', headers: { authorization: `Bearer ${userToken()}` } })
    const page = (hist.json() as { data: { total: number; list: Array<{ amount: number }> } }).data
    assert.equal(page.total, 1)
    assert.equal(page.list[0]?.amount, 3)

    // 覆盖增量写进 user_quota_overrides，所以总额变了但总数守恒（10+5 = 7+8）
    assert.equal(quota.effectiveLimit(2, plan.id, 'demo_one'), 7)
    assert.equal(quota.effectiveLimit(2, plan.id, 'demo_two'), 8)

    const cleared = await app.inject({ method: 'DELETE', url: '/quota/transfers', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal((cleared.json() as { data: { cleared: number } }).data.cleared, 1)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('JWT 互认：Go 形状的票（uid/username + jti，无 roles/exp）在本仓可用', async () => {
  const { app, root, sessions } = await makeApp()
  try {
    // Go 版 utils/jwt.go 的 JWTClaims：uid + username + jti/iat/iss/sub，**没有 roles、-1 时没有 exp**
    const goToken = signToken(
      { uid: 1, username: 'syiism', iss: 'loomproxy', sub: 'user', iat: Math.floor(Date.now() / 1000), jti: 'go-jti' },
      SECRET,
    )

    // 本库没有这张 jti ⇒ 视为跨版本签发的外来票，按签名放行
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${goToken}` } })
    assert.equal(me.statusCode, 200)
    const view = (me.json() as { data: { id: number; username: string; roles: Array<{ code: string }> } }).data
    assert.equal(view.id, 1)
    assert.equal(view.username, 'admin', '用户名以库为准（token 里那个只是签发时的快照）')
    assert.equal(view.roles[0]?.code, 'admin', '角色从库里读（Go 的票里没有 roles）')

    // 管理员端点也认
    const stats = await app.inject({ method: 'GET', url: '/admin/stats', headers: { authorization: `Bearer ${goToken}` } })
    assert.equal(stats.statusCode, 200)

    // 本库有的 jti 被撤销 ⇒ 立刻失效（外来票放行不能变成"撤销无效"）
    sessions.create(1, 'own-jti', new Date(Date.now() + 3600_000).toISOString(), '127.0.0.1', 'test')
    const own = signToken({ uid: 1, username: 'admin', jti: 'own-jti' }, SECRET)
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${own}` } })).statusCode, 200)
    sessions.revoke('own-jti')
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${own}` } })).statusCode, 401)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('默认设置真的生效：注册开关/默认角色与套餐/邮箱名单/维护模式/验证码场景', async () => {
  const { app, root, users, settings, roles, plans } = await makeApp()
  try {
    // 关闭注册 → 403
    settings.set('register_enabled', 'false')
    const closed = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'neo', password: 'pw' } })
    assert.equal(closed.statusCode, 403)
    assert.match((closed.json() as { msg: string }).msg, /注册已关闭/)

    // 打开注册 + 默认角色/套餐（plan 用 free）
    settings.set('register_enabled', 'true')
    settings.set('default_role', 'user')
    settings.set('default_quota_plan', 'basic')
    const okRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'neo', email: 'neo@example.com', password: 'pw123456' },
    })
    assert.equal(okRes.statusCode, 200)
    const body = okRes.json() as { data: { token: string; user: { username: string; plan: { code: string } | null; roles: Array<{ code: string }> } } }
    assert.ok(body.data.token, '注册后直接发 token（面板据此跳转）')
    assert.equal(body.data.user.plan?.code, 'basic')
    assert.equal(body.data.user.roles[0]?.code, 'user')
    assert.ok(users.byUsernameOrEmail('neo'))

    // 邮箱黑白名单：白名单非空时别的域名一律拒
    settings.set('email_domain_allowlist', 'example.com')
    const bad = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'trin', email: 't@other.com', password: 'pw' } })
    assert.equal(bad.statusCode, 400)
    const sub = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'trin', email: 't@mail.example.com', password: 'pw' } })
    assert.equal(sub.statusCode, 200, '后缀匹配：mail.example.com 命中 example.com')
    settings.set('email_domain_allowlist', '')

    // 验证码场景：只下发受支持的场景
    settings.set('verify_code_scenes', 'register,bogus')
    const vc = await app.inject({ method: 'GET', url: '/verify/config' })
    assert.deepEqual((vc.json() as { data: { scenes: string[] } }).data.scenes, ['register'])

    // 维护模式：普通用户 503，管理员放行（数据面）
    settings.set('maintenance_mode', 'true')
    const blocked = await app.inject({ method: 'GET', url: '/demo_one/search?key=a', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal(blocked.statusCode, 503)
    assert.match((blocked.json() as { msg: string }).msg, /系统维护中/)
    const adminOk = await app.inject({ method: 'GET', url: '/demo_one/search?key=a', headers: { authorization: `Bearer ${adminToken()}` } })
    assert.equal(adminOk.statusCode, 200)
    settings.set('maintenance_mode', 'false')

    // 设置项都对得上库（29 条内置在 compose 里播种；这里是 makeApp 的最小集）
    assert.ok(plans.list().some((p) => p.code === 'basic'))
    assert.ok(roles.list().some((r) => r.code === 'user'))
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('/admin/settings 形状：items + sensitive_keys（面板读 resp.items，读 list 会空白）', async () => {
  const { app, root, settings } = await makeApp()
  try {
    settings.set('announcement', 'hello')
    const res = await app.inject({ method: 'GET', url: '/admin/settings', headers: { authorization: `Bearer ${adminToken()}` } })
    assert.equal(res.statusCode, 200)
    const data = res.json() as { data: { items?: unknown[]; list?: unknown[]; sensitive_keys?: string[] } }
    assert.ok(Array.isArray(data.data.items), '必须是 items（Go ListSettings 的形状）')
    assert.equal(data.data.list, undefined, '不要再回 list：面板读不到它会整页空白')
    assert.ok(Array.isArray(data.data.sensitive_keys))
    const hit = (data.data.items as Array<{ key: string; value: string }>).find((i) => i.key === 'announcement')
    assert.equal(hit?.value, 'hello')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('数据源 PATCH/DELETE：404/无字段/非法分组/rank_public 走设置名单/被套餐引用不许删', async () => {
  const { app, root, settings, quota, plans, dataSources } = await makeApp()
  try {
    const H = { authorization: `Bearer ${adminToken()}` }
    // 造一行源（插件 upsert 的等价物）
    const id = dataSources.create({ name: 'demo_3', display_name: '三号', category: 'demo', sort_order: 3 })

    assert.equal((await app.inject({ method: 'PATCH', url: '/admin/data-sources/9999', headers: H, payload: { display_name: 'x' } })).statusCode, 404)
    assert.equal((await app.inject({ method: 'PATCH', url: `/admin/data-sources/${id}`, headers: H, payload: {} })).statusCode, 400)
    assert.equal(
      (await app.inject({ method: 'PATCH', url: `/admin/data-sources/${id}`, headers: H, payload: { group_id: 1, clear_group: true } })).statusCode,
      400,
    )
    assert.equal(
      (await app.inject({ method: 'PATCH', url: `/admin/data-sources/${id}`, headers: H, payload: { group_id: 999 } })).statusCode,
      400,
      '分组不存在',
    )

    // 正常改 + rank_public（存设置名单，不是列）
    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/data-sources/${id}`,
      headers: H,
      payload: { display_name: '三号改', status: 0, rank_public: true },
    })
    assert.equal(patched.statusCode, 200)
    const row = (patched.json() as { data: { display_name: string; status: number; rank_public: boolean } }).data
    assert.equal(row.display_name, '三号改')
    assert.equal(row.status, 0)
    assert.equal(row.rank_public, true)
    assert.equal(settings.get('rank_public_sources'), 'demo_3', '榜单可见性落在设置名单上')

    // 关闭榜单
    const off = await app.inject({ method: 'PATCH', url: `/admin/data-sources/${id}`, headers: H, payload: { rank_public: false } })
    assert.equal((off.json() as { data: { rank_public: boolean } }).data.rank_public, false)
    assert.equal(settings.get('rank_public_sources'), '')

    // 被套餐引用 ⇒ 不许删（限额即授权）
    quota.grant(plans.list()[0]!.id, 'source', 'demo_3', 10)
    const blocked = await app.inject({ method: 'DELETE', url: `/admin/data-sources/${id}`, headers: H })
    assert.equal(blocked.statusCode, 400)
    assert.match((blocked.json() as { msg: string }).msg, /被套餐引用/)

    // 解除引用后可删，且顺手摘榜单名单
    settings.set('rank_public_sources', 'demo_3')
    quota.removeLimit(quota.limitsOfPlan(plans.list()[0]!.id).find((l) => l.target === 'demo_3')!.id)
    assert.equal((await app.inject({ method: 'DELETE', url: `/admin/data-sources/${id}`, headers: H })).statusCode, 200)
    assert.equal(settings.get('rank_public_sources'), '')
    assert.equal(dataSources.get('demo_3'), undefined)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('套餐授权：批量授权回 created/skipped、限额 -1 视为「已授权但不限」、看板不该把它藏起来', async () => {
  const { app, root, quota, plans } = await makeApp()
  try {
    const H = { authorization: `Bearer ${adminToken()}` }
    const planId = plans.list()[0]!.id

    // 面板的默认 bulkLimit 是 -1（不限）——这一步以前会被当成"没授权"
    const first = await app.inject({ method: 'POST', url: `/admin/quotas/plans/${planId}/sources`, headers: H, payload: { sources: ['demo_one'], limit: -1 } })
    assert.equal(first.statusCode, 200)
    assert.deepEqual((first.json() as { data: { created: number; skipped: number } }).data, { created: 1, skipped: 0 })

    // 再授一次同源：跳过，不覆盖已有额度
    const again = await app.inject({ method: 'POST', url: `/admin/quotas/plans/${planId}/sources`, headers: H, payload: { sources: ['demo_one'], limit: 99 } })
    assert.deepEqual((again.json() as { data: { created: number; skipped: number } }).data, { created: 0, skipped: 1 })
    assert.equal(quota.effectiveLimit(2, planId, 'demo_one'), -1, '已授权的额度没被覆盖')

    // 授权行存在 = 能用（额度 -1 仍算授权）：普通用户看板要能看到这个源
    const dash = await app.inject({ method: 'GET', url: '/quota/dashboard', headers: { authorization: `Bearer ${userToken()}` } })
    const sources = (dash.json() as { data: { sources: Array<{ source_code: string; effective_total: number }> } }).data.sources
    assert.deepEqual(sources.map((s) => [s.source_code, s.effective_total]), [['demo_one', -1]])

    // 套餐列表内联 limits / data_source_ids（面板据此显示「源的 N 个」与「套餐 N」）
    const list = await app.inject({ method: 'GET', url: '/admin/quotas/plans', headers: H })
    const plan = (list.json() as { data: Array<{ id: number; limits: Array<{ scope: string; target: string }>; data_source_ids: number[] }> }).data.find((p) => p.id === planId)!
    assert.ok(plan.limits.some((l) => l.scope === 'source' && l.target === 'demo_one'))
    assert.deepEqual(plan.data_source_ids, [1])

    // 复制到另一个套餐：回 created/skipped
    const p2 = plans.create({ name: '二套', code: 'x2' })
    const cloned = await app.inject({ method: 'POST', url: `/admin/quotas/plans/${p2.id}/clone-sources`, headers: H, payload: { from_plan_id: planId } })
    assert.deepEqual((cloned.json() as { data: { created: number; skipped: number } }).data, { created: 1, skipped: 0 })
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('分组：列表回 {groups, ungrouped_count}（面板读 res.groups）+ 源行带 group_name/rank_public', async () => {
  const { app, root, settings, dataSources } = await makeApp()
  try {
    const H = { authorization: `Bearer ${adminToken()}` }
    // 空态也要是对象（裸数组会让面板 sourceGroups 恒空 → 分组不显示）
    const empty = await app.inject({ method: 'GET', url: '/admin/source-groups', headers: H })
    const emptyData = (empty.json() as { data: { groups: unknown[]; ungrouped_count: number } }).data
    assert.ok(Array.isArray(emptyData.groups))
    assert.equal(emptyData.ungrouped_count, 1)

    const created = await app.inject({
      method: 'POST',
      url: '/admin/source-groups',
      headers: H,
      payload: { name: '网文', description: '入选的网文', sort_order: 2, status: 1 },
    })
    assert.equal(created.statusCode, 200)
    const gid = (created.json() as { data: { id: number; description: string } }).data.id
    assert.equal((created.json() as { data: { description: string } }).data.description, '入选的网文')

    // 成员 + 源行字段
    const moved = await app.inject({ method: 'PUT', url: `/admin/source-groups/${gid}/members`, headers: H, payload: { source_names: ['demo_one'] } })
    assert.equal((moved.json() as { data: { moved: number } }).data.moved, 1)
    settings.set('rank_public_sources', 'demo_one')
    const dsList = await app.inject({ method: 'GET', url: '/admin/data-sources', headers: H })
    const row = (dsList.json() as { data: Array<{ name: string; group_id: number; group_name: string; rank_public: boolean }> }).data.find((d) => d.name === 'demo_one')!
    assert.equal(row.group_id, gid)
    assert.equal(row.group_name, '网文')
    assert.equal(row.rank_public, true, '榜单开关的当前态（面板靠它渲染 可见/隐藏）')

    const after = (await app.inject({ method: 'GET', url: '/admin/source-groups', headers: H })).json() as {
      data: { groups: Array<{ id: number; member_count: number }>; ungrouped_count: number }
    }
    assert.equal(after.data.groups.find((g) => g.id === gid)?.member_count, 1)
    assert.equal(after.data.ungrouped_count, 0)
    void dataSources
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
