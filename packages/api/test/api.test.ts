import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, silentLogger, Upstream } from '@loomproxy/kernel'
import { SourceRegistry } from '@loomproxy/source-kit'
import {
  DbApiKeys,
  DbBlockedIPs,
  DbCallLogs,
  DbDevices,
  DbNameCache,
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
import { buildServer, signToken, TOKEN_COOKIE } from '../src/index.ts'
import { RateLimiter } from '@loomproxy/gate'

const SECRET = 'test-secret-0123456789abcdef0123456789'

function makePluginDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'loomproxy-api-'))
  const v = join(root, 'plugins', 'demo_one')
  mkdirSync(v, { recursive: true })
  writeFileSync(
    join(v, 'manifest.json'),
    JSON.stringify({
      sdk_version: '^2', version: '1.0.0',
      entry: './index.mjs',
      params: { search: ['key'], detail: ['bookId'], chapter: ['bookId'], content: ['bookId', 'itemId'] },
      meta: {
        code: 'demo_one',
        display: '演示一号',
        category: 'demo',
        sort_order: 1,
        status: 1,
        actions: ['search', 'detail', 'chapter', 'content'],
        required_params: { content: ['itemId'] },
        media_type: 'novel',
        search_tabs: [{ tab_type: 3, bd_id: '2', name: '小说', media_type: 'novel' }],
        // 源声明的设置项（自注册）：一个普通键 + 一个敏感键（源自己要能读到，面板只写不回显）
        settings: [
          { key: 'demo_mode', type: 'string', default: 'v1', description: '演示开关' },
          { key: 'demo_secret', type: 'string', default: 's3', description: '演示密钥', sensitive: true },
        ],
      },
    }),
  )
  writeFileSync(
    join(v, 'index.mjs'),
    `export default (sdk) => ({ handlers: {
       search: async (ctx) => ({ bookList: [{ bookId: 'b1', name: 'n-' + (ctx.params.key ?? ''), author: 'a',
         kind: 'stale,小说', wordCount: '', lastChapter: '', intro: '', coverUrl: '' }] }),
       detail: async (ctx) => ({ bookId: ctx.params.bookId ?? 'b1', name: '真实书名', author: 'a',
         bookTypeCode: 8, bookType: 'novel', coverUrl: '', intro: '', wordCount: '', lastChapter: '',
         chapterCount: 2, kind: '', status: '' }),
       chapter: async (ctx) => ({ chapterList: [{ title: '第一章', itemId: 'c1' }, { title: '第二章', itemId: 'c2' }],
         secret: ctx.settings.get('demo_secret'), mode: ctx.settings.get('demo_mode') }),
       content: async () => ({ contentType: 'novel', data: { content: '正文' } }),
     } })`,
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
  // quota 必须在 host 之前建：扫描时 onPluginActive 就会登记成本行（晚建会撞 TDZ，
  // 扫描把这当成加载失败 → 全套用例 404）
  const quota = new DbQuota(db)
  const host = new SourceHost({
    pluginDir: config.pluginDir,
    logger,
    registry,
    settings,
    dataSources,
    upstream,
    drainTimeoutMs: 500,
    // 与 compose 同一条：插件生效即登记接口成本行（缺行 = 不计费）
    onPluginActive: (meta) => quota.ensureDefaultCosts(meta.code, meta.actions),
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
  const nameCache = new DbNameCache(db)
  const sourceGroups = new DbSourceGroups(db, quota)
  const quotaExtra = new DbQuotaExtra(db, quota)
  const blockedIPs = new DbBlockedIPs(db)
  const devices = new DbDevices(db)
  for (const r of [
    { code: 'admin', name: '管理员', description: '' },
    { code: 'user', name: '用户', description: '' },
    { code: 'vip', name: 'VIP', description: '' },
  ]) {
    roles.create(r)
  }
  // 匿名档读的是内置 `free` 套餐的授权行（限额即授权），所以夹具里必须有一条 code=free 的套餐，
  // 并给 demo_one 授权——否则匿名调用会被判成 need_login（这正是 Go 版播种做的事）
  const plan = plans.create({ name: '基础版', code: 'free' })
  users.create({ username: 'admin', password: 'secret-pass', planId: plan.id, roles: ['admin'] })
  users.create({ username: 'u', password: 'u-pass', planId: plan.id, roles: ['user'] })
  users.create({ username: 'v', password: 'v-pass', planId: plan.id, roles: ['vip'] })
  // 匿名/免费档的授权：限额即授权，缺这一行匿名调用会被判 need_login
  quota.grant(plan.id, 'source', 'demo_one', 100)
  const app = buildServer({
    config, logger, upstream, host, dataSources, settings, limiter,
    users, roles, plans, sessions, apiKeys, callLogs, nameCache, quota, quotaExtra, sourceGroups, blockedIPs, devices,
  })
  return { app, root, config, host, db, callLogs, nameCache, users, quota, plans, quotaExtra, blockedIPs, dataSources, sessions, apiKeys, roles, settings }
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

test('CORS：任意 Origin 回显并允许 Cookie，OPTIONS 预检直接 204', async () => {
  const { app, root } = await makeApp()
  try {
    const get = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://example.com' } })
    assert.equal(get.headers['access-control-allow-origin'], 'https://example.com')
    assert.equal(get.headers['access-control-allow-credentials'], 'true')
    assert.equal(get.headers['vary'], 'Origin')

    const pre = await app.inject({
      method: 'OPTIONS', url: '/demo_one/search',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    assert.equal(pre.statusCode, 204)
    assert.equal(pre.headers['access-control-allow-origin'], 'https://example.com')
    assert.equal(pre.headers['access-control-allow-credentials'], 'true')
    assert.match(String(pre.headers['access-control-allow-headers']), /authorization/)
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

test('5xx 错误脱敏：内部 SQL/堆栈不透给前端', async () => {
  const { app, root, settings } = await makeApp()
  // 让 settings.list() 抛带内部 SQL 的错（模拟 MysqlDb 抛错），验证全局错误处理器脱敏
  ;(settings as unknown as { list: () => never }).list = () => {
    throw new Error('MySQL 查询失败: SELECT secret FROM internal\nSQL: SELECT secret FROM internal')
  }
  try {
    const res = await app.inject({ method: 'GET', url: '/admin/settings', headers: { authorization: `Bearer ${adminToken()}` } })
    assert.equal(res.statusCode, 500)
    const body = res.body
    assert.ok(!body.includes('internal'), `500 响应泄露了内部 SQL: ${body}`)
    assert.ok(!body.includes('SELECT'), `500 响应泄露了 SQL: ${body}`)
    assert.match(body, /服务内部错误/)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('/admin/stats 的 today_new 来自今日创建的用户（不是硬编码 0）', async () => {
  const { app, root } = await makeApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/admin/stats', headers: { authorization: `Bearer ${adminToken()}` } })
    assert.equal(res.statusCode, 200)
    const d = (res.json() as { data: Record<string, unknown> }).data
    assert.equal(typeof d['today_new'], 'number')
    // makeApp 里 admin/alice 都是刚刚（今天）创建的，今日新增至少 2
    assert.ok(Number(d['today_new']) >= 2, `today_new=${d['today_new']}，应为今日新建用户数`)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('/admin/stats 的 vip_count 读角色码，normal_count 扣掉 VIP（Go 口径）', async () => {
  const { app, root } = await makeApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/admin/stats', headers: { authorization: `Bearer ${adminToken()}` } })
    assert.equal(res.statusCode, 200)
    const d = (res.json() as { data: Record<string, number> }).data
    assert.equal(d['total_users'], 3)
    assert.equal(d['admin_count'], 1)
    assert.equal(d['vip_count'], 1, '库里 vip 角色的用户必须出现在响应里')
    assert.equal(d['normal_count'], 1, 'total - admin - vip')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})


test('/admin/users/:id/quota 回面板读的 items 形状；PUT 只改提交的源', async () => {
  const { app, root, quota, plans, dataSources } = await makeApp()
  try {
    dataSources.upsert({ code: 'demo_two', display: '演示二号', category: 'demo', sort_order: 2, status: 1, actions: ['search'], fixed_base_url: false })
    const plan = plans.list()[0]!
    quota.grant(plan.id, 'source', 'demo_one', 10)
    quota.grant(plan.id, 'source', 'demo_two', 20)
    quota.setOverride(2, 'source', 'demo_one', -3)
    quota.setOverride(2, 'source', 'demo_two', 7)

    const H = { authorization: `Bearer ${adminToken()}` }
    const res = await app.inject({ method: 'GET', url: '/admin/users/2/quota', headers: H })
    assert.equal(res.statusCode, 200)
    const data = (res.json() as { data: Record<string, any> }).data
    assert.ok(Array.isArray(data.items), '面板读 items，不是 rows')
    assert.ok(data.items.length >= 2)
    assert.ok(data.plan_name && data.usage_since)
    const one = data.items.find((i: any) => i.source_code === 'demo_one')
    assert.deepEqual([one.granted, one.plan_limit, one.user_limit, one.effective], [true, 10, -3, 7])

    const put = await app.inject({
      method: 'PUT', url: '/admin/users/2/quota', headers: H,
      payload: { overrides: [{ group_code: 'demo_one', limit: -2 }] },
    })
    assert.equal(put.statusCode, 200)
    assert.equal((put.json() as { data: { message: string } }).data.message, '额度覆盖已更新')
    assert.equal(quota.overrideRaw(2, 'demo_one'), -2)
    assert.equal(quota.overrideRaw(2, 'demo_two'), 7, '没提交的源不清空')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('/admin/monitor 回完整形状（面板 overview/items/recent），不是 {stats,total}', async () => {
  const { app, root } = await makeApp()
  try {
    const token = adminToken()
    await app.inject({ method: 'GET', url: '/demo_one/search?key=x' }) // 落一条明细与聚合
    const res = await app.inject({ method: 'GET', url: '/admin/monitor', headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.statusCode, 200)
    const d = (res.json() as { data: Record<string, unknown> }).data
    for (const k of ['started_at', 'total', 'success', 'failed', 'success_rate', 'lifetime_total', 'items', 'recent']) {
      assert.ok(k in d, `monitor 缺字段 ${k}`)
    }
    assert.equal(typeof d['total'], 'number')
    assert.equal(typeof d['success_rate'], 'number')
    assert.ok(Array.isArray(d['items']))
    assert.ok(Array.isArray(d['recent']))
    // 最近调用按 Go 的 RecentCall 形状：time/username/media（不是 created_at/media_type）
    const rc = (d['recent'] as Array<Record<string, unknown>>)[0]!
    assert.ok('time' in rc && typeof rc['time'] === 'string', '最近调用要有 time 字段')
    assert.ok('username' in rc, '最近调用要有 username 字段')
    assert.ok('media' in rc, '最近调用要有 media 字段')
    const item = (d['items'] as Array<Record<string, unknown>>)[0]!
    for (const k of ['source', 'action', 'total', 'success', 'failed', 'success_rate', 'avg_latency_ms', 'max_latency_ms', 'lifetime', 'last_called_at']) {
      assert.ok(k in item, `monitor item 缺字段 ${k}`)
    }
    // 口径一致：total 是启动以来窗口计数，lifetime 是历史累计，后者必须 >= 前者
    assert.ok(Number(item['lifetime']) >= Number(item['total']), 'lifetime 是历史累计，不能小于启动以来窗口计数')
    assert.ok(Number(d['lifetime_total']) >= Number(d['total']), 'lifetime_total 不能小于 total')
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

test('插件管理：要管理员；外部换目录 + reload 后 /datasources 跟着变', async () => {
  const { app, root, host } = await makeApp()
  try {
    // 先存一份 v2，再把当前目录换成 v1（多版本由外部管理，服务只认当前这一份）
    const v2 = join(root, 'plugins', 'demo_one_v2')
    cpSync(join(root, 'plugins', 'demo_one'), v2, { recursive: true })
    const v1 = join(root, 'plugins', 'demo_one_v1')
    mkdirSync(v1, { recursive: true })
    cpSync(join(root, 'plugins', 'demo_one'), v1, { recursive: true })
    writeFileSync(join(v1, 'manifest.json'), JSON.stringify({
      sdk_version: '^2', version: '1.0.0', entry: './index.mjs',
      params: { search: ['key'], detail: ['bookId'], chapter: ['bookId'], content: ['bookId', 'itemId'] },
      meta: {
        code: 'demo_one', display: '演示一号 v1', category: 'demo', sort_order: 1, status: 1,
        actions: ['search', 'detail', 'chapter', 'content'], required_params: { content: ['itemId'] }, media_type: 'novel',
        search_tabs: [{ tab_type: 3, bd_id: '2', name: '小说', media_type: 'novel' }],
      },
    }))

    const denied = await app.inject({
      method: 'POST', url: '/admin/sources/demo_one/reload', headers: { authorization: `Bearer ${userToken()}` },
    })
    assert.equal(denied.statusCode, 403)
    const okRes = await app.inject({
      method: 'POST', url: '/admin/sources/demo_one/reload', headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal(okRes.statusCode, 200)
    const info = (okRes.json() as { data: { code: string; state: string; version: string } }).data
    assert.equal(info.code, 'demo_one')
    assert.equal(info.state, 'active')

    rmSync(join(root, 'plugins', 'demo_one'), { recursive: true, force: true })
    cpSync(v1, join(root, 'plugins', 'demo_one'), { recursive: true })
    const reload = await app.inject({
      method: 'POST', url: '/admin/sources/demo_one/reload',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal(reload.statusCode, 200)
    assert.equal((reload.json() as { data: { version: string } }).data.version, '1.0.0')
    const ds = await app.inject({ method: 'GET', url: '/datasources' })
    const item = (ds.json() as { data: Array<{ name: string }> }).data[0]
    assert.equal(item?.name, '演示一号 v1', '清单必须跟着换代')
    assert.equal(host.registryRef.get('demo_one')?.version, '1.0.0')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件管理：disable/enable 翻状态；unload 后可列出并重新注册', async () => {
  const { app, root } = await makeApp()
  const H = { authorization: `Bearer ${adminToken()}` }
  try {
    const disabled = await app.inject({ method: 'POST', url: '/admin/sources/demo_one/disable', headers: H })
    assert.equal(disabled.statusCode, 200)
    assert.equal((disabled.json() as { data: { state: string } }).data.state, 'disabled')

    const enabled = await app.inject({ method: 'POST', url: '/admin/sources/demo_one/enable', headers: H })
    assert.equal(enabled.statusCode, 200)
    assert.equal((enabled.json() as { data: { state: string } }).data.state, 'active')

    const unloaded = await app.inject({ method: 'POST', url: '/admin/sources/demo_one/unload', headers: H })
    assert.equal(unloaded.statusCode, 200)
    const available = await app.inject({ method: 'GET', url: '/admin/sources/plugins/available', headers: H })
    assert.deepEqual((available.json() as { data: string[] }).data, ['demo_one'])

    const registered = await app.inject({ method: 'POST', url: '/admin/sources/demo_one/register', headers: H })
    assert.equal(registered.statusCode, 200)
    assert.equal((registered.json() as { data: { state: string } }).data.state, 'active')
    const after = await app.inject({ method: 'GET', url: '/admin/sources/plugins/available', headers: H })
    assert.deepEqual((after.json() as { data: string[] }).data, [])

    const denied = await app.inject({
      method: 'POST', url: '/admin/sources/demo_one/enable', headers: { authorization: `Bearer ${userToken()}` },
    })
    assert.equal(denied.statusCode, 403)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('静态文件管理：管理员可列/读写/删，非法路径与非管理员被拦', async () => {
  const { app, root } = await makeApp()
  const H = { authorization: `Bearer ${adminToken()}` }
  try {
    const put = await app.inject({
      method: 'PUT', url: '/admin/static-files/shuyuan/bookSource.json', headers: H,
      payload: { content: '{"bookSource":[]}' },
    })
    assert.equal(put.statusCode, 200)

    const list = await app.inject({ method: 'GET', url: '/admin/static-files', headers: H })
    const data = (list.json() as { data: {
      sources: Array<{ source: string; files: Array<{ filename: string }> }>
      known_sources: Array<{ code: string; has_dir: boolean }>
    } }).data
    assert.ok(data.sources.some((s) => s.source === 'shuyuan' && s.files.some((f) => f.filename === 'bookSource.json')))
    assert.ok(data.known_sources.some((s) => s.code === 'demo_one' && !s.has_dir))

    // 已登记但没有静态目录的源：直接给 data/<source>/ 建目录并改名
    const made = await app.inject({
      method: 'POST', url: '/admin/static-files/rename-source', headers: H,
      payload: { from: 'demo_one', to: 'demo_static' },
    })
    assert.equal(made.statusCode, 200)
    const withDir = await app.inject({ method: 'GET', url: '/admin/static-files', headers: H })
    assert.ok((withDir.json() as { data: { sources: Array<{ source: string }> } }).data.sources.some((s) => s.source === 'demo_static'))

    const one = await app.inject({ method: 'GET', url: '/admin/static-files/shuyuan/bookSource.json', headers: H })
    assert.equal((one.json() as { data: { content: string } }).data.content, '{"bookSource":[]}')

    const moved = await app.inject({
      method: 'POST', url: '/admin/static-files/move', headers: H,
      payload: { fromSource: 'shuyuan', fromName: 'bookSource.json', toSource: 'shuyuan', toName: 'bookSource.new.json' },
    })
    assert.equal(moved.statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/admin/static-files/shuyuan/bookSource.json', headers: H })).statusCode, 404)
    const renamed = await app.inject({ method: 'GET', url: '/admin/static-files/shuyuan/bookSource.new.json', headers: H })
    assert.equal((renamed.json() as { data: { content: string } }).data.content, '{"bookSource":[]}')

    const denied = await app.inject({
      method: 'PUT', url: '/admin/static-files/shuyuan/bookSource.json',
      headers: { authorization: `Bearer ${userToken()}` }, payload: { content: 'x' },
    })
    assert.equal(denied.statusCode, 403)

    const badPath = await app.inject({
      method: 'PUT', url: '/admin/static-files/shuyuan/%2E%2E%2Fsecret.json', headers: H, payload: { content: 'x' },
    })
    assert.equal(badPath.statusCode, 400)
    const runtime = await app.inject({ method: 'GET', url: '/admin/static-files/_runtime/fq-sessions.json', headers: H })
    assert.equal(runtime.statusCode, 400)

    const del = await app.inject({ method: 'DELETE', url: '/admin/static-files/shuyuan/bookSource.new.json', headers: H })
    assert.equal(del.statusCode, 200)
    const after = await app.inject({ method: 'GET', url: '/admin/static-files/shuyuan/bookSource.json', headers: H })
    assert.equal(after.statusCode, 404)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('静态字典：/data/:source/:name 兼容带 .json 后缀的 URL', async () => {
  const { app, root } = await makeApp()
  try {
    const dir = join(root, 'data', 'demo_one')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cats.json'), '{"a":1}')
    const bare = await app.inject({ method: 'GET', url: '/data/demo_one/cats' })
    const withExt = await app.inject({ method: 'GET', url: '/data/demo_one/cats.json' })
    assert.equal(bare.statusCode, 200)
    assert.equal(withExt.statusCode, 200)
    assert.deepEqual(bare.json(), withExt.json())
    assert.deepEqual(bare.json(), { a: 1 })
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
    // Go utils.SetTokenCookie：登录必须下发 HttpOnly Cookie，否则浏览器里的旧票永远不刷新
    const cookie = ok.headers['set-cookie'] as string
    assert.ok(cookie.startsWith(`${TOKEN_COOKIE}=`), 'Set-Cookie 名与 TokenCookieName 一致')
    assert.match(cookie, /Path=\//)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Max-Age=\d+/)
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


test('登出清 Cookie（Go ClearTokenCookie 同口径）', async () => {
  const { app, root } = await makeApp()
  try {
    const r = await app.inject({ method: 'POST', url: '/auth/logout' })
    assert.equal(r.statusCode, 200)
    assert.match(r.headers['set-cookie'] as string, new RegExp(`${TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`))
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

test('阅读记录：书名列章节靠命名缓存回填，内容维度榜与公开榜都读得出来', async () => {
  const { app, root, nameCache } = await makeApp()
  try {
    const token = adminToken()
    // 搜索列表攒书名 → 目录攒章节名 → 正文只带标识，靠缓存反查书名/章名
    await app.inject({ method: 'GET', url: '/demo_one/search?key=三体' })
    await app.inject({ method: 'GET', url: '/demo_one/chapter?bookId=b1' })
    const body = await app.inject({ method: 'GET', url: '/demo_one/content?bookId=b1&itemId=c1' })
    assert.equal(body.statusCode, 200)

    const cache = nameCache.stats()
    assert.ok(cache.books >= 1, '搜索列表里的书名要进缓存')
    assert.ok(cache.chapters >= 2, '目录里的章节名要进缓存')

    const hist = await app.inject({
      method: 'GET',
      url: '/admin/monitor/history?action=content',
      headers: { authorization: `Bearer ${token}` },
    })
    const row = (hist.json() as { data: { list: Array<Record<string, unknown>> } }).data.list[0]!
    assert.equal(row['book_name'], 'n-三体', '正文只带 bookId：书名必须由缓存回填')
    assert.equal(row['chapter_title'], '第一章', '章节名按「书+章」反查')
    assert.equal(row['book_ident'], 'b1')
    assert.equal(row['chapter_ident'], 'c1')
    assert.equal(row['media_type'], 'novel')

    // 内容维度榜：面板读 data.items / data.coverage / data.name_cache（回裸数组会让整段空白）
    const subj = await app.inject({
      method: 'GET',
      url: '/admin/monitor/subjects?dim=book&days=7',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(subj.statusCode, 200)
    const sd = (subj.json() as { data: Record<string, unknown> }).data
    assert.equal(sd['dim'], 'book')
    assert.equal(sd['coverage_error'], false)
    assert.ok(Array.isArray(sd['coverage']) && (sd['coverage'] as unknown[]).length > 0, '覆盖率体检要有行')
    assert.equal(((sd['name_cache'] as { books: number }).books) >= 1, true)
    const items = sd['items'] as Array<Record<string, unknown>>
    const book = items.find((i) => i['name'] === 'n-三体')!
    assert.ok(book, '阅读记录要进书名榜')
    assert.equal(book['total'], Number(book['visitors']), '书名榜按访问人数排')
    assert.equal(book['requests'], 1)
    assert.equal((book['sources'] as string[])[0], 'demo_one')
    assert.equal(book['book_id'], 'b1')
    assert.equal(book['success'], 1)
    assert.ok(typeof book['last_called_at'] === 'string')

    // 维度白名单外的键 → 400（不是回空榜）
    const bad = await app.inject({
      method: 'GET',
      url: '/admin/monitor/subjects?dim=nope',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(bad.statusCode, 400)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('公开榜：/rank/boards 回 {boards:[keyword,book], sources, medias}；白名单空 → 普通用户 403', async () => {
  const { app, root, settings } = await makeApp()
  try {
    await app.inject({ method: 'GET', url: '/demo_one/search?key=三体' })
    await app.inject({ method: 'GET', url: '/demo_one/content?bookId=b1&itemId=c1' })

    // 管理员不受白名单限制（否则开关一关，自己也没法验证）
    const admin = await app.inject({ method: 'GET', url: '/rank/boards?days=7', headers: { authorization: `Bearer ${adminToken()}` } })
    assert.equal(admin.statusCode, 200)
    const data = (admin.json() as { data: Record<string, unknown> }).data
    assert.equal(data['unrestricted'], true)
    const boards = data['boards'] as Array<{ dim: string; title: string; rows: Array<Record<string, unknown>> }>
    assert.deepEqual(boards.map((b) => b.dim), ['keyword', 'book'])
    assert.equal(boards[1]!.title, '阅读榜')
    assert.equal((data['medias'] as unknown[]).length, 4)
    assert.equal((data['sources'] as Array<{ code: string }>)[0]!.code, 'demo_one')
    assert.equal(boards[0]!.rows[0]!['name'], '三体')
    assert.equal(boards[1]!.rows[0]!['name'], 'n-三体')
    assert.equal(boards[1]!.rows[0]!['book_id'], 'b1')
    // 公开榜不给运维字段和时间（明细是敏感数据）
    assert.equal(boards[1]!.rows[0]!['last_called_at'], undefined)

    // 白名单留空 = 不对普通用户开放
    assert.equal(settings.get('rank_public_sources'), '')
    const denied = await app.inject({ method: 'GET', url: '/rank/boards', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal(denied.statusCode, 403)

    // 放进白名单后普通用户可见，且候选源只剩被开放的那个
    settings.set('rank_public_sources', 'demo_one')
    const allowed = await app.inject({ method: 'GET', url: '/rank/boards', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal(allowed.statusCode, 200)
    const ok2 = (allowed.json() as { data: Record<string, unknown> }).data
    assert.equal(ok2['unrestricted'], false)
    assert.equal((ok2['sources'] as unknown[]).length, 1)

    // 非法媒介 → 400（枚举不能拿 IsValidMedia 校验入参，空值也认）
    const badMedia = await app.inject({
      method: 'GET',
      url: '/rank/boards?media=movie',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal(badMedia.statusCode, 400)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('留存同意位：关掉之后内容维度在写进明细之前就被抹掉（标识一起清）', async () => {
  const { app, root } = await makeApp()
  try {
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'u', password: 'u-pass' } })
    const token = (login.json() as { data: { token: string } }).data.token
    const off = await app.inject({
      method: 'POST',
      url: '/auth/privacy',
      headers: { authorization: `Bearer ${token}` },
      payload: { content_consent: false },
    })
    assert.equal(off.statusCode, 200)

    const res = await app.inject({
      method: 'GET',
      url: '/demo_one/content?bookId=b1&itemId=c1',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 200)
    // 响应照常给——留存是采集侧的事，不影响调用
    assert.deepEqual(res.json(), { contentType: 'novel', data: { content: '正文' } })

    const hist = await app.inject({
      method: 'GET',
      url: '/admin/monitor/history?username=u',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    const row = (hist.json() as { data: { list: Array<Record<string, unknown>> } }).data.list[0]!
    assert.equal(row['content_withheld'], true, '要能看出是「本人关掉了」，不是「没抽到」')
    for (const k of ['keyword', 'book_name', 'chapter_title', 'media_type', 'book_ident', 'chapter_ident']) {
      assert.equal(row[k], '', `${k} 必须被抹掉（标识也要清，否则回填循环会把它补回来）`)
    }
    // 成没成仍要留在读数里：它不是「用户读了什么」
    assert.equal(row['status'], 200)
    assert.equal(row['result_count'], 0)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('授权即准入：匿名没有免费档授权 → need_login；用户套餐不含该源 → 403（不是"全放行"）', async () => {
  const { app, root, quota, plans } = await makeApp()
  try {
    const freeId = plans.list().find((p) => p.code === 'free')!.id
    // 匿名：把免费档的授权摘掉 → 不能再用（过去这里默认全放行）
    quota.removeLimit(quota.limitsOfPlan(freeId).find((l) => l.target === 'demo_one')!.id)
    const anon = await app.inject({ method: 'GET', url: '/demo_one/search?key=x' })
    assert.equal(anon.statusCode, 401)
    assert.match((anon.json() as { msg: string }).msg, /请先登录/)

    // 用户：套餐里没有这一行 → 403 ungranted（额度填 -1 也算授权，这里是"根本没有行"）
    const noGrant = await app.inject({
      method: 'GET', url: '/demo_one/search?key=x',
      headers: { authorization: `Bearer ${userToken()}` },
    })
    assert.equal(noGrant.statusCode, 403)
    assert.match((noGrant.json() as { msg: string }).msg, /套餐不包含/)

    // 授权后排上；管理员一直能用（不受套餐限制）
    quota.grant(freeId, 'source', 'demo_one', -1)
    const granted = await app.inject({
      method: 'GET', url: '/demo_one/search?key=x',
      headers: { authorization: `Bearer ${userToken()}` },
    })
    assert.equal(granted.statusCode, 200, '额度 -1（不限）也是授权')
    assert.equal((await app.inject({ method: 'GET', url: '/demo_one/search?key=x' })).statusCode, 200)
    const admin = await app.inject({
      method: 'GET', url: '/demo_one/search?key=x',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal(admin.statusCode, 200)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('源设置自注册：声明位落库（幂等不覆盖）、面板带 source 归属、敏感键只写不回显但源读得到', async () => {
  const { app, root, host, settings } = await makeApp()
  try {
    // ① 声明位落库：默认值来自 manifest（不止内置那 29 条）
    assert.equal(settings.get('demo_mode'), 'v1')
    assert.equal(settings.get('demo_secret'), 's3', '源自己要能读到敏感键的真值')

    // ② 面板视角：值被抹掉、名单给出、并带上「谁声明的」——面板据此按源成卡
    const res = await app.inject({
      method: 'GET',
      url: '/admin/settings',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    const data = (res.json() as {
      data: { items: Array<{ key: string; value: string; source?: string; source_display?: string }>; sensitive_keys: string[] }
    }).data
    const secret = data.items.find((i) => i.key === 'demo_secret')!
    assert.equal(secret.value, '', '敏感键不下发值（只写不回显）')
    assert.equal(secret.source, 'demo_one')
    assert.equal(secret.source_display, '演示一号')
    assert.ok(data.sensitive_keys.includes('demo_secret'))
    const mode = data.items.find((i) => i.key === 'demo_mode')!
    assert.equal(mode.value, 'v1')
    assert.equal(mode.source, 'demo_one')

    // ③ 源真的拿得到：数据面响应里带着两个键的值
    const body = await app.inject({ method: 'GET', url: '/demo_one/chapter?bookId=b1' })
    const out = body.json() as { secret?: string; mode?: string }
    assert.equal(out.secret, 's3')
    assert.equal(out.mode, 'v1')

    // ④ 再扫一遍（热更新/重启同一条路）：不覆盖管理员改过的值，只对账类型与说明
    settings.set('demo_mode', 'v2')
    await host.scanSync()
    assert.equal(settings.get('demo_mode'), 'v2')
    assert.equal(settings.get('demo_secret'), 's3')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// 用例里造 zip（生产路径只读不写，所以写 zip 的代码只出现在测试里）
function makeZip(entries: Array<{ name: string; content: string; deflate?: boolean }>): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.from(e.content, 'utf8')
    const body = e.deflate ? deflateRawSync(raw) : raw
    const crc = crc32(raw)
    const nameBuf = Buffer.from(e.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(e.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(e.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }
  const cdOffset = offset
  const cdSize = centrals.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  return new Uint8Array(Buffer.concat([...locals, ...centrals, eocd]))
}
let crcTable: number[] | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = (crcTable![(crc ^ b) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}


test('上传插件包（zip）：包根或 <源码>/<版本>/ 前缀都能装；路径穿越/多根/缺 manifest 都 400', async () => {
  const { app, root, host } = await makeApp()
  try {
    const H = { authorization: `Bearer ${adminToken()}` }
    const manifest = (code: string, version = '1.0.0') =>
      JSON.stringify({
        sdk_version: '^2', version,
        entry: './index.mjs',
        params: { search: ['key'] },
        meta: { code, display: '打包来的源', category: 'demo', actions: ['search'], sort_order: 50 },
      })
    const entry = `export default (sdk) => ({ handlers: { search: async () => ({ bookList: [] }) } })`
    const asBody = (zip: Uint8Array) => ({ package: Buffer.from(zip).toString('base64') })

    // ① 带 <源码>/<版本>/ 前缀 + deflate 压缩（zip -r 打包目录的常见形状）
    const zipped = makeZip([
      { name: 'zip_one/0.2.0/manifest.json', content: manifest('zip_one', '0.2.0'), deflate: true },
      { name: 'zip_one/0.2.0/index.mjs', content: entry, deflate: true },
      { name: 'zip_one/0.2.0/data/cats.json', content: '{"a":1}' },
    ])
    const res = await app.inject({ method: 'POST', url: '/admin/sources/install-package', headers: H, payload: asBody(zipped) })
    assert.equal(res.statusCode, 200)
    const info = (res.json() as { data: { code: string; version: string; state: string } }).data
    assert.equal(info.code, 'zip_one')
    assert.equal(info.version, '0.2.0', '版本号从 manifest 读')
    assert.equal(info.state, 'active')
    // 多文件也要落盘（data/cats.json 是源的数据字典）
    assert.ok(existsSync(join(root, 'plugins', 'zip_one', 'data', 'cats.json')))

    // ② 扁平包（manifest 在根）：版本从 manifest 读
    const flat = makeZip([
      { name: 'manifest.json', content: manifest('zip_flat') },
      { name: 'index.mjs', content: entry },
    ])
    const flatRes = await app.inject({ method: 'POST', url: '/admin/sources/install-package', headers: H, payload: asBody(flat) })
    assert.equal(flatRes.statusCode, 200)
    assert.equal((flatRes.json() as { data: { version: string } }).data.version, '1.0.0')
    // manifest 缺 version → 拒绝，不猜一个
    const noVersion = makeZip([
      { name: 'manifest.json', content: JSON.stringify({ sdk_version: '^2', entry: './index.mjs', meta: { code: 'zip_nov', display: 'N', category: 'demo', actions: ['search'] } }) },
      { name: 'index.mjs', content: entry },
    ])
    const noVersionRes = await app.inject({ method: 'POST', url: '/admin/sources/install-package', headers: H, payload: asBody(noVersion) })
    assert.equal(noVersionRes.statusCode, 400)
    assert.match((noVersionRes.json() as { msg: string }).msg, /version|版本/)

    // ③ 路径穿越（zip-slip）：包里的文件名带 .. → 拒绝，且没往上级目录写东西
    const slip = makeZip([
      { name: 'manifest.json', content: manifest('zip_slip') },
      { name: 'index.mjs', content: entry },
      { name: '../escaped.txt', content: 'boom' },
    ])
    const slipRes = await app.inject({ method: 'POST', url: '/admin/sources/install-package', headers: H, payload: asBody(slip) })
    assert.equal(slipRes.statusCode, 400)
    assert.match((slipRes.json() as { msg: string }).msg, /路径/)
    assert.equal(existsSync(join(root, 'plugins', 'escaped.txt')), false)
    assert.equal(existsSync(join(root, 'escaped.txt')), false)

    // ④ 多份 manifest（包里塞了两个源）与缺 manifest
    const two = makeZip([
      { name: 'a/1.0.0/manifest.json', content: manifest('zip_a') },
      { name: 'a/1.0.0/index.mjs', content: entry },
      { name: 'b/1.0.0/manifest.json', content: manifest('zip_b') },
      { name: 'b/1.0.0/index.mjs', content: entry },
    ])
    const twoRes = await app.inject({ method: 'POST', url: '/admin/sources/install-package', headers: H, payload: asBody(two) })
    assert.equal(twoRes.statusCode, 400)
    const empty = makeZip([{ name: 'index.mjs', content: entry }])
    const emptyRes = await app.inject({ method: 'POST', url: '/admin/sources/install-package', headers: H, payload: asBody(empty) })
    assert.equal(emptyRes.statusCode, 400)
    assert.match((emptyRes.json() as { msg: string }).msg, /manifest/)

    // ③' 非法 base64 / 空包：不落到解包逻辑里
    assert.equal((await app.inject({ method: 'POST', url: '/admin/sources/install-package', headers: H, payload: { package: '不是 base64 !!' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: '/admin/sources/install-package', headers: H, payload: {} })).statusCode, 400)

    // 装出来的源照常可派发
    assert.equal(
      (await app.inject({ method: 'GET', url: '/zip_one/search?key=x', headers: H })).statusCode,
      200,
    )
    assert.ok(host.info().some((i) => i.code === 'zip_one' && i.state === 'active'))
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('计费：新装的源立刻有成本行并计入今日消耗；匿名调用不归属账号（不进流水）', async () => {
  const { app, root, quota, host } = await makeApp()
  try {
    const H = { authorization: `Bearer ${adminToken()}` }
    // 装一个插件：生效即登记每个动作的成本行（缺行 = 该接口不计费，流水永远空）
    await host.install({
      code: 'cost_src',
      files: {
        'manifest.json': JSON.stringify({ sdk_version: '^2', version: '1.0.0', entry: './index.mjs', params: { search: ['key'], content: ['bookId', 'itemId'] }, meta: { code: 'cost_src', display: 'C', category: 'demo', actions: ['search', 'content'] } }),
        'index.mjs': `export default (sdk) => ({ handlers: { search: async () => ({ bookList: [] }), content: async () => ({ contentType: 'novel', data: { content: '正文' } }) } })`,
      },
    })
    // 默认成本档：**只有正文 1 单位**，检索/详情/目录是 0（免费，但行必须存在——
    // 面板「接口」页按行编辑，没有行就没有 id，"改成本"会静默打空）
    const searchCost = quota.costOf('cost_src', 'search')
    assert.ok(searchCost, '安装插件必须顺手登记成本行，否则"后装的源免费"')
    assert.equal(searchCost!.cost, 0, '检索默认免费')
    assert.equal(quota.costOf('cost_src', 'content')?.cost, 1, '正文默认消耗 1 单位')

    // 管理员调正文（有账号）→ 进流水、看板今日消耗 +1；调检索不计
    const contentRes = await app.inject({
      method: 'GET', url: '/cost_src/content?bookId=b1&itemId=c1', headers: H,
    })
    assert.equal(contentRes.statusCode, 200)
    const dash1 = await app.inject({ method: 'GET', url: '/quota/dashboard', headers: H })
    const card1 = (dash1.json() as { data: { sources: Array<{ source_code: string; used_today: number }> } }).data.sources.find((s) => s.source_code === 'cost_src')!
    assert.equal(card1.used_today, 1)

    // 默认免费的检索：同一个人再调一次，今日消耗不变
    await app.inject({ method: 'GET', url: '/cost_src/search?key=free', headers: H })
    const dashFree = await app.inject({ method: 'GET', url: '/quota/dashboard', headers: H })
    const cardFree = (dashFree.json() as { data: { sources: Array<{ source_code: string; used_today: number }> } }).data.sources.find((s) => s.source_code === 'cost_src')!
    assert.equal(cardFree.used_today, 1, '检索成本 0：不记账')

    // 匿名调用：不归属任何账号 → 不进流水（额度域是账号维度；Go 版匿名同样不计）
    const before = card1.used_today
    await app.inject({ method: 'GET', url: '/cost_src/search?key=two' })
    const dash2 = await app.inject({ method: 'GET', url: '/quota/dashboard', headers: H })
    const card2 = (dash2.json() as { data: { sources: Array<{ source_code: string; used_today: number }> } }).data.sources.find((s) => s.source_code === 'cost_src')!
    assert.equal(card2.used_today, before, '匿名调用不该改变账号维度的今日消耗')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('数据源是配置位、插件是实现：新增数据源不带实现（installed=false，数据面 404），删除也不动插件', async () => {
  const { app, root } = await makeApp()
  try {
    const H = { authorization: `Bearer ${adminToken()}` }

    // ① 已有插件的数据源：列表里带 installed/plugin_version/actions（面板据此看出"装没装"）
    const list = await app.inject({ method: 'GET', url: '/admin/data-sources', headers: H })
    const demo = (list.json() as { data: Array<Record<string, unknown>> }).data.find((r) => r['name'] === 'demo_one')!
    assert.equal(demo['installed'], true)
    assert.equal(demo['plugin_version'], '1.0.0')
    assert.deepEqual(demo['actions'], ['search', 'detail', 'chapter', 'content'])

    // ② 手动新增：只登记配置位，并且**明说**还没有实现
    const created = await app.inject({
      method: 'POST', url: '/admin/data-sources', headers: H,
      payload: { name: 'demo_planned', display_name: '规划中的源', category: 'demo', status: 1 },
    })
    assert.equal(created.statusCode, 200)
    const createdBody = (created.json() as { data: { id: number; installed: boolean; msg: string } }).data
    assert.equal(createdBody.installed, false)
    assert.match(createdBody.msg, /还没有插件实现它/)

    // 数据面：配置位 ≠ 能用。404 not_found，目录里也不出现
    assert.equal((await app.inject({ method: 'GET', url: '/demo_planned/search?key=x' })).statusCode, 404)
    const catalog = await app.inject({ method: 'GET', url: '/datasources' })
    assert.equal((catalog.json() as { data: Array<{ id: string }> }).data.some((d) => d.id === 'demo_planned'), false)

    // ③ 源码约束与重复：同一个位置不许登记两行
    const badName = await app.inject({
      method: 'POST', url: '/admin/data-sources', headers: H,
      payload: { name: 'Bad-Name', display_name: 'x' },
    })
    assert.equal(badName.statusCode, 400)
    const dup = await app.inject({
      method: 'POST', url: '/admin/data-sources', headers: H,
      payload: { name: 'demo_planned', display_name: 'x' },
    })
    assert.equal(dup.statusCode, 400)

    // ④ 删配置位不影响插件实现：删 demo_planned 后 demo_one 照常可调
    const del = await app.inject({ method: 'DELETE', url: `/admin/data-sources/${createdBody.id}`, headers: H })
    assert.equal(del.statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/demo_one/search?key=x' })).statusCode, 200)
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
  const { app, root, quota, plans, dataSources } = await makeApp()
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

    // 历史流水里的源可能已经停用，下拉仍要能选到它
    dataSources.create({ name: 'off_one', display_name: '停用源', category: 'x', status: 0 })
    const logs = await app.inject({ method: 'GET', url: '/admin/usage-logs', headers: { authorization: `Bearer ${adminToken()}` } })
    const page = (logs.json() as {
      data: {
        total: number
        list: Array<{ group_code: string; interface: string; cost: number }>
        source_codes: string[]
        source_display_names: Record<string, string>
      }
    }).data
    assert.equal(page.total, 1, '只记成功那一发')
    assert.equal(page.list[0]?.group_code, 'demo_one')
    assert.equal(page.list[0]?.interface, 'search')
    assert.equal(page.list[0]?.cost, 1)
    assert.deepEqual([...page.source_codes].sort(), ['demo_one', 'off_one'], '面板数据源下拉包含停用源')
    assert.equal(page.source_display_names['demo_one'], '演示一号')
    assert.equal(page.source_display_names['off_one'], '停用源')

    const filtered = await app.inject({
      method: 'GET',
      url: '/admin/usage-logs?group=demo_one',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal((filtered.json() as { data: { total: number } }).data.total, 1)
    const none = await app.inject({
      method: 'GET',
      url: '/admin/usage-logs?group=off_one',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    assert.equal((none.json() as { data: { total: number } }).data.total, 0)

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

test('额度转移：对齐 Go（覆盖写增量、审计行 operator/via、本人清而管理端仍见）', async () => {
  const { app, root, quota, plans, dataSources } = await makeApp()
  try {
    dataSources.upsert({
      code: 'demo_two', display: '演示二号', category: 'demo', sort_order: 2,
      status: 1, actions: ['search'], fixed_base_url: false,
    })
    const plan = plans.list()[0]!
    quota.grant(plan.id, 'source', 'demo_one', 10)
    quota.grant(plan.id, 'source', 'demo_two', 5)

    const res = await app.inject({
      method: 'POST', url: '/quota/transfer',
      headers: { authorization: `Bearer ${userToken()}` },
      payload: { from: 'demo_one', to: 'demo_two', amount: 3 },
    })
    assert.equal(res.statusCode, 200)
    const out = (res.json() as { data: Record<string, any> }).data
    assert.equal(out.amount, 3)
    assert.deepEqual([out.from.code, out.from.before, out.from.after], ['demo_one', 10, 7])
    assert.deepEqual([out.to.code, out.to.before, out.to.after], ['demo_two', 5, 8])
    assert.match(out.scope, /当日限额/)

    // 写进覆盖行的是**增量**（Go putOverride 口径），不是绝对额度
    assert.equal(quota.overrideRaw(2, 'demo_one'), -3)
    assert.equal(quota.overrideRaw(2, 'demo_two'), 3)
    assert.equal(quota.effectiveLimit(2, plan.id, 'demo_one'), 7)
    assert.equal(quota.effectiveLimit(2, plan.id, 'demo_two'), 8)

    const hist = await app.inject({ method: 'GET', url: '/quota/transfers', headers: { authorization: `Bearer ${userToken()}` } })
    const page = (hist.json() as { data: { total: number; scope: string; list: Array<Record<string, any>> } }).data
    assert.equal(page.total, 1)
    assert.equal(page.list[0]?.via, 'self')
    assert.equal(page.list[0]?.from, 'demo_one')
    assert.match(page.scope, /覆盖增量/)

    const admin = await app.inject({
      method: 'GET', url: '/admin/users/2/quota-transfers',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    const adminPage = (admin.json() as { data: { total: number; list: Array<Record<string, any>> } }).data
    assert.equal(adminPage.total, 1)
    assert.equal(adminPage.list[0]?.operator_id, 2, '本人自助：operator_id = user_id')
    assert.equal(adminPage.list[0]?.operator, 'u')
    assert.equal(adminPage.list[0]?.from_override, -3)
    assert.equal(adminPage.list[0]?.to_override, 3)
    assert.equal(adminPage.list[0]?.cleared, false)

    // 转回去后两端增量归零 ⇒ 覆盖行删掉（不是留一行 0），有效额度回到套餐值
    const back = await app.inject({
      method: 'POST', url: '/quota/transfer',
      headers: { authorization: `Bearer ${userToken()}` },
      payload: { from: 'demo_two', to: 'demo_one', amount: 3 },
    })
    assert.equal(back.statusCode, 200)
    assert.equal(quota.overrideRaw(2, 'demo_one'), 0)
    assert.equal(quota.overrideRaw(2, 'demo_two'), 0)
    assert.equal(quota.overridesOf(2).length, 0)
    assert.equal(quota.effectiveLimit(2, plan.id, 'demo_one'), 10)
    assert.equal(quota.effectiveLimit(2, plan.id, 'demo_two'), 5)
    // 成因文案与 Go gate.TransferErrorStatus 一致
    const bad = await app.inject({
      method: 'POST', url: '/quota/transfer',
      headers: { authorization: `Bearer ${userToken()}` },
      payload: { from: 'demo_one', to: 'demo_two', amount: 0 },
    })
    assert.equal(bad.statusCode, 400)
    assert.equal((bad.json() as { msg: string }).msg, '转移数量必须是正整数')

    const cleared = await app.inject({ method: 'DELETE', url: '/quota/transfers', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal((cleared.json() as { data: { cleared: number } }).data.cleared, 2)
    const afterSelf = await app.inject({ method: 'GET', url: '/quota/transfers', headers: { authorization: `Bearer ${userToken()}` } })
    assert.equal((afterSelf.json() as { data: { total: number } }).data.total, 0, '本人不再看见')
    const afterAdmin = await app.inject({
      method: 'GET', url: '/admin/users/2/quota-transfers',
      headers: { authorization: `Bearer ${adminToken()}` },
    })
    const audit = (afterAdmin.json() as { data: { total: number; list: Array<Record<string, any>> } }).data
    assert.equal(audit.total, 2, '管理端审计面仍留着')
    assert.ok(audit.list.every((r) => r.cleared === true))
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

test('用户名长度校验 1–16：注册端点 400、store 兜底', async () => {
  const { app, root, users } = await makeApp()
  try {
    // 空用户名（trim 后 0）→ 400
    const empty = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: '   ', email: 'a@b.com', password: 'pw123456' } })
    assert.equal(empty.statusCode, 400)
    assert.match((empty.json() as { msg: string }).msg, /用户名/)
    // 17 字符 → 400
    const tooLong = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'a'.repeat(17), email: 'b@b.com', password: 'pw123456' } })
    assert.equal(tooLong.statusCode, 400)
    assert.match((tooLong.json() as { msg: string }).msg, /1–16/)
    // 1 字符 → 通过（与 contract 口径一致）
    const one = await app.inject({ method: 'POST', url: '/auth/register', payload: { username: 'z', email: 'z@b.com', password: 'pw123456' } })
    assert.equal(one.statusCode, 200)
    assert.ok(users.byUsernameOrEmail('z'))
    // store 层兜底：绕过端点直接 create 超长也抛
    assert.throws(() => users.create({ username: 'a'.repeat(20), password: 'pw123456' }), /1–16/)
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
    plans.create({ name: '基础版', code: 'basic' })
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

test('数据源 PATCH/DELETE：级联清引用，历史日志保留', async () => {
  const { app, root, settings, quota, plans, quotaExtra, dataSources, db, callLogs, nameCache } = await makeApp()
  try {
    const H = { authorization: `Bearer ${adminToken()}` }
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

    const patched = await app.inject({
      method: 'PATCH', url: `/admin/data-sources/${id}`, headers: H,
      payload: { display_name: '三号改', status: 0, rank_public: true },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(settings.get('rank_public_sources'), 'demo_3')

    // 造齐各种引用：套餐授权 / 接口成本 / 用户覆盖 / 源配置 / 名称缓存 / 榜单名单
    const planId = plans.list()[0]!.id
    quota.grant(planId, 'source', 'demo_3', 10)
    quotaExtra.upsertCostPlan({ plan_id: planId, group_code: 'demo_3', interface: 'search' })
    quota.setOverride(2, 'source', 'demo_3', 5)
    db.run('INSERT INTO platform_source_configs (source_name, base_url, updated_at) VALUES (?,?,?)', 'demo_3', 'https://x', 'now')
    db.run('INSERT INTO user_source_configs (user_id, source_name, base_url, updated_at) VALUES (?,?,?,?)', 2, 'demo_3', 'https://y', 'now')
    nameCache.rememberBook('demo_3', 'b1', '书名')
    callLogs.append({ username: 'u', ip: '1.1.1.1', source: 'demo_3', action: 'search', status: 200, latency_ms: 1, in_band_error: false, in_band_reason: '', in_band_code: '', keyword: '', book_name: '', chapter_title: '', book_ident: '', chapter_ident: '', media_type: 'novel', result_count: 1, content_withheld: false, plugin_version: '1.0' })

    // 以前会被「被套餐引用」挡下；现在级联删除所有引用
    const del = await app.inject({ method: 'DELETE', url: `/admin/data-sources/${id}`, headers: H })
    assert.equal(del.statusCode, 200)
    assert.deepEqual((del.json() as { data: { removed: boolean; source: string } }).data, { removed: true, source: 'demo_3' })
    assert.equal(dataSources.get('demo_3'), undefined)
    assert.equal(settings.get('rank_public_sources'), '')
    assert.equal(quota.limitsOfPlan(planId).some((l) => l.target === 'demo_3'), false)
    assert.equal(quota.costOf('demo_3', 'search'), undefined)
    assert.equal(quota.overridesOf(2).some((o) => o.target === 'demo_3'), false)
    assert.equal(db.get('SELECT COUNT(*) n FROM quota_cost_plans WHERE group_code=?', 'demo_3')?.n, 0)
    assert.equal(db.get('SELECT COUNT(*) n FROM platform_source_configs WHERE source_name=?', 'demo_3')?.n, 0)
    assert.equal(db.get('SELECT COUNT(*) n FROM user_source_configs WHERE source_name=?', 'demo_3')?.n, 0)
    assert.equal(nameCache.lookupBook('demo_3', 'b1'), '')
    // 历史是账本，不跟着删
    assert.equal(callLogs.page({ source: 'demo_3', page: 1, pageSize: 20 }).total, 1)
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
    // 夹具给匿名档授权过 demo_one；这一组断言要从"空授权"开始
    quota.removeLimit(quota.limitsOfPlan(planId).find((l) => l.target === 'demo_one')!.id)

    // 面板的默认 bulkLimit 是 -1（不限）——这一步以前会被当成"没授权"
    const first = await app.inject({ method: 'POST', url: `/admin/quotas/plans/${planId}/sources`, headers: H, payload: { sources: ['demo_one'], limit: -1 } })
    assert.equal(first.statusCode, 200)
    assert.deepEqual((first.json() as { data: { created: number; skipped: number } }).data, { created: 1, skipped: 0 })

    // 套餐/源码都要校验：0 号套餐与拼错的源码会在 quota_limits 留下"删不掉数据源"的垃圾行
    const noPlan = await app.inject({ method: 'POST', url: '/admin/quotas/plans/0/sources', headers: H, payload: { sources: ['demo_one'], limit: -1 } })
    assert.equal(noPlan.statusCode, 404)
    const noSource = await app.inject({ method: 'POST', url: `/admin/quotas/plans/${planId}/sources`, headers: H, payload: { sources: ['nope_src'], limit: -1 } })
    assert.equal(noSource.statusCode, 400)
    assert.match((noSource.json() as { msg: string }).msg, /数据源不存在/)

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
