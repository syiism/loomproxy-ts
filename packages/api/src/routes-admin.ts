// 管理面：总览读数、用户、角色、套餐、设置、数据源、监控、号池(空)、公开榜。
// 额度/卡密/分组/定时/IP/设备/接口消耗属"未接域"：显式 501 并说清是哪个域，
// 面板会把 msg 原样 toast 出来——不假造成功。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fail, ok } from '@loomproxy/contract'
import { clampPage, clampPageSize } from '@loomproxy/kernel'
import type { Config } from '@loomproxy/kernel'
import { resolveIdentity } from './auth.ts'
import type { DataSourceStore } from '@loomproxy/store'
import type { SourceHost } from '@loomproxy/source-host'
import { notWired, type ApiStores } from './stores.ts'

type Deps = { config: Config; stores: ApiStores; dataSources?: DataSourceStore; host?: SourceHost }

async function requireAdmin(req: FastifyRequest, reply: FastifyReply, deps: Deps) {
  const id = await resolveIdentity(req, deps.config, {
    ...(deps.stores.sessions ? { sessions: deps.stores.sessions } : {}),
    ...(deps.stores.apiKeys ? { apiKeys: deps.stores.apiKeys } : {}),
  })
  if (!id.roles.includes('admin')) {
    reply.code(403).send(fail(deps.config.errorCode, '需要管理员权限'))
    return undefined
  }
  return id
}

