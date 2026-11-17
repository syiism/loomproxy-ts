// 控制面路由（迁移-TS-1 §6）：信封一律 {code,msg,data}；`/` 是裸对象（现状如此，照抄）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, normalize, resolve as resolvePath } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fail, ok, type SearchTab } from '@loomproxy/contract'
import { clampPage, clampPageSize } from '@loomproxy/kernel'
import type { Config } from '@loomproxy/kernel'
import type { CallLogStore, DataSourceStore, UserStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { issueToken, resolveIdentity } from './auth.ts'
import { declaredParams } from './params.ts'

export type RouteDeps = {
  config: Config
  host: SourceHost
  dataSources: DataSourceStore
  users?: UserStore
  callLogs?: CallLogStore
}

type DatasourceItem = {
  id: string
  name: string
  category: string
  media_type?: string
  search_tab: SearchTab[]
  files: string[]
}

const DEFAULT_TABS: SearchTab[] = [{ tab_type: 3, bd_id: '2', name: '小说' }]

function listDataFiles(dataDir: string, source: string): string[] {
  const dir = join(dataDir, source)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .sort()
}

function fileInfos(dataDir: string, source: string): Array<{ name: string; filename: string; size: number; description: string }> {
  return listDataFiles(dataDir, source).map((n) => {
    const p = join(dataDir, source, `${n}.json`)
    let size = 0
    try {
      size = statSync(p).size
    } catch {
      size = 0
    }
    return { name: n, filename: `${n}.json`, size, description: '' }
  })
}

/**
 * 源清单：只列 enabled 且注册表里 active 的。
 * 缓存键必须并进 `registry.generation`，否则"加载了新源但清单里没有"（迁移-TS-4 §5）。
 */
function datasourcesOf(deps: RouteDeps): DatasourceItem[] {
  const items: DatasourceItem[] = []
  for (const row of deps.dataSources.listEnabled()) {
    const entry = deps.host.registryRef.get(row.name)
    if (!entry || entry.state !== 'active') continue
    items.push({
      id: row.name,
      name: row.display_name,
      category: row.category,
      ...(row.media_type ? { media_type: row.media_type } : {}),
      search_tab: entry.meta.search_tabs ?? DEFAULT_TABS,
      files: listDataFiles(deps.config.dataDir, row.name),
    })
  }
  return items
}

type EndpointInfo = { path: string; method: string; description: string; params: string[]; auth_required: boolean }
type RouteEntry = { id: string; name: string; endpoints: EndpointInfo[] }

function endpointsOf(deps: RouteDeps): RouteEntry[] {
  const allowed = new Set(deps.dataSources.listEnabled().map((r) => r.name))
  const out: RouteEntry[] = []
  for (const entry of deps.host.registryRef.active()) {
    if (!allowed.has(entry.code)) continue
    const endpoints: EndpointInfo[] = entry.meta.actions.map((action) => ({
      path: `/${entry.code}/${action}`,
      method: 'GET',
      description: entry.meta.description ?? '',
      params: [...declaredParams(entry.params, action)],
      auth_required: true,
    }))
    out.push({ id: entry.code, name: entry.meta.display, endpoints })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function adminOnly(req: FastifyRequest, reply: FastifyReply, cfg: Config): boolean {
  const id = resolveIdentity(req, cfg)
  if (!id.roles.includes('admin')) {
    reply.code(403).send(fail(cfg.errorCode, '需要管理员权限'))
    return false
  }
  return true
}

export function registerControlRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config } = deps

  // 存活探针：裸对象（与 Go 版同形状）
  app.get('/', async () => ({ app: 'LoomProxy', status: 'ok', panel: '/panel' }))

  // ---- 登录（面板唯一入口；本轮只有 env 单管理员） ----
  app.post('/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; email?: string }
    const username = (body.username ?? body.email ?? '').trim()
    if (!username || !body.password) {
      reply.code(400).send(fail(config.errorCode, '请输入用户名与密码'))
      return
    }
    const user = deps.users?.verify(username, body.password)
    if (!user || user.status !== 1) {
      // 用户不存在与密码错误统一口径（与 Go 版一致）：不给出"哪一个错了"
      reply.code(401).send(fail(config.errorCode, '用户名或密码错误'))
      return
    }
    const { token, expires_at } = issueToken(user, config)
    return ok({
      token,
      expires_at,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        email: user.email,
        status: user.status,
        roles: user.roles,
      },
    })
  })

  app.get('/auth/me', async (req, reply) => {
    const id = resolveIdentity(req, config)
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const user = deps.users?.byId(id.userId)
    return ok({
      id: user?.id ?? id.userId,
      username: user?.username ?? id.username ?? '',
      nickname: user?.nickname ?? '',
      email: user?.email ?? '',
      status: user?.status ?? 1,
      roles: user?.roles ?? id.roles,
    })
  })

  app.post('/auth/logout', async () => ok({}))
  app.post('/auth/register', async (_req, reply) => {
    reply.code(403).send(fail(config.errorCode, '本部署未开放注册（账号由 ADMIN_USERNAME/ADMIN_PASSWORD 提供）'))
  })

  app.get('/datasources', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return ok(datasourcesOf(deps))
  })

  app.get('/endpoints', async (req, reply) => {
    const id = resolveIdentity(req, config)
    if (id.userId === undefined) {
      reply
        .code(401)
        .send(
          fail(
            401,
            '这个端点要按你的套餐过滤端点清单，必须有登录归属：请带会话 Cookie、JWT 或账号 API Key 再试（网关鉴权关闭时同样要带凭证）',
          ),
        )
      return
    }
    const data = endpointsOf(deps)
    return { code: 0, msg: 'ok', count: data.length, data }
  })

  app.get('/announcement', async () =>
    ok({ content: deps.host.settingsReader().get('announcement'), maintenance: false }),
  )

  // ---- 静态字典：命中直接写字节；没命中 404 {error}（不列可用清单，收敛枚举面） ----
  const serveData = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.params as { source?: string; name?: string }
    const root = resolvePath(config.dataDir)
    const source = p.source ?? ''
    const name = p.name ?? ''

    if (source === '' && name === '') {
      const sources: Record<string, { file_count: number; files: unknown[] }> = {}
      if (existsSync(root)) {
        for (const d of readdirSync(root, { withFileTypes: true })) {
          if (!d.isDirectory()) continue
          const files = fileInfos(root, d.name)
          sources[d.name] = { file_count: files.length, files }
        }
      }
      return ok({ count: Object.keys(sources).length, sources })
    }

    if (name === '') {
      const files = fileInfos(root, source)
      return ok({ source, count: files.length, files })
    }

    const target = normalize(join(root, source, `${name}.json`))
    if (!target.startsWith(`${root}/`) || !existsSync(target)) {
      reply.code(404).send({ error: 'not found' })
      return
    }
    reply.header('content-type', 'application/json; charset=utf-8')
    reply.send(readFileSync(target))
  }
  app.get('/data', serveData)
  app.get('/data/:source', serveData)
  app.get('/data/:source/:name', serveData)

  // ---- 插件管理（新增；迁移-TS-4 §7） ----
  app.get('/admin/sources/plugins', async (req, reply) => {
    if (!adminOnly(req, reply, config)) return
    return ok(deps.host.info())
  })

  app.get('/admin/sources/versions', async (req, reply) => {
    if (!adminOnly(req, reply, config)) return
    const q = req.query as Record<string, string>
    return ok({
      page: clampPage(q['page']),
      page_size: clampPageSize(q['page_size']),
      versions: deps.host.latestVersions(),
    })
  })

  app.post('/admin/sources/reload-all', async (req, reply) => {
    if (!adminOnly(req, reply, config)) return
    const results = []
    for (const info of deps.host.info()) {
      try {
        results.push(await deps.host.reload(info.code))
      } catch (e) {
        results.push({ code: info.code, state: 'failed', last_error: e instanceof Error ? e.message : String(e) })
      }
    }
    return ok(results)
  })

  // 明细历史：筛选键与 Go 版同名同义，多一个 plugin_version（④ §7 批准的那一格）
  app.get('/admin/monitor/history', async (req, reply) => {
    if (!adminOnly(req, reply, config)) return
    if (!deps.callLogs) {
      reply.code(503).send(fail(config.errorCode, '本部署未启用调用明细'))
      return
    }
    const q = req.query as Record<string, string>
    const page = deps.callLogs.page({
      page: clampPage(q['page']),
      pageSize: clampPageSize(q['page_size']),
      ...(q['source'] ? { source: q['source'] } : {}),
      ...(q['action'] ? { action: q['action'] } : {}),
      ...(q['username'] ? { username: q['username'] } : {}),
      ...(q['plugin_version'] ? { pluginVersion: q['plugin_version'] } : {}),
      ...(q['in_band_code'] ? { inBandCode: q['in_band_code'] } : {}),
      ...(q['media_type'] ? { mediaType: q['media_type'] } : {}),
      ...(q['keyword'] ? { keyword: q['keyword'] } : {}),
      ...(q['book_name'] ? { bookName: q['book_name'] } : {}),
      ...(q['chapter_title'] ? { chapterTitle: q['chapter_title'] } : {}),
    })
    return ok(page)
  })

  for (const op of ['reload', 'rollback'] as const) {
    app.post(`/admin/sources/:code/${op}`, async (req, reply) => {
      if (!adminOnly(req, reply, config)) return
      const { code } = req.params as { code: string }
      try {
        const info = op === 'reload' ? await deps.host.reload(code) : await deps.host.rollback(code)
        return ok(info)
      } catch (e) {
        reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : String(e)))
      }
    })
  }

  app.post('/admin/sources/:code/disable', async (req, reply) => {
    if (!adminOnly(req, reply, config)) return
    const { code } = req.params as { code: string }
    deps.host.disable(code)
    return ok({ code, state: 'disabled' })
  })

  app.post('/admin/sources/:code/unload', async (req, reply) => {
    if (!adminOnly(req, reply, config)) return
    const { code } = req.params as { code: string }
    await deps.host.unload(code)
    return ok({ code, state: 'unloaded' })
  })
}
