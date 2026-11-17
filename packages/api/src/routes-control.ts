// 控制面：活的探针、源清单、静态字典、端点清单、公告、插件管理。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, normalize, resolve as resolvePath } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ok, fail, type SearchTab } from '@loomproxy/contract'
import { clampPage, clampPageSize } from '@loomproxy/kernel'
import type { Config } from '@loomproxy/kernel'
import type { DataSourceStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { resolveIdentity } from './auth.ts'
import { declaredParams } from './params.ts'
import type { ApiStores } from './stores.ts'

export type ControlDeps = {
  config: Config
  host: SourceHost
  dataSources: DataSourceStore
  stores?: ApiStores
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

function fileInfos(dataDir: string, source: string) {
  return listDataFiles(dataDir, source).map((n) => {
    let size = 0
    try {
      size = statSync(join(dataDir, source, `${n}.json`)).size
    } catch {
      size = 0
    }
    return { name: n, filename: `${n}.json`, size, description: '' }
  })
}

function datasourcesOf(deps: ControlDeps) {
  const items = []
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

function endpointsOf(deps: ControlDeps) {
  const allowed = new Set(deps.dataSources.listEnabled().map((r) => r.name))
  const out = []
  for (const entry of deps.host.registryRef.active()) {
    if (!allowed.has(entry.code)) continue
    out.push({
      id: entry.code,
      name: entry.meta.display,
      endpoints: entry.meta.actions.map((action) => ({
        path: `/${entry.code}/${action}`,
        method: 'GET',
        description: entry.meta.description ?? '',
        params: [...declaredParams(entry.params, action)],
        auth_required: true,
      })),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

async function adminOnly(req: FastifyRequest, reply: FastifyReply, config: Config, stores?: ApiStores): Promise<boolean> {
  const id = await resolveIdentity(req, config, {
    ...(stores?.sessions ? { sessions: stores.sessions } : {}),
    ...(stores?.apiKeys ? { apiKeys: stores.apiKeys } : {}),
  })
  if (!id.roles.includes('admin')) {
    reply.code(403).send(fail(config.errorCode, '需要管理员权限'))
    return false
  }
  return true
}

export function registerControlRoutes(app: FastifyInstance, deps: ControlDeps): void {
  const { config } = deps

  app.get('/', async () => ({ app: 'LoomProxy', status: 'ok', panel: '/panel' }))

  app.get('/datasources', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return ok(datasourcesOf(deps))
  })

  app.get('/endpoints', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply
        .code(401)
        .send(fail(401, '这个端点要按你的套餐过滤端点清单，必须有登录归属：请带会话 Cookie、JWT 或账号 API Key 再试（网关鉴权关闭时同样要带凭证）'))
      return
    }
    const data = endpointsOf(deps)
    return { code: 0, msg: 'ok', count: data.length, data }
  })

  app.get('/announcement', async () => ok({ content: deps.stores?.settings?.get('announcement') ?? '', maintenance: false }))

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

  // ---- 源插件（④ §7） ----
  app.get('/admin/sources/plugins', async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    return ok(deps.host.info())
  })

  app.get('/admin/sources/versions', async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    const q = req.query as Record<string, string>
    return ok({
      page: clampPage(q['page']),
      page_size: clampPageSize(q['page_size']),
      versions: deps.host.latestVersions(),
    })
  })

  app.post('/admin/sources/reload-all', async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
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

  for (const op of ['reload', 'rollback'] as const) {
    app.post(`/admin/sources/:code/${op}`, async (req, reply) => {
      if (!(await adminOnly(req, reply, config, deps.stores))) return
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
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    const { code } = req.params as { code: string }
    deps.host.disable(code)
    return ok({ code, state: 'disabled' })
  })

  app.post('/admin/sources/:code/unload', async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    const { code } = req.params as { code: string }
    await deps.host.unload(code)
    return ok({ code, state: 'unloaded' })
  })
}
