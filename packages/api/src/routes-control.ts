// 控制面：活的探针、源清单、静态字典、端点清单、公告、插件管理。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, normalize, resolve as resolvePath } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ok, fail, type SearchTab } from '@loomproxy/contract'
import { clampPage, clampPageSize } from '@loomproxy/kernel'
import type { Config } from '@loomproxy/kernel'
import type { DataSourceStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { createClock } from '@loomproxy/kernel'
import { resolveIdentity } from './auth.ts'
import { Issue, VerifyError, verifyConfig, type VerifyDeps } from './verify.ts'
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
    ...(stores?.users ? { users: stores.users } : {}),
  })
  if (!id.roles.includes('admin')) {
    reply.code(403).send(fail(config.errorCode, '需要管理员权限'))
    return false
  }
  return true
}

export function registerControlRoutes(app: FastifyInstance, deps: ControlDeps): void {
  const { config } = deps

  // 健康检查（裸对象，不带信封）：`/` 现在是面板，探针挪到这里
  app.get('/health', async () => ({ app: 'LoomProxy', status: 'ok' }))

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

  // 验证码：/verify/config 给前端决定是否渲染输入框；/verify/send 发码。
  // 口径与 Go 的 handlers/verify/router.go 一致（错误码、状态码映射）。
  const verifyStore = deps.stores?.verification
  const settings = deps.stores?.settings
  app.get('/verify/config', async () => {
    if (!settings) return ok({ scenes: [], ttl: 600, send_interval: 60 })
    return ok(verifyConfig(settings))
  })
  app.post('/verify/send', async (req, reply) => {
    if (!verifyStore || !settings) {
      reply.code(501).send(fail(config.errorCode, '本部署未开启验证码通道（验证码存储未接）'))
      return
    }
    const b = (req.body ?? {}) as { scene?: string; target?: string }
    if (!b.scene || !b.target) {
      reply.code(400).send(fail(config.errorCode, '参数错误: 需要 scene 与 target'))
      return
    }
    const vd: VerifyDeps = {
      settings,
      store: verifyStore,
      dayStartIso: new Date(createClock(config.tzOffsetHours).startOfDay()).toISOString(),
    }
    try {
      const expires = await Issue(req.ip, b.scene, b.target, vd)
      return ok({ message: '验证码已发送，请查收', expires_at: expires })
    } catch (e) {
      const ve = e as VerifyError
      const kind = ve.kind ?? ''
      const status = ['too_frequent', 'daily_limit'].includes(kind) ? 429
        : kind === 'register_closed' ? 403
        : ['scene_unknown', 'scene_disabled', 'target_invalid', 'bad_request'].includes(kind) ? 400
        : kind === 'storage' ? 503 : 400
      reply.code(status).send(fail(config.errorCode, ve instanceof Error ? ve.message : '验证码发送失败，请稍后再试'))
    }
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
          if (!d.isDirectory() || d.name.startsWith('_')) continue // _runtime / _archive 是运行状态与归档，不是静态字典
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
    // 兼容带 .json 后缀的 URL：路由本身会拼 .json，重复后缀会变成 x.json.json 而 404
    const bareName = name.replace(/\.json$/i, '')
    const target = normalize(join(root, source, `${bareName}.json`))
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

  // 磁盘上有、但已 unload 的插件：面板据此显示「未注册」行并提供「注册」按钮
  app.get('/admin/sources/plugins/available', async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    return ok(deps.host.availableCodes())
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

  /**
   * 安装插件包（zip）：面板选文件 → base64 → 这里解包 → 与 install 同一条写盘/换代路径。
   * 收 zip 而不是收文件内容：真实插件包不止两个文件（`data/*.json` 数据字典、
   * 多模块入口），逐个贴文本框不现实；解压面在 source-host 的 zip.ts（stored/deflate 两种，
   * 路径合法性仍由 host 的 safeRelPath 一处判）。
   */
  app.post('/admin/sources/install-package', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    const b = (req.body ?? {}) as { package?: string }
    if (!b.package || typeof b.package !== 'string') {
      reply.code(400).send(fail(config.errorCode, '缺少 package（zip 的 base64）'))
      return
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b.package)) {
      reply.code(400).send(fail(config.errorCode, 'package 不是合法的 base64'))
      return
    }
    const bytes = Buffer.from(b.package, 'base64')
    if (bytes.length === 0) {
      reply.code(400).send(fail(config.errorCode, 'package 解出来是空的'))
      return
    }
    try {
      const info = await deps.host.installPackage({ bytes: new Uint8Array(bytes) })
      return ok(info)
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : String(e)))
    }
  })

  app.post('/admin/sources/:code/enable', async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    const { code } = req.params as { code: string }
    try {
      return ok(deps.host.enable(code))
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : String(e)))
    }
  })

  // 注册 = 从磁盘重新加载一个已 unload 的目录；内容与上次相同也不会 bump（注册表里没有它，必然真加载）
  app.post('/admin/sources/:code/register', async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    const { code } = req.params as { code: string }
    try {
      return ok(await deps.host.reload(code))
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : String(e)))
    }
  })

  app.post('/admin/sources/:code/reload', async (req, reply) => {
    if (!(await adminOnly(req, reply, config, deps.stores))) return
    const { code } = req.params as { code: string }
    const qs = req.query as { force?: string }
    // force=1 跳过"代码没变就不换代"的短路，用于强制重试/重落声明
    const force = ['1', 'true', 'yes', 'on'].includes(String(qs['force'] ?? '').toLowerCase())
    try {
      return ok(await deps.host.reload(code, { force }))
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : String(e)))
    }
  })

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