/** 下次清零时刻（平台时区下一个 0 点），形状与 Go 的 nextResetTime 一致：2026/11/18 00:00:00 */
function nextResetLabel(tzOffsetHours: number): string {
  const offsetMs = tzOffsetHours * 3600_000
  const local = Date.now() + offsetMs
  const next = (Math.floor(local / 86_400_000) + 1) * 86_400_000 - offsetMs
  // next 是 UTC 时刻；要显示的是**平台时区**的钟点，所以把位移加回去再读 UTC 分量
  const d = new Date(next + offsetMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`
}

export function registerAdminRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, stores } = deps
  const unavailable = (reply: FastifyReply, msg: string) => {
    const n = notWired(msg)
    reply.code(n.status).send(fail(config.errorCode, n.msg))
  }
  const guard = async (req: FastifyRequest, reply: FastifyReply) => (await requireAdmin(req, reply, deps)) !== undefined

  // ---- 总览 ----
  app.get('/admin/stats', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const s = stores.users?.stats() ?? { total: 0, active: 0, admin: 0, deleted: 0 }
    return ok({
      total_users: s.total,
      admin_count: s.admin,
      // 本 TS 部署还没有 VIP 角色语义（角色由管理员在「角色」页建）
      vip_count: 0,
      normal_count: Math.max(0, s.total - s.admin),
      today_new: 0,
      billing_dedupe: 0,
    })
  })

  // ---- 用户 ----
  app.get('/admin/users', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = req.query as Record<string, string>
    const page = clampPage(q['page'])
    const pageSize = clampPageSize(q['page_size'])
    const users = stores.users
    if (!users) return unavailable(reply, '用户存储未接')
    const { total, list } = users.list({
      page,
      pageSize,
      ...(q['keyword'] ? { keyword: q['keyword'] } : {}),
      ...(q['status'] ? { status: q['status'] } : {}),
      ...(q['role'] ? { role: q['role'] } : {}),
    })
    return ok({ total, page, page_size: pageSize, list })
  })

  app.get('/admin/users/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const user = stores.users?.byId(Number(id))
    if (!user) {
      reply.code(404).send(fail(config.errorCode, '用户不存在'))
      return
    }
    return ok(user)
  })

  app.post('/admin/users', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { username?: string; password?: string; nickname?: string; email?: string; role_codes?: string[]; plan_id?: number }
    if (!b.username || !b.password) {
      reply.code(400).send(fail(config.errorCode, '缺少用户名或密码'))
      return
    }
    if (!stores.users) return unavailable(reply, '用户存储未接')
    if (stores.users.byUsernameOrEmail(b.username)) {
      reply.code(400).send(fail(config.errorCode, '用户名或邮箱已被占用'))
      return
    }
    const created = stores.users.create({
      username: b.username,
      password: b.password,
      ...(b.nickname !== undefined ? { nickname: b.nickname } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
      ...(b.role_codes ? { roles: b.role_codes } : {}),
      ...(b.plan_id !== undefined ? { planId: b.plan_id } : {}),
    })
    return ok(created)
  })

  app.patch('/admin/users/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { nickname?: string; email?: string; status?: number; plan_id?: number | null }
    const updated = stores.users?.update(Number(id), {
      ...(b.nickname !== undefined ? { nickname: b.nickname } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
      ...(b.status !== undefined ? { status: b.status } : {}),
      ...(b.plan_id !== undefined ? { planId: b.plan_id } : {}),
    })
    if (!updated) {
      reply.code(404).send(fail(config.errorCode, '用户不存在'))
      return
    }
    return ok(updated)
  })

  app.delete('/admin/users/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const target = Number(id)
    if (target === 1) {
      reply.code(400).send(fail(config.errorCode, '内置管理员账号不允许删除'))
      return
    }
    stores.users?.softDelete(target)
    return ok({})
  })

  app.post('/admin/users/:id/restore', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.users?.restore(Number(id))
    return ok({})
  })

  app.post('/admin/users/:id/roles', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { role_code?: string; role_codes?: string[]; replace?: boolean }
    const codes = b.role_codes ?? (b.role_code ? [b.role_code] : [])
    if (!stores.users) return unavailable(reply, '用户存储未接')
    if (b.replace) {
      stores.users.setRoles(Number(id), codes)
    } else {
      const cur = stores.users.byId(Number(id))?.roles.map((r) => r.code) ?? []
      stores.users.setRoles(Number(id), [...new Set([...cur, ...codes])])
    }
    return ok(stores.users.byId(Number(id)) ?? {})
  })

  app.post('/admin/users/:id/reset-password', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { new_password?: string }
    if (!b.new_password) {
      reply.code(400).send(fail(config.errorCode, '缺少新密码'))
      return
    }
    stores.users?.setPassword(Number(id), b.new_password)
    return ok({})
  })

  app.put('/admin/users/:id/plan', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { plan_id?: number | null }
    stores.quota?.setPlan(Number(id), b.plan_id ?? null)
    return ok(stores.users?.byId(Number(id)) ?? {})
  })

  app.get('/admin/users/:id/quota', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const user = stores.users?.byId(Number(id))
    if (!user) {
      reply.code(404).send(fail(config.errorCode, '用户不存在'))
      return
    }
    const q = stores.quota
    const since = q?.startOfWindow(user.id, config.tzOffsetHours) ?? new Date().toISOString()
    const limits = (q?.limitsOfPlan(user.plan_id ?? 0) ?? []).filter((l) => l.scope === 'source')
    const rows = limits.map((l) => {
      const used = q?.usedSince(user.id, l.target, since) ?? 0
      const override = q?.overridesOf(user.id).find((o) => o.target === l.target)
      return {
        source: l.target,
        limit: override ? override.limit : l.limit,
        plan_limit: l.limit,
        override: override ? override.limit : null,
        used,
        remaining: Math.max(0, (override ? override.limit : l.limit) - used),
      }
    })
    return ok({ user_id: user.id, plan: user.plan, since, rows })
  })

  app.put('/admin/users/:id/quota', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { overrides?: Array<{ source?: string; target?: string; limit?: number }> }
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    q.clearOverrides(Number(id))
    for (const o of b.overrides ?? []) {
      const target = o.source ?? o.target
      if (!target) continue
      q.setOverride(Number(id), 'source', target, o.limit ?? 0)
    }
    return ok({})
  })

  app.post('/admin/users/:id/refresh-quota', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.quota?.refreshStart(Number(id))
    return ok({})
  })

  app.get('/admin/users/:id/quota-transfers', async (_req, reply) => unavailable(reply, '额度转移记录（转移模型未接）'))
  app.post('/admin/users/:id/quota-transfer', async (_req, reply) => unavailable(reply, '管理员代转额度（转移模型未接）'))

  // ---- 角色 ----
  app.get('/admin/roles', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(stores.roles?.list() ?? [])
  })
  app.post('/admin/roles', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { code?: string; name?: string; description?: string }
    if (!b.code || !b.name) {
      reply.code(400).send(fail(config.errorCode, '缺少角色码或名称'))
      return
    }
    try {
      return ok(stores.roles?.create({ code: b.code, name: b.name, ...(b.description ? { description: b.description } : {}) }))
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '创建失败'))
    }
  })
  app.patch('/admin/roles/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; description?: string }
    return ok(stores.roles?.update(Number(id), b) ?? {})
  })
  app.delete('/admin/roles/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.roles?.remove(Number(id))
    return ok({})
  })

  // ---- 套餐（最小集：列表/增删改；限额与授权属额度域） ----
  app.get('/admin/quotas/plans', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok(stores.plans?.list() ?? [])
  })
  app.post('/admin/quotas/plans', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { name?: string; code?: string; description?: string }
    if (!b.name) {
      reply.code(400).send(fail(config.errorCode, '缺少套餐名'))
      return
    }
    return ok(stores.plans?.create({ name: b.name, ...(b.code ? { code: b.code } : {}), ...(b.description ? { description: b.description } : {}) }))
  })
  app.patch('/admin/quotas/plans/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { name?: string; description?: string; status?: number }
    return ok(stores.plans?.update(Number(id), b) ?? {})
  })
  app.delete('/admin/quotas/plans/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.plans?.remove(Number(id))
    return ok({})
  })
  // 套餐限额（= 授权）：scope=source 的行就是"这个套餐能用哪些源"
  app.get('/admin/quotas/plans/:id/limits', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const { id } = req.params as { id: string }
    return ok(q.limitsOfPlan(Number(id)))
  })
  app.get('/admin/quotas/plans/:id/data-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const { id } = req.params as { id: string }
    return ok(q.grantedSources(Number(id)))
  })
  app.post('/admin/quotas/limits', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const b = (req.body ?? {}) as { plan_id?: number; scope?: string; target?: string; limit?: number }
    if (!b.plan_id || !b.scope || !b.target) {
      reply.code(400).send(fail(config.errorCode, '缺少 plan_id/scope/target'))
      return
    }
    const id = q.createLimit({ plan_id: b.plan_id, scope: b.scope, target: b.target, limit: b.limit ?? 0 })
    return ok({ id })
  })
  app.put('/admin/quotas/limits/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { limit?: number }
    stores.quota?.updateLimit(Number(id), b.limit ?? 0)
    return ok({})
  })
  app.delete('/admin/quotas/limits/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    stores.quota?.removeLimit(Number(id))
    return ok({})
  })
  // 批量授权 / 从别的套餐复制（面板的"一次给多个源"与"复制授权"）
  const grantMany = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { source_names?: string[]; sources?: string[]; limit?: number }
    const names = b.source_names ?? b.sources ?? []
    for (const n of names) q.grant(Number(id), 'source', n, b.limit ?? 0)
    return ok({ granted: names.length })
  }
  app.post('/admin/quotas/plans/:id/sources', grantMany)
  app.post('/admin/quotas/plans/:id/data-sources', grantMany)
  app.post('/admin/quotas/plans/:id/data-sources/batch', grantMany)
  app.post('/admin/quotas/plans/:id/clone-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { from_plan_id?: number; source_plan_id?: number; from?: number }
    const from = b.from_plan_id ?? b.source_plan_id ?? b.from
    if (!from) {
      reply.code(400).send(fail(config.errorCode, '缺少来源套餐 from_plan_id'))
      return
    }
    return ok({ cloned: q.cloneSources(Number(id), from) })
  })
  app.delete('/admin/quotas/plans/:id/data-sources/:ds_id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { ds_id } = req.params as { ds_id: string }
    stores.quota?.removeLimit(Number(ds_id))
    return ok({})
  })

  // ---- 设置 ----
  app.get('/admin/settings', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok({ list: stores.settings?.list() ?? [], sensitive_keys: stores.settings?.sensitiveKeys() ?? [] })
  })
  app.post('/admin/settings', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { key?: string; value?: string; type?: string; description?: string; sensitive?: boolean }
    if (!b.key || !b.type) {
      reply.code(400).send(fail(config.errorCode, '缺少 key 或 type'))
      return
    }
    const settings = stores.settings as unknown as { upsertRaw?: (i: { key: string; value: string; type: string; description: string; sensitive?: boolean }) => void }
    if (!settings?.upsertRaw) return unavailable(reply, '设置存储未接')
    try {
      settings.upsertRaw({ key: b.key, value: b.value ?? '', type: b.type, description: b.description ?? '', sensitive: !!b.sensitive })
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '写入失败'))
      return
    }
    return ok({})
  })
  app.put('/admin/settings/:key', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { key } = req.params as { key: string }
    const b = (req.body ?? {}) as { value?: string }
    try {
      stores.settings?.set(key, b.value ?? '')
    } catch (e) {
      reply.code(400).send(fail(config.errorCode, e instanceof Error ? e.message : '写入失败'))
      return
    }
    return ok({})
  })
  app.delete('/admin/settings/:key', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { key } = req.params as { key: string }
    const settings = stores.settings as unknown as { remove?: (k: string) => boolean }
    settings?.remove?.(key)
    return ok({})
  })

  // ---- 数据源 ----
  app.get('/admin/data-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const ds = stores.dataSources as unknown as { listAll?: () => unknown[] }
    return ok(ds?.listAll?.() ?? [])
  })
  app.post('/admin/data-sources', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const b = (req.body ?? {}) as { name?: string; display_name?: string; category?: string; description?: string; sort_order?: number; status?: number }
    if (!b.name || !b.display_name) {
      reply.code(400).send(fail(config.errorCode, '缺少源码或显示名'))
      return
    }
    const ds = stores.dataSources as unknown as { create?: (i: never) => number }
    if (!ds?.create) return unavailable(reply, '数据源存储未接')
    return ok({ id: ds.create({ ...b, name: b.name, display_name: b.display_name } as never) })
  })
  app.patch('/admin/data-sources/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const ds = stores.dataSources as unknown as { update?: (id: number, patch: unknown) => void }
    ds?.update?.(Number(id), req.body ?? {})
    return ok({})
  })
  app.delete('/admin/data-sources/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const ds = stores.dataSources as unknown as { remove?: (id: number) => boolean }
    ds?.remove?.(Number(id))
    return ok({})
  })
  // 平台默认地址（个人级在 /user/source-configs）：回落顺序 个人 → 平台 → 源内置
  app.get('/admin/source-configs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const map = cfg.platform()
    const dsStore = deps.dataSources as unknown as { listAll?: () => Array<{ name: string; display_name: string }> }
    const items = (dsStore?.listAll?.() ?? []).map((ds) => ({
      source_name: ds.name,
      source_display: ds.display_name,
      base_url: map[ds.name] ?? '',
    }))
    return ok(items)
  })
  app.put('/admin/source-configs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const b = (req.body ?? {}) as { configs?: Array<{ source_name?: string; base_url?: string }> }
    for (const c of b.configs ?? []) {
      if (!c.source_name) continue
      cfg.setPlatform(c.source_name, (c.base_url ?? '').trim())
    }
    return ok({})
  })

  // 分组 / 定时 / 榜单可见：未接
  for (const path of ['/admin/source-groups', '/admin/source-groups/:id', '/admin/source-schedules', '/admin/source-schedules/:id', '/admin/source-groups/:id/members', '/admin/source-groups/:id/apply-limits']) {
    app.get(path, async (_req, reply) => unavailable(reply, '数据源默认地址/分组/定时'))
    app.put(path, async (_req, reply) => unavailable(reply, '数据源默认地址/分组/定时'))
    app.post(path, async (_req, reply) => unavailable(reply, '数据源默认地址/分组/定时'))
    app.patch(path, async (_req, reply) => unavailable(reply, '数据源默认地址/分组/定时'))
    app.delete(path, async (_req, reply) => unavailable(reply, '数据源默认地址/分组/定时'))
  }

  // ---- 监控 ----
  app.get('/admin/monitor', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const logs = stores.callLogs as unknown as { stats?: () => unknown[] }
    return ok({ stats: logs?.stats?.() ?? [], total: stores.callLogs?.count() ?? 0 })
  })

  app.get('/admin/monitor/history', async (req, reply) => {
    if (!(await guard(req, reply))) return
    if (!stores.callLogs) return unavailable(reply, '调用明细存储未接')
    const q = req.query as Record<string, string>
    return ok(
      stores.callLogs.page({
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
      }),
    )
  })

  app.get('/admin/monitor/subjects', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = req.query as Record<string, string>
    const logs = stores.callLogs as unknown as { subjects?: (dim: string, days: number) => unknown[] }
    const days = Math.max(1, Number(q['days'] ?? 7) || 7)
    return ok(logs?.subjects?.(q['dim'] ?? 'keyword', days) ?? [])
  })

  app.post('/admin/monitor/reset', async (req, reply) => {
    if (!(await guard(req, reply))) return
    stores.callLogs?.clear()
    return ok({})
  })

  app.get('/admin/monitor/report.html', async (req, reply) => {
    if (!(await guard(req, reply))) return
    reply.header('content-type', 'text/html; charset=utf-8')
    return '<!doctype html><meta charset="utf-8"><title>监控报表</title><p>本 TS 部署暂未迁移服务端渲染报表，读数见「监控」页。</p>'
  })

  app.get('/admin/monitor/trend', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const qs = req.query as Record<string, string>
    const days = Math.max(1, Number(qs['days'] ?? 7) || 7)
    const logs = stores.callLogs as unknown as { trend?: (d: number) => unknown[] }
    return ok(logs?.trend?.(days) ?? [])
  })
  app.post('/admin/monitor/backfill-subjects', async (_req, reply) => unavailable(reply, '名称回填（需命名缓存）'))

  // ---- 号池：本轮没有池运行时（③ §9），空列表而不是假数据 ----
  app.get('/admin/pools', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok([])
  })

  // ---- 公开榜（登录用户可读）：直接按明细聚合 ----
  app.get('/rank/boards', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const q = req.query as Record<string, string>
    const logs = stores.callLogs as unknown as { subjects?: (dim: string, days: number) => unknown[] }
    return ok({ dim: 'keyword', days: Number(q['days'] ?? 7), list: logs?.subjects?.('keyword', Number(q['days'] ?? 7)) ?? [] })
  })

  // ---- 用量流水与接口消耗 ----
  app.get('/admin/usage-logs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const q = stores.quota
    if (!q) return unavailable(reply, '额度存储未接')
    const qs = req.query as Record<string, string>
    return ok(
      q.usagePage({
        page: clampPage(qs['page']),
        pageSize: clampPageSize(qs['page_size']),
        ...(qs['username'] ? { username: qs['username'] } : {}),
        ...(qs['group'] ? { groupCode: qs['group'] } : {}),
      }),
    )
  })

  app.get('/admin/quota-costs', async (req, reply) => {
    if (!(await guard(req, reply))) return
    return ok((stores.quota?.costs() ?? []).map((c) => ({ ...c, group_code: c.group_code, interface: c.interface })))
  })
  app.put('/admin/quota-costs/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { cost?: number; status?: number; interval?: number; limit_count?: number; window_sec?: number }
    stores.quota?.updateCost(Number(id), b)
    return ok({})
  })

  // ---- 我的额度（面板概览页）：形状照 Go 的 DashboardResponse 抄 ----
  app.get('/quota/dashboard', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const user = stores.users?.byId(id.userId)
    if (!user) {
      reply.code(404).send(fail(config.errorCode, '用户不存在'))
      return
    }
    const q = stores.quota
    const isAdmin = id.roles.includes('admin')
    const since = q?.startOfWindow(user.id, config.tzOffsetHours) ?? new Date().toISOString()
    const dayStart = q?.startOfWindow(0, config.tzOffsetHours) ?? since

    const rows = (deps.dataSources?.listEnabled() ?? []).filter((ds) => {
      if (isAdmin) return true
      // 非管理员只看见"套餐里有这一行"的源（限额即授权）
      return q ? q.effectiveLimit(user.id, user.plan_id, ds.name) !== -1 : false
    })

    const sources = rows.map((ds) => {
      const granted = q?.limitsOfPlan(user.plan_id ?? 0).find((l) => l.scope === 'source' && l.target === ds.name)
      const override = q?.overridesOf(user.id).find((o) => o.scope === 'source' && o.target === ds.name)
      const effective = isAdmin ? -1 : q?.effectiveLimit(user.id, user.plan_id, ds.name) ?? -1
      const used = isAdmin ? q?.usedTodayAll(ds.name, since) ?? 0 : q?.usedSince(user.id, ds.name, since) ?? 0
      const remaining = effective >= 0 ? Math.max(0, effective - used) : -1
      const usagePct = effective > 0 ? Math.min(100, Math.floor((used * 100) / effective)) : 0
      const entry = deps.host?.registryRef.get(ds.name)
      const actions = entry?.meta.actions ?? []
      return {
        id: ds.id ?? 0,
        source_code: ds.name,
        name: ds.display_name,
        // 分组视图还没接（表都没有），一律未分组
        group_id: 0,
        group_name: '',
        override: override ? (override.limit > 0 ? `+${override.limit}` : String(override.limit)) : '未设置',
        used_today: used,
        active_users: isAdmin ? q?.activeUsersForSource(ds.name, since) ?? 0 : 0,
        effective_total: effective,
        remaining,
        usage_pct: usagePct,
        next_reset: nextResetLabel(config.tzOffsetHours),
        handlers: actions,
        interfaces: actions.map((a) => {
          const c = q?.costOf(ds.name, a)
          return {
            id: c?.id ?? 0,
            name: a,
            cost: c?.cost ?? 0,
            interval: c?.interval ?? 0,
            limit_count: c?.limit_count ?? 0,
            window_sec: c?.window_sec ?? 60,
            enabled: (c?.status ?? 1) === 1,
          }
        }),
        ...(granted ? { plan_limit: granted.limit } : {}),
      }
    })

    return ok({
      sources,
      groups: [],
      ungrouped_count: sources.length,
      is_admin: isAdmin,
      plan_name: user.plan?.name ?? '',
      plan_code: user.plan?.code ?? '',
      plan_expire_at: null,
      active_users: isAdmin ? q?.activeUsersAll(since) ?? 0 : 0,
      call_count: isAdmin ? q?.callCountSince(dayStart) ?? 0 : 0,
      quota_cycle_mode: 'day',
      switch_allowed_at: null,
    })
  })

  app.get('/quota/usage-logs', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const qs = req.query as Record<string, string>
    return ok(
      stores.quota?.usagePage({
        page: clampPage(qs['page']),
        pageSize: clampPageSize(qs['page_size']),
        userId: id.userId,
        ...(qs['group'] ? { groupCode: qs['group'] } : {}),
      }) ?? { total: 0, page: 1, page_size: 20, list: [] },
    )
  })

  // ---- 个人数据源地址 ----
  app.get('/user/source-configs', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const user = stores.users?.byId(id.userId)
    const isAdmin = id.roles.includes('admin')
    const mine = cfg.user(id.userId)
    const items = (deps.dataSources?.listEnabled() ?? [])
      .filter((ds) => isAdmin || (stores.quota ? stores.quota.effectiveLimit(id.userId!, user?.plan_id ?? null, ds.name) !== -1 : false))
      .map((ds) => ({ source_name: ds.name, source_display: ds.display_name, base_url: mine[ds.name] ?? '' }))
    return ok(items)
  })
  app.put('/user/source-configs', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const cfg = stores.sourceConfigs
    if (!cfg) return unavailable(reply, '数据源默认地址存储未接')
    const b = (req.body ?? {}) as { configs?: Array<{ source_name?: string; base_url?: string }> }
    for (const c of b.configs ?? []) {
      if (!c.source_name) continue
      cfg.setUser(id.userId, c.source_name, (c.base_url ?? '').trim())
    }
    return ok({})
  })

  // 导入入口：书源文件是否托管就位（就位才在面板显示提示；rc 路径与 Go 版同形）
  app.get('/user/import-config', async (req, reply) => {
    const id = await resolveIdentity(req, config, deps.stores ?? {})
    if (id.userId === undefined) {
      reply.code(401).send(fail(401, '请先登录'))
      return
    }
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const rel = '/data/shuyuan/bookSource.json'
    const ready = existsSync(join(config.dataDir, 'shuyuan', 'bookSource.json'))
    return ok({ book_source_path: rel, ready })
  })

  // ---- 明确未接的域（面板有页、后端没有） ----
  const stubs: Array<[string, string, string]> = [
    ['GET', '/admin/quota-costs/plans', '套餐接口消耗（覆盖全局限速）'],
    ['POST', '/admin/quota-costs/plans/upsert', '套餐接口消耗（覆盖全局限速）'],
    ['PUT', '/admin/quota-costs/plans/:id', '套餐接口消耗（覆盖全局限速）'],
    ['GET', '/admin/redeem-codes', '卡密'],
    ['POST', '/admin/redeem-codes', '卡密'],
    ['POST', '/admin/redeem-codes/:id/revoke', '卡密'],
    ['POST', '/admin/redeem-codes/revoke-selected', '卡密'],
    ['DELETE', '/admin/redeem-codes/batch/:batch_no', '卡密'],
    ['GET', '/admin/blocked-ips', 'IP 拉黑'],
    ['POST', '/admin/blocked-ips', 'IP 拉黑'],
    ['DELETE', '/admin/blocked-ips/:id', 'IP 拉黑'],
    ['GET', '/admin/security/attempts', '登录限频读数'],
    ['POST', '/admin/security/attempts/reset', '登录限频读数'],
    ['GET', '/admin/devices', '设备与密钥统计'],
    ['GET', '/quota/transfers', '额度转移'],
    ['POST', '/quota/transfer', '额度转移'],
    ['DELETE', '/quota/transfers', '额度转移'],
    ['POST', '/user/redeem', '卡密兑换'],
  ]
  for (const [method, path, what] of stubs) {
    const m = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'
    app[m](path, async (_req, reply) => unavailable(reply, what))
  }
}
